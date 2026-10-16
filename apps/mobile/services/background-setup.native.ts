import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import { ensureAndroidChannel } from './device-notifications';
import { syncNotificationsToDevice, TASK_NAME } from './notification-sync';
import { restaurarTokenDeSesion } from './session-store';

/**
 * Arranque GLOBAL de las notificaciones nativas. Se importa desde `index.js`, antes que Expo Router,
 * y todo lo de aquí corre al cargar el bundle: no hay componentes ni hooks de por medio.
 *
 * Tiene que ser así porque WorkManager, cuando despierta la app con el proceso muerto, carga el
 * bundle pero NO monta React. Antes la tarea se definía dentro de un `useEffect`
 * (`registerBackgroundSync`) y en ese arranque sin interfaz no llegaba a existir: Expo no
 * encontraba qué ejecutar y acababa desregistrándola. Es el requisito que pone
 * `TaskManager.defineTask`: ámbito global del bundle, nunca un ciclo de vida de React.
 *
 * Solo nativo. La variante web (`background-setup.ts`) está vacía: en web no hay WorkManager y
 * `expo-notifications` no funciona, así que Metro elige ese archivo y este no entra en el bundle.
 */

// Sin manejador, Expo NO muestra la notificación cuando la app está en primer plano: se publicaba,
// pero no salía ni banner ni entrada en el panel. `shouldPlaySound` va en true también por Android,
// donde en false el aviso emergente no aparece aunque el canal lo permita.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Los canales, desde el arranque y no al publicar el primer aviso: así existen (y aparecen en los
// ajustes del sistema) aunque todavía no haya llegado nada. Un fallo aquí no puede tumbar la carga
// del bundle; `notification-sync` los vuelve a asegurar antes de publicar.
void ensureAndroidChannel().catch(() => {
  /* se reintenta en la próxima sincronización */
});

TaskManager.defineTask(TASK_NAME, async () => {
  try {
    // En un proceso despertado por WorkManager no hay `AuthContext` y el token en memoria es null:
    // sin esto, la consulta a la bandeja recibía un 401 en cada ciclo. Sin sesión válida (nadie
    // entró, o pasaron las 8 h) no hay nada que consultar, y eso es un ciclo correcto, no un fallo.
    if (!(await restaurarTokenDeSesion())) return BackgroundTask.BackgroundTaskResult.Success;

    await syncNotificationsToDevice();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});
