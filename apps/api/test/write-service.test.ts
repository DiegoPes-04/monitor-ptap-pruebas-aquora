/**
 * Fase 5 — WriteService (criterios de aceptación), con dobles deterministas para cada
 * dependencia y el SimulatorBridgeAdapter real para el I/O de escritura/read-back:
 *  - sesión Anonymous/None (o writes deshabilitados) → TODO rechazado (WRITES_DISABLED_INSECURE_SESSION);
 *  - target no writable / comando desconocido → rechazado;
 *  - RBAC del mapping: jefe NO puede control_valves;
 *  - interlock: bridge != Connected o snapshot no fresco → rechazado;
 *  - write sin read-back confirmado → 'fallido', nunca 'exitoso' (+ rollback);
 *  - idempotencia: misma idempotencyKey no re-ejecuta;
 *  - audit log SIEMPRE.
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AuditEntry, AuditLogService } from '../src/infrastructure/audit/audit-log.service';
import type { ConnectivityConfig, OpcUaConfig } from '../src/infrastructure/connectivity/connectivity.config';
import { loadMapping, type LoadedMapping, type WriteSpec } from '../src/infrastructure/connectivity/mapping/opc-mapping.loader';
import type { PlantCache } from '../src/infrastructure/connectivity/pipeline/plant-cache';
import type { LivenessState, PlantSnapshotDto } from '../src/infrastructure/connectivity/pipeline/plant-snapshot.dto';
import type { BridgeStatus, ConnectivityAdapter } from '../src/infrastructure/connectivity/ports/connectivity-adapter.port';
import { SimulatorBridgeAdapter } from '../src/infrastructure/connectivity/adapters/simulator/simulator-bridge.adapter';
import type { CommandLogRepository, StoredCommand } from '../src/modules/commands/command-log.repository';
import type { CommandMappingResolver } from '../src/modules/commands/command-mapping.resolver';
import { REJECT, FAIL, SENT, httpStatusForCommand, type CommandActor } from '../src/modules/commands/command.dto';
import { WriteService } from '../src/modules/commands/write.service';
import type { CommandSignatureService } from '../src/modules/commands/command-signature.service';
import type { NotificationRepository } from '../src/modules/notifications/notification.repository';

const WRITE: WriteSpec = {
  target: { channel: 'intOut', sourceBuffer: 'INT_OUT_TEST', index: 3 },
  commands: { openValve: 1, closeValve: 0 },
  readBack: { channel: 'intOut', sourceBuffer: 'INT_OUT_TEST', index: 3, confirmsWrittenValue: true, stateVerified: true },
  timeoutMs: 60,
  rollbackValue: 0,
  permission: 'control_valves',
  mode: 'absolute',
  pulse: null,
};

interface FakeAdapter extends ConnectivityAdapter {
  /** El ÍNDICE importa tanto como el valor: en una orden compuesta, escribir el sentido en la
   *  posición equivocada es indistinguible de no escribirlo si solo se mira el valor. */
  writes: Array<{ index: number; value: number | boolean }>;
}

function fakeAdapter(opts: { secure: boolean; bridge: BridgeStatus; confirms?: boolean; writeThrows?: boolean; preset?: number; echoFails?: boolean }): FakeAdapter {
  const store = new Map<string, number | boolean>();
  const confirms = opts.confirms !== false;
  // `echoFails`: la lectura posterior al write falla, así que `writeVerified` queda en null. Sirve
  // para probar que el desenlace `sent` NO se concede sin un eco que lo respalde.
  let reads = 0;
  const key = (t: { plantId: string; channel: string; sourceBuffer: string; index: number }) =>
    `${t.plantId}/${t.channel}/${t.sourceBuffer}[${t.index}]`;
  const adapter = {
    writes: [] as Array<{ index: number; value: number | boolean }>,
    getWriteSecurity: () => ({
      secure: opts.secure,
      securityMode: opts.secure ? 'SignAndEncrypt' : 'None',
      identity: opts.secure ? 'username' : 'anonymous',
    }),
    getBridgeStatus: () => opts.bridge,
    async writeBufferElement(t: { plantId: string; channel: string; sourceBuffer: string; index: number }, v: number | boolean) {
      // Emula un write RECHAZADO por el servidor OPC UA (StatusCode != Good) o un buffer faulted.
      if (opts.writeThrows) throw new Error('write OPC UA rechazado (BadUserAccessDenied)');
      adapter.writes.push({ index: t.index, value: v });
      store.set(key(t), v);
    },
    async readBufferElement(t: never) {
      reads += 1;
      // La 1ª lectura es el valor previo (antes de escribir); la 2ª es el eco. Solo se rompe el eco.
      if (opts.echoFails && reads === 2) throw new Error('lectura del eco falló');
      const s = store.get(key(t));
      // `preset`: valor previo de la palabra (para probar que bitmask conserva bits ajenos).
      const base = s === undefined ? (opts.preset ?? 0) : s;
      const value = s === undefined ? base : confirms ? s : typeof s === 'boolean' ? !s : Number(s) + 1;
      return { value, quality: 'Good' as const, sourceTimestamp: null };
    },
  };
  return adapter as unknown as FakeAdapter;
}

function fakeConfig(writesEnabled: boolean): ConnectivityConfig {
  return { opcua: { writesEnabled } } as unknown as ConnectivityConfig;
}

function snap(state: LivenessState, sequence = 7): PlantSnapshotDto {
  return {
    plantId: 'voragine',
    displayName: 'La Vorágine',
    sequence,
    protocolVersion: 'v2',
    dtoVersion: 'v1',
    bridgeStatus: 'Connected',
    liveness: { state, lastChangeAt: null, windowSec: 300 },
    signals: {},
  } as PlantSnapshotDto;
}

function fakeCache(snapshot: PlantSnapshotDto | null): PlantCache {
  return { get: () => snapshot } as unknown as PlantCache;
}

function fakeResolver(write: WriteSpec | null): CommandMappingResolver {
  return { resolve: () => (write ? { domainKey: 'valveEV01', write } : null) } as unknown as CommandMappingResolver;
}

function fakeRepo(): CommandLogRepository {
  const byKey = new Map<string, StoredCommand>();
  const rows = new Map<number, StoredCommand>();
  let idSeq = 1;
  return {
    reserve: async (input: { idempotencyKey: string | null }) => {
      if (input.idempotencyKey && byKey.has(input.idempotencyKey)) {
        return { reserved: false, existing: byKey.get(input.idempotencyKey)! };
      }
      const id = idSeq++;
      const row: StoredCommand = {
        id, status: 'pending', reason: null, previousValue: null, writtenValue: null, confirmedValue: null, interlockSequence: null,
      };
      rows.set(id, row);
      if (input.idempotencyKey) byKey.set(input.idempotencyKey, row);
      return { reserved: true, id };
    },
    finalize: async (id: number, result: Partial<StoredCommand>) => {
      const row = rows.get(id);
      if (row) Object.assign(row, result);
    },
    findByIdempotencyKey: async (k: string) => byKey.get(k) ?? null,
  } as unknown as CommandLogRepository;
}

/**
 * Doble del libro de firmas. Devuelve un sello fijo: aquí se comprueba que la maniobra se firma y
 * que el sello llega al aviso, no el cálculo del HMAC — eso tiene su propio test, sin base de datos.
 */
function fakeFirmas(): CommandSignatureService {
  return { firmar: async () => 'firma-de-prueba' } as unknown as CommandSignatureService;
}

/** Doble de la bandeja: cada maniobra deja un aviso, y publicarlo no debe poder romper la orden. */
function fakeAvisos(): NotificationRepository {
  return { create: async () => true } as unknown as NotificationRepository;
}

function fakeAudit(): { service: AuditLogService; calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  const service = { record: async (e: AuditEntry) => { calls.push(e); } } as unknown as AuditLogService;
  return { service, calls };
}

const OPERADOR: CommandActor = { userId: 'u1', userEmail: 'op@ptap.co', role: 'operador', ip: '10.0.0.1' };
const JEFE: CommandActor = { userId: 'u2', userEmail: 'jefe@ptap.co', role: 'jefe', ip: '10.0.0.2' };

function build(opts: { secure: boolean; bridge: BridgeStatus; confirms?: boolean; writesEnabled?: boolean; write?: WriteSpec | null; snapshot?: PlantSnapshotDto | null; writeThrows?: boolean; preset?: number; echoFails?: boolean }) {
  const adapter = fakeAdapter({ secure: opts.secure, bridge: opts.bridge, confirms: opts.confirms, writeThrows: opts.writeThrows, preset: opts.preset, echoFails: opts.echoFails });
  const audit = fakeAudit();
  const service = new WriteService(
    adapter,
    fakeConfig(opts.writesEnabled ?? true),
    fakeCache(opts.snapshot === undefined ? snap('live') : opts.snapshot),
    fakeResolver(opts.write === undefined ? WRITE : opts.write),
    fakeRepo(),
    audit.service,
    fakeFirmas(),
    fakeAvisos(),
  );
  return { service, adapter, audit };
}

test('write-service: sesión insegura (Anonymous/None) → rechazado WRITES_DISABLED_INSECURE_SESSION, sin escribir', async () => {
  const { service, adapter } = build({ secure: false, bridge: 'Connected' });
  const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, REJECT.WRITES_DISABLED_INSECURE_SESSION);
  assert.equal(adapter.writes.length, 0);
});

test('write-service: OPCUA_WRITES_ENABLED=false → rechazado, sin escribir', async () => {
  const { service, adapter } = build({ secure: true, bridge: 'Connected', writesEnabled: false });
  const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
  assert.equal(r.reason, REJECT.WRITES_DISABLED_INSECURE_SESSION);
  assert.equal(adapter.writes.length, 0);
});

test('write-service: target sin señal writable → TARGET_NOT_WRITABLE', async () => {
  const { service } = build({ secure: true, bridge: 'Connected', write: null });
  const r = await service.execute('voragine', { command: 'openValve', target: 'noExiste' }, OPERADOR);
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, REJECT.TARGET_NOT_WRITABLE);
});

test('write-service: comando desconocido → UNKNOWN_COMMAND', async () => {
  const { service } = build({ secure: true, bridge: 'Connected' });
  const r = await service.execute('voragine', { command: 'frobnicate', target: 'valveEV01' }, OPERADOR);
  assert.equal(r.reason, REJECT.UNKNOWN_COMMAND);
});

test('write-service: jefe NO puede control_valves → FORBIDDEN, sin escribir', async () => {
  const { service, adapter } = build({ secure: true, bridge: 'Connected' });
  const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, JEFE);
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, REJECT.FORBIDDEN);
  assert.equal(adapter.writes.length, 0);
});

test('write-service: interlock bridge != Connected → rechazado, sin escribir', async () => {
  const { service, adapter } = build({ secure: true, bridge: 'Stale' });
  const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
  assert.equal(r.status, 'rejected');
  assert.ok(r.reason?.startsWith(REJECT.INTERLOCK_FAILED));
  assert.equal(adapter.writes.length, 0);
});

// El interlock sigue exigiendo `live`: para accionar equipo no basta con que la sesión esté
// viva, hay que estar VIENDO moverse el dato. `stable` y `frozen` bloquean por igual — misma
// postura de seguridad que antes (cuando bloqueaban idle/stale/unknown).
test('write-service: interlock snapshot congelado → rechazado', async () => {
  const { service, adapter } = build({ secure: true, bridge: 'Connected', snapshot: snap('frozen') });
  const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
  assert.ok(r.reason?.startsWith(REJECT.INTERLOCK_FAILED));
  assert.equal(adapter.writes.length, 0);
});

test('write-service: interlock snapshot estable (sin movimiento) → rechazado por defecto', async () => {
  delete process.env.COMMAND_REQUIRE_LIVE;
  const { service, adapter } = build({ secure: true, bridge: 'Connected', snapshot: snap('stable') });
  const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
  assert.ok(r.reason?.startsWith(REJECT.INTERLOCK_FAILED));
  assert.equal(adapter.writes.length, 0);
});

// Un sitio en régimen estable (sesión sana, proceso quieto) no podía comandarse nunca, y con los
// relojes del PLC desfasados el `live` tampoco es fiable. La excepción es EXPLÍCITA y auditable.
test('write-service: con COMMAND_REQUIRE_LIVE=false un snapshot estable SÍ puede comandarse', async () => {
  process.env.COMMAND_REQUIRE_LIVE = 'false';
  try {
    const { service, adapter } = build({ secure: true, bridge: 'Connected', snapshot: snap('stable'), confirms: true });
    const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
    assert.equal(r.status, 'confirmed');
    assert.equal(adapter.writes.length, 1);
  } finally {
    delete process.env.COMMAND_REQUIRE_LIVE;
  }
});

test('write-service: `frozen` bloquea SIEMPRE, incluso con COMMAND_REQUIRE_LIVE=false', async () => {
  process.env.COMMAND_REQUIRE_LIVE = 'false';
  try {
    const { service, adapter } = build({ secure: true, bridge: 'Connected', snapshot: snap('frozen') });
    const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
    assert.ok(r.reason?.startsWith(REJECT.INTERLOCK_FAILED), 'sin fuente viva no se acciona jamás');
    assert.equal(adapter.writes.length, 0);
  } finally {
    delete process.env.COMMAND_REQUIRE_LIVE;
  }
});

// Hallazgo de campo 2026-07-30: antes, un write RECHAZADO por el servidor y un write EXITOSO sin
// confirmación de estado daban el MISMO reason (READBACK_UNCONFIRMED), así que era imposible saber
// si el valor había llegado al canal. Ahora se distinguen.
test('write-service: write rechazado por el servidor → WRITE_REJECTED (no READBACK_UNCONFIRMED)', async () => {
  const { service } = build({ secure: true, bridge: 'Connected', writeThrows: true });
  const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, FAIL.WRITE_REJECTED, 'debe decir que la ESCRITURA falló, no que no se confirmó');
  assert.equal(r.writtenValue, null, 'no se llegó a escribir nada');
  assert.equal(r.writeVerified, null, 'sin escritura no hay eco que verificar');
});

test('write-service: el ECO del canal de comando verifica la escritura en el instante', async () => {
  const { service } = build({ secure: true, bridge: 'Connected', confirms: true });
  const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
  assert.equal(r.writeVerified, true, 'el eco debe coincidir con el valor escrito');
  assert.equal(r.writeEcho, r.writtenValue);
});

// Hallazgo (revisión externa 2026-07-30): escribir el valor ABSOLUTO apaga los bits ajenos que
// estuvieran activos en la misma palabra (otra válvula del mismo sitio). `bitmask` hace
// read-modify-write y los conserva.
test('write-service: modo bitmask CONSERVA los otros bits de la palabra', async () => {
  const spec: WriteSpec = { ...WRITE, mode: 'bitmask', commands: { openValve: 4096 } };
  const { service, adapter } = build({ secure: true, bridge: 'Connected', write: spec, preset: 32 });
  await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
  // 32 (bit5, de otro comando) debe seguir presente: 32 | 4096 = 4128
  assert.equal(adapter.writes[0].value, 4128, 'debe escribir actual|máscara, no la máscara sola');
});

// Hallazgo: el rollback solo corría al FALLAR el read-back, así que un comando CONFIRMADO dejaba el
// bit de comando enclavado para siempre. Un pulso debe limpiarse SIEMPRE.
// Nota de diseño que este test hace explícita: un PULSO NO puede confirmarse releyendo el canal de
// comando (el bit ya se limpió), así que su readBack debe apuntar al canal de ESTADO. El schema lo
// exige (pulse ⇒ confirmsWrittenValue:false).
test('write-service: un PULSO se limpia incluso cuando el estado CONFIRMA', async () => {
  const spec: WriteSpec = {
    ...WRITE,
    mode: 'bitmask',
    pulse: { holdMs: 5 },
    commands: { openValve: 4096 },
    readBack: { channel: 'intIn', sourceBuffer: 'INT_IN_TEST', index: 0, confirmsWrittenValue: false, expectedValue: 16385 },
  };
  // preset: la palabra ya trae 16385 (bit14+bit0 de otro uso) y el estado responde 16385.
  const { service, adapter } = build({ secure: true, bridge: 'Connected', write: spec, preset: 16385 });
  const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
  assert.equal(r.status, 'confirmed');
  assert.equal(adapter.writes.length, 2, 'debe haber activación Y cierre del pulso');
  assert.equal(adapter.writes[0].value, 16385 | 4096, 'activa el bit conservando los ajenos');
  assert.equal(Number(adapter.writes[1].value) & 4096, 0, 'el bit del comando queda LIMPIO (sin enclavar)');
  assert.equal(adapter.writes[1].value, 16385, 'y los bits ajenos se conservan');
});

test('write-service: un PULSO no se escribe dos veces cuando el estado NO confirma', async () => {
  const spec: WriteSpec = { ...WRITE, mode: 'bitmask', pulse: { holdMs: 5 }, commands: { openValve: 4096 } };
  const { service, adapter } = build({ secure: true, bridge: 'Connected', write: spec, confirms: false });
  await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
  assert.equal(adapter.writes.length, 2, 'activación + cierre; el rollback NO debe añadir un 3er write espurio');
});

// ── EXCLUSIÓN ABRIR/CERRAR EN MÁSCARA (Carbonero, integrador 2026-10-05) ────────────────────
//
// Abrir = bit0 (1) y cerrar = bit1 (2) de la MISMA palabra, y los dos a 1 a la vez es el estado que
// el PLC declara ERROR. `bitmask` hacía `actual | valor`: con el bit contrario todavía puesto (un
// cierre de pulso que falló, una escritura ajena) escribía 3. `preset` es lo que ya trae la palabra.

const WRITE_EXCLUSION: WriteSpec = {
  ...WRITE,
  target: { channel: 'intOut', sourceBuffer: 'INT_OUT_TEST', index: 0 },
  mode: 'bitmask',
  commands: { open: 1, close: 2 },
  pulse: { holdMs: 5 },
  readBack: { channel: 'intIn', sourceBuffer: 'INT_IN_TEST', index: 0, confirmsWrittenValue: false, stateVerified: false },
};

/** ¿Alguna escritura dejó los dos sentidos puestos a la vez? */
function dosSentidos(writes: Array<{ value: number | boolean }>, abrir: number, cerrar: number): boolean {
  return writes.some((w) => (Number(w.value) & abrir) !== 0 && (Number(w.value) & cerrar) !== 0);
}

test('write-service: en máscara, ABRIR apaga el bit de CERRAR en la misma escritura', async () => {
  const { service, adapter } = build({ secure: true, bridge: 'Connected', write: WRITE_EXCLUSION, preset: 2 });
  await service.execute('carbonero', { command: 'open', target: 'valve1' }, OPERADOR);

  assert.equal(adapter.writes[0].value, 1, 'con el bit de cerrar puesto, abrir escribe 1 y no 3');
  assert.equal(dosSentidos(adapter.writes, 1, 2), false, 'jamás los bits 0 y 1 a la vez');
});

test('write-service: en máscara, CERRAR apaga el bit de ABRIR en la misma escritura', async () => {
  const { service, adapter } = build({ secure: true, bridge: 'Connected', write: WRITE_EXCLUSION, preset: 1 });
  await service.execute('carbonero', { command: 'close', target: 'valve1' }, OPERADOR);

  assert.equal(adapter.writes[0].value, 2, 'con el bit de abrir puesto, cerrar escribe 2 y no 3');
  assert.equal(dosSentidos(adapter.writes, 1, 2), false, 'jamás los bits 0 y 1 a la vez');
});

test('write-service: la exclusión solo apaga los bits de la válvula; el resto de la palabra se conserva', async () => {
  // 1024 = bit10 hace aquí de bit AJENO en la palabra de mando: tiene que sobrevivir a la orden y al
  // cierre del pulso, que es para lo que existe `bitmask`.
  const { service, adapter } = build({ secure: true, bridge: 'Connected', write: WRITE_EXCLUSION, preset: 1024 | 2 });
  await service.execute('carbonero', { command: 'open', target: 'valve1' }, OPERADOR);

  assert.deepEqual(adapter.writes.map((w) => w.value), [1024 | 1, 1024], 'activa 1025 y suelta a 1024');
});

test('write-service: la exclusión sale del mapping, no de bits fijos (La Vorágine, 4096/8192)', async () => {
  const spec: WriteSpec = { ...WRITE_EXCLUSION, commands: { open: 4096, close: 8192 } };
  const { service, adapter } = build({ secure: true, bridge: 'Connected', write: spec, preset: 8192 });
  await service.execute('voragine', { command: 'open', target: 'valve1' }, OPERADOR);

  assert.equal(adapter.writes[0].value, 4096, 'con el bit13 puesto, abrir escribe 4096 y no 12288');
  assert.equal(dosSentidos(adapter.writes, 4096, 8192), false);
});

test('write-service: el mando REAL de Carbonero nunca deja los bits 0 y 1 a la vez, y sale en ámbar', async () => {
  const real = loadMapping(join(__dirname, '..', 'config', 'opc_mapping.json')).signals.find(
    (s) => s.plantId === 'carbonero' && s.domainKey === 'valve1',
  )?.write;
  assert.ok(real, 'carbonero/valve1 debe tener write spec');
  // Lo que se prueba es la aritmética de la palabra con el spec de PRODUCCIÓN. El sostenido real
  // (45 s) se acorta para que el test no tarde minutos; su valor lo fija command-mapping.test.ts.
  const spec: WriteSpec = { ...real, pulse: { holdMs: 5 }, timeoutMs: 60 };
  const casos: Array<[string, number, number]> = [
    ['open', 0, 1],
    ['close', 0, 2],
    ['open', 2, 1], // el bit de cerrar se había quedado puesto
    ['close', 1, 2], // el de abrir
    ['open', 3, 1], // la palabra ya llegaba en ERROR: la orden la saca de ahí, no la perpetúa
    ['close', 3, 2],
  ];
  for (const [command, preset, activa] of casos) {
    const { service, adapter } = build({ secure: true, bridge: 'Connected', write: spec, preset });
    const r = await service.execute('carbonero', { command, target: 'valve1' }, OPERADOR);
    const ultima = adapter.writes[adapter.writes.length - 1];

    assert.equal(adapter.writes[0].value, activa, `${command} sobre ${preset}: activa ${activa}`);
    assert.equal(dosSentidos(adapter.writes, 1, 2), false, `${command} sobre ${preset}: jamás 3`);
    assert.equal(Number(ultima.value) & 3, 0, `${command} sobre ${preset}: el sostenido se suelta`);
    assert.equal(r.status, 'sent', `${command} sobre ${preset}: estado sin verificar → ámbar, ni verde ni rojo`);
  }
});

test('write-service: camino feliz → confirmado con trazabilidad', async () => {
  const { service, adapter } = build({ secure: true, bridge: 'Connected', confirms: true });
  const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
  assert.equal(r.status, 'confirmed');
  assert.equal(r.writtenValue, 1);
  assert.equal(r.previousValue, 0);
  assert.equal(r.confirmedValue, 1);
  assert.equal(r.interlockSequence, 7);
  assert.equal(adapter.writes.length, 1);
});

test('write-service: read-back sin confirmar → FALLIDO (nunca exitoso) + rollback', async () => {
  const { service, adapter } = build({ secure: true, bridge: 'Connected', confirms: false });
  const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, FAIL.READBACK_UNCONFIRMED);
  assert.notEqual(r.status, 'confirmed');
  // write del comando (1) + write de rollback (0)
  assert.equal(adapter.writes.length, 2);
  assert.equal(adapter.writes[1].value, 0);
});

// El canal de estado de las 10 plantas espera `16385` para "abierta", pero ese valor nunca se
// observó en campo: es una inferencia del patrón de Vorágine. Declarar `failed` con esa base acusa
// al equipo de no responder apoyándose en un número inventado — tan poco honesto como declarar
// éxito. Con `stateVerified: false` el desenlace es `sent`, que no afirma ni niega el movimiento.
// El read-back apunta a OTRO buffer que el target, como en producción (intOut → intIn): así el eco
// (relectura del canal de comando) y la confirmación de estado son independientes, que es
// justamente la distinción que este desenlace necesita. `confirms: true` deja el eco sano; el
// estado no confirma porque intIn nunca llega al `expectedValue`.
const WRITE_ESTADO_APARTE: WriteSpec = {
  ...WRITE,
  readBack: { channel: 'intIn', sourceBuffer: 'INT_IN_TEST', index: 0, confirmsWrittenValue: false, expectedValue: 16385, stateVerified: false },
};

test('write-service: estado NO verificado + eco OK → SENT (ni confirmado ni fallido)', async () => {
  const { service } = build({ secure: true, bridge: 'Connected', write: WRITE_ESTADO_APARTE, confirms: true });
  const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);

  assert.equal(r.status, 'sent');
  assert.equal(r.reason, SENT.SENT_STATE_UNVERIFIED);
  assert.equal(r.writeVerified, true, 'el eco es lo que sostiene el desenlace `sent`');
  assert.notEqual(r.status, 'confirmed', 'no se afirma que el equipo se movió');
  assert.notEqual(r.status, 'failed', 'ni se lo acusa de no haberlo hecho');
  assert.equal(httpStatusForCommand(r), 202, '202 Accepted, no 200 ni 502');
});

test('write-service: estado NO verificado resuelve RÁPIDO (no agota el timeout de 5 s)', async () => {
  // El operador no debe esperar 5 s por un valor que ya sabemos que no representa el estado.
  const spec: WriteSpec = { ...WRITE_ESTADO_APARTE, timeoutMs: 5000 };
  const { service } = build({ secure: true, bridge: 'Connected', write: spec, confirms: true });
  const t0 = Date.now();
  const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
  const ms = Date.now() - t0;

  assert.equal(r.status, 'sent');
  assert.ok(ms < 2000, `debía resolver en menos de 2 s y tardó ${ms} ms`);
});

test('write-service: estado NO verificado pero SIN eco → sigue siendo FALLIDO', async () => {
  // Sin eco no hay nada que sostenga el `sent`: no consta que el valor llegara al canal.
  const { service } = build({ secure: true, bridge: 'Connected', write: WRITE_ESTADO_APARTE, confirms: true, echoFails: true });
  const r = await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);

  assert.equal(r.status, 'failed');
  assert.equal(r.reason, FAIL.READBACK_UNCONFIRMED);
});

// ── ÓRDENES COMPUESTAS (La Sirena, 2026-08-15) ──────────────────────────────────────────────
//
// La válvula la mueve un relé conmutador en montaje de inversión de giro: una posición del buffer
// da el SENTIDO y otra lo quita. Escribir una sola no puede moverla — por eso la prueba de campo del
// 2026-08-03 concluyó "canal sin actuador" cuando lo que estaba incompleto era la orden.

const WRITE_SECUENCIA: WriteSpec = {
  target: { channel: 'intOut', sourceBuffer: 'INT_OUT_TEST', index: 0 },
  commands: { open: 1, close: 0 },
  sequences: {
    open: [{ index: 1, value: 0 }, { index: 0, value: 1 }],
    close: [{ index: 0, value: 0 }, { index: 1, value: 1 }],
  },
  latched: true,
  mode: 'absolute',
  pulse: null,
  readBack: { channel: 'intIn', sourceBuffer: 'INT_IN_TEST', index: 0, confirmsWrittenValue: false, expectedValue: 16385, stateVerified: false },
  timeoutMs: 60,
  rollbackValue: 0,
  permission: 'control_valves',
};

test('write-service: una orden compuesta escribe TODOS sus pasos, en orden', async () => {
  const { service, adapter } = build({ secure: true, bridge: 'Connected', write: WRITE_SECUENCIA, confirms: true });
  const r = await service.execute('sirena', { command: 'open', target: 'valve1' }, OPERADOR);

  assert.deepEqual(adapter.writes, [{ index: 1, value: 0 }, { index: 0, value: 1 }]);
  assert.equal(r.writtenValue, 1, 'writtenValue es el del canal primario');
  assert.equal(r.status, 'sent', 'el canal de estado de este sitio no está verificado');
});

// EL ORDEN ES LA SEGURIDAD, no una preferencia de estilo: si se energiza antes de soltar la
// dirección contraria, existe un instante con las dos bobinas activas — el fallo que el protocolo
// declara ERROR. Este test falla si alguien "optimiza" la secuencia reordenándola.
test('write-service: la orden compuesta DESENERGIZA antes de energizar', async () => {
  const { service, adapter } = build({ secure: true, bridge: 'Connected', write: WRITE_SECUENCIA, confirms: true });
  await service.execute('sirena', { command: 'close', target: 'valve1' }, OPERADOR);

  assert.deepEqual(adapter.writes, [{ index: 0, value: 0 }, { index: 1, value: 1 }]);
  const primerEnergizado = adapter.writes.findIndex((w) => w.value !== 0);
  assert.ok(!adapter.writes.slice(primerEnergizado + 1).some((w) => w.value === 0), 'ningún cero después de energizar');
});

test('write-service: una secuencia que energizaría dos direcciones a la vez se RECHAZA sin escribir', async () => {
  const spec: WriteSpec = { ...WRITE_SECUENCIA, sequences: { open: [{ index: 1, value: 1 }, { index: 0, value: 1 }] } };
  const { service, adapter } = build({ secure: true, bridge: 'Connected', write: spec, confirms: true });
  const r = await service.execute('sirena', { command: 'open', target: 'valve1' }, OPERADOR);

  assert.equal(r.status, 'rejected');
  assert.ok(r.reason?.startsWith(REJECT.INTERLOCK_FAILED));
  assert.equal(adapter.writes.length, 0, 'no se acciona equipo con una orden que se contradice');
});

// El eco de un solo paso no basta: si el SENTIDO no quedó puesto, el equipo no se mueve por mucho
// que la habilitación sí esté. Decir "verificado" con medio comando escrito sería el engaño exacto
// que este eco existe para evitar.
test('write-service: el eco comprueba TODOS los pasos, no solo el canal primario', async () => {
  const { service } = build({ secure: true, bridge: 'Connected', write: WRITE_SECUENCIA, confirms: false });
  const r = await service.execute('sirena', { command: 'open', target: 'valve1' }, OPERADOR);

  assert.equal(r.writeVerified, false);
  assert.equal(r.status, 'failed', 'sin eco íntegro no se concede el desenlace `sent`');
});

// Deshacer un "abrir" escribiendo 0/0 dejaría el actuador SIN DIRECCIÓN: ni abierto ni cerrado, un
// estado que nadie pidió y del que el operador no se enteraría. En una orden sostenida, lo correcto
// es dejarla puesta y que sea una persona quien mande el verbo contrario.
test('write-service: una orden SOSTENIDA no se deshace sola cuando el estado no confirma', async () => {
  const { service, adapter } = build({ secure: true, bridge: 'Connected', write: WRITE_SECUENCIA, confirms: true });
  const r = await service.execute('sirena', { command: 'open', target: 'valve1' }, OPERADOR);

  assert.equal(r.status, 'sent');
  assert.equal(adapter.writes.length, 2, 'los 2 pasos y ni un write más: sin rollback');
});

test('write-service: una orden compuesta NO sostenida se deshace en orden INVERSO', async () => {
  const spec: WriteSpec = { ...WRITE_SECUENCIA, latched: false, readBack: { ...WRITE_SECUENCIA.readBack, stateVerified: true } };
  const { service, adapter } = build({ secure: true, bridge: 'Connected', write: spec, confirms: true });
  const r = await service.execute('sirena', { command: 'open', target: 'valve1' }, OPERADOR);

  assert.equal(r.status, 'failed');
  assert.deepEqual(
    adapter.writes.map((w) => w.index),
    [1, 0, 0, 1],
    'se escribe 1→0 y se suelta 0→1: soltar primero lo último puesto evita pasar por dos direcciones activas',
  );
  assert.deepEqual(adapter.writes.slice(2).map((w) => w.value), [0, 0]);
});

// ── SEÑAL SOSTENIDA HASTA LA REALIMENTACIÓN (La Vorágine, 2026-08-15) ───────────────────────
//
// La válvula es motorizada: la señal debe mantenerse durante todo el recorrido y soltarse cuando el
// PLC avisa (INT_IN[1] == 1). El pulso ciego de 300 ms arrancaba el movimiento y lo cortaba a mitad.

/** Adaptador cuya realimentación pasa a valer `equals` tras N lecturas (emula el recorrido). */
function adapterConRealimentacion(opts: { lecturasHastaLlegar: number | null }): FakeAdapter {
  const store = new Map<string, number | boolean>();
  let lecturasFeedback = 0;
  const key = (t: { plantId: string; channel: string; sourceBuffer: string; index: number }) =>
    `${t.plantId}/${t.channel}/${t.sourceBuffer}[${t.index}]`;
  const adapter = {
    writes: [] as Array<{ index: number; value: number | boolean }>,
    getWriteSecurity: () => ({ secure: true, securityMode: 'SignAndEncrypt', identity: 'username' }),
    getBridgeStatus: () => 'Connected' as BridgeStatus,
    async writeBufferElement(t: { plantId: string; channel: string; sourceBuffer: string; index: number }, v: number | boolean) {
      adapter.writes.push({ index: t.index, value: v });
      store.set(key(t), v);
    },
    async readBufferElement(t: { plantId: string; channel: string; sourceBuffer: string; index: number }) {
      if (t.sourceBuffer === 'INT_IN_TEST' && t.index === 1) {
        lecturasFeedback += 1;
        const llego = opts.lecturasHastaLlegar !== null && lecturasFeedback >= opts.lecturasHastaLlegar;
        // 1025 es el valor real leído en planta: tiene el bit0 puesto y NO vale 1.
        return { value: llego ? 1 : 1025, quality: 'Good' as const, sourceTimestamp: null };
      }
      return { value: store.get(key(t)) ?? 0, quality: 'Good' as const, sourceTimestamp: null };
    },
  };
  return adapter as unknown as FakeAdapter;
}

const WRITE_SOSTENIDO: WriteSpec = {
  ...WRITE,
  target: { channel: 'intOut', sourceBuffer: 'INT_OUT_TEST', index: 0 },
  mode: 'bitmask',
  commands: { open: 4096, close: 8192 },
  pulse: {
    holdMs: 3000,
    until: { channel: 'intIn', sourceBuffer: 'INT_IN_TEST', index: 1, equals: 1 },
  },
  readBack: { channel: 'intIn', sourceBuffer: 'INT_IN_TEST', index: 0, confirmsWrittenValue: false, expectedValue: 16385, stateVerified: false },
};

function buildSostenido(lecturasHastaLlegar: number | null) {
  const adapter = adapterConRealimentacion({ lecturasHastaLlegar });
  const audit = fakeAudit();
  const service = new WriteService(
    adapter, fakeConfig(true), fakeCache(snap('live')), fakeResolver(WRITE_SOSTENIDO), fakeRepo(), audit.service,
    fakeFirmas(), fakeAvisos(),
  );
  return { service, adapter, audit };
}

test('write-service: la señal se sostiene hasta que la realimentación vale 1, y entonces se suelta', async () => {
  const { service, adapter } = buildSostenido(3);
  const r = await service.execute('voragine', { command: 'open', target: 'valve1' }, OPERADOR);

  assert.equal(adapter.writes.length, 2, 'activación + limpieza del bit');
  assert.equal(adapter.writes[0].value, 4096);
  assert.equal(Number(adapter.writes[1].value) & 4096, 0, 'el bit del comando queda LIMPIO');
  assert.notEqual(r.reason, FAIL.HOLD_FEEDBACK_TIMEOUT, 'la realimentación SÍ llegó');
});

// 1025 = bits{0,10} es el valor real de INT_IN[1] en planta. Si la condición se hubiera escrito
// como "bit0 encendido" se cumpliría desde el primer instante y la señal se cortaría antes de que
// la válvula se moviera. Por eso se compara el VALOR ENTERO.
test('write-service: 1025 NO satisface la realimentación aunque tenga el bit0 puesto', async () => {
  const { service, adapter } = buildSostenido(null); // nunca llega a 1
  const t0 = Date.now();
  const r = await service.execute('voragine', { command: 'open', target: 'valve1' }, OPERADOR);

  assert.ok(Date.now() - t0 >= 3000, 'debió sostener hasta agotar el tope, no cortar al ver el bit0');
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, FAIL.HOLD_FEEDBACK_TIMEOUT, 'se dice que faltó la realimentación, no que el estado no confirmara');
});

// LO QUE MÁS IMPORTA DE TODO EL SOSTENIDO: pase lo que pase, el bit se suelta. Dejarlo puesto
// mantiene la bobina energizada, y eso no puede depender de que la maniobra haya salido bien.
test('write-service: aunque la realimentación no llegue NUNCA, el bit se limpia igual', async () => {
  const { service, adapter } = buildSostenido(null);
  await service.execute('voragine', { command: 'open', target: 'valve1' }, OPERADOR);

  assert.equal(adapter.writes.length, 2, 'activación + limpieza, incluso tras agotar el tope');
  assert.equal(Number(adapter.writes[1].value) & 4096, 0, 'la bobina NO se queda energizada');
});

// Con 300 ms la ventana era despreciable; con decenas de segundos caben dos órdenes opuestas, y en
// `bitmask` eso deja los bits 12 y 13 energizados a la vez — el fallo que el protocolo declara ERROR.
test('write-service: una segunda orden sobre la MISMA válvula se rechaza mientras la primera está en curso', async () => {
  const { service, adapter } = buildSostenido(null);
  const primera = service.execute('voragine', { command: 'open', target: 'valve1' }, OPERADOR);
  const segunda = await service.execute('voragine', { command: 'close', target: 'valve1' }, OPERADOR);

  assert.equal(segunda.status, 'rejected');
  assert.ok(segunda.reason?.startsWith(REJECT.INTERLOCK_FAILED));
  assert.equal(httpStatusForCommand(segunda), 409);

  await primera;
  const bits = adapter.writes.map((w) => Number(w.value));
  assert.ok(!bits.some((v) => (v & 4096) !== 0 && (v & 8192) !== 0), 'jamás los dos sentidos a la vez');
});

// Si el cerrojo no se liberara, esa válvula quedaría bloqueada hasta reiniciar el proceso.
test('write-service: el cerrojo se libera al terminar, aunque la orden acabe en fallo', async () => {
  const { service } = buildSostenido(null);
  const primera = await service.execute('voragine', { command: 'open', target: 'valve1' }, OPERADOR);
  assert.equal(primera.status, 'failed');

  const segunda = await service.execute('voragine', { command: 'open', target: 'valve1' }, OPERADOR);
  assert.notEqual(segunda.status, 'rejected', 'la válvula debe poder volver a comandarse');
});

test('write-service: idempotencia — misma idempotencyKey NO re-ejecuta', async () => {
  const adapter = fakeAdapter({ secure: true, bridge: 'Connected', confirms: true });
  const audit = fakeAudit();
  const service = new WriteService(
    adapter, fakeConfig(true), fakeCache(snap('live')), fakeResolver(WRITE), fakeRepo(), audit.service,
    fakeFirmas(), fakeAvisos(),
  );

  const first = await service.execute('voragine', { command: 'openValve', target: 'valveEV01', idempotencyKey: 'k1' }, OPERADOR);
  const second = await service.execute('voragine', { command: 'openValve', target: 'valveEV01', idempotencyKey: 'k1' }, OPERADOR);

  assert.equal(first.status, 'confirmed');
  assert.equal(first.idempotent, false);
  assert.equal(second.status, 'confirmed');
  assert.equal(second.idempotent, true);
  assert.equal(adapter.writes.length, 1, 'el comando NO debe re-ejecutarse con la misma idempotencyKey');
});

test('write-service: audit log SIEMPRE, incluso en rechazos', async () => {
  const { service, audit } = build({ secure: false, bridge: 'Connected' });
  await service.execute('voragine', { command: 'openValve', target: 'valveEV01' }, OPERADOR);
  assert.equal(audit.calls.length, 1);
  assert.equal(audit.calls[0].eventType, 'command.execute');
  assert.equal(audit.calls[0].statusCode, 403);
  assert.equal(audit.calls[0].role, 'operador');
});

// ── Cobertura del SimulatorBridgeAdapter real (regla 5: probar contra el simulador) ──

function simConfig(secure: boolean): OpcUaConfig {
  return {
    securityMode: secure ? 'SignAndEncrypt' : 'None',
    identity: secure ? { type: 'username', userName: 'u', password: 'p' } : { type: 'anonymous' },
    watchdogTimeoutMs: 30000,
    coalesceWindowMs: 1000,
    heartbeatIntervalMs: 10000,
    heartbeatMaxFailures: 2,
    publishingIntervalMs: 2000,
    samplingIntervalMs: 1000,
    subscriptionRecycleMaxAttempts: 3,
  } as unknown as OpcUaConfig;
}

const EMPTY_MAPPING: LoadedMapping = {
  version: '1.0.0', protocolVersion: 'v2', dtoVersion: 'v1', plants: [], targets: [], signals: [], raw: {},
};

test('simulator: getWriteSecurity refleja SignAndEncrypt + identidad no anónima', () => {
  const secure = new SimulatorBridgeAdapter(simConfig(true), EMPTY_MAPPING);
  const insecure = new SimulatorBridgeAdapter(simConfig(false), EMPTY_MAPPING);
  assert.equal(secure.getWriteSecurity().secure, true);
  assert.equal(insecure.getWriteSecurity().secure, false);
});

test('simulator: write + read-back hacen echo; setWriteConfirms(false) fuerza mismatch', async () => {
  const sim = new SimulatorBridgeAdapter(simConfig(true), EMPTY_MAPPING);
  const target = { plantId: 'voragine', channel: 'intOut', sourceBuffer: 'INT_OUT_TEST', index: 3 };
  await sim.writeBufferElement(target, 1);
  assert.equal((await sim.readBufferElement(target)).value, 1);
  sim.setWriteConfirms(false);
  assert.notEqual((await sim.readBufferElement(target)).value, 1);
});
