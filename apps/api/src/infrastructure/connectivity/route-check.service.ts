import { Inject, Injectable } from '@nestjs/common';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { CONNECTIVITY_ADAPTER } from './connectivity.tokens';
import type { ConnectivityAdapter } from './ports/connectivity-adapter.port';

/**
 * Prueba de ruta EN VIVO servidor → PLC, para el diagnóstico del admin. Automatiza lo que en el
 * incidente 2026-07-21/22 se hizo a mano con Test-NetConnection: sondas crudas (sin OPC UA)
 * que acotan DÓNDE está fallando la cadena, porque "no llegan datos" tiene varias causas
 * distintas con responsables distintos:
 *
 *   1. El SERVIDOR no tiene salida a internet          → proveedor del servidor (SRV-07)
 *   2. Internet OK, host SIN ping y TCP sin respuesta  → ruta intermedia o planta (PLC-01)
 *   3. Internet OK, host CON ping y TCP sin respuesta  → puerto FILTRADO: host vivo con un
 *      cortafuegos descartando el TCP (PLC-12) — la evidencia clave del 2026-07-22
 *   4. El host contesta pero RECHAZA el puerto          → servicio OPC del maestro caído (PLC-11)
 *   5. El puerto acepta                                 → la red está BIEN; mirar la sesión OPC
 *
 * Las distinciones importan: TIMEOUT = los paquetes salen y nadie contesta (descartados);
 * RECHAZO inmediato = host vivo sin nada escuchando; PING OK + TCP muerto = el host existe y
 * está en línea, alguien filtra el puerto (no es "la planta sin internet").
 *
 * El veredicto NUNCA culpa a un tramo sin evidencia — ese fue el error del banner original, que
 * atribuía el corte a la planta cuando podía ser el internet del propio servidor.
 */

export type ProbeOutcome = 'ok' | 'timeout' | 'refused' | 'error';

export interface ProbeResult {
  /** Qué tramo prueba: salida a internet del servidor, ping ICMP al host, o TCP al puerto OPC. */
  name: 'internet' | 'ping' | 'plc' | 'control';
  target: string; // host[:puerto]
  outcome: ProbeOutcome;
  ms: number;
  /** Código de error del socket cuando outcome = error (p. ej. ENOTFOUND). */
  detail: string | null;
}

export interface RouteVerdict {
  /** Código del catálogo (docs/CATALOGO_ERRORES.md). '—' si la ruta está bien. */
  code: string;
  where: 'servidor' | 'ruta-o-planta' | 'plc-servicio' | 'ninguno';
  message: string;
}

export interface RouteCheckReport {
  at: string;
  target: { endpoint: string; host: string; port: number };
  /** IP pública del servidor (con ella un técnico identifica al proveedor vía whois). null si no
   *  se pudo consultar — coherente con SRV-07 si además la sonda de internet falló. */
  serverPublicIp: string | null;
  probes: ProbeResult[];
  verdict: RouteVerdict;
  bridge: { status: string; reconnectCount: number; lastNotificationAt: string | null };
}

// Timeouts de sonda: cortos a propósito (es una prueba interactiva, no el puente). Un firewall
// que descarta paquetes jamás contesta, así que esperar más solo retrasa el mismo veredicto.
const INTERNET_PROBE_TIMEOUT_MS = 3000;
const PLC_PROBE_TIMEOUT_MS = 5000;
const PUBLIC_IP_TIMEOUT_MS = 4000;

/** Host público estable para probar la salida a internet del servidor (DNS de Google, TCP/53). */
const INTERNET_PROBE_HOST = '8.8.8.8';
const INTERNET_PROBE_PORT = 53;

/**
 * Puerto de CONTROL en el MISMO host del PLC: la sonda que distingue "no hay ruta hasta ese
 * equipo" de "bloquearon exactamente el puerto OPC UA".
 *
 * Nace del corte del 2026-08-25. El TCP al 59200 devolvia EHOSTUNREACH y el veredicto lo leyo
 * como un problema de ruta, cuando bastaba tocar OTRO puerto del mismo host para verlo: el 443,
 * el 22 y el 59100 contestaban RST en 25 ms. El equipo era perfectamente alcanzable y lo unico
 * bloqueado era el puerto del OPC UA. Media hora de diagnostico para algo que esta sonda
 * responde en 25 ms.
 *
 * Se usa el 443 y no un puerto al azar porque un RST desde ahi prueba lo unico que hace falta
 * probar: que los paquetes LLEGAN al equipo y este responde. No importa que no haya nada
 * escuchando — "cerrado" es exactamente la respuesta util.
 */
const CONTROL_PROBE_PORT = 443;
const CONTROL_PROBE_TIMEOUT_MS = 4000;

/**
 * Veredicto puro (testeable sin red) a partir de las sondas. `ping` es opcional: si no se pudo
 * ejecutar (comando ausente), el veredicto cae a la versión sin ping.
 */
export function buildVerdict(
  internet: ProbeResult,
  plc: ProbeResult,
  ping: ProbeResult | null = null,
  control: ProbeResult | null = null,
): RouteVerdict {
  if (internet.outcome !== 'ok') {
    return {
      code: 'SRV-07',
      where: 'servidor',
      message:
        'El SERVIDOR no tiene salida a internet. El problema está en la red o el proveedor del ' +
        'servidor de monitoreo, no en la planta. Revisar el internet del sitio donde corre el servidor.',
    };
  }
  if (plc.outcome === 'ok') {
    return {
      code: '—',
      where: 'ninguno',
      message:
        'La ruta de red está bien: el puerto del PLC acepta conexiones. Si aun así no llegan ' +
        'datos, el problema es la sesión OPC UA (ver el estado del puente y el heartbeat).',
    };
  }
  if (plc.outcome === 'refused') {
    return {
      code: 'PLC-11',
      where: 'plc-servicio',
      message:
        'El equipo de la planta responde, pero RECHAZA la conexión en el puerto OPC UA: el host ' +
        'está vivo y nada escucha en ese puerto. El servicio del PLC maestro está caído o cambió de puerto.',
    };
  }
  // TCP sin respuesta al puerto del OPC UA. Aquí se decide A QUIÉN se puede señalar, y el orden
  // de las comprobaciones es el orden de la FUERZA de la evidencia, no el de los casos.
  if (ping?.outcome === 'ok') {
    // La sonda de CONTROL es la evidencia más fuerte que tenemos, así que manda cuando existe.
    // Si otro puerto del MISMO host contesta —da igual que esté cerrado, "cerrado" ya prueba que
    // el paquete llega y vuelve— quedan descartadas de golpe la ruta, la VPN, el internet del
    // servidor y una IP equivocada. Sin esta sonda hubo que deducirlo a mano el 2026-08-25.
    if (control && (control.outcome === 'ok' || control.outcome === 'refused')) {
      const rutaDescartada =
        `El router de la planta es ALCANZABLE y responde: otro puerto del mismo host contestó en ` +
        `${control.ms} ms. Queda DESCARTADO que sea la ruta de red, la VPN, el internet del ` +
        'servidor de monitoreo o una IP equivocada — si fuera cualquiera de esas, el puerto de ' +
        'control tampoco respondería. ';

      // Y ahora CÓMO murió el TCP separa dos culpables distintos:
      //
      //   ERROR (ICMP inalcanzable) → el router ACEPTÓ el paquete y lo reenvió: si no hubiera
      //     regla de reenvío contestaría RST al instante, como el control. Intentó entregarlo
      //     dentro de la planta y no encontró a nadie. El retardo lo confirma — un bloqueo
      //     descarta en silencio o rechaza en milisegundos, nunca tarda segundos; esos segundos
      //     son el router agotando el ARP hacia una máquina que no está.
      //   TIMEOUT (nada, nunca) → el paquete se descarta en silencio: cortafuegos filtrando.
      //
      // La diferencia decide a quién se llama: "enciendan el PC del OPC UA" o "abran el paso".
      if (plc.outcome === 'error') {
        return {
          code: 'PLC-13',
          where: 'plc-servicio',
          message:
            rutaDescartada +
            `El router SÍ acepta el puerto del OPC UA y reenvía, pero el equipo que está detrás no ` +
            `contesta: la conexión murió con ${plc.detail ?? 'un error de red'} tras ${plc.ms} ms. ` +
            'Si no existiera la regla de reenvío, el router habría rechazado al instante como el ' +
            'puerto de control; y un cortafuegos que bloquea no tarda segundos. Ese retardo es el ' +
            'router buscando dentro de la planta a una máquina que no responde. LO QUE HAY QUE ' +
            'PEDIR: que comprueben que el PC del servidor OPC UA (FactoryTalk Optix) está ENCENDIDO ' +
            'y con red, y que su IP interna sigue siendo la del reenvío. No es un problema de ' +
            'permisos ni de puertos cerrados: no hay nada que abrir.',
        };
      }
      return {
        code: 'PLC-12',
        where: 'ruta-o-planta',
        message:
          rutaDescartada +
          'El puerto del OPC UA no contesta NADA (descartado en silencio), que es la firma de un ' +
          'cortafuegos filtrando justo ese puerto. Solo lo puede cambiar quien lo administra. ' +
          'Pedir acceso por VPN o un túnel controlado hasta la planta; NO pedir que reabran el ' +
          'puerto a internet: eso es exactamente el hallazgo P0 (sesión anónima y sin cifrar sobre ' +
          'infraestructura de agua potable), y cerrarlo es la mitigación que este proyecto pidió ' +
          'por escrito.',
      };
    }

    // Sin sonda de control (o el control también cayó): la evidencia es más pobre y el veredicto
    // tiene que reflejarlo en vez de fingir certeza.
    if (plc.outcome === 'timeout') {
      return {
        code: 'PLC-12',
        where: 'ruta-o-planta',
        message:
          'El host del PLC está VIVO (responde ping) pero el puerto OPC UA no responde: un ' +
          'cortafuegos está FILTRANDO el puerto. No es "la planta sin internet" ni una IP incorrecta — ' +
          'es un bloqueo deliberado o mal configurado. Pedir al administrador OT acceso por VPN o la ' +
          'apertura controlada del puerto (NO reabrirlo a internet: hallazgo P0).',
      };
    }
    return {
      code: 'PLC-12',
      where: 'ruta-o-planta',
      message:
        `El host del PLC está VIVO (responde ping) pero la conexión al puerto OPC UA fue ` +
        `RECHAZADA con un error de red${plc.detail ? ` (${plc.detail})` : ''}: algo del camino ` +
        'contestó "inalcanzable" en vez de dejar pasar el TCP. NO es lo mismo que un puerto ' +
        'filtrado en silencio, y con esta evidencia no se puede señalar un solo responsable: ' +
        'cabe una regla de cortafuegos que rechaza activamente en la planta, y cabe un fallo de ' +
        'ruta o de NAT en el trayecto (incluido el lado del servidor de monitoreo). Comprobar ' +
        'PRIMERO la ruta desde el servidor (tabla de rutas, VPN, NAT del proveedor) antes de ' +
        'pedirle al administrador OT que abra nada.',
    };
  }
  return {
    code: 'PLC-01',
    where: 'ruta-o-planta',
    message:
      'El servidor SÍ tiene internet, pero los paquetes hacia el PLC no obtienen respuesta' +
      (ping ? ' (tampoco el ping)' : '') +
      '. Típico de un cortafuegos que descarta todo, un equipo apagado o una IP que ya no corresponde. ' +
      'La falla está en la ruta intermedia (VPN/firewall/NAT) o en la planta — no en el servidor.',
  };
}

const PING_TIMEOUT_MS = 3000;

/** Solo IPs/hostnames legítimos llegan al comando ping (defensa en profundidad: viene de .env). */
const SAFE_HOST = /^[a-zA-Z0-9.\-]+$/;

/**
 * Ping ICMP al host vía el comando del sistema (Node no puede ICMP sin privilegios de raw
 * socket). `execFile` sin shell: el host jamás se interpola en una línea de comandos. La
 * evidencia que aporta es la que el TCP no puede dar: un host que responde ping con el puerto
 * muerto está VIVO detrás de un filtro — no apagado ni en una IP equivocada.
 */
export function pingHost(host: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const finish = (outcome: ProbeOutcome, detail: string | null = null) =>
      resolve({ name: 'ping', target: host, outcome, ms: Date.now() - started, detail });

    if (!SAFE_HOST.test(host)) return finish('error', 'host inválido');

    const isWin = process.platform === 'win32';
    const args = isWin
      ? ['-n', '1', '-w', String(PING_TIMEOUT_MS), host]
      : ['-c', '1', '-W', String(Math.ceil(PING_TIMEOUT_MS / 1000)), host];

    execFile('ping', args, { timeout: PING_TIMEOUT_MS + 2000 }, (err, stdout) => {
      // En Windows, ping puede salir con código 0 aunque la respuesta sea "host inaccesible":
      // la señal fiable de eco recibido es el TTL en la salida.
      const replied = !err && (!isWin || /ttl=/i.test(stdout));
      if (replied) return finish('ok');
      finish(err && 'code' in err && err.code === 'ENOENT' ? 'error' : 'timeout', err ? String(err.code ?? '') || null : null);
    });
  });
}

/** Una conexión TCP cruda con timeout. No habla OPC UA: solo mide si el puerto contesta. */
export function probeTcp(
  name: ProbeResult['name'],
  host: string,
  port: number,
  timeoutMs: number,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = connect({ host, port });
    const finish = (outcome: ProbeOutcome, detail: string | null = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ name, target: `${host}:${port}`, outcome, ms: Date.now() - started, detail });
    };
    socket.setTimeout(timeoutMs, () => finish('timeout'));
    socket.once('connect', () => finish('ok'));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      finish(err.code === 'ECONNREFUSED' ? 'refused' : 'error', err.code ?? err.message),
    );
  });
}

@Injectable()
export class RouteCheckService {
  constructor(@Inject(CONNECTIVITY_ADAPTER) private readonly adapter: ConnectivityAdapter) {}

  /** IP pública del servidor (fail-soft: null si no hay internet o el servicio no responde). */
  private async lookupPublicIp(): Promise<string | null> {
    try {
      const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS) });
      if (!res.ok) return null;
      const ip = (await res.text()).trim();
      return ip.length > 0 && ip.length <= 45 ? ip : null;
    } catch {
      return null;
    }
  }

  async run(): Promise<RouteCheckReport> {
    // El endpoint real del puente, de la MISMA fuente que usa el adapter (.env con default).
    const endpoint = process.env.OPC_ENDPOINT ?? 'opc.tcp://10.10.51.225:59100';
    const url = new URL(endpoint);
    const host = url.hostname;
    const port = Number(url.port) || 4840; // 4840 = puerto estándar OPC UA

    // Las consultas en paralelo: son independientes y la prueba es interactiva.
    const [internet, ping, plc, control, serverPublicIp] = await Promise.all([
      probeTcp('internet', INTERNET_PROBE_HOST, INTERNET_PROBE_PORT, INTERNET_PROBE_TIMEOUT_MS),
      pingHost(host),
      probeTcp('plc', host, port, PLC_PROBE_TIMEOUT_MS),
      // Control: otro puerto del MISMO host. Solo importa si CONTESTA, no si está abierto.
      probeTcp('control', host, CONTROL_PROBE_PORT, CONTROL_PROBE_TIMEOUT_MS),
      this.lookupPublicIp(),
    ]);

    const diagnostics = this.adapter.getDiagnostics();
    return {
      at: new Date().toISOString(),
      target: { endpoint, host, port },
      serverPublicIp,
      probes: [internet, ping, plc, control],
      // Si el comando ping no existe en el sistema (error ENOENT), no aporta evidencia.
      verdict: buildVerdict(internet, plc, ping.outcome === 'error' ? null : ping, control),
      bridge: {
        status: diagnostics.bridgeStatus,
        reconnectCount: diagnostics.reconnectCount,
        lastNotificationAt: diagnostics.lastNotificationAt,
      },
    };
  }
}
