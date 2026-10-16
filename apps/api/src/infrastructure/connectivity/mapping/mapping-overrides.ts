import {
  bitsCompartidosEntreValvulas,
  motivoSostenidaInvalida,
  type LoadedMapping,
  type MonitorTarget,
  type SignalMapping,
  type WriteSpec,
} from './opc-mapping.loader';

/**
 * Correcciones del mapeo aplicadas ENCIMA del JSON del repositorio.
 *
 * **Todo lo de aquí es puro.** Recibe el mapping cargado y los overrides, y devuelve otro mapping.
 * Ni disco, ni base de datos, ni Nest: así se prueba sin PLC y sin MySQL, igual que
 * `raw-buffers.ts` y `buildVerdict`.
 *
 * Está aparte del loader a propósito. El loader es fail-fast y decide si el proceso arranca; esto
 * decide si un cambio que pidió una persona es admisible. Mezclarlos habría hecho que un override
 * inválido guardado en la base impidiera arrancar el backend — exactamente el fallo que no se puede
 * permitir en un sistema que vigila agua potable.
 *
 * ## Qué se puede editar, y por qué solo eso
 *
 * Un override mueve la señal a otro índice o corrige su unidad y sus rangos. **No crea señales, no
 * las borra y no toca NodeIds.** Esa frontera no es prudencia: es lo que permite que el cambio se
 * aplique en caliente. NodeIds y buffers los conoce la Subscription OPC UA, que se negoció al
 * arrancar; cambiar uno exigiría rehacerla. Índice, unidad y rangos viven enteros en la capa de
 * dominio, así que basta con reconstruir el MappingEngine.
 *
 * Y **las señales `writable` quedan fuera**. El schema exige `confidence: confirmed` para lo
 * escribible, y eso significa documento oficial de la planta. Dejar que un toque en el móvil
 * reapunte el canal por el que se manda abrir una válvula es otra clase de riesgo, y no se cubre
 * con un diálogo de confirmación.
 */

/** Campos de LECTURA: dónde se lee la señal y cómo se interpreta. Viven planos en la señal. */
export const CAMPOS_EDITABLES = ['index', 'sourceBuffer', 'unit', 'min', 'max', 'opMin', 'opMax'] as const;

/**
 * Campos de MANDO: solo en señales de válvula, y anidados dentro de `write` / `stateEncoding`.
 *
 * Se listan aparte porque no se pueden recorrer con el mismo bucle que los planos —cada uno va a un
 * sitio distinto de la estructura— y porque la regla que los gobierna también es distinta: en una
 * señal de solo lectura no significan nada y se rechazan.
 *
 * Son los que responden a «¿qué valor abre y qué valor cierra?», que en 8 de las 10 plantas con
 * válvula sigue siendo una suposición heredada de La Vorágine y jamás verificada allí.
 */
export const CAMPOS_DE_MANDO = ['writeIndex', 'writeCommands', 'writeMode', 'stateOpen', 'stateClosed'] as const;

export type CampoEditable = (typeof CAMPOS_EDITABLES)[number];
export type CampoDeMando = (typeof CAMPOS_DE_MANDO)[number];

/**
 * Parche de una señal. Un campo ausente significa «no lo toques»; presente y `null`, «bórralo y
 * vuelve a no tener valor». Son cosas distintas y hay que poder expresar las dos: quitar un rango
 * operativo mal puesto es una corrección legítima.
 */
export interface MappingPatch {
  index?: number;
  sourceBuffer?: string | null;
  unit?: string | null;
  min?: number | null;
  max?: number | null;
  opMin?: number | null;
  opMax?: number | null;

  // ── Mando (solo válvulas) ──
  /** `write.target.index`: la posición del buffer de salida por la que sale la orden. */
  writeIndex?: number;
  /**
   * `write.commands`: verbo → valor. **Reemplaza el mapa entero**, no lo fusiona.
   *
   * Es deliberado: fusionar dejaría verbos viejos que nadie recuerda haber puesto, y en un canal de
   * mando un verbo olvidado es un botón de más en la pantalla del operario.
   */
  writeCommands?: Record<string, number | boolean>;
  /** `write.mode`: `absolute` pisa la palabra entera; `bitmask` respeta los bits ajenos. */
  writeMode?: 'absolute' | 'bitmask';
  /** `stateEncoding.open` / `.closed`: qué valor de la palabra de estado significa cada posición. */
  stateOpen?: number | null;
  stateClosed?: number | null;
}

export interface MappingOverride {
  plantId: string;
  domainKey: string;
  patch: MappingPatch;
  /** Quién lo aplicó y cuándo. Solo para mostrar; la autoridad es la fila de la base. */
  by: string | null;
  at: string | null;
}

export type MotivoRechazo =
  | 'SENAL_DESCONOCIDA'
  | 'SENAL_ESCRIBIBLE'
  | 'SIN_CAMBIOS'
  | 'INDICE_INVALIDO'
  | 'INDICE_FUERA_DE_RANGO'
  | 'BUFFER_DESCONOCIDO'
  | 'BUFFER_DE_OTRO_CANAL'
  | 'RANGO_INVERTIDO'
  | 'UNIDAD_INVALIDA'
  | 'MANDO_EN_SENAL_DE_LECTURA'
  | 'SIN_WRITE_SPEC'
  | 'COMANDOS_INVALIDOS'
  | 'MODO_INCOMPATIBLE_CON_SECUENCIA'
  | 'SECUENCIA_NO_EDITABLE'
  | 'MANDO_INCOMPATIBLE_CON_SOSTENIDA'
  | 'BITS_COMPARTIDOS'
  | 'ESTADO_INVALIDO';

export interface Rechazo {
  ok: false;
  motivo: MotivoRechazo;
  /** Explicación para la persona que está mirando la pantalla, no para el log. */
  detalle: string;
}

export type Veredicto = { ok: true } | Rechazo;

// ── Aplicación ──────────────────────────────────────────────────────────────────

function clave(plantId: string, domainKey: string): string {
  return `${plantId} ${domainKey}`;
}

/**
 * El mapping con los overrides puestos.
 *
 * Devuelve un objeto NUEVO y deja el original intacto: el pipeline conserva el mapping base para
 * poder recalcular el efectivo cada vez que cambian los overrides. Sin eso, dos ediciones seguidas
 * se aplicarían una encima de la otra y no habría forma de volver al JSON sin reiniciar.
 *
 * Un override que apunta a una señal que ya no existe (se renombró en el JSON, o se borró) se
 * **ignora en silencio** y no rompe nada: la fila sigue en la base como registro histórico, pero no
 * puede resucitar una señal ni inventarse una nueva.
 */
export function aplicarOverrides(mapping: LoadedMapping, overrides: MappingOverride[]): LoadedMapping {
  if (overrides.length === 0) return mapping;

  const porSenal = new Map<string, MappingPatch>();
  for (const o of overrides) porSenal.set(clave(o.plantId, o.domainKey), o.patch);

  const signals = mapping.signals.map((s) => {
    const patch = porSenal.get(clave(s.plantId, s.domainKey));
    if (!patch) return s;
    const out = fusionar(s, patch);
    // Una fila guardada ANTES de que la válvula pasara a señal sostenida (o tocada a mano en la base)
    // puede dejar un mando que el loader se negaría a cargar. Su parte de mando NO se aplica: rige la
    // del repositorio, que sí está validada; lo de lectura (índice, unidad, rangos) se aplica igual.
    // `validarParche` impide guardar filas así desde ahora; esto cubre las que ya estuvieran.
    if (out.write?.sustained && motivoSostenidaInvalida(out.write)) return fusionar(s, sinMando(patch));
    return out;
  });

  return { ...mapping, signals };
}

/** El parche sin sus campos de mando. */
function sinMando(patch: MappingPatch): MappingPatch {
  const out: MappingPatch = { ...patch };
  for (const c of CAMPOS_DE_MANDO) delete out[c];
  return out;
}

/** La señal con el parche puesto. `confidence` baja a `inferred`: ya no hay documento detrás. */
export function fusionar(s: SignalMapping, patch: MappingPatch): SignalMapping {
  const out: SignalMapping = { ...s };
  if (patch.index !== undefined) out.index = patch.index;
  if (patch.sourceBuffer !== undefined) out.sourceBuffer = patch.sourceBuffer;
  if (patch.unit !== undefined) out.unit = patch.unit;
  if (patch.min !== undefined) out.min = patch.min;
  if (patch.max !== undefined) out.max = patch.max;
  if (patch.opMin !== undefined) out.opMin = patch.opMin;
  if (patch.opMax !== undefined) out.opMax = patch.opMax;

  // El mando, solo si la señal lo tiene. `{...s}` es una copia SUPERFICIAL: sin clonar `write` y su
  // `target`, tocarlos aquí mutaría el mapping BASE, y el efectivo dejaría de poder recalcularse
  // desde él — que es justo lo que permite revertir sin reiniciar el proceso.
  const tocaMando = CAMPOS_DE_MANDO.some((c) => patch[c] !== undefined);
  if (tocaMando && out.write) {
    const write: WriteSpec = { ...out.write, target: { ...out.write.target }, commands: { ...out.write.commands } };
    if (patch.writeIndex !== undefined) write.target.index = patch.writeIndex;
    if (patch.writeCommands !== undefined) write.commands = { ...patch.writeCommands };
    if (patch.writeMode !== undefined) write.mode = patch.writeMode;
    out.write = write;
  }

  if (patch.stateOpen !== undefined || patch.stateClosed !== undefined) {
    const actual = out.stateEncoding ?? {};
    const open = patch.stateOpen !== undefined ? patch.stateOpen : actual.open;
    const closed = patch.stateClosed !== undefined ? patch.stateClosed : actual.closed;
    const encoding: { open?: number; closed?: number } = {};
    if (typeof open === 'number') encoding.open = open;
    if (typeof closed === 'number') encoding.closed = closed;
    // El schema exige al menos una propiedad: si se borran las dos, la clave desaparece entera en
    // vez de quedar un objeto vacío, que sería inválido.
    out.stateEncoding = Object.keys(encoding).length > 0 ? encoding : undefined;
  }

  // No hay documento oficial detrás de un cambio hecho desde el móvil, y `confidence` existe
  // exactamente para decir eso. Que el tablero muestre la señal como inferida es información, no
  // un castigo: quien la lea sabe que alguien la reapuntó a mano. En una válvula es más que
  // información: es lo que hace que la pantalla de mando avise de que ese valor no está verificado.
  out.confidence = 'inferred';
  return out;
}

/** Lo que rige HOY para esos campos, para poder guardar el «antes» y pintar el «de → a». */
export function valoresActuales(s: SignalMapping): Required<MappingPatch> {
  return {
    index: s.index,
    sourceBuffer: s.sourceBuffer ?? null,
    unit: s.unit ?? null,
    min: s.min ?? null,
    max: s.max ?? null,
    opMin: s.opMin ?? null,
    opMax: s.opMax ?? null,
    // El mando de una señal de lectura no existe; se devuelve vacío para que el «de → a» pueda
    // pintar «(vacío)» en vez de tener que preguntar antes si la señal es una válvula.
    writeIndex: s.write?.target.index ?? -1,
    writeCommands: s.write?.commands ?? {},
    writeMode: s.write?.mode ?? 'absolute',
    stateOpen: s.stateEncoding?.open ?? null,
    stateClosed: s.stateEncoding?.closed ?? null,
  };
}

/** Dos mapas de comandos son el mismo si tienen los mismos verbos con los mismos valores. */
export function mismosComandos(a: Record<string, number | boolean>, b: Record<string, number | boolean>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** Solo los campos que de verdad cambian respecto a lo que rige ahora. */
export function soloCambios(actual: SignalMapping, patch: MappingPatch): MappingPatch {
  const ahora = valoresActuales(actual);
  const out: MappingPatch = {};

  for (const campo of CAMPOS_EDITABLES) {
    const nuevo = patch[campo];
    if (nuevo === undefined) continue;
    if (nuevo !== ahora[campo]) (out as Record<string, unknown>)[campo] = nuevo;
  }

  for (const campo of CAMPOS_DE_MANDO) {
    const nuevo = patch[campo];
    if (nuevo === undefined) continue;
    // `writeCommands` es un objeto: comparado con !== SIEMPRE saldría distinto, y cada guardado
    // registraría un cambio que no existe. La historia de quién tocó qué dejaría de poder leerse.
    if (campo === 'writeCommands') {
      if (!mismosComandos(patch.writeCommands ?? {}, ahora.writeCommands)) out.writeCommands = patch.writeCommands;
      continue;
    }
    if (nuevo !== ahora[campo]) (out as Record<string, unknown>)[campo] = nuevo;
  }

  return out;
}

// ── Validación ──────────────────────────────────────────────────────────────────

/** Buffers de una planta, por browseName. */
function buffersDe(mapping: LoadedMapping, plantId: string): MonitorTarget[] {
  return mapping.targets.filter((t) => t.plantId === plantId);
}

/**
 * El buffer que de verdad alimenta a la señal: `sourceBuffer` si lo declara, y si no el PRIMARIO del
 * canal (el de más elementos). Es la misma convención de `MappingEngine` y de `raw-buffers.ts`, y
 * tiene que coincidir: si aquí se resolviera otro, el índice se validaría contra la longitud
 * equivocada y se aceptaría un override que produce dead-letters.
 */
export function bufferDeLaSenal(
  mapping: LoadedMapping,
  plantId: string,
  canal: string,
  sourceBuffer: string | null | undefined,
): MonitorTarget | undefined {
  const buffers = buffersDe(mapping, plantId);
  if (sourceBuffer) return buffers.find((t) => t.browseName === sourceBuffer);
  let primario: MonitorTarget | undefined;
  for (const t of buffers) {
    if (t.channel !== canal) continue;
    if (!primario || (t.arrayLength ?? 0) > (primario.arrayLength ?? 0)) primario = t;
  }
  return primario;
}

/**
 * ¿Se puede aplicar este parche?
 *
 * Se comprueba contra el mapping EFECTIVO, no contra el JSON: si la señal ya tiene un override, lo
 * que hay que validar es el resultado final. Devuelve el primer motivo de rechazo, con el texto que
 * se le va a enseñar a la persona — un «400 Bad Request» a secas no le dice a nadie qué corregir.
 */
export function validarParche(
  mapping: LoadedMapping,
  plantId: string,
  domainKey: string,
  patch: MappingPatch,
): Veredicto {
  const senal = mapping.signals.find((s) => s.plantId === plantId && s.domainKey === domainKey);
  if (!senal) {
    return { ok: false, motivo: 'SENAL_DESCONOCIDA', detalle: `${plantId} no tiene una señal llamada ${domainKey}.` };
  }
  const cambios = soloCambios(senal, patch);
  if (Object.keys(cambios).length === 0) {
    return { ok: false, motivo: 'SIN_CAMBIOS', detalle: 'No hay ningún campo distinto del que ya rige.' };
  }

  // Los campos de mando solo significan algo en una válvula. En una señal de lectura no se ignoran
  // en silencio: se rechazan, porque mandarlos ahí es señal de que quien lo hizo cree estar tocando
  // otra cosa.
  const mandoTocado = CAMPOS_DE_MANDO.filter((c) => cambios[c] !== undefined);
  if (mandoTocado.length > 0) {
    if (!senal.writable) {
      return {
        ok: false,
        motivo: 'MANDO_EN_SENAL_DE_LECTURA',
        detalle: `${domainKey} no es una válvula: no tiene canal de mando que configurar (${mandoTocado.join(', ')}).`,
      };
    }
    if (!senal.write) {
      return {
        ok: false,
        motivo: 'SIN_WRITE_SPEC',
        detalle: `${domainKey} está declarada writable pero no tiene write spec en el mapeo. Eso hay que arreglarlo en el JSON, no desde la app.`,
      };
    }
  }

  const resultado = fusionar(senal, cambios);

  if (cambios.index !== undefined) {
    if (!Number.isInteger(resultado.index) || resultado.index < 0) {
      return { ok: false, motivo: 'INDICE_INVALIDO', detalle: 'El índice tiene que ser un entero de 0 en adelante.' };
    }
  }

  if (cambios.sourceBuffer !== undefined && resultado.sourceBuffer) {
    const buffer = buffersDe(mapping, plantId).find((t) => t.browseName === resultado.sourceBuffer);
    if (!buffer) {
      return {
        ok: false,
        motivo: 'BUFFER_DESCONOCIDO',
        detalle: `${plantId} no tiene ningún buffer llamado ${resultado.sourceBuffer}.`,
      };
    }
    if (buffer.channel !== resultado.buffer) {
      return {
        ok: false,
        motivo: 'BUFFER_DE_OTRO_CANAL',
        detalle: `${buffer.browseName} es del canal ${buffer.channel} y la señal es del canal ${resultado.buffer}. Cambiar de canal cambia el tipo del dato, y eso no es una corrección de índice.`,
      };
    }
  }

  // El índice se valida contra la longitud DECLARADA del buffer que le toque, ya con el
  // sourceBuffer nuevo aplicado. Es lo que evita guardar un override que solo produce
  // dead-letters INDEX_OUT_OF_RANGE en cada muestra.
  if (cambios.index !== undefined || cambios.sourceBuffer !== undefined) {
    const buffer = bufferDeLaSenal(mapping, plantId, resultado.buffer, resultado.sourceBuffer);
    if (!buffer) {
      return {
        ok: false,
        motivo: 'BUFFER_DESCONOCIDO',
        detalle: `No se encontró el buffer del canal ${resultado.buffer} en ${plantId}.`,
      };
    }
    if (buffer.arrayLength !== null && resultado.index >= buffer.arrayLength) {
      return {
        ok: false,
        motivo: 'INDICE_FUERA_DE_RANGO',
        detalle: `${buffer.browseName} declara ${buffer.arrayLength} elementos, así que el último índice válido es ${buffer.arrayLength - 1}.`,
      };
    }
  }

  const min = resultado.min;
  const max = resultado.max;
  if (min !== null && min !== undefined && max !== null && max !== undefined && min > max) {
    return { ok: false, motivo: 'RANGO_INVERTIDO', detalle: `El mínimo (${min}) no puede ser mayor que el máximo (${max}).` };
  }
  const opMin = resultado.opMin;
  const opMax = resultado.opMax;
  if (opMin !== null && opMin !== undefined && opMax !== null && opMax !== undefined && opMin > opMax) {
    return {
      ok: false,
      motivo: 'RANGO_INVERTIDO',
      detalle: `El mínimo operativo (${opMin}) no puede ser mayor que el máximo operativo (${opMax}).`,
    };
  }

  if (cambios.unit !== undefined && resultado.unit !== null) {
    const u = resultado.unit.trim();
    if (u.length === 0 || u.length > 16) {
      return { ok: false, motivo: 'UNIDAD_INVALIDA', detalle: 'La unidad tiene que ser un texto corto, como l/s, m o psi.' };
    }
  }

  if (mandoTocado.length > 0 && senal.write && resultado.write) {
    const veredictoMando = validarMando(mapping, plantId, domainKey, senal.write, resultado.write, cambios);
    if (!veredictoMando.ok) return veredictoMando;
  }

  if (cambios.stateOpen !== undefined || cambios.stateClosed !== undefined) {
    const enc = resultado.stateEncoding;
    if (enc && enc.open !== undefined && enc.closed !== undefined && enc.open === enc.closed) {
      return {
        ok: false,
        motivo: 'ESTADO_INVALIDO',
        detalle: `Abierta y cerrada no pueden leerse con el mismo valor (${enc.open}): entonces el estado no distingue nada.`,
      };
    }
  }

  return { ok: true };
}

/**
 * Las reglas del canal de mando. Son las que impiden que una corrección desde el móvil produzca una
 * orden que el equipo no pueda obedecer — o que pueda obedecer de la forma equivocada.
 */
function validarMando(
  mapping: LoadedMapping,
  plantId: string,
  domainKey: string,
  original: SignalMapping['write'],
  resultado: NonNullable<SignalMapping['write']>,
  cambios: MappingPatch,
): Veredicto {
  // Un spec con ORDEN COMPUESTA no se edita desde la app, y no es prudencia: sus reglas —el verbo
  // debe existir también en commands, primero se desenergiza y después se energiza, como mucho una
  // posición queda activa al final— son las que impiden la ventana con las dos direcciones puestas
  // a la vez, que es lo que el protocolo de estas plantas declara ERROR. Un parche que toque
  // `commands` o el índice sin recalcular la secuencia las rompe sin avisar. Hoy ninguna planta usa
  // secuencias; esto existe para el día que sí.
  if (original?.sequences && (cambios.writeCommands !== undefined || cambios.writeIndex !== undefined)) {
    return {
      ok: false,
      motivo: 'SECUENCIA_NO_EDITABLE',
      detalle:
        'Esta válvula usa una orden compuesta (varias escrituras en secuencia). Sus reglas de orden son lo que impide energizar dos direcciones a la vez, así que se edita en el JSON con revisión, no desde la app.',
    };
  }

  if (cambios.writeCommands !== undefined) {
    const verbos = Object.entries(resultado.commands);
    if (verbos.length === 0) {
      return {
        ok: false,
        motivo: 'COMANDOS_INVALIDOS',
        detalle: 'Una válvula sin ningún verbo no se puede accionar. Deja al menos uno.',
      };
    }
    for (const [verbo, valor] of verbos) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(verbo)) {
        return {
          ok: false,
          motivo: 'COMANDOS_INVALIDOS',
          detalle: `«${verbo}» no sirve como nombre de verbo: empieza por letra y sigue con letras, números o guion bajo.`,
        };
      }
      if (typeof valor === 'number' && !Number.isFinite(valor)) {
        return { ok: false, motivo: 'COMANDOS_INVALIDOS', detalle: `El valor de «${verbo}» tiene que ser un número finito o un booleano.` };
      }
    }
    // Dos verbos con el MISMO valor significan que abrir y cerrar escriben lo mismo: el equipo no
    // podría distinguirlos y una de las dos órdenes haría lo contrario de lo que dice su botón.
    const valores = verbos.map(([, v]) => String(v));
    if (new Set(valores).size !== valores.length) {
      return {
        ok: false,
        motivo: 'COMANDOS_INVALIDOS',
        detalle: 'Dos verbos con el mismo valor: el equipo no podría distinguir una orden de la otra.',
      };
    }
  }

  if (cambios.writeMode !== undefined && resultado.sequences && resultado.mode !== 'absolute') {
    return {
      ok: false,
      motivo: 'MODO_INCOMPATIBLE_CON_SECUENCIA',
      detalle: 'Una orden compuesta escribe siempre en absoluto: ahí la posición del array ES el canal físico, no un bit de una palabra compartida.',
    };
  }

  if (cambios.writeIndex !== undefined) {
    if (!Number.isInteger(resultado.target.index) || resultado.target.index < 0) {
      return { ok: false, motivo: 'INDICE_INVALIDO', detalle: 'El índice de mando es un entero de 0 en adelante.' };
    }
    const buffer = buffersDe(mapping, plantId).find((t) => t.browseName === resultado.target.sourceBuffer);
    if (!buffer) {
      return {
        ok: false,
        motivo: 'BUFFER_DESCONOCIDO',
        detalle: `El write spec apunta a ${resultado.target.sourceBuffer}, que no existe en ${plantId}.`,
      };
    }
    if (buffer.arrayLength !== null && resultado.target.index >= buffer.arrayLength) {
      return {
        ok: false,
        motivo: 'INDICE_FUERA_DE_RANGO',
        detalle: `${buffer.browseName} declara ${buffer.arrayLength} elementos: el último índice de mando válido es ${buffer.arrayLength - 1}.`,
      };
    }
  }

  // Una válvula de señal SOSTENIDA tiene reglas que un parche no puede romper: modo bitmask, al menos
  // dos verbos, cada uno una máscara de 1 a 65535 sin bits compartidos. Son las mismas con las que el
  // loader se NIEGA A ARRANCAR, así que aceptar aquí algo que las incumple dejaría en caliente un mando
  // que el proceso, al reiniciar, no cargaría — o, peor, una válvula que se queda con los dos verbos
  // puestos o con ninguno, que es lo que el integrador prohíbe. (`pulse`, `rollbackValue` y
  // `sustained` no son editables desde la app: no hay forma de que un parche los toque.)
  if (resultado.sustained) {
    const motivo = motivoSostenidaInvalida(resultado);
    if (motivo) {
      return {
        ok: false,
        motivo: 'MANDO_INCOMPATIBLE_CON_SOSTENIDA',
        detalle: `Esta válvula es de señal SOSTENIDA (siempre queda puesto abrir o cerrar, nunca los dos ni ninguno), y el cambio la dejaría inválida: ${motivo}.`,
      };
    }
  }

  // Y con la palabra COMPARTIDA: tras el cambio, ninguna otra válvula que mande por el mismo elemento
  // puede usar un bit de esta. Es la misma regla de validate:mapping, aplicada al mapeo que quedaría.
  if (cambios.writeCommands !== undefined || cambios.writeIndex !== undefined || cambios.writeMode !== undefined) {
    const quedaria = mapping.signals
      .filter((s) => s.plantId === plantId && s.writable)
      .map((s) => ({ plantId: s.plantId, domainKey: s.domainKey, write: s.domainKey === domainKey ? resultado : s.write }));
    const conflicto = bitsCompartidosEntreValvulas(quedaria).find((c) => c.valvulas.includes(domainKey));
    if (conflicto) {
      return {
        ok: false,
        motivo: 'BITS_COMPARTIDOS',
        detalle: `Dos válvulas que mandan por la misma palabra no pueden compartir bits: ${conflicto.motivo}.`,
      };
    }
  }

  return { ok: true };
}

// ── Documento crudo (para revalidar contra el schema y, más adelante, llevarlo a git) ──

interface RawDoc {
  plants?: { plantId?: string; signals?: Record<string, unknown>[] }[];
}

/**
 * El documento JSON completo con los overrides aplicados.
 *
 * Existe para poder pasar el resultado por `config/opc_mapping.schema.json` ANTES de guardar nada:
 * lo que se acepta tiene que seguir siendo un mapping legal, porque es el mismo documento que la
 * fase siguiente llevará a git. Valida la estructura, no la intención.
 *
 * Clona en profundidad. El `raw` del mapping cargado lo usa `resolveNamespaces()` en el arranque del
 * puente, y mutarlo aquí sería corromper la fuente de los NodeIds en caliente.
 */
export function aplicarSobreRaw(raw: unknown, overrides: MappingOverride[]): unknown {
  const doc = structuredClone(raw) as RawDoc;
  if (!Array.isArray(doc.plants)) return doc;

  for (const o of overrides) {
    const planta = doc.plants.find((p) => p.plantId === o.plantId);
    const senal = planta?.signals?.find((s) => s.domainKey === o.domainKey);
    if (!senal) continue;

    for (const campo of CAMPOS_EDITABLES) {
      const valor = o.patch[campo];
      if (valor === undefined) continue;
      // `null` significa «que no esté». En JSON Schema estos campos son opcionales y de tipo
      // number/string: dejar un null explícito lo haría INVÁLIDO, así que se borra la clave.
      if (valor === null) delete senal[campo];
      else senal[campo] = valor;
    }

    // El mando vive anidado, así que no cabe en el bucle de arriba. Solo se toca si la señal de
    // verdad tiene write spec: inventarle uno a una señal de lectura produciría un documento que el
    // schema rechaza («el write spec solo puede existir en una señal writable»).
    const write = senal.write as Record<string, unknown> | undefined;
    if (write) {
      if (o.patch.writeIndex !== undefined) {
        write.target = { ...(write.target as Record<string, unknown>), index: o.patch.writeIndex };
      }
      if (o.patch.writeCommands !== undefined) write.commands = { ...o.patch.writeCommands };
      if (o.patch.writeMode !== undefined) write.mode = o.patch.writeMode;
    }

    if (o.patch.stateOpen !== undefined || o.patch.stateClosed !== undefined) {
      const actual = (senal.stateEncoding as { open?: number; closed?: number } | undefined) ?? {};
      const open = o.patch.stateOpen !== undefined ? o.patch.stateOpen : actual.open;
      const closed = o.patch.stateClosed !== undefined ? o.patch.stateClosed : actual.closed;
      const encoding: { open?: number; closed?: number } = {};
      if (typeof open === 'number') encoding.open = open;
      if (typeof closed === 'number') encoding.closed = closed;
      // El schema exige minProperties: 1. Sin ninguna de las dos, la clave se borra entera.
      if (Object.keys(encoding).length > 0) senal.stateEncoding = encoding;
      else delete senal.stateEncoding;
    }

    senal.confidence = 'inferred';
  }

  return doc;
}
