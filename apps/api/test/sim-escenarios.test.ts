/**
 * Escenarios del simulador y mapping de PRUEBA: que lo versionado carga, que el mapping de prueba
 * pasa el MISMO gate que el de producción (`validate:mapping`), que un escenario mal escrito falla con
 * un motivo legible, y que un mapping de simulación JAMÁS arranca contra el PLC real.
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CONNECTIVITY_ADAPTER } from '../src/infrastructure/connectivity/connectivity.tokens';
import { ConnectivityModule } from '../src/infrastructure/connectivity/connectivity.module';
import { loadMapping } from '../src/infrastructure/connectivity/mapping/opc-mapping.loader';
import { SimulatorBridgeAdapter } from '../src/infrastructure/connectivity/adapters/simulator/simulator-bridge.adapter';
import { SimulatorToolsModule } from '../src/infrastructure/connectivity/adapters/simulator/simulator-tools.module';
import {
  SIM_DEFAULTS,
  asegurarMappingParaPlcReal,
  configDePlanta,
  configDeValvula,
  directoriosDeEscenarios,
  esMappingSoloSimulacion,
  leerEscenario,
  opcionesDelEntorno,
  opcionesDesdeEscenario,
  opcionesPorDefecto,
  resolverRutaEscenario,
  validarEscenarioContraMapping,
} from '../src/infrastructure/connectivity/adapters/simulator/sim-scenario';
import { loadJson, validateMapping } from '../scripts/validate-mapping';

Logger.overrideLogger(false);

const API = join(__dirname, '..');
const DIR_ESCENARIOS = join(API, 'fixtures', 'sim-scenarios');
const RUTA_PRUEBA = join(DIR_ESCENARIOS, 'mappings', 'valvulas-de-prueba.json');
const RUTA_PRODUCCION = join(API, 'config', 'opc_mapping.json');
const ESQUEMA = loadJson(join(API, 'config', 'opc_mapping.schema.json')) as object;
const VERSIONADOS = ['valvulas-de-prueba', 'enclavamiento-latch', 'produccion'];

/** Escribe un escenario temporal (fuera del repo) y devuelve su ruta. */
function escenarioTemporal(contenido: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'sim-escenario-'));
  const ruta = join(dir, 'escenario.json');
  writeFileSync(ruta, JSON.stringify(contenido), 'utf8');
  return ruta;
}

/** Ejecuta `fn` con variables de entorno puestas y las deja como estaban. */
async function conEntorno<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const antes = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── Lo versionado ────────────────────────────────────────────────────────────────────

test('escenarios versionados: cargan, su mapping pasa validate:mapping (schema + reglas) y son coherentes con él', () => {
  for (const nombre of VERSIONADOS) {
    const leido = leerEscenario(resolverRutaEscenario(nombre));
    assert.ok(leido.rutaMapping, `${nombre}: declara su mapping`);
    const veredicto = validateMapping(ESQUEMA, loadJson(leido.rutaMapping));
    assert.deepEqual(veredicto.errors, [], `${nombre}: el mapping ${leido.rutaMapping} debe pasar el gate de CI`);
    const opts = opcionesDesdeEscenario(leido);
    assert.deepEqual(validarEscenarioContraMapping(opts, loadMapping(leido.rutaMapping)), [], `${nombre}: coherente`);
  }
});

test('mapping de PRUEBA: 1 válvula, 2 y 3 en la MISMA palabra (bits 0/1, 2/3, 4/5), buffers distintos y bitOut — y todos los write spec sobreviven al loader', () => {
  const m = loadMapping(RUTA_PRUEBA);
  assert.equal(esMappingSoloSimulacion(m), true, 'marcado como de simulación');
  const valvulas = (plantId: string) =>
    m.signals.filter((s) => s.plantId === plantId && s.writable).map((s) => ({ v: s.domainKey, w: s.write }));
  for (const { v, w } of [...valvulas('sim-una'), ...valvulas('sim-dos'), ...valvulas('sim-tres'), ...valvulas('sim-buffers')]) {
    assert.ok(w, `${v}: el loader no descartó su write spec`);
  }
  assert.equal(valvulas('sim-una').length, 1);

  const palabra = (plantId: string) => valvulas(plantId).map(({ w }) => `${w!.target.sourceBuffer}[${w!.target.index}] ${JSON.stringify(w!.commands)} ${w!.mode}`);
  assert.deepEqual(palabra('sim-dos'), [
    'INT_OUT_SIM_DOS[0] {"open":1,"close":2} bitmask',
    'INT_OUT_SIM_DOS[0] {"open":4,"close":8} bitmask',
  ]);
  assert.deepEqual(palabra('sim-tres'), [
    'INT_OUT_SIM_TRES[0] {"open":1,"close":2} bitmask',
    'INT_OUT_SIM_TRES[0] {"open":4,"close":8} bitmask',
    'INT_OUT_SIM_TRES[0] {"open":16,"close":32} bitmask',
  ]);
  // Ningún bit compartido entre válvulas de la misma palabra: si alguien copia y pega mal, se ve aquí.
  const bits = valvulas('sim-tres').flatMap(({ w }) => Object.values(w!.commands) as number[]);
  assert.equal(bits.reduce((a, b) => a | b, 0), 63);
  assert.equal(new Set(bits).size, 6);

  const buffers = valvulas('sim-buffers').map(({ w }) => `${w!.target.channel}/${w!.target.sourceBuffer} ${w!.mode}${w!.sequences ? ' secuencia' : ''}${w!.pulse?.until ? ' until' : ''}`);
  assert.deepEqual(buffers, [
    'intOut/INT_OUT_SIM_BUF absolute',
    'intOut/INT_OUT_SIM_BUF_B bitmask until',
    'bitOut/BIT_OUT_SIM_BUF absolute secuencia',
  ]);
});

test('mapping de PRODUCCIÓN: no está marcado como de simulación', () => {
  assert.equal(esMappingSoloSimulacion(loadMapping(RUTA_PRODUCCION)), false);
});

// ── Forma del escenario ──────────────────────────────────────────────────────────────

test('escenario con forma inválida → error con el campo y el motivo, nunca un default silencioso', () => {
  const casos: [unknown, RegExp][] = [
    [{ name: 'x', defaults: { travelMS: 1000 } }, /defaults: Unrecognized key/],
    [{ name: 'x', defaults: { msgCycleMs: 5 } }, /msgCycleMs: un ciclo es 0 \(instantáneo\) o al menos 10 ms/],
    [{ name: 'x', defaults: { latchMode: 'pulso' } }, /latchMode/],
    [{ name: 'x', initialValues: { 'INT_OUT[0]': 1 } }, /se espera plantId\/BUFFER\[indice\]/],
    [{ name: 'x', valves: { 'sim-una/valve1': { feedbackElements: [{ element: 'INT_IN' }] } } }, /se espera BUFFER\[indice\]/],
    [{ description: 'sin nombre' }, /name/],
    [{ name: 'x', mapping: 'no-existe.json' }, /apunta a un mapping que no existe/],
  ];
  for (const [contenido, motivo] of casos) {
    assert.throws(() => leerEscenario(escenarioTemporal(contenido)), motivo, JSON.stringify(contenido));
  }
});

test('escenario incoherente con el mapping → lista de errores (planta, válvula, verbo, buffer o índice que no existen)', () => {
  const ruta = escenarioTemporal({
    name: 'incoherente',
    mapping: RUTA_PRUEBA,
    plants: { 'sim-nada': { msgCycleMs: 1000 } },
    valves: {
      'sim-una/valve9': { travelMs: 1000 },
      'sim-una/outletFlow1': { travelMs: 1000 },
      'sim-dos/valve1': { verbs: { open: 'abrir' } },
      'sim-tres/valve1': { feedbackElements: [{ element: 'INT_IN_SIM_TRES[99]', open: 1 }] },
    },
    initialValues: { 'sim-una/INT_OUT_NO_EXISTE[0]': 1, 'sim-x/INT_OUT_SIM_UNA[0]': 1 },
  });
  const opts = opcionesDesdeEscenario(leerEscenario(ruta));
  const errores = validarEscenarioContraMapping(opts, loadMapping(RUTA_PRUEBA));
  const esperados = [
    /plants\.sim-nada: el mapping no tiene esa planta/,
    /valves\.sim-una\/valve9: no existe esa señal/,
    /valves\.sim-una\/outletFlow1: la señal no es una válvula/,
    /valves\.sim-dos\/valve1\.verbs\.open: "abrir" no está en write\.commands/,
    /INT_IN_SIM_TRES declara 10 elementos; 99 está fuera/,
    /sim-una no tiene ningún buffer INT_OUT_NO_EXISTE/,
    /el mapping no tiene la planta sim-x/,
  ];
  for (const e of esperados) assert.ok(errores.some((x) => e.test(x)), `falta ${e}: ${errores.join(' | ')}`);
  assert.equal(errores.length, esperados.length, errores.join(' | '));
});

// ── Parámetros ───────────────────────────────────────────────────────────────────────

test('sin escenario: los supuestos documentados (MSG 8 s, recorrido 30 s, hold, realimentación auto) y la vuelta cicla como la ida', () => {
  const opts = opcionesPorDefecto();
  assert.equal(SIM_DEFAULTS.msgCycleMs, 8000);
  assert.deepEqual(configDePlanta(opts, 'cualquiera'), { msgCycleMs: 8000, msgPhaseMs: 0, feedbackCycleMs: 8000, feedbackPhaseMs: 0 });
  const v = configDeValvula(opts, 'cualquiera', 'valve1');
  assert.equal(v.travelMs, 30_000);
  assert.equal(v.latchMode, 'hold');
  assert.equal(v.feedback, 'auto');
  assert.deepEqual(v.verbs, { open: 'open', close: 'close' });
});

test('escenario: planta y válvula pisan a los defaults solo en lo que declaran', () => {
  const opts = opcionesDesdeEscenario(leerEscenario(resolverRutaEscenario('valvulas-de-prueba')));
  assert.deepEqual(configDePlanta(opts, 'sim-buffers'), { msgCycleMs: 8000, msgPhaseMs: 3000, feedbackCycleMs: 8000, feedbackPhaseMs: 3000 });
  assert.equal(configDeValvula(opts, 'sim-tres', 'valve3').latchMode, 'latch');
  assert.equal(configDeValvula(opts, 'sim-tres', 'valve3').travelMs, 20_000);
  assert.equal(configDeValvula(opts, 'sim-tres', 'valve2').latchMode, 'hold', 'su vecina sigue en el default');
  assert.equal(configDeValvula(opts, 'sim-buffers', 'valve2').untilIdleValue, 1025);
  assert.equal(opts.ioLatencyMs, 50);
});

// ── SIM_SCENARIO ─────────────────────────────────────────────────────────────────────

test('SIM_SCENARIO: por nombre o por ruta; uno que no existe falla diciendo dónde buscó', () => {
  const porNombre = resolverRutaEscenario('produccion');
  assert.ok(directoriosDeEscenarios().some((d) => porNombre.startsWith(d)));
  assert.equal(resolverRutaEscenario(join(DIR_ESCENARIOS, 'produccion.json')), join(DIR_ESCENARIOS, 'produccion.json'));
  assert.throws(() => resolverRutaEscenario('no-existe-este'), /no encontrado: "no-existe-este".*Rutas probadas/);
});

test('SIM_SCENARIO exige SU mapping: si la app cargó otro, el simulador no arranca', async () => {
  await conEntorno({ SIM_SCENARIO: 'valvulas-de-prueba' }, () => {
    assert.throws(() => opcionesDelEntorno(loadMapping(RUTA_PRODUCCION), RUTA_PRODUCCION), /exige el mapping .*valvulas-de-prueba\.json.*npm run dev:sim/s);
    const opts = opcionesDelEntorno(loadMapping(RUTA_PRUEBA), RUTA_PRUEBA);
    assert.equal(opts.name, 'valvulas-de-prueba');
  });
  await conEntorno({ SIM_SCENARIO: undefined }, () => {
    assert.equal(opcionesDelEntorno(loadMapping(RUTA_PRODUCCION), RUTA_PRODUCCION).name, 'por-defecto');
  });
});

// ── El mapping de prueba jamás llega al PLC real ──────────────────────────────────────

test('un mapping de SIMULACIÓN no pasa la guarda del PLC real; el de producción sí', () => {
  assert.throws(() => asegurarMappingParaPlcReal(loadMapping(RUTA_PRUEBA)), /SIMULACIÓN.*CONNECTIVITY_PROVIDER=opcua/s);
  assert.doesNotThrow(() => asegurarMappingParaPlcReal(loadMapping(RUTA_PRODUCCION)));
});

test('cableado real (ConnectivityModule): CONNECTIVITY_PROVIDER=opcua con el mapping de prueba → el backend NO arranca', async () => {
  await conEntorno({ CONNECTIVITY_PROVIDER: 'opcua', OPC_MAPPING_PATH: RUTA_PRUEBA, SIM_SCENARIO: undefined }, async () => {
    await assert.rejects(Test.createTestingModule({ imports: [ConnectivityModule] }).compile(), /SIMULACIÓN/);
  });
});

test('cableado real (ConnectivityModule): con el simulador, SIM_SCENARIO y su mapping, el adaptador es el simulador con ese escenario', async () => {
  await conEntorno({ CONNECTIVITY_PROVIDER: 'simulator', OPC_MAPPING_PATH: RUTA_PRUEBA, SIM_SCENARIO: 'tres-valvulas-que-no-existe' }, async () => {
    await assert.rejects(Test.createTestingModule({ imports: [ConnectivityModule] }).compile(), /no encontrado/, 'un escenario que no existe no degrada a los defaults');
  });
  await conEntorno({ CONNECTIVITY_PROVIDER: 'simulator', OPC_MAPPING_PATH: RUTA_PRUEBA, SIM_SCENARIO: 'valvulas-de-prueba' }, async () => {
    const mod = await Test.createTestingModule({ imports: [ConnectivityModule] }).compile();
    const adapter = mod.get(CONNECTIVITY_ADAPTER);
    assert.ok(adapter instanceof SimulatorBridgeAdapter);
    const informe = adapter.getSimulationReport();
    assert.equal(informe.scenario.name, 'valvulas-de-prueba');
    assert.equal(informe.valves.length, 9);
    await mod.close();
  });
});

test('los endpoints de diagnóstico del simulador solo se montan con CONNECTIVITY_PROVIDER=simulator', async () => {
  await conEntorno({ CONNECTIVITY_PROVIDER: 'simulator' }, () => assert.deepEqual(SimulatorToolsModule.siElSimuladorEstaActivo(), [SimulatorToolsModule]));
  await conEntorno({ CONNECTIVITY_PROVIDER: 'opcua' }, () => assert.deepEqual(SimulatorToolsModule.siElSimuladorEstaActivo(), []));
  await conEntorno({ CONNECTIVITY_PROVIDER: undefined }, () => assert.deepEqual(SimulatorToolsModule.siElSimuladorEstaActivo(), [], 'sin la variable manda el default (opcua)'));
});
