import { Inject, Injectable } from '@nestjs/common';
import { hasPermission, ROLES, type Role } from '@ptap/shared';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../../infrastructure/database/database.tokens';

/** Un usuario que debe recibir un aviso, con todos sus teléfonos. */
export interface Destinatario {
  userId: string;
  tokens: string[];
}

/**
 * ¿Le corresponden a este usuario los avisos de `plantId`?
 *
 * Es la MISMA regla que acota la bandeja (`scopeOf` en `NotificationsController`): hace falta
 * `view_dashboard` —el Civil no recibe avisos de proceso— y, además, `view_all_plants` o que la
 * planta sea la suya. Si las dos reglas divergieran, a alguien le sonaría en el teléfono un aviso que
 * luego no encuentra en su bandeja, o al revés; a un operario de Km 18 ya le sonaban los de Cascajal
 * antes de que la bandeja se acotara por planta.
 *
 * Un rol que no existe en la matriz no recibe nada: `hasPermission` no lo conoce y fallaría.
 */
export function recibeAvisosDe(role: string, plant: string | null, plantId: string): boolean {
  if (!ROLES.includes(role as Role)) return false;
  if (!hasPermission(role as Role, 'view_dashboard')) return false;
  if (hasPermission(role as Role, 'view_all_plants')) return true;
  return Boolean(plant) && plant === plantId;
}

/**
 * Teléfonos registrados para recibir avisos por push.
 *
 * Una fila por token de FCM, con UNIQUE en el token: si otra persona entra en el mismo teléfono, el
 * token pasa a ella. A quién se manda cada aviso NO se guarda aquí: se decide en el momento de enviar,
 * con la cuenta tal como está (activa, rol, planta). Así desactivar a alguien o pasarlo a Civil corta
 * sus avisos al instante, sin que nadie tenga que acordarse de limpiar esta tabla.
 */
@Injectable()
export class DevicePushTokenRepository {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  /**
   * Alta o actualización. Si el token ya existía —aunque fuera de otra persona— pasa a `userId` y se
   * refresca `last_seen_at`: lo normal es que la app lo vuelva a registrar cada vez que se abre.
   */
  async registrar(userId: string, token: string, platform: string, appVersion: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO device_push_token (user_id, token, platform, app_version)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         user_id      = VALUES(user_id),
         platform     = VALUES(platform),
         app_version  = VALUES(app_version),
         last_seen_at = CURRENT_TIMESTAMP(3)`,
      [userId, token, platform, appVersion],
    );
  }

  /**
   * Baja a petición del propio usuario (al cerrar sesión). Solo borra si el token es SUYO: nadie
   * puede dar de baja el teléfono de otra persona aunque conozca su token.
   * @returns cuántas filas borró (0 o 1).
   */
  async quitar(token: string, userId: string): Promise<number> {
    const [res] = await this.pool.query<ResultSetHeader>(
      'DELETE FROM device_push_token WHERE token = ? AND user_id = ?',
      [token, userId],
    );
    return res.affectedRows ?? 0;
  }

  /** Baja porque FCM dijo que el token ya no vale (app desinstalada, datos borrados, token rotado). */
  async borrarToken(token: string): Promise<void> {
    await this.pool.query('DELETE FROM device_push_token WHERE token = ?', [token]);
  }

  /** Teléfonos de un usuario concreto: el aviso de prueba va solo a los de quien lo pide. */
  async tokensDe(userId: string): Promise<string[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT token FROM device_push_token WHERE user_id = ? ORDER BY id',
      [userId],
    );
    return rows.map((r) => r.token as string);
  }

  /**
   * Quién debe recibir los avisos de `plantId`, con sus teléfonos.
   *
   * La cuenta activa se filtra en SQL (`is_active = 1`): una cuenta desactivada no recibe nada aunque
   * conserve sus tokens. El rol y la planta se filtran en código, con `recibeAvisosDe`, para que la
   * regla sea literalmente la de la bandeja y no una traducción a SQL que pueda desviarse.
   *
   * Lee todos los teléfonos registrados: son decenas, no miles, y una consulta por planta y ráfaga.
   */
  async destinatarios(plantId: string): Promise<Destinatario[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT t.token, u.id AS user_id, u.role, u.plant
         FROM device_push_token t
         JOIN users u ON u.id = t.user_id
        WHERE u.is_active = 1
        ORDER BY t.id`,
    );
    const porUsuario = new Map<string, Destinatario>();
    for (const r of rows) {
      if (!recibeAvisosDe(String(r.role), (r.plant as string | null) ?? null, plantId)) continue;
      const userId = String(r.user_id);
      const d = porUsuario.get(userId) ?? { userId, tokens: [] };
      d.tokens.push(String(r.token));
      porUsuario.set(userId, d);
    }
    return [...porUsuario.values()];
  }
}
