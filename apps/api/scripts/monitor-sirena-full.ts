/**
 * ANÁLISIS COMPLETO (solo lectura) de los arrays de válvula de Sirena.
 * Suscripción (muestreo 20 ms servidor) a INT_OUT_SIRENA e INT_IN_SIRENA: en cada CAMBIO vuelca el
 * ARRAY ENTERO indicando qué índices cambiaron; y además una FOTO del estado cada 1 s durante 1 min.
 * Objetivo: identificar exactamente qué índice/valor mueve el comando (abrir vs cerrar) y el estado.
 * NO escribe nada.
 * Uso:  MONITOR_SECONDS=60 npm exec -w @ptap/api -- tsx scripts/monitor-sirena-full.ts
 */
import {
  OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds,
  ClientSubscription, ClientMonitoredItem, TimestampsToReturn,
} from 'node-opcua';
import { resolverEndpoint } from './opc-endpoint';

const ENDPOINT = resolverEndpoint(process.argv[2]);
const SECONDS = Number(process.env.MONITOR_SECONDS ?? 60);
const TARGETS = [
  { key: 'OUT', name: 'INT_OUT_SIRENA', guid: '4AB6ECB4-D019-D4F1-A8A8-6177C3FE3278' },
  { key: 'IN', name: 'INT_IN_SIRENA', guid: '184E4071-DC15-213A-3DE8-442A4E0A354B' },
];

const bits = (n: number): string => {
  const u = Number(n) & 0xffff;
  const s: number[] = [];
  for (let b = 0; b < 16; b++) if (u & (1 << b)) s.push(b);
  return `{${s.join(',')}}`;
};
const nz = (arr: number[]): string => JSON.stringify(arr.map((v, i) => [i, v]).filter(([, v]) => v !== 0));
const toArr = (dv: { value?: { value?: unknown } }): number[] =>
  Array.from((dv.value?.value ?? []) as ArrayLike<number>).map(Number);

async function main(): Promise<void> {
  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    connectionStrategy: { maxRetry: 1, initialDelay: 500, maxDelay: 1500 },
    requestedSessionTimeout: (SECONDS + 30) * 1000,
  });
  await client.connect(ENDPOINT);
  const session = await client.createSession();
  const t0 = Date.now();
  const ts = (): string => ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
  const last: Record<string, number[]> = { OUT: [], IN: [] };
  const prev: Record<string, number[]> = {};
  const seen: Record<string, Set<string>> = { OUT: new Set(), IN: new Set() };
  let hb: NodeJS.Timeout | null = null;

  try {
    const nsArray = await session.readNamespaceArray();
    const aq = nsArray.indexOf('AQUATECH');
    if (aq < 0) throw new Error('namespace AQUATECH no encontrado');

    const sub = ClientSubscription.create(session, {
      requestedPublishingInterval: 100,
      requestedLifetimeCount: 6000,
      requestedMaxKeepAliveCount: 20,
      maxNotificationsPerPublish: 1000,
      publishingEnabled: true,
      priority: 10,
    });

    console.log(`== ANÁLISIS COMPLETO Sirena (solo lectura) ==`);
    console.log(`endpoint ${ENDPOINT}  ·  ns AQUATECH=${aq}  ·  muestreo 20ms  ·  ${SECONDS}s`);
    console.log(`>>> DISPARA ABRIR y luego CERRAR (ambos) durante este minuto. Vuelco array completo en cada cambio:\n`);

    for (const tgt of TARGETS) {
      const nodeId = `ns=${aq};g=${tgt.guid}`;
      const item = ClientMonitoredItem.create(
        sub,
        { nodeId, attributeId: AttributeIds.Value },
        { samplingInterval: 20, discardOldest: false, queueSize: 200 },
        TimestampsToReturn.Both,
      );
      item.on('changed', (dv) => {
        const arr = toArr(dv);
        last[tgt.key] = arr;
        seen[tgt.key].add(nz(arr));
        const p = prev[tgt.key];
        const changedIdx = p ? arr.map((v, i) => (v !== (p[i] ?? 0) ? i : -1)).filter((i) => i >= 0) : arr.map((_, i) => i).filter((i) => arr[i] !== 0);
        prev[tgt.key] = arr;
        const detail = changedIdx.map((i) => `[${i}]=${arr[i]} ${bits(arr[i])}`).join('  ');
        console.log(`t=${ts()}s  CAMBIO ${tgt.name}  idx=${JSON.stringify(changedIdx)}  ${detail}`);
        console.log(`          FULL=[${arr.join(',')}]`);
      });
    }

    hb = setInterval(() => {
      console.log(`t=${ts()}s  FOTO  OUTnz=${nz(last.OUT)}  |  INnz=${nz(last.IN)}`);
    }, 1000);

    await new Promise<void>((resolve) => setTimeout(resolve, SECONDS * 1000));
    if (hb) clearInterval(hb);
    await sub.terminate().catch(() => undefined);

    console.log(`\n== RESUMEN ==`);
    console.log(`estados NO-CERO vistos en INT_OUT_SIRENA (comando): ${[...seen.OUT].filter((s) => s !== '[]').join('   ') || '(ninguno ≠0)'}`);
    console.log(`estados vistos en INT_IN_SIRENA (estado):           ${[...seen.IN].join('   ')}`);
  } finally {
    if (hb) clearInterval(hb);
    await session.close().catch(() => undefined);
    await client.disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('monitor-sirena-full falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
