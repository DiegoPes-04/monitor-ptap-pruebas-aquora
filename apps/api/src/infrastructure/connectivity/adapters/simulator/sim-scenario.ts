import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { LoadedMapping } from '../../mapping/opc-mapping.loader';

/**
 * Escenarios del SIMULADOR (solo `CONNECTIVITY_PROVIDER=simulator`).
 *
 * Un escenario dice CÓMO se comporta la planta simulada: cuánto tarda cada válvula en recorrer, si el
 * PLC local enclava con el flanco o hay que sostener el bit, cada cuánto cicla la MSG maestro→local,
 * la latencia del enlace OPC UA y el valor inicial de cada elemento. Lo hace SIN tocar
 * `config/opc_mapping.json`, y puede además apuntar a un mapping de PRUEBA (p. ej. tres válvulas en la
 * misma palabra INT_OUT) para ensayar una asignación de bits antes de que exista en el PLC.
 *
 * Lo que NO hay aquí es semántica de planta: qué bit abre, qué buffer manda, qué valor confirma. Eso
 * sigue saliendo del mapping (regla 2), y el simulador lo LEE de ahí. El escenario solo pone los
 * parámetros físicos que el mapping no tiene porque nadie los conoce todavía con certeza (recorrido,
 * enclavamiento, ciclo de la MSG). Ver docs/PRUEBAS_LOCALES_VALVULAS.md.
 */

export type SimValue = number | boolean;
/** `hold`: la válvula se mueve SOLO mientras el bit está puesto. `latch`: basta el flanco. */
export type SimLatchMode = 'hold' | 'latch';
/** `auto`: realimentación derivada del mapping (PLC ideal). `none`: el PLC no informa de nada. */
export type SimFeedbackMode = 'auto' | 'none';

/** Valores de un elemento de entrada por estado de la válvula, declarados a mano en el escenario. */
export interface SimFeedbackElement {
  /** `BUFFER[indice]` de la MISMA planta que la válvula. */
  element: string;
  open?: SimValue;
  closed?: SimValue;
  /** Mientras recorre (abriendo o cerrando). */
  moving?: SimValue;
  /** Parada entre los dos topes (un sostenido que se soltó antes de tiempo). */
  mid?: SimValue;
  error?: SimValue;
}

export interface SimValveConfig {
  /** Recorrido completo, de tope a tope. 0 = instantáneo. */
  travelMs: number;
  latchMode: SimLatchMode;
  initialState: 'open' | 'closed';
  feedback: SimFeedbackMode;
  /** Caudal con la válvula abierta del todo (si el mapping declara `flowDomainKey`). Cerrada = 0. */
  flowOpen: number;
  /** Valor de `pulse.until` cuando NO se cumple. null = 0 (o `!equals` si es booleano). */
  untilIdleValue: SimValue | null;
  /** Valor de las palabras de estado fuera de los topes (moviendo, a medias, error). null = 0/false. */
  otherStateValue: SimValue | null;
  /** Qué verbo del mapping abre y cuál cierra. Por defecto `open` y `close`, los de la app. */
  verbs: { open: string; close: string };
  feedbackElements: SimFeedbackElement[];
}

export interface SimPlantConfig {
  /** Ciclo de la MSG maestro→PLC local: cada cuánto ve el PLC local la palabra de mando. 0 = al instante. */
  msgCycleMs: number;
  msgPhaseMs: number;
  /** Ciclo de vuelta PLC local→maestro (MSG_READ): cada cuánto llega la realimentación. 0 = al instante. */
  feedbackCycleMs: number;
  feedbackPhaseMs: number;
}

/** Parámetros ya resueltos con los que se construye el simulador. */
export interface SimulatorOptions {
  name: string;
  /** Archivo del escenario (diagnóstico). null = valores por defecto, sin escenario. */
  source: string | null;
  /** Mapping que el escenario exige, si declara uno (ruta absoluta). */
  mappingPath: string | null;
  /** Ida y vuelta de cada lectura/escritura OPC UA. La escritura surte efecto a mitad del viaje. */
  ioLatencyMs: number;
  /** Entradas no ligadas a válvulas con valores sintéticos que cambian (mantienen `live`). */
  syntheticInputs: boolean;
  /** Tope del historial de escrituras en RAM (regla 12: acotado). */
  historyCapacity: number;
  defaults: SimValveConfig & PartialPlant;
  plants: Record<string, Partial<SimPlantConfig>>;
  /** `plantId/domainKey` → lo que cambia respecto a `defaults`. */
  valves: Record<string, SimValveOverrides>;
  /** `plantId/BUFFER[indice]` → valor inicial. */
  initialValues: Record<string, SimValue>;
}

/** Lo que un escenario puede cambiar de una válvula: cualquier campo, y de los verbos solo uno. */
export type SimValveOverrides = Partial<Omit<SimValveConfig, 'verbs'>> & { verbs?: Partial<SimValveConfig['verbs']> };

type PartialPlant = Omit<SimPlantConfig, 'feedbackCycleMs' | 'feedbackPhaseMs'> & {
  feedbackCycleMs: number | null;
  feedbackPhaseMs: number | null;
};

/**
 * Valores por defecto. Son SUPUESTOS documentados, no datos de planta: cada uno se puede cambiar en
 * el escenario, y la lista de lo que falta confirmar en campo está en docs/PRUEBAS_LOCALES_VALVULAS.md.
 *
 *  - `msgCycleMs: 8000`: el ciclo de la MSG maestro→local medido en La Sirena
 *    (docs/archivo/PRUEBA_VALVULA_SIRENA.md). Es lo que obliga a sostener el bit 45 s.
 *  - `travelMs: 30000`: recorrido supuesto. El integrador no informó del real.
 *  - `latchMode: 'hold'`: lo conservador. Las dos válvulas verificadas (Vorágine y Sirena) necesitaron
 *    la señal sostenida; si el PLC local enclavara con el flanco, sostener no cambiaría nada.
 */
export const SIM_DEFAULTS: SimValveConfig & SimPlantConfig = {
  travelMs: 30_000,
  latchMode: 'hold',
  initialState: 'closed',
  feedback: 'auto',
  flowOpen: 10,
  untilIdleValue: null,
  otherStateValue: null,
  verbs: { open: 'open', close: 'close' },
  feedbackElements: [],
  msgCycleMs: 8_000,
  msgPhaseMs: 0,
  feedbackCycleMs: 8_000,
  feedbackPhaseMs: 0,
};

const HISTORIAL_POR_DEFECTO = 5_000;

// ── Forma del JSON ─────────────────────────────────────────────────────────────────

const valor = z.union([z.number().finite(), z.boolean()]);
const milisegundos = z.number().int().min(0);
/** 0 = instantáneo; si no, al menos 10 ms (un ciclo de 1 ms solo sirve para colgar el simulador). */
const ciclo = milisegundos.max(600_000).refine((v) => v === 0 || v >= 10, 'un ciclo es 0 (instantáneo) o al menos 10 ms');
const REF_ELEMENTO = /^[A-Za-z0-9_]+\[\d+\]$/;
const REF_ELEMENTO_GLOBAL = /^[a-z][a-z0-9-]*\/[A-Za-z0-9_]+\[\d+\]$/;

const elementoSchema = z
  .object({
    element: z.string().regex(REF_ELEMENTO, 'se espera BUFFER[indice]'),
    open: valor.optional(),
    closed: valor.optional(),
    moving: valor.optional(),
    mid: valor.optional(),
    error: valor.optional(),
  })
  .strict();

const valvulaShape = {
  _nota: z.string().optional(),
  travelMs: milisegundos.max(600_000).optional(),
  latchMode: z.enum(['hold', 'latch']).optional(),
  initialState: z.enum(['open', 'closed']).optional(),
  feedback: z.enum(['auto', 'none']).optional(),
  flowOpen: z.number().finite().min(0).optional(),
  untilIdleValue: valor.optional(),
  otherStateValue: valor.optional(),
  verbs: z.object({ open: z.string().min(1).optional(), close: z.string().min(1).optional() }).strict().optional(),
  feedbackElements: z.array(elementoSchema).optional(),
};

const initialValuesSchema = z.record(z.string(), valor).superRefine((values, ctx) => {
  for (const key of Object.keys(values)) {
    if (!REF_ELEMENTO_GLOBAL.test(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'se espera plantId/BUFFER[indice]',
      });
    }
  }
});

const plantaShape = {
  _nota: z.string().optional(),
  msgCycleMs: ciclo.optional(),
  msgPhaseMs: milisegundos.optional(),
  feedbackCycleMs: ciclo.optional(),
  feedbackPhaseMs: milisegundos.optional(),
};

export const escenarioSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    /** Ruta del mapping, RELATIVA al archivo del escenario. Ausente = el que use la app. */
    mapping: z.string().min(1).optional(),
    ioLatencyMs: milisegundos.max(30_000).optional(),
    syntheticInputs: z.boolean().optional(),
    historyCapacity: z.number().int().min(1).max(1_000_000).optional(),
    defaults: z.object({ ...valvulaShape, ...plantaShape }).strict().optional(),
    plants: z.record(z.string(), z.object(plantaShape).strict()).optional(),
    valves: z.record(z.string(), z.object(valvulaShape).strict()).optional(),
    initialValues: initialValuesSchema.optional(),
  })
  .strict();

export type SimScenarioFile = z.infer<typeof escenarioSchema>;

// ── Resolución de rutas ─────────────────────────────────────────────────────────────

/** Carpeta de escenarios versionados: apps/api/fixtures/sim-scenarios. */
export function directoriosDeEscenarios(): string[] {
  return [
    // src|dist/infrastructure/connectivity/adapters/simulator → 5 niveles arriba = apps/api
    join(__dirname, '..', '..', '..', '..', '..', 'fixtures', 'sim-scenarios'),
    join(process.cwd(), 'fixtures', 'sim-scenarios'),
    join(process.cwd(), 'apps', 'api', 'fixtures', 'sim-scenarios'),
  ];
}

/**
 * `SIM_SCENARIO` admite una ruta (absoluta o relativa al directorio actual) o el NOMBRE de un escenario
 * versionado (`tres-valvulas` → fixtures/sim-scenarios/tres-valvulas.json). Falla con todas las rutas
 * probadas: un escenario que no se encuentra no puede degradar en silencio a los valores por defecto.
 */
export function resolverRutaEscenario(nombreORuta: string, cwd = process.cwd()): string {
  const conExtension = nombreORuta.endsWith('.json') ? nombreORuta : `${nombreORuta}.json`;
  const candidatos = isAbsolute(nombreORuta)
    ? [nombreORuta]
    : [
        resolve(cwd, nombreORuta),
        resolve(cwd, conExtension),
        ...directoriosDeEscenarios().map((d) => join(d, conExtension)),
      ];
  const encontrado = candidatos.find((c) => c.toLowerCase().endsWith('.json') && existsSync(c) && statSync(c).isFile());
  if (!encontrado) {
    throw new Error(`Escenario del simulador no encontrado: "${nombreORuta}". Rutas probadas: ${candidatos.join(', ')}`);
  }
  return encontrado;
}

export interface EscenarioLeido {
  archivo: string;
  escenario: SimScenarioFile;
  /** Ruta ABSOLUTA del mapping que declara el escenario, o null. */
  rutaMapping: string | null;
}

/** Lee y valida la FORMA de un escenario. Los errores dicen qué campo y por qué. */
export function leerEscenario(archivo: string): EscenarioLeido {
  let crudo: unknown;
  try {
    crudo = JSON.parse(readFileSync(archivo, 'utf8'));
  } catch (err) {
    throw new Error(`Escenario del simulador ilegible (${archivo}): ${err instanceof Error ? err.message : err}`);
  }
  const r = escenarioSchema.safeParse(crudo);
  if (!r.success) {
    const detalle = r.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ');
    throw new Error(`Escenario del simulador inválido (${archivo}): ${detalle}`);
  }
  const rutaMapping = r.data.mapping ? resolve(dirname(archivo), r.data.mapping) : null;
  if (rutaMapping && !existsSync(rutaMapping)) {
    throw new Error(`El escenario ${archivo} apunta a un mapping que no existe: ${rutaMapping}`);
  }
  return { archivo, escenario: r.data, rutaMapping };
}

// ── Opciones resueltas ──────────────────────────────────────────────────────────────

/** Sin escenario: los supuestos por defecto, sobre el mapping que use la app. */
export function opcionesPorDefecto(): SimulatorOptions {
  return {
    name: 'por-defecto',
    source: null,
    mappingPath: null,
    ioLatencyMs: 0,
    syntheticInputs: true,
    historyCapacity: HISTORIAL_POR_DEFECTO,
    defaults: { ...SIM_DEFAULTS, feedbackCycleMs: null, feedbackPhaseMs: null },
    plants: {},
    valves: {},
    initialValues: {},
  };
}

function sinUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function valvulaParcial(p: NonNullable<SimScenarioFile['valves']>[string]): SimValveOverrides {
  const { _nota: _ignorada, verbs, ...resto } = p;
  void _ignorada;
  const parcial = sinUndefined(resto) as SimValveOverrides;
  if (verbs) parcial.verbs = sinUndefined(verbs);
  return parcial;
}

function plantaParcial(p: NonNullable<SimScenarioFile['plants']>[string]): Partial<SimPlantConfig> {
  const { _nota: _ignorada, ...resto } = p;
  void _ignorada;
  return sinUndefined(resto);
}

export function opcionesDesdeEscenario(leido: EscenarioLeido): SimulatorOptions {
  const e = leido.escenario;
  const base = opcionesPorDefecto();
  const d = e.defaults ?? {};
  const valvulaPorDefecto = valvulaParcial(d);
  const plantaPorDefecto = plantaParcial(d);
  return {
    name: e.name,
    source: leido.archivo,
    mappingPath: leido.rutaMapping,
    ioLatencyMs: e.ioLatencyMs ?? 0,
    syntheticInputs: e.syntheticInputs ?? true,
    historyCapacity: e.historyCapacity ?? HISTORIAL_POR_DEFECTO,
    defaults: {
      ...base.defaults,
      ...valvulaPorDefecto,
      verbs: { ...base.defaults.verbs, ...(valvulaPorDefecto.verbs ?? {}) },
      ...plantaPorDefecto,
      feedbackCycleMs: plantaPorDefecto.feedbackCycleMs ?? null,
      feedbackPhaseMs: plantaPorDefecto.feedbackPhaseMs ?? null,
    },
    plants: Object.fromEntries(Object.entries(e.plants ?? {}).map(([k, v]) => [k, plantaParcial(v)])),
    valves: Object.fromEntries(Object.entries(e.valves ?? {}).map(([k, v]) => [k, valvulaParcial(v)])),
    initialValues: { ...(e.initialValues ?? {}) },
  };
}

/** Parámetros efectivos de una planta: los suyos, si no los del escenario, si no los por defecto. */
export function configDePlanta(opts: SimulatorOptions, plantId: string): SimPlantConfig {
  const p = opts.plants[plantId] ?? {};
  const msgCycleMs = p.msgCycleMs ?? opts.defaults.msgCycleMs;
  const msgPhaseMs = p.msgPhaseMs ?? opts.defaults.msgPhaseMs;
  // La vuelta (MSG_READ) cicla, salvo que se diga otra cosa, igual que la ida.
  return {
    msgCycleMs,
    msgPhaseMs,
    feedbackCycleMs: p.feedbackCycleMs ?? opts.defaults.feedbackCycleMs ?? msgCycleMs,
    feedbackPhaseMs: p.feedbackPhaseMs ?? opts.defaults.feedbackPhaseMs ?? msgPhaseMs,
  };
}

/** Parámetros efectivos de una válvula (`plantId/domainKey`). */
export function configDeValvula(opts: SimulatorOptions, plantId: string, domainKey: string): SimValveConfig {
  const v = opts.valves[`${plantId}/${domainKey}`] ?? {};
  const d = opts.defaults;
  return {
    travelMs: v.travelMs ?? d.travelMs,
    latchMode: v.latchMode ?? d.latchMode,
    initialState: v.initialState ?? d.initialState,
    feedback: v.feedback ?? d.feedback,
    flowOpen: v.flowOpen ?? d.flowOpen,
    untilIdleValue: v.untilIdleValue ?? d.untilIdleValue,
    otherStateValue: v.otherStateValue ?? d.otherStateValue,
    verbs: { ...d.verbs, ...(v.verbs ?? {}) },
    feedbackElements: v.feedbackElements ?? d.feedbackElements,
  };
}

// ── Coherencia con el mapping ───────────────────────────────────────────────────────

/** `BUFFER[indice]` → partes. null si no casa. */
export function partirElemento(ref: string): { buffer: string; index: number } | null {
  const m = /^([A-Za-z0-9_]+)\[(\d+)\]$/.exec(ref);
  return m ? { buffer: m[1], index: Number(m[2]) } : null;
}

/**
 * ¿El escenario habla del mapping que se cargó? Devuelve la lista de errores (vacía = coherente).
 *
 * Un escenario que nombra una válvula, una planta o un elemento que el mapping no tiene no se ignora:
 * quien lo escribió cree estar probando algo que en realidad no se está simulando, que es justo el
 * tipo de falso verde que este simulador existe para evitar.
 */
export function validarEscenarioContraMapping(opts: SimulatorOptions, mapping: LoadedMapping): string[] {
  const errores: string[] = [];
  const plantas = new Set(mapping.plants.map((p) => p.plantId));
  const buffer = (plantId: string, nombre: string) =>
    mapping.targets.find((t) => t.plantId === plantId && t.browseName === nombre);
  const elementoValido = (plantId: string, ref: string, donde: string): void => {
    const partes = partirElemento(ref);
    if (!partes) {
      errores.push(`${donde}: "${ref}" no tiene la forma BUFFER[indice]`);
      return;
    }
    const b = buffer(plantId, partes.buffer);
    if (!b) {
      errores.push(`${donde}: ${plantId} no tiene ningún buffer ${partes.buffer}`);
      return;
    }
    if (b.arrayLength !== null && partes.index >= b.arrayLength) {
      errores.push(`${donde}: ${partes.buffer} declara ${b.arrayLength} elementos; ${partes.index} está fuera`);
    }
  };

  for (const plantId of Object.keys(opts.plants)) {
    if (!plantas.has(plantId)) errores.push(`plants.${plantId}: el mapping no tiene esa planta`);
  }

  for (const [clave, v] of Object.entries(opts.valves)) {
    const [plantId, domainKey] = clave.split('/');
    const senal = mapping.signals.find((s) => s.plantId === plantId && s.domainKey === domainKey);
    if (!plantId || !domainKey || !senal) {
      errores.push(`valves.${clave}: no existe esa señal (se espera plantId/domainKey)`);
      continue;
    }
    if (!senal.writable || !senal.write) {
      errores.push(`valves.${clave}: la señal no es una válvula con write spec (writable: false o spec descartado por el loader)`);
      continue;
    }
    for (const papel of ['open', 'close'] as const) {
      const verbo = v.verbs?.[papel];
      if (verbo !== undefined && !(verbo in senal.write.commands)) {
        errores.push(`valves.${clave}.verbs.${papel}: "${verbo}" no está en write.commands de esa válvula`);
      }
    }
    for (const e of v.feedbackElements ?? []) elementoValido(plantId, e.element, `valves.${clave}.feedbackElements`);
  }

  for (const e of opts.defaults.feedbackElements) {
    errores.push(`defaults.feedbackElements: "${e.element}" no puede ir en defaults (un elemento es de UNA válvula)`);
  }

  for (const clave of Object.keys(opts.initialValues)) {
    const corte = clave.indexOf('/');
    const plantId = clave.slice(0, corte);
    if (!plantas.has(plantId)) {
      errores.push(`initialValues.${clave}: el mapping no tiene la planta ${plantId}`);
      continue;
    }
    elementoValido(plantId, clave.slice(corte + 1), `initialValues.${clave}`);
  }
  return errores;
}

// ── Desde el entorno ────────────────────────────────────────────────────────────────

/**
 * ¿El mapping es de PRUEBA? Se marca en `generatedFrom.simulationOnly: true` (el schema admite ese
 * objeto libre; un campo nuevo en la raíz lo rechazaría).
 */
export function esMappingSoloSimulacion(mapping: LoadedMapping): boolean {
  const raw = mapping.raw as { generatedFrom?: { simulationOnly?: unknown } } | null;
  return raw?.generatedFrom?.simulationOnly === true;
}

/**
 * Lo que impide que un mapping de prueba llegue al PLC real. Se llama al construir el adaptador OPC UA:
 * con `OPC_MAPPING_PATH` apuntando a un mapping de simulación, el backend NO arranca.
 */
export function asegurarMappingParaPlcReal(mapping: LoadedMapping): void {
  if (esMappingSoloSimulacion(mapping)) {
    throw new Error(
      'El mapping cargado es de SIMULACIÓN (generatedFrom.simulationOnly: true) y CONNECTIVITY_PROVIDER=opcua. ' +
        'Sus bits son de prueba: escribirlos en el PLC real movería equipo que nadie asignó. ' +
        'Quita OPC_MAPPING_PATH o usa CONNECTIVITY_PROVIDER=simulator (npm run dev:sim).',
    );
  }
}

function mismaRuta(a: string, b: string): boolean {
  try {
    return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();
  } catch {
    return resolve(a).toLowerCase() === resolve(b).toLowerCase();
  }
}

/**
 * Opciones del simulador según `SIM_SCENARIO`. Sin la variable, los valores por defecto.
 *
 * `rutaMappingCargado` es el archivo que de verdad cargó la app (`resolverRutaDelMapping()`): si el
 * escenario exige otro, se falla aquí, porque el resto de la app (pipeline, WriteService, informes) ya
 * está leyendo el otro y la simulación sería de un mapping distinto del que se manda.
 */
export function opcionesDelEntorno(mapping: LoadedMapping, rutaMappingCargado: string | null): SimulatorOptions {
  const nombre = process.env.SIM_SCENARIO?.trim();
  if (!nombre) return opcionesPorDefecto();

  const leido = leerEscenario(resolverRutaEscenario(nombre));
  const opts = opcionesDesdeEscenario(leido);
  if (opts.mappingPath && (!rutaMappingCargado || !mismaRuta(opts.mappingPath, rutaMappingCargado))) {
    throw new Error(
      `El escenario ${leido.archivo} exige el mapping ${opts.mappingPath}, pero la app cargó ` +
        `${rutaMappingCargado ?? '(desconocido)'}. Arranca con \`npm run dev:sim\` (fija OPC_MAPPING_PATH) ` +
        'o define OPC_MAPPING_PATH con esa ruta.',
    );
  }
  const errores = validarEscenarioContraMapping(opts, mapping);
  if (errores.length > 0) {
    throw new Error(`Escenario ${leido.archivo} incoherente con el mapping:\n  - ${errores.join('\n  - ')}`);
  }
  return opts;
}
