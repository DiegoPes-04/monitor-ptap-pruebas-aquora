/**
 * Tests del pipeline de dominio (PASO 3): liveness, quality, mapping engine, cache/sequence.
 * Node built-in test runner vía tsx. Sin PLC ni red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LivenessTracker } from '../src/infrastructure/connectivity/pipeline/liveness.tracker';
import { evaluateQuality } from '../src/infrastructure/connectivity/pipeline/quality.evaluator';
import { MappingEngine } from '../src/infrastructure/connectivity/pipeline/mapping.engine';
import { DeadLetterBuffer } from '../src/infrastructure/connectivity/pipeline/dead-letter.buffer';
import { PlantCache } from '../src/infrastructure/connectivity/pipeline/plant-cache';
import { buildSnapshot } from '../src/infrastructure/connectivity/pipeline/snapshot.builder';
import type { LoadedMapping } from '../src/infrastructure/connectivity/mapping/opc-mapping.loader';
import type { RawBufferSample, RawPlantFrame } from '../src/infrastructure/connectivity/ports/connectivity-adapter.port';

function buf(browseName: string, channel: string, values: Array<number | boolean>, sourceTimestamp = new Date().toISOString()): RawBufferSample {
  return { browseName, channel, values, quality: 'Good', statusCode: 'Good', sourceTimestamp, serverTimestamp: sourceTimestamp };
}
function frame(plantId: string, buffers: RawBufferSample[]): RawPlantFrame {
  return { plantId, buffers, receivedAt: new Date().toISOString() };
}

// ── QualityService (PASO 3.5) ────────────────────────────────────────────────

test('quality: Good + en rango + live → usable, sin aviso de rango', () => {
  assert.deepEqual(evaluateQuality({ value: 14.2, quality: 'Good', min: 0, max: 1000, livenessState: 'live' }), {
    usable: true,
    outOfRange: false,
  });
});

test('quality: caudal negativo llega Good y SIGUE siendo usable — solo se marca outOfRange (regla de producto: los límites son para alertar, no para ocultar)', () => {
  const v = evaluateQuality({ value: -5, quality: 'Good', min: 0, max: 1000, livenessState: 'live' });
  assert.equal(v.usable, true);
  assert.equal(v.outOfRange, true);
  assert.equal(v.reason, undefined);
});

test('quality: fuera del máximo → sigue usable, outOfRange=true', () => {
  const v = evaluateQuality({ value: 262144, quality: 'Good', min: 0, max: 1000, livenessState: 'live' });
  assert.equal(v.usable, true);
  assert.equal(v.outOfRange, true);
});

test('quality: NaN/Infinity → INVALID_NUMBER', () => {
  assert.equal(evaluateQuality({ value: NaN, quality: 'Good', min: 0, max: 1000, livenessState: 'live' }).reason, 'INVALID_NUMBER');
  assert.equal(evaluateQuality({ value: Infinity, quality: 'Good', min: 0, max: 1000, livenessState: 'live' }).reason, 'INVALID_NUMBER');
});

test('quality: StatusCode != Good → BAD_QUALITY', () => {
  assert.equal(evaluateQuality({ value: 10, quality: 'Bad', min: 0, max: 1000, livenessState: 'live' }).reason, 'BAD_QUALITY');
});

// DEF-04: una señal estructuralmente rota (índice fuera de rango, buffer ausente) llega con
// value=null; antes salía usable:true, indistinguible de un dato bueno.
test('quality: value=null aun con quality Good → NO usable (INVALID_NUMBER)', () => {
  const v = evaluateQuality({ value: null, quality: 'Good', min: 0, max: 1000, livenessState: 'live' });
  assert.equal(v.usable, false);
  assert.equal(v.reason, 'INVALID_NUMBER');
});

// DEF-03: un `null` por elemento del PLC se convierte en NaN en el adaptador (nunca 0). Aquí se
// verifica la GARANTÍA aguas abajo: un elemento sin dato (NaN) termina NO usable, jamás como 0 real.
test('quality: NaN (lo que produce un null del PLC) → NO usable, nunca un 0 falso', () => {
  const v = evaluateQuality({ value: NaN, quality: 'Good', min: 0, max: 1000, livenessState: 'live' });
  assert.equal(v.usable, false);
  assert.equal(v.reason, 'INVALID_NUMBER');
});

test('quality: liveness frozen → BRIDGE_STALE (perdimos la fuente)', () => {
  assert.equal(evaluateQuality({ value: 10, quality: 'Good', min: 0, max: 1000, livenessState: 'frozen' }).reason, 'BRIDGE_STALE');
});

// El fix de fondo: una planta en régimen estable estaba viendo DESAPARECER sus lecturas.
test('quality: liveness stable NO invalida — proceso quieto es operación normal', () => {
  const v = evaluateQuality({ value: 10, quality: 'Good', min: 0, max: 1000, livenessState: 'stable' });
  assert.equal(v.usable, true);
  assert.equal(v.reason, undefined);
});

// ── LivenessTracker (PASO 3.3) — 3 estados: live / stable / frozen ───────────

test('liveness: sesión sana y sin frames → stable (conectados, aún sin movimiento)', () => {
  const lt = new LivenessTracker(10, 300);
  assert.equal(lt.get('voragine', true).state, 'stable');
});

test('liveness: sin sesión → frozen, pase lo que pase con los valores', () => {
  const lt = new LivenessTracker(10, 300);
  assert.equal(lt.get('voragine', false).state, 'frozen');
  // incluso con un cambio recentísimo: sin fuente viva el dato no está respaldado
  lt.ingest(frame('voragine', [buf('B', 'realIn', [1])]));
  lt.ingest(frame('voragine', [buf('B', 'realIn', [2])]));
  assert.equal(lt.get('voragine', false).state, 'frozen');
});

test('liveness: segundo frame con valor distinto → cambio → live', () => {
  const lt = new LivenessTracker(10, 300);
  lt.ingest(frame('montebello', [buf('REAL_IN_MONTEBELLO', 'realIn', [14.1])]));
  const changed = lt.ingest(frame('montebello', [buf('REAL_IN_MONTEBELLO', 'realIn', [14.2])]));
  assert.equal(changed, true);
  assert.equal(lt.get('montebello', true).state, 'live');
});

// EL CASO QUE MOTIVÓ EL CAMBIO: valores quietos hace rato, pero la sesión responde.
// Antes esto era 'stale' (rojo, "congelado") y además invalidaba las señales.
test('liveness: cambio viejo con sesión sana → stable, NO congelado', () => {
  const lt = new LivenessTracker(10, 300);
  const old = new Date(Date.now() - 60_000).toISOString();
  lt.ingest(frame('m', [buf('B', 'realIn', [1], old)]));
  lt.ingest(frame('m', [buf('B', 'realIn', [2], old)]));
  assert.equal(lt.get('m', true).state, 'stable');

  assert.equal(lt.get('m', false).state, 'frozen', 'perder la sesión congela, pase lo que pase');
});

/**
 * LA CORRECCIÓN DEL 2026-08-15. El cambio anterior quitó el criterio de reloj porque marcaba
 * "congelada" a una planta en régimen estable — legítimo. Pero se pasó de largo: quitó TODA cota
 * superior, y `windowSec` quedó configurado, expuesto en el DTO y sin consultarse en ninguna parte.
 *
 * Consecuencia real: con el puente `Connected`, una planta con datos de 24 DÍAS devolvía `stable`,
 * indistinguible de un tanque quieto 30 segundos. Así pasaron inadvertidas tres plantas muertas en
 * campo y 41 h en las que el propio backend dejó de entregar frames.
 *
 * El equilibrio correcto es la cota LARGA que ya estaba declarada: dentro de `windowSec` es
 * operación normal; pasada la ventana, es un congelamiento y hay que decirlo.
 */
test('liveness: quieto MÁS que la ventana → frozen, aunque la sesión esté sana', () => {
  const lt = new LivenessTracker(10, 300);

  // Dentro de la ventana: proceso quieto, operación normal. NO se toca.
  const dentro = new Date(Date.now() - 60_000).toISOString();
  lt.ingest(frame('m', [buf('B', 'realIn', [1], dentro)]));
  lt.ingest(frame('m', [buf('B', 'realIn', [2], dentro)]));
  assert.equal(lt.get('m', true).state, 'stable', 'un minuto quieto es operación normal');

  // Pasada la ventana: ya no se puede llamar "estable" a esto.
  const fuera = new Date(Date.now() - 400_000).toISOString();
  lt.ingest(frame('m', [buf('B', 'realIn', [3], fuera)]));
  assert.equal(lt.get('m', true).state, 'frozen', 'más que windowSec sin moverse ES un congelamiento');
});

test('liveness: conectados y sin ver NUNCA un cambio → stable al principio, frozen pasada la ventana', () => {
  const lt = new LivenessTracker(10, 300);
  const t0 = Date.now();
  // El arranque merece el beneficio de la duda: la primera muestra de cada buffer no es un cambio.
  assert.equal(lt.get('v', true, t0).state, 'stable');
  // Pero si pasa la ventana entera sin ver moverse nada, no es "acabamos de arrancar".
  assert.equal(lt.get('v', true, t0 + 301_000).state, 'frozen');
});

test('liveness: tras congelarse, un cambio nuevo lo devuelve a live de inmediato', () => {
  const lt = new LivenessTracker(10, 300);
  const viejo = new Date(Date.now() - 400_000).toISOString();
  lt.ingest(frame('m', [buf('B', 'realIn', [1], viejo)]));
  lt.ingest(frame('m', [buf('B', 'realIn', [2], viejo)]));
  assert.equal(lt.get('m', true).state, 'frozen');

  // La señal vuelve: debe alzarse en el acto, sin esperas ni histéresis.
  lt.ingest(frame('m', [buf('B', 'realIn', [3], new Date().toISOString())]));
  assert.equal(lt.get('m', true).state, 'live', 'apenas vuelve el dato, la planta vuelve a estar viva');
});

/**
 * Planta dada de alta SIN un solo buffer de datos: Cabuyo, La Luisa, La Leonera y Gloria desde el
 * 2026-10-19, que aún no están en el PLC maestro. El beneficio de la duda del arranque es para buffers
 * que todavía no entregaron su segunda muestra; aquí no va a llegar ninguno. Concederlo pintaba
 * ESTABLE —y «Sistema operativo, enviando datos» en la vista Civil— los primeros 5 min de cada
 * arranque, de una planta que no está en el PLC.
 */
test('liveness: planta SIN buffers de datos → frozen desde el arranque, nunca stable', () => {
  const lt = new LivenessTracker(10, 300);
  const t0 = Date.now();
  lt.configurePlant('cabuyo', null, false);
  assert.equal(lt.get('cabuyo', true, t0).state, 'frozen', 'no hay ningún buffer cuya llegada esperar');
  assert.equal(lt.get('cabuyo', true, t0 + 301_000).state, 'frozen');
  assert.equal(lt.get('cabuyo', false, t0).state, 'frozen');
  assert.equal(lt.get('cabuyo', true, t0).windowSec, 300, 'la ventana sigue siendo la de siempre');
});

test('liveness: con buffers (el default de configurePlant) se conserva el beneficio de la duda del arranque', () => {
  const lt = new LivenessTracker(10, 300);
  const t0 = Date.now();
  lt.configurePlant('voragine', null);
  lt.configurePlant('soledad', 120, true);
  assert.equal(lt.get('voragine', true, t0).state, 'stable');
  assert.equal(lt.get('soledad', true, t0).state, 'stable');
  assert.equal(lt.get('soledad', true, t0).windowSec, 120);
});

test('liveness: si a una planta declarada sin buffers le llega un frame, manda la regla normal', () => {
  // «Sin buffers» es lo que dice el mapping; un frame real dice otra cosa, y el dato gana.
  const lt = new LivenessTracker(10, 300);
  lt.configurePlant('leonera', null, false);
  lt.ingest(frame('leonera', [buf('B', 'realIn', [1])]));
  assert.equal(lt.get('leonera', true).state, 'stable', 'primera muestra: sin delta, beneficio de la duda');
  lt.ingest(frame('leonera', [buf('B', 'realIn', [2])]));
  assert.equal(lt.get('leonera', true).state, 'live');
});

// ── MappingEngine (PASO 3.4) ─────────────────────────────────────────────────

function montebelloMapping(): LoadedMapping {
  return {
    version: '0.3.0', protocolVersion: 'v2', dtoVersion: 'v1',
    plants: [{ plantId: 'montebello', displayName: 'Montebello', livenessWindowSec: null }],
    targets: [],
    signals: [
      { plantId: 'montebello', buffer: 'realIn', index: 0, domainKey: 'inletFlow1', label: 'Caudal 1', unit: 'l/s', min: 0, max: 1000, mappingStatus: 'mapped', confidence: 'inferred', writable: false },
      { plantId: 'montebello', buffer: 'realIn', index: 5, domainKey: 'inletFlow2', label: 'Caudal 2', unit: 'l/s', min: 0, max: 1000, mappingStatus: 'mapped', confidence: 'inferred', writable: false },
    ],
    raw: {},
  };
}

// `stateEncoding` es estático del mapping y solo sirve si llega ENTERO hasta el DTO: el front
// decide con él si la válvula está cerrada. Se prueba el recorrido completo (mapping → engine →
// snapshot) porque el fallo típico aquí es calcularlo y olvidar copiarlo al DTO — ya pasó con
// `outOfRange` (fcfc2af).
test('mapping: stateEncoding viaja del mapping al DTO (Cascajal: 251 = cerrada)', () => {
  const mapping: LoadedMapping = {
    version: '0.3.0', protocolVersion: 'v2', dtoVersion: 'v1',
    plants: [{ plantId: 'cascajal', displayName: 'Cascajal', livenessWindowSec: null }],
    targets: [],
    signals: [
      { plantId: 'cascajal', buffer: 'intIn', sourceBuffer: 'INT_IN_CASCAJAL', index: 1, domainKey: 'valve1State', label: 'Estado válvula 1', unit: null, min: null, max: null, mappingStatus: 'mapped', confidence: 'confirmed', writable: false, stateEncoding: { closed: 251 } },
    ],
    raw: {},
  };
  const dl = new DeadLetterBuffer();
  const latest = new Map<string, RawBufferSample>();
  latest.set('INT_IN_CASCAJAL', buf('INT_IN_CASCAJAL', 'intIn', [7826, 251, 0]));

  const extracted = new MappingEngine(mapping).extract('cascajal', latest, dl);
  assert.deepEqual(extracted[0]?.stateEncoding, { closed: 251 }, 'el engine debe conservarlo');

  const snapshot = buildSnapshot({
    plantId: 'cascajal', displayName: 'Cascajal', protocolVersion: 'v2', dtoVersion: 'v1',
    sequence: 1, bridgeStatus: 'Connected',
    liveness: { state: 'live', lastChangeAt: null, windowSec: 300 },
    extracted, deadLetter: dl,
  });
  assert.equal(snapshot.signals.valve1State?.value, 251);
  assert.deepEqual(snapshot.signals.valve1State?.stateEncoding, { closed: 251 }, 'y el DTO también');
});

test('mapping: una señal sin stateEncoding no lo inventa en el DTO', () => {
  const engine = new MappingEngine(montebelloMapping());
  const dl = new DeadLetterBuffer();
  const latest = new Map<string, RawBufferSample>();
  latest.set('REAL_IN_MONTEBELLO', buf('REAL_IN_MONTEBELLO', 'realIn', Array.from({ length: 50 }, (_, i) => i)));
  const snapshot = buildSnapshot({
    plantId: 'montebello', displayName: 'Montebello', protocolVersion: 'v2', dtoVersion: 'v1',
    sequence: 1, bridgeStatus: 'Connected',
    liveness: { state: 'live', lastChangeAt: null, windowSec: 300 },
    extracted: engine.extract('montebello', latest, dl), deadLetter: dl,
  });
  assert.equal('stateEncoding' in (snapshot.signals.inletFlow1 ?? {}), false);
});

test('mapping: extrae realIn[0]→inletFlow1 y realIn[5]→inletFlow2 del buffer primario', () => {
  const engine = new MappingEngine(montebelloMapping());
  const dl = new DeadLetterBuffer();
  const latest = new Map<string, RawBufferSample>();
  // buffer primario (50 elementos) + un buffer de tanque (10 elementos) del mismo canal
  latest.set('REAL_IN_MONTEBELLO', buf('REAL_IN_MONTEBELLO', 'realIn', Array.from({ length: 50 }, (_, i) => i)));
  latest.set('REAL_IN_TK1_MONTEBELLO', buf('REAL_IN_TK1_MONTEBELLO', 'realIn', Array.from({ length: 10 }, () => 99)));
  const ex = engine.extract('montebello', latest, dl);
  const f1 = ex.find((e) => e.domainKey === 'inletFlow1');
  const f5 = ex.find((e) => e.domainKey === 'inletFlow2');
  assert.equal(f1?.value, 0); // primario[0], no el tanque
  assert.equal(f5?.value, 5); // primario[5]
  assert.equal(dl.snapshot().total, 0);
});

// DEF-04 (capa 2): un índice fuera del array real → quality:'Bad' (no la del buffer), para que
// aguas abajo salga BAD_QUALITY y nunca usable:true con value:null.
test('mapping: índice fuera de rango → value:null Y quality:Bad (señal rota)', () => {
  const mapping: LoadedMapping = {
    version: '0.9.0', protocolVersion: 'v2', dtoVersion: 'v1',
    plants: [{ plantId: 'montebello', displayName: 'Montebello', livenessWindowSec: null }],
    targets: [],
    signals: [
      { plantId: 'montebello', buffer: 'realIn', sourceBuffer: 'REAL_IN_MONTEBELLO', index: 40, domainKey: 'x', label: null, unit: null, min: null, max: null, mappingStatus: 'mapped', confidence: 'inferred', writable: false },
    ],
    raw: {},
  };
  const engine = new MappingEngine(mapping);
  const dl = new DeadLetterBuffer();
  const latest = new Map<string, RawBufferSample>();
  // llega un buffer más corto (10) de lo que el mapping direcciona (índice 40)
  latest.set('REAL_IN_MONTEBELLO', buf('REAL_IN_MONTEBELLO', 'realIn', Array.from({ length: 10 }, (_, i) => i)));
  const ex = engine.extract('montebello', latest, dl);
  assert.equal(ex[0].value, null);
  assert.equal(ex[0].quality, 'Bad', 'una señal con índice fuera de rango NO puede heredar quality Good del buffer');
  // y por tanto NO es usable
  assert.equal(evaluateQuality({ value: ex[0].value, quality: ex[0].quality, min: null, max: null, livenessState: 'live' }).usable, false);
  assert.equal(dl.snapshot().total, 1);
});

test('mapping: sourceBuffer explícito gana sobre el empate de tamaño del canal', () => {
  const mapping: LoadedMapping = {
    version: '0.8.0', protocolVersion: 'v2', dtoVersion: 'v1',
    plants: [{ plantId: 'soledad', displayName: 'Soledad', livenessWindowSec: null }],
    targets: [],
    signals: [
      { plantId: 'soledad', buffer: 'realIn', sourceBuffer: 'REAL_IN_SOLEDAD', index: 0, domainKey: 'inletFlow1', label: 'Caudal de entrada', unit: 'l/s', min: 0, max: 1000, mappingStatus: 'mapped', confidence: 'inferred', writable: false },
    ],
    raw: {},
  };
  const engine = new MappingEngine(mapping);
  const dl = new DeadLetterBuffer();
  const latest = new Map<string, RawBufferSample>();
  // dos buffers realIn del MISMO tamaño: sin sourceBuffer la elección sería no determinista
  latest.set('DATOS_IN_PTAP_SOLEDAD', buf('DATOS_IN_PTAP_SOLEDAD', 'realIn', Array.from({ length: 50 }, () => -1)));
  latest.set('REAL_IN_SOLEDAD', buf('REAL_IN_SOLEDAD', 'realIn', Array.from({ length: 50 }, (_, i) => i + 100)));
  const ex = engine.extract('soledad', latest, dl);
  assert.equal(ex[0].value, 100); // REAL_IN_SOLEDAD[0], no DATOS_IN_PTAP_SOLEDAD[0]
  assert.equal(dl.snapshot().total, 0);
});

test('mapping: sourceBuffer ausente en runtime → dead-letter BUFFER_MISSING', () => {
  const mapping: LoadedMapping = {
    version: '0.8.0', protocolVersion: 'v2', dtoVersion: 'v1',
    plants: [{ plantId: 'soledad', displayName: 'Soledad', livenessWindowSec: null }],
    targets: [],
    signals: [
      { plantId: 'soledad', buffer: 'realIn', sourceBuffer: 'REAL_IN_SOLEDAD', index: 0, domainKey: 'inletFlow1', label: null, unit: null, min: null, max: null, mappingStatus: 'mapped', confidence: 'inferred', writable: false },
    ],
    raw: {},
  };
  const engine = new MappingEngine(mapping);
  const dl = new DeadLetterBuffer();
  const latest = new Map<string, RawBufferSample>();
  // llegó OTRO buffer del canal, pero no el declarado: NO debe usarse como sustituto
  latest.set('DATOS_IN_PTAP_SOLEDAD', buf('DATOS_IN_PTAP_SOLEDAD', 'realIn', Array.from({ length: 50 }, () => -1)));
  const ex = engine.extract('soledad', latest, dl);
  assert.equal(ex[0].value, null);
  assert.ok(dl.snapshot().counts.BUFFER_MISSING >= 1);
});

test('mapping: buffer ausente → dead-letter BUFFER_MISSING', () => {
  const engine = new MappingEngine(montebelloMapping());
  const dl = new DeadLetterBuffer();
  engine.extract('montebello', new Map(), dl); // sin buffers
  assert.ok(dl.snapshot().counts.BUFFER_MISSING >= 1);
});

test('mapping: índice fuera de rango → dead-letter INDEX_OUT_OF_RANGE', () => {
  const engine = new MappingEngine(montebelloMapping());
  const dl = new DeadLetterBuffer();
  const latest = new Map<string, RawBufferSample>();
  latest.set('REAL_IN_MONTEBELLO', buf('REAL_IN_MONTEBELLO', 'realIn', [14.1, 170466])); // solo 2 elementos; idx 5 no existe
  engine.extract('montebello', latest, dl);
  assert.ok(dl.snapshot().counts.INDEX_OUT_OF_RANGE >= 1);
});

// ── PlantCache / sequence (PASO 3.2) ─────────────────────────────────────────

test('cache: sequence monótono por planta, independiente entre plantas', () => {
  const cache = new PlantCache();
  assert.equal(cache.nextSequence('montebello'), 1);
  assert.equal(cache.nextSequence('montebello'), 2);
  assert.equal(cache.nextSequence('montebello'), 3);
  assert.equal(cache.nextSequence('soledad'), 1); // contador propio
  assert.equal(cache.nextSequence('montebello'), 4);
});

test('cache: solo se lee lo que se escribió', () => {
  const cache = new PlantCache();
  assert.equal(cache.get('montebello'), null);
});

test('dead-letter: el ring respeta el tope, pero los CONTADORES no se pierden (regla 12)', () => {
  const dl = new DeadLetterBuffer(3);
  for (let i = 0; i < 10; i++) dl.record('INVALID_NUMBER', 'voragine', `k${i}`, `detalle ${i}`);

  const snap = dl.snapshot();
  // El detalle está acotado a 3 entradas...
  assert.equal(snap.recent.length, 3);
  // ...y son las 3 ÚLTIMAS (se descarta lo viejo, no lo nuevo).
  assert.deepEqual(
    snap.recent.map((e) => e.domainKey),
    ['k7', 'k8', 'k9'],
  );
  // ...pero el contador vio las 10: acotar la memoria no puede falsear la cuenta.
  assert.equal(snap.counts.INVALID_NUMBER, 10);
  assert.equal(snap.total, 10);
});

test('dead-letter: capacidad inválida → lanza (nunca un ring que se traga todo en silencio)', () => {
  assert.throws(() => new DeadLetterBuffer(0), /capacity/);
  assert.throws(() => new DeadLetterBuffer(-1), /capacity/);
});

// ── FASE 1: los verbos de la válvula viajan al DTO ───────────────────────────────────────────
//
// `commands` es estático del mapping y solo sirve si llega ENTERO hasta el DTO, igual que
// `stateEncoding`: el front decide con él si ofrece "cerrar". El fallo típico es calcularlo y
// olvidar copiarlo, así que se prueba el recorrido completo (mapping → engine → snapshot).
//
// Lo que protege: hoy solo Vorágine y Sirena declaran `close`. En las otras ocho un "cerrar"
// llegaría al backend para volver con UNKNOWN_COMMAND tras hacer confirmar la maniobra.

/** WriteSpec mínimo válido; `commands` es lo único que varía entre los casos. */
function writeSpec(commands: Record<string, number>) {
  return {
    target: { channel: 'intOut', sourceBuffer: 'INT_OUT_T', index: 0 },
    commands,
    mode: 'bitmask' as const,
    pulse: { holdMs: 300 },
    readBack: { channel: 'intIn', sourceBuffer: 'INT_IN_T', index: 0, confirmsWrittenValue: false, stateVerified: false },
    timeoutMs: 5000,
    rollbackValue: 0,
    permission: 'control_valves',
  };
}

function mappingConVerbos(plantId: string, commands: Record<string, number>): LoadedMapping {
  return {
    version: '0.3.0', protocolVersion: 'v2', dtoVersion: 'v1',
    plants: [{ plantId, displayName: plantId, livenessWindowSec: null }],
    targets: [],
    signals: [
      { plantId, buffer: 'intOut', sourceBuffer: 'INT_OUT_T', index: 0, domainKey: 'valve1', label: 'Válvula 1', unit: null, min: null, max: null, mappingStatus: 'mapped', confidence: 'confirmed', writable: true, write: writeSpec(commands) },
      { plantId, buffer: 'realIn', index: 0, domainKey: 'outletFlow1', label: 'Caudal', unit: 'l/s', min: 0, max: 1000, mappingStatus: 'mapped', confidence: 'confirmed', writable: false },
    ],
    raw: {},
  };
}

function snapshotDe(mapping: LoadedMapping, plantId: string) {
  const dl = new DeadLetterBuffer();
  const latest = new Map<string, RawBufferSample>();
  latest.set('INT_OUT_T', buf('INT_OUT_T', 'intOut', [0, 0, 0]));
  latest.set('REAL_IN_T', buf('REAL_IN_T', 'realIn', [12.5, 0, 0]));
  const extracted = new MappingEngine(mapping).extract(plantId, latest, dl);
  return {
    extracted,
    snapshot: buildSnapshot({
      plantId, displayName: plantId, protocolVersion: 'v2', dtoVersion: 'v1',
      sequence: 1, bridgeStatus: 'Connected',
      liveness: { state: 'live', lastChangeAt: null, windowSec: 300 },
      extracted, deadLetter: dl,
    }),
  };
}

test('valvulas: una planta con open y close publica AMBOS verbos en el DTO (Voragine/Sirena)', () => {
  const { extracted, snapshot } = snapshotDe(mappingConVerbos('voragine', { open: 4096, close: 8192 }), 'voragine');
  assert.deepEqual(extracted.find((e) => e.domainKey === 'valve1')?.commands, ['open', 'close'], 'el engine debe leerlos del write spec');
  assert.deepEqual(snapshot.signals.valve1?.commands, ['open', 'close'], 'y el DTO también');
});

test('valvulas: una planta que solo declara open NO publica close (las otras ocho)', () => {
  const { snapshot } = snapshotDe(mappingConVerbos('cascajal', { open: 4096 }), 'cascajal');
  assert.deepEqual(snapshot.signals.valve1?.commands, ['open']);
  assert.equal(snapshot.signals.valve1?.commands?.includes('close'), false, 'ofrecer cerrar aquí devolvería UNKNOWN_COMMAND');
});

test('valvulas: una señal que NO es válvula no lleva el campo commands', () => {
  const { snapshot } = snapshotDe(mappingConVerbos('cascajal', { open: 4096 }), 'cascajal');
  assert.equal('commands' in (snapshot.signals.outletFlow1 ?? {}), false, 'el DTO viaja en cada barrido: no se pagan bytes sin significado');
});
