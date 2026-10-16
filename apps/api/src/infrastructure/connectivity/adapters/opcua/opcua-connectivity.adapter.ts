import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import {
  AttributeIds,
  ClientMonitoredItem,
  ClientSession,
  ClientSubscription,
  DataType,
  DataValue,
  MessageSecurityMode,
  NumericRange,
  OPCUACertificateManager,
  OPCUAClient,
  resolveNodeId,
  SecurityPolicy,
  StatusCodes,
  TimestampsToReturn,
  UserTokenType,
  Variant,
  VariantArrayType,
} from 'node-opcua';
import type { OPCUAClientOptions, UserIdentityInfo } from 'node-opcua';
import { coerceCertificate } from 'node-opcua-crypto';
import { BridgeStateMachine } from '../../bridge/bridge-state-machine';
import { FrameCoalescer } from '../../bridge/frame-coalescer';
import { HeartbeatMonitor } from '../../bridge/heartbeat-monitor';
import { Watchdog } from '../../bridge/watchdog';
import type { OpcIdentity, OpcUaConfig } from '../../connectivity.config';
import type { LoadedMapping, MonitorTarget } from '../../mapping/opc-mapping.loader';
import { NamespaceNotFoundError, resolveNamespaces } from '../../opcua/namespace-resolver';
import type {
  AdapterDiagnostics,
  BridgeStatus,
  BufferElementRead,
  BufferElementTarget,
  BufferHealth,
  ConnectivityAdapter,
  OpcQuality,
  RawBufferSample,
  RawPlantFrame,
  ServerInfo,
  WriteSecurity,
} from '../../ports/connectivity-adapter.port';

/** Tipo OPC UA del elemento según el canal de buffer (para construir el Variant de escritura). */
function channelDataType(channel: string): DataType {
  if (channel === 'realIn' || channel === 'realOut') return DataType.Double;
  if (channel === 'bitIn' || channel === 'bitOut') return DataType.Boolean;
  return DataType.Int32; // intIn | intOut | msgRead | msgWrite
}

interface ResolvedTarget extends MonitorTarget {
  nodeId: string;
  resolved: boolean;
  faultReason: string | null;
}

const SECURITY_MODES: Record<string, MessageSecurityMode> = {
  None: MessageSecurityMode.None,
  Sign: MessageSecurityMode.Sign,
  SignAndEncrypt: MessageSecurityMode.SignAndEncrypt,
};

function toSecurityPolicy(name: string): SecurityPolicy {
  const key = name as keyof typeof SecurityPolicy;
  const value = SecurityPolicy[key];
  return typeof value === 'string' ? (value as SecurityPolicy) : SecurityPolicy.None;
}

/** Severidad Good (bits 30-31 == 0) del StatusCode, sin depender de igualdad por referencia. */
function isGoodStatus(sc: { value: number }): boolean {
  return ((sc.value >>> 30) & 0x3) === 0;
}

// ── Lo que una herramienta de campo tiene que hacer EXACTAMENTE igual que el backend ──────────
//
// Conexión, identidad, y lectura/escritura de UN elemento. Viven fuera de la clase y exportadas para
// que scripts/test-valvulas-voragine.ts las use tal cual: una herramienta que escribe en el PLC con
// otro DataType, otro IndexRange u otra identidad que el backend prueba OTRA cosa, y su resultado no
// dice nada de lo que hará la app. La clase las usa igual que antes.

/**
 * Opciones del cliente OPC UA: aplicación, modo y política de seguridad, PKI y reconexión. `pkiRoot`
 * tiene que existir (la clase lo crea en `createClient`).
 */
export function opcionesDeCliente(config: OpcUaConfig, pkiRoot: string): OPCUAClientOptions {
  return {
    applicationName: 'monitor-ptap-gateway',
    endpointMustExist: config.endpointMustExist,
    securityMode: SECURITY_MODES[config.securityMode] ?? MessageSecurityMode.None,
    securityPolicy: toSecurityPolicy(config.securityPolicy),
    connectionStrategy: {
      initialDelay: config.reconnectInitialDelayMs,
      maxDelay: config.reconnectMaxDelayMs,
      maxRetry: config.reconnectMaxRetry,
    },
    keepSessionAlive: true,
    clientCertificateManager: new OPCUACertificateManager({
      rootFolder: pkiRoot,
      // Fase 4 (regla 8): antes quemado en `true`; ahora sale de .env. En producción
      // contra el servidor de la planta debe ser false (confiar certs a mano, ver
      // docs/OPTIX_CLIENT_CERT_TRUST.md).
      automaticallyAcceptUnknownCertificate: config.autoAcceptUnknownCertificate,
    }),
  };
}

/**
 * Identidad de sesión. Para `certificate`, lee el certificado/llave que OPCUACertificateManager
 * autogenera en disco al conectar el cliente: hay que llamarla DESPUÉS de `client.connect()`.
 */
export function identidadDeSesion(identity: OpcIdentity, pkiRoot: string): UserIdentityInfo {
  if (identity.type === 'username') {
    return {
      type: UserTokenType.UserName,
      userName: identity.userName,
      password: identity.password,
    };
  }
  if (identity.type === 'certificate') {
    const certificateFile = join(pkiRoot, 'own', 'certs', 'client_certificate.pem');
    const privateKeyFile = join(pkiRoot, 'own', 'private', 'private_key.pem');
    if (!existsSync(certificateFile) || !existsSync(privateKeyFile)) {
      throw new Error(
        `OPC_IDENTITY=certificate pero no se encontró el certificado de cliente en ${certificateFile} ` +
          `(¿createClient() no corrió antes de buildIdentity()?)`,
      );
    }
    return {
      type: UserTokenType.Certificate,
      certificateData: coerceCertificate(readFileSync(certificateFile, 'utf8')),
      privateKey: readFileSync(privateKeyFile, 'utf8'),
    };
  }
  return { type: UserTokenType.Anonymous };
}

/** Escribe UN elemento del array (IndexRange), con el DataType del canal. Lanza si no es Good. */
export async function escribirElemento(
  session: ClientSession,
  nodeId: string,
  target: BufferElementTarget,
  value: number | boolean,
): Promise<void> {
  const statusCode = await session.write({
    nodeId: resolveNodeId(nodeId),
    attributeId: AttributeIds.Value,
    indexRange: new NumericRange(target.index), // escribe UN elemento del array (regla 6: nunca el array entero por gusto)
    value: {
      value: new Variant({
        dataType: channelDataType(target.channel),
        arrayType: VariantArrayType.Array,
        value: [value],
      }),
    },
  });
  if (statusCode.value !== StatusCodes.Good.value) {
    throw new Error(`write OPC UA rechazado (${statusCode.toString()}) en ${target.sourceBuffer}[${target.index}]`);
  }
}

/** Lee UN elemento del array (IndexRange). */
export async function leerElemento(
  session: ClientSession,
  nodeId: string,
  target: BufferElementTarget,
): Promise<BufferElementRead> {
  const dv = await session.read({
    nodeId: resolveNodeId(nodeId),
    attributeId: AttributeIds.Value,
    indexRange: new NumericRange(target.index),
  });
  const raw = Array.isArray(dv.value?.value) ? dv.value.value[0] : dv.value?.value;
  const value = typeof raw === 'boolean' ? raw : raw == null ? null : Number(raw);
  return {
    value,
    quality: isGoodStatus(dv.statusCode) ? 'Good' : 'Bad',
    sourceTimestamp: dv.sourceTimestamp ? new Date(dv.sourceTimestamp).toISOString() : null,
  };
}

const SERVER_STATES = ['Running', 'Failed', 'NoConfiguration', 'Suspended', 'Shutdown', 'Test', 'CommunicationFault', 'Unknown'];
function serverStateName(raw: unknown): string | null {
  if (typeof raw !== 'number') return raw != null ? String(raw) : null;
  return SERVER_STATES[raw] ?? String(raw);
}

/**
 * Adaptador OPC UA real. Push-based: los datos llegan por una Subscription
 * (regla 6: 1 MonitoredItem por buffer). Máquina de estados BridgeStatus,
 * reconexión con backoff, watchdog, heartbeat y verificación de NodeIds al conectar.
 * No conoce la PTAP (regla 3): solo endpoints, NodeIds y buffers crudos.
 */
export class OpcUaConnectivityAdapter implements ConnectivityAdapter {
  readonly provider = 'opcua' as const;

  private readonly logger = new Logger('OpcUaBridge');
  private readonly bridge = new BridgeStateMachine(this.logger, 'opcua');
  private readonly watchdog: Watchdog;
  private readonly heartbeat: HeartbeatMonitor;
  private readonly coalescer: FrameCoalescer;
  private readonly frameListeners = new Set<(f: RawPlantFrame) => void>();

  private client: OPCUAClient | null = null;
  private session: ClientSession | null = null;
  private subscription: ClientSubscription | null = null;
  private monitoredItems: ClientMonitoredItem[] = [];

  private targets: ResolvedTarget[] = [];
  private nsMap = new Map<string, number>();

  private reconnectCount = 0;
  private recycleCount = 0;
  private notificationsTotal = 0;
  private lastNotificationAt: string | null = null;
  private lastNotificationLatencyMs: number | null = null;
  private readonly lastFrameByPlant = new Map<string, string>();
  /** Último frame EMITIDO al dominio (ms). Con `connectedSinceMs`, detecta el atasco aguas abajo. */
  private lastFrameEmittedAtMs: number | null = null;
  private connectedSinceMs: number | null = null;
  private starting = false;
  private recycling = false; // guard: evita reciclajes concurrentes (watchdog vs heartbeat)

  constructor(
    private readonly config: OpcUaConfig,
    private readonly mapping: LoadedMapping,
  ) {
    this.watchdog = new Watchdog(config.watchdogTimeoutMs, () => void this.onWatchdogTimeout());
    this.coalescer = new FrameCoalescer(config.coalesceWindowMs, (f) => this.emitFrame(f));
    this.heartbeat = new HeartbeatMonitor({
      intervalMs: config.heartbeatIntervalMs,
      maxFailures: config.heartbeatMaxFailures,
      probe: () => this.heartbeatProbe(),
      onFailureThreshold: (reason) => void this.onHeartbeatThreshold(reason),
    });
  }

  // ── ciclo de vida ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.starting || this.bridge.is('Connected')) return;
    this.starting = true;
    this.bridge.transition('Connecting', `conectando a ${this.config.endpoint}`);
    try {
      this.client = this.createClient();
      this.wireClientEvents(this.client);
      this.logger.log(`conectando a ${this.config.endpoint} (${this.config.securityMode}/${this.config.securityPolicy})`);
      await this.client.connect(this.config.endpoint);
      this.logger.log('canal seguro abierto; creando sesión');
      this.session = await this.client.createSession(this.buildIdentity());
      this.logger.log('sesión abierta; resolviendo NodeIds');
      await this.resolveTargets();
      await this.setupSubscription();
      // El coalescer se REUTILIZA entre ciclos y `stop()` lo deja mudo: reactivarlo aquí es lo
      // único que hace que los datos vuelvan a fluir tras una reconexión (ver FrameCoalescer).
      this.coalescer.start();
      this.heartbeat.start();
      this.watchdog.start();
      // Un `start()` que no es el primero ES una reconexión: sin esto, `reconnectCount` solo
      // contaba las que resuelve node-opcua por dentro y reportaba 0 tras recuperaciones reales
      // que pasan por Faulted → cliente nuevo. Como señal de salud, mentía justo cuando importa.
      if (this.connectedSinceMs !== null) this.reconnectCount++;
      this.connectedSinceMs = Date.now();
      this.lastFrameEmittedAtMs = null; // el reloj del atasco cuenta desde esta conexión
      this.bridge.transition('Connected', 'sesión + subscription listas');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof NamespaceNotFoundError) {
        // Config/servidor equivocado: no se arregla reintentando.
        this.bridge.transition('Faulted', `namespace no resuelto: ${message}`);
      } else {
        this.bridge.transition('Disconnected', `fallo al conectar: ${message}`);
      }
      await this.teardownSession().catch(() => undefined);
      // Cerrar TAMBIÉN el cliente: `teardownSession()` solo suelta sesión/subscription. Sin esto,
      // cada reintento fallido tras `connect()` fuga un OPCUAClient completo (socket + canal
      // seguro + 3 listeners), porque el siguiente `createClient()` sobrescribe la referencia
      // sin desconectar la anterior — fuga sin cota con un mapping mal configurado (reintenta
      // indefinido). Es lo mismo que ya hace stop().
      if (this.client) {
        await this.client.disconnect().catch(() => undefined);
        this.client = null;
      }
      throw err;
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    this.watchdog.stop();
    this.heartbeat.stop();
    this.coalescer.stop(); // flushea pendientes con el bridge aún "vivo" (regla 12)
    await this.teardownSession().catch(() => undefined);
    if (this.client) await this.client.disconnect().catch(() => undefined);
    this.client = null;
    this.bridge.transition('Disconnected', 'stop()');
  }

  getBridgeStatus(): BridgeStatus {
    return this.bridge.get();
  }
  onFrame(listener: (frame: RawPlantFrame) => void): void {
    this.frameListeners.add(listener);
  }
  onStatusChange(listener: (status: BridgeStatus, reason: string) => void): void {
    this.bridge.onChange(listener);
  }

  // ── conexión ───────────────────────────────────────────────────────────────

  /** cwd del backend es apps/api (npm -w @ptap/api). PKI del cliente OPC UA (gitignored). */
  private readonly pkiRoot = join(process.cwd(), 'pki');

  private createClient(): OPCUAClient {
    // El árbol PKI del cliente debe existir antes de instanciar el CertificateManager:
    // node-opcua no garantiza crearlo en un clon limpio y fallaría con un error críptico.
    // mkdir recursive es idempotente (no falla si ya existe).
    mkdirSync(this.pkiRoot, { recursive: true });
    return OPCUAClient.create(opcionesDeCliente(this.config, this.pkiRoot));
  }

  /**
   * Identidad de sesión. Para `certificate`, lee el certificado/llave que
   * OPCUACertificateManager ya autogeneró en disco al construir el cliente (llamado
   * SIEMPRE antes que buildIdentity() en start(): client.connect() → createSession(buildIdentity())),
   * así que los archivos ya existen para cuando esto corre — sin condición de carrera.
   */
  private buildIdentity(): UserIdentityInfo {
    return identidadDeSesion(this.config.identity, this.pkiRoot);
  }

  private wireClientEvents(client: OPCUAClient): void {
    client.on('connection_lost', () => {
      this.watchdog.stop();
      this.bridge.transition('Recovering', 'connection_lost (backoff en curso)');
    });
    client.on('connection_reestablished', () => {
      this.reconnectCount++;
      this.logger.warn(`reconexión #${this.reconnectCount}: re-creando subscription`);
      void this.onReconnected();
    });
    client.on('backoff', (retry: number, delay: number) => {
      this.logger.warn(`backoff de reconexión: intento ${retry}, próximo en ${delay}ms`);
    });
  }

  private async onReconnected(): Promise<void> {
    try {
      await this.resolveTargets();
      await this.setupSubscription();
      this.coalescer.start(); // idempotente; defensa por si algún camino lo dejó parado
      this.watchdog.start();
      this.bridge.transition('Connected', 'reconectado; subscription re-creada');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof NamespaceNotFoundError) this.bridge.transition('Faulted', `namespace no resuelto tras reconexión: ${message}`);
      else this.bridge.transition('Recovering', `re-setup falló: ${message}`);
    }
  }

  // ── resolución de NodeIds (requiere sesión viva) ───────────────────────────

  private async resolveTargets(): Promise<void> {
    if (!this.session) throw new Error('sin sesión');
    const namespaceArray = await this.session.readNamespaceArray();
    // Lanza NamespaceNotFoundError → Faulted (política de fallo dura).
    this.nsMap = resolveNamespaces(namespaceArray, this.mapping.raw as never);

    const resolved: ResolvedTarget[] = this.mapping.targets.map((t) => {
      const nsIndex = this.nsMap.get(t.node.nsUri);
      const nodeId = `ns=${nsIndex};${t.node.identifier}`;
      return { ...t, nodeId, resolved: false, faultReason: null };
    });

    // Verificación: leer NodeClass de cada buffer. Bad → buffer faulted (solo ese).
    const reads = resolved.map((t) => ({ nodeId: t.nodeId, attributeId: AttributeIds.NodeClass }));
    const results = await this.session.read(reads);
    results.forEach((dv: DataValue, i) => {
      const good = isGoodStatus(dv.statusCode);
      resolved[i].resolved = good;
      resolved[i].faultReason = good ? null : `NodeId no resoluble: ${dv.statusCode.toString()}`;
      if (!good) this.logger.warn(`buffer faulted ${resolved[i].plantId}/${resolved[i].browseName}: ${resolved[i].faultReason}`);
    });

    this.targets = resolved;
    const faulted = resolved.filter((t) => !t.resolved).length;
    this.logger.log(`NodeIds resueltos: ${resolved.length - faulted}/${resolved.length} (faulted: ${faulted})`);
  }

  // ── subscription + monitored items (1 por buffer) ──────────────────────────

  private async setupSubscription(): Promise<void> {
    if (!this.session) throw new Error('sin sesión');
    await this.teardownSubscription();

    this.subscription = await this.session.createSubscription2({
      requestedPublishingInterval: this.config.publishingIntervalMs,
      requestedLifetimeCount: this.config.subscriptionLifetimeCount,
      requestedMaxKeepAliveCount: this.config.subscriptionMaxKeepAliveCount,
      maxNotificationsPerPublish: 0,
      publishingEnabled: true,
      priority: 1,
    });

    this.subscription.on('keepalive', () => this.watchdog.kick());
    this.subscription.on('terminated', () => this.logger.warn('subscription terminada'));

    this.monitoredItems = [];
    for (const target of this.targets) {
      if (!target.resolved) continue; // los faulted no se suscriben; el bridge sigue
      // queueSize:1 + discardOldest:true — esto es MONITOREO, no historización: solo
      // importa el ÚLTIMO valor del array. Si un publish se atrasa, el servidor descarta
      // las muestras viejas y entrega la más reciente (dato fresco manda, regla 7). NO
      // subir queueSize en Fase 2 sin entender que el diff de elementos ya lo hace el parser.
      const item = await this.subscription.monitor(
        { nodeId: resolveNodeId(target.nodeId), attributeId: AttributeIds.Value },
        { samplingInterval: this.config.samplingIntervalMs, discardOldest: true, queueSize: 1 },
        TimestampsToReturn.Both,
      );
      item.on('changed', (dv: DataValue) => this.onBufferChanged(target, dv));
      this.monitoredItems.push(item);
    }

    this.logger.log(`Subscription lista: ${this.monitoredItems.length} MonitoredItems`);
  }

  private onBufferChanged(target: ResolvedTarget, dv: DataValue): void {
    const now = Date.now();
    const sample = this.toSample(target, dv);

    // Vitalidad del upstream: contadores y kick del watchdog van en la RECEPCIÓN de la
    // notificación, no en el flush del coalescer (kickear en el flush añadiría holgura).
    this.notificationsTotal++;
    this.lastNotificationAt = new Date(now).toISOString();
    if (sample.sourceTimestamp) {
      this.lastNotificationLatencyMs = Math.max(0, now - new Date(sample.sourceTimestamp).getTime());
    }
    this.watchdog.kick();
    if (this.bridge.is('Stale', 'Recovering')) this.bridge.transition('Connected', 'notificaciones reanudadas');

    // Coalescing por planta (A2): un RawPlantFrame por planta por ventana, no por buffer.
    this.coalescer.add(target.plantId, sample);

    // El watchdog de arriba vigila que ENTREN notificaciones; esto vigila que SALGAN frames.
    this.detectarAtascoAguasAbajo(now);
  }

  /**
   * Notificaciones entrando pero ningún frame saliendo: el dato llega y se pierde entre medias.
   *
   * Es el modo de fallo que costó 41 h de datos congelados el 2026-08-13 sin que nada lo notara,
   * porque TODOS los indicadores (contadores, `lastNotificationAt`, watchdog, buffers activos) se
   * miden aguas ARRIBA del coalescer. Con el enlace sano y la suscripción entregando, nadie
   * miraba el otro extremo de la tubería.
   *
   * Se evalúa en cada notificación en vez de con un temporizador propio: si no entra nada, ya se
   * ocupa el watchdog; este caso SOLO existe cuando sí entra.
   */
  private detectarAtascoAguasAbajo(now: number): void {
    if (!this.bridge.is('Connected')) return;
    const desde = this.lastFrameEmittedAtMs ?? this.connectedSinceMs;
    if (desde === null || now - desde <= this.config.watchdogTimeoutMs) return;

    const seg = Math.round((now - desde) / 1000);
    this.logger.error(
      `atasco aguas abajo: llegan notificaciones pero no sale ningún frame desde hace ${seg}s ` +
        '(coalescer o listeners). Reciclando la sesión.',
    );
    this.lastFrameEmittedAtMs = now; // evita reciclar en bucle mientras se recupera
    this.bridge.transition('Recovering', `sin frames emitidos en ${seg}s pese a recibir datos`);
    void this.recycleSession('atasco aguas abajo');
  }

  /** Callback del coalescer: un frame por planta con todos los buffers de la ventana. */
  private emitFrame(frame: RawPlantFrame): void {
    this.lastFrameEmittedAtMs = Date.now();
    this.lastFrameByPlant.set(frame.plantId, frame.receivedAt);
    for (const l of this.frameListeners) {
      try {
        l(frame);
      } catch (err) {
        this.logger.error(`listener de frame falló: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private toSample(target: ResolvedTarget, dv: DataValue): RawBufferSample {
    const raw = dv.value ? dv.value.value : null;
    const values = this.toValueArray(raw);
    const severity = (dv.statusCode.value >>> 30) & 0x3;
    const quality: OpcQuality = severity === 0 ? 'Good' : severity === 1 ? 'Uncertain' : 'Bad';
    return {
      browseName: target.browseName,
      channel: target.channel,
      values,
      quality,
      statusCode: dv.statusCode.name,
      sourceTimestamp: dv.sourceTimestamp ? dv.sourceTimestamp.toISOString() : null,
      serverTimestamp: dv.serverTimestamp ? dv.serverTimestamp.toISOString() : null,
    };
  }

  private toValueArray(raw: unknown): Array<number | boolean> {
    if (raw === null || raw === undefined) return [];
    // Un `null`/`undefined` POR ELEMENTO (canal con calidad mala representada como null en un
    // array mixto) NO puede volverse 0: `Number(null) === 0` sería una lectura falsa e
    // indistinguible de un cero real. Se mapea a NaN para que QualityService lo marque
    // INVALID_NUMBER (DAT-02) — "el tablero nunca miente".
    if (Array.isArray(raw)) return raw.map((v) => (typeof v === 'boolean' ? v : v == null ? NaN : Number(v)));
    if (ArrayBuffer.isView(raw)) return Array.from(raw as unknown as ArrayLike<number>);
    if (typeof raw === 'boolean') return [raw];
    return [Number(raw)];
  }

  // ── watchdog + heartbeat ───────────────────────────────────────────────────

  private async onWatchdogTimeout(): Promise<void> {
    if (this.recycling) return; // ya hay un reciclaje en curso (p.ej. disparado por heartbeat)
    if (this.bridge.is('Connected')) {
      this.bridge.transition('Stale', `watchdog: sin notificaciones en ${this.config.watchdogTimeoutMs}ms`);
    }
    this.recycleCount++;

    // Nivel 1: reciclar solo la subscription (barato). El guard evita que el heartbeat escale en paralelo.
    if (this.recycleCount <= this.config.subscriptionRecycleMaxAttempts) {
      this.recycling = true;
      try {
        this.logger.warn(`reciclando subscription (intento ${this.recycleCount})`);
        await this.setupSubscription();
        this.watchdog.start();
        return;
      } catch (err) {
        this.logger.warn(`reciclaje de subscription falló: ${err instanceof Error ? err.message : err}`);
      } finally {
        this.recycling = false;
      }
    }

    // Nivel 2: escalar a reciclaje de la sesión completa.
    this.logger.warn('reciclaje de subscription agotado; reciclando la sesión');
    await this.recycleSession('watchdog');
  }

  /**
   * Reciclaje de sesión completa: único punto que recrea la sesión. Serializado con el
   * flag `recycling` para que watchdog y heartbeat no lo disparen a la vez (dos
   * createSession concurrentes dejarían una sesión huérfana en el servidor).
   */
  private async recycleSession(trigger: string): Promise<void> {
    if (this.recycling) {
      this.logger.warn(`reciclaje ya en curso; se ignora disparo de ${trigger}`);
      return;
    }
    this.recycling = true;
    this.watchdog.stop();
    this.heartbeat.stop(); // sin probes contra una sesión que se está cerrando
    try {
      await this.teardownSession();
      if (!this.client) {
        // Guard explícito (reemplaza el non-null assertion): sin cliente no se recicla.
        // Nunca un TypeError enmascarado como Faulted sin sentido.
        this.bridge.transition('Faulted', 'sin cliente OPC UA para reciclar sesión');
        return;
      }
      this.session = await this.client.createSession(this.buildIdentity());
      await this.resolveTargets();
      await this.setupSubscription();
      this.recycleCount = 0;
      this.heartbeat.reset();
      this.watchdog.start();
      this.heartbeat.start();
      this.bridge.transition('Connected', `sesión reciclada (${trigger})`);
    } catch (err) {
      // Faulted es terminal hasta stop()/start(): watchdog y heartbeat quedan parados.
      this.bridge.transition('Faulted', `reciclaje de sesión falló (${trigger}): ${err instanceof Error ? err.message : err}`);
    } finally {
      this.recycling = false;
    }
  }

  /** Un probe de heartbeat: resuelve si el servidor responde Good; lanza en caso contrario. */
  private async heartbeatProbe(): Promise<void> {
    if (!this.session) throw new Error('sin sesión');
    const dv = await this.session.read({ nodeId: 'i=2258', attributeId: AttributeIds.Value }); // Server CurrentTime
    if (!isGoodStatus(dv.statusCode)) throw new Error(`status ${dv.statusCode.toString()}`);
  }

  private async onHeartbeatThreshold(reason: string): Promise<void> {
    // No resucitar un bridge terminal ni pisar un reciclaje/arranque en curso.
    if (this.recycling || this.bridge.is('Faulted', 'Disconnected', 'Connecting')) return;
    this.bridge.transition('Recovering', reason);
    await this.recycleSession('heartbeat');
  }

  private async teardownSubscription(): Promise<void> {
    for (const item of this.monitoredItems) item.removeAllListeners();
    this.monitoredItems = [];
    if (this.subscription) {
      await this.subscription.terminate().catch(() => undefined);
      this.subscription = null;
    }
  }
  private async teardownSession(): Promise<void> {
    await this.teardownSubscription();
    if (this.session) {
      await this.session.close().catch(() => undefined);
      this.session = null;
    }
  }

  // ── diagnósticos / info ────────────────────────────────────────────────────

  getDiagnostics(): AdapterDiagnostics {
    const buffersFaulted = this.targets.filter((t) => !t.resolved).length;
    const perPlant = this.mapping.plants.map((p) => {
      const bufs = this.targets.filter((t) => t.plantId === p.plantId);
      return {
        plantId: p.plantId,
        lastFrameAt: this.lastFrameByPlant.get(p.plantId) ?? null,
        buffersTotal: bufs.length,
        buffersFaulted: bufs.filter((t) => !t.resolved).length,
      };
    });
    const hb = this.heartbeat.getStats();
    return {
      provider: this.provider,
      bridgeStatus: this.bridge.get(),
      lastNotificationAt: this.lastNotificationAt,
      // El OTRO extremo de la tubería. Comparado con lastNotificationAt delata el atasco aguas
      // abajo de un vistazo: entran datos, no salen frames.
      lastFrameEmittedAt: this.lastFrameEmittedAtMs ? new Date(this.lastFrameEmittedAtMs).toISOString() : null,
      lastNotificationLatencyMs: this.lastNotificationLatencyMs,
      subscriptionCount: this.subscription ? 1 : 0,
      monitoredItemCount: this.monitoredItems.length,
      reconnectCount: this.reconnectCount,
      subscriptionRecycleCount: this.recycleCount,
      notificationsTotal: this.notificationsTotal,
      droppedNotificationsTotal: this.coalescer.getDroppedCount(),
      lastHeartbeatAt: hb.lastHeartbeatAt,
      lastSuccessfulHeartbeatAt: hb.lastSuccessfulHeartbeatAt,
      heartbeatFailures: hb.heartbeatFailures,
      heartbeatFailuresTotal: hb.heartbeatFailuresTotal,
      buffersActive: this.targets.filter((t) => t.resolved).length,
      buffersFaulted,
      perPlant,
      recentTransitions: this.bridge.recentTransitions(),
    };
  }

  async getServerInfo(): Promise<ServerInfo> {
    const base: ServerInfo = {
      provider: this.provider,
      endpoint: this.config.endpoint,
      activeSecurityMode: this.config.securityMode,
      activeSecurityPolicy: this.config.securityPolicy,
      identity: this.config.identity.type,
      productName: null,
      manufacturerName: null,
      softwareVersion: null,
      buildNumber: null,
      serverState: null,
      serverCurrentTime: null,
      namespaces: [...this.nsMap.keys()],
      sessionId: this.session ? this.session.sessionId.toString() : null,
      subscription: {
        publishingIntervalMs: this.subscription ? this.config.publishingIntervalMs : null,
        samplingIntervalMs: this.subscription ? this.config.samplingIntervalMs : null,
      },
    };
    if (!this.session) return base;

    try {
      const nodes = {
        productName: 'i=2261',
        manufacturerName: 'i=2262',
        softwareVersion: 'i=2264',
        buildNumber: 'i=2265',
        state: 'i=2259',
        currentTime: 'i=2258',
      };
      const dvs = await this.session.read(
        Object.values(nodes).map((nodeId) => ({ nodeId, attributeId: AttributeIds.Value })),
      );
      const val = (i: number): unknown => (dvs[i]?.value ? dvs[i].value.value : null);
      base.productName = typeof val(0) === 'string' ? (val(0) as string) : null;
      base.manufacturerName = typeof val(1) === 'string' ? (val(1) as string) : null;
      base.softwareVersion = typeof val(2) === 'string' ? (val(2) as string) : null;
      base.buildNumber = val(3) != null ? String(val(3)) : null;
      base.serverState = serverStateName(val(4));
      base.serverCurrentTime = val(5) instanceof Date ? (val(5) as Date).toISOString() : null;
    } catch (err) {
      this.logger.warn(`getServerInfo parcial: ${err instanceof Error ? err.message : err}`);
    }
    return base;
  }

  getBufferHealth(): BufferHealth[] {
    return this.targets.map((t) => ({
      plantId: t.plantId,
      browseName: t.browseName,
      channel: t.channel,
      resolved: t.resolved,
      faulted: !t.resolved,
      reason: t.faultReason,
    }));
  }

  // ── Fase 5: canal de escritura ──────────────────────────────────────────────
  // NOTA: la seguridad (precondición dura) y los interlocks los aplica el WriteService
  // ANTES de llamar aquí. Estos métodos solo hacen el I/O OPC UA sobre un elemento.

  getWriteSecurity(): WriteSecurity {
    // ⚠️ `allowInsecureWrites` es una excepción DELIBERADA y TEMPORAL a la regla 9 ("sin excepciones,
    // ni para probar"), habilitada solo por OPCUA_ALLOW_INSECURE_WRITES=true — ver su doc en
    // connectivity.config.ts. Debe estar en false salvo durante una prueba de campo auditada.
    const secure = Boolean(
      (this.config.securityMode === 'SignAndEncrypt' && this.config.identity.type !== 'anonymous') ||
        this.config.allowInsecureWrites,
    );
    return { secure, securityMode: this.config.securityMode, identity: this.config.identity.type };
  }

  async writeBufferElement(target: BufferElementTarget, value: number | boolean): Promise<void> {
    const resolved = this.findResolvedElement(target);
    await escribirElemento(this.session!, resolved.nodeId, target, value);
  }

  async readBufferElement(target: BufferElementTarget): Promise<BufferElementRead> {
    const resolved = this.findResolvedElement(target);
    return leerElemento(this.session!, resolved.nodeId, target);
  }

  private findResolvedElement(target: BufferElementTarget): ResolvedTarget {
    if (!this.session) throw new Error('sin sesión OPC UA activa');
    const t = this.targets.find(
      (x) => x.plantId === target.plantId && x.channel === target.channel && x.browseName === target.sourceBuffer,
    );
    if (!t) throw new Error(`buffer no encontrado para escribir/leer: ${target.plantId}/${target.channel}/${target.sourceBuffer}`);
    if (!t.resolved) throw new Error(`buffer no resuelto (faulted): ${target.sourceBuffer}`);
    return t;
  }
}
