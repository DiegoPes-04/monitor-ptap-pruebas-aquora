import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  CANAL_AVISOS,
  CANAL_CRITICAS,
  ETIQUETA_RESUMEN,
  cuerpoDeAviso,
  debeSonar,
  etiquetaDeAviso,
  resumenDeAvisos,
  type NotificationPrefsDto,
  type PruebaPushDto,
} from '@ptap/shared';
import type { TokenMessage } from 'firebase-admin/messaging';
import { DevicePushTokenRepository } from './device-push-token.repository';
import { createFcmSender, SERVICE_ACCOUNT_ENV, type PushSender } from './fcm.sender';
import { NotificationPrefsRepository } from './notification-prefs.repository';
import { NotificationRepository, type CreatedNotification } from './notification.repository';

/** Un mensaje de FCM a falta de saber a qué teléfono va. */
export type PushMessage = Omit<TokenMessage, 'token'>;

/** Etiqueta del aviso de prueba: una prueba nueva reemplaza a la anterior en el panel. */
export const ETIQUETA_PRUEBA = 'prueba';

/**
 * Ajustes del envío. En producción rigen los valores por defecto; los tests los acortan y le pasan un
 * emisor falso, para no esperar segundos reales ni hablar con Google.
 */
export interface PushOptions {
  /**
   * Quien habla con FCM. Sin definir = se crea al arrancar desde `FIREBASE_SERVICE_ACCOUNT_PATH`;
   * `null` = push apagado.
   */
  sender?: PushSender | null;
  /** Cuánto se esperan avisos de la misma ráfaga antes de repartir. */
  windowMs?: number;
  /** Tiempo máximo de cada envío a FCM. */
  timeoutMs?: number;
  /** Espera antes de cada reintento ante un 429/5xx. Su longitud es el número de reintentos. */
  retryDelaysMs?: readonly number[];
  /** Reloj, para las franjas de «no molestar». */
  now?: () => Date;
}
export const PUSH_OPTIONS = Symbol('PUSH_OPTIONS');

/**
 * 3 s de agrupación: lo bastante corto para que el aviso siga siendo «al instante», y lo bastante largo
 * para que un barrido del detector —que guarda sus avisos uno tras otro— salga como UNA ráfaga y se
 * pueda resumir, en vez de doce vibraciones seguidas.
 */
const DEFAULT_WINDOW_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Tres reintentos con espera creciente. */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

/**
 * Zona horaria de las plantas y de sus operarios, que es la de las franjas de «no molestar».
 *
 * `debeSonar` mira la hora con `getHours()`, es decir, la del PROCESO. La VM está en hora de Colombia
 * y eso bastaría, pero dependería de que nadie cambie la zona del servidor: una VM en UTC callaría
 * avisos de 17:00 a 01:00 a quien pidió silencio de 22:00 a 06:00. Colombia no tiene horario de
 * verano, así que fijar la zona aquí no tiene ningún caso raro.
 */
const ZONA_DE_LAS_PLANTAS = 'America/Bogota';
let formatoHora: Intl.DateTimeFormat | null = null;

/**
 * Un `Date` cuya hora LOCAL es la hora de Colombia en `instante`, sea cual sea la zona del proceso.
 * Solo sirve para `debeSonar`, que únicamente lee horas y minutos.
 *
 * Si el runtime no tuviera datos de zonas horarias, se usa el reloj del proceso (la VM está en hora de
 * Colombia): peor un «no molestar» ligeramente impreciso que un envío que falla.
 */
export function horaDeColombia(instante: Date): Date {
  try {
    formatoHora ??= new Intl.DateTimeFormat('en-US', {
      timeZone: ZONA_DE_LAS_PLANTAS,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const partes = formatoHora.formatToParts(instante);
    const h = Number(partes.find((p) => p.type === 'hour')?.value);
    const m = Number(partes.find((p) => p.type === 'minute')?.value);
    if (Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h < 24) return new Date(2000, 0, 1, h, m);
  } catch {
    /* sin datos de zona horaria: el reloj del proceso */
  }
  return instante;
}

interface Contenido {
  titulo: string;
  cuerpo: string;
  canal: string;
  etiqueta: string;
  critico: boolean;
  /** `data` del mensaje, sin `tag` ni `channelId`, que se añaden siempre. Todo texto: FCM no admite otra cosa. */
  datos: { id: string; plantId: string; subject: string; kind: string };
}

/**
 * El mensaje de FCM. Lo que hace cada campo, porque casi todos están por una razón concreta:
 *
 *  - `android.priority: 'high'`: entrega INMEDIATA aunque el teléfono esté en reposo (Doze). Con la
 *    normal, Android la guarda hasta la siguiente ventana de mantenimiento: el retraso que se quiere
 *    quitar.
 *  - `notification` (título y texto): con la app cerrada o en segundo plano es Android —el SDK de FCM—
 *    quien la muestra, sin esperar a que la app arranque. Un mensaje solo de datos dependería de que
 *    la app despertara, que es lo que los fabricantes impiden.
 *  - `channelId`: el canal decide sonido, vibración, banner y pantalla de bloqueo desde Android 8.
 *    Lo normal va a `aquora-avisos` (importancia alta: banner) y lo crítico a `aquora-criticas`
 *    (máxima).
 *  - `tag` = `n-<id>`: Android identifica la notificación por etiqueta + id 0, igual que la que levanta
 *    la consulta de respaldo con ese mismo identificador. Si llegaran las dos, la segunda REEMPLAZA a
 *    la primera en vez de duplicarla.
 *  - `sound`, `defaultVibrateTimings`, `visibility: 'public'` y la prioridad de la notificación
 *    (`PRIORITY_MAX`/`PRIORITY_HIGH` en el cable): son lo que usan los Android anteriores a la 8, que
 *    no tienen canales. Visible en la pantalla de bloqueo: es un aviso de planta, no un mensaje
 *    privado, y tiene que poder leerse sin desbloquear.
 *  - `data` repite `tag` y `channelId`: con la app ABIERTA la notificación la presenta
 *    expo-notifications, que toma el identificador de `data.tag` (el mismo `n-<id>`) y el canal de la
 *    notificación o de `data.channelId`.
 */
function construir(c: Contenido): PushMessage {
  return {
    notification: { title: c.titulo, body: c.cuerpo },
    android: {
      priority: 'high',
      notification: {
        channelId: c.canal,
        tag: c.etiqueta,
        sound: 'default',
        defaultVibrateTimings: true,
        visibility: 'public',
        priority: c.critico ? 'max' : 'high',
      },
    },
    data: { ...c.datos, tag: c.etiqueta, channelId: c.canal },
  };
}

/** Lo que el push necesita de un aviso de la bandeja. */
export type AvisoPush = Pick<CreatedNotification, 'id' | 'kind' | 'severity' | 'plantId' | 'subject' | 'title' | 'message' | 'action'>;

/** Un aviso, por su canal y con su etiqueta. Mismo título y texto que la consulta de respaldo. */
export function mensajeDeAviso(n: AvisoPush): PushMessage {
  const critico = n.severity === 'critical';
  return construir({
    titulo: n.title,
    cuerpo: cuerpoDeAviso(n),
    canal: critico ? CANAL_CRITICAS : CANAL_AVISOS,
    etiqueta: etiquetaDeAviso(n.id),
    critico,
    datos: { id: String(n.id), plantId: n.plantId, subject: n.subject ?? '', kind: n.kind },
  });
}

/**
 * Varios avisos NO críticos resumidos en uno, con etiqueta `resumen`: el siguiente resumen reemplaza al
 * anterior. El id es el del aviso más reciente; la planta, solo si son todos de la misma.
 */
export function mensajeDeResumen(avisos: readonly AvisoPush[]): PushMessage {
  const { titulo, cuerpo } = resumenDeAvisos(avisos);
  const plantas = [...new Set(avisos.map((a) => a.plantId))];
  return construir({
    titulo,
    cuerpo,
    canal: CANAL_AVISOS,
    etiqueta: ETIQUETA_RESUMEN,
    critico: false,
    datos: {
      id: String(Math.max(...avisos.map((a) => a.id))),
      plantId: plantas.length === 1 ? plantas[0] : '',
      subject: '',
      kind: 'resumen',
    },
  });
}

/** El aviso del botón «Enviar aviso de prueba». Va por el canal normal: es el que tiene que dar banner. */
export function mensajeDePrueba(plantId: string): PushMessage {
  return construir({
    titulo: 'Aviso de prueba',
    cuerpo: 'Si lo ves con la app cerrada o con el teléfono bloqueado, los avisos al instante funcionan.',
    canal: CANAL_AVISOS,
    etiqueta: ETIQUETA_PRUEBA,
    critico: false,
    datos: { id: '0', plantId, subject: '', kind: 'prueba' },
  });
}

/**
 * Qué mensajes le tocan a UN usuario de una ráfaga, con SUS preferencias.
 *
 * Es la misma regla que aplica la app en la consulta de respaldo (`notification-sync`), para que un
 * aviso suene igual llegue por donde llegue:
 *  - `debeSonar` decide qué suena: tipos e ítems silenciados, gravedad mínima y franja de «no
 *    molestar». Lo que no suena no se manda: sigue en la bandeja, que nunca se filtra.
 *  - Lo crítico sale UNO POR UNO, nunca resumido: un tanque rebosando no puede leerse igual que tres
 *    sensores parados.
 *  - Más de dos avisos normales salen como UN resumen.
 *
 * Orden ascendente por id: si salen varios, el más reciente queda arriba en el panel.
 */
export function planDeMensajes(avisos: readonly AvisoPush[], prefs: NotificationPrefsDto, ahora: Date): PushMessage[] {
  const unicos = [...new Map(avisos.map((a) => [a.id, a])).values()].sort((a, b) => a.id - b.id);
  const suenan = unicos.filter((n) => debeSonar(n, prefs, ahora));
  const criticos = suenan.filter((n) => n.severity === 'critical');
  const resto = suenan.filter((n) => n.severity !== 'critical');
  const mensajes = criticos.map(mensajeDeAviso);
  if (resto.length > 2) mensajes.push(mensajeDeResumen(resto));
  else mensajes.push(...resto.map(mensajeDeAviso));
  return mensajes;
}

/** Qué hacer con un envío que falló. */
export type ClaseDeFallo =
  /** FCM dice que el token ya no existe o no es válido: se borra, y no se le manda nada más. */
  | 'token-muerto'
  /** 429 o 5xx: es pasajero, se reintenta con espera creciente. */
  | 'reintentable'
  /** Cualquier otra cosa: se registra y se sigue. */
  | 'fallo';

const CODIGOS_TOKEN_MUERTO = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/installation-id-not-registered',
]);

/** Los que firebase-admin da para un 429 o un 5xx cuando la respuesta no trae el estado HTTP. */
const CODIGOS_REINTENTABLES = new Set([
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
  'messaging/server-unavailable',
  'messaging/internal-error',
]);

class TiempoAgotado extends Error {
  constructor(ms: number) {
    super(`sin respuesta de FCM en ${ms} ms`);
  }
}

/**
 * Clasifica un error de firebase-admin (`code` = `messaging/...`, `httpResponse.status`).
 *
 * El caso delicado es `messaging/invalid-argument`: la API v1 de FCM lo usa tanto para un token mal
 * formado como para un MENSAJE mal construido. Solo lo primero condena al token —se reconoce porque el
 * texto habla del token de registro—. Si se borrara ante cualquier `invalid-argument`, un error nuestro
 * en el mensaje vaciaría la tabla y dejaría sin push a todos los teléfonos.
 *
 * Un tiempo agotado NO se reintenta: el mensaje pudo haber llegado, y firebase-admin ya reintenta por su
 * cuenta los 503 y las conexiones cortadas. Repetirlo haría sonar el teléfono dos veces.
 */
export function clasificarError(err: unknown): { clase: ClaseDeFallo; codigo: string } {
  if (err instanceof TiempoAgotado) return { clase: 'fallo', codigo: 'tiempo-agotado' };
  const e = (err && typeof err === 'object' ? err : {}) as {
    code?: unknown;
    message?: unknown;
    httpResponse?: { status?: unknown };
  };
  const code = typeof e.code === 'string' ? e.code : 'desconocido';
  const status = typeof e.httpResponse?.status === 'number' ? e.httpResponse.status : null;
  const codigo = status === null ? code : `${code} (HTTP ${status})`;

  if (CODIGOS_TOKEN_MUERTO.has(code)) return { clase: 'token-muerto', codigo };
  if (code === 'messaging/invalid-argument' && /registration token/i.test(String(e.message ?? ''))) {
    return { clase: 'token-muerto', codigo };
  }
  if (status === 429 || (status !== null && status >= 500 && status <= 599) || CODIGOS_REINTENTABLES.has(code)) {
    return { clase: 'reintentable', codigo };
  }
  return { clase: 'fallo', codigo };
}

/** Desenlace de UN mensaje a UN teléfono, ya con los reintentos hechos. */
type Desenlace = { clase: 'enviado' } | { clase: ClaseDeFallo; codigo: string };

/** Cuántos de qué, para el log y para los tests. */
export interface ResumenDeEnvio {
  avisos: number;
  telefonos: number;
  enviados: number;
  fallidos: number;
  tokensBorrados: number;
}

const VACIO: ResumenDeEnvio = { avisos: 0, telefonos: 0, enviados: 0, fallidos: 0, tokensBorrados: 0 };

const esperar = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/** Lo último del token, para reconocerlo en el log sin dejar el token entero escrito. */
function colaDe(token: string): string {
  return `…${token.slice(-8)}`;
}

/**
 * Envío por push (FCM) de los avisos de la bandeja, en cuanto se guardan.
 *
 * El problema que resuelve: hasta ahora el teléfono PREGUNTABA cada 15 min o más, y Android retrasaba
 * la consulta con la pantalla apagada. Ahora, cuando un detector guarda un aviso, el servidor lo empuja
 * por FCM y Android lo muestra por su cuenta —banner, sonido, vibración, pantalla de bloqueo— aunque la
 * app esté cerrada. La consulta periódica queda como respaldo para los teléfonos sin push.
 *
 * Tres decisiones que conviene no revertir sin pensarlo:
 *
 *  1. **Fuera del camino del aviso.** Se engancha como oyente de `NotificationRepository.create()`, que
 *     se lo pasa con `setImmediate` y sin esperar: ni los detectores ni una orden de válvula esperan a
 *     Google. Ver `NotificationRepository.announce`.
 *  2. **Destinatarios en el momento del envío**, con la regla de la bandeja (`recibeAvisosDe`) y las
 *     preferencias de cada uno (`debeSonar`). No hay lista de suscripción que mantener: desactivar una
 *     cuenta o cambiarle el rol corta sus avisos al instante.
 *  3. **Nunca lanza.** Cada fallo queda en el log y nada más: el aviso ya está guardado en la bandeja,
 *     que es la fuente de verdad, y la consulta de respaldo sigue funcionando.
 *
 * APAGADO mientras no exista la clave de Firebase (`FIREBASE_SERVICE_ACCOUNT_PATH`): no se encola nada
 * y el arranque lo dice en el log. Así el backend se puede desplegar antes de tener la clave.
 */
@Injectable()
export class PushDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Push');
  private sender: PushSender | null | undefined;
  private readonly windowMs: number;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly now: () => Date;

  private pending: CreatedNotification[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @Inject(DevicePushTokenRepository) private readonly devices: DevicePushTokenRepository,
    @Inject(NotificationPrefsRepository) private readonly prefs: NotificationPrefsRepository,
    @Inject(NotificationRepository) private readonly notifications: NotificationRepository,
    @Optional() @Inject(PUSH_OPTIONS) options?: PushOptions,
  ) {
    this.sender = options?.sender;
    this.windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelaysMs = options?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.now = options?.now ?? (() => new Date());
  }

  /** ¿Hay clave de Firebase y el emisor arrancó? Es lo que la app recibe como `pushActivo`. */
  get active(): boolean {
    return Boolean(this.sender);
  }

  async onModuleInit(): Promise<void> {
    if (this.sender === undefined) {
      try {
        this.sender = await createFcmSender(process.env[SERVICE_ACCOUNT_ENV], this.logger);
      } catch (err) {
        // `createFcmSender` no lanza; esto es la red de seguridad para que el arranque no dependa de ello.
        this.sender = null;
        this.logger.error(`push apagado: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.notifications.onCreated((n) => this.enqueue(n));
  }

  onModuleDestroy(): void {
    this.notifications.onCreated(null);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.length > 0) {
      this.logger.warn(`${this.pending.length} aviso(s) sin empujar al apagar: siguen en la bandeja`);
    }
    this.pending = [];
  }

  /**
   * Recibe un aviso recién guardado. No envía nada todavía: abre (o alarga) la ventana de agrupación y,
   * al cerrarla, reparte todo lo acumulado de una vez. Síncrono y barato: es lo único que corre en el
   * oyente de `create()`.
   */
  enqueue(n: CreatedNotification): void {
    if (!this.sender) return;
    this.pending.push(n);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.windowMs);
    this.timer.unref?.();
  }

  /** Reparte YA lo acumulado (lo llama la ventana al cerrarse; los tests, directamente). Nunca lanza. */
  async flush(): Promise<ResumenDeEnvio> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const lote = this.pending.splice(0);
    const sender = this.sender;
    if (!sender || lote.length === 0) return VACIO;
    try {
      return await this.repartir(lote, sender);
    } catch (err) {
      this.logger.error(`push: no se pudo repartir ${lote.length} aviso(s): ${err instanceof Error ? err.message : err}`);
      return { ...VACIO, avisos: lote.length };
    }
  }

  /**
   * El aviso de prueba de Ajustes: SOLO a los teléfonos de quien lo pide, al momento y sin agrupar.
   *
   * Sin preferencias ni «no molestar»: lo pidió la persona, ahora, para comprobar que le llegan. Y sin
   * reintentos, para que la respuesta no tarde más que un envío: es una comprobación, no un aviso que
   * no se pueda perder. Un token muerto se borra igual que en un envío normal.
   */
  async sendTest(userId: string, plantId: string): Promise<PruebaPushDto> {
    const sender = this.sender;
    if (!sender) return { pushActivo: false, telefonos: 0, enviados: 0, fallidos: 0 };
    const tokens = await this.devices.tokensDe(userId);
    const mensaje = mensajeDePrueba(plantId);
    const desenlaces = await Promise.all(
      tokens.map(async (token) => {
        const d = await this.enviarUno(sender, { ...mensaje, token }, []);
        if (d.clase === 'token-muerto') await this.borrarToken(token, d.codigo);
        return d;
      }),
    );
    const enviados = desenlaces.filter((d) => d.clase === 'enviado').length;
    this.logger.log(`push: aviso de prueba de ${userId} → ${enviados}/${tokens.length} teléfono(s)`);
    return { pushActivo: true, telefonos: tokens.length, enviados, fallidos: tokens.length - enviados };
  }

  private async repartir(lote: CreatedNotification[], sender: PushSender): Promise<ResumenDeEnvio> {
    // Quién recibe qué: una consulta por planta del lote, con la regla de la bandeja.
    const porUsuario = new Map<string, { tokens: Set<string>; avisos: CreatedNotification[] }>();
    for (const plantId of new Set(lote.map((n) => n.plantId))) {
      const dePlanta = lote.filter((n) => n.plantId === plantId);
      for (const d of await this.devices.destinatarios(plantId)) {
        const u = porUsuario.get(d.userId) ?? { tokens: new Set<string>(), avisos: [] };
        d.tokens.forEach((t) => u.tokens.add(t));
        u.avisos.push(...dePlanta);
        porUsuario.set(d.userId, u);
      }
    }

    // Qué le suena a cada uno, con SUS preferencias y la hora de Colombia.
    const ahora = horaDeColombia(this.now());
    const trabajos: Promise<{ enviados: number; fallidos: number; borrado: boolean }>[] = [];
    for (const [userId, u] of porUsuario) {
      const mensajes = planDeMensajes(u.avisos, await this.prefs.get(userId), ahora);
      if (mensajes.length === 0) continue;
      for (const token of u.tokens) trabajos.push(this.enviarATelefono(sender, token, mensajes));
    }

    const resultados = await Promise.all(trabajos);
    const resumen: ResumenDeEnvio = {
      avisos: lote.length,
      telefonos: resultados.length,
      enviados: resultados.reduce((s, r) => s + r.enviados, 0),
      fallidos: resultados.reduce((s, r) => s + r.fallidos, 0),
      tokensBorrados: resultados.filter((r) => r.borrado).length,
    };
    this.logger.log(
      `push: ${resumen.avisos} aviso(s) → ${resumen.telefonos} teléfono(s): ${resumen.enviados} enviado(s), ` +
        `${resumen.fallidos} fallido(s), ${resumen.tokensBorrados} token(s) borrado(s)`,
    );
    return resumen;
  }

  /**
   * Los mensajes de un teléfono, de uno en uno y en orden: así el más reciente queda arriba y no se
   * dispara el límite de mensajes por dispositivo de FCM. Los teléfonos distintos van en paralelo. Si
   * el token resulta muerto, se borra y no se le manda nada más.
   */
  private async enviarATelefono(
    sender: PushSender,
    token: string,
    mensajes: PushMessage[],
  ): Promise<{ enviados: number; fallidos: number; borrado: boolean }> {
    let enviados = 0;
    let fallidos = 0;
    for (const m of mensajes) {
      const d = await this.enviarUno(sender, { ...m, token }, this.retryDelaysMs);
      if (d.clase === 'enviado') {
        enviados++;
        continue;
      }
      fallidos++;
      if (d.clase === 'token-muerto') {
        await this.borrarToken(token, d.codigo);
        return { enviados, fallidos, borrado: true };
      }
    }
    return { enviados, fallidos, borrado: false };
  }

  /** UN mensaje a UN teléfono: tiempo máximo por envío y reintentos con espera creciente ante 429/5xx. */
  private async enviarUno(sender: PushSender, mensaje: TokenMessage, esperas: readonly number[]): Promise<Desenlace> {
    for (let intento = 0; ; intento++) {
      try {
        await this.conTiempoMaximo(Promise.resolve().then(() => sender.send(mensaje)));
        return { clase: 'enviado' };
      } catch (err) {
        const { clase, codigo } = clasificarError(err);
        if (clase === 'reintentable' && intento < esperas.length) {
          this.logger.warn(
            `push: ${codigo} hacia ${colaDe(mensaje.token)}; reintento ${intento + 1}/${esperas.length} en ${esperas[intento]} ms`,
          );
          await esperar(esperas[intento]);
          continue;
        }
        if (clase !== 'token-muerto') {
          this.logger.warn(
            `push: no se pudo enviar a ${colaDe(mensaje.token)} (${codigo}): ${err instanceof Error ? err.message : err}`,
          );
        }
        return { clase, codigo };
      }
    }
  }

  private async conTiempoMaximo<T>(promesa: Promise<T>): Promise<T> {
    let t: ReturnType<typeof setTimeout> | undefined;
    const limite = new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new TiempoAgotado(this.timeoutMs)), this.timeoutMs);
      t.unref?.();
    });
    try {
      return await Promise.race([promesa, limite]);
    } finally {
      if (t) clearTimeout(t);
    }
  }

  private async borrarToken(token: string, codigo: string): Promise<void> {
    try {
      await this.devices.borrarToken(token);
      this.logger.warn(`push: token ${colaDe(token)} borrado (${codigo}): ese teléfono ya no está registrado en FCM`);
    } catch (err) {
      this.logger.error(`push: no se pudo borrar el token ${colaDe(token)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
