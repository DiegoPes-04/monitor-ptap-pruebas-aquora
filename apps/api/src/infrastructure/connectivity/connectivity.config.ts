/**
 * Configuración del módulo de conectividad. TODO sale de .env (regla 8); cero
 * valores quemados en el resto del código. Aquí se centralizan los defaults.
 */

export type ConnectivityProvider = 'simulator' | 'opcua';

export interface OpcIdentityAnonymous {
  type: 'anonymous';
}
export interface OpcIdentityUserName {
  type: 'username';
  userName: string;
  password: string;
}
export interface OpcIdentityCertificate {
  type: 'certificate';
}
export type OpcIdentity = OpcIdentityAnonymous | OpcIdentityUserName | OpcIdentityCertificate;

export interface OpcUaConfig {
  endpoint: string;
  endpointMustExist: boolean;
  securityMode: string; // None | Sign | SignAndEncrypt
  securityPolicy: string; // None | Basic256Sha256 | Aes128_Sha256_RsaOaep | Aes256_Sha256_RsaPss
  identity: OpcIdentity;
  /** Fase 4: true SOLO para desarrollo/bootstrap; en producción debe ser false (confiar certs a mano). */
  autoAcceptUnknownCertificate: boolean;
  publishingIntervalMs: number;
  samplingIntervalMs: number;
  /** Vida de la Subscription en múltiplos de publishingInterval (OPC UA Part 4 exige >= 3× keepAlive). */
  subscriptionLifetimeCount: number;
  subscriptionMaxKeepAliveCount: number;
  /** Ventana de coalescing por planta: un RawPlantFrame por planta por ventana. Default = publishingInterval (nota: con jitter puede fusionar dos ciclos; bajarla si se necesita 1 frame/ciclo estricto). */
  coalesceWindowMs: number;
  watchdogTimeoutMs: number;
  heartbeatIntervalMs: number;
  /** Fallos de heartbeat CONSECUTIVOS que fuerzan Connected → Recovering. */
  heartbeatMaxFailures: number;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  reconnectMaxRetry: number;
  subscriptionRecycleMaxAttempts: number;
  staleThresholdMs: number;
  writesEnabled: boolean; // OPCUA_WRITES_ENABLED (Fase 5); aquí solo se lee, nunca habilita write en Fase 1
  /**
   * ⚠️ EXCEPCIÓN DELIBERADA Y TEMPORAL a la regla 9 ("sin excepciones, ni para probar"): permite
   * que `getWriteSecurity()` reporte `secure:true` aunque la sesión NO sea SignAndEncrypt+no-anónima.
   * Existe SOLO porque el servidor real hoy únicamente acepta Anonymous+None (hallazgo P0) y se
   * necesitó una prueba de campo controlada (válvula de Sirena, 2026-07-29). Default false — debe
   * quedar en false salvo durante una prueba explícita, auditada y revertida al terminar.
   */
  allowInsecureWrites: boolean; // OPCUA_ALLOW_INSECURE_WRITES
}

export interface LivenessConfig {
  /** Un cambio dentro de esta ventana (s) → estado `live`. */
  liveSec: number;
  /** Sin cambios más allá de esta ventana (s) → estado `stale`. Default por planta en el mapping. */
  windowSec: number;
  /** Cada cuánto se re-evalúa el liveness (para pasar idle→stale sin frames nuevos). */
  sweepMs: number;
}

export interface ConnectivityConfig {
  provider: ConnectivityProvider;
  opcua: OpcUaConfig;
  liveness: LivenessConfig;
  /**
   * Tope del ring de DeadLetter en RAM (regla 12: "tope acotado ... por env"). Acota la memoria
   * del buffer de señales anómalas: los CONTADORES por tipo nunca se pierden, solo se descartan
   * las entradas más viejas del detalle. 0 = ilimitado está PROHIBIDO por eso mismo — el mínimo
   * es 1, así que un valor inválido revienta al arrancar en vez de dejar crecer el ring sin fin.
   */
  deadLetterCapacity: number;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Variable de entorno ${name} inválida: "${raw}" (se esperaba número ≥ 0)`);
  }
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function resolveIdentity(): OpcIdentity {
  const kind = str('OPC_IDENTITY', 'anonymous').toLowerCase();
  if (kind === 'username') {
    const userName = process.env.OPC_USERNAME ?? '';
    const password = process.env.OPC_PASSWORD ?? '';
    if (!userName) throw new Error('OPC_IDENTITY=username requiere OPC_USERNAME');
    return { type: 'username', userName, password };
  }
  if (kind === 'certificate') {
    return { type: 'certificate' };
  }
  return { type: 'anonymous' };
}

export function loadConnectivityConfig(): ConnectivityConfig {
  const provider = str('CONNECTIVITY_PROVIDER', 'opcua').toLowerCase();
  if (provider !== 'simulator' && provider !== 'opcua') {
    throw new Error(`CONNECTIVITY_PROVIDER inválido: "${provider}" (simulator | opcua)`);
  }

  const publishingIntervalMs = num('OPCUA_PUBLISHING_INTERVAL_MS', 2000);
  const subscriptionLifetimeCount = num('OPCUA_REQUESTED_LIFETIME_COUNT', 100);
  const subscriptionMaxKeepAliveCount = num('OPCUA_REQUESTED_MAX_KEEPALIVE_COUNT', 10);

  // Validación de arranque (regla 8 + spec OPC UA Part 4): si la relación no se
  // cumple, el backend NO debe iniciar. El throw mata el useFactory del módulo.
  if (subscriptionMaxKeepAliveCount < 1) {
    throw new Error(`OPCUA_REQUESTED_MAX_KEEPALIVE_COUNT (${subscriptionMaxKeepAliveCount}) debe ser >= 1`);
  }
  if (subscriptionLifetimeCount < 3 * subscriptionMaxKeepAliveCount) {
    throw new Error(
      `OPCUA_REQUESTED_LIFETIME_COUNT (${subscriptionLifetimeCount}) debe ser >= 3 × ` +
        `OPCUA_REQUESTED_MAX_KEEPALIVE_COUNT (${subscriptionMaxKeepAliveCount}) — spec OPC UA Part 4`,
    );
  }

  // Regla 12: el tope del DeadLetter sale de .env, no del código. Un ring de capacidad 0
  // no acota nada — se traga las entradas en silencio, que es justo lo que la regla prohíbe.
  const deadLetterCapacity = num('OPC_DEAD_LETTER_CAPACITY', 500);
  if (deadLetterCapacity < 1) {
    throw new Error(`OPC_DEAD_LETTER_CAPACITY (${deadLetterCapacity}) debe ser >= 1`);
  }

  return {
    provider,
    opcua: {
      // Ruta interna por la red OT: la planta cerró el path público el 2026-09-21. El servidor se
      // anuncia con esta misma IP interna, pero tras NAT → endpointMustExist:false igualmente.
      endpoint: str('OPC_ENDPOINT', 'opc.tcp://10.10.51.225:59100'),
      endpointMustExist: bool('OPC_ENDPOINT_MUST_EXIST', false),
      securityMode: str('OPC_SECURITY_MODE', 'None'),
      securityPolicy: str('OPC_SECURITY_POLICY', 'None'),
      identity: resolveIdentity(),
      publishingIntervalMs,
      samplingIntervalMs: num('OPCUA_SAMPLING_INTERVAL_MS', 1000),
      subscriptionLifetimeCount,
      subscriptionMaxKeepAliveCount,
      coalesceWindowMs: num('OPCUA_COALESCE_WINDOW_MS', publishingIntervalMs),
      watchdogTimeoutMs: num('OPCUA_WATCHDOG_TIMEOUT_MS', 30000),
      heartbeatIntervalMs: num('OPCUA_HEARTBEAT_INTERVAL_MS', 10000),
      heartbeatMaxFailures: num('OPCUA_HEARTBEAT_MAX_FAILURES', 2),
      reconnectInitialDelayMs: num('OPCUA_RECONNECT_INITIAL_DELAY_MS', 1000),
      reconnectMaxDelayMs: num('OPCUA_RECONNECT_MAX_DELAY_MS', 30000),
      reconnectMaxRetry: num('OPCUA_RECONNECT_MAX_RETRY', 1_000_000), // efectivamente indefinido; el operador restaura la red sin reiniciar
      subscriptionRecycleMaxAttempts: num('OPCUA_SUBSCRIPTION_RECYCLE_MAX_ATTEMPTS', 3),
      staleThresholdMs: num('OPCUA_STALE_THRESHOLD_MS', 300000), // 5 min (FASE 0.3: frescura de datos)
      writesEnabled: bool('OPCUA_WRITES_ENABLED', false),
      allowInsecureWrites: bool('OPCUA_ALLOW_INSECURE_WRITES', false),
      autoAcceptUnknownCertificate: bool('OPC_AUTO_ACCEPT_UNKNOWN_CERTIFICATE', false),
    },
    liveness: {
      liveSec: num('LIVENESS_LIVE_SEC', 10),
      windowSec: num('LIVENESS_WINDOW_SEC', 300),
      sweepMs: num('LIVENESS_SWEEP_MS', 2000),
    },
    deadLetterCapacity,
  };
}
