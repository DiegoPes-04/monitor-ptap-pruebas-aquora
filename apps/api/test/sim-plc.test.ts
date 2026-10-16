/**
 * El PLC SIMULADO y el SimulatorBridgeAdapter, por piezas.
 *
 * Antes el simulador inventaba un seno para TODOS los buffers, incluidos los de salida: lo que se
 * escribía no aparecía nunca en un frame y no había ninguna válvula que respondiera, así que probar
 * en local una asignación de bits era imposible. Aquí se fija lo que lo hace útil:
 *  - los buffers de SALIDA llevan lo escrito (o su valor inicial), nunca ruido;
 *  - la MSG maestro→local se muestrea por ciclos: lo que cae entre dos muestreos no llega;
 *  - hold (se mueve solo con el bit sostenido) y latch (basta el flanco);
 *  - abrir y cerrar a 1 a la vez: violación en el instante y ERROR cuando el PLC local lo ve;
 *  - la realimentación que el código espera, deducida del mapping (y nada que el mapping no diga);
 *  - con escenario, el destino de cada lectura/escritura se valida como en el adaptador real.
 *
 * El modelo (`SimulatedPlc`) recibe el tiempo como argumento: sus tests no necesitan temporizadores.
 */
import 'reflect-metadata';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Logger, type LoggerService } from '@nestjs/common';
import type { AuditLogService } from '../src/infrastructure/audit/audit-log.service';
import type { ConnectivityConfig, OpcUaConfig } from '../src/infrastructure/connectivity/connectivity.config';
import { loadMapping, type LoadedMapping, type WriteSpec } from '../src/infrastructure/connectivity/mapping/opc-mapping.loader';
import type { PlantCache } from '../src/infrastructure/connectivity/pipeline/plant-cache';
import type { PlantSnapshotDto } from '../src/infrastructure/connectivity/pipeline/plant-snapshot.dto';
import type { RawPlantFrame } from '../src/infrastructure/connectivity/ports/connectivity-adapter.port';
import { SimulatorBridgeAdapter } from '../src/infrastructure/connectivity/adapters/simulator/simulator-bridge.adapter';
import { SimulatedPlc, type SimElementRef } from '../src/infrastructure/connectivity/adapters/simulator/simulated-plc';
import { opcionesPorDefecto, type SimulatorOptions } from '../src/infrastructure/connectivity/adapters/simulator/sim-scenario';
import type { CommandLogRepository } from '../src/modules/commands/command-log.repository';
import type { CommandMappingResolver } from '../src/modules/commands/command-mapping.resolver';
import type { CommandSignatureService } from '../src/modules/commands/command-signature.service';
import { FAIL } from '../src/modules/commands/command.dto';
import { WriteService } from '../src/modules/commands/write.service';
import type { NotificationRepository } from '../src/modules/notifications/notification.repository';

Logger.overrideLogger(false);

const RUTA_PRUEBA = join(__dirname, '..', 'fixtures', 'sim-scenarios', 'mappings', 'valvulas-de-prueba.json');
const RUTA_PRODUCCION = join(__dirname, '..', 'config', 'opc_mapping.json');
const prueba = (): LoadedMapping => loadMapping(RUTA_PRUEBA);

type Cambios = {
  ioLatencyMs?: number;
  historyCapacity?: number;
  defaults?: Partial<SimulatorOptions['defaults']>;
  plants?: SimulatorOptions['plants'];
  valves?: SimulatorOptions['valves'];
  initialValues?: SimulatorOptions['initialValues'];
};

function opciones(c: Cambios = {}): SimulatorOptions {
  const base = opcionesPorDefecto();
  return {
    ...base,
    name: 'test',
    ioLatencyMs: c.ioLatencyMs ?? 0,
    historyCapacity: c.historyCapacity ?? base.historyCapacity,
    defaults: { ...base.defaults, msgCycleMs: 0, msgPhaseMs: 0, travelMs: 1000, ...c.defaults },
    plants: c.plants ?? {},
    valves: c.valves ?? {},
    initialValues: c.initialValues ?? {},
  };
}

const UNA: SimElementRef = { plantId: 'sim-una', channel: 'intOut', sourceBuffer: 'INT_OUT_SIM_UNA', index: 0 };
const UNA_ESTADO: SimElementRef = { plantId: 'sim-una', channel: 'intIn', sourceBuffer: 'INT_IN_SIM_UNA', index: 0 };
const UNA_CAUDAL: SimElementRef = { plantId: 'sim-una', channel: 'realIn', sourceBuffer: 'REAL_IN_SIM_UNA', index: 0 };

function capturarLogs(): { errores: string[]; avisos: string[]; restaurar: () => void } {
  const errores: string[] = [];
  const avisos: string[] = [];
  const capturador: LoggerService = {
    log: () => undefined,
    error: (m: unknown) => void errores.push(String(m)),
    warn: (m: unknown) => void avisos.push(String(m)),
    debug: () => undefined,
    verbose: () => undefined,
  };
  Logger.overrideLogger(capturador);
  return { errores, avisos, restaurar: () => Logger.overrideLogger(false) };
}

function opcuaConfig(over: Partial<OpcUaConfig> = {}): OpcUaConfig {
  return {
    endpoint: 'simulator://in-memory',
    endpointMustExist: false,
    securityMode: 'SignAndEncrypt',
    securityPolicy: 'Basic256Sha256',
    identity: { type: 'username', userName: 'simulador', password: 'simulador' },
    autoAcceptUnknownCertificate: false,
    publishingIntervalMs: 100,
    samplingIntervalMs: 100,
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
    ...over,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function avanzar(t: TestContext, ms: number, paso = 10): Promise<void> {
  for (let hecho = 0; hecho < ms; hecho += paso) {
    t.mock.timers.tick(Math.min(paso, ms - hecho));
    await flush();
    await flush();
  }
}

// ── Frames: las SALIDAS reflejan lo escrito ──────────────────────────────────────────

/** Una planta con un buffer de entrada y uno de salida, sin válvulas (el modo de los tests de siempre). */
function mappingMinimo(): LoadedMapping {
  return {
    version: '1.0.0',
    protocolVersion: 'v2',
    dtoVersion: 'v1',
    plants: [{ plantId: 'p', displayName: 'P', livenessWindowSec: null }],
    targets: [
      { plantId: 'p', browseName: 'REAL_IN_P', channel: 'realIn', node: { nsUri: 'X', identifier: 's=1' }, arrayLength: 4, dataType: 'Float' },
      { plantId: 'p', browseName: 'INT_OUT_P', channel: 'intOut', node: { nsUri: 'X', identifier: 's=2' }, arrayLength: 6, dataType: 'Int16' },
      { plantId: 'p', browseName: 'BIT_OUT_P', channel: 'bitOut', node: { nsUri: 'X', identifier: 's=3' }, arrayLength: 3, dataType: 'Boolean' },
    ],
    signals: [],
    raw: {},
  };
}

test('simulador: los buffers de SALIDA de los frames llevan lo escrito y lo conservan; lo nunca escrito vale 0/false, no ruido', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-07T08:00:00Z') });
  const sim = new SimulatorBridgeAdapter(opcuaConfig(), mappingMinimo()); // sin escenario: modo de siempre
  const frames: RawPlantFrame[] = [];
  sim.onFrame((f) => frames.push(f));
  await sim.start();
  try {
    await avanzar(t, 250);
    const salida = (f: RawPlantFrame, b: string) => f.buffers.find((x) => x.browseName === b)?.values;
    assert.deepEqual(salida(frames[frames.length - 1], 'INT_OUT_P'), [0, 0, 0, 0, 0, 0], 'nada escrito: ceros deterministas');
    assert.deepEqual(salida(frames[frames.length - 1], 'BIT_OUT_P'), [false, false, false]);

    await sim.writeBufferElement({ plantId: 'p', channel: 'intOut', sourceBuffer: 'INT_OUT_P', index: 3 }, 4096);
    await sim.writeBufferElement({ plantId: 'p', channel: 'bitOut', sourceBuffer: 'BIT_OUT_P', index: 1 }, true);
    const desde = frames.length;
    await avanzar(t, 350);
    const nuevos = frames.slice(desde);
    assert.ok(nuevos.length >= 3, `debe haber varios frames nuevos (${nuevos.length})`);
    for (const f of nuevos) {
      assert.deepEqual(salida(f, 'INT_OUT_P'), [0, 0, 0, 4096, 0, 0], 'lo escrito aparece en CADA frame y se conserva');
      assert.deepEqual(salida(f, 'BIT_OUT_P'), [false, true, false]);
    }
    // Las entradas siguen siendo sintéticas: cambian con el tiempo (es lo que mantiene la planta `live`).
    const entradas = nuevos.map((f) => JSON.stringify(salida(f, 'REAL_IN_P')));
    assert.ok(new Set(entradas).size > 1, 'las entradas sin dueño cambian');
  } finally {
    await sim.stop();
  }
});

test('simulador: valores iniciales del escenario — deterministas en frames y lecturas, en salidas y en entradas', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-07T08:00:00Z') });
  const sim = new SimulatorBridgeAdapter(
    opcuaConfig(),
    prueba(),
    opciones({ initialValues: { 'sim-tres/INT_OUT_SIM_TRES[0]': 2 | 8 | 32, 'sim-una/REAL_IN_SIM_UNA[2]': 1.8 } }),
  );
  const frames: RawPlantFrame[] = [];
  sim.onFrame((f) => frames.push(f));
  await sim.start();
  try {
    await avanzar(t, 250);
    const ultimo = (plantId: string, b: string) =>
      [...frames].reverse().find((f) => f.plantId === plantId && f.buffers.some((x) => x.browseName === b))?.buffers.find((x) => x.browseName === b)
        ?.values;
    assert.equal(ultimo('sim-tres', 'INT_OUT_SIM_TRES')?.[0], 42, 'la palabra arranca con los tres CERRAR puestos');
    assert.equal(ultimo('sim-una', 'REAL_IN_SIM_UNA')?.[2], 1.8, 'una entrada con valor inicial deja de ser ruido');
    const leido = await sim.readBufferElement({ plantId: 'sim-tres', channel: 'intOut', sourceBuffer: 'INT_OUT_SIM_TRES', index: 0 });
    assert.equal(leido.value, 42, 'la lectura OPC UA ve lo mismo que el frame');
  } finally {
    await sim.stop();
  }
});

test('simulador: una entrada sin dueño se LEE igual que se emite en el frame del mismo instante', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-07T08:00:00Z') });
  const sim = new SimulatorBridgeAdapter(opcuaConfig({ publishingIntervalMs: 100 }), prueba(), opciones());
  const frames: RawPlantFrame[] = [];
  sim.onFrame((f) => frames.push(f));
  await sim.start();
  try {
    // A los 100 ms el temporizador de emisión toma la muestra; la lectura se hace en ese mismo instante.
    await avanzar(t, 100);
    const leido = await sim.readBufferElement({ plantId: 'sim-una', channel: 'realIn', sourceBuffer: 'REAL_IN_SIM_UNA', index: 4 });
    await avanzar(t, 20); // el coalescer entrega el frame 10 ms después, con los valores tomados a los 100 ms
    const f = frames.find((x) => x.plantId === 'sim-una' && x.buffers.some((b) => b.browseName === 'REAL_IN_SIM_UNA'));
    assert.ok(f, 'hubo frame');
    const enFrame = f.buffers.find((b) => b.browseName === 'REAL_IN_SIM_UNA')?.values[4];
    assert.equal(typeof leido.value, 'number');
    assert.notEqual(leido.value, 0, 'no es un cero de relleno: es la señal sintética');
    assert.equal(leido.value, enFrame, 'la lectura OPC UA y el frame del mismo instante dicen lo mismo');
  } finally {
    await sim.stop();
  }
});

// ── La MSG maestro→local y el enclavamiento ──────────────────────────────────────────

test('PLC: un bit puesto y quitado ENTRE dos muestreos de la MSG nunca llega al PLC local', () => {
  const plc = new SimulatedPlc(prueba(), opciones({ defaults: { msgCycleMs: 8000, travelMs: 30_000, latchMode: 'latch' } }), 0);
  plc.escribir(UNA, 1, 1000);
  plc.escribir(UNA, 0, 4000);
  const v = plc.valvula('sim-una', 'valve1', 20_000);
  assert.equal(v?.state, 'closed', 'ni siquiera en latch: el flanco nunca existió en la copia local');
  assert.equal(v?.position, 0);
  assert.deepEqual(v?.transitions, []);
  assert.deepEqual(
    plc.escrituras().map((w) => w.value),
    [1, 0],
    'el historial sí registra la orden: salió del maestro, no llegó al local',
  );
});

test('PLC: hold se mueve SOLO con el bit en la copia local y se queda a medias; latch completa con el flanco', () => {
  const res: Record<string, ReturnType<SimulatedPlc['valvula']>> = {};
  for (const latchMode of ['hold', 'latch'] as const) {
    const plc = new SimulatedPlc(prueba(), opciones({ defaults: { msgCycleMs: 8000, travelMs: 30_000, latchMode } }), 0);
    plc.escribir(UNA, 1, 6000); // el muestreo de 8000 lo ve
    plc.escribir(UNA, 0, 9000); // el de 16000 ve que se soltó
    res[latchMode] = plc.valvula('sim-una', 'valve1', 60_000);
  }
  assert.equal(res.hold?.state, 'mid');
  assert.ok(Math.abs((res.hold?.position ?? 0) - 8000 / 30_000) < 0.001, `vio el bit 8 s de 30: ${res.hold?.position}`);
  assert.deepEqual(
    res.hold?.transitions.map((x) => `${x.from}→${x.to}@${x.ms}`),
    ['closed→opening@8000', 'opening→mid@16000'],
  );
  assert.equal(res.latch?.state, 'open');
  assert.deepEqual(
    res.latch?.transitions.map((x) => `${x.from}→${x.to}@${x.ms}`),
    ['closed→opening@8000', 'opening→open@38000'],
    'el recorrido completo (30 s) desde el muestreo que vio el flanco',
  );
});

test('PLC: en latch, el verbo contrario a mitad de recorrido invierte el movimiento', () => {
  const plc = new SimulatedPlc(prueba(), opciones({ defaults: { msgCycleMs: 0, travelMs: 10_000, latchMode: 'latch' } }), 0);
  plc.escribir(UNA, 1, 0);
  plc.escribir(UNA, 0, 100);
  plc.escribir(UNA, 2, 4000); // cerrar a 4 s: posición 0,4
  const v = plc.valvula('sim-una', 'valve1', 9000);
  assert.equal(v?.state, 'closed', 'cerró en 4 s más');
  assert.deepEqual(
    v?.transitions.map((x) => `${x.from}→${x.to}@${x.ms}`),
    ['closed→opening@0', 'opening→closing@4000', 'closing→closed@8000'],
  );
});

// ── ERROR: abrir y cerrar a 1 a la vez ────────────────────────────────────────────────

test('PLC: abrir y cerrar a 1 → VIOLACIÓN al instante, ERROR cuando el PLC local lo ve; log fuerte, contador, se para y no sale solo', () => {
  const logs = capturarLogs();
  try {
    const plc = new SimulatedPlc(prueba(), opciones({ defaults: { msgCycleMs: 8000, travelMs: 30_000 } }), 0);
    plc.escribir(UNA, 1 | 2, 1000);
    const violaciones = plc.violacionesRegistradas();
    assert.equal(violaciones.length, 1, 'la escritura queda registrada como violación en el acto');
    assert.equal(violaciones[0].valve, 'valve1');
    assert.equal(violaciones[0].value, 3);
    assert.match(violaciones[0].reason, /ABRIR y CERRAR a 1 a la vez/);
    assert.equal(plc.valvula('sim-una', 'valve1', 2000)?.state, 'closed', 'el PLC local aún no lo vio (MSG de 8 s)');

    const enError = plc.valvula('sim-una', 'valve1', 8000);
    assert.equal(enError?.state, 'error', 'el muestreo de 8 s lo ve: ERROR, como lo declara el PLC');
    assert.equal(enError?.errorsTotal, 1);
    assert.equal(enError?.violationsTotal, 1);
    assert.match(enError?.error?.reason ?? '', /ABRIR y CERRAR/);
    assert.ok(logs.errores.some((m) => m.includes('⛔') && m.includes('VIOLACIÓN')), 'la violación se loguea como error');
    assert.ok(logs.errores.some((m) => m.includes('⛔') && m.includes('en ERROR')), 'el ERROR se loguea como error');

    plc.escribir(UNA, 0, 9000);
    assert.equal(plc.valvula('sim-una', 'valve1', 40_000)?.state, 'error', 'soltar los bits NO saca del ERROR: hace falta rearmar');
    assert.equal(plc.valvula('sim-una', 'valve1', 40_000)?.position, 0, 'parada: no se movió');
    assert.equal(plc.informe(40_000).errorsTotal, 1);

    assert.equal(plc.rearmar('sim-una', 'valve1', 41_000)?.state, 'closed');
  } finally {
    logs.restaurar();
  }
});

test('PLC: una violación que dura menos que el ciclo de la MSG queda registrada aunque el PLC local no llegue a verla', () => {
  const plc = new SimulatedPlc(prueba(), opciones({ defaults: { msgCycleMs: 8000, travelMs: 30_000 } }), 0);
  plc.escribir(UNA, 3, 1000);
  plc.escribir(UNA, 1, 1001);
  assert.equal(plc.violacionesRegistradas().length, 1, 'el simulador es más estricto que el PLC: cuenta hasta 1 ms con los dos bits');
  assert.equal(plc.valvula('sim-una', 'valve1', 9000)?.state, 'opening', 'el PLC local solo vio el 1');
});

test('PLC: dos bobinas en bitOut energizadas a la vez es ERROR', () => {
  const plc = new SimulatedPlc(prueba(), opciones(), 0);
  const bobina = (index: number): SimElementRef => ({ plantId: 'sim-buffers', channel: 'bitOut', sourceBuffer: 'BIT_OUT_SIM_BUF', index });
  plc.escribir(bobina(0), true, 10);
  plc.escribir(bobina(1), true, 20);
  assert.equal(plc.violacionesRegistradas().length, 1);
  assert.equal(plc.valvula('sim-buffers', 'valve3', 30)?.state, 'error');
});

// ── Realimentación ───────────────────────────────────────────────────────────────────

test('PLC: realimentación auto — read-back por verbo, caudal proporcional, y valor neutro mientras se mueve', () => {
  const plc = new SimulatedPlc(prueba(), opciones({ defaults: { travelMs: 1000, flowOpen: 10 } }), 0);
  assert.equal(plc.leer(UNA_ESTADO, 0), 16384, 'cerrada: lo que espera `close`');
  assert.equal(plc.leer(UNA_CAUDAL, 0), 0);
  plc.escribir(UNA, 1, 100);
  assert.equal(plc.leer(UNA_ESTADO, 600), 0, 'moviéndose: ni abierta ni cerrada (sin bit14)');
  assert.equal(plc.leer(UNA_CAUDAL, 600), 5, 'a mitad de recorrido, la mitad del caudal');
  assert.equal(plc.leer(UNA_ESTADO, 1100), 16385, 'abierta: lo que espera `open`');
  assert.equal(plc.leer(UNA_CAUDAL, 1100), 10);
});

test('PLC: pulse.until vale `equals` SOLO con el verbo puesto y la válvula en ESE tope; en reposo, el valor de reposo', () => {
  const plc = new SimulatedPlc(prueba(), opciones({ valves: { 'sim-buffers/valve2': { untilIdleValue: 1025 } } }), 0);
  const mando: SimElementRef = { plantId: 'sim-buffers', channel: 'intOut', sourceBuffer: 'INT_OUT_SIM_BUF_B', index: 0 };
  const fin: SimElementRef = { plantId: 'sim-buffers', channel: 'intIn', sourceBuffer: 'INT_IN_SIM_BUF', index: 2 };
  assert.equal(plc.leer(fin, 0), 1025, 'en reposo, 1025 (como La Vorágine), no 1');
  plc.escribir(mando, 4096, 100);
  assert.equal(plc.leer(fin, 500), 1025, 'abriendo: aún no');
  assert.equal(plc.leer(fin, 1200), 1, 'en el tope de abierta con abrir puesto: 1, el sostenido se puede soltar');
  plc.escribir(mando, 0, 1300);
  assert.equal(plc.leer(fin, 1400), 1025, 'soltado el bit, vuelve al reposo');
  plc.escribir(mando, 8192, 2000);
  assert.equal(plc.leer(fin, 2100), 1025, 'cerrando desde abierta: NO vale 1 aunque esté en un tope');
  assert.equal(plc.leer(fin, 3100), 1, 'en el tope de cerrada con cerrar puesto');
});

test('PLC: read-back AMBIGUO (mismo valor para abrir y cerrar, como La Vorágine) NO se emula, y lo avisa', () => {
  const v = new SimulatedPlc(prueba(), opciones(), 0).valvula('sim-buffers', 'valve2', 0);
  assert.ok(v?.warnings.some((w) => /AMBIGUO/.test(w)), v?.warnings.join(' | '));
  assert.ok(!v?.feedback.some((f) => f.origin === 'readBack'), 'ningún read-back emulado');
  assert.ok(v?.feedback.some((f) => f.origin === 'until'), 'el fin de carrera sí');
});

test('PLC: palabra de estado con convención LITERAL (stateEncoding de Cascajal, mapping real)', () => {
  const plc = new SimulatedPlc(loadMapping(RUTA_PRODUCCION), opciones(), 0);
  const estado: SimElementRef = { plantId: 'cascajal', channel: 'intIn', sourceBuffer: 'INT_IN_CASCAJAL', index: 1 };
  assert.equal(plc.leer(estado, 0), 251, 'cerrada = 251 (verificado en campo 2026-08-13)');
  // 128 = bit7 = abrir la salida 1 (integrador 2026-10-16). El 4096 de antes es ahora la salida 2.
  plc.escribir({ plantId: 'cascajal', channel: 'intOut', sourceBuffer: 'INT_OUT_CASCAJAL', index: 0 }, 128, 10);
  assert.equal(plc.leer(estado, 2000), 0, 'abierta: el mapping no declara literal de abierta → neutro, la app cae al caudal');
});

test('PLC: con feedback none no se emula nada; lo declarado a mano en el escenario sí, estado por estado', () => {
  const plc = new SimulatedPlc(
    prueba(),
    opciones({
      defaults: { travelMs: 1000 },
      valves: {
        'sim-una/valve1': { feedback: 'none', feedbackElements: [{ element: 'INT_IN_SIM_UNA[5]', open: 1, closed: 2, moving: 3, mid: 4, error: 9 }] },
      },
    }),
    0,
  );
  const manual: SimElementRef = { plantId: 'sim-una', channel: 'intIn', sourceBuffer: 'INT_IN_SIM_UNA', index: 5 };
  const v = plc.valvula('sim-una', 'valve1', 0);
  assert.deepEqual(v?.feedback.map((f) => f.origin), ['scenario'], 'ni read-back ni caudal: solo el elemento declarado');
  assert.notEqual(plc.leer(UNA_ESTADO, 0), 16384, 'el read-back NO se emula: es una entrada sintética más');
  assert.equal(plc.leer(manual, 0), 2, 'cerrada');
  plc.escribir(UNA, 1, 100);
  assert.equal(plc.leer(manual, 500), 3, 'moviéndose');
  plc.escribir(UNA, 0, 600);
  assert.equal(plc.leer(manual, 700), 4, 'a medias (hold soltado antes del tope)');
  plc.escribir(UNA, 1, 800);
  assert.equal(plc.leer(manual, 1400), 1, 'abierta');
  plc.forzarError('sim-una', 'valve1', 'prueba', 1500);
  assert.equal(plc.leer(manual, 1500), 9, 'error');
});

// ── Historial acotado ────────────────────────────────────────────────────────────────

test('PLC: el historial de escrituras está acotado (regla 12) y conserva las más recientes', () => {
  const plc = new SimulatedPlc(prueba(), opciones({ historyCapacity: 3 }), 0);
  for (let i = 1; i <= 5; i++) plc.escribir(UNA, i % 2 === 0 ? 0 : 1, i * 10);
  assert.deepEqual(plc.escrituras().map((w) => w.seq), [3, 4, 5]);
  assert.equal(plc.informe(100).writesTotal, 5, 'el contador no se pierde');
});

// ── El adaptador con escenario: destino estricto, latencia, perillas ──────────────────

test('adaptador con escenario: el destino se valida como en el adaptador OPC UA real', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-07T08:00:00Z') });
  const sim = new SimulatorBridgeAdapter(opcuaConfig(), prueba(), opciones());
  await assert.rejects(sim.writeBufferElement(UNA, 1), /sin sesión OPC UA activa/, 'antes de start(): sin sesión');
  await sim.start();
  try {
    await assert.rejects(
      sim.writeBufferElement({ ...UNA, sourceBuffer: 'INT_OUT_SIM_UNO' }, 1),
      /buffer no encontrado para escribir\/leer: sim-una\/intOut\/INT_OUT_SIM_UNO/,
      'un sourceBuffer mal escrito falla aquí igual que en el PLC',
    );
    await assert.rejects(sim.writeBufferElement({ ...UNA, channel: 'intIn' }, 1), /buffer no encontrado/, 'el canal tiene que casar');
    await assert.rejects(sim.writeBufferElement({ ...UNA, index: 20 }, 1), /BadIndexRangeNoData/, 'INT_OUT_SIM_UNA declara 20 elementos');
    assert.deepEqual(
      { ...(await sim.readBufferElement({ ...UNA, index: 20 })), sourceTimestamp: null },
      { value: null, quality: 'Bad', sourceTimestamp: null },
      'leer fuera de rango: Bad sin valor, como el servidor real',
    );
    sim.faultBuffer('sim-una', 'INT_OUT_SIM_UNA');
    await assert.rejects(sim.writeBufferElement(UNA, 1), /faulted/);
    assert.equal(sim.getWriteHistory().length, 0, 'ninguna de esas escrituras llegó al maestro');
  } finally {
    await sim.stop();
  }
  // Sin escenario, el modo de siempre: acepta cualquier destino (lo usan los tests anteriores).
  const heredado = new SimulatorBridgeAdapter(opcuaConfig(), prueba());
  await heredado.writeBufferElement({ ...UNA, sourceBuffer: 'INT_OUT_TEST' }, 7);
  assert.equal((await heredado.readBufferElement({ ...UNA, sourceBuffer: 'INT_OUT_TEST' })).value, 7);
});

test('WriteService + simulador: un write spec con el buffer mal escrito sale WRITE_REJECTED y no escribe nada', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-07T08:00:00Z') });
  const mapping = prueba();
  const sim = new SimulatorBridgeAdapter(opcuaConfig(), mapping, opciones());
  await sim.start();
  try {
    const bueno = mapping.signals.find((s) => s.plantId === 'sim-una' && s.domainKey === 'valve1')!.write!;
    const conErrata: WriteSpec = { ...bueno, target: { ...bueno.target, sourceBuffer: 'INT_OUT_SIM_UNO' } };
    const servicio = new WriteService(
      sim,
      { opcua: { writesEnabled: true } } as ConnectivityConfig,
      { get: () => ({ liveness: { state: 'live' }, signals: {}, sequence: 1 }) as unknown as PlantSnapshotDto } as unknown as PlantCache,
      { resolve: () => ({ domainKey: 'valve1', write: conErrata }) } as unknown as CommandMappingResolver,
      { reserve: async () => ({ reserved: true, id: 1 }), finalize: async () => undefined } as unknown as CommandLogRepository,
      { record: async () => undefined } as unknown as AuditLogService,
      { firmar: async () => 'f' } as unknown as CommandSignatureService,
      { create: async () => true } as unknown as NotificationRepository,
    );
    const r = await servicio.execute('sim-una', { command: 'open', target: 'valve1' }, { userId: 'u', userName: 'u', userEmail: 'u@x', role: 'operador', ip: null });
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, FAIL.WRITE_REJECTED);
    assert.equal(sim.getWriteHistory().length, 0);
  } finally {
    await sim.stop();
  }
});

test('adaptador con escenario: la latencia de I/O hace que la escritura surta efecto a MITAD del viaje', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-07T08:00:00Z') });
  const sim = new SimulatorBridgeAdapter(opcuaConfig(), prueba(), opciones({ ioLatencyMs: 100 }));
  await sim.start();
  try {
    let terminada = false;
    void sim.writeBufferElement(UNA, 1).then(() => (terminada = true));
    await avanzar(t, 40);
    assert.equal(sim.getWriteHistory().length, 0, 'a los 40 ms la petición aún va de camino');
    await avanzar(t, 20);
    assert.equal(sim.getWriteHistory().length, 1, 'a los 50 ms surte efecto en el servidor');
    assert.equal(terminada, false, 'pero la respuesta aún no ha vuelto');
    await avanzar(t, 50);
    assert.equal(terminada, true, 'a los 100 ms vuelve');
  } finally {
    await sim.stop();
  }
});

test('adaptador con escenario: perillas de diagnóstico — forzar ERROR, rearmar y cambiar hold/latch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-07T08:00:00Z') });
  const sim = new SimulatorBridgeAdapter(opcuaConfig(), prueba(), opciones());
  await sim.start();
  try {
    assert.equal(sim.forceValveError('sim-dos', 'valve2', 'prueba de la app')?.state, 'error');
    assert.equal(sim.getSimulationReport().errorsTotal, 1);
    assert.equal(sim.getSimulatedValve('sim-dos', 'valve1')?.state, 'closed', 'solo esa válvula');
    assert.equal(sim.resetValve('sim-dos', 'valve2')?.state, 'closed');
    assert.equal(sim.setValveLatchMode('sim-dos', 'valve2', 'latch')?.latchMode, 'latch');
    assert.equal(sim.getSimulatedValve('sim-x', 'valve9'), null, 'una válvula que no existe');
    const informe = sim.getSimulationReport();
    assert.equal(informe.valves.length, 9, 'las 9 válvulas del mapping de prueba');
    assert.equal(informe.scenario.name, 'test');
  } finally {
    await sim.stop();
  }
});
