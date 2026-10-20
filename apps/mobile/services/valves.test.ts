/**
 * Tests de la derivación de electroválvulas desde el snapshot real (services/valves.ts).
 * Cubre los DOS métodos de estado acordados con el operador (2026-07-30):
 *   1. `valve1State` = palabra de bits del PLC (bit14 válido, bit0 abierta) → 16384 cerrada / 16385 abierta.
 *   2. Caudal: <= 0.1 cerrada, > 0.1 abierta.
 * Y lo importante: que NO se elija uno en silencio cuando discrepan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  valvesFromSnapshot,
  isValveSignal,
  FLOW_CLOSED_THRESHOLD,
  POSITION_CLOSED_THRESHOLD_PCT,
  interpretCommand,
  detectManual,
  accionDisponible,
  vigilaOperacionManual,
  textoApertura,
  anchoBarraApertura,
} from './valves';
import type { PlantSnapshotDto, SignalDto, ValveCommandResult } from './api';

function sig(value: number | null, over: Partial<SignalDto> = {}): SignalDto {
  return {
    value,
    unit: 'l/s',
    quality: 'Good',
    usable: value !== null,
    mappingStatus: 'mapped',
    confidence: 'inferred',
    label: null,
    ts: '2026-07-30T12:00:00.000Z',
    ...over,
  } as SignalDto;
}

function snap(signals: Record<string, SignalDto>): PlantSnapshotDto {
  return {
    plantId: 'sirena',
    displayName: 'La Sirena',
    sequence: 1,
    protocolVersion: 'v2',
    dtoVersion: 'v1',
    bridgeStatus: 'Connected',
    liveness: { state: 'live', lastChangeAt: null, windowSec: 300 },
    signals,
  } as PlantSnapshotDto;
}

test('valves: sin señal de válvula → lista vacía (nada de mocks)', () => {
  assert.deepEqual(valvesFromSnapshot(snap({ inletFlow1: sig(5) })), []);
  assert.deepEqual(valvesFromSnapshot(undefined), []);
});

// ── Método 1: palabra de estado del PLC ──
test('valves: método 1 — 16384 (bit14) → CERRADA', () => {
  const v = valvesFromSnapshot(snap({ valve1: sig(0), valve1State: sig(16384) }))[0];
  assert.equal(v.byState, 'closed');
  assert.equal(v.state, 'closed');
  assert.equal(v.source, 'estado');
  assert.equal(v.rawState, 16384);
});

test('valves: método 1 — 16385 (bit14+bit0) → ABIERTA', () => {
  const v = valvesFromSnapshot(snap({ valve1: sig(0), valve1State: sig(16385) }))[0];
  assert.equal(v.byState, 'open');
  assert.equal(v.state, 'open');
});

// ── Método 1b: convención de valores LITERALES (stateEncoding) ──
// Cascajal no usa la máscara de bits: reporta 251 = CERRADA en INT_IN[1], verificado en campo
// (2026-08-13). Sin esta convención el valor no trae bit14 y la planta se quedaba sin estado.
test('valves: stateEncoding — 251 declarado como cerrada → CERRADA (aunque no tenga bit14)', () => {
  const v = valvesFromSnapshot(
    snap({ valve1: sig(0), valve1State: sig(251, { stateEncoding: { closed: 251 } }) }),
  )[0];
  assert.equal(v.byState, 'closed');
  assert.equal(v.state, 'closed');
  assert.equal(v.source, 'estado');
});

test('valves: stateEncoding — un valor NO declarado no se interpreta (no cae a la regla de bits)', () => {
  // 16385 tiene bit14+bit0 → la regla de bits diría "abierta". Pero el sitio declaró su propia
  // convención, y mezclarlas es exactamente como se inventaron estados falsos antes.
  const v = valvesFromSnapshot(
    snap({ valve1: sig(0), valve1State: sig(16385, { stateEncoding: { closed: 251 } }) }),
  )[0];
  assert.equal(v.byState, null, 'no se afirma nada con un valor ajeno a la convención declarada');
});

test('valves: stateEncoding — también sirve para declarar el valor de abierta', () => {
  const enc = { stateEncoding: { closed: 251, open: 1056 } };
  assert.equal(valvesFromSnapshot(snap({ valve1: sig(0), valve1State: sig(1056, enc) }))[0].byState, 'open');
  assert.equal(valvesFromSnapshot(snap({ valve1: sig(0), valve1State: sig(251, enc) }))[0].byState, 'closed');
});

test('valves: sin stateEncoding se conserva la regla de bits de siempre', () => {
  assert.equal(valvesFromSnapshot(snap({ valve1: sig(0), valve1State: sig(16384) }))[0].byState, 'closed');
  assert.equal(valvesFromSnapshot(snap({ valve1: sig(0), valve1State: sig(251) }))[0].byState, null);
});

test('valves: método 1 — sin bit14 el PLC no reporta estado válido → no se afirma nada', () => {
  const v = valvesFromSnapshot(snap({ valve1: sig(0), valve1State: sig(1) }))[0];
  assert.equal(v.byState, null, 'sin bit de validez no se puede decidir');
});

// ── Método 2: caudal ──
test('valves: método 2 — caudal <= 0.1 → CERRADA; por encima → ABIERTA', () => {
  const cerrada = valvesFromSnapshot(snap({ valve1: sig(0), outletFlow1: sig(FLOW_CLOSED_THRESHOLD) }))[0];
  assert.equal(cerrada.byFlow, 'closed');
  assert.equal(cerrada.source, 'caudal', 'sin palabra de estado, el veredicto sale del caudal');

  const abierta = valvesFromSnapshot(snap({ valve1: sig(0), outletFlow1: sig(0.11) }))[0];
  assert.equal(abierta.byFlow, 'open');
});

test('valves: método 2 usa la SALIDA si existe, y cae a la entrada si no', () => {
  const conSalida = valvesFromSnapshot(snap({ valve1: sig(0), inletFlow1: sig(9), outletFlow1: sig(0.05) }))[0];
  assert.equal(conSalida.byFlow, 'closed', 'debe mandar el caudal de salida');
  const soloEntrada = valvesFromSnapshot(snap({ valve1: sig(0), inletFlow1: sig(9) }))[0];
  assert.equal(soloEntrada.byFlow, 'open');
});

// ── Cruce de los dos métodos ──
test('valves: el método 1 MANDA sobre el 2 cuando ambos existen', () => {
  const v = valvesFromSnapshot(snap({ valve1: sig(0), valve1State: sig(16385), outletFlow1: sig(0) }))[0];
  assert.equal(v.state, 'open', 'la lectura del equipo tiene prioridad');
  assert.equal(v.source, 'estado');
});

test('valves: si los dos métodos DISCREPAN se marca (no se oculta)', () => {
  const v = valvesFromSnapshot(snap({ valve1: sig(0), valve1State: sig(16385), outletFlow1: sig(0) }))[0];
  assert.equal(v.byState, 'open');
  assert.equal(v.byFlow, 'closed');
  assert.equal(v.disagreement, true, 'estado abierta + caudal 0 es una inconsistencia que hay que avisar');
});

test('valves: si coinciden, no hay discrepancia', () => {
  const v = valvesFromSnapshot(snap({ valve1: sig(0), valve1State: sig(16384), outletFlow1: sig(0) }))[0];
  assert.equal(v.disagreement, false);
});

test('valves: sin estado ni caudal → unknown y se dice que no hay fuente', () => {
  const v = valvesFromSnapshot(snap({ valve1: sig(0) }))[0];
  assert.equal(v.state, 'unknown');
  assert.equal(v.source, 'ninguno');
});

test('valves: una señal no usable no se toma como lectura válida', () => {
  const v = valvesFromSnapshot(snap({ valve1: sig(0), valve1State: sig(16385, { usable: false }) }))[0];
  assert.equal(v.byState, null);
});

test('valves: varias válvulas se ordenan por número', () => {
  const vs = valvesFromSnapshot(
    snap({ valve2: sig(0), valve1: sig(0), valve2State: sig(16385), valve1State: sig(16384) }),
  );
  assert.deepEqual(vs.map((v) => v.id), ['valve1', 'valve2']);
  assert.equal(vs[1].state, 'open');
});

test('valves: isValveSignal reconoce comando y estado (para no duplicar en el tablero)', () => {
  assert.equal(isValveSignal('valve1'), true);
  assert.equal(isValveSignal('valve1State'), true);
  assert.equal(isValveSignal('inletFlow1'), false);
});

// ── Interpretación del resultado de un comando ──
// Lo crítico: distinguir "la señal salió" de "el equipo respondió". Un 502 con eco verificado NO es
// "no funcionó" — es "salió y el equipo no acusó el cambio" (probable falla física).
function res(over: Partial<ValveCommandResult>): ValveCommandResult {
  return {
    http: 200, status: 'confirmed', reason: null, previousValue: 0, writtenValue: 4096,
    confirmedValue: 16385, writeEcho: 4096, writeVerified: true, ...over,
  };
}

test('interpretCommand: confirmado → ok y señal enviada', () => {
  const v = interpretCommand(res({}), 'open', 'Válvula 1');
  assert.equal(v.ok, true);
  assert.equal(v.signalSent, true);
});

test('interpretCommand: 502 con eco verificado → la señal SÍ salió, avisa de posible falla física', () => {
  const v = interpretCommand(
    res({ http: 502, status: 'failed', reason: 'READBACK_UNCONFIRMED', confirmedValue: 16384, writeVerified: true }),
    'open',
    'Válvula 1',
  );
  assert.equal(v.ok, false, 'no se puede afirmar que la válvula se movió');
  assert.equal(v.signalSent, true, 'pero la orden salió: eso NO es un fallo del canal');
  assert.match(v.message, /trabada o sin energía/, 'se dice la causa probable en cristiano');
  assert.equal(v.tone, 'danger');
  assert.match(String(v.technical), /verificado/, 'el detalle técnico existe, pero fuera de la frase');
});

test('interpretCommand: WRITE_REJECTED → la señal NO salió', () => {
  const v = interpretCommand(res({ http: 502, status: 'failed', reason: 'WRITE_REJECTED', writeVerified: null, writtenValue: null }), 'close', 'Válvula 1');
  assert.equal(v.signalSent, false);
  assert.match(v.message, /RECHAZÓ/);
});

test('interpretCommand: interlock y permisos se explican sin culpar al equipo', () => {
  const il = interpretCommand(res({ http: 409, status: 'rejected', reason: 'INTERLOCK_FAILED: snapshot frozen' }), 'open', 'V1');
  assert.equal(il.signalSent, false);
  assert.match(il.title, /dato fresco/i, 'sin la palabra «enclavamiento», que no está en el vocabulario de nadie');
  assert.equal(il.technical, 'INTERLOCK_FAILED: snapshot frozen', 'el código va aparte, para reportarlo');
  assert.doesNotMatch(il.message, /INTERLOCK_FAILED/, 'y NUNCA dentro de la frase');
  const fb = interpretCommand(res({ http: 403, status: 'rejected', reason: 'FORBIDDEN' }), 'open', 'V1');
  assert.match(fb.title, /permiso/i);
});

test('interpretCommand: fallo de red NO afirma que la orden salió', () => {
  const v = interpretCommand(res({ http: 0, status: 'error', reason: 'NETWORK' }), 'close', 'V1');
  assert.equal(v.ok, false);
  assert.equal(v.signalSent, false);
});

// ── Detección de operación manual ──
test('detectManual: el caudal cruza el umbral y el PLC no reporta nada → MANUAL', () => {
  assert.equal(detectManual('closed', 'open', 'closed', 'closed', false), 'opened');
  assert.equal(detectManual('open', 'closed', 'open', 'open', false), 'closed');
});

test('detectManual: si NOSOTROS mandamos la orden hace poco, no es manual', () => {
  assert.equal(detectManual('closed', 'open', 'closed', 'closed', true), null);
});

test('detectManual: si el PLC SÍ reportó el cambio, fue eléctrico (no manual)', () => {
  assert.equal(detectManual('closed', 'open', 'closed', 'open', false), null);
});

test('detectManual: sin cambio de lado del caudal no hay evento', () => {
  assert.equal(detectManual('open', 'open', 'open', 'open', false), null);
  assert.equal(detectManual(null, 'open', null, null, false), null, 'sin lectura previa no se juzga');
});

// ── Qué caudal corresponde a cada válvula ────────────────────────────────────
// El orden por defecto (salida, luego entrada) es una SUPOSICIÓN: acierta o falla según dónde esté
// físicamente la válvula. Declararlo en el mapping convierte un dato de campo en configuración.
// La Sirena declara `outletFlow1`: su única válvula es la de SALIDA (operador, 2026-08-15).
test('valves: si el mapping declara flowDomainKey, ese caudal MANDA sobre la preferencia', () => {
  const v = valvesFromSnapshot(
    snap({
      valve1: sig(0, { flowDomainKey: 'inletFlow1' }),
      inletFlow1: sig(23.3),
      outletFlow1: sig(0), // la preferencia por defecto diría CERRADA; lo declarado dice ABIERTA
    }),
  )[0];
  assert.equal(v.byFlow, 'open');
  assert.equal(v.state, 'open');
});

test('valves: elegir el caudal equivocado miente — válvula de SALIDA con la entrada llenando', () => {
  // El caso real que protege esto: la válvula de salida está cerrada y la entrada sigue llenando
  // el tanque. Mirar la entrada diría ABIERTA con la válvula cerrada.
  const v = valvesFromSnapshot(
    snap({ valve1: sig(0, { flowDomainKey: 'outletFlow1' }), inletFlow1: sig(23.3), outletFlow1: sig(0) }),
  )[0];
  assert.equal(v.byFlow, 'closed');
});

test('valves: sin flowDomainKey se conserva la preferencia de siempre (salida primero)', () => {
  const v = valvesFromSnapshot(snap({ valve1: sig(0), inletFlow1: sig(0), outletFlow1: sig(19.6) }))[0];
  assert.equal(v.byFlow, 'open', 'sin declaración explícita manda el caudal de salida');
});

test('valves: cada válvula resuelve SU caudal por separado', () => {
  const v = valvesFromSnapshot(
    snap({
      valve1: sig(0, { flowDomainKey: 'inletFlow1' }),
      valve2: sig(0), // esta usa la preferencia por defecto
      inletFlow1: sig(20),
      outletFlow1: sig(0),
    }),
  );
  assert.equal(v[0].byFlow, 'open', 'valve1 mira la entrada');
  assert.equal(v[1].byFlow, 'closed', 'valve2 cae a la salida, que está en 0');
});

// El caso REAL que reportó el cliente: la app decía CERRADA con 23,33 l/s entrando.
test('valves: con la palabra declarada no fiable, el veredicto lo da el caudal (caso Sirena)', () => {
  // El caso REAL que reportó el cliente: la app decía CERRADA con el agua pasando.
  const v = valvesFromSnapshot(
    snap({
      valve1: sig(0, { flowDomainKey: 'outletFlow1' }),
      valve1State: sig(17408, { stateTrusted: false }),
      outletFlow1: sig(19.66),
    }),
  )[0];
  assert.equal(v.byState, null, 'su palabra no está verificada: no puede decidir');
  assert.equal(v.state, 'open');
  assert.equal(v.source, 'caudal');
});

// La Sirena: su INT_IN[0] paso de 16384 a 17408 con 23,33 l/s entrando, y ninguna convencion
// conocida lo explica. Se conserva MAPEADO como diagnostico (rawState sigue visible) pero se
// declara no fiable, para que el veredicto lo de el caudal — que es evidencia fisica.
test('valves: stateTrusted:false → la palabra NO decide, pero se sigue viendo como diagnóstico', () => {
  const v = valvesFromSnapshot(
    snap({
      valve1: sig(0, { flowDomainKey: 'inletFlow1' }),
      valve1State: sig(17408, { stateTrusted: false }),
      inletFlow1: sig(23.33),
    }),
  )[0];
  assert.equal(v.byState, null, 'no se afirma nada desde un registro declarado no fiable');
  assert.equal(v.rawState, 17408, 'pero el valor crudo SIGUE disponible para diagnosticar');
  assert.equal(v.state, 'open', 'manda el caudal de entrada');
  assert.equal(v.source, 'caudal');
});

test('valves: stateTrusted:false no marca discrepancia (no hay dos veredictos que comparar)', () => {
  const v = valvesFromSnapshot(
    snap({ valve1: sig(0), valve1State: sig(16384, { stateTrusted: false }), outletFlow1: sig(19.6) }),
  )[0];
  assert.equal(v.disagreement, false, 'la palabra no opina, asi que no puede contradecir al caudal');
});

test('valves: sin stateTrusted la palabra sigue mandando (las demás plantas no cambian)', () => {
  const v = valvesFromSnapshot(snap({ valve1: sig(0), valve1State: sig(16384), outletFlow1: sig(19.6) }))[0];
  assert.equal(v.byState, 'closed');
  assert.equal(v.source, 'estado');
});

// ── Dos válvulas en una planta (La Vorágine, 2026-08-15) ────────────────────────────────────
//
// Salida accionable con su caudal de salida; entrada sin canal de mando, juzgada por el de entrada.
// El caso que estos tests protegen es el de los caudales cruzados: si cada válvula no declara el
// suyo, el orden por defecto prefiere la salida y las DOS se juzgarían con el mismo dato.

const DOS_VALVULAS = {
  valve1: sig(0, { label: 'Válvula de salida', flowDomainKey: 'outletFlow1' }),
  valve2: sig(0, { label: 'Válvula de entrada', flowDomainKey: 'inletFlow1', commandable: false }),
  outletFlow1: sig(1.61),
  inletFlow1: sig(6.93),
};

test('valves: una planta con dos válvulas devuelve las dos, ordenadas y con su nombre', () => {
  const v = valvesFromSnapshot(snap(DOS_VALVULAS));
  assert.equal(v.length, 2);
  assert.deepEqual(v.map((x) => x.id), ['valve1', 'valve2']);
  assert.deepEqual(v.map((x) => x.name), ['Válvula de salida', 'Válvula de entrada']);
});

test('valves: cada válvula se juzga con SU caudal, no con el de la otra', () => {
  const [salida, entrada] = valvesFromSnapshot(snap(DOS_VALVULAS));
  assert.equal(salida.flowValue, 1.61);
  assert.equal(entrada.flowValue, 6.93);
  assert.equal(salida.source, 'caudal');
  assert.equal(entrada.source, 'caudal');
});

// Lo que de verdad importa de este caso: una válvula de ENTRADA cerrada mientras el tanque se vacía
// aguas abajo. Hay caudal en el lado que no manda, y sin `flowDomainKey` se afirmaría "abierta".
test('valves: la de entrada CERRADA no se contagia del caudal de salida', () => {
  const [, entrada] = valvesFromSnapshot(
    snap({ ...DOS_VALVULAS, inletFlow1: sig(0), outletFlow1: sig(12.4) }),
  );
  assert.equal(entrada.state, 'closed', 'su caudal es 0: está cerrada aunque salga agua del tanque');
});

test('valves: commandable false solo en la que no tiene mando; ausente = accionable', () => {
  const [salida, entrada] = valvesFromSnapshot(snap(DOS_VALVULAS));
  assert.equal(salida.commandable, true, 'sin el campo, la válvula se acciona como siempre');
  assert.equal(entrada.commandable, false);
});

// El operario no tiene por qué saber qué es un bit, un PLC ni un enclavamiento. Este test recorre
// TODOS los desenlaces y bloquea la jerga en el texto visible; los códigos siguen disponibles en
// `technical`, que es donde sirven para reportar una incidencia por teléfono.
test('interpretCommand: ningún desenlace suelta jerga en el texto que se lee', () => {
  const casos: ValveCommandResult[] = [
    res({ http: 200, status: 'confirmed', confirmedValue: 16385 }),
    res({ http: 202, status: 'sent', writeVerified: true, writtenValue: 4096 }),
    res({ http: 502, status: 'failed', reason: 'WRITE_REJECTED' }),
    res({ http: 502, status: 'failed', reason: 'READBACK_UNCONFIRMED', writeVerified: true }),
    res({ http: 409, status: 'rejected', reason: 'INTERLOCK_FAILED: snapshot frozen' }),
    res({ http: 429, status: 'rejected', reason: 'RATE_LIMITED' }),
    res({ http: 0, status: 'error', reason: 'NETWORK' }),
  ];
  const prohibido = /bit|PLC|enclavamiento|read-?back|snapshot|[A-Z]{4,}_[A-Z_]+/;
  for (const r of casos) {
    const v = interpretCommand(r, 'open', 'Válvula 1');
    assert.doesNotMatch(v.title, prohibido, `título con jerga: ${v.title}`);
    assert.doesNotMatch(v.message, prohibido, `mensaje con jerga: ${v.message}`);
    assert.ok(['success', 'warning', 'danger'].includes(v.tone));
  }
});

// El desenlace que motivó el tercer color: la orden salió y nadie puede confirmar que la válvula se
// movió. Con `ok` booleano se pintaba VERDE con un tick sobre un texto que pedía ir a comprobarlo en
// planta. El semáforo ganaba y nadie iba.
test('interpretCommand: «no se pudo confirmar» es ÁMBAR, nunca verde', () => {
  const v = interpretCommand(res({ http: 202, status: 'sent', writeVerified: true, writtenValue: 4096 }), 'open', 'V1');
  assert.equal(v.tone, 'warning');
  assert.notEqual(v.tone, 'success', 'un tick verde convierte «ve a mirar» en «ya está»');
  assert.match(v.title, /[Vv]erifique/);
});

// ── FASE 1: qué acción se ofrece, y por qué NO cuando no se ofrece ───────────────────────────
//
// Lo que protege: hasta ahora el botón se pintaba para toda válvula con canal de mando, así que en
// las ocho plantas sin `close` el operador confirmaba un cierre en un diálogo y solo después
// recibía UNKNOWN_COMMAND. Y al quitar el botón entero quedó un icono con forma de interruptor que
// no respondía, sin decir por qué.

/** Válvula mínima para probar la puerta; solo varían estado, verbos y canal. */
function valvula(over: Partial<ReturnType<typeof valvesFromSnapshot>[number]> = {}) {
  return {
    id: 'valve1', name: 'Válvula 1', kind: 'onoff' as const, positionPct: null,
    state: 'closed' as const, source: 'estado' as const,
    byState: 'closed' as const, byFlow: null, flowValue: null, flowUnit: null, flowLabel: null,
    disagreement: false, commandable: true, commands: ['open', 'close'], rawState: null, ts: null,
    effectiveState: 'closed' as const, manualOverride: false,
    ...over,
  } as ReturnType<typeof valvesFromSnapshot>[number];
}

test('accion: cerrada con open declarado → ofrece abrir (las 10 plantas)', () => {
  const a = accionDisponible(valvula({ state: 'closed', commands: ['open'] }), false);
  assert.deepEqual(a, { kind: 'command', verb: 'open' });
});

test('accion: abierta con close declarado → ofrece cerrar (las que declaran close)', () => {
  const a = accionDisponible(valvula({ state: 'open', commands: ['open', 'close'] }), false);
  assert.deepEqual(a, { kind: 'command', verb: 'close' });
});

test('accion: abierta SIN close declarado → sin control, y lo explica', () => {
  const a = accionDisponible(valvula({ state: 'open', commands: ['open'] }), false);
  assert.equal(a.kind, 'blocked');
  assert.equal(a.kind === 'blocked' && a.reason, 'verb-missing');
  assert.match(a.kind === 'blocked' ? a.explain : '', /no declara canal de cierre/);
});

test('accion: sin canal de mando → sin control (la de ENTRADA de La Voragine)', () => {
  const a = accionDisponible(valvula({ commandable: false }), false);
  assert.equal(a.kind === 'blocked' && a.reason, 'no-channel');
});

test('accion: planta congelada → sin control, porque el interlock lo rechazaria igual', () => {
  const a = accionDisponible(valvula({ state: 'closed', commands: ['open'] }), true);
  assert.equal(a.kind === 'blocked' && a.reason, 'frozen');
});

test('accion: estado desconocido → sin control (no se sabe hacia donde moverla)', () => {
  const a = accionDisponible(valvula({ state: 'unknown', commands: ['open', 'close'] }), false);
  assert.equal(a.kind === 'blocked' && a.reason, 'unknown-state');
});

test('accion: congelada manda sobre todo lo demas (no revela otro motivo antes)', () => {
  const a = accionDisponible(valvula({ commandable: false, state: 'unknown', commands: [] }), true);
  assert.equal(a.kind === 'blocked' && a.reason, 'frozen');
});

// ── Válvula PROPORCIONAL (Cabuyo, La Luisa, La Leonera, Gloria; 2026-10-19) ──────────────────
//
// La de salida reporta su % de apertura y recibe una consigna 0–100 %. Convención: `valve<N>Position`
// en realIn, unit "%", 0–100, con label y flowDomainKey; sin `valve<N>` mientras no exista la fase de
// consigna. Lo que protegen estos tests: que se VEA (antes solo se descubría por `valve<N>`), que su
// estado salga de la apertura, y que NO se ofrezca un abrir/cerrar que no es la orden que entiende.

function apertura(value: number | null, over: Partial<SignalDto> = {}): SignalDto {
  return sig(value, { unit: '%', label: 'Válvula de salida', flowDomainKey: 'outletFlow1', ...over });
}

/** Motivo del bloqueo, o null si la acción no está bloqueada. */
function motivo(a: ReturnType<typeof accionDisponible>): string | null {
  return a.kind === 'blocked' ? a.reason : null;
}

test('proporcional: con solo valve1Position aparece, es proporcional y NO es accionable', () => {
  const vs = valvesFromSnapshot(snap({ valve1Position: apertura(47.3), outletFlow1: sig(12) }));
  assert.equal(vs.length, 1, 'se descubre por la apertura, aunque no declare valve1');
  const v = vs[0];
  assert.equal(v.id, 'valve1');
  assert.equal(v.kind, 'proportional');
  assert.equal(v.positionPct, 47.3);
  assert.equal(v.name, 'Válvula de salida', 'el nombre sale del label de la apertura');
  assert.equal(v.commandable, false, 'sin valve1 no hay por dónde mandar: la trampa de «ausente ⇒ accionable»');
  assert.deepEqual(v.commands, []);
  assert.equal(v.state, 'open');
  assert.equal(v.source, 'posicion');
  assert.equal(v.disagreement, false, 'abierta al 47 % con 12 l/s: cuadra');
});

test('proporcional: sin label usa «Válvula N», igual que las on/off', () => {
  const [v] = valvesFromSnapshot(snap({ valve3Position: apertura(10, { label: null }) }));
  assert.equal(v.name, 'Válvula 3');
});

test('proporcional: CERRADA hasta el umbral inclusive; abierta justo por encima', () => {
  const estado = (pct: number) => valvesFromSnapshot(snap({ valve1Position: apertura(pct) }))[0].state;
  assert.equal(estado(0), 'closed');
  assert.equal(estado(POSITION_CLOSED_THRESHOLD_PCT), 'closed', 'en el umbral cuenta como cerrada (<=), como el caudal');
  assert.equal(estado(POSITION_CLOSED_THRESHOLD_PCT + 0.1), 'open');
  assert.equal(estado(100), 'open');
});

test('proporcional: la acción es setpoint-pending, con el motivo en palabras', () => {
  const [v] = valvesFromSnapshot(snap({ valve1Position: apertura(30) }));
  const a = accionDisponible(v, false);
  assert.equal(motivo(a), 'setpoint-pending');
  assert.equal(
    a.kind === 'blocked' ? a.explain : '',
    'La consigna de apertura (0–100 %) todavía no se puede enviar desde la app; solo se muestra la apertura.',
  );
});

test('proporcional: congelada sigue mandando frozen (la puerta nueva va DESPUÉS)', () => {
  const [v] = valvesFromSnapshot(snap({ valve1Position: apertura(30) }));
  assert.equal(motivo(accionDisponible(v, true)), 'frozen');
});

test('proporcional: aunque algún día declare valve1, sigue sin ofrecer abrir/cerrar', () => {
  const [v] = valvesFromSnapshot(snap({ valve1: sig(0, { commands: ['open', 'close'] }), valve1Position: apertura(30) }));
  assert.equal(v.kind, 'proportional');
  assert.equal(v.commandable, true, 'con valve1 hay canal...');
  assert.equal(motivo(accionDisponible(v, false)), 'setpoint-pending', '...pero la orden que entiende es una consigna');
});

test('proporcional: apertura inusable y sin caudal → unknown, sin inventar un %', () => {
  const [v] = valvesFromSnapshot(snap({ valve1Position: apertura(50, { usable: false }) }));
  assert.equal(v.kind, 'proportional', 'sigue siendo proporcional aunque hoy no reporte');
  assert.equal(v.positionPct, null);
  assert.equal(v.state, 'unknown');
  assert.equal(v.source, 'ninguno');
});

test('proporcional: apertura inusable con caudal → cae al caudal, como una on/off sin palabra', () => {
  const [v] = valvesFromSnapshot(snap({ valve1Position: apertura(50, { usable: false }), outletFlow1: sig(8) }));
  assert.equal(v.positionPct, null);
  assert.equal(v.state, 'open');
  assert.equal(v.source, 'caudal');
  assert.equal(v.disagreement, false, 'sin apertura no hay dos veredictos que comparar');
});

test('proporcional: apertura y caudal que DISCREPAN se marcan; la apertura manda', () => {
  const [v] = valvesFromSnapshot(snap({ valve1Position: apertura(0), outletFlow1: sig(23.3) }));
  assert.equal(v.state, 'closed', 'manda la apertura, que es la lectura del propio equipo');
  assert.equal(v.source, 'posicion');
  assert.equal(v.byFlow, 'open');
  assert.equal(v.disagreement, true, 'cerrada al 0 % con 23 l/s: hay que avisarlo, no elegir en silencio');
});

test('proporcional: el caudal que corrobora es el que declara SU apertura (flowDomainKey)', () => {
  const [v] = valvesFromSnapshot(
    snap({ valve1Position: apertura(60, { flowDomainKey: 'inletFlow1' }), inletFlow1: sig(0), outletFlow1: sig(20) }),
  );
  assert.equal(v.byFlow, 'closed', 'miró la entrada declarada, no la salida por defecto');
  assert.equal(v.flowLabel, 'inletFlow1');
  assert.equal(v.disagreement, true);
});

test('proporcional: planta mixta — salida proporcional (valve1) y entrada on/off (valve2)', () => {
  const vs = valvesFromSnapshot(
    snap({
      valve1Position: apertura(35),
      valve2: sig(0, { label: 'Válvula de entrada', flowDomainKey: 'inletFlow1', commands: ['open', 'close'] }),
      outletFlow1: sig(1.6),
      inletFlow1: sig(6.9),
    }),
  );
  assert.deepEqual(vs.map((v) => v.id), ['valve1', 'valve2']);
  assert.deepEqual(vs.map((v) => v.kind), ['proportional', 'onoff']);
  assert.deepEqual(vs.map((v) => v.name), ['Válvula de salida', 'Válvula de entrada']);
  const [salida, entrada] = vs;
  assert.equal(salida.commandable, false);
  assert.equal(salida.flowValue, 1.6, 'la salida se corrobora con su caudal');
  assert.equal(motivo(accionDisponible(salida, false)), 'setpoint-pending');
  assert.equal(entrada.commandable, true, 'la on/off con valve2 se comporta como siempre');
  assert.equal(entrada.positionPct, null);
  assert.equal(entrada.flowValue, 6.9, 'y la entrada con el suyo');
  assert.equal(entrada.source, 'caudal');
  assert.deepEqual(accionDisponible(entrada, false), { kind: 'command', verb: 'close' });
});

test('valves: una palabra de estado SUELTA no crea válvula (como antes)', () => {
  assert.deepEqual(valvesFromSnapshot(snap({ valve1State: sig(16385) })), []);
});

test('valves: isValveSignal también reconoce la apertura de una proporcional', () => {
  assert.equal(isValveSignal('valve1Position'), true);
  assert.equal(isValveSignal('valve12Position'), true);
  assert.equal(isValveSignal('valvePosition'), false);
  assert.equal(isValveSignal('valve1PositionSetpoint'), false);
});

test('proporcional: no se le aplica la detección de operación manual de las on/off', () => {
  const [prop] = valvesFromSnapshot(snap({ valve1Position: apertura(30) }));
  const [onoff] = valvesFromSnapshot(snap({ valve1: sig(0) }));
  assert.equal(vigilaOperacionManual(prop), false);
  assert.equal(vigilaOperacionManual(onoff), true);
});

test('proporcional: texto y barra de la apertura', () => {
  assert.equal(textoApertura(47.3), 'Apertura 47 %');
  assert.equal(textoApertura(2.4), 'Apertura 2,4 %', 'cerca del umbral no se redondea a un número que contradiga el badge');
  assert.equal(textoApertura(0), 'Apertura 0 %');
  assert.equal(textoApertura(null), 'Apertura sin dato');
  assert.equal(anchoBarraApertura(120), 100, 'la barra no crece más allá del 100 %');
  assert.equal(anchoBarraApertura(-3), 0);
  assert.equal(anchoBarraApertura(null), 0);
  assert.equal(anchoBarraApertura(55.5), 55.5);
});
