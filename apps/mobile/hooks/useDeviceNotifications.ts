import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import type { PruebaPushDto } from '@ptap/shared';
import { useAuth } from '../context/AuthContext';
import {
  getPermission,
  isSupported,
  requestPermission,
  unsupportedReason,
  type PermissionState,
} from '../services/device-notifications';
import {
  registerBackgroundSync,
  syncNotificationsToDevice,
  UPDATE_TAG,
} from '../services/notification-sync';
import { escucharCambiosDeToken, probarPush, registrarPush } from '../services/push-registration';
import type { EstadoPush } from '../services/push-rules';

/**
 * Notificaciones del sistema operativo: permiso, push y sincronización de respaldo.
 *
 * Se monta en la cáscara de `(app)` (la franja de permiso) y en la tarjeta de Ajustes, siempre ya con
 * sesión: sin token la consulta a la bandeja daría 401. Que haya dos instancias no duplica avisos:
 * `syncNotificationsToDevice` comparte la sincronización en curso entre todos los que la piden, y
 * `registrarPush` el registro.
 *
 * **No pide el permiso solo.** Un `requestPermission()` automático al arrancar lo rechazan los
 * navegadores y Android lo cuenta como denegado — y una vez denegado, volver a pedirlo ya no
 * muestra el diálogo. El permiso se pide desde el botón de Ajustes, con un gesto del usuario.
 */

/** Cada cuánto consulta la bandeja la versión web mientras la pestaña esté abierta. */
const WEB_POLL_MS = 5 * 60 * 1000;

/**
 * Toques ya atendidos, por identificador de notificación.
 *
 * `getLastNotificationResponseAsync()` devuelve SIEMPRE la última respuesta, no una cola: si el hook
 * se remonta (recarga en caliente, o un re-render de la cáscara) volvería a leer el mismo toque y
 * abriría el navegador otra vez. A nivel de módulo y no de componente justamente para sobrevivir a
 * ese remontaje.
 */
const toquesAtendidos = new Set<string>();
export function useDeviceNotifications(): {
  supported: boolean;
  reason: string | null;
  permission: PermissionState;
  ask: () => Promise<void>;
  /** En qué quedó el push de este teléfono (ver `EstadoPush`). */
  push: EstadoPush;
  /** «Enviar aviso de prueba»: lo manda el servidor, solo a los teléfonos de quien lo pide. */
  probar: () => Promise<PruebaPushDto>;
} {
  const [permission, setPermission] = useState<PermissionState>('undetermined');
  const [push, setPush] = useState<EstadoPush>('pendiente');
  const supported = isSupported();
  // Mismo permiso que exige el servidor para registrar el teléfono: el Civil no recibe avisos de
  // proceso, así que ni se intenta (sería un 403 cada vez que abre la app).
  const { hasPermission } = useAuth();
  const recibeAvisos = hasPermission('view_dashboard');

  // El permiso se vuelve a leer CADA VEZ que la app pasa a primer plano, con o sin permiso actual.
  // Quien lo había denegado lo concede desde los ajustes del sistema («Abrir ajustes» en la tarjeta)
  // y vuelve: sin esta relectura la app seguía creyéndolo denegado hasta reiniciarla, y la tarea de
  // fondo no se registraba. También cubre lo contrario: si lo quita allí, la app deja de sincronizar
  // desde primer plano.
  useEffect(() => {
    void getPermission().then(setPermission);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void getPermission().then(setPermission);
    });
    return () => sub.remove();
  }, []);

  // Con permiso concedido: registrar la tarea periódica y sincronizar ya, para no esperar a que
  // Android decida ejecutarla por primera vez.
  useEffect(() => {
    if (permission !== 'granted') return;
    void registerBackgroundSync();
    void syncNotificationsToDevice();
  }, [permission]);

  // PUSH: con permiso y sesión, registrar este teléfono para que el servidor le empuje los avisos al
  // instante. Se vuelve a registrar cada vez que la app pasa a primer plano —es barato y mantiene al
  // día la marca que lee la consulta de respaldo— y cuando FCM rota el token. Si el registro falla, la
  // marca se quita y la consulta de respaldo sigue publicando: el teléfono nunca queda mudo.
  useEffect(() => {
    if (permission !== 'granted' || !recibeAvisos || Platform.OS !== 'android') return;
    let vivo = true;
    const actualizar = (estado: EstadoPush): void => {
      if (vivo) setPush(estado);
    };
    void registrarPush().then(actualizar);
    const dejarDeEscuchar = escucharCambiosDeToken(actualizar);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void registrarPush().then(actualizar);
    });
    return () => {
      vivo = false;
      dejarDeEscuchar();
      sub.remove();
    };
  }, [permission, recibeAvisos]);

  // Al volver a primer plano se sincroniza también: es el camino FIABLE. La tarea en segundo plano
  // es "lo mejor posible" y algunos fabricantes no la ejecutan nunca; esto garantiza que, al menos
  // cuando la persona abre la app, el panel refleje lo que hay.
  useEffect(() => {
    if (permission !== 'granted') return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncNotificationsToDevice();
    });
    return () => sub.remove();
  }, [permission]);

  // En WEB no hay tarea en segundo plano —WorkManager no existe y el equivalente exige una PWA
  // instalada—, así que la pestaña abierta es el único canal. Sin esto, quien deja la web abierta en
  // otra pestaña no recibía nada hasta volver a mirarla, que es justo cuando ya no hace falta.
  useEffect(() => {
    if (permission !== 'granted' || Platform.OS !== 'web') return;
    const id = setInterval(() => void syncNotificationsToDevice(), WEB_POLL_MS);
    return () => clearInterval(id);
  }, [permission]);

  /**
   * Que tocar el aviso de actualización lleve DIRECTO a la descarga.
   *
   * Sin esto, tocarlo solo abre la app y hay que encontrar el banner: tres pasos para algo que
   * debería ser uno. Actúa **solo** sobre el aviso de actualización (`UPDATE_TAG`) — los avisos de
   * planta siguen comportándose igual, abriendo la app sin más.
   *
   * Se atienden DOS caminos, y el segundo es el que se olvida: el listener solo capta el toque si el
   * proceso está vivo. Si Android había matado la app, el toque la arranca en frío y ese evento ya
   * pasó — `getLastNotificationResponseAsync()` lo recupera. Sin él, tocar el aviso con la app
   * cerrada no haría nada, que es justo el caso más probable en un aviso que llega horas después.
   *
   * En web no hace falta: el destino va colgado de la propia notificación al crearla
   * (`presentNotification`), porque la API del navegador no tiene manejador global.
   */
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let vivo = true;
    let quitar: (() => void) | undefined;

    const abrirSiEsActualizacion = (datos: unknown, id: string): void => {
      if (toquesAtendidos.has(id)) return;
      const d = (datos ?? {}) as Record<string, unknown>;
      if (d.tag !== UPDATE_TAG) return;
      toquesAtendidos.add(id);
      if (typeof d.downloadUrl === 'string') void Linking.openURL(d.downloadUrl);
    };

    void (async () => {
      try {
        const Notifications = await import('expo-notifications');
        if (!vivo) return;

        // 1) Arranque en frío: el toque que abrió la app.
        const ultima = await Notifications.getLastNotificationResponseAsync();
        if (vivo && ultima) {
          abrirSiEsActualizacion(
            ultima.notification.request.content.data,
            ultima.notification.request.identifier,
          );
        }

        // 2) App viva: los toques que lleguen a partir de ahora.
        const sub = Notifications.addNotificationResponseReceivedListener((r) => {
          abrirSiEsActualizacion(r.notification.request.content.data, r.notification.request.identifier);
        });
        quitar = () => sub.remove();
      } catch {
        /* sin el módulo nativo el toque solo abre la app: se pierde el atajo, nada más */
      }
    })();

    return () => {
      vivo = false;
      quitar?.();
    };
  }, []);

  const ask = useCallback(async () => {
    setPermission(await requestPermission());
  }, []);

  const probar = useCallback(() => probarPush(), []);

  return { supported, reason: unsupportedReason(), permission, ask, push, probar };
}
