/**
 * La herramienta de campo de La Vorágine (scripts/test-valvulas-voragine.ts) y el adaptador OPC UA del
 * backend, contra un servidor OPC UA LOCAL (127.0.0.1) — nunca contra el PLC. Lo que la prueba pura
 * (voragine-valvulas-bits.test.ts) no puede ver: que se conecta como el backend (None/None + usuario,
 * como en producción), resuelve los GUID del mapping y el namespace, escribe UN elemento con el MISMO
 * método que el backend, relee, observa, registra, y no limpia nada al salir.
 *
 * EMULACIÓN DE OPTIX, explícita: FactoryTalk Optix acepta la escritura del backend —Variant Int32 con
 * IndexRange sobre un array Int16— y la convierte (StatusCode Good, eco 25/25 y testigo independiente,
 * docs/archivo/PRUEBA_VALVULA_SIRENA.md, 2026-07-30). El servidor de node-opcua es más estricto y la
 * rechaza con BadTypeMismatch, así que aquí se intercepta `writeAttribute` del INT_OUT para hacer lo que
 * hace Optix: convertir a Int16, y rechazar con BadOutOfRange lo que no cabe (supuesto conservador).
 * Lo que se pide al servidor —tipo, rango, valores— queda registrado y se comprueba.
 */
import 'reflect-metadata';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import {
  DataType,
  MessageSecurityMode,
  OPCUAServer,
  SecurityPolicy,
  StatusCodes,
  Variant,
  VariantArrayType,
  WriteValue,
  type UAVariable,
  type WriteValueOptions,
} from 'node-opcua';
import { OpcUaConnectivityAdapter } from '../src/infrastructure/connectivity/adapters/opcua/opcua-connectivity.adapter';
import { loadConnectivityConfig } from '../src/infrastructure/connectivity/connectivity.config';
import { loadMapping, type LoadedMapping } from '../src/infrastructure/connectivity/mapping/opc-mapping.loader';
import { CODIGO, ejecutar } from '../scripts/test-valvulas-voragine';

Logger.overrideLogger(false);

const PUERTO = 48433;
const ENDPOINT = `opc.tcp://127.0.0.1:${PUERTO}`;
const USUARIO = 'ptap-voragine-test';
const CLAVE = 'clave-solo-para-la-suite-local';
const RUTA_MAPPING = join(__dirname, '..', 'config', 'opc_mapping.json');

/** Lo que el servidor recibió en cada escritura sobre INT_OUT_VORAGINE, ANTES de convertir nada. */
const peticiones: Array<{ dataType: string; indexRange: string; valores: number[]; status: string }> = [];
let server: OPCUAServer;
let mando: UAVariable;
const entornoPrevio = new Map<string, string | undefined>();

function palabra(): number {
  return (mando.readValue().value.value as Int16Array)[0];
}

function ponerPalabra(v: number): void {
  const arr = Int16Array.from(mando.readValue().value.value as Int16Array);
  arr[0] = v;
  mando.setValueFromSource(new Variant({ dataType: DataType.Int16, arrayType: VariantArrayType.Array, value: arr }));
}

before(async () => {
  // Producción: OPC_SECURITY_MODE=None, OPC_SECURITY_POLICY=None, OPC_IDENTITY=username. Aquí igual. El
  // endpoint va TAMBIÉN en OPC_ENDPOINT: si un argumento se perdiera, no hay otro sitio adonde conectar.
  const vars: Record<string, string> = {
    OPC_ENDPOINT: ENDPOINT,
    OPC_ENDPOINT_MUST_EXIST: 'false',
    OPC_SECURITY_MODE: 'None',
    OPC_SECURITY_POLICY: 'None',
    OPC_IDENTITY: 'username',
    OPC_USERNAME: USUARIO,
    OPC_PASSWORD: CLAVE,
    OPC_AUTO_ACCEPT_UNKNOWN_CERTIFICATE: 'true',
  };
  for (const [k, v] of Object.entries(vars)) {
    entornoPrevio.set(k, process.env[k]);
    process.env[k] = v;
  }

  server = new OPCUAServer({
    port: PUERTO,
    hostname: '127.0.0.1',
    securityModes: [MessageSecurityMode.None],
    // Basic256Sha256 solo para que el endpoint None ofrezca usuario y contraseña (cifrada con el
    // certificado del servidor): node-opcua no lo ofrece sin una política con la que cifrarla.
    securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256],
    allowAnonymous: false,
    userManager: { isValidUser: (u: string, p: string) => u === USUARIO && p === CLAVE },
  });
  await server.initialize();
  const espacio = server.engine.addressSpace!;
  const ns = espacio.registerNamespace('AQUATECH4');
  const variable = (browseName: string, nodeId: string, dataType: 'Int16' | 'Float', valores: Int16Array | Float32Array) =>
    ns.addVariable({
      organizedBy: espacio.rootFolder.objects,
      browseName,
      nodeId,
      dataType,
      valueRank: 1,
      arrayDimensions: [valores.length],
      accessLevel: 'CurrentRead | CurrentWrite',
      userAccessLevel: 'CurrentRead | CurrentWrite',
      value: { dataType: dataType === 'Int16' ? DataType.Int16 : DataType.Float, arrayType: VariantArrayType.Array, value: valores },
    });
  // Los GUID son los del mapping real: si alguien los cambia allí, la herramienta no los encontraría aquí.
  mando = variable('INT_OUT_VORAGINE', 'g=1505CBA4-0BCF-A4FC-7602-DB5BF940BBC6', 'Int16', new Int16Array(20));
  const estado = new Int16Array(20);
  estado.set([7192, 1025, 0]);
  variable('INT_IN_VORAGINE', 'g=002A5DBD-381A-F691-1071-4BFF23ED007C', 'Int16', estado);
  const proceso = new Float32Array(50);
  proceso[0] = 6.93;
  proceso[5] = 1.52;
  proceso[7] = 1.61;
  variable('REAL_IN_VORAGINE', 'g=93BAFF92-FF57-4877-74E4-B7CC1EFAE6B3', 'Float', proceso);

  // La firma de `writeAttribute` está sobrecargada (callback o promesa); el servidor usa la de callback.
  type EscribirAtributo = (context: unknown, opciones: WriteValue | WriteValueOptions, callback: (err: Error | null, sc?: unknown) => void) => void;
  const original = mando.writeAttribute.bind(mando) as unknown as EscribirAtributo;
  const emulado: EscribirAtributo = (context, opciones, callback) => {
    const wv = opciones instanceof WriteValue ? opciones : new WriteValue(opciones);
    const v = wv.value?.value;
    const valores = Array.from((v?.value ?? []) as ArrayLike<number>);
    const registro = { dataType: DataType[v?.dataType ?? DataType.Null], indexRange: String(wv.indexRange?.toString() ?? ''), valores, status: 'Good' };
    peticiones.push(registro);
    if (v && v.dataType === DataType.Int32) {
      if (valores.some((x) => x < -0x8000 || x > 0x7fff)) {
        registro.status = 'BadOutOfRange';
        callback(null, StatusCodes.BadOutOfRange);
        return;
      }
      wv.value.value = new Variant({ dataType: DataType.Int16, arrayType: VariantArrayType.Array, value: Int16Array.from(valores) });
    }
    original(context, wv, callback);
  };
  (mando as unknown as { writeAttribute: EscribirAtributo }).writeAttribute = emulado;
  await server.start();
});

after(async () => {
  await server.shutdown();
  for (const [k, v] of entornoPrevio) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Ejecuta la herramienta como lo haría la CLI, pero sin esperas reales y con Ctrl+C a voluntad. */
async function correr(argv: string[], o: { ctrlCEnTick?: number; enTick?: (n: number) => void } = {}) {
  const lineas: string[] = [];
  const dirLogs = mkdtempSync(join(tmpdir(), 'pruebas-voragine-'));
  let ticks = 0;
  const codigo = await ejecutar({
    argv: [...argv, ENDPOINT],
    rutaMapping: RUTA_MAPPING,
    dirLogs,
    pkiRoot: join(__dirname, '..', 'pki'),
    imprimir: (l) => lineas.push(l),
    esperar: async () => {
      ticks += 1;
      o.enTick?.(ticks);
    },
    cancelado: () => o.ctrlCEnTick !== undefined && ticks >= o.ctrlCEnTick,
    ahora: () => new Date(),
  });
  const logs = readdirSync(dirLogs);
  const log = logs.length === 1 ? readFileSync(join(dirLogs, logs[0]), 'utf8') : null;
  return { codigo, salida: lineas.join('\n'), logs, log };
}

test('herramienta: sin argumentos lee el estado (como el backend: None/None + usuario) y no escribe nada', async () => {
  ponerPalabra(8 | 8192);
  const antes = peticiones.length;
  const r = await correr([]);
  assert.equal(r.codigo, CODIGO.OK, r.salida);
  assert.equal(peticiones.length, antes, 'ninguna escritura');
  assert.match(r.salida, /seguridad: None\/None · identidad username \(ptap-voragine-test\)/);
  assert.doesNotMatch(r.salida, new RegExp(CLAVE), 'la contraseña no se imprime');
  assert.match(r.salida, /INT_OUT_VORAGINE\[0\] = 8200 \{3,13\} · entrada CERRAR · salida CERRAR/);
  assert.match(r.salida, /IN\[0\]=  7192 \{3,4,10,11,12\}/);
  assert.match(r.salida, /Qent=6\.93 l\/s {2}Qsal=1\.61 l\/s {2}nivel=1\.52 m/);
  assert.deepEqual(r.logs, [], 'solo lectura sin --observar: no deja registro');
});

test('herramienta: sin --armar es un SIMULACRO — dice qué escribiría, sale con 2 y no escribe', async () => {
  ponerPalabra(8 | 8192);
  const antes = peticiones.length;
  const r = await correr(['salida', 'abrir']);
  assert.equal(r.codigo, CODIGO.SIMULACRO, r.salida);
  assert.equal(peticiones.length, antes);
  assert.equal(palabra(), 8 | 8192);
  assert.match(r.salida, /escribiría: 4104 \{3,12\} · entrada CERRAR · salida ABRIR/);
  assert.match(r.salida, /SIMULACRO: no se ha escrito nada/);
});

test('herramienta: ARMADA escribe UNA vez, como el backend (Int32 + IndexRange 0), el eco cuadra, observa y NO limpia al salir', async () => {
  ponerPalabra(8 | 8192);
  const antes = peticiones.length;
  const r = await correr(['salida', 'abrir', '--armar', '--observar', '2']);
  assert.equal(r.codigo, CODIGO.OK, r.salida);

  const nuevas = peticiones.slice(antes);
  assert.deepEqual(nuevas, [{ dataType: 'Int32', indexRange: '0', valores: [4096 | 8], status: 'Good' }], 'una escritura, con el método del backend');
  assert.equal(palabra(), 4096 | 8, 'la señal queda SOSTENIDA después de cerrar la sesión: nada la limpió');
  assert.match(r.salida, /ECO OK/);
  assert.match(r.salida, /OBSERVANDO 2 s/);
  assert.match(r.salida, /FIN\. NO se limpia nada al salir/);

  // El registro: un archivo, con el estado de antes, la escritura y la observación.
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0], /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-salida-abrir\.log$/);
  assert.match(String(r.log), /ESTADO ACTUAL/);
  assert.match(String(r.log), /ESCRIBIENDO INT_OUT_VORAGINE\[0\] ← 4104/);
  assert.match(String(r.log), /OUT\[0\]=  4104/);
  assert.doesNotMatch(String(r.log), new RegExp(CLAVE));
});

test('herramienta: idempotente — si la palabra ya tiene el verbo, no escribe', async () => {
  ponerPalabra(4096 | 8);
  const antes = peticiones.length;
  const r = await correr(['salida', 'abrir', '--armar']);
  assert.equal(r.codigo, CODIGO.OK, r.salida);
  assert.equal(peticiones.length, antes);
  assert.match(r.salida, /YA tiene la señal de abrir/);
});

test('herramienta: Ctrl+C durante la cuenta atrás cancela SIN escribir (y queda registrado)', async () => {
  ponerPalabra(4096 | 8);
  const antes = peticiones.length;
  const r = await correr(['entrada', 'abrir', '--armar'], { ctrlCEnTick: 12 });
  assert.equal(r.codigo, CODIGO.CANCELADO, r.salida);
  assert.equal(peticiones.length, antes, 'nada escrito');
  assert.equal(palabra(), 4096 | 8);
  assert.match(String(r.log), /CANCELADO con Ctrl\+C: NO se escribió nada/);
});

test('herramienta: si la palabra cambia durante la cuenta atrás, se RELEE y se recalcula (no se pisa la otra válvula)', async () => {
  // Durante los 5 s alguien abre la ENTRADA desde la app (8 → 4). Con la lectura vieja, abrir la salida
  // escribiría 4096|8 y le devolvería a la entrada el CERRAR. Releyendo, escribe 4096|4.
  ponerPalabra(8 | 8192);
  const antes = peticiones.length;
  const r = await correr(['salida', 'abrir', '--armar', '--observar', '0'], {
    enTick: (n) => {
      if (n === 20) ponerPalabra(4 | 8192);
    },
  });
  assert.equal(r.codigo, CODIGO.OK, r.salida);
  assert.match(r.salida, /La palabra cambió durante la cuenta atrás \(8200 → 8196\)/);
  assert.deepEqual(peticiones.slice(antes).map((p) => p.valores), [[4096 | 4]]);
  assert.equal(palabra(), 4096 | 4, 'la entrada conserva lo que hizo la app');
});

test('herramienta: con el bit15 puesto la palabra llega negativa y se escribe negativa (cabe en el Int16)', async () => {
  ponerPalabra(-28672); // 0x9000 = bit15 + bit12
  const antes = peticiones.length;
  const r = await correr(['entrada', 'abrir', '--armar', '--observar', '0']);
  assert.equal(r.codigo, CODIGO.OK, r.salida);
  assert.deepEqual(peticiones.slice(antes), [{ dataType: 'Int32', indexRange: '0', valores: [-28668], status: 'Good' }]);
  assert.equal(palabra(), -28668, '0x9004: bit15 y bit12 intactos, bit2 puesto');
  assert.match(r.salida, /bits fuera de \{2,3,12,13\} puestos \(\{15\}\): se conservan/);
});

test('herramienta: si el mapping y la herramienta no coinciden, no escribe ni en simulacro', async () => {
  const raw = JSON.parse(readFileSync(RUTA_MAPPING, 'utf8')) as {
    plants: Array<{ plantId: string; signals: Array<{ domainKey: string; write?: { commands?: unknown } }> }>;
  };
  raw.plants.find((p) => p.plantId === 'voragine')!.signals.find((s) => s.domainKey === 'valve1')!.write!.commands = { open: 4, close: 8192 };
  const dir = mkdtempSync(join(tmpdir(), 'mapping-discrepante-'));
  const ruta = join(dir, 'opc_mapping.json');
  writeFileSync(ruta, JSON.stringify(raw), 'utf8');
  const lineas: string[] = [];
  const antes = peticiones.length;
  const codigo = await ejecutar({
    argv: ['salida', 'abrir', '--armar', ENDPOINT],
    rutaMapping: ruta,
    dirLogs: dir,
    pkiRoot: join(__dirname, '..', 'pki'),
    imprimir: (l) => lineas.push(l),
    esperar: async () => undefined,
    cancelado: () => false,
    ahora: () => new Date(),
  });
  assert.equal(codigo, CODIGO.ERROR);
  assert.equal(peticiones.length, antes);
  assert.match(lineas.join('\n'), /NO coinciden[\s\S]*salida \(valve1\): el mapping dice open=4 close=8192/);
});

test('adaptador del backend: escribe y lee el mismo elemento igual que la herramienta, contra el mismo servidor', async () => {
  // Las funciones que la herramienta importa son las que usa el adaptador (opcionesDeCliente,
  // identidadDeSesion, escribirElemento, leerElemento). Aquí se ejerce el adaptador completo —sesión,
  // resolución de NodeIds, suscripción— con un mapping de solo La Vorágine.
  const real = loadMapping(RUTA_MAPPING);
  const mapping: LoadedMapping = {
    ...real,
    plants: real.plants.filter((p) => p.plantId === 'voragine'),
    targets: real.targets.filter((t) => t.plantId === 'voragine'),
    signals: real.signals.filter((s) => s.plantId === 'voragine'),
    raw: { plants: [{ opcBuffers: { intOut: [{ node: { nsUri: 'AQUATECH4' } }] } }] },
  };
  const adapter = new OpcUaConnectivityAdapter(loadConnectivityConfig().opcua, mapping);
  ponerPalabra(8 | 8192);
  const antes = peticiones.length;
  try {
    await adapter.start();
    assert.equal(adapter.getBridgeStatus(), 'Connected');
    const el = { plantId: 'voragine', channel: 'intOut', sourceBuffer: 'INT_OUT_VORAGINE', index: 0 };
    assert.equal((await adapter.readBufferElement(el)).value, 8 | 8192);
    await adapter.writeBufferElement(el, 4 | 8192);
    const leido = await adapter.readBufferElement(el);
    assert.deepEqual(leido, { value: 4 | 8192, quality: 'Good', sourceTimestamp: leido.sourceTimestamp });
    assert.deepEqual(peticiones.slice(antes), [{ dataType: 'Int32', indexRange: '0', valores: [4 | 8192], status: 'Good' }], 'misma petición que la herramienta');
  } finally {
    await adapter.stop();
  }
});
