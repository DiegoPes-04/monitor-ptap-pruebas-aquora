/**
 * LECTURA (solo lectura) de los buffers de válvula de La Sirena — PoC Nivel 1.
 * NO escribe nada: abre sesión anónima None/None y lee Value + AccessLevel de:
 *   - INT_OUT_SIRENA (comando, canal 0)  g=4AB6ECB4-D019-D4F1-A8A8-6177C3FE3278  Int16[20]
 *   - INT_IN_SIRENA  (estado, read-back) g=184E4071-DC15-213A-3DE8-442A4E0A354B  Int16[10]
 * Uso:  npm exec -w @ptap/api -- tsx scripts/read-sirena.ts  [opc.tcp://host:puerto]
 */
import { OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds } from 'node-opcua';
import { resolverEndpoint } from './opc-endpoint';

const ENDPOINT = resolverEndpoint(process.argv[2]);
const TARGETS = [
  { name: 'INT_OUT_SIRENA (COMANDO/canal 0)', guid: '4AB6ECB4-D019-D4F1-A8A8-6177C3FE3278' },
  { name: 'INT_IN_SIRENA  (ESTADO/read-back)', guid: '184E4071-DC15-213A-3DE8-442A4E0A354B' },
];

const bits = (n: number): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  const set: number[] = [];
  const u = n & 0xffff;
  for (let b = 0; b < 16; b++) if (u & (1 << b)) set.push(b);
  return set.length ? `bits{${set.join(',')}}` : 'bits{}';
};
const accStr = (a: number): string =>
  `${a} (${a & 1 ? 'CurrentRead ' : ''}${a & 2 ? 'CurrentWrite' : ''})${a & 2 ? '' : ' → SOLO LECTURA en el servidor'}`;

async function main(): Promise<void> {
  console.log(`\n== LECTURA Sirena (solo lectura) ==\nendpoint: ${ENDPOINT}\n${new Date().toISOString()}`);
  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    connectionStrategy: { maxRetry: 1, initialDelay: 500, maxDelay: 1500 },
    requestedSessionTimeout: 20000,
  });
  await client.connect(ENDPOINT);
  const session = await client.createSession(); // anónima
  try {
    const nsArray = await session.readNamespaceArray();
    const aq = nsArray.indexOf('AQUATECH');
    console.log('namespaces:', nsArray);
    console.log('índice ns AQUATECH:', aq);
    if (aq < 0) throw new Error('no se encontró el namespace AQUATECH en el servidor');

    for (const t of TARGETS) {
      const nodeId = `ns=${aq};g=${t.guid}`;
      const [val, acc] = await session.read([
        { nodeId, attributeId: AttributeIds.Value },
        { nodeId, attributeId: AttributeIds.AccessLevel },
      ]);
      const arr = val.value?.value;
      console.log(`\n${t.name}\n  nodeId: ${nodeId}\n  status: ${val.statusCode?.toString()}  accessLevel: ${accStr(Number(acc.value?.value ?? 0))}`);
      if (Array.isArray(arr) || ArrayBuffer.isView(arr)) {
        const a = Array.from(arr as ArrayLike<number>);
        a.forEach((v, i) => console.log(`    [${String(i).padStart(2)}] = ${String(v).padStart(7)}   ${bits(Number(v))}`));
      } else {
        console.log('    value:', JSON.stringify(arr));
      }
    }
  } finally {
    await session.close().catch(() => undefined);
    await client.disconnect().catch(() => undefined);
  }
  console.log('\n== fin lectura ==');
}

main().catch((err) => {
  console.error('read-sirena falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
