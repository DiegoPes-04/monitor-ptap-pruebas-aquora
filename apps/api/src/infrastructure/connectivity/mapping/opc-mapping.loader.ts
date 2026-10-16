import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Carga config/opc_mapping.json y expone lo que el adaptador necesita para
 * suscribirse: la lista de buffers de datos por planta con su { nsUri, identifier }.
 * Fail-fast: si el archivo falta o no parsea, el proceso no arranca.
 *
 * NO valida el schema completo aquí (eso es scripts/validate-mapping.ts, gate de CI);
 * hace comprobaciones mínimas de forma para fallar temprano y claro.
 */

export interface NodeRef {
  nsUri: string;
  identifier: string; // con prefijo de tipo: g= | i= | s= | b=
}

export interface MonitorTarget {
  plantId: string;
  browseName: string;
  channel: string;
  node: NodeRef;
  arrayLength: number | null;
  dataType: string | null;
}

/** Par opMin/opMax para un tipo de día concreto (ver `SignalMapping.opRangeByDay`). */
export interface RangoOperativo {
  opMin?: number;
  opMax?: number;
}

/** Elemento de un buffer (canal + browseName + índice). Fase 5: destino/feedback de escritura. */
export interface BufferElementRef {
  channel: string;
  sourceBuffer: string;
  index: number;
}

/** Un paso de una orden compuesta: qué valor va a qué posición del buffer de salida. */
export interface WriteStep {
  index: number;
  value: number | boolean;
}

/**
 * Elemento de realimentación que dice cuándo soltar una señal sostenida (`pulse.until`).
 *
 * Se compara por VALOR COMPLETO, no por bits, y es una decisión deliberada: en La Vorágine
 * `INT_IN[1]` vale 1025 = bits{0,10}, así que una condición "bit 0 encendido" ya se cumpliría con la
 * válvula quieta y cortaría la señal antes de que llegara a moverse.
 */
export interface FeedbackRef {
  channel: string;
  sourceBuffer: string | null;
  index: number;
  equals: number | boolean;
}

/** Fase 5: traducción de comando de dominio a escritura de buffer/bit (vive en el mapping, regla 2). */
export interface WriteSpec {
  target: BufferElementRef; // buffer de SALIDA donde se escribe
  commands: Record<string, number | boolean>; // verbo → valor a escribir
  /**
   * ORDEN COMPUESTA: un verbo que necesita escribir VARIAS posiciones del mismo buffer para que el
   * equipo se mueva.
   *
   * Existe porque en La Sirena (y probablemente en el resto) la válvula la maneja un relé
   * conmutador en montaje de inversión de giro: una posición del buffer da el sentido y otra lo
   * quita. Escribir solo una **no puede mover la válvula jamás** — es exactamente por lo que la
   * prueba de campo del 2026-08-03 concluyó "canal sin actuador" cuando en realidad la orden
   * estaba incompleta.
   *
   * Reglas que el loader EXIGE (una secuencia que las incumpla invalida el spec entero y deja la
   * señal como no-writable, que es el lado seguro):
   *  1. el verbo debe existir también en `commands`, y el paso que toca `target.index` debe llevar
   *     el mismo valor — si no, el mapping se contradice a sí mismo;
   *  2. **primero se desenergiza, después se energiza**: ningún paso a cero puede ir detrás de uno
   *     distinto de cero. Al revés existe una ventana con las dos direcciones activas a la vez, que
   *     es justo lo que el protocolo declara ERROR;
   *  3. como mucho UNA posición queda energizada al final, por el mismo motivo;
   *  4. sin índices repetidos (dos valores para la misma posición es ambigüedad, no orden).
   *
   * Los pasos se escriben SIEMPRE en absoluto: la posición es el canal, no un bit dentro de una
   * palabra compartida, así que `mode: bitmask` es incompatible y también invalida el spec.
   */
  sequences?: Record<string, WriteStep[]>;
  /**
   * `true` ⇒ la orden es SOSTENIDA: el valor se queda puesto y NO se hace rollback si el estado no
   * confirma. Es lo correcto cuando cada verbo define un estado eléctrico completo y su opuesto es
   * el otro verbo (abrir = c0:1/c1:0, cerrar = c0:0/c1:1): deshacer un "abrir" a 0/0 dejaría el
   * actuador en un estado que no es ni abierto ni cerrado, y que nadie pidió.
   *
   * Incompatible con `pulse` (uno se limpia solo, el otro no debe limpiarse). Es la versión para
   * ÓRDENES COMPUESTAS (`sequences`, posiciones del array en absoluto); para un par de bits dentro
   * de una palabra compartida está `sustained`.
   */
  latched?: boolean;
  /**
   * `true` ⇒ SEÑAL SOSTENIDA en una palabra compartida. Integrador del PLC de La Vorágine,
   * 2026-10-16, textual: «estas señales deben ser sostenidas, es decir que todo el tiempo debe quedar
   * la señal de apertura o la señal de cierre, nunca las dos, siempre una de las dos».
   *
   * Cada verbo es una máscara de bits de `target` y la orden es UNA escritura read-modify-write:
   * `(actual & ~bitsDeLosOtrosVerbos) | bitsDelVerbo` (ver `WriteService.applyValue`). La palabra pasa
   * de un verbo al otro sin ningún instante con los dos (1/1) ni con ninguno (0/0), y los bits de las
   * demás válvulas de la palabra no se tocan. Y luego **no se suelta nunca**: ni al terminar, ni si el
   * estado no confirma, ni si algo falla — soltar es justo dejar la válvula en 0/0.
   *
   * Reglas que el loader EXIGE, y con las que el backend NO ARRANCA si se incumplen (ver
   * `motivoSostenidaInvalida`): `mode: 'bitmask'`; al menos dos verbos, cada uno una máscara entera
   * de 1 a 65535 y sin bits compartidos entre ellos; y prohibidos `pulse`, `rollbackValue`,
   * `sequences` y `latched`.
   *
   * Se llama `sustained` y no se reutilizó `latched` aunque ambos «no deshacen»: `latched` es de las
   * órdenes compuestas (posiciones en absoluto, con su `rollbackValue`), y en este código «enclavar»
   * significa otra cosa en los dos sitios donde aparece — un bit ENCLAVADO es la avería que el pulso
   * evita, y `latchMode: 'latch'` del simulador es un PLC que se mueve con el flanco, lo contrario de
   * lo que pidió el integrador. «Sostenida» es su palabra.
   */
  sustained?: boolean;
  /**
   * Cómo se aplica el valor sobre el elemento:
   *  - `absolute` (default): se escribe el valor tal cual (pisa la palabra completa).
   *  - `bitmask`: read-modify-write → activar = `(actual & ~bitsDeLosOtrosVerbos) | valor` (apaga el
   *    verbo contrario de la MISMA válvula en la misma escritura), limpiar = `actual & ~valor`.
   *    OBLIGATORIO cuando la palabra concentra VARIOS comandos/válvulas: escribir absoluto
   *    apagaría los bits ajenos que estuvieran activos (p. ej. otra válvula del mismo sitio).
   */
  mode: 'absolute' | 'bitmask';
  /**
   * Si está presente, el comando es un PULSO: se activa, se sostiene `holdMs` y se limpia
   * SIEMPRE (haya confirmado el estado o no). Sin esto, un comando `confirmed` dejaba el bit
   * ENCLAVADO para siempre, porque el rollback solo corría al fallar el read-back.
   *
   * Con `until`, el sostenido deja de ser a ciegas: se sondea ese elemento y el bit se suelta en
   * cuanto vale `equals`, que es como funciona un actuador motorizado — la señal se mantiene hasta
   * que el final de carrera avisa. Ahí `holdMs` pasa a ser el **tope duro**, no la duración: si la
   * realimentación no llega nunca (sensor averiado, válvula atascada) el bit se limpia igualmente y
   * el comando se reporta fallido. Nunca se sostiene indefinidamente, lo pida quien lo pida: dejar
   * una bobina energizada sin que nadie se entere es peor que abortar la maniobra.
   */
  pulse: { holdMs: number; until?: FeedbackRef } | null;
  readBack: {
    channel: string;
    sourceBuffer: string | null;
    index: number;
    confirmsWrittenValue: boolean;
    expectedValue?: number | boolean;
    /**
     * Estado esperado POR VERBO. Necesario cuando cada comando deja un estado distinto: abrir espera
     * `16385` y cerrar `16384`, así que un único `expectedValue` no puede confirmar ambos. Si el verbo
     * no está aquí, se cae a `confirmsWrittenValue`/`expectedValue`.
     */
    expectedByCommand?: Record<string, number | boolean>;
    /**
     * ¿La semántica de este canal de estado está VERIFICADA en campo? Default `true`.
     *
     * Con `false`, la falta de confirmación deja de significar «el equipo no respondió»: si el eco
     * demuestra que el valor quedó escrito en el canal de comando, el resultado es `sent`
     * (`SENT_STATE_UNVERIFIED`) en vez de `failed`. Existe porque el `expectedValue` de estas
     * plantas es una inferencia del patrón de Vorágine que nunca se observó en campo — y declarar
     * un fallo del equipo a partir de un número no verificado afirma tanto como declarar un éxito.
     */
    stateVerified: boolean;
  };
  timeoutMs: number;
  /**
   * Valor con el que se limpia un pulso en `absolute` y se deshace una orden no confirmada.
   * Obligatorio en todo spec SALVO en una orden sostenida (`sustained`), donde está PROHIBIDO: allí no
   * se deshace nada, y volver a este valor dejaría la válvula sin señal.
   */
  rollbackValue?: number | boolean;
  permission: string; // Permission de @ptap/shared (control_valves | acknowledge_alarms | adjust_setpoints)
}

/** Señal de proceso mapeada: un elemento de un buffer con semántica de dominio. */
export interface SignalMapping {
  plantId: string;
  buffer: string; // canal (realIn, intIn, …); refiere al buffer PRIMARIO de ese canal en el sitio
  /** browseName exacto del buffer fuente. Obligatorio si el canal tiene varios buffers del mismo tamaño (la resolución por tamaño sería no determinista). */
  sourceBuffer?: string | null;
  index: number;
  domainKey: string;
  label: string | null;
  unit: string | null;
  min: number | null;
  max: number | null;
  /** Rango operativo/normativo (se expone en el DTO para que el front lo muestre). */
  opMin?: number | null;
  opMax?: number | null;
  /**
   * Rango operativo que CAMBIA segun el dia. Cuando esta, MANDA sobre opMin/opMax para el tipo de
   * dia que toque; `opMin`/`opMax` quedan como valor por defecto. El caudal de salida de La Voragine
   * es 1-3 l/s entre semana y 1-2 l/s sabados, domingos y festivos (cliente, 2026-08-20).
   */
  opRangeByDay?: { semana?: RangoOperativo; finde?: RangoOperativo };
  mappingStatus: 'mapped' | 'unmapped';
  confidence: 'confirmed' | 'inferred' | 'estimated';
  writable: boolean;
  /** Presente solo si writable (⇒ confidence:confirmed, garantizado por el schema). */
  write?: WriteSpec;
  /**
   * Valores literales de la palabra de estado de válvula para sitios que NO usan la máscara
   * bit14/bit0. Viaja al DTO para que el front no tenga que conocer cada planta. Ver `SignalDto`.
   */
  stateEncoding?: { closed?: number; open?: number };
  /** Solo en válvulas: el caudal que corresponde a ESA válvula. Ver `SignalDto.flowDomainKey`. */
  flowDomainKey?: string;
  /** Solo en palabras de estado: `false` = se lee como diagnóstico pero NO decide el veredicto. */
  stateTrusted?: boolean;
}

export interface LoadedPlant {
  plantId: string;
  displayName: string;
  /** Ventana de liveness específica del sitio (s). null → usar el default de .env. */
  livenessWindowSec: number | null;
}

export interface LoadedMapping {
  version: string;
  protocolVersion: string;
  dtoVersion: string;
  plants: LoadedPlant[];
  targets: MonitorTarget[];
  signals: SignalMapping[];
  raw: unknown; // el documento completo, para resolveNamespaces()
}

// Canales de DATOS que se suscriben (1 MonitoredItem por buffer, regla 6).
// Se excluyen msgRead/msgWrite: son estructuras de diagnóstico, no arrays de proceso.
const DATA_CHANNELS = new Set(['realIn', 'realOut', 'intIn', 'intOut', 'bitIn', 'bitOut']);

function resolvePath(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.OPC_MAPPING_PATH,
    join(process.cwd(), 'config', 'opc_mapping.json'),
    join(process.cwd(), 'apps', 'api', 'config', 'opc_mapping.json'),
    join(__dirname, '..', '..', '..', '..', 'config', 'opc_mapping.json'),
  ].filter((c): c is string => !!c);

  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(`No se encontró opc_mapping.json. Rutas probadas: ${candidates.join(', ')}`);
  }
  return found;
}

/**
 * La ruta que `loadMapping()` cargaría con estos argumentos y este entorno. El simulador la usa para
 * comprobar que un escenario se está ejecutando contra el mapping que exige (ver sim-scenario.ts).
 */
export function resolverRutaDelMapping(explicitPath?: string): string {
  return resolvePath(explicitPath);
}

interface RawWriteSpec {
  target?: { channel?: string; sourceBuffer?: string; index?: number };
  commands?: Record<string, number | boolean>;
  sequences?: Record<string, Array<{ index?: unknown; value?: unknown }>>;
  latched?: unknown;
  sustained?: unknown;
  mode?: string;
  pulse?: { holdMs?: number; until?: { channel?: unknown; sourceBuffer?: unknown; index?: unknown; equals?: unknown } };
  readBack?: {
    channel?: string;
    sourceBuffer?: string;
    index?: number;
    confirmsWrittenValue?: boolean;
    expectedValue?: number | boolean;
    expectedByCommand?: Record<string, number | boolean>;
    stateVerified?: boolean;
  };
  timeoutMs?: number;
  rollbackValue?: number | boolean;
  permission?: string;
}

interface RawSignal {
  buffer?: string;
  sourceBuffer?: string;
  index?: number;
  domainKey?: string;
  label?: string;
  unit?: string;
  min?: number;
  max?: number;
  opMin?: number;
  opMax?: number;
  opRangeByDay?: { semana?: RangoOperativo; finde?: RangoOperativo };
  mappingStatus?: string;
  confidence?: string;
  writable?: boolean;
  write?: RawWriteSpec;
  stateEncoding?: { closed?: unknown; open?: unknown };
  flowDomainKey?: unknown;
  stateTrusted?: unknown;
}

/**
 * Valores literales de estado, solo si son números. Se descarta la clave que no lo sea en vez de
 * dejarla pasar: un `closed: "251"` que llegara como texto nunca casaría con el número del PLC y
 * daría una válvula eternamente "sin estado" difícil de explicar.
 */
function parseStateEncoding(raw: RawSignal['stateEncoding']): SignalMapping['stateEncoding'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const enc: { closed?: number; open?: number } = {};
  if (typeof raw.closed === 'number') enc.closed = raw.closed;
  if (typeof raw.open === 'number') enc.open = raw.open;
  return enc.closed === undefined && enc.open === undefined ? undefined : enc;
}

/** Normaliza `pulse.until`. Devuelve undefined si le falta algo: nunca se completa a medias. */
function parseFeedback(raw: NonNullable<RawWriteSpec['pulse']>['until']): FeedbackRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  if (typeof raw.channel !== 'string' || typeof raw.index !== 'number') return undefined;
  if (typeof raw.equals !== 'number' && typeof raw.equals !== 'boolean') return undefined;
  return {
    channel: raw.channel,
    sourceBuffer: typeof raw.sourceBuffer === 'string' ? raw.sourceBuffer : null,
    index: raw.index,
    equals: raw.equals,
  };
}

/** Un paso está "energizado" si su valor no es cero/false. La posición en reposo es el 0. */
function energizado(value: number | boolean): boolean {
  return value !== 0 && value !== false;
}

/**
 * Valida una orden compuesta y devuelve el motivo del rechazo, o null si es correcta.
 *
 * Esto NO es una comprobación de forma (de eso se encarga el schema): son las reglas ELÉCTRICAS.
 * Se comprueban aquí, al cargar, y no al ejecutar, porque una secuencia mal escrita es un error del
 * mapping que debe descubrirse en `validate:mapping` o en el arranque — no con el operador delante
 * del tablero y la válvula a medio recorrido.
 */
export function motivoSecuenciaInvalida(
  verb: string,
  steps: WriteStep[],
  spec: { target: BufferElementRef; commands: Record<string, number | boolean>; mode: 'absolute' | 'bitmask' },
): string | null {
  if (steps.length === 0) return `${verb}: secuencia vacía`;
  if (spec.mode === 'bitmask') {
    return `${verb}: una secuencia escribe posiciones completas, no bits — mode debe ser 'absolute'`;
  }

  const vistos = new Set<number>();
  for (const s of steps) {
    if (vistos.has(s.index)) return `${verb}: la posición ${s.index} aparece dos veces`;
    vistos.add(s.index);
  }

  // El paso que toca el target primario tiene que decir lo mismo que `commands`, o el mapping se
  // contradice y no hay forma de saber cuál de los dos valores es el que se quiso.
  const primario = steps.find((s) => s.index === spec.target.index);
  if (!primario) return `${verb}: la secuencia no toca el canal primario (posición ${spec.target.index})`;
  if (primario.value !== spec.commands[verb]) {
    return `${verb}: la secuencia escribe ${String(primario.value)} en la posición ${spec.target.index} pero commands dice ${String(spec.commands[verb])}`;
  }

  // Desenergizar SIEMPRE antes de energizar: si un paso a cero va detrás de uno energizado, existe
  // una ventana con las dos direcciones activas.
  const primeroEnergizado = steps.findIndex((s) => energizado(s.value));
  if (primeroEnergizado >= 0) {
    const ceroTardio = steps.findIndex((s, i) => i > primeroEnergizado && !energizado(s.value));
    if (ceroTardio >= 0) {
      return `${verb}: el paso ${ceroTardio} (posición ${steps[ceroTardio].index}) desenergiza DESPUÉS de energizar — hay que soltar la dirección contraria primero`;
    }
  }

  const energizados = steps.filter((s) => energizado(s.value));
  if (energizados.length > 1) {
    return `${verb}: dejaría ${energizados.length} posiciones energizadas a la vez (${energizados.map((s) => s.index).join(', ')}) — dos direcciones opuestas activas es el fallo que el protocolo prohíbe`;
  }
  return null;
}

/** Algo está declarado si está y no es `null` (un `WriteSpec` parseado lleva `pulse: null` sin pulso). */
function declarado(v: unknown): boolean {
  return v !== undefined && v !== null;
}

/**
 * Valida una orden SOSTENIDA (`sustained: true`) y devuelve el motivo del rechazo, o null si es
 * correcta.
 *
 * Igual que `motivoSecuenciaInvalida`, esto no es forma: son las reglas que hacen que la orden cumpla
 * lo que pide el integrador — siempre abrir o cerrar puesto, nunca los dos, nunca ninguno. La usan el
 * loader (que con un spec sostenido inválido NO arranca), `validate:mapping`, la edición del mapeo en
 * caliente y el WriteService justo antes de escribir.
 *
 * Sirve para el JSON crudo y para un `WriteSpec` ya parseado, y por eso mira PRESENCIA, no validez:
 * un `pulse` mal escrito al lado de `sustained` sigue siendo pedir dos cosas opuestas.
 */
export function motivoSostenidaInvalida(spec: {
  commands?: unknown;
  mode?: unknown;
  pulse?: unknown;
  rollbackValue?: unknown;
  sequences?: unknown;
  latched?: unknown;
}): string | null {
  if (spec.mode !== 'bitmask') {
    return `mode debe ser 'bitmask' y es ${JSON.stringify(spec.mode ?? 'absolute (por omisión)')}: cada verbo es un bit de una palabra que pueden compartir varias válvulas, y escribirla en absoluto borraría el par de las demás`;
  }
  if (declarado(spec.pulse)) {
    return 'sustained y pulse son excluyentes: un pulso se LIMPIA al terminar, y una señal sostenida no se suelta nunca';
  }
  if (declarado(spec.rollbackValue)) {
    return 'una orden sostenida no lleva rollbackValue: no se deshace nunca, y volver a ese valor dejaría la válvula sin señal (0/0), que es justo lo que la regla prohíbe';
  }
  if (declarado(spec.sequences)) {
    return 'sustained no admite sequences: una orden compuesta escribe posiciones enteras en absoluto, y la sostenida es un par de bits dentro de una palabra';
  }
  if (spec.latched === true) {
    return 'sustained y latched no se combinan: latched es de las órdenes compuestas, y sustained ya implica no deshacer nunca';
  }
  if (!spec.commands || typeof spec.commands !== 'object') return 'sin commands';
  const verbos = Object.entries(spec.commands as Record<string, unknown>);
  if (verbos.length < 2) {
    return `una orden sostenida necesita al menos dos verbos (abrir y cerrar), y hay ${verbos.length}: sin el contrario, la señal no se podría cambiar nunca`;
  }
  let usados = 0;
  for (const [verbo, valor] of verbos) {
    if (typeof valor !== 'number' || !Number.isInteger(valor) || valor < 1 || valor > 0xffff) {
      return `${verbo}: en una orden sostenida cada verbo es una máscara de bits entera de 1 a 65535, y vale ${JSON.stringify(valor)}`;
    }
    if ((usados & valor) !== 0) {
      return `${verbo} (${valor}) comparte bits con otro verbo de la misma válvula: activarlo dejaría puesto parte del contrario — abrir y cerrar a la vez`;
    }
    usados |= valor;
  }
  return null;
}

/** Lo mínimo de una señal para saber por qué palabra manda y con qué bits. Vale para JSON crudo. */
export interface SenalConMando {
  plantId: string;
  domainKey: string;
  write?: {
    target?: { channel?: unknown; sourceBuffer?: unknown; index?: unknown };
    mode?: unknown;
    commands?: unknown;
    sustained?: unknown;
  };
}

/**
 * Válvulas que mandan por la MISMA palabra (misma planta, buffer e índice) en `bitmask` no pueden
 * compartir ni un bit: si lo compartieran, la orden de una encendería o apagaría un verbo de la otra.
 * Con dos válvulas sostenidas en `INT_OUT_VORAGINE[0]` un copia-y-pega de 4096/8192 en la de entrada
 * haría que «abrir entrada» abriera la SALIDA, y ninguna regla por válvula lo vería.
 *
 * Devuelve un aviso por par en conflicto, con las dos válvulas; `sostenida` dice si alguna de las
 * dos lo es (el loader solo se niega a arrancar por esas; `validate:mapping` las rechaza todas).
 */
export function bitsCompartidosEntreValvulas(
  senales: SenalConMando[],
): Array<{ motivo: string; sostenida: boolean; valvulas: [string, string] }> {
  const porPalabra = new Map<string, Array<{ domainKey: string; bits: number; sostenida: boolean }>>();
  for (const s of senales) {
    const w = s.write;
    if (!w || w.mode !== 'bitmask' || !w.target || !w.commands || typeof w.commands !== 'object') continue;
    const { channel, sourceBuffer, index } = w.target;
    if (typeof sourceBuffer !== 'string' || typeof index !== 'number') continue;
    let bits = 0;
    for (const v of Object.values(w.commands as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isInteger(v)) bits |= v & 0xffff;
    }
    const palabra = `${s.plantId}/${String(channel)}/${sourceBuffer}[${index}]`;
    const lista = porPalabra.get(palabra) ?? [];
    lista.push({ domainKey: s.domainKey, bits, sostenida: w.sustained === true });
    porPalabra.set(palabra, lista);
  }
  const conflictos: Array<{ motivo: string; sostenida: boolean; valvulas: [string, string] }> = [];
  for (const [palabra, valvulas] of porPalabra) {
    for (let i = 0; i < valvulas.length; i++) {
      for (let j = i + 1; j < valvulas.length; j++) {
        const comun = valvulas[i].bits & valvulas[j].bits;
        if (comun === 0) continue;
        conflictos.push({
          motivo: `${valvulas[i].domainKey} y ${valvulas[j].domainKey} mandan por ${palabra} y comparten bits (${comun}): la orden de una movería a la otra`,
          sostenida: valvulas[i].sostenida || valvulas[j].sostenida,
          valvulas: [valvulas[i].domainKey, valvulas[j].domainKey],
        });
      }
    }
  }
  return conflictos;
}

function parseSequences(
  raw: RawWriteSpec['sequences'],
  spec: { target: BufferElementRef; commands: Record<string, number | boolean>; mode: 'absolute' | 'bitmask' },
): { sequences?: Record<string, WriteStep[]>; error?: string } {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, WriteStep[]> = {};
  for (const [verb, pasos] of Object.entries(raw)) {
    if (!Array.isArray(pasos)) return { error: `${verb}: sequences debe ser una lista de pasos` };
    if (!(verb in spec.commands)) return { error: `${verb}: tiene secuencia pero no está en commands` };
    const steps: WriteStep[] = [];
    for (const p of pasos) {
      if (typeof p?.index !== 'number' || (typeof p?.value !== 'number' && typeof p?.value !== 'boolean')) {
        return { error: `${verb}: paso inválido (se espera {index: number, value: number|boolean})` };
      }
      steps.push({ index: p.index, value: p.value });
    }
    const motivo = motivoSecuenciaInvalida(verb, steps, spec);
    if (motivo) return { error: motivo };
    out[verb] = steps;
  }
  return { sequences: Object.keys(out).length > 0 ? out : undefined };
}

/**
 * Parsea el write spec. Confía en que el schema ya validó la forma (validate:mapping es el
 * gate); aquí solo se normaliza. Devuelve undefined si la señal no es writable o no lo trae.
 *
 * La excepción es la orden SOSTENIDA: si incumple sus reglas, esto LANZA y el backend no arranca.
 * Descartarla en silencio, como se hace con lo demás, dejaría las válvulas sin mando tras un
 * despliegue sin que nadie lo supiera hasta que un operario lo intentara; y aplicarla a medias
 * (con un pulso, con un rollbackValue) haría justo lo que el integrador prohíbe: soltar la señal.
 * `donde` es `planta/domainKey`, para que el mensaje diga qué corregir.
 */
function parseWriteSpec(raw: RawWriteSpec | undefined, donde: string): WriteSpec | undefined {
  if (!raw || !raw.target || !raw.commands || !raw.readBack) return undefined;
  const { channel, sourceBuffer, index } = raw.target;
  if (typeof channel !== 'string' || typeof sourceBuffer !== 'string' || typeof index !== 'number') return undefined;
  if (typeof raw.readBack.channel !== 'string' || typeof raw.readBack.index !== 'number') return undefined;
  if (typeof raw.timeoutMs !== 'number' || typeof raw.permission !== 'string') return undefined;

  if (raw.sustained !== undefined && typeof raw.sustained !== 'boolean') {
    throw new Error(`opc_mapping.json: ${donde}: write.sustained tiene que ser true o false, y vale ${JSON.stringify(raw.sustained)}`);
  }
  const sustained = raw.sustained === true;
  if (sustained) {
    const motivo = motivoSostenidaInvalida(raw);
    if (motivo) {
      throw new Error(
        `opc_mapping.json: ${donde}: orden SOSTENIDA inválida — ${motivo}. El backend no arranca con este mapping; \`npm run validate:mapping\` lo detecta antes de desplegar.`,
      );
    }
  } else if (raw.rollbackValue === undefined) {
    return undefined;
  }

  const mode = raw.mode === 'bitmask' ? 'bitmask' : 'absolute';
  const pulse = typeof raw.pulse?.holdMs === 'number' && raw.pulse.holdMs > 0
    ? { holdMs: raw.pulse.holdMs, ...(parseFeedback(raw.pulse.until) ? { until: parseFeedback(raw.pulse.until)! } : {}) }
    : null;
  const latched = raw.latched === true;

  // Un `until` mal escrito NO puede degradar en silencio a un sostenido a ciegas de 45 s: el bit se
  // quedaría puesto tres cuartos de minuto sin que nadie lo hubiera pedido. Se descarta el spec.
  if (raw.pulse?.until !== undefined && !pulse?.until) {
    console.error(`[opc-mapping] write spec DESCARTADO en ${sourceBuffer}[${index}]: pulse.until incompleto (se esperan channel, index y equals)`);
    return undefined;
  }

  // Fallar CERRADO: un spec compuesto que no cumple las reglas eléctricas deja la señal como no
  // writable (el WriteService responderá TARGET_NOT_WRITABLE) en vez de accionar equipo con una
  // orden que el propio mapping declara contradictoria. Se grita en el log porque una válvula que
  // deja de responder sin explicación es peor que un arranque ruidoso.
  const seq = parseSequences(raw.sequences, { target: { channel, sourceBuffer, index }, commands: raw.commands, mode });
  if (seq.error) {
    console.error(`[opc-mapping] write spec DESCARTADO en ${sourceBuffer}[${index}]: ${seq.error}`);
    return undefined;
  }
  if (latched && pulse) {
    console.error(`[opc-mapping] write spec DESCARTADO en ${sourceBuffer}[${index}]: latched y pulse son excluyentes`);
    return undefined;
  }

  return {
    target: { channel, sourceBuffer, index },
    commands: raw.commands,
    ...(seq.sequences ? { sequences: seq.sequences } : {}),
    ...(latched ? { latched: true } : {}),
    ...(sustained ? { sustained: true } : {}),
    mode,
    pulse,
    readBack: {
      channel: raw.readBack.channel,
      sourceBuffer: typeof raw.readBack.sourceBuffer === 'string' ? raw.readBack.sourceBuffer : null,
      index: raw.readBack.index,
      confirmsWrittenValue: raw.readBack.confirmsWrittenValue !== false,
      expectedValue: raw.readBack.expectedValue,
      expectedByCommand: raw.readBack.expectedByCommand,
      // Default true: un canal se presume verificado salvo que el mapping diga lo contrario. Así,
      // omitir la clave conserva el comportamiento estricto de siempre.
      stateVerified: raw.readBack.stateVerified !== false,
    },
    timeoutMs: raw.timeoutMs,
    // Ausente solo en una orden sostenida (arriba se comprobó): la clave ni aparece, para que nadie
    // pueda leer un `undefined` como «limpiar a 0».
    ...(raw.rollbackValue !== undefined ? { rollbackValue: raw.rollbackValue } : {}),
    permission: raw.permission,
  };
}

/**
 * Cache por ruta resuelta: el mapping es INMUTABLE en runtime (no hay hot-reload), así que
 * releer + re-parsear 80 KB en cada llamada es desperdicio (reports.service lo invocaba por
 * request). Ahora todos los consumidores comparten el mismo objeto parseado.
 * `clearMappingCache()` existe para los tests.
 */
const mappingCache = new Map<string, LoadedMapping>();
export function clearMappingCache(): void {
  mappingCache.clear();
}

export function loadMapping(explicitPath?: string): LoadedMapping {
  const path = resolvePath(explicitPath);
  const cached = mappingCache.get(path);
  if (cached) return cached;
  const doc = JSON.parse(readFileSync(path, 'utf8')) as {
    version?: string;
    protocolVersion?: string;
    dtoVersion?: string;
    plants?: Array<{
      plantId?: string;
      displayName?: string;
      livenessWindowSec?: number;
      opcBuffers?: Record<
        string,
        Array<{ browseName?: string; node?: { nsUri?: string; identifier?: string }; arrayLength?: number | null; dataType?: string | null }>
      >;
      signals?: RawSignal[];
    }>;
  };

  if (!Array.isArray(doc.plants) || doc.plants.length === 0) {
    throw new Error(`opc_mapping.json inválido (${path}): sin plants[]`);
  }

  const targets: MonitorTarget[] = [];
  const signals: SignalMapping[] = [];
  const plants: LoadedPlant[] = [];

  for (const plant of doc.plants) {
    if (!plant.plantId) throw new Error(`opc_mapping.json: planta sin plantId en ${path}`);
    plants.push({
      plantId: plant.plantId,
      displayName: plant.displayName ?? plant.plantId,
      livenessWindowSec: typeof plant.livenessWindowSec === 'number' ? plant.livenessWindowSec : null,
    });

    for (const [channel, buffers] of Object.entries(plant.opcBuffers ?? {})) {
      if (!DATA_CHANNELS.has(channel)) continue;
      for (const b of buffers ?? []) {
        if (!b.browseName || !b.node?.nsUri || !b.node?.identifier) {
          throw new Error(`opc_mapping.json: buffer inválido en ${plant.plantId}/${channel}`);
        }
        targets.push({
          plantId: plant.plantId,
          browseName: b.browseName,
          channel,
          node: { nsUri: b.node.nsUri, identifier: b.node.identifier },
          arrayLength: typeof b.arrayLength === 'number' ? b.arrayLength : null,
          dataType: typeof b.dataType === 'string' ? b.dataType : null,
        });
      }
    }

    for (const s of plant.signals ?? []) {
      if (!s.buffer || typeof s.index !== 'number' || !s.domainKey) {
        throw new Error(`opc_mapping.json: signal inválida en ${plant.plantId} (buffer/index/domainKey)`);
      }
      signals.push({
        plantId: plant.plantId,
        buffer: s.buffer,
        sourceBuffer: typeof s.sourceBuffer === 'string' ? s.sourceBuffer : null,
        index: s.index,
        domainKey: s.domainKey,
        label: s.label ?? null,
        unit: s.unit ?? null,
        min: typeof s.min === 'number' ? s.min : null,
        max: typeof s.max === 'number' ? s.max : null,
        opMin: typeof s.opMin === 'number' ? s.opMin : null,
        opMax: typeof s.opMax === 'number' ? s.opMax : null,
        ...(s.opRangeByDay ? { opRangeByDay: s.opRangeByDay } : {}),
        mappingStatus: s.mappingStatus === 'unmapped' ? 'unmapped' : 'mapped',
        confidence: (s.confidence as SignalMapping['confidence']) ?? 'inferred',
        writable: s.writable === true,
        write: s.writable === true ? parseWriteSpec(s.write, `${plant.plantId}/${s.domainKey}`) : undefined,
        stateEncoding: parseStateEncoding(s.stateEncoding),
        flowDomainKey: typeof s.flowDomainKey === 'string' ? s.flowDomainKey : undefined,
        stateTrusted: typeof s.stateTrusted === 'boolean' ? s.stateTrusted : undefined,
      });
    }
  }

  // Dos válvulas de la misma palabra que comparten un bit: si alguna es SOSTENIDA, no se arranca —
  // con la señal puesta para siempre, la orden de una movería a la otra sin que nadie lo pidiera.
  // Si ninguna lo es, se avisa y sigue (validate:mapping las rechaza todas antes de desplegar).
  for (const c of bitsCompartidosEntreValvulas(signals)) {
    if (c.sostenida) throw new Error(`opc_mapping.json (${path}): ${c.motivo}. El backend no arranca con este mapping.`);
    console.error(`[opc-mapping] ${c.motivo}`);
  }

  const result: LoadedMapping = {
    version: doc.version ?? '0.0.0',
    protocolVersion: doc.protocolVersion ?? 'v0',
    dtoVersion: doc.dtoVersion ?? 'v1',
    plants,
    targets,
    signals,
    raw: doc,
  };
  mappingCache.set(path, result);
  return result;
}
