/**
 * Probador de canales: escribir en el PLC para averiguar qué hace ese canal.
 *
 * **El test que justifica que esta herramienta exista es «suelta siempre».** Todo lo demás de este
 * archivo es higiene; ese es el que separa una prueba de campo de una bobina energizada que nadie
 * sabe que quedó puesta. Se comprueba por los cuatro caminos por los que se puede salir de la
 * función: bien, con el eco roto, con la liberación fallando a la primera, y con la liberación
 * fallando del todo.
 *
 * El contexto real: Carbonero no tiene caudal, ni presión, ni palabra de estado, y su mapping lleva
 * `open: 4096` heredado de Vorágine y jamás validado allí. La codificación hay que capturarla, y
 * capturarla implica escribir. Esto es lo que hace que escribir sea admisible.
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditEntry, AuditLogService } from '../src/infrastructure/audit/audit-log.service';
import type { ConnectivityConfig, OpcUaConfig } from '../src/infrastructure/connectivity/connectivity.config';
import type { LoadedMapping, WriteSpec } from '../src/infrastructure/connectivity/mapping/opc-mapping.loader';
import type { PlantPipelineService } from '../src/infrastructure/connectivity/pipeline/plant-pipeline.service';
import type { BufferElementTarget, ConnectivityAdapter, RawBufferSample } from '../src/infrastructure/connectivity/ports/connectivity-adapter.port';
import type { WriteService } from '../src/modules/commands/write.service';
import type { CommandActor } from '../src/modules/commands/command.dto';
import { ChannelProbeService } from '../src/modules/commands/channel-probe.service';
import {
  cambiosEntre,
  validarProbe,
  valvulasAfectadas,
  type FotoBuffers,
  type ProbeRequest,
} from '../src/modules/commands/channel-probe';

// ── Fixtures ────────────────────────────────────────────────────────────────────

const WRITE: WriteSpec = {
  target: { channel: 'intOut', sourceBuffer: 'INT_OUT_CARBONERO', index: 0 },
  commands: { open: 4096 },
  readBack: { channel: 'intIn', sourceBuffer: 'INT_IN_CARBONERO', index: 1, confirmsWrittenValue: false, stateVerified: false },
  timeoutMs: 3000,
  rollbackValue: 0,
  permission: 'control_valves',
  mode: 'bitmask',
  pulse: { holdMs: 300 },
};

function mapping(): LoadedMapping {
  return {
    version: '0.14.0',
    protocolVersion: 'v2',
    dtoVersion: 'v1',
    plants: [{ plantId: 'carbonero', displayName: 'Carbonero', livenessWindowSec: null }],
    targets: [
      { plantId: 'carbonero', browseName: 'REAL_IN_CARBONERO', channel: 'realIn', node: { nsUri: 'AQUATECH4', identifier: 'g=RI' }, arrayLength: 50, dataType: 'Float' },
      { plantId: 'carbonero', browseName: 'INT_IN_CARBONERO', channel: 'intIn', node: { nsUri: 'AQUATECH4', identifier: 'g=II' }, arrayLength: 20, dataType: 'Int16' },
      { plantId: 'carbonero', browseName: 'INT_OUT_CARBONERO', channel: 'intOut', node: { nsUri: 'AQUATECH4', identifier: 'g=IO' }, arrayLength: 20, dataType: 'Int16' },
    ],
    signals: [
      { plantId: 'carbonero', buffer: 'realIn', index: 5, domainKey: 'tank1Level', label: 'Nivel tanque 1', unit: 'm', min: 0, max: 10, mappingStatus: 'mapped', confidence: 'inferred', writable: false },
      { plantId: 'carbonero', buffer: 'intIn', sourceBuffer: 'INT_IN_CARBONERO', index: 1, domainKey: 'valve1State', label: 'Estado valvula 1', unit: null, min: null, max: null, mappingStatus: 'mapped', confidence: 'inferred', writable: false },
      { plantId: 'carbonero', buffer: 'intOut', sourceBuffer: 'INT_OUT_CARBONERO', index: 0, domainKey: 'valve1', label: 'Valvula 1', unit: null, min: null, max: null, mappingStatus: 'mapped', confidence: 'confirmed', writable: true, write: WRITE },
    ],
    raw: {},
  };
}

const PROBE: ProbeRequest = {
  channel: 'intOut',
  sourceBuffer: 'INT_OUT_CARBONERO',
  index: 0,
  value: 4096,
  holdMs: 5,
};

const ACTOR: CommandActor = {
  userId: 'u1',
  userName: 'Admin',
  userEmail: 'admin@x.co',
  role: 'admin',
  ip: '10.0.0.1',
};

function config(): ConnectivityConfig {
  const opcua = { writesEnabled: true, allowInsecureWrites: false } as unknown as OpcUaConfig;
  return { provider: 'opcua', opcua, liveness: { liveSec: 10, windowSec: 300, sweepMs: 1000 }, deadLetterCapacity: 100 };
}

interface Espia {
  writes: { index: number; value: number | boolean }[];
}

/**
 * Adaptador de mentira con un almacén por elemento.
 *  - `echoThrows`: la lectura del eco revienta (2ª lectura).
 *  - `releaseFailsVeces`: las N primeras escrituras de LIBERACIÓN fallan (prueba los reintentos).
 *  - `writeThrows`: la escritura inicial la rechaza el servidor.
 *  - `prevThrows`: no se puede leer el valor previo.
 */
function fakeAdapter(opts: {
  secure?: boolean;
  echoThrows?: boolean;
  releaseFailsVeces?: number;
  writeThrows?: boolean;
  prevThrows?: boolean;
} = {}): ConnectivityAdapter & Espia {
  const store = new Map<string, number | boolean>();
  const key = (t: BufferElementTarget) => `${t.plantId}/${t.sourceBuffer}[${t.index}]`;
  let lecturas = 0;
  let escrituras = 0;
  let fallosLiberacion = opts.releaseFailsVeces ?? 0;

  const adapter = {
    writes: [] as { index: number; value: number | boolean }[],
    getWriteSecurity: () => ({
      secure: opts.secure !== false,
      securityMode: 'SignAndEncrypt',
      identity: 'username',
    }),
    getBridgeStatus: () => 'Connected',
    async writeBufferElement(t: BufferElementTarget, v: number | boolean) {
      escrituras += 1;
      // La 1ª escritura es la del sondeo; las siguientes son intentos de liberación.
      if (escrituras === 1 && opts.writeThrows) throw new Error('BadUserAccessDenied');
      if (escrituras > 1 && fallosLiberacion > 0) {
        fallosLiberacion -= 1;
        throw new Error('la liberación falló');
      }
      adapter.writes.push({ index: t.index, value: v });
      store.set(key(t), v);
    },
    async readBufferElement(t: BufferElementTarget) {
      lecturas += 1;
      if (lecturas === 1 && opts.prevThrows) throw new Error('no se pudo leer el previo');
      if (lecturas === 2 && opts.echoThrows) throw new Error('el eco falló');
      const v = store.get(key(t));
      return { value: v === undefined ? 0 : v, quality: 'Good' as const, statusCode: 'Good', sourceTimestamp: null, serverTimestamp: null };
    },
  } as unknown as ConnectivityAdapter & Espia;
  return adapter;
}

function muestra(browseName: string, channel: string, values: (number | boolean)[]): RawBufferSample {
  return { browseName, channel, values, quality: 'Good', statusCode: 'Good', sourceTimestamp: null, serverTimestamp: null };
}

/** Pipeline de mentira: el mapeo y las últimas muestras, que es todo lo que usa el probador. */
function fakePipeline(buffers?: Map<string, RawBufferSample>): PlantPipelineService {
  return {
    getMapping: () => mapping(),
    getLatestBuffers: () => buffers,
  } as unknown as PlantPipelineService;
}

function fakeWrites(): WriteService & { tomadas: Set<string> } {
  const tomadas = new Set<string>();
  return {
    tomadas,
    reservar(claves: string[]) {
      if (claves.some((c) => tomadas.has(c))) return false;
      for (const c of claves) tomadas.add(c);
      return true;
    },
    liberar(claves: string[]) {
      for (const c of claves) tomadas.delete(c);
    },
  } as unknown as WriteService & { tomadas: Set<string> };
}

function fakeAudit(): AuditLogService & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    async record(e: AuditEntry) {
      entries.push(e);
    },
  } as unknown as AuditLogService & { entries: AuditEntry[] };
}

function servicio(opts: Parameters<typeof fakeAdapter>[0] = {}, buffers?: Map<string, RawBufferSample>) {
  const adapter = fakeAdapter(opts);
  const writes = fakeWrites();
  const audit = fakeAudit();
  const svc = new ChannelProbeService(adapter, config(), fakePipeline(buffers), writes, audit);
  return { svc, adapter, writes, audit };
}

// ── Validación pura ─────────────────────────────────────────────────────────────

test('probe: NO se escribe en un canal de entrada', () => {
  // Escribir en un buffer de entrada no prueba nada de la planta: corrompe la lectura que el
  // operador está mirando en ese momento.
  const v = validarProbe(mapping(), 'carbonero', { ...PROBE, channel: 'realIn', sourceBuffer: 'REAL_IN_CARBONERO' });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.motivo, 'CANAL_NO_ES_DE_SALIDA');
});

test('probe: buffer desconocido y buffer de otro canal', () => {
  const a = validarProbe(mapping(), 'carbonero', { ...PROBE, sourceBuffer: 'INT_OUT_OTRA_PLANTA' });
  assert.equal(a.ok === false && a.motivo, 'BUFFER_DESCONOCIDO');
  const b = validarProbe(mapping(), 'carbonero', { ...PROBE, sourceBuffer: 'INT_IN_CARBONERO' });
  assert.equal(b.ok === false && b.motivo, 'BUFFER_DE_OTRO_CANAL');
});

test('probe: el índice tiene que caber en el buffer declarado', () => {
  const malo = validarProbe(mapping(), 'carbonero', { ...PROBE, index: 20 });
  assert.equal(malo.ok === false && malo.motivo, 'INDICE_FUERA_DE_RANGO');
  assert.match(malo.ok === false ? malo.detalle : '', /19/);
  assert.equal(validarProbe(mapping(), 'carbonero', { ...PROBE, index: 19 }).ok, true);
});

test('probe: el sostenido está acotado a 5 s', () => {
  // El tope es la red de seguridad: un olvido, una desconexión o cerrar la app no pueden dejar una
  // salida energizada más que eso.
  assert.equal(validarProbe(mapping(), 'carbonero', { ...PROBE, holdMs: 5001 }).ok, false);
  assert.equal(validarProbe(mapping(), 'carbonero', { ...PROBE, holdMs: 0 }).ok, false);
  assert.equal(validarProbe(mapping(), 'carbonero', { ...PROBE, holdMs: 5000 }).ok, true);
});

test('probe: valor no finito se rechaza', () => {
  assert.equal(validarProbe(mapping(), 'carbonero', { ...PROBE, value: Number.NaN }).ok, false);
  assert.equal(validarProbe(mapping(), 'carbonero', { ...PROBE, value: true }).ok, true);
});

test('probe: una palabra con válvulas de señal SOSTENIDA no se sondea (La Vorágine, integrador 2026-10-16)', () => {
  // El probador escribe en ABSOLUTO durante el sostenido. En INT_OUT_VORAGINE[0] eso rompería la
  // regla del integrador —siempre abrir o cerrar de cada válvula, nunca los dos ni ninguno— aunque
  // después se soltara: cualquier valor de prueba deja algún par en 0/0 o en 1/1.
  const m = mapping();
  const sostenida: WriteSpec = { ...WRITE, commands: { open: 4096, close: 8192 }, sustained: true, pulse: null, rollbackValue: undefined };
  const entrada: WriteSpec = { ...sostenida, commands: { open: 4, close: 8 } };
  m.signals = m.signals.map((s) => (s.domainKey === 'valve1' ? { ...s, label: 'Válvula de salida', write: sostenida } : s));
  m.signals.push({ ...m.signals.find((s) => s.domainKey === 'valve1')!, index: 1, domainKey: 'valve2', label: 'Válvula de entrada', write: entrada });

  const v = validarProbe(m, 'carbonero', PROBE);
  assert.equal(v.ok === false && v.motivo, 'SENAL_SOSTENIDA');
  assert.match(v.ok === false ? v.detalle : '', /Válvula de salida y Válvula de entrada/);
  // Otra posición del mismo buffer sí: allí no manda ninguna válvula sostenida.
  assert.equal(validarProbe(m, 'carbonero', { ...PROBE, index: 1 }).ok, true);
  // Y una válvula de pulso en esa misma palabra se sigue pudiendo sondear (el caso de Carbonero).
  assert.equal(validarProbe(mapping(), 'carbonero', PROBE).ok, true);
});

test('probe: se identifican las válvulas que mandan por ese elemento', () => {
  // Es lo que permite bloquearlas mientras dura la prueba.
  assert.deepEqual(valvulasAfectadas(mapping(), 'carbonero', PROBE), ['valve1']);
  assert.deepEqual(valvulasAfectadas(mapping(), 'carbonero', { ...PROBE, index: 7 }), []);
});

test('probe: los cambios observados ignoran el elemento sondeado y nombran quién los lee', () => {
  const antes: FotoBuffers = new Map([
    ['INT_OUT_CARBONERO', [0, 0]],
    ['INT_IN_CARBONERO', [0, 0]],
  ]);
  const despues: FotoBuffers = new Map([
    ['INT_OUT_CARBONERO', [4096, 0]],
    ['INT_IN_CARBONERO', [0, 16385]],
  ]);
  const cambios = cambiosEntre(antes, despues, mapping(), 'carbonero', PROBE);
  assert.equal(cambios.length, 1, 'el propio índice sondeado no es un hallazgo');
  assert.equal(cambios[0].browseName, 'INT_IN_CARBONERO');
  assert.equal(cambios[0].index, 1);
  assert.equal(cambios[0].a, 16385);
  assert.equal(cambios[0].domainKey, 'valve1State', 'nombrar quién lo lee es lo que hace legible el hallazgo');
});

// ── El servicio: la garantía de que SUELTA ──────────────────────────────────────

test('probe: camino feliz — escribe, verifica el eco y DEJA el valor anterior', async () => {
  const { svc, adapter } = servicio();
  const r = await svc.probar('carbonero', PROBE, ACTOR);

  assert.equal(r.status, 'done');
  assert.equal(r.writeVerified, true, 'el eco prueba que el valor entró');
  assert.equal(r.released, true);
  assert.equal(r.releasedValue, 0, 'la salida vuelve a lo que había');
  assert.deepEqual(
    adapter.writes.map((w) => w.value),
    [4096, 0],
    'se escribió el valor de prueba y después el original',
  );
});

test('probe: SUELTA aunque el eco falle', async () => {
  // Un fallo leyendo el eco no puede impedir la liberación: sin este test, un `return` temprano
  // dejaría el valor puesto y el resultado diría que todo fue bien.
  const { svc, adapter } = servicio({ echoThrows: true });
  const r = await svc.probar('carbonero', PROBE, ACTOR);

  assert.equal(r.writeVerified, null, 'no se afirma nada que no se haya podido leer');
  assert.equal(r.released, true);
  assert.deepEqual(adapter.writes.map((w) => w.value), [4096, 0]);
});

test('probe: SUELTA a la segunda si la primera liberación falla', async () => {
  // Reintentar es lo que convierte un fallo transitorio del servidor OPC en un no-evento.
  const { svc, adapter } = servicio({ releaseFailsVeces: 1 });
  const r = await svc.probar('carbonero', PROBE, ACTOR);

  assert.equal(r.released, true);
  assert.equal(r.status, 'done');
  assert.deepEqual(adapter.writes.map((w) => w.value), [4096, 0], 'el 0 acabó escrito');
});

test('probe: si NO se puede soltar, el resultado es FALLIDO y lo dice a gritos', async () => {
  // El peor final posible, y tiene que ser inconfundible: nunca 200, nunca `done`.
  const { svc } = servicio({ releaseFailsVeces: 99 });
  const r = await svc.probar('carbonero', PROBE, ACTOR);

  assert.equal(r.status, 'failed');
  assert.equal(r.released, false);
  assert.match(r.reason ?? '', /NO_SE_PUDO_SOLTAR/);
  assert.match(r.reason ?? '', /ATIENDE LA PLANTA/);
});

test('probe: sin poder leer el valor previo NO se escribe nada', async () => {
  // Sin valor previo no hay a dónde volver, así que esto dejaría de ser una prueba y pasaría a ser
  // un cambio permanente a ciegas.
  const { svc, adapter } = servicio({ prevThrows: true });
  const r = await svc.probar('carbonero', PROBE, ACTOR);

  assert.equal(r.status, 'rejected');
  assert.match(r.reason ?? '', /SIN_VALOR_PREVIO/);
  assert.equal(adapter.writes.length, 0, 'ni una escritura');
});

test('probe: escritura rechazada por el servidor → fallido, y nada que soltar', async () => {
  const { svc, adapter } = servicio({ writeThrows: true });
  const r = await svc.probar('carbonero', PROBE, ACTOR);

  assert.equal(r.status, 'failed');
  assert.match(r.reason ?? '', /WRITE_REJECTED/);
  assert.equal(adapter.writes.length, 0);
});

// ── Precondiciones duras ────────────────────────────────────────────────────────

test('probe: sesión insegura → rechazado sin escribir', async () => {
  const { svc, adapter } = servicio({ secure: false });
  const r = await svc.probar('carbonero', PROBE, ACTOR);
  assert.equal(r.status, 'rejected');
  assert.match(r.reason ?? '', /WRITES_DISABLED_INSECURE_SESSION/);
  assert.equal(adapter.writes.length, 0);
});

test('probe: un rol sin los DOS permisos no sondea', async () => {
  // Sondear es más peligroso que accionar una válvula ya mapeada: puede mover equipo que nadie ha
  // declarado. Se exigen control_valves Y system_config.
  const { svc, adapter } = servicio();
  for (const role of ['jefe', 'operador', 'civil']) {
    const r = await svc.probar('carbonero', PROBE, { ...ACTOR, role });
    assert.equal(r.status, 'rejected', `${role} no debería poder sondear`);
    assert.match(r.reason ?? '', /FORBIDDEN/);
  }
  assert.equal(adapter.writes.length, 0);
});

// ── Cerrojo compartido con las órdenes de válvula ───────────────────────────────

test('probe: bloquea la válvula que manda por ese elemento y la libera al terminar', async () => {
  const { svc, writes } = servicio();
  const r = await svc.probar('carbonero', PROBE, ACTOR);

  assert.deepEqual(r.valvesLocked, ['valve1']);
  assert.equal(writes.tomadas.size, 0, 'al terminar no queda nada reservado');
});

test('probe: con una orden en curso sobre esa válvula, el sondeo se rechaza', async () => {
  // Sin este cerrojo compartido, una orden en máscara solapada con la escritura absoluta del
  // probador dejaría la palabra con las DOS direcciones energizadas — lo que el protocolo de estas
  // plantas declara ERROR.
  const { svc, writes, adapter } = servicio();
  writes.reservar(['carbonero/valve1']);

  const r = await svc.probar('carbonero', PROBE, ACTOR);
  assert.equal(r.status, 'rejected');
  assert.match(r.reason ?? '', /IN_PROGRESS/);
  assert.equal(adapter.writes.length, 0);
});

// ── Auditoría ───────────────────────────────────────────────────────────────────

test('probe: queda auditado SIEMPRE, también cuando se rechaza', async () => {
  // En estas plantas no hay confirmación eléctrica: el registro es la única evidencia.
  const ok = servicio();
  await ok.svc.probar('carbonero', PROBE, ACTOR);
  assert.equal(ok.audit.entries.length, 1);
  assert.equal(ok.audit.entries[0].eventType, 'channel.probe');
  assert.equal(ok.audit.entries[0].userEmail, 'admin@x.co');

  const no = servicio({ secure: false });
  await no.svc.probar('carbonero', PROBE, ACTOR);
  assert.equal(no.audit.entries.length, 1, 'un rechazo también se registra');
});

test('probe: la auditoría lleva el valor escrito y si se soltó', async () => {
  const { svc, audit } = servicio({ releaseFailsVeces: 99 });
  await svc.probar('carbonero', PROBE, ACTOR);
  const detalle = audit.entries[0].detail as Record<string, unknown>;
  assert.equal(detalle.requestedValue, 4096);
  assert.equal(detalle.released, false, 'que no se soltó tiene que quedar escrito');
  assert.equal(detalle.index, 0);
  assert.equal(detalle.sourceBuffer, 'INT_OUT_CARBONERO');
});

// ── Lo observado ────────────────────────────────────────────────────────────────

test('probe: distingue «no se vio nada» de «no cambió nada»', async () => {
  // Sin muestras que mirar, `observed` vacío NO significa que el canal no haga nada. Decirlo al
  // revés convertiría una prueba ciega en una prueba negativa, que es peor que no probar.
  const sinMuestras = servicio({}, undefined);
  const a = await sinMuestras.svc.probar('carbonero', PROBE, ACTOR);
  assert.equal(a.sampled, false);
  assert.deepEqual(a.observed, []);

  const conMuestras = servicio(
    {},
    new Map([['INT_IN_CARBONERO', muestra('INT_IN_CARBONERO', 'intIn', [0, 0])]]),
  );
  const b = await conMuestras.svc.probar('carbonero', PROBE, ACTOR);
  assert.equal(b.sampled, true);
});
