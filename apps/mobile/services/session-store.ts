import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { getAuthToken, setAuthToken } from './api';

/**
 * Dónde y cómo se guarda la sesión en el dispositivo.
 *
 * Estaba dentro de `AuthContext.tsx` y se sacó aquí por la tarea de segundo plano: cuando
 * WorkManager despierta la app con el proceso muerto no se monta React, así que `AuthContext` no
 * llega a restaurar nada y el JWT en memoria (`services/api.ts`) vale `null`. La tarea necesita
 * leer la sesión guardada SIN depender de un componente, y para eso estas piezas tienen que vivir
 * fuera de él. `AuthContext` las importa de aquí: el comportamiento es el mismo de antes.
 *
 * Este módulo puede importar `api.ts`; `api.ts` NO debe importar este (sería un ciclo).
 */

export const TOKEN_KEY = 'ptap_auth_token';
export const USER_KEY = 'ptap_auth_user';

/**
 * Instante de expiración (ms epoch) del JWT, leyendo el `exp` del payload. NO verifica la firma
 * — eso es del backend en cada petición; aquí solo se lee el reloj de la sesión para que la app
 * cierre sola a la hora que el backend ya decidió (JWT_EXPIRES_IN, 8 h). null = sin exp legible;
 * en ese caso el cierre queda en manos del 401 del backend.
 */
export function tokenExpiryMs(token: string): number | null {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64)) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export const storage = {
  getItem: (key: string) =>
    Platform.OS === 'web'
      ? Promise.resolve(localStorage.getItem(key))
      : SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) =>
    Platform.OS === 'web'
      ? Promise.resolve(localStorage.setItem(key, value))
      : SecureStore.setItemAsync(key, value),
  deleteItem: (key: string) =>
    Platform.OS === 'web'
      ? Promise.resolve(localStorage.removeItem(key))
      : SecureStore.deleteItemAsync(key),
};

/**
 * Deja el cliente REST con el JWT guardado, para la tarea de segundo plano. Devuelve si hay sesión
 * utilizable.
 *
 * Si ya hay token en memoria (la app está viva y `AuthContext` lo restauró), no se toca nada. Si no,
 * se lee el guardado y solo se usa si no ha vencido: una sesión de más de 8 h haría que la tarea
 * consultara la bandeja para recibir un 401 cada quince minutos.
 *
 * **No borra nada ni cierra la sesión.** Limpiar una sesión vencida es cosa de `AuthContext` al
 * abrir la app, que además manda al login; hacerlo desde un proceso sin interfaz dejaría a la app
 * en un estado que nadie ve. Aquí solo se decide si la tarea tiene con qué consultar.
 *
 * Un token sin `exp` legible se da por válido, igual que hace `AuthContext` al restaurarlo: en ese
 * caso el cierre lo decide el 401 del backend.
 */
export async function restaurarTokenDeSesion(): Promise<boolean> {
  if (getAuthToken()) return true;

  const guardado = await storage.getItem(TOKEN_KEY);
  if (!guardado) return false;

  const exp = tokenExpiryMs(guardado);
  if (exp !== null && exp <= Date.now()) return false;

  setAuthToken(guardado);
  return true;
}
