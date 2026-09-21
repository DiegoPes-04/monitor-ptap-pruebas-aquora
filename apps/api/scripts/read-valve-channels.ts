/**
 * LECTURA (solo lectura) de los canales de válvula de CUALQUIER planta: el comando (`intOut`) y el
 * estado (`intIn`), elemento a elemento y con los bits desglosados.
 *
 * Generaliza a `read-sirena.ts`, que llevaba los GUID de una sola planta escritos a mano. Eso
 * bastaba mientras la única válvula bajo estudio era la de La Sirena, pero cada vez que hubo que
 * mirar otro sitio se copió el archivo y se cambiaron dos constantes — y una de esas copias acabó
 * leyendo el buffer equivocado (los GUID se parecen mucho entre sí). Aquí los GUID salen del
 * mapping, que es la única fuente que sabe qué buffer es de quién.
 *
 * NUNCA escribe: sesión anónima None/None y solo `read`. Para escribir están los comandos de la app,
 * que pasan por RBAC, interlock y auditoría.
 *
 * Uso:
 *   npm exec -w @ptap/api -- tsx scripts/read-valve-channels.ts voragine [opc.tcp://host:puerto]
 *   npm exec -w @ptap/api -- tsx scripts/read-valve-channels.ts voragine --watch 60
 *
 * `--watch <seg>` reduce la salida a los canales 0 y 1 y la repite cada segundo: es el modo para
 * mirar CÓMO reacciona el estado mientras alguien acciona la válvula desde la app, que es la única
 * forma de averiguar qué significa la palabra sin escribir nada desde aquí.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds, type ClientSession } from 'node-opcua';
import { resolverEndpoint } from './opc-endpoint';

interface RawBuffer {
  browseName: string;
  node: { nsUri: string; identifier: string };
  arrayLength?: number;
}
interface RawPlant {
  plantId: string;
  displayName: string;
  opcBuffers: Record<string, RawBuffer[]>;
}

const bits = (n: number): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  const set: number[] = [];
  const u = n & 0xffff;
  for (let b = 0; b < 16; b++) if (u & (1 << b)) set.push(b);
  return set.length ? `bits{${set.join(',')}}` : 'bits{}';
};

const accStr = (a: number): string =>
  `${a} (${a & 1 ? 'CurrentRead ' : ''}${a & 2 ? 'CurrentWrite' : ''})${a & 2 ? '' : ' → SOLO LECTURA en el servidor'}`;

function plantaDelMapping(plantId: string): RawPlant {
  const path = process.env.OPC_MAPPING_PATH ?? join(__dirname, '..', 'config', 'opc_mapping.json');
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { plants: RawPlant[] };
  const planta = doc.plants.find((p) => p.plantId === plantId);
  if (!planta) {
    throw new Error(`planta "${plantId}" no está en el mapping. Hay: ${doc.plants.map((p) => p.plantId).join(', ')}`);
  }
  return planta;
}

async function leerArray(session: ClientSession, nodeId: string): Promise<{ arr: number[]; status: string; access: number }> {
  const [val, acc] = await session.read([
    { nodeId, attributeId: AttributeIds.Value },
    { nodeId, attributeId: AttributeIds.AccessLevel },
  ]);
  const raw = val.value?.value;
  const arr = Array.isArray(raw) || ArrayBuffer.isView(raw) ? Array.from(raw as ArrayLike<number>).map(Number) : [];
  return { arr, status: val.statusCode?.toString() ?? '?', access: Number(acc.value?.value ?? 0) };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const plantId = argv[0];
  if (!plantId || plantId.startsWith('-')) throw new Error('falta el plantId. Ej: tsx scripts/read-valve-channels.ts voragine');

  const iWatch = argv.indexOf('--watch');
  const watchSec = iWatch >= 0 ? Number(argv[iWatch + 1] ?? 60) : 0;
  const endpoint = resolverEndpoint(argv.find((a, i) => a.startsWith('opc.tcp://') && i > 0));

  const planta = plantaDelMapping(plantId);
  const targets = (['intOut', 'intIn'] as const)
    .map((canal) => ({ canal, buf: planta.opcBuffers[canal]?.[0] }))
    .filter((t): t is { canal: 'intOut' | 'intIn'; buf: RawBuffer } => !!t.buf);
  if (targets.length === 0) throw new Error(`${plantId} no tiene buffers intOut/intIn: no hay canal de válvula que leer`);

  console.log(`\n== ${planta.displayName} (${plantId}) — SOLO LECTURA ==\nendpoint: ${endpoint}\n${new Date().toISOString()}`);

  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    connectionStrategy: { maxRetry: 1, initialDelay: 500, maxDelay: 1500 },
    requestedSessionTimeout: 20000,
  });
  await client.connect(endpoint);
  const session = await client.createSession(); // anónima
  try {
    const nsArray = await session.readNamespaceArray();
    const resolver = (nsUri: string): number => {
      const i = nsArray.indexOf(nsUri);
      if (i < 0) throw new Error(`el servidor no publica el namespace "${nsUri}". Publica: ${nsArray.join(', ')}`);
      return i;
    };
    const nodos = targets.map((t) => ({ ...t, nodeId: `ns=${resolver(t.buf.node.nsUri)};${t.buf.node.identifier}` }));

    if (watchSec > 0) {
      // Modo vigilancia: solo los canales 0 y 1, y solo cuando CAMBIAN. Imprimir cada segundo
      // llenaría la pantalla de líneas idénticas y escondería justo el instante que interesa.
      console.log(`\nvigilando ${watchSec}s los canales 0 y 1 (solo se imprime lo que cambia)\n`);
      const previo = new Map<string, string>();
      const fin = Date.now() + watchSec * 1000;
      while (Date.now() < fin) {
        for (const n of nodos) {
          const { arr } = await leerArray(session, n.nodeId);
          const firma = `${arr[0]}|${arr[1]}`;
          if (previo.get(n.canal) !== firma) {
            previo.set(n.canal, firma);
            console.log(
              `${new Date().toISOString().slice(11, 19)}  ${n.buf.browseName.padEnd(18)} [0]=${String(arr[0]).padStart(7)} ${bits(arr[0]).padEnd(22)} [1]=${String(arr[1]).padStart(7)} ${bits(arr[1])}`,
            );
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return;
    }

    for (const n of nodos) {
      const { arr, status, access } = await leerArray(session, n.nodeId);
      const rol = n.canal === 'intOut' ? 'COMANDO' : 'ESTADO';
      console.log(`\n${n.buf.browseName}  (${rol})\n  nodeId: ${n.nodeId}\n  status: ${status}  accessLevel: ${accStr(access)}`);
      arr.forEach((v, i) => console.log(`    [${String(i).padStart(2)}] = ${String(v).padStart(7)}   ${bits(v)}`));
    }
  } finally {
    await session.close().catch(() => undefined);
    await client.disconnect().catch(() => undefined);
  }
  console.log('\n== fin lectura ==');
}

main().catch((err) => {
  console.error('read-valve-channels falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
