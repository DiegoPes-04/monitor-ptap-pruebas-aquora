import { Inject, Injectable, Logger } from '@nestjs/common';
import { hasPermission, type Permission, type Role } from '@ptap/shared';
import { AuditLogService } from '../../infrastructure/audit/audit-log.service';
import { CONNECTIVITY_ADAPTER, CONNECTIVITY_CONFIG } from '../../infrastructure/connectivity/connectivity.tokens';
import type { ConnectivityConfig } from '../../infrastructure/connectivity/connectivity.config';
import { motivoSecuenciaInvalida, type WriteSpec, type WriteStep } from '../../infrastructure/connectivity/mapping/opc-mapping.loader';
import { PlantCache } from '../../infrastructure/connectivity/pipeline/plant-cache';
import type { BufferElementTarget, ConnectivityAdapter } from '../../infrastructure/connectivity/ports/connectivity-adapter.port';
import { NotificationRepository } from '../notifications/notification.repository';
import { diaLocal } from '../../infrastructure/connectivity/pipeline/dia-operativo';
import { CommandLogRepository, type CommandValue, type StoredCommand } from './command-log.repository';
import { CommandMappingResolver } from './command-mapping.resolver';
import { CommandSignatureService } from './command-signature.service';
import { avisoDeManiobra } from './valve-notice';
import {
  FAIL,
  REJECT,
  SENT,
  httpStatusForCommand,
  type CommandActor,
  type CommandOutcome,
  type CommandRequest,
  type CommandResult,
} from './command.dto';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ventana de read-back cuando el canal de estado NO está verificado (`stateVerified: false`).
 * Suficiente para captar un cambio inmediato si lo hubiera, sin bloquear al operador esperando un
 * valor que de antemano sabemos que no es fiable.
 */
const UNVERIFIED_READBACK_MS = 600;

/**
 * Cada cuánto se consulta la realimentación durante un sostenido (`pulse.until`).
 *
 * 500 ms: lo bastante fino para no alargar la maniobra de forma perceptible y lo bastante grueso
 * para no castigar al servidor OPC UA con 45 s de lecturas seguidas.
 */
const HOLD_POLL_MS = 500;

/**
 * Bits de los OTROS verbos de la misma válvula, sin los del verbo que se activa: lo que la exclusión
 * abrir/cerrar tiene que apagar (ver `applyValue`). Sale del mapping, no de una lista en el código
 * (regla 2): en Carbonero son 1/2 y en La Vorágine 4096/8192. Los booleanos no tienen bits.
 */
function bitsDeLosOtrosVerbos(commands: Record<string, number | boolean>, value: number): number {
  let mascara = 0;
  for (const v of Object.values(commands)) if (typeof v === 'number' && v !== value) mascara |= v;
  return mascara & ~value & 0xffff;
}

/**
 * WriteService (Fase 5): único punto que ejecuta comandos de escritura al PLC.
 *
 * PRECONDICIÓN DURA (regla 9): rechaza TODO si OPCUA_WRITES_ENABLED=false o si la sesión
 * no es autenticada+cifrada — sin excepciones, ni "para probar". Flujo por comando:
 * resolver target → verbo válido → precondición segura → RBAC (permiso del mapping) →
 * interlock (bridge Connected + snapshot fresco) → idempotencia (insert-pending-first) →
 * write → read-back con timeout → confirmado|fallido (+ rollback best-effort) → audit SIEMPRE.
 */
@Injectable()
export class WriteService {
  private readonly logger = new Logger('WriteService');

  constructor(
    @Inject(CONNECTIVITY_ADAPTER) private readonly adapter: ConnectivityAdapter,
    @Inject(CONNECTIVITY_CONFIG) private readonly config: ConnectivityConfig,
    @Inject(PlantCache) private readonly cache: PlantCache,
    @Inject(CommandMappingResolver) private readonly resolver: CommandMappingResolver,
    @Inject(CommandLogRepository) private readonly repo: CommandLogRepository,
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
    @Inject(CommandSignatureService) private readonly firmas: CommandSignatureService,
    @Inject(NotificationRepository) private readonly avisos: NotificationRepository,
  ) {}

  /**
   * Válvulas con una orden EN CURSO (`plantId/target`).
   *
   * Mientras el pulso duró 300 ms esto no hacía falta. Con una señal sostenida hasta la
   * realimentación la ventana pasa a ser de decenas de segundos, y en ese hueco caben dos órdenes
   * opuestas: `bitmask` haría `actual | 8192` sobre una palabra que todavía tiene el `4096` puesto y
   * dejaría **las dos direcciones energizadas a la vez**, que es el fallo que el protocolo declara
   * ERROR. La guarda de secuencias solo cubre el interior de UNA orden; esto cubre el solape entre
   * dos.
   *
   * No sustituye a la idempotencia de `command-log.repository`, que protege del reenvío de la MISMA
   * orden — y que además hoy no se dispara desde el móvil, porque el front no manda `idempotencyKey`.
   */
  private readonly enCurso = new Set<string>();

  /**
   * Reserva TODAS las claves o ninguna. Lo usa el probador de canales para bloquear, mientras dura
   * una prueba, las válvulas que mandan por ese mismo elemento del buffer — y al revés: una orden en
   * curso impide sondear su canal.
   *
   * Comparten este mismo conjunto a propósito. Dos cerrojos separados no se ven entre sí, y el hueco
   * entre ellos es justo donde cabe el fallo que hay que evitar: una orden en máscara solapada con
   * una escritura absoluta deja la palabra con las DOS direcciones energizadas, que es el estado que
   * el protocolo de estas plantas declara ERROR.
   *
   * Todo o nada: reservar la mitad de las claves y devolver false dejaría media planta bloqueada sin
   * que nadie la libere.
   */
  reservar(claves: string[]): boolean {
    if (claves.some((c) => this.enCurso.has(c))) return false;
    for (const c of claves) this.enCurso.add(c);
    return true;
  }

  /** Libera lo reservado. Se llama SIEMPRE desde un `finally`. */
  liberar(claves: string[]): void {
    for (const c of claves) this.enCurso.delete(c);
  }

  /**
   * Turnos por ELEMENTO del buffer (`plantId/canal/buffer[índice]`): la cola de quien está haciendo un
   * read-modify-write sobre esa palabra.
   *
   * `enCurso` reserva la VÁLVULA, no la palabra, así que dos válvulas de la misma palabra (Carbonero
   * con 2 o 3 válvulas en INT_OUT[0]) corren a la vez — y debe ser así: la orden de B no puede esperar
   * los 45 s del sostenido de A. Pero la activación (leer → `applyValue` → escribir) y la limpieza del
   * pulso (leer → quitar el bit → escribir) son DOS idas al PLC, y entre ellas cabe la escritura de la
   * otra válvula. Demostrado contra el simulador con 100 ms por petición
   * (test/sim-valvulas-e2e.test.ts): A lee, B escribe, A escribe lo que leyó → el bit de B se BORRA y
   * su orden se pierde; o B lee, A limpia, B escribe lo que leyó → el bit de A RESUCITA y se queda
   * puesto para siempre, que es la bobina energizada sin que nadie lo sepa.
   *
   * El turno cubre solo esas secciones (milisegundos, nunca el sostenido): la orden de B espera a lo
   * sumo una ida y vuelta de la de A. Se suelta SIEMPRE desde un `finally`.
   */
  private readonly turnos = new Map<string, Promise<void>>();

  private async turnoDe(el: BufferElementTarget): Promise<() => void> {
    const clave = `${el.plantId}/${el.channel}/${el.sourceBuffer}[${el.index}]`;
    const anterior = this.turnos.get(clave) ?? Promise.resolve();
    let soltar: () => void = () => undefined;
    const propio = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    const cola = anterior.then(() => propio);
    this.turnos.set(clave, cola);
    await anterior;
    return () => {
      soltar();
      if (this.turnos.get(clave) === cola) this.turnos.delete(clave);
    };
  }

  async execute(plantId: string, req: CommandRequest, actor: CommandActor): Promise<CommandResult> {
    const cerrojo = `${plantId}/${req.target}`;
    if (this.enCurso.has(cerrojo)) {
      const motivo = `${REJECT.INTERLOCK_FAILED}: ya hay un comando en curso sobre esta válvula`;
      this.logger.warn(`comando ${req.command}/${req.target} de ${plantId} rechazado: ${motivo}`);
      return this.audit(actor, req, {
        plantId, target: req.target, command: req.command,
        previousValue: null, writtenValue: null, confirmedValue: null,
        writeEcho: null, writeVerified: null, interlockSequence: null,
        idempotent: false, at: new Date().toISOString(),
        status: 'rejected', reason: motivo,
      });
    }
    this.enCurso.add(cerrojo);
    try {
      return await this.ejecutar(plantId, req, actor);
    } finally {
      // En `finally` a propósito: si `ejecutar` revienta, dejar la clave puesta bloquearía esa
      // válvula para siempre hasta reiniciar el proceso.
      this.enCurso.delete(cerrojo);
    }
  }

  private async ejecutar(plantId: string, req: CommandRequest, actor: CommandActor): Promise<CommandResult> {
    const base = {
      plantId,
      target: req.target,
      command: req.command,
      previousValue: null as CommandValue,
      writtenValue: null as CommandValue,
      confirmedValue: null as CommandValue,
      writeEcho: null as CommandValue,
      writeVerified: null as boolean | null,
      interlockSequence: null as number | null,
      idempotent: false,
      at: new Date().toISOString(),
    };
    const reject = (reason: string): CommandResult => ({ ...base, status: 'rejected', reason });

    // 1) Resolver el target a una señal writable + write spec (regla 2).
    const resolved = this.resolver.resolve(plantId, req.target);
    if (!resolved) return this.audit(actor, req, await this.finalizeNoReserve(reject(REJECT.TARGET_NOT_WRITABLE)));
    const write = resolved.write;

    // 2) El verbo debe existir en el mapping.
    if (!(req.command in write.commands)) {
      return this.audit(actor, req, await this.finalizeNoReserve(reject(REJECT.UNKNOWN_COMMAND)));
    }

    // 2-bis) GUARDA ELÉCTRICA de la orden compuesta, antes de reservar y de tocar nada. El loader ya
    // la aplicó al arrancar; se repite aquí porque es barata y lo que hay al otro lado del cable es
    // una válvula: energizar dos direcciones opuestas a la vez es el fallo que el protocolo prohíbe.
    const secuencia = write.sequences?.[req.command] ?? null;
    if (secuencia) {
      const motivo = motivoSecuenciaInvalida(req.command, secuencia, write);
      if (motivo) {
        this.logger.error(`secuencia inválida en ${plantId}/${req.target}: ${motivo}`);
        return this.audit(actor, req, await this.finalizeNoReserve({ ...reject(REJECT.INTERLOCK_FAILED), reason: `${REJECT.INTERLOCK_FAILED}: ${motivo}` }));
      }
    }

    // 3) PRECONDICIÓN DURA: writes habilitados Y sesión segura (autenticada+cifrada).
    const security = this.adapter.getWriteSecurity();
    if (!this.config.opcua.writesEnabled || !security.secure) {
      return this.audit(actor, req, await this.finalizeNoReserve(reject(REJECT.WRITES_DISABLED_INSECURE_SESSION)));
    }

    // 4) RBAC dinámico: el permiso lo declara el mapping (jefe NO tiene control_valves).
    if (!actor.role || !hasPermission(actor.role as Role, write.permission as Permission)) {
      return this.audit(actor, req, await this.finalizeNoReserve(reject(REJECT.FORBIDDEN)));
    }

    // 5) Interlock: no accionar sobre un sitio desconectado o con datos congelados.
    const il = this.interlock(plantId);
    base.interlockSequence = il.sequence;
    if (!il.ok) {
      return this.audit(actor, req, await this.finalizeNoReserve({ ...reject(REJECT.INTERLOCK_FAILED), reason: `${REJECT.INTERLOCK_FAILED}: ${il.reason}` }));
    }

    // 6) Idempotencia (insert-pending-first): reserva ANTES de escribir (evita doble accionamiento).
    const reservation = await this.repo.reserve({
      idempotencyKey: req.idempotencyKey ?? null,
      plantId,
      target: req.target,
      command: req.command,
      userId: actor.userId,
      userEmail: actor.userEmail,
      role: actor.role,
      ip: actor.ip,
    });
    if (!reservation.reserved) {
      return this.audit(actor, req, this.replay(base, reservation.existing));
    }

    // 7) Ejecutar: leer valor previo → escribir → read-back con timeout.
    const writtenValue = write.commands[req.command];
    const el = (index: number): BufferElementTarget => ({
      plantId,
      channel: write.target.channel,
      sourceBuffer: write.target.sourceBuffer,
      index,
    });
    const targetEl = el(write.target.index);
    // Una orden simple es el caso particular de un solo paso sobre el canal primario.
    const pasos: WriteStep[] = secuencia ?? [{ index: write.target.index, value: writtenValue }];
    /** Lo que REALMENTE quedó escrito, en orden: es la base del eco, del cierre de pulso y del rollback. */
    const escritos: WriteStep[] = [];

    let result: CommandResult;
    try {
      // 7a + 7b EN TURNO sobre la palabra de mando (ver `turnoDe`): leer, escribir y releer el eco sin
      // que la orden de otra válvula de la MISMA palabra se cuele entre medias. Sin el turno, el eco
      // además podía leer la escritura de la otra válvula y dar por no verificada una orden que sí salió.
      const soltarTurno = await this.turnoDe(targetEl);
      let rechazo: { err: unknown } | null = null;
      try {
        // 7a) La ESCRITURA, aislada: si falla aquí, el motivo es WRITE_REJECTED (no se escribió),
        // nunca READBACK_UNCONFIRMED (que significa "se escribió y el equipo no respondió").
        try {
          const prev = await this.adapter.readBufferElement(targetEl);
          base.previousValue = prev.value;
          for (const paso of pasos) {
            // Los pasos de una SECUENCIA se escriben en absoluto: ahí la posición del array ES el
            // canal físico, no un bit dentro de una palabra compartida. En una orden simple se
            // conserva la semántica de `mode` (bitmask = activar sin pisar los bits ajenos).
            const toWrite = secuencia ? paso.value : this.applyValue(write, prev.value, paso.value);
            await this.adapter.writeBufferElement(el(paso.index), toWrite);
            escritos.push({ index: paso.index, value: toWrite });
          }
          base.writtenValue = escritos.find((e) => e.index === write.target.index)?.value ?? null;
        } catch (err) {
          rechazo = { err };
        }

        // 7b) ECO INSTANTÁNEO del canal de comando: prueba, en el momento, que el valor SÍ quedó
        // escrito — independiente del canal de estado (que necesita al equipo respondiendo).
        // En una orden compuesta se comprueban TODOS los pasos: si el sentido no quedó puesto, el
        // equipo no se va a mover por mucho que la habilitación sí esté, y decir "verificado" con
        // medio comando escrito sería exactamente el engaño que este eco existe para evitar.
        if (!rechazo) {
          try {
            let todosOk = true;
            for (const e of escritos) {
              const echo = await this.adapter.readBufferElement(el(e.index));
              if (e.index === write.target.index) base.writeEcho = echo.value;
              if (echo.value !== e.value) todosOk = false;
            }
            base.writeVerified = todosOk;
          } catch {
            base.writeEcho = null;
            base.writeVerified = null; // no se pudo comprobar; no se afirma nada
          }
        }
      } finally {
        soltarTurno();
      }

      if (rechazo) {
        const { err } = rechazo;
        this.logger.error(`write de ${req.command}/${req.target} RECHAZADO: ${err instanceof Error ? err.message : err}`);
        const rejected: CommandResult = { ...base, status: 'failed', reason: FAIL.WRITE_REJECTED };
        await this.repo.finalize(reservation.id, {
          status: 'failed', reason: rejected.reason, previousValue: rejected.previousValue,
          writtenValue: rejected.writtenValue, confirmedValue: rejected.confirmedValue,
          interlockSequence: rejected.interlockSequence,
        });
        return this.audit(actor, req, rejected);
      }

      // 7b-bis) PULSO: sostener y LIMPIAR SIEMPRE, en orden inverso al de escritura. Un comando de
      // pulso que confirmara el estado dejaba antes el bit ENCLAVADO (el rollback solo corría al
      // fallar) — con la válvula operativa eso habría dejado la orden puesta indefinidamente.
      let realimentacion = true;
      if (write.pulse) {
        try {
          realimentacion = await this.sostener(plantId, write);
        } finally {
          // El `finally` es la parte que importa: pase lo que pase durante el sostenido —timeout,
          // caída de la sesión, excepción— el bit se suelta. Dejarlo puesto mantiene la bobina
          // energizada, y eso no puede depender de que todo lo demás haya ido bien.
          //
          // Se limpia con el valor DECLARADO del comando, no con el que se escribió: en `bitmask` lo
          // escrito es la palabra completa (`actual | máscara`), y usar eso para limpiar apagaría
          // también los bits ajenos que se acababa de tener el cuidado de conservar.
          for (const paso of [...pasos].reverse()) await this.clearPulse(el(paso.index), write, paso.value);
        }
      }

      // La realimentación no llegó dentro del tope: se dice ESO, no que el estado no confirmara.
      // Un final de carrera que no responde y una palabra de estado que no cuadra son averías
      // distintas, y mezclarlas en un solo motivo borra el diagnóstico.
      if (!realimentacion) {
        result = { ...base, status: 'failed', reason: FAIL.HOLD_FEEDBACK_TIMEOUT };
        await this.repo.finalize(reservation.id, {
          status: 'failed', reason: result.reason, previousValue: result.previousValue,
          writtenValue: result.writtenValue, confirmedValue: result.confirmedValue,
          interlockSequence: result.interlockSequence,
        });
        return this.audit(actor, req, result, escritos);
      }

      // 7c) Confirmación por el canal de ESTADO (que el equipo se movió).
      const confirmation = await this.confirmReadBack(plantId, write, writtenValue, req.command);
      base.confirmedValue = confirmation.value;

      if (confirmation.confirmed) {
        result = { ...base, status: 'confirmed', reason: null };
      } else if (write.readBack.stateVerified === false && base.writeVerified === true) {
        // El canal de estado de este sitio NO tiene semántica verificada en campo: su valor
        // esperado es una inferencia. Con el eco probando que la escritura quedó en el canal, no
        // hay base para declarar un fallo del equipo — pero tampoco para afirmar que se movió.
        // Ver CommandOutcome.'sent'. Un pulso ya se limpió en 7b-bis; no se hace rollback.
        await this.rollbackSteps(el, write, escritos);
        result = { ...base, status: 'sent', reason: SENT.SENT_STATE_UNVERIFIED };
      } else {
        // Un pulso ya se limpió en 7b-bis: no volver a escribir (sería un segundo pulso espurio).
        await this.rollbackSteps(el, write, escritos); // best-effort
        result = { ...base, status: 'failed', reason: FAIL.READBACK_UNCONFIRMED };
      }
    } catch (err) {
      // Fallo de I/O DESPUÉS de haber escrito: nunca se reporta como 'exitoso'.
      this.logger.error(`comando ${req.command}/${req.target} falló tras escribir: ${err instanceof Error ? err.message : err}`);
      result = { ...base, status: 'failed', reason: FAIL.READBACK_UNCONFIRMED };
    }

    await this.repo.finalize(reservation.id, {
      status: result.status as Exclude<CommandOutcome, never>,
      reason: result.reason,
      previousValue: result.previousValue,
      writtenValue: result.writtenValue,
      confirmedValue: result.confirmedValue,
      interlockSequence: result.interlockSequence,
    });

    return this.audit(actor, req, result, escritos, {
      commandLogId: reservation.id,
      estadoVerificado: write.readBack.stateVerified !== false,
    });
  }

  /** Interlock: BridgeStatus Connected + snapshot fresco (liveness live) + connection OK si está mapeada. */
  private interlock(plantId: string): { ok: boolean; reason: string; sequence: number | null } {
    const bridge = this.adapter.getBridgeStatus();
    if (bridge !== 'Connected') return { ok: false, reason: `bridge ${bridge} (se requiere Connected)`, sequence: null };

    const snap = this.cache.get(plantId);
    if (!snap) return { ok: false, reason: 'sin snapshot del sitio (sin datos)', sequence: null };

    // `frozen` SIEMPRE bloquea: perdimos la fuente y el estado del sitio no está respaldado.
    if (snap.liveness.state === 'frozen') {
      return { ok: false, reason: `snapshot frozen (sin fuente viva)`, sequence: snap.sequence };
    }
    // `stable` = sesión sana con el proceso quieto. Por defecto TAMBIÉN bloquea (postura deliberada:
    // para accionar equipo no basta sesión viva, hay que estar viendo moverse el dato). Pero en un
    // sitio en régimen estable eso hace IMPOSIBLE comandar, y con relojes del PLC desfasados el
    // `live` no es fiable (visto en planta: lastChangeAt de 27 h atrás con el puente Connected). Se
    // puede autorizar explícitamente con COMMAND_REQUIRE_LIVE=false, y queda en la auditoría.
    if (snap.liveness.state !== 'live' && process.env.COMMAND_REQUIRE_LIVE !== 'false') {
      return {
        ok: false,
        reason: `snapshot ${snap.liveness.state} (se requiere fresco/live; autorizar con COMMAND_REQUIRE_LIVE=false)`,
        sequence: snap.sequence,
      };
    }
    const conn = snap.signals['connectionStatus'];
    if (conn && conn.usable === false) {
      return { ok: false, reason: 'connectionStatus del sitio no OK', sequence: snap.sequence };
    }
    return { ok: true, reason: 'ok', sequence: snap.sequence };
  }

  /** Re-lee el elemento de confirmación hasta que coincida con el valor esperado o venza el timeout. */
  private async confirmReadBack(
    plantId: string,
    write: WriteSpec,
    writtenValue: CommandValue,
    command: string,
  ): Promise<{ confirmed: boolean; value: CommandValue }> {
    // El estado esperado depende del VERBO cuando cada comando deja un estado distinto
    // (abrir → 16385, cerrar → 16384). `expectedByCommand` manda sobre el valor único.
    const perCommand = write.readBack.expectedByCommand?.[command];
    const expected: CommandValue =
      perCommand !== undefined
        ? perCommand
        : write.readBack.confirmsWrittenValue
          ? writtenValue
          : write.readBack.expectedValue ?? writtenValue;
    const rbTarget: BufferElementTarget = {
      plantId,
      channel: write.readBack.channel,
      sourceBuffer: write.readBack.sourceBuffer ?? write.target.sourceBuffer,
      index: write.readBack.index,
    };
    // Con el canal de estado NO verificado, esperar los 5 s completos no aporta nada: se estaría
    // aguardando un valor que ya sabemos que no representa el estado (`stateVerified: false`), y
    // mientras tanto el operador mira un botón girando. Se hace una ventana corta —por si el estado
    // SÍ cambiara, que sería información valiosa— y se resuelve. La orden pasa de ~5,5 s a ~1 s.
    const efectivo = write.readBack.stateVerified === false
      ? Math.min(write.timeoutMs, UNVERIFIED_READBACK_MS)
      : write.timeoutMs;
    const deadline = Date.now() + efectivo;
    const pollMs = Math.max(5, Math.min(50, Math.floor(efectivo / 4)));

    let last: CommandValue = null;
    do {
      const rb = await this.adapter.readBufferElement(rbTarget);
      last = rb.value;
      if (last === expected) return { confirmed: true, value: last };
      if (Date.now() >= deadline) break;
      await sleep(pollMs);
    } while (Date.now() < deadline);

    return { confirmed: false, value: last };
  }

  /**
   * Valor a ESCRIBIR para activar el comando.
   *  - `absolute`: el valor del mapping tal cual.
   *  - `bitmask`:  `(actual & ~otrosVerbos) | valor` → activa los bits del comando, APAGA los de los
   *    demás verbos de la misma válvula y CONSERVA el resto de la palabra.
   * Si el valor actual no es numérico (o es booleano) no hay aritmética de bits posible: absoluto.
   *
   * Apagar los otros verbos es la EXCLUSIÓN abrir/cerrar. En Carbonero abrir = bit0 y cerrar = bit1
   * de `INT_OUT[0]`, y los dos a 1 a la vez es el estado que el PLC declara ERROR (integrador,
   * 2026-10-05). Con `actual | valor` a secas, una palabra que todavía trajera el bit contrario —un
   * cierre de pulso que falló, una escritura ajena— quedaba con las dos direcciones energizadas. Va en
   * la MISMA escritura a propósito: la palabra pasa de un sentido al otro sin ningún instante con los
   * dos bits puestos. Un verbo que vale 0 no energiza nada y se aplica como antes.
   */
  private applyValue(write: WriteSpec, current: CommandValue, value: number | boolean): number | boolean {
    if (write.mode !== 'bitmask' || typeof value !== 'number' || typeof current !== 'number') return value;
    const contrarios = (value & 0xffff) === 0 ? 0 : bitsDeLosOtrosVerbos(write.commands, value);
    return ((current & ~contrarios) | value) & 0xffff; // Int16 del PLC
  }

  /**
   * Sostiene la señal y decide cuándo soltarla. Devuelve `true` si el sostenido terminó como debía.
   *
   *  - **Sin `until`**: se duerme `holdMs` y ya. Es el pulso de siempre.
   *  - **Con `until`**: se sondea el elemento de realimentación y se vuelve en cuanto vale lo
   *    esperado — que es como funciona un actuador motorizado: la señal se mantiene hasta que el
   *    final de carrera avisa. `holdMs` deja de ser la duración y pasa a ser el TOPE DURO.
   *
   * Si vence el tope sin que llegue la realimentación devuelve `false`, y el llamante limpia el bit
   * igualmente. Sostener "hasta que llegue" sin límite es lo único que no se contempla: con un
   * sensor averiado eso deja la bobina energizada para siempre y sin que nadie se entere.
   */
  private async sostener(plantId: string, write: WriteSpec): Promise<boolean> {
    const pulse = write.pulse;
    if (!pulse) return true;
    if (!pulse.until) {
      await sleep(pulse.holdMs);
      return true;
    }

    const target: BufferElementTarget = {
      plantId,
      channel: pulse.until.channel,
      // El buffer de realimentación suele ser el mismo del read-back (el canal de ESTADO). Caer al
      // buffer del target sería caer al de SALIDA, que es justo el que nosotros escribimos.
      sourceBuffer: pulse.until.sourceBuffer ?? write.readBack.sourceBuffer ?? write.target.sourceBuffer,
      index: pulse.until.index,
    };
    const deadline = Date.now() + pulse.holdMs;
    let ultimo: CommandValue = null;

    while (Date.now() < deadline) {
      try {
        const lectura = await this.adapter.readBufferElement(target);
        ultimo = lectura.value;
        if (lectura.value === pulse.until.equals) return true;
      } catch (err) {
        // Un fallo de lectura NO cancela el sostenido: la señal ya está puesta y el equipo puede
        // estar moviéndose. Se reintenta hasta el tope, que es quien pone el límite.
        this.logger.warn(`no se pudo leer la realimentación de ${plantId}: ${err instanceof Error ? err.message : err}`);
      }
      await sleep(HOLD_POLL_MS);
    }

    this.logger.error(
      `sostenido de ${plantId} agotado tras ${pulse.holdMs} ms: ${target.sourceBuffer}[${target.index}] esperaba ${String(pulse.until.equals)} y vale ${String(ultimo)}. Se suelta la señal.`,
    );
    return false;
  }

  /**
   * Cierra el pulso: en `bitmask` limpia SOLO los bits del comando (`actual & ~valor`), releyendo el
   * valor por si otro proceso tocó la palabra durante el pulso; en `absolute` escribe `rollbackValue`.
   * Best-effort: si falla, se registra — dejar un bit puesto es peor que un log ruidoso.
   *
   * En TURNO sobre el elemento (ver `turnoDe`): releer no basta si entre la lectura y la escritura cae
   * la orden de otra válvula de la misma palabra.
   */
  private async clearPulse(targetEl: BufferElementTarget, write: WriteSpec, value: number | boolean): Promise<void> {
    const soltarTurno = await this.turnoDe(targetEl);
    try {
      if (write.mode === 'bitmask' && typeof value === 'number') {
        const now = await this.adapter.readBufferElement(targetEl);
        const cleared = typeof now.value === 'number' ? (now.value & ~value) & 0xffff : write.rollbackValue;
        await this.adapter.writeBufferElement(targetEl, cleared);
      } else {
        await this.adapter.writeBufferElement(targetEl, write.rollbackValue);
      }
    } catch (err) {
      this.logger.error(
        `NO se pudo cerrar el pulso en ${targetEl.sourceBuffer}[${targetEl.index}] — puede quedar un bit ACTIVO: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      soltarTurno();
    }
  }

  private async rollback(targetEl: BufferElementTarget, write: WriteSpec): Promise<void> {
    try {
      await this.adapter.writeBufferElement(targetEl, write.rollbackValue);
    } catch (err) {
      this.logger.warn(`rollback falló en ${targetEl.sourceBuffer}[${targetEl.index}]: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Deshace lo escrito, en ORDEN INVERSO: si una orden compuesta falló a medias, hay que soltar todo
   * lo que se energizó, y soltar primero lo último puesto evita pasar por un estado con dos
   * direcciones activas.
   *
   * Dos casos NO se deshacen, a propósito:
   *  - `pulse`: ya se limpió en 7b-bis; repetirlo sería un segundo pulso espurio.
   *  - `latched`: la orden es SOSTENIDA y cada verbo define un estado eléctrico completo. Volver a
   *    `rollbackValue` dejaría la válvula en 0/0 — ni abierta ni cerrada, un estado que nadie pidió
   *    y del que el operador no se enteraría. Ahí lo correcto es dejar la orden puesta y que sea una
   *    persona quien mande el verbo contrario.
   */
  private async rollbackSteps(
    el: (index: number) => BufferElementTarget,
    write: WriteSpec,
    escritos: WriteStep[],
  ): Promise<void> {
    if (write.pulse) return;
    if (write.latched) {
      this.logger.warn(
        `orden SOSTENIDA sin confirmar en ${write.target.sourceBuffer}: se deja puesta (${escritos.map((e) => `[${e.index}]=${String(e.value)}`).join(' ')}). Deshacerla dejaría el actuador sin dirección; mandar el verbo contrario si procede.`,
      );
      return;
    }
    for (const e of [...escritos].reverse()) await this.rollback(el(e.index), write);
  }

  /** Reconstruye el resultado desde una fila previa (respuesta idempotente). */
  private replay(base: Omit<CommandResult, 'status' | 'reason'>, existing: StoredCommand): CommandResult {
    if (existing.status === 'pending') {
      return { ...base, status: 'rejected', reason: REJECT.IN_PROGRESS, idempotent: true };
    }
    return {
      ...base,
      status: existing.status as CommandOutcome,
      reason: existing.reason,
      previousValue: existing.previousValue,
      writtenValue: existing.writtenValue,
      confirmedValue: existing.confirmedValue,
      interlockSequence: existing.interlockSequence,
      idempotent: true,
    };
  }

  /** Los rechazos previos a la reserva no crean fila en command_log; devuelven el resultado tal cual. */
  private async finalizeNoReserve(result: CommandResult): Promise<CommandResult> {
    return result;
  }

  /** Audit log SIEMPRE (regla 12 + criterio de aceptación): todo intento queda registrado. */
  private async audit(
    actor: CommandActor,
    req: CommandRequest,
    result: CommandResult,
    escritos?: WriteStep[],
    traza?: { commandLogId: number | null; estadoVerificado: boolean },
  ): Promise<CommandResult> {
    // La firma y el aviso van ANTES de la auditoría porque la firma cambia lo que se registra: el
    // detalle de auditoría lleva el sello, y sin él la auditoría no diría qué maniobra es cuál.
    const firma = traza?.commandLogId ? await this.firmas.firmar(traza.commandLogId, actor.userName) : null;
    await this.publicarManiobra(actor, result, firma, traza?.estadoVerificado ?? false);
    await this.auditLog.record({
      eventType: 'command.execute',
      userId: actor.userId,
      userEmail: actor.userEmail,
      role: actor.role,
      ip: actor.ip,
      method: 'POST',
      path: `/api/plants/${result.plantId}/commands`,
      statusCode: httpStatusForCommand(result),
      detail: {
        command: result.command,
        target: result.target,
        status: result.status,
        reason: result.reason,
        previousValue: result.previousValue,
        writtenValue: result.writtenValue,
        confirmedValue: result.confirmedValue,
        // TODAS las posiciones escritas, en orden. `writtenValue` solo cuenta la del canal
        // primario: en una orden compuesta, eso deja fuera el paso que da el SENTIDO, que es
        // justamente el que hay que poder revisar cuando la válvula no se mueva.
        steps: escritos && escritos.length > 0 ? escritos.map((e) => ({ index: e.index, value: e.value })) : undefined,
        // Eco del canal de comando: distingue "no se escribió" de "se escribió y no confirmó".
        writeEcho: result.writeEcho,
        writeVerified: result.writeVerified,
        interlockSequence: result.interlockSequence,
        idempotencyKey: req.idempotencyKey ?? null,
        idempotent: result.idempotent,
        firma,
      },
    });
    return result;
  }

  /**
   * Deja la maniobra en la BANDEJA, no en la pantalla de válvulas.
   *
   * Antes esto era un aviso efímero dentro de la propia pantalla: se descartaba con un toque, solo
   * lo veía quien lo hizo y desaparecía al recargar. En una planta donde el equipo NO confirma
   * eléctricamente que la válvula se movió, saber quién la movió y cuándo es la única evidencia que
   * hay — y esa evidencia la tienen que ver el resto de operarios, el jefe y el administrador.
   *
   * No deduplica: cada maniobra es un hecho distinto. Si alguien abre a las 9 y cierra a las 14,
   * tienen que quedar las dos.
   *
   * Silencioso ante fallos: la maniobra ya ocurrió y la respuesta al operador no puede depender de
   * que la bandeja acepte una fila.
   */
  private async publicarManiobra(
    actor: CommandActor,
    result: CommandResult,
    firma: string | null,
    estadoVerificado: boolean,
  ): Promise<void> {
    // Una respuesta idempotente no es una maniobra nueva: es la MISMA orden contestada otra vez.
    // Publicarla duplicaría el registro de un hecho que solo ocurrió una vez.
    if (result.idempotent) return;
    try {
      const aviso = avisoDeManiobra({
        userName: actor.userName,
        userEmail: actor.userEmail,
        valveName: this.nombreDeValvula(result.plantId, result.target),
        command: result.command,
        status: result.status,
        at: result.at,
        firma,
        estadoVerificado,
      });
      await this.avisos.create({
        kind: 'valve_command',
        severity: aviso.severity,
        plantId: result.plantId,
        subject: result.target,
        title: aviso.title,
        message: aviso.message,
        action: aviso.action,
        day: diaLocal(new Date(result.at)),
        // Cada orden es un suceso irrepetible: sin esto, la segunda maniobra del día sobre la misma
        // válvula se descartaría por duplicada.
        eventId: `${result.at}#${firma ?? result.status}`,
      });
    } catch (err) {
      this.logger.error(`no se pudo publicar la maniobra en la bandeja: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Nombre legible de la válvula. Sale del snapshot, que es donde vive la etiqueta del mapping.
   *
   * Si no hay snapshot cae a la clave técnica: es feo, pero un aviso que dice `valveInlet` sigue
   * siendo mejor que uno que no se publica.
   */
  private nombreDeValvula(plantId: string, target: string): string {
    const snap = this.cache.get(plantId);
    // `signals` es un mapa por domainKey, no una lista: el target ES la clave.
    const senal = snap?.signals?.[target];
    return senal?.label?.trim() || target;
  }
}
