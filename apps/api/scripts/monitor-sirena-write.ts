/**
 * MONITOR (solo lectura) del canal de COMANDO de Sirena — captura de valores de escritura.
 * Sondea ~10/s durante 60 s `INT_OUT_SIRENA[0]` (comando) e `INT_IN_SIRENA[0]` (estado) para
 * CAPTAR qué valor aparece cuando se ejecuta un comando (abrir/cerrar) desde el HMI/PLC.
 * NO escribe nada. Guarda un CSV con las 600 muestras y resume los valores no-cero captados.
 * Uso:  npm exec -w @ptap/api -- tsx scripts/monitor-sirena-write.ts  [opc.tcp://host:puerto]
 */
import { OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds } from 'node-opcua';
import { writeFileSync } from 'node:fs';
import { resolverEndpoint } from './opc-endpoint';

const ENDPOINT = resolverEndpoint(process.argv[2]);
const OUT_GUID = '4AB6ECB4-D019-D4F1-A8A8-6177C3FE3278'; // INT_OUT_SIRENA (comando)
const IN_GUID = '184E4071-DC15-213A-3DE8-442A4E0A354B';  // INT_IN_SIRENA  (estado)
const HZ = 10;
const SECONDS = Number(process.env.MONITOR_SECONDS ?? 60);
const PERIOD = Math.round(1000 / HZ);
const CSV = 'C:/Users/USUARIO/AppData/Local/Temp/claude/c--Users-USUARIO-Documents-GitHub-monitor-ptap/8f0a239c-bd07-46da-93f3-2a1854e9a58b/scratchpad/sirena-write-capture.csv';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const bits = (n: number): string => {
  const u = Number(n) & 0xffff;
  const s: number[] = [];
  for (let b = 0; b < 16; b++) if (u & (1 << b)) s.push(b);
  return `{${s.join(',')}}`;
};
const nz = (arr: number[]): Array<[number, number]> => arr.map((v, i) => [i, Number(v)] as [number, number]).filter(([, v]) => v !== 0);

async function main(): Promise<void> {
  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    connectionStrategy: { maxRetry: 1, initialDelay: 500, maxDelay: 1500 },
    requestedSessionTimeout: 90000,
  });
  await client.connect(ENDPOINT);
  const session = await client.createSession();
  try {
    const nsArray = await session.readNamespaceArray();
    const aq = nsArray.indexOf('AQUATECH');
    if (aq < 0) throw new Error('namespace AQUATECH no encontrado');
    const outId = `ns=${aq};g=${OUT_GUID}`;
    const inId = `ns=${aq};g=${IN_GUID}`;

    console.log(`== MONITOR Sirena (solo lectura) ==`);
    console.log(`endpoint ${ENDPOINT}  ·  ns AQUATECH=${aq}  ·  ${HZ}/s × ${SECONDS}s`);
    console.log(`>>> EJECUTA LOS COMANDOS (abrir/cerrar) AHORA. Registro cambios de OUT[0]/IN[0]:\n`);

    const samples: Array<{ ts: string; out0: number; in0: number; outNz: Array<[number, number]> }> = [];
    let prevOut0: number | null = null;
    let prevIn0: number | null = null;
    let captures = 0;
    const t0 = Date.now();
    const total = HZ * SECONDS;

    for (let i = 0; i < total; i++) {
      const tick = Date.now();
      const [outR, inR] = await session.read([
        { nodeId: outId, attributeId: AttributeIds.Value },
        { nodeId: inId, attributeId: AttributeIds.Value },
      ]);
      const outArr = Array.from((outR.value?.value ?? []) as ArrayLike<number>).map(Number);
      const inArr = Array.from((inR.value?.value ?? []) as ArrayLike<number>).map(Number);
      const out0 = outArr[0] ?? 0;
      const in0 = inArr[0] ?? 0;
      const ts = ((tick - t0) / 1000).toFixed(2);
      const outNz = nz(outArr);
      samples.push({ ts, out0, in0, outNz });

      if (out0 !== prevOut0 || in0 !== prevIn0) {
        console.log(`t=${ts.padStart(5)}s  OUT[0]=${String(out0).padStart(6)} ${bits(out0)}  OUTnz=${JSON.stringify(outNz)}  |  IN[0]=${String(in0).padStart(6)} ${bits(in0)}`);
        if (out0 !== 0 && out0 !== prevOut0) captures++;
        prevOut0 = out0;
        prevIn0 = in0;
      } else if (i % (HZ * 5) === 0) {
        console.log(`t=${ts.padStart(5)}s  (estable) OUT[0]=${out0}  IN[0]=${in0}`);
      }

      const elapsed = Date.now() - tick;
      if (elapsed < PERIOD) await sleep(PERIOD - elapsed);
    }

    // Resumen
    const distinctOut = [...new Set(samples.map((s) => s.out0))].sort((a, b) => a - b);
    const nonzero = samples.filter((s) => s.out0 !== 0);
    console.log(`\n== RESUMEN (${samples.length} muestras) ==`);
    console.log(`valores distintos en OUT[0]: ${distinctOut.join(', ')}`);
    console.log(`muestras con OUT[0]!=0: ${nonzero.length}`);
    for (const v of distinctOut.filter((x) => x !== 0)) {
      const hits = nonzero.filter((s) => s.out0 === v);
      console.log(`  valor ${v} ${bits(v)} — visto en ${hits.length} muestras, primero en t=${hits[0].ts}s (con OUTnz=${JSON.stringify(hits[0].outNz)})`);
    }
    const inStates = [...new Set(samples.map((s) => s.in0))].sort((a, b) => a - b);
    console.log(`estados vistos en IN[0]: ${inStates.map((v) => `${v}${bits(v)}`).join(', ')}`);

    try {
      writeFileSync(CSV, 'ts_s,out0,in0,out_nonzero\n' + samples.map((s) => `${s.ts},${s.out0},${s.in0},"${JSON.stringify(s.outNz)}"`).join('\n'));
      console.log(`\nCSV con las ${samples.length} muestras: ${CSV}`);
    } catch (e) {
      console.log('(no se pudo guardar CSV:', e instanceof Error ? e.message : e, ')');
    }
  } finally {
    await session.close().catch(() => undefined);
    await client.disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('monitor-sirena-write falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
