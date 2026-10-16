/**
 * Testigo (SOLO LECTURA) del tramo maestro → PLC local de La Vorágine: la instrucción
 * MSG_WRITE_INT_VORAGINE, que es la que lleva INT_OUT_VORAGINE (el mando de las válvulas) al PLC de
 * la planta.
 *
 * Existe porque el 2026-10-16 la orden «cerrar entrada» quedó escrita y sostenida en
 * INT_OUT_VORAGINE[0] (4106 = bits {1,3,12}) y el caudal de entrada no se movió. El backend hizo su
 * parte; la pregunta es si la palabra llega al PLC local, y a qué tag. Eso lo dicen los campos de la
 * propia MSG, que Optix publica como nodos hijos (docs/plc/01_inventory.json):
 *  - EN/ST/DN/ER/TO/EW y ERR/EXERR: si el mensaje se completa, falla o caduca;
 *  - REQ_LEN/DN_LEN, LocalIndex/RemoteIndex: cuántos elementos y desde qué posición se mandan;
 *  - RemoteElement/Path: a qué tag del PLC local y por qué ruta.
 *
 * Por SUSCRIPCIÓN y no con `read`: un `read` suelto de estos nodos devuelve null (los tags del
 * CommDriver de Optix solo se refrescan mientras alguien los vigila). Mismo motivo que el testigo de
 * Sirena (docs/archivo/PRUEBA_VALVULA_SIRENA.md, «Tramo FTOptix → PLC»).
 *
 * NUNCA escribe. Conexión e identidad iguales a las del backend (mismo .env, mismas funciones del
 * adaptador), como test-valvulas-voragine.ts.
 *
 * Uso (en la VM):
 *   npm exec -w @ptap/api -- tsx scripts/monitor-voragine-msg.ts [segundos=90] [opc.tcp://host:puerto]
 */
import { join } from 'node:path';
import {
  AttributeIds,
  ClientMonitoredItem,
  ClientSubscription,
  OPCUAClient,
  TimestampsToReturn,
  type ClientSession,
  type DataValue,
} from 'node-opcua';
import {
  identidadDeSesion,
  opcionesDeCliente,
} from '../src/infrastructure/connectivity/adapters/opcua/opcua-connectivity.adapter';
import { loadConnectivityConfig } from '../src/infrastructure/connectivity/connectivity.config';
import { resolverEndpoint } from './opc-endpoint';

const NS_URI = 'AQUATECH4';

/** Hijos de MSG_WRITE_INT_VORAGINE (g=6E45CF3A-…), del inventario del servidor. */
const MSG: ReadonlyArray<[string, string]> = [
  ['EN', '7F083AC0-44B6-7714-56B8-49B58CF6CC52'],
  ['ST', '614CE682-7AB7-6579-C9D9-D09AEC67AE25'],
  ['DN', '5C424FA5-A3DD-2D8A-5126-0FBA34868E1A'],
  ['ER', '8B2D68CC-BAEE-9627-BD51-9E0E4EB2719E'],
  ['TO', '6D09C62F-DB1E-4684-E293-5313AB333D1D'],
  ['EW', '85C267DD-834A-CD88-53B5-8F287D50E301'],
  ['ERR', '65F2FD50-1C5A-CA9F-BF8D-B893DC68B42E'],
  ['EXERR', 'B2295B71-E534-AE95-A56F-4172D818A6C0'],
  ['REQ_LEN', '685DC1C7-02E5-D92F-C626-9557922B6AC5'],
  ['DN_LEN', 'C98F78A7-30F7-6389-0D74-09FCD0A7EF5E'],
  ['LocalIndex', 'FB78422A-55F8-2331-ED8B-4BCF598E3B7A'],
  ['RemoteIndex', '03357653-09A6-FC83-B51D-31BF18C52C43'],
  ['RemoteElement', '3730E916-BFBE-B2E5-9508-A4532D1A35A8'],
  ['Path', '2F6DFADE-BA21-D90F-9AB7-7D8CF1211292'],
];

/** Buffers de la planta, para ver la palabra de mando y el proceso a la vez que el mensaje. */
const INT_OUT = '1505CBA4-0BCF-A4FC-7602-DB5BF940BBC6';
const INT_IN = '002A5DBD-381A-F691-1071-4BFF23ED007C';
const REAL_IN = '93BAFF92-FF57-4877-74E4-B7CC1EFAE6B3';

const bits = (n: number): string => {
  const u = Number(n) & 0xffff;
  const s: number[] = [];
  for (let b = 0; b < 16; b++) if (u & (1 << b)) s.push(b);
  return `{${s.join(',')}}`;
};
const hora = (): string => new Date().toTimeString().slice(0, 8);
const valor = (dv: DataValue): unknown => (dv.statusCode.isGood() ? dv.value?.value : `(${dv.statusCode.name})`);

async function main(): Promise<void> {
  await import('../src/config/load-env');
  const args = process.argv.slice(2);
  const segundos = Number(args.find((a) => /^\d+$/.test(a)) ?? 90);
  const endpoint = resolverEndpoint(args.find((a) => a.startsWith('opc.tcp://')));
  const cfg = loadConnectivityConfig().opcua;
  const pkiRoot = join(__dirname, '..', 'pki');

  console.log(`== Testigo MSG_WRITE_INT_VORAGINE (solo lectura) == ${endpoint} · ${segundos} s`);
  const client = OPCUAClient.create({
    ...opcionesDeCliente(cfg, pkiRoot),
    connectionStrategy: { maxRetry: 1, initialDelay: 500, maxDelay: 1500 },
  });
  await client.connect(endpoint);
  const session: ClientSession = await client.createSession(identidadDeSesion(cfg.identity, pkiRoot));
  const sub = ClientSubscription.create(session, {
    requestedPublishingInterval: 250,
    requestedLifetimeCount: 600,
    requestedMaxKeepAliveCount: 20,
    maxNotificationsPerPublish: 200,
    publishingEnabled: true,
    priority: 10,
  });

  try {
    const ns = (await session.readNamespaceArray()).indexOf(NS_URI);
    if (ns < 0) throw new Error(`el servidor no publica el namespace ${NS_URI}`);
    const id = (g: string): string => `ns=${ns};g=${g}`;

    const ultimo = new Map<string, unknown>();
    let ciclosDN = 0;
    let erAlto = 0;
    let toAlto = 0;
    let errNoCero = 0;

    for (const [nombre, g] of MSG) {
      const item = ClientMonitoredItem.create(
        sub,
        { nodeId: id(g), attributeId: AttributeIds.Value },
        { samplingInterval: 100, discardOldest: true, queueSize: 20 },
        TimestampsToReturn.Both,
      );
      item.on('changed', (dv: DataValue) => {
        const v = valor(dv);
        const previo = ultimo.get(nombre);
        ultimo.set(nombre, v);
        if (nombre === 'DN' && v === true && previo !== true) ciclosDN++;
        if (nombre === 'ER' && v === true && previo !== true) erAlto++;
        if (nombre === 'TO' && v === true && previo !== true) toAlto++;
        if ((nombre === 'ERR' || nombre === 'EXERR') && typeof v === 'number' && v !== 0 && v !== previo) errNoCero++;
        // Los bits de handshake cambian varias veces por ciclo: solo se imprime su primera lectura y lo
        // anómalo; el resto, siempre.
        const ruidoso = ['EN', 'ST', 'DN'].includes(nombre) && previo !== undefined;
        if (!ruidoso) console.log(`${hora()}  MSG.${nombre.padEnd(13)} = ${JSON.stringify(v)}`);
      });
    }

    let antes = '';
    const leerProceso = async (): Promise<void> => {
      const [o, i, r] = await session.read([
        { nodeId: id(INT_OUT), attributeId: AttributeIds.Value },
        { nodeId: id(INT_IN), attributeId: AttributeIds.Value },
        { nodeId: id(REAL_IN), attributeId: AttributeIds.Value },
      ]);
      const out = Array.from((o.value?.value ?? []) as ArrayLike<number>).map(Number);
      const inn = Array.from((i.value?.value ?? []) as ArrayLike<number>).map(Number);
      const real = Array.from((r.value?.value ?? []) as ArrayLike<number>).map(Number);
      const linea =
        `OUT[0]=${out[0]} ${bits(out[0])}  IN[0]=${inn[0]} ${bits(inn[0])}  IN[1]=${inn[1]} ${bits(inn[1])}` +
        `  Qent=${real[0]?.toFixed(2)}  Qsal=${real[7]?.toFixed(2)}  nivel=${real[5]?.toFixed(2)}`;
      const msg = `EN=${ultimo.get('EN')} DN=${ultimo.get('DN')} ER=${ultimo.get('ER')} TO=${ultimo.get('TO')}`;
      if (linea !== antes) console.log(`${hora()}  ${linea}   │ ${msg}`);
      antes = linea;
    };

    const fin = Date.now() + segundos * 1000;
    while (Date.now() < fin) {
      await leerProceso().catch((err) => console.log(`${hora()}  (lectura de buffers falló: ${err instanceof Error ? err.message : err})`));
      await new Promise((r) => setTimeout(r, 2000));
    }

    console.log('');
    console.log('== RESUMEN del tramo maestro → PLC local (MSG_WRITE_INT_VORAGINE) ==');
    console.log(`  ciclos DN (mensaje completado): ${ciclosDN} en ${segundos} s`);
    console.log(`  ER en alto: ${erAlto} · TO en alto: ${toAlto} · ERR/EXERR distinto de 0: ${errNoCero}`);
    console.log(`  ERR=${JSON.stringify(ultimo.get('ERR'))} EXERR=${JSON.stringify(ultimo.get('EXERR'))}`);
    console.log(`  REQ_LEN=${JSON.stringify(ultimo.get('REQ_LEN'))} DN_LEN=${JSON.stringify(ultimo.get('DN_LEN'))} LocalIndex=${JSON.stringify(ultimo.get('LocalIndex'))} RemoteIndex=${JSON.stringify(ultimo.get('RemoteIndex'))}`);
    console.log(`  RemoteElement=${JSON.stringify(ultimo.get('RemoteElement'))}  Path=${JSON.stringify(ultimo.get('Path'))}`);
    const veredicto =
      ciclosDN === 0
        ? '❌ el mensaje NO se completa: la palabra de mando no está llegando al PLC local'
        : erAlto || toAlto || errNoCero
          ? '⚠️ el mensaje se completa a ratos pero con errores/timeouts'
          : '✅ el mensaje se completa sin errores: la palabra llega al PLC local (mirar RemoteElement/REQ_LEN y la lógica del local)';
    console.log(`  ${veredicto}`);
  } finally {
    await sub.terminate().catch(() => undefined);
    await session.close().catch(() => undefined);
    await client.disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('monitor-voragine-msg falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
