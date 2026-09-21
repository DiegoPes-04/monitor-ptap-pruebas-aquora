/**
 * ⛔ ESCRITURA CONTROLADA (acciona el PLC) — pulso a INT_OUT_SIRENA[0].
 * Replica el pulso del HMI: lee estado previo → escribe el valor → read-back → RESTAURA a 0 →
 * read-back. Restaurar a 0 evita dejar un bit de comando LATENTE que se ejecute si el PLC de Sirena
 * revive. Registra todo con marca de tiempo. NO usa el WriteService del backend a propósito: con el
 * PLC de Sirena caído, el interlock del backend RECHAZARÍA (correctamente); esta es una prueba de
 * campo controlada y explícita, autorizada por el operador.
 *
 * REQUIERE confirmación explícita para ejecutar: correr con  --armar  (si no, aborta e informa).
 * Uso:  PULSE=4096 HOLD_MS=1000 npm exec -w @ptap/api -- tsx scripts/write-sirena-pulse.ts --armar
 */
import { OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds, DataType, VariantArrayType } from 'node-opcua';
import { resolverEndpoint } from './opc-endpoint';

const ENDPOINT = resolverEndpoint(process.argv[2]);
const OUT_GUID = '4AB6ECB4-D019-D4F1-A8A8-6177C3FE3278'; // INT_OUT_SIRENA
const IN_GUID = '184E4071-DC15-213A-3DE8-442A4E0A354B';  // INT_IN_SIRENA
const INDEX = Number(process.env.INDEX ?? 0);
const PULSE = Number(process.env.PULSE ?? 4096);   // 4096 = ABRIR (confirmado por captura)
const HOLD_MS = Number(process.env.HOLD_MS ?? 1000);
const ARMED = process.argv.includes('--armar');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const bits = (n: number): string => { const u = Number(n) & 0xffff; const s: number[] = []; for (let b = 0; b < 16; b++) if (u & (1 << b)) s.push(b); return `{${s.join(',')}}`; };

async function main(): Promise<void> {
  if (!ARMED) {
    console.log('ABORTADO: falta --armar. Este script ACCIONA el PLC; no se ejecuta sin la bandera explícita.');
    process.exit(2);
  }
  const client = OPCUAClient.create({
    endpointMustExist: false, securityMode: MessageSecurityMode.None, securityPolicy: SecurityPolicy.None,
    connectionStrategy: { maxRetry: 1, initialDelay: 500, maxDelay: 1500 }, requestedSessionTimeout: 30000,
  });
  await client.connect(ENDPOINT);
  const session = await client.createSession();
  try {
    const nsArray = await session.readNamespaceArray();
    const aq = nsArray.indexOf('AQUATECH');
    if (aq < 0) throw new Error('namespace AQUATECH no encontrado');
    const outId = `ns=${aq};g=${OUT_GUID}`;
    const inId = `ns=${aq};g=${IN_GUID}`;

    const readFull = async (nodeId: string): Promise<number[]> => {
      const dv = await session.read({ nodeId, attributeId: AttributeIds.Value });
      return Array.from((dv.value?.value ?? []) as ArrayLike<number>).map(Number);
    };
    const readEl = async (nodeId: string, idx: number): Promise<number> => (await readFull(nodeId))[idx] ?? 0;
    // Escribe el ARRAY COMPLETO (read-modify-write): más robusto que IndexRange y como lo hace el HMI.
    const writeEl = async (nodeId: string, idx: number, val: number) => {
      const arr = await readFull(nodeId);
      arr[idx] = val;
      return session.write({
        nodeId, attributeId: AttributeIds.Value,
        value: { value: { dataType: DataType.Int16, arrayType: VariantArrayType.Array, value: arr } },
      });
    };

    const stamp = () => new Date().toISOString().slice(11, 23);
    console.log(`== ESCRITURA CONTROLADA Sirena ==  ${ENDPOINT}  ns=${aq}  INT_OUT[${INDEX}]`);

    const prevOut = await readEl(outId, INDEX);
    const prevIn = await readEl(inId, 0);
    console.log(`${stamp()}  PREVIO   OUT[${INDEX}]=${prevOut} ${bits(prevOut)}   IN[0]=${prevIn} ${bits(prevIn)}`);

    const sc1 = await writeEl(outId, INDEX, PULSE);
    console.log(`${stamp()}  WRITE    OUT[${INDEX}] <- ${PULSE} ${bits(PULSE)}   status=${sc1.toString()}`);
    const rb1out = await readEl(outId, INDEX);
    const rb1in = await readEl(inId, 0);
    console.log(`${stamp()}  READBACK OUT[${INDEX}]=${rb1out} ${bits(rb1out)}   IN[0]=${rb1in} ${bits(rb1in)}`);

    await sleep(HOLD_MS);

    const sc0 = await writeEl(outId, INDEX, 0);
    console.log(`${stamp()}  RESTORE  OUT[${INDEX}] <- 0   status=${sc0.toString()}`);
    const rb2out = await readEl(outId, INDEX);
    const rb2in = await readEl(inId, 0);
    console.log(`${stamp()}  READBACK OUT[${INDEX}]=${rb2out} ${bits(rb2out)}   IN[0]=${rb2in} ${bits(rb2in)}`);

    console.log(`\n== RESULTADO ==`);
    console.log(`  escritura del pulso: ${sc1.isGood?.() ? 'aceptada (Good)' : sc1.toString()}`);
    console.log(`  restaurado a 0:      ${rb2out === 0 ? 'sí (sin bit latente)' : `NO (OUT[${INDEX}]=${rb2out}) ⚠️`}`);
    console.log(`  cambio de estado IN[0]: ${prevIn} -> ${rb2in} ${prevIn !== rb2in ? '(¡CAMBIÓ!)' : '(sin cambio — esperado si el PLC de Sirena está caído)'}`);
  } finally {
    await session.close().catch(() => undefined);
    await client.disconnect().catch(() => undefined);
  }
}

main().catch((err) => { console.error('write-sirena-pulse falló:', err instanceof Error ? err.message : err); process.exit(1); });
