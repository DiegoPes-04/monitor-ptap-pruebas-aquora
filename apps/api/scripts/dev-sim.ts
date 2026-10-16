/**
 * `npm run dev:sim` — la API COMPLETA (main.ts) contra el SIMULADOR de válvulas. Sin VPN, sin la VM,
 * sin PLC. Ver docs/PRUEBAS_LOCALES_VALVULAS.md.
 *
 *   npm run dev:sim -w @ptap/api                          # escenario por defecto (valvulas-de-prueba)
 *   npm run dev:sim -w @ptap/api -- tres-valvulas-x.json  # otro escenario (nombre o ruta)
 *   npm run dev:sim -w @ptap/api -- --check produccion    # solo valida mapping + escenario y sale
 *
 * Qué hace, en orden:
 *  1. Fija SOLO EN ESTE PROCESO el entorno del simulador (dotenv no pisa lo ya definido, así que gana
 *     sobre el .env, que NO se toca): provider=simulator, escrituras habilitadas y una sesión SEGURA
 *     EMULADA (SignAndEncrypt + usuario) para pasar la precondición dura del WriteService.
 *     NO se usa OPCUA_ALLOW_INSECURE_WRITES: con el PLC real esa variable abre escrituras sobre una
 *     sesión sin cifrar; aquí se fuerza a false.
 *  2. Resuelve el escenario y fija OPC_MAPPING_PATH con el mapping que declara, para que TODA la app
 *     (pipeline, WriteService, informes) lea el mismo.
 *  3. Pasa el mapping por el MISMO gate de CI (`validate:mapping`: schema + reglas semánticas) y el
 *     escenario por la validación contra ese mapping. Si algo falla, no arranca.
 *  4. Comprueba que MySQL responde (la app completa lo necesita para login, auditoría y command_log).
 *  5. Arranca main.ts.
 */
import { connect } from 'node:net';
import { join } from 'node:path';
import { loadMapping, resolverRutaDelMapping } from '../src/infrastructure/connectivity/mapping/opc-mapping.loader';
import {
  configDePlanta,
  esMappingSoloSimulacion,
  leerEscenario,
  opcionesDesdeEscenario,
  resolverRutaEscenario,
  validarEscenarioContraMapping,
  type EscenarioLeido,
} from '../src/infrastructure/connectivity/adapters/simulator/sim-scenario';
import { loadJson, validateMapping } from './validate-mapping';

const ESCENARIO_POR_DEFECTO = 'valvulas-de-prueba';

/**
 * Entorno del simulador. Se FUERZA (pisa lo que venga del shell o del .env) porque cada una de estas
 * variables es parte de la garantía "esto no puede tocar el PLC real".
 */
const ENTORNO_FORZADO: Record<string, string> = {
  CONNECTIVITY_PROVIDER: 'simulator',
  OPCUA_WRITES_ENABLED: 'true',
  // Sesión segura EMULADA: el simulador evalúa la precondición igual que el adaptador real
  // (SignAndEncrypt + identidad no anónima). Con provider=simulator no hay ninguna conexión OPC UA.
  OPC_SECURITY_MODE: 'SignAndEncrypt',
  OPC_SECURITY_POLICY: 'Basic256Sha256',
  OPC_IDENTITY: 'username',
  OPC_USERNAME: 'simulador-local',
  OPC_PASSWORD: 'simulador-local',
  OPCUA_ALLOW_INSECURE_WRITES: 'false',
  // Sin servicios de fuera: el correo va al log y la sonda de ruta al PLC (sin VPN) se apaga.
  EMAIL_TRANSPORT: 'console',
  ROUTE_PROBE_ENABLED: 'false',
};

function puertoAbierto(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const fin = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });
}

function salir(mensaje: string): never {
  console.error(`\n✗ dev:sim: ${mensaje}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const soloValidar = args.includes('--check');
  const nombre = args.find((a) => !a.startsWith('--')) ?? process.env.SIM_SCENARIO?.trim() ?? ESCENARIO_POR_DEFECTO;

  for (const [k, v] of Object.entries(ENTORNO_FORZADO)) process.env[k] = v;

  // 2) Escenario y su mapping.
  let leido: EscenarioLeido;
  try {
    // Una ruta relativa se lee desde donde se lanzó npm (INIT_CWD), no desde apps/api: así
    // `npm run dev:sim -- docs/mi-escenario.json` funciona igual desde la raíz que desde el workspace.
    leido = leerEscenario(resolverRutaEscenario(nombre, process.env.INIT_CWD ?? process.cwd()));
  } catch (err) {
    salir(err instanceof Error ? err.message : String(err));
  }
  process.env.SIM_SCENARIO = leido.archivo;
  if (leido.rutaMapping) process.env.OPC_MAPPING_PATH = leido.rutaMapping;

  // .env DESPUÉS de fijar lo anterior: dotenv no pisa variables ya definidas.
  await import('../src/config/load-env');

  // 3) El mismo gate que CI.
  const rutaMapping = resolverRutaDelMapping();
  const schema = loadJson(join(__dirname, '..', 'config', 'opc_mapping.schema.json')) as object;
  const veredicto = validateMapping(schema, loadJson(rutaMapping));
  if (!veredicto.ok) {
    salir(`el mapping ${rutaMapping} NO pasa validate:mapping:\n  - ${veredicto.errors.join('\n  - ')}`);
  }
  const mapping = loadMapping();
  const opciones = opcionesDesdeEscenario(leido);
  const errores = validarEscenarioContraMapping(opciones, mapping);
  if (errores.length > 0) salir(`el escenario ${leido.archivo} no casa con su mapping:\n  - ${errores.join('\n  - ')}`);

  const valvulas = mapping.signals.filter((s) => s.writable && s.write);
  console.log('');
  console.log('──────────────────────────────────────────────────────────────────────────────');
  console.log(' SIMULADOR DE VÁLVULAS — sin VPN, sin VM, sin PLC');
  console.log('──────────────────────────────────────────────────────────────────────────────');
  console.log(` Escenario : ${opciones.name}  (${leido.archivo})`);
  console.log(` Mapping   : ${rutaMapping}${esMappingSoloSimulacion(mapping) ? '  [de PRUEBA: simulationOnly]' : ''}`);
  console.log(` Validación: validate:mapping OK · escenario coherente con el mapping`);
  console.log(` I/O OPC UA: ${opciones.ioLatencyMs} ms por petición (ida y vuelta)`);
  for (const p of mapping.plants) {
    const cfg = configDePlanta(opciones, p.plantId);
    const suyas = valvulas.filter((v) => v.plantId === p.plantId).map((v) => v.domainKey);
    if (suyas.length === 0) continue;
    console.log(
      `   · ${p.plantId.padEnd(16)} MSG ${cfg.msgCycleMs} ms (fase ${cfg.msgPhaseMs}) · vuelta ${cfg.feedbackCycleMs} ms · válvulas: ${suyas.join(', ')}`,
    );
  }
  console.log(` Entorno forzado (solo este proceso): ${Object.keys(ENTORNO_FORZADO).join(', ')}`);
  console.log(' Diagnóstico: GET /api/opc/sim · /api/opc/sim/writes · /api/opc/sim/violations (admin)');
  console.log('──────────────────────────────────────────────────────────────────────────────');

  if (soloValidar) {
    console.log('✓ --check: mapping y escenario válidos. No se arranca la API.\n');
    return;
  }

  // 4) MySQL: la app completa lo necesita (usuarios/JWT, auditoría, command_log, bandeja).
  const host = process.env.DB_HOST ?? '127.0.0.1';
  const port = Number(process.env.DB_PORT ?? 3306);
  if (!(await puertoAbierto(host, port))) {
    salir(
      `MySQL no responde en ${host}:${port}. La API completa lo necesita (login, auditoría, command_log).\n` +
        '  1) Arranca tu MySQL local (el del .env: DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME).\n' +
        '  2) npm run db:migrate -w @ptap/api\n' +
        '  3) npm run db:seed-admin -w @ptap/api   (usa SEED_ADMIN_* del .env)\n' +
        '  4) npm run dev:sim\n' +
        'Para validar solo mapping y escenario, sin base: npm run dev:sim -w @ptap/api -- --check',
    );
  }

  // 5) La API completa.
  await import('../src/main');
}

void main();
