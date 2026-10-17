/**
 * ⛔ ESCRITURA CONTROLADA (acciona el PLC) — válvulas de ENTRADA y SALIDA de La Vorágine, con
 *    SEÑAL SOSTENIDA, en INT_OUT_VORAGINE[0].
 *
 * FUENTE: integrador del PLC, 2026-10-16. Las dos válvulas mandan por la MISMA palabra:
 *   - entrada (valve2): abrir = bit2 (4),     cerrar = bit3 (8)
 *   - salida  (valve1): abrir = bit12 (4096), cerrar = bit13 (8192)
 * REGLA, textual: «estas señales deben ser sostenidas, es decir que todo el tiempo debe quedar la
 * señal de apertura o la señal de cierre, nunca las dos, siempre una de las dos».
 *
 * QUÉ HACE: lee la palabra, calcula `(actual & ~contrario) | verbo` —el par de ESA válvula pasa al
 * verbo pedido en UNA escritura; la otra válvula y cualquier otro bit quedan intactos—, cuenta atrás
 * 5 s (Ctrl+C cancela sin escribir), RELEE justo antes y recalcula, escribe, comprueba el eco y
 * observa la planta segundo a segundo, todo a ~/pruebas-voragine/<ISO>-<valvula>-<verbo>.log.
 *
 * DIFERENCIA CON write-sirena-pulse.ts, para que nadie copie de allí:
 *   - aquél RESTAURABA a 0 al terminar, para no dejar un bit latente. Aquí eso es justo lo prohibido:
 *     0 deja las dos válvulas sin señal (0/0). Esta herramienta NO LIMPIA NUNCA: ni al terminar, ni
 *     con Ctrl+C, ni si algo falla.
 *   - aquél escribía el ARRAY COMPLETO como Int16 con una sesión anónima. Ésta escribe UN elemento
 *     (IndexRange) con el DataType del canal, y conecta con la misma configuración, identidad y
 *     funciones de lectura/escritura que el adaptador del backend (opcua-connectivity.adapter.ts):
 *     lo que se pruebe aquí es lo que hará la app.
 *   - aquél llevaba los GUID a mano. Aquí salen del mapping (como read-valve-channels.ts), el
 *     namespace se resuelve con readNamespaceArray, y los bits se COTEJAN con los del mapping: si no
 *     coinciden, no se escribe.
 *
 * NO pasa por el WriteService (ni por su RBAC, su interlock ni la auditoría en MySQL): es para una
 * prueba de campo con un TESTIGO mirando la válvula y el caudal, y el registro es el log. Mientras
 * corre, que nadie mande órdenes desde la app: las dos harían read-modify-write sobre la misma palabra
 * sin un turno común.
 *
 * Conexión: OPC_SECURITY_MODE, OPC_SECURITY_POLICY, OPC_IDENTITY (+ OPC_USERNAME/OPC_PASSWORD) del
 * entorno; lo que falte se toma del .env de la raíz con el MISMO mecanismo que el backend
 * (src/config/load-env, dotenv, que no pisa lo ya definido). Sin nada: anónimo None/None. El endpoint,
 * con resolverEndpoint(): argumento opc.tcp:// > OPC_ENDPOINT > el de opc-endpoint.ts. La contraseña
 * no se imprime ni se registra.
 *
 * Uso (desde apps/api, en la VM):
 *   npx tsx scripts/test-valvulas-voragine.ts                            solo estado (lectura)
 *   npx tsx scripts/test-valvulas-voragine.ts --observar 120             solo observar (lectura)
 *   npx tsx scripts/test-valvulas-voragine.ts salida cerrar              SIMULACRO: qué escribiría (sale con 2)
 *   npx tsx scripts/test-valvulas-voragine.ts salida cerrar --armar      ESCRIBE y observa 60 s
 *   npx tsx scripts/test-valvulas-voragine.ts entrada abrir --armar --observar 120 opc.tcp://host:puerto
 * Códigos de salida: 0 hecho (o nada que hacer), 1 error, 2 simulacro, 130 cancelado.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OPCUAClient, type ClientSession } from 'node-opcua';
import {
  escribirElemento,
  identidadDeSesion,
  leerElemento,
  opcionesDeCliente,
} from '../src/infrastructure/connectivity/adapters/opcua/opcua-connectivity.adapter';
import { loadConnectivityConfig } from '../src/infrastructure/connectivity/connectivity.config';
import { resolverRutaDelMapping } from '../src/infrastructure/connectivity/mapping/opc-mapping.loader';
import type { BufferElementTarget } from '../src/infrastructure/connectivity/ports/connectivity-adapter.port';
import { resolverEndpoint } from './opc-endpoint';
import {
  BUFFER_ESTADO,
  BUFFER_MANDO,
  BUFFER_PROCESO,
  INDICES_PROCESO,
  INDICE_MANDO,
  PLANTA,
  USO,
  VALVULAS,
  cuentaAtras,
  describirPalabra,
  describirPar,
  lineaDeMuestra,
  nodosDelMapping,
  nombreDelLog,
  parsearArgumentos,
  planificar,
  planificarPalabra,
  segundosDeObservacion,
  textoBits,
  verificarContraMapping,
  type Muestra,
  type Plan,
} from './voragine-valvulas-bits';

export const CODIGO = { OK: 0, ERROR: 1, SIMULACRO: 2, CANCELADO: 130 } as const;

/** Cuenta atrás antes de escribir. */
const CUENTA_ATRAS_SEG = 5;

/** Todo lo que la herramienta toma de fuera, para poder probarla contra un servidor OPC UA local. */
export interface Entorno {
  argv: string[];
  rutaMapping: string;
  /** ~/pruebas-voragine en la VM. */
  dirLogs: string;
  /** PKI del cliente OPC UA: la del backend (apps/api/pki), como en el adaptador. */
  pkiRoot: string;
  imprimir: (linea: string) => void;
  esperar: (ms: number) => Promise<void>;
  /** true tras Ctrl+C. */
  cancelado: () => boolean;
  ahora: () => Date;
}

const T_MANDO: BufferElementTarget = { plantId: PLANTA, channel: 'intOut', sourceBuffer: BUFFER_MANDO, index: INDICE_MANDO };
const tEstado = (index: number): BufferElementTarget => ({ plantId: PLANTA, channel: 'intIn', sourceBuffer: BUFFER_ESTADO, index });
const tProceso = (index: number): BufferElementTarget => ({ plantId: PLANTA, channel: 'realIn', sourceBuffer: BUFFER_PROCESO, index });

const mensaje = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const hora = (d: Date): string => d.toTimeString().slice(0, 8);

interface NodeIds {
  mando: string;
  estado: string;
  proceso: string;
}

/** Un elemento como número, o null si no se pudo leer o no es un número con calidad Good. */
async function leerNumero(session: ClientSession, nodeId: string, t: BufferElementTarget): Promise<number | null> {
  try {
    const r = await leerElemento(session, nodeId, t);
    return r.quality === 'Good' && typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null;
  } catch {
    return null;
  }
}

async function leerMuestra(session: ClientSession, ids: NodeIds): Promise<Muestra> {
  return {
    mando: await leerNumero(session, ids.mando, T_MANDO),
    estado: [
      await leerNumero(session, ids.estado, tEstado(0)),
      await leerNumero(session, ids.estado, tEstado(1)),
      await leerNumero(session, ids.estado, tEstado(2)),
    ],
    caudalEntrada: await leerNumero(session, ids.proceso, tProceso(INDICES_PROCESO.caudalEntrada)),
    caudalSalida: await leerNumero(session, ids.proceso, tProceso(INDICES_PROCESO.caudalSalida)),
    nivel: await leerNumero(session, ids.proceso, tProceso(INDICES_PROCESO.nivel)),
  };
}

function lineasDelPlan(p: Plan): string[] {
  const v = VALVULAS[p.valvula];
  return [
    `ORDEN: ${p.valvula.toUpperCase()} (${v.domainKey}, ${v.label}) → ${p.verbo.toUpperCase()}`,
    `  bits de la ${p.valvula}: abrir = ${v.abrir} ${textoBits(v.abrir)}, cerrar = ${v.cerrar} ${textoBits(v.cerrar)}`,
    `  ahora:     ${describirPalabra(p.actual)}`,
    `  escribiría: ${describirPalabra(p.nuevo)}`,
    `  ${BUFFER_MANDO}[${INDICE_MANDO}] ← ${p.aEscribir}  (cambian los bits ${p.bitsQueCambian.length ? `{${p.bitsQueCambian.join(',')}}` : '{}'}; par de la ${p.valvula}: ${describirPar(p.parAntes)} → ${describirPar(p.parDespues)}; la ${p.otra.valvula} sigue en ${describirPar(p.otra.estado)})`,
    ...p.avisos.map((a) => `  ⚠ ${a}`),
  ];
}

/**
 * La herramienta entera. Devuelve el código de salida; no llama a `process.exit` ni toca señales,
 * para que un test pueda ejecutarla contra un servidor local.
 */
export async function ejecutar(e: Entorno): Promise<number> {
  const parse = parsearArgumentos(e.argv);
  if (!parse.ok) {
    e.imprimir(`ERROR: ${parse.error}\n\n${USO}`);
    return CODIGO.ERROR;
  }
  const o = parse.opciones;

  // Lo impreso antes de abrir el log se guarda y se vuelca al abrirlo: el registro empieza por el
  // estado previo, que es lo primero que se pregunta cuando algo sale raro.
  const previas: string[] = [];
  let rutaLog: string | null = null;
  const out = (linea: string): void => {
    e.imprimir(linea);
    if (rutaLog) appendFileSync(rutaLog, `${linea}\n`, 'utf8');
    else previas.push(linea);
  };
  const abrirLog = (): void => {
    if (rutaLog) return;
    mkdirSync(e.dirLogs, { recursive: true });
    rutaLog = join(e.dirLogs, nombreDelLog(e.ahora(), o));
    appendFileSync(rutaLog, previas.map((l) => `${l}\n`).join(''), 'utf8');
    out(`(registro: ${rutaLog})`);
  };

  out(`== La Vorágine — válvulas de entrada y salida, INT_OUT_VORAGINE[0], señal SOSTENIDA ==`);
  out(`${e.ahora().toISOString()}  (hora local ${hora(e.ahora())})`);

  // 1) El mapping: de dónde salen los GUID, y contra qué se cotejan los bits.
  let ids: NodeIds;
  let nsUri: string;
  let discrepancias: string[];
  try {
    const raw: unknown = JSON.parse(readFileSync(e.rutaMapping, 'utf8'));
    const nodos = nodosDelMapping(raw);
    nsUri = nodos.nsUri;
    ids = { mando: nodos.mando, estado: nodos.estado, proceso: nodos.proceso };
    discrepancias = verificarContraMapping(raw);
  } catch (err) {
    out(`ERROR: no se pudo usar el mapping ${e.rutaMapping}: ${mensaje(err)}`);
    return CODIGO.ERROR;
  }
  out(`mapping: ${e.rutaMapping}`);
  if (discrepancias.length > 0) {
    out('⚠ El mapping y esta herramienta NO coinciden:');
    for (const d of discrepancias) out(`   - ${d}`);
    if (o.valvula) {
      out('No se escribe nada, ni en simulacro: antes hay que saber cuál de los dos está mal.');
      return CODIGO.ERROR;
    }
  }

  // 2) Conexión: la misma configuración e identidad que el backend.
  let cfg: ReturnType<typeof loadConnectivityConfig>['opcua'];
  try {
    cfg = loadConnectivityConfig().opcua;
  } catch (err) {
    out(`ERROR en la configuración OPC UA del entorno: ${mensaje(err)}`);
    return CODIGO.ERROR;
  }
  const endpoint = resolverEndpoint(o.endpoint ?? undefined);
  const identidad = cfg.identity.type === 'username' ? `username (${cfg.identity.userName})` : cfg.identity.type;
  out(`endpoint: ${endpoint}`);
  out(`seguridad: ${cfg.securityMode}/${cfg.securityPolicy} · identidad ${identidad}  (la del backend; contraseña no se muestra)`);
  out(`OPCUA_WRITES_ENABLED=${process.env.OPCUA_WRITES_ENABLED ?? '(no definido)'}  — solo informativo: esta herramienta no pasa por el backend`);

  mkdirSync(e.pkiRoot, { recursive: true });
  const client = OPCUAClient.create({
    ...opcionesDeCliente(cfg, e.pkiRoot),
    // La única diferencia con el backend, y a propósito: el backend reintenta para siempre porque es un
    // servicio; una herramienta que se queda reintentando contra un puerto muerto no informa de nada.
    connectionStrategy: { maxRetry: 1, initialDelay: 500, maxDelay: 1500 },
  });
  let session: ClientSession | null = null;
  try {
    await client.connect(endpoint);
    session = await client.createSession(identidadDeSesion(cfg.identity, e.pkiRoot));
  } catch (err) {
    out(`ERROR: no se pudo abrir la sesión OPC UA en ${endpoint}: ${mensaje(err)}`);
    await client.disconnect().catch(() => undefined);
    return CODIGO.ERROR;
  }

  try {
    const nsArray = await session.readNamespaceArray();
    const ns = nsArray.indexOf(nsUri);
    if (ns < 0) {
      out(`ERROR: el servidor no publica el namespace "${nsUri}". Publica: ${nsArray.join(', ')}`);
      return CODIGO.ERROR;
    }
    const nodeIds: NodeIds = { mando: `ns=${ns};${ids.mando}`, estado: `ns=${ns};${ids.estado}`, proceso: `ns=${ns};${ids.proceso}` };
    out(`nodos: ${BUFFER_MANDO} ${nodeIds.mando} · ${BUFFER_ESTADO} ${nodeIds.estado} · ${BUFFER_PROCESO} ${nodeIds.proceso}`);

    const observar = async (segundos: number): Promise<void> => {
      out('');
      out(`OBSERVANDO ${segundos} s, una línea por segundo (Ctrl+C deja de mirar; no se limpia nada):`);
      let antes: Muestra | null = null;
      for (let i = 0; i < segundos; i++) {
        if (e.cancelado()) {
          out('observación interrumpida con Ctrl+C. No se limpia nada.');
          return;
        }
        const m = await leerMuestra(session!, nodeIds);
        out(lineaDeMuestra(hora(e.ahora()), m, antes));
        antes = m;
        for (let d = 0; d < 10 && !e.cancelado(); d++) await e.esperar(100);
      }
    };

    // 3) Estado actual.
    const inicial = await leerMuestra(session, nodeIds);
    out('');
    out('ESTADO ACTUAL');
    out(lineaDeMuestra(hora(e.ahora()), inicial, null));
    if (inicial.mando !== null) out(`  ${BUFFER_MANDO}[${INDICE_MANDO}] = ${describirPalabra(inicial.mando)}`);

    // 3-bis) Modo `palabra <valor>`: la palabra ENTERA con un valor exacto (ver planificarPalabra).
    if (o.palabra !== null) {
      if (inicial.mando === null) {
        out(`ERROR: no se pudo leer ${BUFFER_MANDO}[${INDICE_MANDO}]. No se escribe nada sin ver antes lo que hay.`);
        return CODIGO.ERROR;
      }
      const pp = planificarPalabra(inicial.mando, o.palabra);
      out('');
      out(`PALABRA ENTERA: ${BUFFER_MANDO}[${INDICE_MANDO}] ← ${pp.aEscribir}`);
      out(`  ahora:      ${describirPalabra(pp.actual)}`);
      out(`  escribiría: ${describirPalabra(pp.nuevo)}  (cambian los bits {${pp.bitsQueCambian.join(',')}})`);
      for (const a of pp.avisos) out(`  ⚠ ${a}`);
      if (!pp.cambia) {
        out('La palabra ya tiene ese valor: no hay nada que escribir.');
        return CODIGO.OK;
      }
      if (!o.armar) {
        out('');
        out('SIMULACRO: no se ha escrito nada. Para escribir, repite con --armar, con un testigo mirando las válvulas y el caudal.');
        return CODIGO.SIMULACRO;
      }
      abrirLog();
      out('');
      out(`⛔ ARMADA: se va a escribir ${BUFFER_MANDO}[${INDICE_MANDO}] ← ${pp.aEscribir} en ${CUENTA_ATRAS_SEG} s.`);
      if (!(await cuentaAtras(CUENTA_ATRAS_SEG, { esperar: e.esperar, cancelado: e.cancelado, imprimir: out }))) {
        out('CANCELADO con Ctrl+C: NO se escribió nada.');
        return CODIGO.CANCELADO;
      }
      out(`ESCRIBIENDO ${BUFFER_MANDO}[${INDICE_MANDO}] ← ${pp.aEscribir}  (${hora(e.ahora())})`);
      try {
        await escribirElemento(session, nodeIds.mando, T_MANDO, pp.aEscribir);
      } catch (err) {
        out(`ESCRITURA RECHAZADA: ${mensaje(err)}. No se reintenta ni se deshace nada.`);
        return CODIGO.ERROR;
      }
      out('  escritura aceptada por el servidor (StatusCode Good)');
      let ecoOk = false;
      try {
        const eco = await leerElemento(session, nodeIds.mando, T_MANDO);
        ecoOk = eco.value === pp.aEscribir;
        out(ecoOk ? `  ECO OK: ${describirPalabra(Number(eco.value))}` : `  ⚠ ECO DISTINTO: se escribió ${pp.aEscribir} y se lee ${String(eco.value)} (calidad ${eco.quality}).`);
      } catch (err) {
        out(`  ⚠ no se pudo releer el eco: ${mensaje(err)}`);
      }
      const seg = segundosDeObservacion(o);
      if (seg > 0) await observar(seg);
      out('');
      out(`FIN. ${BUFFER_MANDO}[${INDICE_MANDO}] queda en ${pp.aEscribir}. No se limpia nada al salir.`);
      return ecoOk ? CODIGO.OK : CODIGO.ERROR;
    }

    if (!o.valvula || !o.verbo) {
      const seg = segundosDeObservacion(o);
      if (seg > 0) {
        abrirLog();
        await observar(seg);
      }
      return CODIGO.OK;
    }

    // 4) La orden: qué se escribiría.
    if (inicial.mando === null) {
      out(`ERROR: no se pudo leer ${BUFFER_MANDO}[${INDICE_MANDO}]. Sin la palabra actual no se calcula ninguna escritura.`);
      return CODIGO.ERROR;
    }
    let plan = planificar(inicial.mando, o.valvula, o.verbo, { limpiarAjenos: o.sinAjenos });
    out('');
    for (const l of lineasDelPlan(plan)) out(l);

    if (!plan.cambia) {
      out(`La ${o.valvula} YA tiene la señal de ${o.verbo}${o.sinAjenos ? ' y no hay bits ajenos' : ''}: no hay nada que escribir.`);
      if (o.observarSeg) {
        abrirLog();
        await observar(o.observarSeg);
      }
      return CODIGO.OK;
    }
    if (!o.armar) {
      out('');
      out('SIMULACRO: no se ha escrito nada. Para escribir, repite con --armar, con un testigo mirando la válvula y el caudal.');
      return CODIGO.SIMULACRO;
    }

    // 5) Armada: cuenta atrás, relectura, escritura, eco.
    abrirLog();
    out('');
    out(`⛔ ARMADA: se va a escribir ${BUFFER_MANDO}[${INDICE_MANDO}] ← ${plan.aEscribir} en ${CUENTA_ATRAS_SEG} s.`);
    const completa = await cuentaAtras(CUENTA_ATRAS_SEG, { esperar: e.esperar, cancelado: e.cancelado, imprimir: out });
    if (!completa) {
      out('CANCELADO con Ctrl+C: NO se escribió nada.');
      return CODIGO.CANCELADO;
    }

    // Releer JUSTO antes: en cinco segundos alguien pudo mandar la otra válvula desde la app, y escribir
    // lo calculado con la lectura vieja le borraría su par.
    const fresca = await leerElemento(session, nodeIds.mando, T_MANDO);
    if (fresca.quality !== 'Good' || typeof fresca.value !== 'number' || !Number.isFinite(fresca.value)) {
      out(`ERROR: la relectura justo antes de escribir falló (valor ${String(fresca.value)}, calidad ${fresca.quality}). NO se escribe nada.`);
      return CODIGO.ERROR;
    }
    if (fresca.value !== inicial.mando) {
      out(`⚠ La palabra cambió durante la cuenta atrás (${inicial.mando} → ${fresca.value}): se recalcula sobre la nueva.`);
      plan = planificar(fresca.value, o.valvula, o.verbo, { limpiarAjenos: o.sinAjenos });
      for (const l of lineasDelPlan(plan)) out(l);
      if (!plan.cambia) {
        out(`La ${o.valvula} ya tiene la señal de ${o.verbo}: no se escribe nada.`);
        return CODIGO.OK;
      }
    }

    out(`ESCRIBIENDO ${BUFFER_MANDO}[${INDICE_MANDO}] ← ${plan.aEscribir}  (${hora(e.ahora())})`);
    try {
      await escribirElemento(session, nodeIds.mando, T_MANDO, plan.aEscribir);
    } catch (err) {
      out(`ESCRITURA RECHAZADA: ${mensaje(err)}. No se reintenta ni se deshace nada.`);
      return CODIGO.ERROR;
    }
    out('  escritura aceptada por el servidor (StatusCode Good)');

    let ecoOk = false;
    try {
      const eco = await leerElemento(session, nodeIds.mando, T_MANDO);
      ecoOk = eco.value === plan.aEscribir;
      out(
        ecoOk
          ? `  ECO OK: ${BUFFER_MANDO}[${INDICE_MANDO}] = ${String(eco.value)} — ${describirPalabra(Number(eco.value))}`
          : `  ⚠ ECO DISTINTO: se escribió ${plan.aEscribir} y se lee ${String(eco.value)} (calidad ${eco.quality}). Alguien más escribe en la palabra, o el servidor no lo dejó así. No se deshace nada.`,
      );
    } catch (err) {
      out(`  ⚠ no se pudo releer el eco: ${mensaje(err)}`);
    }

    const seg = segundosDeObservacion(o);
    if (seg > 0) await observar(seg);

    out('');
    out(`FIN. NO se limpia nada al salir: la señal de ${o.verbo} de la ${o.valvula} queda SOSTENIDA en ${BUFFER_MANDO}[${INDICE_MANDO}] = ${plan.aEscribir}.`);
    return ecoOk ? CODIGO.OK : CODIGO.ERROR;
  } catch (err) {
    out(`ERROR: ${mensaje(err)}`);
    return CODIGO.ERROR;
  } finally {
    await session.close().catch(() => undefined);
    await client.disconnect().catch(() => undefined);
  }
}

if (require.main === module) {
  void (async () => {
    // El .env de la raíz, con el MISMO mecanismo que el backend. Se carga aquí y no arriba del archivo
    // para que importar este módulo (los tests) no meta el .env del desarrollador en el proceso.
    await import('../src/config/load-env');

    let cancelado = false;
    process.on('SIGINT', () => {
      if (cancelado) {
        console.error('\nSegundo Ctrl+C: se sale ya. No se limpia nada.');
        process.exit(CODIGO.CANCELADO);
      }
      cancelado = true;
      console.error('\nCtrl+C: antes de escribir, cancela sin escribir; observando, deja de mirar. No se limpia nada.');
    });

    const codigo = await ejecutar({
      argv: process.argv.slice(2),
      // El mapping que cargaría el backend con este mismo entorno (OPC_MAPPING_PATH, si no vacío; si no,
      // config/opc_mapping.json). Con `??` un `OPC_MAPPING_PATH=` vacío en el .env dejaba la ruta en ''.
      rutaMapping: resolverRutaDelMapping(),
      dirLogs: join(homedir(), 'pruebas-voragine'),
      pkiRoot: join(__dirname, '..', 'pki'),
      imprimir: (linea) => console.log(linea),
      esperar: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      cancelado: () => cancelado,
      ahora: () => new Date(),
    });
    process.exit(codigo);
  })().catch((err) => {
    console.error('test-valvulas-voragine falló:', mensaje(err));
    process.exit(CODIGO.ERROR);
  });
}
