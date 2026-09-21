/**
 * PRUEBA DE CAMPO — canal OFICIAL de comandos contra el PLC real (válvula de Sirena).
 *
 * Proceso ACOTADO y autoterminante (no deja demonio): arranca la app NestJS real en PORT,
 * espera a que el puente OPC UA conecte, diagnostica el interlock, ejecuta el/los comandos por
 * HTTP (pasando por JwtAuthGuard + PermissionGuard + PlantScopeGuard → WriteService: RBAC del
 * mapping, interlock, idempotencia, read-back con timeout, rollback y auditoría), verifica que
 * NO quede bit latente y se cierra.
 *
 * Env:
 *   PORT=4001                 puerto de la instancia de prueba
 *   FT_EMAIL=...              cuenta REAL (activa) cuyo JWT se firma para llamar
 *   FT_MODE=preflight|single|burst|single+burst
 *   FT_BURST_SECONDS=120      duración de la ráfaga
 *   FT_BURST_INTERVAL_MS=5000 intervalo entre comandos
 *
 * Uso:  FT_EMAIL=x@y.com FT_MODE=single npm exec -w @ptap/api -- tsx scripts/fieldtest-valve-run.ts
 */
import 'reflect-metadata';
import '../src/config/load-env';
import { NestFactory } from '@nestjs/core';
import { createPool, type RowDataPacket } from 'mysql2/promise';
import {
  OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds,
  ClientSubscription, ClientMonitoredItem, TimestampsToReturn,
} from 'node-opcua';
import { AppModule } from '../src/modules/app.module';
import { readDatabaseConfig } from '../src/infrastructure/database/database.config';
import { JwtService } from '../src/modules/auth/jwt.service';
import { PlantCache } from '../src/infrastructure/connectivity/pipeline/plant-cache';
import { CONNECTIVITY_ADAPTER } from '../src/infrastructure/connectivity/connectivity.tokens';
import type { ConnectivityAdapter } from '../src/infrastructure/connectivity/ports/connectivity-adapter.port';
import type { Role } from '@ptap/shared';
import { resolverEndpoint } from './opc-endpoint';

const PORT = Number(process.env.PORT ?? 4001);
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = process.env.FT_EMAIL ?? '';
const MODE = process.env.FT_MODE ?? 'preflight';
const BURST_SECONDS = Number(process.env.FT_BURST_SECONDS ?? 120);
const BURST_INTERVAL_MS = Number(process.env.FT_BURST_INTERVAL_MS ?? 5000);
const PLANT = 'sirena';
const TARGET = 'valve1';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 23);
const bits = (n: unknown): string => {
  const u = Number(n) & 0xffff;
  const s: number[] = [];
  for (let b = 0; b < 16; b++) if (u & (1 << b)) s.push(b);
  return `{${s.join(',')}}`;
};

const OUT_EL = { plantId: PLANT, channel: 'intOut', sourceBuffer: 'INT_OUT_SIRENA', index: 0 };
const IN_EL = { plantId: PLANT, channel: 'intIn', sourceBuffer: 'INT_IN_SIRENA', index: 0 };

async function mintJwt(email: string): Promise<{ token: string; role: string; plant: string }> {
  const pool = createPool({ ...readDatabaseConfig(), waitForConnections: true, connectionLimit: 2 });
  try {
    const [rows] = await pool.query<(RowDataPacket & { id: string; email: string; name: string; role: string; plant: string; is_active: number })[]>(
      'SELECT id, email, name, role, plant, is_active FROM users WHERE email = ? LIMIT 1',
      [email],
    );
    if (rows.length === 0) throw new Error(`no existe el usuario ${email}`);
    const u = rows[0];
    if (u.is_active !== 1) throw new Error(`la cuenta ${email} no está activa (JwtAuthGuard la rechazaría)`);
    const token = new JwtService().sign({ sub: u.id, email: u.email, name: u.name, role: u.role as Role, plant: u.plant });
    return { token, role: u.role, plant: u.plant };
  } finally {
    await pool.end();
  }
}

// ── TESTIGO INDEPENDIENTE del canal 0 ────────────────────────────────────────────────────────
// Segunda sesión OPC UA, SEPARADA del puente de la app: observa INT_OUT_SIRENA (comando) e
// INT_IN_SIRENA (estado) con muestreo de 20 ms en el servidor. Es la prueba de que el pulso
// REALMENTE apareció en el canal — independiente de lo que reporte el propio WriteService.
const OUT_GUID = '4AB6ECB4-D019-D4F1-A8A8-6177C3FE3278';
const IN_GUID = '184E4071-DC15-213A-3DE8-442A4E0A354B';

/**
 * Nodos vigilados por el testigo. Los bits de MSG_WRITE_INT_SIRENA son el TRAMO FTOptix → PLC
 * (instrucción MSG por EtherNet/IP hacia el Allen-Bradley): DN=done, ER=error, TO=timeout, ERR=código.
 * Se leen como hijos ESCALARES direccionables (descubiertos con scripts/browse-msg-sirena.ts) — mucho
 * más robusto que decodificar el ExtensionObject completo, que ya tumbó una sesión antes.
 */
const WITNESS_NODES: Array<{ tag: WitnessTag; guid: string; kind: 'array0' | 'scalar' }> = [
  { tag: 'OUT', guid: OUT_GUID, kind: 'array0' },
  { tag: 'IN', guid: IN_GUID, kind: 'array0' },
  { tag: 'MSG.DN', guid: '37D4AE55-3731-D313-BF74-E71D54D2A5F9', kind: 'scalar' },
  { tag: 'MSG.ER', guid: '9940D02E-157D-03CA-C179-240C8DA0E5A1', kind: 'scalar' },
  { tag: 'MSG.TO', guid: '39003436-2EFD-47BD-2CDD-3FA3B49A82BE', kind: 'scalar' },
  { tag: 'MSG.ERR', guid: '86703B23-8C2B-56A5-BEDB-AF0BC4D4C667', kind: 'scalar' },
];

type WitnessTag = 'OUT' | 'IN' | 'MSG.DN' | 'MSG.ER' | 'MSG.TO' | 'MSG.ERR';
interface WitnessEvent { tMs: number; node: WitnessTag; value: number }

async function startWitness(): Promise<{ events: WitnessEvent[]; t0: number; stop: () => Promise<void> }> {
  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    connectionStrategy: { maxRetry: 1, initialDelay: 500, maxDelay: 1500 },
    requestedSessionTimeout: 600000,
  });
  await client.connect(resolverEndpoint(process.argv[2]));
  const session = await client.createSession();
  const nsArray = await session.readNamespaceArray();
  const aq = nsArray.indexOf('AQUATECH');
  if (aq < 0) throw new Error('testigo: namespace AQUATECH no encontrado');

  const sub = ClientSubscription.create(session, {
    requestedPublishingInterval: 100,
    requestedLifetimeCount: 60000,
    requestedMaxKeepAliveCount: 20,
    maxNotificationsPerPublish: 2000,
    publishingEnabled: true,
    priority: 10,
  });

  const events: WitnessEvent[] = [];
  const t0 = Date.now();
  for (const { tag, guid, kind } of WITNESS_NODES) {
    const item = ClientMonitoredItem.create(
      sub,
      { nodeId: `ns=${aq};g=${guid}`, attributeId: AttributeIds.Value },
      { samplingInterval: 20, discardOldest: false, queueSize: 200 },
      TimestampsToReturn.Both,
    );
    item.on('changed', (dv) => {
      const raw = dv.value?.value;
      const v =
        kind === 'array0'
          ? Number((Array.from((raw ?? []) as ArrayLike<number>)[0]) ?? 0)
          : typeof raw === 'boolean'
            ? (raw ? 1 : 0)
            : Number(raw ?? 0);
      const ev: WitnessEvent = { tMs: Date.now() - t0, node: tag, value: v };
      events.push(ev);
      const shown = kind === 'array0' ? `[0]=${v} ${bits(v)}` : `=${v}`;
      console.log(`   [testigo] +${(ev.tMs / 1000).toFixed(2)}s  ${tag}${shown}`);
    });
    item.on('err', (m: string) => console.log(`   [testigo] aviso en ${tag}: ${m}`));
  }
  return {
    events,
    t0,
    stop: async () => {
      await sub.terminate().catch(() => undefined);
      await session.close().catch(() => undefined);
      await client.disconnect().catch(() => undefined);
    },
  };
}

interface CallResult { n: number; at: string; http: number; status?: string; reason?: string | null; written?: unknown; confirmed?: unknown; prev?: unknown; echo?: unknown; verified?: boolean | null; seq?: number | null; ms: number }

async function callCommand(token: string, n: number): Promise<CallResult> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/plants/${PLANT}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ command: 'open', target: TARGET }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text }; }
  const inner = (body.status ? body : (body.message as Record<string, unknown>) ?? body) as Record<string, unknown>;
  return {
    n, at: now(), http: res.status, ms: Date.now() - t0,
    status: inner.status as string, reason: (inner.reason as string) ?? null,
    written: inner.writtenValue, confirmed: inner.confirmedValue, prev: inner.previousValue,
    echo: inner.writeEcho, verified: (inner.writeVerified as boolean | null) ?? null,
    seq: (inner.interlockSequence as number) ?? null,
  };
}

async function main(): Promise<void> {
  if (!EMAIL) { console.error('Falta FT_EMAIL'); process.exit(2); }
  console.log(`\n════════ PRUEBA DE CAMPO — válvula ${PLANT}/${TARGET} ════════`);
  console.log(`modo=${MODE}  puerto=${PORT}  ${new Date().toISOString()}`);

  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.setGlobalPrefix('api', { exclude: ['metrics'] });
  await app.listen(PORT);
  console.log(`${now()}  app de prueba escuchando en ${BASE}`);

  const adapter = app.get<ConnectivityAdapter>(CONNECTIVITY_ADAPTER);
  const cache = app.get(PlantCache);
  let witness: Awaited<ReturnType<typeof startWitness>> | null = null;

  try {
    // ── 1. esperar puente ──
    console.log(`${now()}  esperando puente OPC UA...`);
    for (let i = 0; i < 90 && adapter.getBridgeStatus() !== 'Connected'; i++) await sleep(1000);
    const sec = adapter.getWriteSecurity();
    console.log(`${now()}  bridge=${adapter.getBridgeStatus()}  writeSecurity: secure=${sec.secure} mode=${sec.securityMode} identity=${sec.identity}`);
    if (adapter.getBridgeStatus() !== 'Connected') throw new Error('el puente no llegó a Connected');

    // ── 2. esperar snapshot de la planta ──
    for (let i = 0; i < 40 && !cache.get(PLANT); i++) await sleep(1000);
    const snap = cache.get(PLANT);
    console.log(`${now()}  snapshot ${PLANT}: ${snap ? `sequence=${snap.sequence} señales=${Object.keys(snap.signals).length}` : 'AUSENTE'}`);

    // ── 3. INTERLOCK: esperar a que el puente OBSERVE movimiento real del dato.
    // El interlock exige liveness==='live' por decisión DELIBERADA de seguridad (ver
    // test/write-service.test.ts:183): para accionar equipo no basta sesión viva, hay que estar
    // viendo moverse el dato. `live` requiere un CAMBIO de valor dentro de LIVENESS_LIVE_SEC, y
    // el primer frame nunca cuenta como cambio — así que hay que darle tiempo. Se vigila la
    // liveness DEL SNAPSHOT EN CACHE, que es exactamente lo que lee el interlock.
    const WAIT_LIVE_S = Number(process.env.FT_WAIT_LIVE_S ?? 150);
    console.log(`${now()}  esperando liveness='live' del snapshot en cache (máx ${WAIT_LIVE_S}s)...`);
    let live = false;
    for (let i = 0; i < WAIT_LIVE_S; i++) {
      const s = cache.get(PLANT);
      const st = s?.liveness.state;
      const lca = s?.liveness.lastChangeAt ?? null;
      const age = lca ? (Date.now() - new Date(lca).getTime()) / 1000 : null;
      if (i % 5 === 0 || st === 'live') {
        console.log(`   +${String(i).padStart(3)}s  liveness=${st ?? 'sin snapshot'}  seq=${s?.sequence ?? '-'}  lastChangeAt=${lca ?? 'null'}  antigüedad=${age === null ? 'n/a' : age.toFixed(1) + 's'}`);
      }
      if (st === 'live') { live = true; break; }
      await sleep(1000);
    }
    if (!live) {
      const s = cache.get(PLANT);
      console.log(`${now()}  ⚠️  el snapshot NO alcanzó 'live' (quedó '${s?.liveness.state}'). El interlock rechazará.`);
      console.log(`      Si lastChangeAt es null: el puente no vio NINGÚN cambio de valor en la ventana → planta en régimen quieto.`);
      console.log(`      Si la antigüedad es enorme: el sourceTimestamp del PLC está desfasado del reloj de la VM.`);
    } else {
      console.log(`${now()}  ✅ liveness='live' → el interlock debería permitir el comando.`);
    }

    // ── 4. estado crudo de los buffers antes de tocar nada ──
    const out0 = await adapter.readBufferElement(OUT_EL);
    const in0 = await adapter.readBufferElement(IN_EL);
    console.log(`${now()}  PREVIO  INT_OUT[0]=${out0.value} ${bits(out0.value)}   INT_IN[0]=${in0.value} ${bits(in0.value)}`);

    const { token, role, plant } = await mintJwt(EMAIL);
    console.log(`${now()}  JWT de ${EMAIL} (rol=${role}, planta=${plant}) listo`);

    // ── 4b. TESTIGO: lectura del canal 0 ESTABLECIDA ANTES de comandar ──
    console.log(`\n${now()}  estableciendo TESTIGO independiente sobre INT_OUT_SIRENA[0] (canal 0)...`);
    witness = await startWitness();
    await sleep(2500); // línea base antes del primer pulso
    console.log(`${now()}  testigo activo (${witness.events.length} lecturas de línea base). A partir de aquí, todo cambio del canal 0 queda registrado.\n`);

    const results: CallResult[] = [];

    // ── 5. comando único ──
    if (MODE.includes('single') || MODE === 'preflight') {
      console.log(`\n──── COMANDO ÚNICO por el canal oficial ────`);
      const r = await callCommand(token, 0);
      results.push(r);
      console.log(`${r.at}  HTTP ${r.http}  status=${r.status}  reason=${r.reason}`);
      console.log(`         prev=${r.prev}  written=${r.written}  ECO=${r.echo} verificado=${r.verified}  confirmed(estado)=${r.confirmed}  seq=${r.seq}  (${r.ms}ms)`);
    }

    // ── 6. ráfaga ──
    if (MODE.includes('burst')) {
      const total = Math.floor((BURST_SECONDS * 1000) / BURST_INTERVAL_MS);
      console.log(`\n──── RÁFAGA: ${total} comandos, 1 cada ${BURST_INTERVAL_MS}ms durante ${BURST_SECONDS}s ────`);
      const t0 = Date.now();
      for (let i = 1; i <= total; i++) {
        const tick = Date.now();
        const r = await callCommand(token, i);
        results.push(r);
        console.log(`  #${String(i).padStart(2)} t=${((tick - t0) / 1000).toFixed(1).padStart(5)}s  HTTP ${r.http}  ${r.status}/${r.reason ?? '-'}  written=${r.written} eco=${r.echo} verificado=${r.verified} confirmed=${r.confirmed}  (${r.ms}ms)`);
        const elapsed = Date.now() - tick;
        if (i < total && elapsed < BURST_INTERVAL_MS) await sleep(BURST_INTERVAL_MS - elapsed);
      }
    }

    // ── 6b. VEREDICTO DEL TESTIGO: ¿se vio el pulso en el canal 0? ──
    if (witness) {
      await sleep(1500); // dejar llegar las últimas notificaciones
      const out = witness.events.filter((e) => e.node === 'OUT');
      const inn = witness.events.filter((e) => e.node === 'IN');
      let pulsos = 0;
      let retornos = 0;
      let prev: number | null = null;
      for (const e of out) {
        if (prev !== null && prev !== 4096 && e.value === 4096) pulsos++;
        if (prev === 4096 && e.value === 0) retornos++;
        prev = e.value;
      }
      // el primer evento es la línea base, no una transición
      if (out.length > 0 && out[0].value === 4096) pulsos++;
      console.log(`\n════════ VEREDICTO DEL TESTIGO (canal 0, sesión OPC UA independiente) ════════`);
      console.log(`  eventos observados en INT_OUT_SIRENA[0]: ${out.length}   ·   en INT_IN_SIRENA[0]: ${inn.length}`);
      console.log(`  valores distintos vistos en el canal 0: ${[...new Set(out.map((e) => e.value))].join(', ')}`);
      console.log(`  PULSOS 4096 observados: ${pulsos}   ·   retornos a 0 (rollback): ${retornos}`);
      console.log(`  comandos enviados: ${results.length}`);
      const ok = pulsos >= results.length && results.length > 0;
      console.log(`  ${ok ? '✅ CONFIRMADO' : '⚠️  DISCREPANCIA'}: el testigo ${ok ? 'vio' : 'NO vio'} un pulso 4096 por cada comando enviado.`);
      if (inn.length > 0) {
        console.log(`  estado INT_IN[0] durante toda la prueba: ${[...new Set(inn.map((e) => e.value))].map((v) => `${v} ${bits(v)}`).join(', ')} (sin cambio = canal sin actuador, esperado)`);
      }
      console.log(`  timeline OUT (primeros 12): ${out.slice(0, 12).map((e) => `+${(e.tMs / 1000).toFixed(1)}s=${e.value}`).join('  ')}`);

      // ── TRAMO FTOptix → PLC (instrucción MSG por EtherNet/IP) ──
      const dn = witness.events.filter((e) => e.node === 'MSG.DN');
      const er = witness.events.filter((e) => e.node === 'MSG.ER');
      const to = witness.events.filter((e) => e.node === 'MSG.TO');
      const errCodes = witness.events.filter((e) => e.node === 'MSG.ERR');
      const dnCiclos = dn.filter((e, i) => e.value === 1 && (i === 0 || dn[i - 1].value === 0)).length;
      const erAlto = er.filter((e) => e.value === 1).length;
      const toAlto = to.filter((e) => e.value === 1).length;
      const errNoCero = errCodes.filter((e) => e.value !== 0).length;
      console.log(`\n──── TRAMO FTOptix → PLC (MSG_WRITE_INT_SIRENA, EtherNet/IP) ────`);
      console.log(`  ciclos DN (mensaje completado) : ${dnCiclos}   (eventos DN: ${dn.length})`);
      console.log(`  ER en alto (error de mensaje)  : ${erAlto}`);
      console.log(`  TO en alto (timeout)           : ${toAlto}`);
      console.log(`  ERR != 0 (código de error CIP) : ${errNoCero}${errNoCero ? '  ⚠️' : ''}`);
      if (dnCiclos > 0 && erAlto === 0 && toAlto === 0 && errNoCero === 0) {
        console.log(`  ✅ El transporte al PLC está SANO: la MSG se completa (DN) sin errores ni timeouts.`);
        console.log(`     → el buffer INT_OUT se está entregando al Allen-Bradley; lo que no ocurre es la`);
        console.log(`       ENERGIZACIÓN de la válvula (canal físico dañado), por eso INT_IN no cambia.`);
      } else if (erAlto > 0 || toAlto > 0 || errNoCero > 0) {
        console.log(`  ⚠️  HAY ERRORES en el tramo al PLC → el valor puede NO estar llegando al Allen-Bradley.`);
      } else {
        console.log(`  ⚠️  No se observaron ciclos DN en la ventana: no se puede afirmar que la MSG corriera.`);
      }
    }

    // ── 7. verificación final: nada latente ──
    const outEnd = await adapter.readBufferElement(OUT_EL);
    const inEnd = await adapter.readBufferElement(IN_EL);
    console.log(`\n${now()}  FINAL   INT_OUT[0]=${outEnd.value} ${bits(outEnd.value)}   INT_IN[0]=${inEnd.value} ${bits(inEnd.value)}`);
    console.log(`         bit latente: ${Number(outEnd.value) === 0 ? 'NO (INT_OUT[0]=0, reposo) ✅' : `SÍ ⚠️ INT_OUT[0]=${outEnd.value}`}`);

    // ── 8. resumen ──
    if (results.length) {
      const byStatus = results.reduce<Record<string, number>>((a, r) => { const k = `${r.http} ${r.status}/${r.reason ?? '-'}`; a[k] = (a[k] ?? 0) + 1; return a; }, {});
      console.log(`\n════════ RESUMEN (${results.length} llamadas) ════════`);
      for (const [k, v] of Object.entries(byStatus)) console.log(`  ${v}×  ${k}`);
      const verificados = results.filter((r) => r.verified === true).length;
      console.log(`  ESCRITURA VERIFICADA POR ECO (canal de comando, en el instante): ${verificados}/${results.length}`);
      const ms = results.map((r) => r.ms).sort((a, b) => a - b);
      console.log(`  duración por llamada: min=${ms[0]}ms  mediana=${ms[Math.floor(ms.length / 2)]}ms  max=${ms[ms.length - 1]}ms`);
      console.log(`  JSON: ${JSON.stringify(results)}`);
    }
  } finally {
    if (witness) await witness.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
    console.log(`${now()}  testigo e instancia de prueba cerrados.`);
  }
  process.exit(0);
}

main().catch((err) => { console.error('fieldtest-valve-run falló:', err instanceof Error ? err.stack : err); process.exit(1); });
