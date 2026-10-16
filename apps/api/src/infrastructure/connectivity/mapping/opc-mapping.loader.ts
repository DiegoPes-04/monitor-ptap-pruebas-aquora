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
   * Incompatible con `pulse` (uno se limpia solo, el otro no debe limpiarse).
   */
  latched?: boolean;
  /**
   * Cómo se aplica el valor sobre el elemento:
   *  - `absolute` (default): se escribe el valor tal cual (pisa la palabra completa).
   *  - `bitmask`: read-modify-write → activar = `actual | valor`, limpiar = `actual & ~valor`.
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
  rollbackValue: number | boolean;
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
 */
function parseWriteSpec(raw: RawWriteSpec | undefined): WriteSpec | undefined {
  if (!raw || !raw.target || !raw.commands || !raw.readBack) return undefined;
  const { channel, sourceBuffer, index } = raw.target;
  if (typeof channel !== 'string' || typeof sourceBuffer !== 'string' || typeof index !== 'number') return undefined;
  if (typeof raw.readBack.channel !== 'string' || typeof raw.readBack.index !== 'number') return undefined;
  if (typeof raw.timeoutMs !== 'number' || typeof raw.permission !== 'string') return undefined;
  if (raw.rollbackValue === undefined) return undefined;

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
    rollbackValue: raw.rollbackValue,
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
        write: s.writable === true ? parseWriteSpec(s.write) : undefined,
        stateEncoding: parseStateEncoding(s.stateEncoding),
        flowDomainKey: typeof s.flowDomainKey === 'string' ? s.flowDomainKey : undefined,
        stateTrusted: typeof s.stateTrusted === 'boolean' ? s.stateTrusted : undefined,
      });
    }
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
