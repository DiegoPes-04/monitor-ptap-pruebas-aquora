import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { NotificationKind, NotificationSeverity } from '@ptap/shared';
import { MYSQL_POOL } from '../../infrastructure/database/database.tokens';

export type { NotificationKind, NotificationSeverity };

export interface NewNotification {
  kind: NotificationKind;
  severity: NotificationSeverity;
  plantId: string;
  /** Señal/tanque concreto, para que el front navegue al item exacto. */
  subject: string | null;
  title: string;
  message: string;
  /**
   * QUÉ HACER, en una frase. Se pinta aparte y destacado, no enterrado en el párrafo.
   *
   * Existe porque ningún aviso lo decía: describían el síntoma y, con suerte, el diagnóstico. El
   * único que justifica salir corriendo —el rebose real— cerraba con «Revisar la planta: se está
   * perdiendo agua tratada», sin decir qué válvula tocar ni a quién llamar.
   *
   * `null` cuando no hay una acción clara. Inventarse una es peor que no ponerla: enseña al
   * operario a ignorar este campo.
   */
  action?: string | null;
  /** Día al que se ancla la deduplicación (YYYY-MM-DD). */
  day: string;
  /**
   * Discriminante para avisos que son SUCESOS, no estados.
   *
   * La deduplicación existe para no repetir «este sensor sigue caído» cada diez minutos. Pero una
   * maniobra de válvula no es un estado que persiste: si el jefe abre a las 9 y cierra a las 14,
   * son dos hechos y los dos tienen que quedar. Sin esto, el segundo se perdía por tener la misma
   * clave que el primero.
   */
  eventId?: string;
}

/**
 * Un aviso recién insertado, tal como se le pasa al oyente de `create()`: lo que se guardó, más el id
 * que le dio la base (de él sale la etiqueta `n-<id>` del panel del teléfono).
 */
export interface CreatedNotification extends NewNotification {
  id: number;
  /** Momento del INSERT en este proceso. Informativo: la hora que rige es la de la fila. */
  createdAt: string;
}

/** Quien quiere enterarse de cada aviso NUEVO (hoy, el envío por push). */
export type NotificationListener = (n: CreatedNotification) => void | Promise<void>;

export interface StoredNotification {
  id: number;
  kind: NotificationKind;
  severity: NotificationSeverity;
  plantId: string;
  subject: string | null;
  title: string;
  message: string;
  /** Qué hacer, en una frase. `null` si no hay una acción clara. Ver `NewNotification.action`. */
  action: string | null;
  createdAt: string;
  seen: boolean;
}

const DUP_ENTRY = 'ER_DUP_ENTRY';

/**
 * `<kind>:<plantId>[:<subject>]:<severity>:<YYYY-MM-DD>` — un aviso por problema, GRAVEDAD y día.
 *
 * **La severidad entra en la clave, y esa es la parte que importa.** Sin ella, un tanque que a las
 * 19:05 estaba `indeterminado` (warning) y a las 21:00 pasa a `rebosando` (critical) NO generaba
 * aviso: mismo tipo, misma planta, mismo sujeto, mismo día. El empeoramiento se tragaba en silencio,
 * que es exactamente lo contrario de lo que un sistema de avisos debe hacer.
 *
 * Sigue callando la repetición idéntica —el mismo problema con la misma gravedad no vuelve a avisar
 * hasta el día siguiente—, que es para lo que se creó la deduplicación. Lo único que cambia es que
 * *empeorar* cuenta como noticia nueva. Mejorar también: un `critical` que baja a `warning` avisa, y
 * eso es información útil («va a mejor») que antes tampoco llegaba.
 */
function dedupeKeyOf(n: NewNotification): string {
  const base = [n.kind, n.plantId, n.subject ?? '-', n.severity, n.day];
  return (n.eventId ? [...base, n.eventId] : base).join(':');
}

/**
 * Ámbito por planta de las consultas de la bandeja.
 *
 * `null` = sin acotar, y eso SOLO lo concede `view_all_plants` (hoy el Admin). Se devuelve como
 * fragmento + parámetros en lugar de interpolar el identificador en el SQL.
 */
function plantFilter(plantScope: string | null): { sql: string; params: string[] } {
  return plantScope === null ? { sql: '', params: [] } : { sql: ' AND n.plant_id = ?', params: [plantScope] };
}

/**
 * Ámbito de una consulta de bandeja. Hoy es SOLO la planta, y conviene entender por qué.
 *
 * Hubo aquí un filtro por tipo y gravedad, para que el usuario pudiera limpiarse la bandeja. Se
 * quitó al unificar el silenciado en dos modos: **silenciar significa que no suena fuera de la
 * app, nunca que el aviso desaparece.** El historial es evidencia —sobre todo el de las válvulas—
 * y algo que se puede ocultar sin querer deja de servir para reclamar nada.
 *
 * El filtro por preferencias vive ahora en el cliente, en el momento de decidir si suena
 * (`debeSonar` en `@ptap/shared`). Aquí no se filtra: se sirve todo lo de la planta.
 */
export interface NotificationScope {
  plantScope: string | null;
}

export function scopeFilter(scope: NotificationScope): { sql: string; params: (string | number)[] } {
  return plantFilter(scope.plantScope);
}

/**
 * Bandeja de notificaciones.
 *
 * Dos decisiones que conviene no revertir sin pensarlo:
 *
 *  1. **La deduplicación la hace la BASE, no el código.** `create()` inserta y deja que el índice
 *     único rechace el duplicado. Comprobar-y-luego-insertar tendría una carrera: dos ciclos del
 *     detector solapados crearían dos avisos del mismo problema.
 *  2. **No existe `delete()`.** El usuario no puede borrar un aviso, solo marcarlo visto: el
 *     historial es evidencia operativa. Lo único que borra filas es la purga por retención.
 */
@Injectable()
export class NotificationRepository {
  private readonly logger = new Logger('Notifications');
  private listener: NotificationListener | null = null;

  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  /**
   * Engancha a quien debe enterarse de cada aviso NUEVO (el envío por push). Uno solo; `null` lo
   * suelta.
   *
   * Es un oyente y no un parámetro de `create()` a propósito: hay seis sitios que crean avisos
   * (detectores, observador de válvulas, libro de firmas y `WriteService.publicarManiobra`) y
   * ninguno tiene que saber que existe el push. `create()` sigue devolviendo solo si el aviso es nuevo.
   */
  onCreated(listener: NotificationListener | null): void {
    this.listener = listener;
  }

  /**
   * Crea el aviso si no existe ya uno del mismo problema ese día.
   * @returns true si se creó (es nuevo), false si ya existía.
   */
  async create(input: NewNotification): Promise<boolean> {
    try {
      const resultado = await this.pool.query<ResultSetHeader>(
        `INSERT INTO notification (dedupe_key, kind, severity, plant_id, subject, title, message, action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [dedupeKeyOf(input), input.kind, input.severity, input.plantId, input.subject, input.title, input.message, input.action ?? null],
      );
      this.announce(input, resultado);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === DUP_ENTRY) return false; // ya se avisó hoy
      this.logger.error(`No se pudo crear la notificación: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /**
   * Pasa el aviso recién creado al oyente SIN esperarlo: en la siguiente vuelta del bucle de eventos
   * (`setImmediate`) y sin `await`.
   *
   * Lo que se protege es la respuesta al operario. Uno de los sitios que crean avisos es la maniobra
   * de válvula, y `WriteService` espera a `create()` antes de contestar al mando: si el envío por push
   * corriera dentro, un Google lento o caído retrasaría la respuesta de una orden de válvula. Así
   * `create()` tarda lo mismo que el INSERT, haya push o no.
   *
   * Nunca lanza, ni aquí ni dentro del oyente: el aviso ya está guardado en la bandeja y nada de lo que
   * pase con el push puede convertir eso en un fallo.
   */
  private announce(input: NewNotification, resultado: unknown): void {
    const listener = this.listener;
    if (!listener) return;
    try {
      const cabecera = Array.isArray(resultado) ? (resultado[0] as Partial<ResultSetHeader> | undefined) : undefined;
      const id = Number(cabecera?.insertId);
      if (!Number.isSafeInteger(id) || id <= 0) {
        // Sin id no hay etiqueta `n-<id>` que case con la del teléfono: mejor no empujarlo que
        // duplicarlo. Sigue en la bandeja y la consulta de respaldo lo encontrará.
        this.logger.warn(`aviso creado sin insertId utilizable (${String(cabecera?.insertId)}): no se empuja`);
        return;
      }
      const creado: CreatedNotification = { ...input, id, createdAt: new Date().toISOString() };
      setImmediate(() => {
        Promise.resolve()
          .then(() => listener(creado))
          .catch((err: unknown) => {
            this.logger.error(`el oyente de avisos nuevos falló con el aviso ${id}: ${err instanceof Error ? err.message : err}`);
          });
      });
    } catch (err) {
      this.logger.error(`no se pudo anunciar el aviso nuevo: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Historial reciente con el estado de lectura DE ESE usuario, acotado a `plantScope`
   * (`null` = todas las plantas).
   */
  async listRecent(
    userId: string,
    scope: NotificationScope,
    sinceHours: number,
    limit: number,
  ): Promise<StoredNotification[]> {
    const planta = scopeFilter(scope);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT n.id, n.kind, n.severity, n.plant_id, n.subject, n.title, n.message, n.action, n.created_at,
              (s.user_id IS NOT NULL) AS seen
         FROM notification n
         LEFT JOIN notification_seen s ON s.notification_id = n.id AND s.user_id = ?
        WHERE n.created_at >= NOW() - INTERVAL ? HOUR${planta.sql}
        ORDER BY n.created_at DESC
        LIMIT ?`,
      [userId, sinceHours, ...planta.params, limit],
    );
    return rows.map((r) => ({
      id: r.id as number,
      kind: r.kind as NotificationKind,
      severity: r.severity as NotificationSeverity,
      plantId: r.plant_id as string,
      subject: (r.subject as string | null) ?? null,
      title: r.title as string,
      message: r.message as string,
      action: (r.action as string | null) ?? null,
      createdAt: new Date(r.created_at as Date).toISOString(),
      seen: Boolean(r.seen),
    }));
  }

  /**
   * Cuántos avisos del historial reciente NO ha visto este usuario, dentro de su ámbito (es el
   * número de la campana). Va acotado igual que `listRecent`: si contara de más, la campana
   * marcaría avisos que la bandeja no llega a mostrar y nunca se podría dejar en cero.
   */
  async countUnseen(userId: string, scope: NotificationScope, sinceHours: number): Promise<number> {
    const planta = scopeFilter(scope);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n
         FROM notification n
         LEFT JOIN notification_seen s ON s.notification_id = n.id AND s.user_id = ?
        WHERE n.created_at >= NOW() - INTERVAL ? HOUR
          AND s.user_id IS NULL${planta.sql}`,
      [userId, sinceHours, ...planta.params],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Marca como vistos los avisos recientes DEL ÁMBITO de ese usuario. Idempotente: `INSERT IGNORE`
   * deja intacta la marca previa, así que `seen_at` conserva la PRIMERA vez que lo vio.
   *
   * Acotado a propósito: sin el filtro se marcarían como vistos avisos de plantas que la persona
   * nunca vio, y si mañana un admin la reasigna a otra planta llegaría con el historial ya "leído".
   *
   * Va con el MISMO ámbito con el que se pintó la bandeja —preferencias incluidas—: se marca visto
   * exactamente lo que se enseñó. Si alguien deja de silenciar un tipo, esos avisos reaparecen sin
   * ver, que es la verdad: nunca los vio.
   */
  async markAllSeen(userId: string, scope: NotificationScope, sinceHours: number): Promise<number> {
    const planta = scopeFilter(scope);
    const [res] = await this.pool.query<ResultSetHeader>(
      `INSERT IGNORE INTO notification_seen (notification_id, user_id)
       SELECT n.id, ? FROM notification n
        WHERE n.created_at >= NOW() - INTERVAL ? HOUR${planta.sql}`,
      [userId, sinceHours, ...planta.params],
    );
    return res.affectedRows ?? 0;
  }

  /** Purga por retención. Las marcas de visto caen solas por la FK en cascada. */
  async purgeOlderThan(days: number): Promise<number> {
    const [res] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM notification WHERE created_at < NOW() - INTERVAL ? DAY`,
      [days],
    );
    return res.affectedRows ?? 0;
  }
}
