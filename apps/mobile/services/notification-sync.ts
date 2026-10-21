import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { cuerpoDeAviso, debeSonar, ETIQUETA_RESUMEN, etiquetaDeAviso, resumenDeAvisos } from '@ptap/shared';
import { fetchNotifications, type AppNotification } from './notifications';
import { ensureAndroidChannel, getPermission, presentNotification } from './device-notifications';
import { getNotificationPrefs, loadNotificationPrefs } from './notification-prefs';
import { fetchAppRelease, runningVersionCode } from './app-release';
import { decidirAvisoActualizacion } from './app-release-compare';
import { punteroConPush, siguientePuntero } from './notification-pointer';
import { pushActivo } from './push-registration';

/**
 * Lleva los avisos del servidor al panel de notificaciones del dispositivo.
 *
 * **Es el RESPALDO del push.** Desde la 1.4.0 el servidor empuja cada aviso por FCM en cuanto lo
 * guarda y Android lo muestra aunque la app esté cerrada (`push-registration.ts`). Con el push activo,
 * esto solo avanza el puntero, sin publicar: el aviso ya sonó. Sin push —una APK sin Firebase, el
 * servidor sin clave, un fallo al registrar— todo funciona como antes, y lo de abajo sigue valiendo:
 *
 * El dispositivo pregunta cada ~15 min y levanta la notificación por su cuenta
 * (`expo-background-task`, que por debajo usa WorkManager en Android). La entrega es **"lo mejor
 * posible"**: Android agrupa y retrasa estas tareas, y algunos fabricantes (Xiaomi, Huawei) matan
 * el proceso de forma agresiva. Para un aviso diario de "este sensor lleva días caído" es
 * suficiente; para una alarma de seguridad en segundos NO lo sería, y para eso está el push.
 *
 * La tarea NO se define aquí sino en `background-setup.native.ts`, al cargar el bundle: cuando
 * WorkManager despierta un proceso muerto no se monta React, y una tarea definida desde un hook no
 * existiría en ese momento. Aquí solo se registra (`registerBackgroundSync`) y se sincroniza.
 *
 * Idempotencia: se recuerda hasta qué id ya se anunció (`ptap_last_notified_id`). Un aviso solo
 * salta al panel una vez, aunque la tarea corra veinte veces con él en la lista. El puntero avanza
 * DESPUÉS de publicar y solo sobre lo resuelto —publicado de verdad o aplazado—; se detiene antes
 * del primer aviso que no pudo publicarse, que se reintenta en el ciclo siguiente. Ver
 * `notification-pointer.ts`. Sin permiso del sistema no se publica nada y el puntero salta al final.
 *
 * **Aquí se decide qué SUENA, no qué existe.** La bandeja y la campana las sirve el servidor sin
 * filtrar: lo silenciado sigue estando ahí. Lo que se aplica en este punto son las preferencias del
 * usuario —tipos y señales callados, gravedad mínima y franja de «no molestar»—, porque dependen
 * del reloj de este teléfono y porque el silencio no debe borrarle el historial a nadie.
 *
 * Las maniobras de válvula atraviesan todo eso: son el registro que sustituye a la confirmación
 * eléctrica que estas plantas no dan, y no se pueden callar.
 */

/** Nombre de la tarea periódica. Lo comparten la definición (`background-setup.native.ts`) y el registro. */
export const TASK_NAME = 'ptap-notification-sync';
const LAST_NOTIFIED_KEY = 'ptap_last_notified_id';
/** Avisos que tocaron durante el "no molestar" y aún no han sonado. */
const DEFERRED_KEY = 'ptap_deferred_notifications';
/** Último `versionCode` del que ya se avisó en el panel. Ver `avisarSiHayActualizacion`. */
const UPDATE_NOTIFIED_KEY = 'ptap_last_update_notified';
/** Marca que llevan los datos del aviso de actualización, para reconocerlo al tocarlo. */
export const UPDATE_TAG = 'app-update';
/** Tope de diferidos que se arrastran. Una noche entera de avisos no puede crecer sin límite. */
const MAX_DIFERIDOS = 30;
/** Mínimo que Android respeta de verdad; pedir menos no lo acelera. */
const INTERVAL_MINUTES = 15;

async function lastNotifiedId(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(LAST_NOTIFIED_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function rememberNotifiedId(id: number): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_NOTIFIED_KEY, String(id));
  } catch {
    /* si el storage falla, a lo sumo se repite un aviso */
  }
}

async function diferidos(): Promise<number[]> {
  try {
    const raw = await AsyncStorage.getItem(DEFERRED_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

async function recordarDiferidos(ids: number[]): Promise<void> {
  try {
    await AsyncStorage.setItem(DEFERRED_KEY, JSON.stringify(ids.slice(-MAX_DIFERIDOS)));
  } catch {
    /* si el storage falla, a lo sumo un aviso diferido no vuelve a intentarse */
  }
}

/**
 * Avisa en el panel del teléfono de que hay una versión nueva de la app.
 *
 * Existe porque el aviso de actualización solo vivía DENTRO de la app, y quien no la abre es
 * precisamente quien más desactualizado está: sin tienda ni `expo-updates`, no había forma de
 * alcanzarle. Esto le llega al panel como cualquier otro aviso.
 *
 * **Va por el canal normal, no el crítico.** Una actualización disponible no es un tanque
 * rebosando: el canal crítico es persistente y suena a las cuatro de la mañana.
 *
 * **No se le aplican las preferencias de silencio ni el «no molestar».** Esas son preferencias
 * sobre avisos DE PLANTA (`NotificationKind`), y esto no es uno: es un aviso sobre la propia
 * aplicación. El permiso del sistema sí se respeta — lo comprueba `presentNotification` por dentro.
 *
 * Devuelve 1 si avisó, 0 si no. Nunca lanza: que no se pueda saber si hay actualización no puede
 * tumbar el barrido de avisos de planta, que es lo que de verdad importa.
 */
async function avisarSiHayActualizacion(): Promise<number> {
  try {
    const [release, ultimo] = await Promise.all([fetchAppRelease(), ultimoAvisoActualizacion()]);
    const aviso = decidirAvisoActualizacion(release, runningVersionCode(), ultimo);
    if (!aviso) return 0;

    await ensureAndroidChannel();
    const publicado = await presentNotification(aviso.titulo, aviso.cuerpo, {
      tag: UPDATE_TAG,
      downloadUrl: aviso.downloadUrl,
    });
    // Solo se recuerda lo que de verdad salió al panel. `presentNotification` no lanza: sin permiso
    // o con un fallo del sistema devuelve false, y antes eso bastaba para dar la versión por
    // anunciada sin que nadie la hubiera visto. Así, el próximo ciclo reintenta.
    if (!publicado) return 0;
    await recordarAvisoActualizacion(aviso.versionCode);
    return 1;
  } catch {
    return 0;
  }
}

async function ultimoAvisoActualizacion(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(UPDATE_NOTIFIED_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function recordarAvisoActualizacion(versionCode: number): Promise<void> {
  try {
    await AsyncStorage.setItem(UPDATE_NOTIFIED_KEY, String(versionCode));
  } catch {
    /* si el storage falla, a lo sumo el aviso se repite en el próximo ciclo */
  }
}

/**
 * Sincronización en curso, compartida por quien llame mientras dure.
 *
 * El hook `useDeviceNotifications` se monta dos veces (la franja de permiso de la cáscara y la
 * tarjeta de Ajustes) y las dos lanzaban la sincronización a la vez: ambas leían el mismo puntero
 * antes de que ninguna lo guardara, así que podían publicar los mismos avisos dos veces. A nivel de
 * módulo para que lo compartan todos los llamadores de este proceso, incluida la tarea de fondo si
 * la app está viva.
 */
let enCurso: Promise<number> | null = null;

/**
 * Consulta la bandeja y lleva al panel lo que sea nuevo. Devuelve cuántos avisos mostró.
 *
 * Se exporta aparte de la tarea porque también se llama con la app abierta (al volver a primer
 * plano): así el aviso aparece aunque Android nunca llegue a ejecutar la tarea en segundo plano.
 *
 * Una sola a la vez: si ya hay una en marcha, se devuelve esa misma promesa en vez de empezar otra.
 */
export function syncNotificationsToDevice(): Promise<number> {
  if (enCurso) return enCurso;
  enCurso = sincronizar().finally(() => {
    enCurso = null;
  });
  return enCurso;
}

async function sincronizar(): Promise<number> {
  // El permiso se mira ANTES que nada, porque sin él no se puede publicar y el puntero no podría
  // avanzar nunca: todo lo acumulado mientras tanto saldría de golpe el día que se concediera. Ver
  // la rama `!conPermiso` más abajo.
  const conPermiso = (await getPermission()) === 'granted';

  // La actualización se comprueba PRIMERO y por separado: es independiente de los avisos de planta
  // y no comparte ni su idempotencia ni sus preferencias de silencio. Va con su propio try/catch
  // dentro, así que si el endpoint de versión falla, lo de abajo sigue igual. Sin permiso no se
  // intenta: no recordaría la versión, y avisará de ella en cuanto se conceda.
  const avisosActualizacion = conPermiso ? await avisarSiHayActualizacion() : 0;

  const [previo, pendientes] = await Promise.all([lastNotifiedId(), diferidos()]);
  const [{ notifications }] = await Promise.all([fetchNotifications(), loadNotificationPrefs()]);
  const prefs = getNotificationPrefs();

  // Solo lo NO VISTO y más nuevo que lo ya anunciado, MÁS lo que quedó pendiente de una franja de
  // silencio anterior. Orden ascendente para que, si hay varios, el más reciente quede arriba.
  const candidatos = notifications
    .filter((n) => !n.seen && (n.id > previo || pendientes.includes(n.id)))
    .sort((a, b) => a.id - b.id);

  // SIN PERMISO: nada puede salir al panel, así que lo que llega mientras tanto se da por pasado y el
  // puntero salta hasta el último candidato. Si no, el día que el permiso se conceda (o se recupere
  // tras quitarlo en los ajustes) saldrían de golpe días de avisos viejos.
  //
  // La lista de diferidos se deja COMO ESTÁ, a propósito: lo que contiene se aplazó cuando sí había
  // permiso —una franja de «no molestar», un tipo silenciado— y no es lo acumulado a ciegas que se
  // quiere evitar. Ya está acotada (MAX_DIFERIDOS) y lo que se haya visto en la bandeja cae solo
  // por el filtro `!n.seen`.
  if (!conPermiso) {
    const tope = Math.max(previo, ...candidatos.map((n) => n.id));
    if (tope > previo) await rememberNotifiedId(tope);
    return 0;
  }

  // CON PUSH: cada aviso ya lo mostró Android cuando el servidor lo empujó, con las preferencias de
  // esta persona aplicadas allí. Publicarlo aquí otra vez lo haría sonar dos veces. Solo se avanza el
  // puntero —si el push se corta, la consulta retoma desde aquí sin soltar días de avisos viejos— y se
  // vacía la lista de diferidos: con push, lo que cae en el «no molestar» se queda en la bandeja y nadie
  // lo vuelve a sonar después, igual que decide el servidor.
  if (await pushActivo()) {
    const tope = punteroConPush(previo, candidatos.map((n) => n.id));
    await Promise.all([
      tope > previo ? rememberNotifiedId(tope) : Promise.resolve(),
      pendientes.length > 0 ? recordarDiferidos([]) : Promise.resolve(),
    ]);
    return avisosActualizacion;
  }

  // El "no molestar" no oculta nada: aplaza. Lo crítico lo atraviesa —un tanque rebosando suena a
  // las cuatro de la mañana— y el resto espera a que termine la franja, sin perderse por el camino.
  const ahora = new Date();
  const suena = (n: AppNotification): boolean => debeSonar(n, prefs, ahora);
  const nuevos = candidatos.filter(suena);
  const aplazados = candidatos.filter((n) => !suena(n)).map((n) => n.id);

  // Ids que de verdad llegaron al panel. El puntero se calcula con esto, DESPUÉS de publicar: antes
  // avanzaba primero, y un aviso que no lograba publicarse quedaba dado por anunciado para siempre.
  const publicados: number[] = [];

  if (nuevos.length > 0) {
    await ensureAndroidChannel();

    // LO CRÍTICO NUNCA SE RESUME. Antes, tres avisos de golpe se colapsaban en «3 avisos nuevos» sin
    // severidad ni planta, y un tanque rebosando se leía igual que tres sensores parados. Ahora lo
    // crítico sale siempre con su título completo, por el canal de importancia máxima y persistente;
    // solo se agrupa el resto.
    const criticos = nuevos.filter((n) => n.severity === 'critical');
    const resto = nuevos.filter((n) => n.severity !== 'critical');

    // Título, texto y etiqueta salen de `@ptap/shared`, los mismos que usa el push del servidor: un
    // aviso se lee igual llegue por donde llegue, y la etiqueta `n-<id>` hace que uno reemplace al otro.
    for (const n of criticos) {
      const ok = await presentNotification(
        n.title,
        cuerpoDeAviso(n),
        { tag: etiquetaDeAviso(n.id), plantId: n.plantId, subject: n.subject },
        true,
      );
      if (ok) publicados.push(n.id);
    }

    // Más de dos avisos de golpe se resumen: llenar el panel con doce tarjetas es peor que una. El
    // resumen cubre TODO `resto`: si sale, todos quedan anunciados; si falla, ninguno.
    if (resto.length > 2) {
      const { titulo, cuerpo } = resumenDeAvisos(resto);
      const ok = await presentNotification(titulo, cuerpo, { tag: ETIQUETA_RESUMEN });
      if (ok) publicados.push(...resto.map((n) => n.id));
    } else {
      for (const n of resto) {
        const ok = await presentNotification(n.title, cuerpoDeAviso(n), {
          tag: etiquetaDeAviso(n.id),
          plantId: n.plantId,
          subject: n.subject,
        });
        if (ok) publicados.push(n.id);
      }
    }
  }

  // El puntero avanza también con la franja activa: lo aplazado se recuerda aparte, así no se
  // re-anuncia cada quince minutos lo que ya sonó. Pero se detiene antes del primer aviso que no
  // pudo publicarse (`siguientePuntero`), para reintentarlo en el ciclo siguiente.
  const ids = candidatos.map((n) => n.id);
  const resueltos = new Set([...aplazados, ...publicados]);
  const puntero = siguientePuntero(previo, ids, resueltos);

  // Un diferido de una franja anterior (id por debajo del puntero) que ahora tocaba sonar pero no se
  // pudo publicar no tiene puntero que lo traiga de vuelta: se mantiene en la lista de diferidos para
  // reintentarlo, en vez de perderlo por el camino.
  const fallidosYaPasados = ids.filter((id) => id <= puntero && !resueltos.has(id));

  await Promise.all([
    recordarDiferidos([...aplazados, ...fallidosYaPasados]),
    puntero > previo ? rememberNotifiedId(puntero) : Promise.resolve(),
  ]);

  return publicados.length + avisosActualizacion;
}

/**
 * Registra la tarea periódica. Solo en nativo: en web no existe WorkManager, y el equivalente
 * (Periodic Background Sync) exige una PWA instalada y solo lo admite Chromium — la web recibe
 * sus avisos mientras la pestaña está abierta, vía `syncNotificationsToDevice()`.
 *
 * Solo REGISTRA: la definición vive en `background-setup.native.ts`, que se ejecuta al cargar el
 * bundle. Si al llegar aquí la tarea no está definida, ese arranque falló y no se registra nada:
 * WorkManager despertaría un proceso que no sabe qué ejecutar y Expo acabaría desregistrándola.
 *
 * Silencioso ante fallos: que no se pueda registrar la tarea no debe impedir arrancar la app.
 */
export async function registerBackgroundSync(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const TaskManager = await import('expo-task-manager');
    const BackgroundTask = await import('expo-background-task');

    if (!TaskManager.isTaskDefined(TASK_NAME)) return false;

    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return false;

    await BackgroundTask.registerTaskAsync(TASK_NAME, { minimumInterval: INTERVAL_MINUTES });
    return true;
  } catch {
    return false;
  }
}
