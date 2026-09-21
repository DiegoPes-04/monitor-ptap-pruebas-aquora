/**
 * Exploración (SOLO LECTURA) del nodo MSG_WRITE_INT_SIRENA — el tramo FTOptix → PLC.
 *
 * Objetivo: averiguar si los bits de la instrucción MSG (DN=done, ER=error, TO=timeout, EN=enable)
 * están expuestos como nodos HIJOS direccionables. Si lo están, se pueden leer como Boolean —
 * mucho más robusto que decodificar el ExtensionObject completo, que ya tumbó una sesión antes
 * (`Connection Break` al resolver su dataType ns=6;i=70).
 *
 * Uso:  npm exec -w @ptap/api -- tsx scripts/browse-msg-sirena.ts
 */
import { OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds, BrowseDirection, NodeClass } from 'node-opcua';
import { resolverEndpoint } from './opc-endpoint';

const ENDPOINT = resolverEndpoint(process.argv[2]);
const MSG_WRITE_GUID = 'AEC8BB93-ED3D-BEC5-6EC5-782EA513CFA2'; // MSG_WRITE_INT_SIRENA
const MSG_READ_GUID = '44F9A9C6-5FE8-FF87-FDD2-F7DA8EB94BA1'; // MSG_READ_INT_SIRENA (comparación)

async function main(): Promise<void> {
  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    connectionStrategy: { maxRetry: 1, initialDelay: 500, maxDelay: 1500 },
    requestedSessionTimeout: 60000,
  });
  await client.connect(ENDPOINT);
  const session = await client.createSession();
  try {
    const nsArray = await session.readNamespaceArray();
    const aq = nsArray.indexOf('AQUATECH');
    console.log(`ns AQUATECH = ${aq}\n`);

    for (const [label, guid] of [['MSG_WRITE_INT_SIRENA', MSG_WRITE_GUID], ['MSG_READ_INT_SIRENA', MSG_READ_GUID]] as const) {
      const nodeId = `ns=${aq};g=${guid}`;
      console.log(`════ ${label}  (${nodeId}) ════`);
      try {
        const meta = await session.read([
          { nodeId, attributeId: AttributeIds.BrowseName },
          { nodeId, attributeId: AttributeIds.DataType },
          { nodeId, attributeId: AttributeIds.AccessLevel },
        ]);
        console.log(`  browseName=${meta[0].value?.value?.toString?.() ?? '?'}  dataType=${meta[1].value?.value?.toString?.() ?? '?'}  accessLevel=${meta[2].value?.value ?? '?'}`);
      } catch (e) {
        console.log(`  (no se pudo leer metadata: ${e instanceof Error ? e.message : e})`);
      }

      try {
        const res = await session.browse({
          nodeId,
          browseDirection: BrowseDirection.Forward,
          includeSubtypes: true,
          nodeClassMask: 0, // todo
          resultMask: 63,
        });
        const refs = res.references ?? [];
        console.log(`  hijos: ${refs.length}`);
        for (const r of refs) {
          const cls = NodeClass[r.nodeClass] ?? r.nodeClass;
          console.log(`    - ${String(r.browseName?.name).padEnd(24)} ${String(cls).padEnd(10)} ${r.nodeId.toString()}`);
        }
        // Intentar leer los hijos que parezcan bits de la MSG
        const interesting = refs.filter((r) => /^(DN|ER|TO|EN|ST|EW|EN_CC|ERR|EXERR)$/i.test(String(r.browseName?.name ?? '')));
        if (interesting.length > 0) {
          console.log(`  ── lectura de los bits direccionables ──`);
          for (const r of interesting) {
            try {
              const dv = await session.read({ nodeId: r.nodeId.toString(), attributeId: AttributeIds.Value });
              console.log(`    ${String(r.browseName?.name).padEnd(8)} = ${JSON.stringify(dv.value?.value)}   status=${dv.statusCode?.toString()}`);
            } catch (e) {
              console.log(`    ${String(r.browseName?.name).padEnd(8)} = (error: ${e instanceof Error ? e.message : e})`);
            }
          }
        } else {
          console.log(`  ⚠️  sin hijos DN/ER/TO direccionables → habría que decodificar el objeto completo`);
        }
      } catch (e) {
        console.log(`  (browse falló: ${e instanceof Error ? e.message : e})`);
      }
      console.log('');
    }
  } finally {
    await session.close().catch(() => undefined);
    await client.disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('browse-msg-sirena falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
