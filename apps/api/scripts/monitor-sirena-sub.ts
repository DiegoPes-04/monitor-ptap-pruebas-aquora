/**
 * MONITOR por SUSCRIPCIÓN (solo lectura) del canal de comando de Sirena — captura fiable de PULSOS.
 * En vez de sondear (que a ~2,3 lecturas/s se pierde un pulso), usa un MonitoredItem: el SERVIDOR
 * muestrea `INT_OUT_SIRENA` (comando) e `INT_IN_SIRENA` (estado) cada ~20 ms con cola, y nos entrega
 * TODOS los cambios aunque la red sea lenta. NO escribe nada.
 * Uso:  MONITOR_SECONDS=120 npm exec -w @ptap/api -- tsx scripts/monitor-sirena-sub.ts
 */
import {
  OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds,
  ClientSubscription, ClientMonitoredItem, TimestampsToReturn,
} from 'node-opcua';
import { resolverEndpoint } from './opc-endpoint';

const ENDPOINT = resolverEndpoint(process.argv[2]);
const SECONDS = Number(process.env.MONITOR_SECONDS ?? 120);
// Todos los buffers de Sirena, por si el pulso aparece en otro canal:
const TARGETS: Array<{ name: string; guid: string }> = [
  { name: 'INT_OUT_SIRENA (comando)', guid: '4AB6ECB4-D019-D4F1-A8A8-6177C3FE3278' },
  { name: 'INT_IN_SIRENA  (estado) ', guid: '184E4071-DC15-213A-3DE8-442A4E0A354B' },
  { name: 'BIT_SIRENA              ', guid: '57F08F39-07AA-5C7C-6B7E-4ABE531EC93D' },
  { name: 'MSG_WRITE_INT_SIRENA    ', guid: 'AEC8BB93-ED3D-BEC5-6EC5-782EA513CFA2' },
];

const bits = (n: number): string => {
  const u = Number(n) & 0xffff;
  const s: number[] = [];
  for (let b = 0; b < 16; b++) if (u & (1 << b)) s.push(b);
  return `{${s.join(',')}}`;
};
const nz = (arr: number[]): Array<[number, number]> => arr.map((v, i) => [i, Number(v)] as [number, number]).filter(([, v]) => v !== 0);
const arrOf = (dv: { value?: { value?: unknown } }): number[] => Array.from((dv.value?.value ?? []) as ArrayLike<number>).map(Number);

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
  const captures: Array<{ t: string; out0: number; nz: Array<[number, number]> }> = [];
  const inStates = new Set<number>();

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

    console.log(`== MONITOR Sirena por SUSCRIPCIÓN (solo lectura) — TODOS los buffers ==`);
    console.log(`endpoint ${ENDPOINT}  ·  ns AQUATECH=${aq}  ·  muestreo servidor 20ms  ·  ${SECONDS}s`);
    console.log(`buffers: ${TARGETS.map((t) => t.name.trim()).join(', ')}`);
    console.log(`>>> EJECUTA abrir/cerrar la válvula AHORA. Cada CAMBIO queda registrado:\n`);

    const fmt = (arr: number[] | null, raw: unknown): string =>
      arr ? `[0]=${arr[0] ?? 0} ${bits(arr[0] ?? 0)}  nz=${JSON.stringify(nz(arr))}` : `val=${JSON.stringify(raw)}`;

    for (const tgt of TARGETS) {
      const nodeId = `ns=${aq};g=${tgt.guid}`;
      const item = ClientMonitoredItem.create(
        sub,
        { nodeId, attributeId: AttributeIds.Value },
        { samplingInterval: 20, discardOldest: false, queueSize: 200 },
        TimestampsToReturn.Both,
      );
      item.on('changed', (dv) => {
        const v = dv.value?.value;
        const arr = Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v as ArrayLike<number>).map(Number) : null;
        const src = dv.sourceTimestamp ? new Date(dv.sourceTimestamp).toISOString().slice(11, 23) : '';
        console.log(`t=${ts()}s  ${tgt.name}  ${fmt(arr, v)}  src=${src}`);
        if (tgt.guid.startsWith('4AB6') && arr && (arr[0] ?? 0) !== 0) captures.push({ t: ts(), out0: arr[0] ?? 0, nz: nz(arr) });
        if (tgt.guid.startsWith('184E') && arr) inStates.add(arr[0] ?? 0);
      });
      item.on('err', (m: string) => console.log(`  (aviso ${tgt.name.trim()}: ${m})`));
    }

    await new Promise<void>((resolve) => setTimeout(resolve, SECONDS * 1000));
    await sub.terminate().catch(() => undefined);

    console.log(`\n== RESUMEN ==`);
    if (captures.length === 0) {
      console.log('INT_OUT_SIRENA[0] nunca cambió de 0 → no se observó comando por ese canal en la ventana.');
    } else {
      const vals = [...new Set(captures.map((c) => c.out0))];
      console.log(`valores de COMANDO captados en INT_OUT_SIRENA[0]: ${vals.map((v) => `${v} ${bits(v)}`).join('  |  ')}`);
      captures.slice(0, 60).forEach((c) => console.log(`  t=${c.t}s  ${c.out0} ${bits(c.out0)}  nz=${JSON.stringify(c.nz)}`));
    }
    console.log(`estados vistos en INT_IN_SIRENA[0]: ${[...inStates].map((v) => `${v}${bits(v)}`).join(', ') || '(sin cambios)'}`);
  } finally {
    await session.close().catch(() => undefined);
    await client.disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('monitor-sirena-sub falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
