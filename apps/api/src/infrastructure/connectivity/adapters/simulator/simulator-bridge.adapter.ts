import { Logger } from '@nestjs/common';
import { BridgeStateMachine } from '../../bridge/bridge-state-machine';
import { FrameCoalescer } from '../../bridge/frame-coalescer';
import { HeartbeatMonitor } from '../../bridge/heartbeat-monitor';
import { Watchdog } from '../../bridge/watchdog';
import type { OpcUaConfig } from '../../connectivity.config';
import type { LoadedMapping, MonitorTarget } from '../../mapping/opc-mapping.loader';
import type {
  AdapterDiagnostics,
  BridgeStatus,
  BufferElementRead,
  BufferElementTarget,
  BufferHealth,
  ConnectivityAdapter,
  RawBufferSample,
  RawPlantFrame,
  ServerInfo,
  WriteSecurity,
} from '../../ports/connectivity-adapter.port';
import type { SimLatchMode, SimulatorOptions } from './sim-scenario';
import { SimulatedPlc, type SimulationReport, type SimValveView, type SimViolation, type SimWrite } from './simulated-plc';

type Outcome = 'success' | 'fail';

/**
 * Adaptador de puente SIMULADO. Implementa ConnectivityAdapter emitiendo frames
 * crudos con la MISMA topología del mapping. Puede emular TODOS los estados
 * del bridge (Connected/Stale/Recovering/Faulted) para probar el pipeline sin PLC
 * (regla 5), incluidos el reciclaje automático del watchdog y el heartbeat.
 *
 * Los valores salen de un PLC simulado (`SimulatedPlc`): los buffers de SALIDA llevan lo que se
 * escribió (nunca ruido) y, con un escenario (`options`), las válvulas del mapping se mueven y
 * escriben su realimentación en los buffers de ENTRADA, de modo que la app ve el estado cambiar por
 * el flujo normal de frames. Ver docs/PRUEBAS_LOCALES_VALVULAS.md.
 *
 * Sin `options` (los tests anteriores a este modelo) se comporta como antes: sin válvulas, sin ciclo
 * MSG, sin latencia y sin validar el destino de las escrituras.
 *
 * Métodos de emulación para tests (no pertenecen al puerto): freeze(), faultBuffer(),
 * setRecycleOutcome(), setHeartbeatOutcome(), y los de diagnóstico del modelo (getSimulationReport…).
 */
export class SimulatorBridgeAdapter implements ConnectivityAdapter {
  readonly provider = 'simulator' as const;

  private readonly logger = new Logger('SimulatorBridge');
  private readonly bridge = new BridgeStateMachine(this.logger, 'simulator');
  private readonly watchdog: Watchdog;
  private readonly heartbeat: HeartbeatMonitor;
  private readonly coalescer: FrameCoalescer;
  private readonly frameListeners = new Set<(f: RawPlantFrame) => void>();
  private readonly targets: MonitorTarget[];
  private readonly faultedBuffers = new Set<string>(); // key: plantId/browseName

  private emitTimer: NodeJS.Timeout | null = null;
  private frozen = false;
  private started = false;
  private recycleCount = 0;
  private reconnectCount = 0;
  private notificationsTotal = 0;
  private lastNotificationAt: string | null = null;
  private readonly lastFrameByPlant = new Map<string, string>();

  // Perillas de emulación: el resultado que darán los reciclajes y los probes de heartbeat.
  private recycleOutcome: Outcome = 'success';
  private heartbeatOutcome: Outcome = 'success';

  // Fase 5: memoria del maestro (buffers OUT/IN) y, con escenario, las válvulas simuladas.
  private readonly plc: SimulatedPlc;
  /** Con escenario: destino validado como el adaptador real, latencia de I/O y válvulas. */
  private readonly modelo: boolean;
  private writeConfirms = true;

  constructor(
    private readonly config: OpcUaConfig,
    private readonly mapping: LoadedMapping,
    private readonly options?: SimulatorOptions,
  ) {
    this.modelo = options !== undefined;
    this.plc = new SimulatedPlc(mapping, options ?? null, Date.now());
    this.targets = mapping.targets;
    this.watchdog = new Watchdog(config.watchdogTimeoutMs, () => this.onWatchdogTimeout());
    this.coalescer = new FrameCoalescer(config.coalesceWindowMs, (f) => this.emitFrame(f));
    this.heartbeat = new HeartbeatMonitor({
      intervalMs: config.heartbeatIntervalMs,
      maxFailures: config.heartbeatMaxFailures,
      probe: () => this.heartbeatProbe(),
      onFailureThreshold: (reason) => this.onHeartbeatThreshold(reason),
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bridge.transition('Connecting', 'inicio del simulador');
    this.bridge.transition('Connected', 'simulador listo');
    // El coalescer se REUTILIZA entre ciclos y `stop()` lo deja mudo (ver FrameCoalescer).
    this.coalescer.start();
    this.watchdog.start();
    this.heartbeat.start();
    this.startEmitTimer();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stopEmitTimer();
    this.watchdog.stop();
    this.heartbeat.stop();
    this.coalescer.stop(); // flushea pendientes con el bridge aún "vivo" (regla 12)
    this.bridge.transition('Disconnected', 'stop() del simulador');
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

  // ── emulación (solo tests) ─────────────────────────────────────────────────────

  /** Congela la emisión: emula una Subscription muerta (sin notificaciones → watchdog). */
  freeze(): void {
    this.frozen = true;
    this.logger.warn('[sim] emisión CONGELADA');
  }

  /** Marca un buffer como faulted (para probar la degradación por buffer). */
  faultBuffer(plantId: string, browseName: string): void {
    this.faultedBuffers.add(`${plantId}/${browseName}`);
  }

  /** Define si los reciclajes (subscription/sesión) tendrán éxito o fallarán. */
  setRecycleOutcome(outcome: Outcome): void {
    this.recycleOutcome = outcome;
  }

  /** Define si el probe de heartbeat resolverá (success) o lanzará (fail). */
  setHeartbeatOutcome(outcome: Outcome): void {
    this.heartbeatOutcome = outcome;
  }

  /** Fase 5 (solo tests): si false, el read-back devuelve un valor que NO coincide (prueba de 'fallido'). */
  setWriteConfirms(confirms: boolean): void {
    this.writeConfirms = confirms;
  }

  // ── Fase 5: canal de escritura (emulado) ────────────────────────────────────────

  getWriteSecurity(): WriteSecurity {
    // El simulador no cifra nada, pero refleja la config para poder probar la precondición dura:
    // secure ⇔ SignAndEncrypt + identidad no anónima (mismos campos que el adaptador OPC UA real).
    // Incluye la misma excepción DELIBERADA/TEMPORAL `allowInsecureWrites` (ver connectivity.config.ts)
    // para que el simulador se comporte igual al adaptador real bajo ese flag.
    const secure = Boolean(
      (this.config.securityMode === 'SignAndEncrypt' && this.config.identity.type !== 'anonymous') ||
        this.config.allowInsecureWrites,
    );
    return { secure, securityMode: this.config.securityMode, identity: this.config.identity.type };
  }

  async writeBufferElement(target: BufferElementTarget, value: number | boolean): Promise<void> {
    const buffer = this.validarDestino(target);
    if (buffer && buffer.arrayLength !== null && target.index >= buffer.arrayLength) {
      // Lo que devuelve un servidor OPC UA ante un IndexRange fuera del array.
      throw new Error(`write OPC UA rechazado (BadIndexRangeNoData) en ${target.sourceBuffer}[${target.index}]`);
    }
    // La escritura viaja, surte efecto en el servidor a mitad del camino y la respuesta vuelve.
    await this.latencia('ida');
    this.plc.escribir(target, value, Date.now());
    await this.latencia('vuelta');
  }

  async readBufferElement(target: BufferElementTarget): Promise<BufferElementRead> {
    const buffer = this.validarDestino(target);
    await this.latencia('ida');
    const ahora = Date.now();
    if (buffer && buffer.arrayLength !== null && target.index >= buffer.arrayLength) {
      // Igual que el adaptador real: el servidor responde Bad sin valor.
      await this.latencia('vuelta');
      return { value: null, quality: 'Bad', sourceTimestamp: new Date(ahora).toISOString() };
    }
    const actual = this.plc.leer(target, ahora);
    // Perilla de test heredada: un elemento ESCRITO devuelve otro valor, para provocar un 'fallido'.
    const value =
      this.writeConfirms || !this.plc.fueEscritoPorBackend(target)
        ? actual
        : typeof actual === 'boolean'
          ? !actual
          : Number(actual) + 1;
    await this.latencia('vuelta');
    return { value, quality: 'Good', sourceTimestamp: new Date(ahora).toISOString() };
  }

  /**
   * Con escenario, el destino se valida como lo hace el adaptador OPC UA real (`findResolvedElement`):
   * sin sesión, buffer inexistente, canal que no casa o buffer faulted → error. Un mapping de prueba
   * con un `sourceBuffer` mal escrito tiene que fallar AQUÍ igual que fallaría en el PLC, no "funcionar"
   * en local. Sin escenario (tests anteriores), no se valida nada, como antes.
   */
  private validarDestino(target: BufferElementTarget): MonitorTarget | null {
    if (!this.modelo) return null;
    if (this.bridge.is('Disconnected', 'Faulted', 'Connecting')) throw new Error('sin sesión OPC UA activa');
    const t = this.targets.find(
      (x) => x.plantId === target.plantId && x.channel === target.channel && x.browseName === target.sourceBuffer,
    );
    if (!t) throw new Error(`buffer no encontrado para escribir/leer: ${target.plantId}/${target.channel}/${target.sourceBuffer}`);
    if (this.faultedBuffers.has(`${t.plantId}/${t.browseName}`)) throw new Error(`buffer no resuelto (faulted): ${target.sourceBuffer}`);
    return t;
  }

  /** Media ida y vuelta de una petición OPC UA (`ioLatencyMs`). Sin escenario, nada. */
  private async latencia(tramo: 'ida' | 'vuelta'): Promise<void> {
    const total = this.options?.ioLatencyMs ?? 0;
    if (total <= 0) return;
    const ida = Math.floor(total / 2);
    const ms = tramo === 'ida' ? ida : total - ida;
    if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  // ── Modelo de válvulas: diagnóstico y perillas (endpoints /api/opc/sim, tests) ──────

  /** Escenario, plantas (ciclos MSG), válvulas con su estado y contadores. */
  getSimulationReport(): SimulationReport {
    return this.plc.informe(Date.now());
  }

  getSimulatedValve(plantId: string, valveKey: string): SimValveView | null {
    return this.plc.valvula(plantId, valveKey, Date.now());
  }

  /** Historial de escrituras del backend sobre el maestro (lo que salió por el cable). */
  getWriteHistory(): SimWrite[] {
    return this.plc.escrituras();
  }

  /** Escrituras que dejaron ABRIR y CERRAR de una misma válvula a 1 a la vez. Debe estar vacío. */
  getViolations(): SimViolation[] {
    return this.plc.violacionesRegistradas();
  }

  forceValveError(plantId: string, valveKey: string, reason = 'forzado desde el diagnóstico del simulador'): SimValveView | null {
    return this.plc.forzarError(plantId, valveKey, reason, Date.now());
  }

  resetValve(plantId: string, valveKey: string): SimValveView | null {
    return this.plc.rearmar(plantId, valveKey, Date.now());
  }

  setValveLatchMode(plantId: string, valveKey: string, mode: SimLatchMode): SimValveView | null {
    return this.plc.cambiarModo(plantId, valveKey, mode, Date.now());
  }

  // ── emisión interna ─────────────────────────────────────────────────────────────

  private startEmitTimer(): void {
    this.stopEmitTimer();
    this.emitTimer = setInterval(() => this.tick(), this.config.publishingIntervalMs);
    if (typeof this.emitTimer.unref === 'function') this.emitTimer.unref();
  }

  private stopEmitTimer(): void {
    if (this.emitTimer) clearInterval(this.emitTimer);
    this.emitTimer = null;
  }

  private tick(): void {
    if (this.frozen) return; // sin notificaciones → el watchdog terminará disparando

    for (const target of this.targets) {
      if (this.faultedBuffers.has(`${target.plantId}/${target.browseName}`)) continue;
      this.notificationsTotal++;
      this.lastNotificationAt = new Date().toISOString();
      this.coalescer.add(target.plantId, this.fakeBuffer(target)); // coalescing por planta (A2)
    }

    this.watchdog.kick();
    if (this.bridge.is('Stale', 'Recovering')) {
      this.recycleCount = 0;
      this.bridge.transition('Connected', 'frames reanudados');
    }
  }

  /** Callback del coalescer: un frame por planta con todos los buffers de la ventana. */
  private emitFrame(frame: RawPlantFrame): void {
    this.lastFrameByPlant.set(frame.plantId, frame.receivedAt);
    for (const l of this.frameListeners) {
      try {
        l(frame);
      } catch (err) {
        this.logger.error(`listener de frame falló: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Muestra de un buffer. Las SALIDAS llevan lo escrito (o su valor inicial), nunca ruido: antes este
   * método inventaba un seno para todos los buffers y lo escrito no aparecía jamás en un frame. Las
   * entradas sin dueño siguen siendo sintéticas (mantienen la planta `live`); las que escribe una
   * válvula simulada llevan su realimentación.
   */
  private fakeBuffer(target: MonitorTarget): RawBufferSample {
    const ahora = Date.now();
    const values = this.plc.valoresDelBuffer(target, ahora);
    return {
      browseName: target.browseName,
      channel: target.channel,
      values,
      quality: 'Good',
      statusCode: 'Good',
      sourceTimestamp: new Date(ahora).toISOString(),
      serverTimestamp: new Date(ahora).toISOString(),
    };
  }

  // ── watchdog: reciclaje EMULADO de verdad ───────────────────────────────────────

  private onWatchdogTimeout(): void {
    if (this.bridge.is('Connected')) {
      this.bridge.transition('Stale', `watchdog: sin notificaciones en ${this.config.watchdogTimeoutMs}ms`);
    }
    this.recycleCount++;

    if (this.recycleCount <= this.config.subscriptionRecycleMaxAttempts) {
      if (this.recycleOutcome === 'success') {
        this.recycleSubscriptionEmulated();
        return;
      }
      this.logger.warn(`[sim] reciclaje de subscription falló (emulado, intento ${this.recycleCount})`);
      this.watchdog.kick(); // re-arma para reintentar al próximo timeout
      return;
    }

    // Escalar: reciclar la sesión completa (emulada).
    if (this.recycleOutcome === 'success') {
      this.recycleSessionEmulated('watchdog');
    } else {
      this.heartbeat.stop();
      this.stopEmitTimer();
      this.bridge.transition(
        'Faulted',
        `reciclaje de sesión falló (emulado) tras ${this.recycleCount - 1} intentos de subscription`,
      );
    }
  }

  /** Recrea la emisión interna: el equivalente simulado de recrear la Subscription. */
  private recycleSubscriptionEmulated(): void {
    this.frozen = false;
    this.startEmitTimer();
    this.recycleCount = 0;
    this.watchdog.start();
    this.bridge.transition('Connected', 'subscription reciclada (emulada)');
  }

  /** Recrea la sesión completa (emulada). */
  private recycleSessionEmulated(trigger: string): void {
    this.reconnectCount++;
    this.frozen = false;
    this.startEmitTimer();
    this.recycleCount = 0;
    this.watchdog.start();
    this.heartbeat.reset();
    this.bridge.transition('Connected', `sesión reciclada (emulada, ${trigger})`);
  }

  // ── heartbeat emulado ───────────────────────────────────────────────────────────

  private async heartbeatProbe(): Promise<void> {
    if (this.heartbeatOutcome === 'fail') throw new Error('heartbeat emulado en fallo');
  }

  private onHeartbeatThreshold(reason: string): void {
    // No resucitar un bridge terminal ni pisar un arranque en curso (la state machine
    // ejecuta transiciones no estándar, solo advierte: hay que guardarlas aquí).
    if (this.bridge.is('Faulted', 'Disconnected', 'Connecting')) return;
    this.bridge.transition('Recovering', reason);
    if (this.recycleOutcome === 'success') {
      this.recycleSessionEmulated('heartbeat');
    } else {
      this.heartbeat.stop();
      this.stopEmitTimer();
      this.bridge.transition('Faulted', 'reciclaje de sesión falló (emulado) tras heartbeat');
    }
  }

  // ── diagnósticos / info ─────────────────────────────────────────────────────────

  getDiagnostics(): AdapterDiagnostics {
    const perPlant = this.mapping.plants.map((p) => {
      const bufs = this.targets.filter((t) => t.plantId === p.plantId);
      const faulted = bufs.filter((t) => this.faultedBuffers.has(`${t.plantId}/${t.browseName}`)).length;
      return {
        plantId: p.plantId,
        lastFrameAt: this.lastFrameByPlant.get(p.plantId) ?? null,
        buffersTotal: bufs.length,
        buffersFaulted: faulted,
      };
    });
    const hb = this.heartbeat.getStats();
    return {
      provider: this.provider,
      bridgeStatus: this.bridge.get(),
      lastNotificationAt: this.lastNotificationAt,
      lastNotificationLatencyMs: null,
      subscriptionCount: this.bridge.is('Connected') ? 1 : 0,
      monitoredItemCount: this.targets.length - this.faultedBuffers.size,
      reconnectCount: this.reconnectCount,
      subscriptionRecycleCount: this.recycleCount,
      notificationsTotal: this.notificationsTotal,
      droppedNotificationsTotal: this.coalescer.getDroppedCount(),
      lastHeartbeatAt: hb.lastHeartbeatAt,
      lastSuccessfulHeartbeatAt: hb.lastSuccessfulHeartbeatAt,
      heartbeatFailures: hb.heartbeatFailures,
      heartbeatFailuresTotal: hb.heartbeatFailuresTotal,
      buffersActive: this.targets.length - this.faultedBuffers.size,
      buffersFaulted: this.faultedBuffers.size,
      perPlant,
      recentTransitions: this.bridge.recentTransitions(),
    };
  }

  async getServerInfo(): Promise<ServerInfo> {
    return {
      provider: this.provider,
      endpoint: 'simulator://in-memory',
      activeSecurityMode: 'None',
      activeSecurityPolicy: 'None',
      identity: 'Simulated',
      productName: 'PTAP Simulator Bridge',
      manufacturerName: 'monitor-ptap',
      softwareVersion: '1.0.0',
      buildNumber: null,
      serverState: this.bridge.is('Connected') ? 'Running' : this.bridge.get(),
      serverCurrentTime: new Date().toISOString(),
      namespaces: ['simulator'],
      sessionId: 'sim-session',
      subscription: {
        publishingIntervalMs: this.config.publishingIntervalMs,
        samplingIntervalMs: this.config.samplingIntervalMs,
      },
    };
  }

  getBufferHealth(): BufferHealth[] {
    return this.targets.map((t) => {
      const faulted = this.faultedBuffers.has(`${t.plantId}/${t.browseName}`);
      return {
        plantId: t.plantId,
        browseName: t.browseName,
        channel: t.channel,
        resolved: true,
        faulted,
        reason: faulted ? 'faulted por emulación' : null,
      };
    });
  }
}
