/**
 * FASE 2 (deuda declarada) — graba tramas REALES del PLC como fixture de replay.
 *
 * Hoy los tests del parser corren contra el simulador. El simulador lo escribimos nosotros con la
 * idea que tenemos del PLC, así que un test contra él confirma esa idea, no la realidad: si el PLC
 * entrega algo que no anticipamos (una longitud distinta, un StatusCode raro, un hueco), ningún test
 * lo ve. Este script captura lo que el equipo manda de verdad y lo congela en disco.
 *
 * Graba exactamente los `RawPlantFrame` que emite el `OpcUaConnectivityAdapter` — la misma
 * estructura que consume `PlantPipelineService` — así el fixture se inyecta directo al pipeline en
 * un test, sin adaptadores intermedios que puedan enmascarar diferencias.
 *
 * ES SOLO LECTURA: abre una sesión, se suscribe y escucha. No escribe ningún nodo.
 *
 * Uso (desde la VM, con la VPN activa):
 *   CAPTURE_SECONDS=90 npm exec -w @ptap/api -- tsx scripts/capture-plc-fixture.ts
 *   OPC_ENDPOINT=opc.tcp://10.10.51.225:59100 CAPTURE_SECONDS=120 npm exec -w @ptap/api -- tsx scripts/capture-plc-fixture.ts
 *
 * Salida: `test/fixtures/plc-frames-<fecha>.json`, versionable en git.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OpcUaConnectivityAdapter } from '../src/infrastructure/connectivity/adapters/opcua/opcua-connectivity.adapter';
import { loadMapping } from '../src/infrastructure/connectivity/mapping/opc-mapping.loader';
import type { RawPlantFrame } from '../src/infrastructure/connectivity/ports/connectivity-adapter.port';
import type { OpcUaConfig } from '../src/infrastructure/connectivity/connectivity.config';
import { resolverEndpoint } from './opc-endpoint';

const ENDPOINT = resolverEndpoint(process.argv[2]);
const SECONDS = Number(process.env.CAPTURE_SECONDS ?? 90);
const MAX_FRAMES = Number(process.env.CAPTURE_MAX_FRAMES ?? 400);
const OUT_DIR = join(__dirname, '..', 'test', 'fixtures');

function config(): OpcUaConfig {
  return {
    endpoint: ENDPOINT,
    // El servidor se anuncia con su IP interna (10.10.51.225), distinta de la que usamos para
    // llegar: sin esto, node-opcua rechaza el endpoint por no coincidir.
    endpointMustExist: false,
    securityMode: 'None',
    securityPolicy: 'None',
    identity: { type: 'anonymous' },
    autoAcceptUnknownCertificate: true,
    publishingIntervalMs: 2000,
    samplingIntervalMs: 1000,
    subscriptionLifetimeCount: 100,
    subscriptionMaxKeepAliveCount: 10,
    coalesceWindowMs: 200,
    watchdogTimeoutMs: 60_000,
    heartbeatIntervalMs: 30_000,
    heartbeatMaxFailures: 3,
    reconnectInitialDelayMs: 1000,
    reconnectMaxDelayMs: 30_000,
    reconnectMaxRetry: 5,
    subscriptionRecycleMaxAttempts: 3,
    staleThresholdMs: 300_000,
    // Redundante con que el script no escriba, pero explícito: nada de esta captura puede accionar
    // un equipo aunque alguien copie esta configuración a otro lado.
    writesEnabled: false,
    allowInsecureWrites: false,
  };
}

async function main(): Promise<void> {
  const mapping = loadMapping();
  const adapter = new OpcUaConnectivityAdapter(config(), mapping);
  const frames: RawPlantFrame[] = [];
  const porPlanta = new Map<string, number>();

  adapter.onFrame((f) => {
    if (frames.length >= MAX_FRAMES) return;
    frames.push(f);
    porPlanta.set(f.plantId, (porPlanta.get(f.plantId) ?? 0) + 1);
  });

  console.log('='.repeat(72));
  console.log(' CAPTURA DE TRAMAS REALES DEL PLC — solo lectura');
  console.log('='.repeat(72));
  console.log(`  endpoint  ${ENDPOINT}`);
  console.log(`  ventana   ${SECONDS}s   ·   tope ${MAX_FRAMES} tramas`);
  console.log(`  plantas   ${mapping.plants.length}`);
  console.log('='.repeat(72) + '\n');

  await adapter.start();
  const t0 = Date.now();
  const tick = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    console.log(`  t=${String(s).padStart(3)}s  tramas=${String(frames.length).padStart(4)}  plantas vistas=${porPlanta.size}  bridge=${adapter.getBridgeStatus()}`);
  }, 10_000);

  await new Promise<void>((r) => setTimeout(r, SECONDS * 1000));
  clearInterval(tick);
  await adapter.stop().catch(() => undefined);

  if (frames.length === 0) {
    console.error('\nNo se capturó ninguna trama. ¿El puente llegó a Connected? ¿La VPN está arriba?');
    process.exit(1);
  }

  // Se guarda con metadatos: un fixture sin procedencia es imposible de interpretar dentro de un
  // año, y peor, imposible de saber si sigue representando al equipo.
  const fixture = {
    _meta: {
      descripcion: 'Tramas RawPlantFrame capturadas del PLC real. Solo lectura, sin escrituras.',
      capturadoEn: new Date(t0).toISOString(),
      endpoint: ENDPOINT,
      ventanaSegundos: SECONDS,
      protocolVersion: mapping.protocolVersion,
      dtoVersion: mapping.dtoVersion,
      tramas: frames.length,
      plantasVistas: [...porPlanta.entries()].map(([plantId, n]) => ({ plantId, tramas: n })),
    },
    frames,
  };

  const out = join(OUT_DIR, `plc-frames-${new Date(t0).toISOString().slice(0, 10)}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(fixture, null, 2), 'utf8');

  console.log('\n' + '='.repeat(72));
  console.log(' CAPTURA TERMINADA');
  console.log('='.repeat(72));
  console.log(`  tramas          ${frames.length}`);
  console.log(`  plantas vistas  ${porPlanta.size} de ${mapping.plants.length}`);
  for (const [p, n] of [...porPlanta.entries()].sort()) console.log(`      ${p.padEnd(18)} ${n}`);
  const sinVer = mapping.plants.map((p) => p.plantId).filter((p) => !porPlanta.has(p));
  if (sinVer.length) console.log(`  SIN TRAMAS      ${sinVer.join(', ')}  ← revisar si su PLC está caído`);
  console.log(`\n  archivo: ${out}`);
  console.log('='.repeat(72));
}

main().catch((err) => {
  console.error('capture-plc-fixture falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
