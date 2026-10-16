/**
 * Válvulas contra el SIMULADOR, de punta a punta: el WriteService REAL escribiendo en el
 * SimulatorBridgeAdapter con su modelo de válvulas, y —en el primer test— el pipeline REAL que
 * produce el snapshot que recibe la app. Lo que aquí se prueba es lo que va a cambiar en las próximas
 * semanas, cuando se asignen bits y canales para abrir y cerrar 1, 2 o 3 válvulas por planta:
 *
 *  - que una orden sale, se sostiene, se suelta y la app VE el cambio de estado por el flujo normal;
 *  - que con varias válvulas en la MISMA palabra una orden no toca los bits de las otras, y que la
 *    exclusión abrir/cerrar solo apaga el verbo contrario de la MISMA válvula;
 *  - que dos órdenes concurrentes sobre la misma palabra no se pisan (aquí se encontró una CARRERA);
 *  - que ninguna escritura intermedia deja abrir y cerrar a 1 a la vez (sobre el historial completo);
 *  - qué pasa con el sostenido frente al ciclo de la MSG maestro→local, en hold y en latch.
 *
 * Relojes FALSOS (`t.mock.timers`, con `Date`): los sostenidos son los REALES del mapping (45 s), la
 * MSG cicla cada 8 s como en La Sirena, y aun así cada test tarda milisegundos. El resto de la suite
 * usa tiempos reales cortos; aquí no se puede, porque lo que se prueba es justamente la relación entre
 * 45 s de sostenido, 8 s de MSG y 30 s de recorrido.
 *
 * Mapping: el de PRUEBA, fixtures/sim-scenarios/mappings/valvulas-de-prueba.json (nunca el de
 * producción, salvo el test de Carbonero, que lo dice).
 */
import 'reflect-metadata';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { AuditLogService } from '../src/infrastructure/audit/audit-log.service';
import type { ConnectivityConfig, OpcUaConfig } from '../src/infrastructure/connectivity/connectivity.config';
import { loadMapping, type LoadedMapping } from '../src/infrastructure/connectivity/mapping/opc-mapping.loader';
import { PlantCache } from '../src/infrastructure/connectivity/pipeline/plant-cache';
import { PlantPipelineService } from '../src/infrastructure/connectivity/pipeline/plant-pipeline.service';
import type { PlantSnapshotDto } from '../src/infrastructure/connectivity/pipeline/plant-snapshot.dto';
import { TankAutonomyStore } from '../src/infrastructure/connectivity/pipeline/tank-autonomy.store';
import { SimulatorBridgeAdapter } from '../src/infrastructure/connectivity/adapters/simulator/simulator-bridge.adapter';
import {
  leerEscenario,
  opcionesDesdeEscenario,
  opcionesPorDefecto,
  resolverRutaEscenario,
  type SimulatorOptions,
} from '../src/infrastructure/connectivity/adapters/simulator/sim-scenario';
import type { SimWrite } from '../src/infrastructure/connectivity/adapters/simulator/simulated-plc';
import type { CommandLogRepository, StoredCommand } from '../src/modules/commands/command-log.repository';
import { CommandMappingResolver } from '../src/modules/commands/command-mapping.resolver';
import type { CommandSignatureService } from '../src/modules/commands/command-signature.service';
import type { CommandActor, CommandResult } from '../src/modules/commands/command.dto';
import { WriteService } from '../src/modules/commands/write.service';
import type { NotificationRepository } from '../src/modules/notifications/notification.repository';

const RUTA_MAPPING_PRUEBA = join(__dirname, '..', 'fixtures', 'sim-scenarios', 'mappings', 'valvulas-de-prueba.json');
const RUTA_MAPPING_PRODUCCION = join(__dirname, '..', 'config', 'opc_mapping.json');
// El pipeline y el CommandMappingResolver cargan el mapping con `loadMapping()` sin argumentos al
// CONSTRUIRSE: con esto leen el de prueba, igual que en `npm run dev:sim`. Cada archivo de test corre
// en su propio proceso, así que no afecta al resto de la suite.
process.env.OPC_MAPPING_PATH = RUTA_MAPPING_PRUEBA;

Logger.overrideLogger(false);

// ── Reloj falso ─────────────────────────────────────────────────────────────────────

const INICIO = Date.parse('2026-10-07T08:00:00.000Z');
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function relojFalso(t: TestContext): void {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: INICIO });
}

/** Avanza el reloj falso `ms`, en pasos de `paso`, dejando correr las continuaciones entre paso y paso. */
async function avanzar(t: TestContext, ms: number, paso = 10): Promise<void> {
  for (let hecho = 0; hecho < ms; hecho += paso) {
    t.mock.timers.tick(Math.min(paso, ms - hecho));
    await flush();
    await flush();
  }
}

/** Avanza el reloj hasta que la promesa termine. Falla si no termina dentro del tope (tiempo simulado). */
async function esperar<T>(t: TestContext, p: Promise<T>, topeMs: number, paso = 10): Promise<T> {
  let listo = false;
  let valor: T | undefined;
  let error: unknown;
  let fallo = false;
  p.then(
    (v) => {
      listo = true;
      valor = v;
    },
    (e: unknown) => {
      listo = true;
      fallo = true;
      error = e;
    },
  );
  for (let hecho = 0; hecho <= topeMs; hecho += paso) {
    await flush();
    await flush();
    if (listo) break;
    t.mock.timers.tick(paso);
  }
  if (!listo) throw new Error(`no terminó en ${topeMs} ms simulados`);
  if (fallo) throw error;
  return valor as T;
}

// ── Dobles de lo que vive en MySQL (lo que aquí importa es el I/O con el PLC) ──────────

function repo(): CommandLogRepository {
  let id = 1;
  return {
    reserve: async () => ({ reserved: true, id: id++ }),
    finalize: async () => undefined,
    findByIdempotencyKey: async () => null as StoredCommand | null,
  } as unknown as CommandLogRepository;
}
const auditoria = { record: async () => undefined } as unknown as AuditLogService;
const firmas = { firmar: async () => 'firma-de-prueba' } as unknown as CommandSignatureService;
const avisos = { create: async () => true } as unknown as NotificationRepository;
const OPERADOR: CommandActor = { userId: 'u1', userName: 'Operador', userEmail: 'op@ptap.co', role: 'operador', ip: '10.0.0.1' };

// ── Montaje ─────────────────────────────────────────────────────────────────────────

function opcuaConfig(): OpcUaConfig {
  return {
    endpoint: 'simulator://in-memory',
    endpointMustExist: false,
    // Sesión segura EMULADA, como la fija `npm run dev:sim`: pasa la precondición dura sin
    // OPCUA_ALLOW_INSECURE_WRITES.
    securityMode: 'SignAndEncrypt',
    securityPolicy: 'Basic256Sha256',
    identity: { type: 'username', userName: 'simulador', password: 'simulador' },
    autoAcceptUnknownCertificate: false,
    publishingIntervalMs: 1000,
    samplingIntervalMs: 1000,
    subscriptionLifetimeCount: 100,
    subscriptionMaxKeepAliveCount: 10,
    coalesceWindowMs: 10,
    watchdogTimeoutMs: 30_000,
    heartbeatIntervalMs: 10_000,
    heartbeatMaxFailures: 2,
    reconnectInitialDelayMs: 10,
    reconnectMaxDelayMs: 50,
    reconnectMaxRetry: 1000,
    subscriptionRecycleMaxAttempts: 2,
    staleThresholdMs: 300_000,
    writesEnabled: true,
    allowInsecureWrites: false,
  };
}

function connConfig(): ConnectivityConfig {
  return { provider: 'simulator', opcua: opcuaConfig(), liveness: { liveSec: 10, windowSec: 300, sweepMs: 1000 }, deadLetterCapacity: 500 };
}

type Cambios = {
  ioLatencyMs?: number;
  defaults?: Partial<SimulatorOptions['defaults']>;
  plants?: SimulatorOptions['plants'];
  valves?: SimulatorOptions['valves'];
  initialValues?: SimulatorOptions['initialValues'];
};

/** Opciones del simulador para un test. Por defecto: MSG instantánea y sin latencia; cada test dice lo suyo. */
function opciones(c: Cambios = {}): SimulatorOptions {
  const base = opcionesPorDefecto();
  return {
    ...base,
    name: 'test',
    ioLatencyMs: c.ioLatencyMs ?? 0,
    defaults: { ...base.defaults, msgCycleMs: 0, msgPhaseMs: 0, travelMs: 1000, ...c.defaults },
    plants: c.plants ?? {},
    valves: c.valves ?? {},
    initialValues: c.initialValues ?? {},
  };
}

/** Un snapshot `live` para el interlock, cuando el test no monta el pipeline. */
function cacheViva(): PlantCache {
  return {
    get: (plantId: string) =>
      ({ plantId, sequence: 1, liveness: { state: 'live', lastChangeAt: null, windowSec: 300 }, signals: {} }) as unknown as PlantSnapshotDto,
  } as unknown as PlantCache;
}

/** Resolver sobre el mapping que se le dé (para el de producción, o para acortar sostenidos). */
function resolverDe(mapping: LoadedMapping, ajustar?: (w: NonNullable<LoadedMapping['signals'][number]['write']>) => typeof w): CommandMappingResolver {
  return {
    resolve: (plantId: string, target: string) => {
      const s = mapping.signals.find((x) => x.plantId === plantId && x.domainKey === target && x.writable && x.write);
      return s?.write ? { domainKey: s.domainKey, write: ajustar ? ajustar(s.write) : s.write } : null;
    },
  } as unknown as CommandMappingResolver;
}

interface Montaje {
  sim: SimulatorBridgeAdapter;
  servicio: WriteService;
  cache: PlantCache;
  pipeline: PlantPipelineService | null;
  parar: () => Promise<void>;
}

async function montar(
  opts: SimulatorOptions,
  o: { pipeline?: boolean; mapping?: LoadedMapping; resolver?: CommandMappingResolver } = {},
): Promise<Montaje> {
  const mapping = o.mapping ?? loadMapping(RUTA_MAPPING_PRUEBA);
  const sim = new SimulatorBridgeAdapter(opcuaConfig(), mapping, opts);
  const cache = new PlantCache();
  let pipeline: PlantPipelineService | null = null;
  if (o.pipeline) {
    pipeline = new PlantPipelineService(sim, connConfig(), cache, new TankAutonomyStore());
    pipeline.onModuleInit();
  }
  await sim.start();
  const servicio = new WriteService(
    sim,
    { opcua: { writesEnabled: true } } as ConnectivityConfig,
    o.pipeline ? cache : cacheViva(),
    o.resolver ?? new CommandMappingResolver(),
    repo(),
    auditoria,
    firmas,
    avisos,
  );
  return {
    sim,
    servicio,
    cache,
    pipeline,
    parar: async () => {
      pipeline?.onModuleDestroy();
      await sim.stop();
    },
  };
}

function orden(m: Montaje, plantId: string, target: string, command: string): Promise<CommandResult> {
  return m.servicio.execute(plantId, { command, target }, OPERADOR);
}

// ── Lectura del historial de escrituras (lo que salió por el cable) ──────────────────

function escriturasEn(h: SimWrite[], sourceBuffer: string, index = 0): SimWrite[] {
  return h.filter((w) => w.sourceBuffer === sourceBuffer && w.index === index);
}

/** Intervalos en los que TODOS los bits de `mascara` estuvieron puestos en la palabra. */
function intervalos(ws: SimWrite[], mascara: number, finMs: number): { desde: number; hasta: number }[] {
  const out: { desde: number; hasta: number }[] = [];
  let desde: number | null = null;
  for (const w of ws) {
    const puesto = (Number(w.value) & mascara) === mascara;
    if (puesto && desde === null) desde = w.ms;
    if (!puesto && desde !== null) {
      out.push({ desde, hasta: w.ms });
      desde = null;
    }
  }
  if (desde !== null) out.push({ desde, hasta: finMs });
  return out;
}

/** ¿Alguna escritura dejó abrir y cerrar de ESTA válvula a 1 a la vez? */
function conLosDosSentidos(ws: SimWrite[], abrir: number, cerrar: number): SimWrite[] {
  return ws.filter((w) => (Number(w.value) & abrir) !== 0 && (Number(w.value) & cerrar) !== 0);
}

/**
 * Lo que la APP deduce del snapshot, con la misma regla que apps/mobile/services/valves.ts: manda la
 * palabra de estado (`valveNState`: literales de `stateEncoding`, o bit14 = válido y bit0 = abierta)
 * si es usable y fiable; si no, el caudal de esa válvula (> 0,1 l/s = abierta).
 */
function estadoQueVeLaApp(s: PlantSnapshotDto, valvula: string): 'open' | 'closed' | 'unknown' {
  const estado = s.signals[`${valvula}State`];
  if (estado && estado.usable && typeof estado.value === 'number' && estado.stateTrusted !== false) {
    const enc = estado.stateEncoding;
    if (enc && (enc.open !== undefined || enc.closed !== undefined)) {
      if (estado.value === enc.closed) return 'closed';
      if (estado.value === enc.open) return 'open';
    } else if ((estado.value & (1 << 14)) !== 0) {
      return (estado.value & 1) !== 0 ? 'open' : 'closed';
    }
  }
  const caudal = s.signals[s.signals[valvula]?.flowDomainKey ?? 'outletFlow1'];
  if (caudal && caudal.usable && typeof caudal.value === 'number') return caudal.value > 0.1 ? 'open' : 'closed';
  return 'unknown';
}

// ── 1 válvula ───────────────────────────────────────────────────────────────────────

test('sim e2e: 1 válvula — abrir y cerrar con read-back CONFIRMADO y el estado visible en el snapshot de la app', async (t) => {
  relojFalso(t);
  // Tiempos de campo: MSG de 8 s, 30 s de recorrido, el PLC local solo mueve con el bit sostenido, y
  // el sostenido REAL del mapping (45 s). Latencia OPC UA de 50 ms por petición.
  const m = await montar(opciones({ ioLatencyMs: 50, defaults: { msgCycleMs: 8000, travelMs: 30_000, latchMode: 'hold', flowOpen: 10 } }), {
    pipeline: true,
  });
  const frames: PlantSnapshotDto[] = [];
  const sub = m.pipeline!.snapshot$.subscribe((s) => {
    if (s.plantId === 'sim-una') frames.push(s);
  });
  try {
    await avanzar(t, 3000);
    const antes = m.cache.get('sim-una');
    assert.ok(antes, 'el pipeline debe haber publicado el snapshot de sim-una');
    assert.equal(antes.liveness.state, 'live', 'con entradas sintéticas la planta está viva: el interlock deja mandar');
    assert.equal(antes.signals.valve1State.value, 16384, 'arranca CERRADA (bit14 válido, bit0 a 0)');
    assert.equal(antes.signals.outletFlow1.value, 0);
    assert.equal(estadoQueVeLaApp(antes, 'valve1'), 'closed');

    const abrir = await esperar(t, orden(m, 'sim-una', 'valve1', 'open'), 70_000);
    assert.equal(abrir.status, 'confirmed', `abrir: ${abrir.status} ${abrir.reason}`);
    assert.equal(abrir.writtenValue, 1, 'bit0 = abrir');
    assert.equal(abrir.writeVerified, true);
    assert.equal(abrir.confirmedValue, 16385, 'el read-back confirma ABIERTA');
    assert.ok(
      frames.some((f) => f.signals.valve1.value === 1),
      'lo escrito tiene que verse en los frames: INT_OUT_SIM_UNA[0] = 1 mientras se sostenía',
    );

    await avanzar(t, 3000);
    const abierta = m.cache.get('sim-una')!;
    assert.equal(abierta.signals.valve1.value, 0, 'el sostenido se soltó');
    assert.equal(abierta.signals.valve1State.value, 16385);
    assert.equal(abierta.signals.outletFlow1.value, 10, 'abierta del todo: el caudal de la válvula');
    assert.equal(estadoQueVeLaApp(abierta, 'valve1'), 'open', 'la app la ve ABIERTA por el flujo normal de frames');
    assert.equal(m.sim.getSimulatedValve('sim-una', 'valve1')?.state, 'open');

    const cerrar = await esperar(t, orden(m, 'sim-una', 'valve1', 'close'), 70_000);
    assert.equal(cerrar.status, 'confirmed', `cerrar: ${cerrar.status} ${cerrar.reason}`);
    assert.equal(cerrar.writtenValue, 2, 'bit1 = cerrar');
    assert.equal(cerrar.confirmedValue, 16384);

    await avanzar(t, 3000);
    const cerrada = m.cache.get('sim-una')!;
    assert.equal(cerrada.signals.valve1State.value, 16384);
    assert.equal(cerrada.signals.outletFlow1.value, 0);
    assert.equal(estadoQueVeLaApp(cerrada, 'valve1'), 'closed');

    const mando = escriturasEn(m.sim.getWriteHistory(), 'INT_OUT_SIM_UNA');
    assert.deepEqual(mando.map((w) => w.value), [1, 0, 2, 0], 'activar, soltar, activar, soltar: nada más salió por el cable');
    assert.deepEqual(conLosDosSentidos(mando, 1, 2), []);
    assert.deepEqual(m.sim.getViolations(), []);
  } finally {
    sub.unsubscribe();
    await m.parar();
  }
});

// ── 2 y 3 válvulas en la MISMA palabra ────────────────────────────────────────────────

/** Cada escritura de una orden de la válvula `mascara` cambia SOLO bits de esa máscara. */
function bitsAjenosIntactos(ws: SimWrite[], mascara: number): SimWrite[] {
  return ws.filter((w) => ((Number(w.value) ^ Number(w.previous)) & ~mascara & 0xffff) !== 0);
}

test('sim e2e: 2 válvulas en la misma palabra — una orden NO toca los bits de la otra, y la exclusión solo apaga el verbo contrario de LA MISMA', async (t) => {
  relojFalso(t);
  // La palabra arranca con el CERRAR de A (2) y el CERRAR de B (8) puestos: un cierre que no se soltó.
  const m = await montar(opciones({ initialValues: { 'sim-dos/INT_OUT_SIM_DOS[0]': 2 | 8 } }));
  try {
    const a = await esperar(t, orden(m, 'sim-dos', 'valve1', 'open'), 70_000);
    assert.notEqual(a.status, 'failed', `A: ${a.reason}`);
    let ws = escriturasEn(m.sim.getWriteHistory(), 'INT_OUT_SIM_DOS');
    assert.deepEqual(ws.map((w) => w.value), [1 | 8, 8], 'abrir A apaga SU cerrar (2) y deja el de B (8); al soltar, solo se va su bit');
    assert.deepEqual(bitsAjenosIntactos(ws, 1 | 2), [], 'la orden de A solo movió los bits 0/1');

    const b = await esperar(t, orden(m, 'sim-dos', 'valve2', 'open'), 70_000);
    assert.notEqual(b.status, 'failed', `B: ${b.reason}`);
    ws = escriturasEn(m.sim.getWriteHistory(), 'INT_OUT_SIM_DOS');
    assert.deepEqual(ws.map((w) => w.value), [9, 8, 4, 0]);
    assert.deepEqual(bitsAjenosIntactos(ws.slice(2), 4 | 8), [], 'la orden de B solo movió los bits 2/3');

    assert.deepEqual(conLosDosSentidos(ws, 1, 2), [], 'A nunca con abrir y cerrar a la vez');
    assert.deepEqual(conLosDosSentidos(ws, 4, 8), [], 'B nunca con abrir y cerrar a la vez');
    assert.deepEqual(m.sim.getViolations(), []);
    assert.equal(m.sim.getSimulatedValve('sim-dos', 'valve1')?.state, 'open');
    assert.equal(m.sim.getSimulatedValve('sim-dos', 'valve2')?.state, 'open');
  } finally {
    await m.parar();
  }
});

test('sim e2e: 3 válvulas en la misma palabra (bits 0/1, 2/3, 4/5) — cada orden toca solo lo suyo y ninguna escritura deja abrir+cerrar de una válvula', async (t) => {
  relojFalso(t);
  // Los TRES cerrar puestos al arrancar (2 | 8 | 32): el peor caso para la exclusión.
  const m = await montar(opciones({ initialValues: { 'sim-tres/INT_OUT_SIM_TRES[0]': 2 | 8 | 32 } }));
  const MASCARA: Record<string, number> = { valve1: 1 | 2, valve2: 4 | 8, valve3: 16 | 32 };
  const pasos: [string, string][] = [
    ['valve2', 'open'],
    ['valve3', 'open'],
    ['valve1', 'close'], // ya tenía su cerrar puesto: se re-afirma y se suelta, sin tocar a nadie
    ['valve1', 'open'],
    ['valve2', 'close'],
  ];
  try {
    let vistas = 0;
    for (const [valvula, verbo] of pasos) {
      const r = await esperar(t, orden(m, 'sim-tres', valvula, verbo), 70_000);
      assert.notEqual(r.status, 'failed', `${valvula} ${verbo}: ${r.reason}`);
      assert.notEqual(r.status, 'rejected', `${valvula} ${verbo}: ${r.reason}`);
      const nuevas = escriturasEn(m.sim.getWriteHistory(), 'INT_OUT_SIM_TRES').slice(vistas);
      vistas += nuevas.length;
      assert.deepEqual(bitsAjenosIntactos(nuevas, MASCARA[valvula]), [], `${valvula} ${verbo} solo puede mover sus bits`);
    }
    const ws = escriturasEn(m.sim.getWriteHistory(), 'INT_OUT_SIM_TRES');
    assert.deepEqual(
      ws.map((w) => w.value),
      [38, 34, 18, 2, 2, 0, 1, 0, 8, 0],
      'B abre (42→38), suelta (34); C abre (18), suelta (2); A cierra (2), suelta (0); A abre (1), suelta (0); B cierra (8), suelta (0)',
    );
    for (const [v, mascara] of Object.entries(MASCARA)) {
      const abrir = mascara & -mascara;
      assert.deepEqual(conLosDosSentidos(ws, abrir, mascara & ~abrir), [], `${v}: jamás abrir y cerrar a 1 a la vez`);
    }
    assert.deepEqual(m.sim.getViolations(), [], 'el simulador tampoco registró ninguna violación');
    assert.equal(m.sim.getSimulatedValve('sim-tres', 'valve1')?.state, 'open');
    assert.equal(m.sim.getSimulatedValve('sim-tres', 'valve2')?.state, 'closed');
    assert.equal(m.sim.getSimulatedValve('sim-tres', 'valve3')?.state, 'open');
  } finally {
    await m.parar();
  }
});

// ── CONCURRENCIA en la misma palabra ──────────────────────────────────────────────────
//
// Cada orden reserva SU válvula (`plantId/target`), no la palabra: A y B, en la misma palabra, corren
// a la vez. La activación y la limpieza del pulso son read-modify-write con DOS idas al PLC (leer y
// escribir), y entre una y otra puede caer la escritura de la otra válvula.

test('sim e2e: concurrencia — B se manda durante el sostenido de 45 s de A; la limpieza de A NO borra el bit de B', async (t) => {
  relojFalso(t);
  const m = await montar(opciones({ ioLatencyMs: 100 }));
  try {
    const a = orden(m, 'sim-dos', 'valve1', 'open');
    await avanzar(t, 20_000);
    const b = orden(m, 'sim-dos', 'valve2', 'open');
    const [ra, rb] = await esperar(t, Promise.all([a, b]), 120_000);
    assert.notEqual(ra.status, 'failed');
    assert.notEqual(rb.status, 'failed');

    const ws = escriturasEn(m.sim.getWriteHistory(), 'INT_OUT_SIM_DOS');
    const fin = ws[ws.length - 1].ms;
    const limpiezaA = ws.find((w) => (Number(w.previous) & 1) !== 0 && (Number(w.value) & 1) === 0);
    assert.ok(limpiezaA, 'A se soltó');
    assert.equal(Number(limpiezaA.value) & 4, 4, 'cuando A se suelta, el bit de B sigue puesto');
    for (const [nombre, bit] of [['A', 1], ['B', 4]] as const) {
      const iv = intervalos(ws, bit, fin);
      assert.equal(iv.length, 1, `${nombre}: el bit se pone una vez y se quita una vez`);
      assert.ok(iv[0].hasta - iv[0].desde >= 45_000, `${nombre}: sostenido ${iv[0].hasta - iv[0].desde} ms, ≥ 45 s`);
    }
    assert.equal(ws[ws.length - 1].value, 0, 'al final no queda ningún bit puesto');
    assert.deepEqual(m.sim.getViolations(), []);
  } finally {
    await m.parar();
  }
});

/**
 * La carrera, barriendo el instante en que llega la orden de B alrededor de la LIMPIEZA de A.
 *
 * Con 100 ms por petición OPC UA, la limpieza de A (leer la palabra → escribirla sin su bit) y la
 * activación de B (leer → escribir con su bit) se pueden entrelazar de dos formas, y las dos son malas:
 *  - A lee, B escribe, A escribe lo que leyó sin su bit → BORRA el bit de B: la orden de B se pierde y
 *    el operador recibe "enviada";
 *  - B lee (con el bit de A), A limpia, B escribe lo que leyó más su bit → RESUCITA el bit de A, que se
 *    queda puesto PARA SIEMPRE (nadie más lo va a limpiar): la bobina energizada sin que nadie lo sepa.
 *
 * El sostenido se acorta a 2 s SOLO aquí, para barrer 81 desfases rápido: la carrera vive en la ventana
 * de ±latencia alrededor de la limpieza y no depende de cuánto dure el sostenido.
 */
test('sim e2e: concurrencia — ninguna orden pierde ni resucita bits, para CUALQUIER desfase entre A y B (latencia OPC UA 100 ms)', async (t) => {
  relojFalso(t);
  const HOLD = 2000;
  const resolver = resolverDe(loadMapping(RUTA_MAPPING_PRUEBA), (w) => ({ ...w, pulse: w.pulse ? { ...w.pulse, holdMs: HOLD } : null }));
  const fallos: string[] = [];
  for (let desfase = 1900; desfase <= 2700; desfase += 10) {
    const m = await montar(opciones({ ioLatencyMs: 100 }), { resolver });
    try {
      const a = orden(m, 'sim-dos', 'valve1', 'open');
      await avanzar(t, desfase);
      const b = orden(m, 'sim-dos', 'valve2', 'open');
      const [ra, rb] = await esperar(t, Promise.all([a, b]), 30_000);
      const ws = escriturasEn(m.sim.getWriteHistory(), 'INT_OUT_SIM_DOS');
      const fin = ws[ws.length - 1].ms;
      const problemas: string[] = [];
      if (ws[ws.length - 1].value !== 0) problemas.push(`queda ${String(ws[ws.length - 1].value)} puesto al final`);
      for (const [nombre, bit] of [['A', 1], ['B', 4]] as const) {
        const iv = intervalos(ws, bit, fin);
        if (iv.length !== 1) problemas.push(`${nombre}: ${iv.length} intervalos con el bit puesto (se esperaba 1)`);
        else if (iv[0].hasta - iv[0].desde < HOLD) problemas.push(`${nombre}: bit sostenido solo ${iv[0].hasta - iv[0].desde} ms`);
      }
      if (m.sim.getSimulatedValve('sim-dos', 'valve2')?.state !== 'open') problemas.push('B no llegó a abrir');
      if (ra.writeVerified !== true || rb.writeVerified !== true) problemas.push(`eco: A=${String(ra.writeVerified)} B=${String(rb.writeVerified)}`);
      if (m.sim.getViolations().length > 0) problemas.push('violación abrir/cerrar');
      if (problemas.length > 0) fallos.push(`B a +${desfase} ms: ${problemas.join('; ')} · escrituras ${ws.map((w) => `${String(w.value)}@${w.ms - ws[0].ms}`).join(' ')}`);
    } finally {
      await m.parar();
    }
  }
  assert.deepEqual(fallos, [], `carrera read-modify-write en la misma palabra:\n${fallos.join('\n')}`);
});

test('sim e2e: concurrencia — dos órdenes SIMULTÁNEAS sobre la misma palabra no se pisan', async (t) => {
  relojFalso(t);
  const m = await montar(opciones({ ioLatencyMs: 100 }));
  try {
    // Dos operadores, o uno que confirma dos válvulas seguidas: las dos lecturas salen antes de que
    // vuelva la primera escritura.
    const [ra, rb] = await esperar(t, Promise.all([orden(m, 'sim-dos', 'valve1', 'open'), orden(m, 'sim-dos', 'valve2', 'open')]), 120_000);
    const ws = escriturasEn(m.sim.getWriteHistory(), 'INT_OUT_SIM_DOS');
    const fin = ws[ws.length - 1].ms;
    for (const [nombre, bit] of [['A', 1], ['B', 4]] as const) {
      const iv = intervalos(ws, bit, fin);
      assert.equal(iv.length, 1, `${nombre}: ${JSON.stringify(ws.map((w) => w.value))}`);
      assert.ok(iv[0].hasta - iv[0].desde >= 45_000, `${nombre}: el bit se sostuvo ${iv[0].hasta - iv[0].desde} ms`);
    }
    assert.equal(ra.writeVerified, true, 'el eco de A ve SU escritura');
    assert.equal(rb.writeVerified, true, 'el eco de B ve SU escritura');
    assert.equal(ws[ws.length - 1].value, 0);
    assert.equal(m.sim.getSimulatedValve('sim-dos', 'valve1')?.state, 'open');
    assert.equal(m.sim.getSimulatedValve('sim-dos', 'valve2')?.state, 'open');
  } finally {
    await m.parar();
  }
});

// ── Sostenido frente al ciclo de la MSG, en hold y en latch ──────────────────────────

test('sim e2e: un sostenido MÁS CORTO que el ciclo de la MSG que cae entre dos muestreos no mueve la válvula (ni en hold ni en latch)', async (t) => {
  relojFalso(t);
  const resolver = resolverDe(loadMapping(RUTA_MAPPING_PRUEBA), (w) => ({ ...w, pulse: w.pulse ? { ...w.pulse, holdMs: 3000 } : null }));
  for (const latchMode of ['hold', 'latch'] as const) {
    const m = await montar(opciones({ defaults: { msgCycleMs: 8000, msgPhaseMs: 0, travelMs: 30_000, latchMode } }), { resolver });
    try {
      // MSG en t0, t0+8 s, t0+16 s… La orden sale en t0+1 s y se suelta en t0+4 s: entre dos muestreos.
      await avanzar(t, 1000);
      const r = await esperar(t, orden(m, 'sim-una', 'valve1', 'open'), 30_000);
      await avanzar(t, 40_000);
      const ws = escriturasEn(m.sim.getWriteHistory(), 'INT_OUT_SIM_UNA');
      assert.deepEqual(ws.map((w) => w.value), [1, 0], `${latchMode}: la orden SÍ salió y se soltó`);
      assert.equal(r.writeVerified, true, `${latchMode}: el eco la vio en el maestro`);
      const v = m.sim.getSimulatedValve('sim-una', 'valve1');
      assert.equal(v?.state, 'closed', `${latchMode}: el PLC local nunca vio el bit, la válvula no se movió`);
      assert.equal(v?.position, 0);
    } finally {
      await m.parar();
    }
  }
});

test('sim e2e: un sostenido corto que SÍ coge un muestreo deja la válvula A MEDIAS en hold y la abre del todo en latch', async (t) => {
  relojFalso(t);
  const resolver = resolverDe(loadMapping(RUTA_MAPPING_PRUEBA), (w) => ({ ...w, pulse: w.pulse ? { ...w.pulse, holdMs: 3000 } : null }));
  const finales: Record<string, string | undefined> = {};
  for (const latchMode of ['hold', 'latch'] as const) {
    const m = await montar(opciones({ defaults: { msgCycleMs: 8000, msgPhaseMs: 0, travelMs: 30_000, latchMode } }), { resolver });
    try {
      // Sale en t0+6 s y se suelta en t0+9 s: el muestreo de t0+8 s lo ve, el de t0+16 s ya no.
      await avanzar(t, 6000);
      await esperar(t, orden(m, 'sim-una', 'valve1', 'open'), 30_000);
      await avanzar(t, 60_000);
      const v = m.sim.getSimulatedValve('sim-una', 'valve1');
      finales[latchMode] = v?.state;
      if (latchMode === 'hold') {
        assert.equal(v?.state, 'mid', 'hold: se movió un ciclo de la MSG (8 s de 30) y se quedó a medias');
        assert.ok(Math.abs((v?.position ?? 0) - 8000 / 30_000) < 0.01, `posición ${v?.position}`);
      } else {
        assert.equal(v?.state, 'open', 'latch: bastó el flanco');
      }
    } finally {
      await m.parar();
    }
  }
  assert.deepEqual(finales, { hold: 'mid', latch: 'open' });
});

/**
 * El PLC local solo cambia su copia en cada muestreo, así que ve el bit un número ENTERO de ciclos: con
 * 45 s sostenidos y MSG de 8 s, 5 o 6 ciclos (40 o 48 s) según dónde caiga la orden respecto a la MSG.
 * (El `_riesgo` de Carbonero lo aproxima como "entre ~37 y ~53 s".) Un recorrido de hasta 40 s llega
 * siempre al tope; uno de 44 s, solo con algunas fases.
 */
test('sim e2e: el sostenido REAL de 45 s cubre la MSG de 8 s con cualquier fase si el recorrido es ≤ 40 s; con 44 s depende de la fase', async (t) => {
  relojFalso(t);
  const fases = [0, 1000, 2500, 4000, 5500, 7000, 7990];
  const resultado = async (travelMs: number, fase: number): Promise<{ estado?: string; vioMs: number }> => {
    const m = await montar(opciones({ defaults: { msgCycleMs: 8000, msgPhaseMs: fase, travelMs, latchMode: 'hold' } }));
    try {
      await avanzar(t, 3000);
      await esperar(t, orden(m, 'sim-una', 'valve1', 'open'), 70_000);
      await avanzar(t, 20_000);
      const v = m.sim.getSimulatedValve('sim-una', 'valve1');
      // Cuánto tiempo vio el PLC local el bit: desde que empezó a abrir hasta que se paró o llegó.
      const inicio = v?.transitions.find((tr) => tr.to === 'opening')?.ms ?? 0;
      const fin = v?.transitions.find((tr) => tr.from === 'opening')?.ms ?? 0;
      return { estado: v?.state, vioMs: fin - inicio };
    } finally {
      await m.parar();
    }
  };
  for (const fase of fases) {
    const r = await resultado(30_000, fase);
    assert.equal(r.estado, 'open', `30 s de recorrido, fase ${fase} ms`);
  }
  for (const fase of fases) {
    const r = await resultado(40_000, fase);
    assert.equal(r.estado, 'open', `40 s de recorrido, fase ${fase} ms: el mínimo que ve el PLC local son 5 ciclos = 40 s`);
  }

  const con44: string[] = [];
  for (const fase of fases) {
    const r = await resultado(44_000, fase);
    con44.push(`${fase}:${String(r.estado)}`);
    if (r.estado === 'mid') assert.equal(r.vioMs, 40_000, `fase ${fase}: a medias tras ver el bit 5 ciclos (40 s)`);
  }
  assert.ok(con44.some((x) => x.endsWith(':open')) && con44.some((x) => x.endsWith(':mid')), `con 44 s depende de la fase: ${con44.join(', ')}`);
});

// ── Mapping REAL de Carbonero (el del integrador, 2026-10-05) ────────────────────────

test('sim e2e: Carbonero REAL — sin realimentación declarada sale en ámbar (sent) aunque la válvula simulada sí se mueva', async (t) => {
  relojFalso(t);
  const real = loadMapping(RUTA_MAPPING_PRODUCCION);
  const escenario = opcionesDesdeEscenario(leerEscenario(resolverRutaEscenario('produccion')));
  for (const feedback of ['none', 'auto'] as const) {
    const opts: SimulatorOptions = { ...escenario, valves: { ...escenario.valves, 'carbonero/valve1': { feedback } } };
    const m = await montar(opts, { mapping: real, resolver: resolverDe(real) });
    try {
      await avanzar(t, 3000);
      const r = await esperar(t, orden(m, 'carbonero', 'valve1', 'open'), 70_000);
      assert.equal(r.status, 'sent', `feedback ${feedback}: sin semántica de estado, ni verde ni rojo (${r.reason})`);
      assert.equal(r.writtenValue, 1, 'bit0 = abrir (integrador 2026-10-05)');
      assert.equal(r.writeVerified, true);
      const ws = escriturasEn(m.sim.getWriteHistory(), 'INT_OUT_CARBONERO');
      assert.deepEqual(ws.map((w) => w.value), [1, 0]);
      assert.deepEqual(conLosDosSentidos(ws, 1, 2), []);
      await avanzar(t, 20_000);
      assert.equal(
        m.sim.getSimulatedValve('carbonero', 'valve1')?.state,
        'open',
        'el PLC simulado SÍ movió la válvula: es justo lo que en campo nadie puede ver sin un testigo',
      );
    } finally {
      await m.parar();
    }
  }
});

// ── Válvulas en buffers distintos y en bitOut ─────────────────────────────────────────

test('sim e2e: buffers distintos — absoluta, máscara con pulse.until en otro INT_OUT y dos bobinas en bitOut; cada una toca solo lo suyo', async (t) => {
  relojFalso(t);
  const m = await montar(opciones({ defaults: { travelMs: 5000 }, valves: { 'sim-buffers/valve2': { untilIdleValue: 1025 } } }));
  try {
    const r1 = await esperar(t, orden(m, 'sim-buffers', 'valve1', 'open'), 70_000);
    const r2 = await esperar(t, orden(m, 'sim-buffers', 'valve2', 'open'), 70_000);
    const r3 = await esperar(t, orden(m, 'sim-buffers', 'valve3', 'open'), 70_000);
    const h = m.sim.getWriteHistory();

    // 1) Absoluta: la palabra entera es suya (1 abre, 0 suelta). Read-back emulado → confirmada.
    assert.deepEqual(escriturasEn(h, 'INT_OUT_SIM_BUF').map((w) => w.value), [1, 0]);
    assert.equal(r1.status, 'confirmed');

    // 2) Máscara 4096 en OTRO buffer, sostenida hasta que INT_IN_SIM_BUF[2] vale 1 (fin de carrera).
    const w2 = escriturasEn(h, 'INT_OUT_SIM_BUF_B');
    assert.deepEqual(w2.map((w) => w.value), [4096, 0]);
    const sostenido = w2[1].ms - w2[0].ms;
    assert.ok(sostenido >= 5000 && sostenido < 7000, `se soltó por la realimentación al llegar (5 s de recorrido), no a los 45 s: ${sostenido} ms`);
    assert.equal(r2.status, 'sent', 'su read-back espera 16385 para abrir Y cerrar (como La Vorágine): ambiguo, no se emula');

    // 3) Dos bobinas en bitOut: primero se suelta la contraria y después se energiza la propia; al
    //    soltar, en orden inverso.
    const w3 = h.filter((w) => w.sourceBuffer === 'BIT_OUT_SIM_BUF');
    assert.deepEqual(
      w3.map((w) => `${w.index}=${String(w.value)}`),
      ['1=false', '0=true', '0=false', '1=false'],
    );
    assert.equal(r3.status, 'confirmed', 'el final de carrera de abierta (BIT_IN[0]) confirma');

    // Ninguna tocó el buffer de otra.
    assert.equal(h.length, 2 + 2 + 4, 'ni una escritura más que las suyas');
    for (const v of ['valve1', 'valve2', 'valve3']) assert.equal(m.sim.getSimulatedValve('sim-buffers', v)?.state, 'open', v);
    assert.deepEqual(m.sim.getViolations(), []);
  } finally {
    await m.parar();
  }
});
