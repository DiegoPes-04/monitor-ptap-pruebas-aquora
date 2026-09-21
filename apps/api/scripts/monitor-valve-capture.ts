/**
 * CAPTURADOR del protocolo de válvula de CUALQUIER planta — solo lectura, cero riesgo.
 *
 * Generaliza `monitor-sirena-sub.ts`, que tenía los GUID de Sirena escritos a mano. Aquí los
 * NodeIds salen del propio `opc_mapping.json`, así que sirve para las 10 plantas con canal.
 *
 * Para qué: capturar el valor del pulso de CERRAR, que hoy no existe en el mapping de ninguna
 * planta. `open = 4096` se obtuvo así (el operador lo disparó desde el HMI y la suscripción lo vio);
 * `close` se obtiene igual. NO se deduce: escribir un valor adivinado a un PLC acciona equipo real.
 *
 * Por qué por suscripción y no sondeando: el comando es un PULSO de ~300 ms. A 2-3 lecturas por
 * segundo se pierde. El SERVIDOR muestrea cada 20 ms con cola y entrega todos los cambios.
 *
 * Uso:
 *   PLANT=montebello MONITOR_SECONDS=120 npm exec -w @ptap/api -- tsx scripts/monitor-valve-capture.ts
 *   PLANT=sirena npm exec -w @ptap/api -- tsx scripts/monitor-valve-capture.ts opc.tcp://host:59200
 *
 * Mientras corre, alguien en la planta acciona ABRIR y luego CERRAR desde el HMI. El resumen dice
 * qué valor viajó por el canal en cada caso.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds,
  ClientSubscription, ClientMonitoredItem, TimestampsToReturn,
} from 'node-opcua';
import { resolverEndpoint } from './opc-endpoint';

const ENDPOINT = resolverEndpoint(process.argv[2]);
const SECONDS = Number(process.env.MONITOR_SECONDS ?? 120);
const PLANT = process.env.PLANT ?? 'sirena';

interface BufferDef { browseName: string; node?: { identifier?: string } }
interface Plant { plantId: string; displayName?: string; opcBuffers?: Record<string, BufferDef[]> }

/** Descompone un Int16 en la lista de bits encendidos: es la única forma legible de leer estas palabras. */
const bits = (n: number): string => {
  const u = Number(n) & 0xffff;
  const s: number[] = [];
  for (let b = 0; b < 16; b++) if (u & (1 << b)) s.push(b);
  return `{${s.join(',')}}`;
};
const nz = (arr: number[]): Array<[number, number]> =>
  arr.map((v, i) => [i, Number(v)] as [number, number]).filter(([, v]) => v !== 0);

function bufferDeLaPlanta(p: Plant, prefijo: string): { browseName: string; guid: string } | null {
  for (const lista of Object.values(p.opcBuffers ?? {})) {
    for (const b of lista) {
      if (b.browseName?.startsWith(prefijo)) {
        const id = b.node?.identifier ?? '';
        const guid = id.startsWith('g=') ? id.slice(2) : id;
        if (guid) return { browseName: b.browseName, guid };
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  const mapPath = process.env.OPC_MAPPING_PATH ?? join(__dirname, '..', 'config', 'opc_mapping.json');
  const mapping = JSON.parse(readFileSync(mapPath, 'utf8')) as { plants: Plant[] };
  const planta = mapping.plants.find((p) => p.plantId === PLANT);
  if (!planta) {
    throw new Error(`planta "${PLANT}" no está en el mapping. Disponibles: ${mapping.plants.map((p) => p.plantId).join(', ')}`);
  }

  const out = bufferDeLaPlanta(planta, 'INT_OUT');
  const inp = bufferDeLaPlanta(planta, 'INT_IN');
  if (!out || !inp) {
    throw new Error(
      `"${PLANT}" no tiene buffers INT_OUT/INT_IN (${out ? '' : 'falta INT_OUT '}${inp ? '' : 'falta INT_IN'}). ` +
        `san-antonio y quijote son tanques retransmitidos: no tienen canal de comando propio.`,
    );
  }

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
  /** Pulsos vistos en el canal de comando, en orden: es lo que se viene a buscar. */
  const pulsos: Array<{ t: string; valor: number; nz: Array<[number, number]> }> = [];
  /** Estados vistos, con el instante: permite correlacionar pulso → cambio de estado. */
  const estados: Array<{ t: string; valor: number }> = [];

  try {
    const nsArray = await session.readNamespaceArray();
    const aq = nsArray.indexOf('AQUATECH');
    if (aq < 0) throw new Error('namespace AQUATECH no encontrado en el servidor');

    const sub = ClientSubscription.create(session, {
      requestedPublishingInterval: 100,
      requestedLifetimeCount: 6000,
      requestedMaxKeepAliveCount: 20,
      maxNotificationsPerPublish: 1000,
      publishingEnabled: true,
      priority: 10,
    });

    console.log(`== CAPTURA de protocolo de válvula — ${planta.displayName ?? PLANT} (${PLANT}) ==`);
    console.log(`endpoint ${ENDPOINT}  ·  ns AQUATECH=${aq}  ·  muestreo servidor 20 ms  ·  ventana ${SECONDS}s`);
    console.log(`  COMANDO  ${out.browseName}  (g=${out.guid})`);
    console.log(`  ESTADO   ${inp.browseName}  (g=${inp.guid})`);
    console.log(`\n>>> ACCIONA la válvula desde el HMI AHORA: primero ABRIR, espera, y luego CERRAR.`);
    console.log(`>>> Este script NO escribe nada: solo observa.\n`);

    const targets = [
      { rol: 'COMANDO' as const, name: out.browseName, guid: out.guid },
      { rol: 'ESTADO' as const, name: inp.browseName, guid: inp.guid },
    ];

    for (const tgt of targets) {
      const item = ClientMonitoredItem.create(
        sub,
        { nodeId: `ns=${aq};g=${tgt.guid}`, attributeId: AttributeIds.Value },
        { samplingInterval: 20, discardOldest: false, queueSize: 200 },
        TimestampsToReturn.Both,
      );
      item.on('changed', (dv) => {
        const v = dv.value?.value;
        const arr = Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v as ArrayLike<number>).map(Number) : null;
        if (!arr) return;
        const v0 = arr[0] ?? 0;
        console.log(`t=${ts()}s  ${tgt.rol.padEnd(7)} ${tgt.name}  [0]=${v0} ${bits(v0)}  nz=${JSON.stringify(nz(arr))}`);
        if (tgt.rol === 'COMANDO' && v0 !== 0) pulsos.push({ t: ts(), valor: v0, nz: nz(arr) });
        if (tgt.rol === 'ESTADO') estados.push({ t: ts(), valor: v0 });
      });
      item.on('err', (m: string) => console.log(`  (aviso ${tgt.name}: ${m})`));
    }

    await new Promise<void>((resolve) => setTimeout(resolve, SECONDS * 1000));
    await sub.terminate().catch(() => undefined);

    console.log(`\n${'='.repeat(70)}`);
    console.log(`RESUMEN — ${PLANT}`);
    console.log('='.repeat(70));

    if (pulsos.length === 0) {
      console.log(`\n${out.browseName}[0] nunca salió de 0: no se observó ningún comando en la ventana.`);
      console.log('Posibles causas: no se accionó desde el HMI, el PLC del sitio está caído,');
      console.log('o el comando de esta planta viaja por otro buffer.');
    } else {
      const distintos = [...new Set(pulsos.map((p) => p.valor))];
      console.log(`\nValores de COMANDO captados en ${out.browseName}[0]:`);
      for (const v of distintos) {
        const veces = pulsos.filter((p) => p.valor === v).length;
        console.log(`  ${String(v).padStart(6)}  ${bits(v).padEnd(12)}  ×${veces}`);
      }
      console.log(`\nSecuencia completa (pulso → estado siguiente):`);
      for (const p of pulsos.slice(0, 40)) {
        const despues = estados.find((e) => Number(e.t) > Number(p.t));
        console.log(`  t=${p.t}s  pulso ${p.valor} ${bits(p.valor)}  →  estado ${despues ? `${despues.valor} ${bits(despues.valor)} (t=${despues.t}s)` : 'sin cambio observado'}`);
      }
      if (distintos.length === 1) {
        console.log(`\n⚠️  Solo se vio UN valor (${distintos[0]}). Dos lecturas posibles:`);
        console.log(`   a) es un TOGGLE: el mismo pulso abre y cierra alternando.`);
        console.log(`   b) solo se accionó en un sentido durante la ventana.`);
        console.log(`   Para distinguirlas: repetir accionando ABRIR y CERRAR, y mirar si el`);
        console.log(`   estado alterna con el MISMO valor de comando.`);
      }
    }

    const estDistintos = [...new Set(estados.map((e) => e.valor))];
    console.log(`\nEstados vistos en ${inp.browseName}[0]: ${estDistintos.map((v) => `${v} ${bits(v)}`).join(' · ') || '(sin cambios)'}`);
    if (estDistintos.length <= 1) {
      console.log('  El estado no cambió: sin actuador conectado el pulso no mueve la válvula (esperado hoy).');
    }
    console.log('');
  } finally {
    await session.close().catch(() => undefined);
    await client.disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('monitor-valve-capture falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
