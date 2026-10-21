import { existsSync, readFileSync } from 'node:fs';
import type { TokenMessage } from 'firebase-admin/messaging';

/**
 * Puerta a Firebase Cloud Messaging. Es el ÚNICO archivo que conoce `firebase-admin`: el resto del
 * envío por push habla con `PushSender`, y los tests le pasan uno falso sin tocar la red.
 */

/** Variable de entorno con la ruta de la clave de cuenta de servicio (JSON) de Firebase. */
export const SERVICE_ACCOUNT_ENV = 'FIREBASE_SERVICE_ACCOUNT_PATH';

/** Lo único que el envío por push necesita de FCM: mandar UN mensaje a UN teléfono. */
export interface PushSender {
  /** Proyecto de Firebase de la clave. Solo para el log. */
  readonly project: string;
  /** Resuelve si FCM aceptó el mensaje. Rechaza con el error de firebase-admin (`code`, `httpResponse`). */
  send(message: TokenMessage): Promise<void>;
}

/** Lo que se usa de firebase-admin. Se inyecta para poder probar el arranque sin cargarlo. */
export interface FirebaseAdminApi {
  initializeApp: typeof import('firebase-admin/app').initializeApp;
  cert: typeof import('firebase-admin/app').cert;
  getMessaging: typeof import('firebase-admin/messaging').getMessaging;
}

/** Donde va el diagnóstico del arranque (en producción, el `Logger` de Nest). */
export interface StartupLog {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Carga PEREZOSA de firebase-admin: solo se ejecuta si hay una clave que usar.
 *
 * Que no se importe arriba del todo es deliberado. Si el paquete no cargara en la VM (una versión de
 * Node que no le guste, un `npm ci` a medias), un import estático tumbaría el backend entero al
 * arrancar —y con él el monitoreo de las plantas— por una función accesoria. Así, lo peor que puede
 * pasar es que el push quede apagado con su motivo en el log.
 */
export async function loadFirebaseAdmin(): Promise<FirebaseAdminApi> {
  const [app, messaging] = await Promise.all([import('firebase-admin/app'), import('firebase-admin/messaging')]);
  return { initializeApp: app.initializeApp, cert: app.cert, getMessaging: messaging.getMessaging };
}

/** Nombre propio de la app de Firebase: no choca con una «default» que algún día cree otra pieza. */
const FIREBASE_APP_NAME = 'aquora-push';

/**
 * Crea el emisor de FCM a partir de la clave de cuenta de servicio, o `null` = push APAGADO.
 *
 * Apagado no es un error: es el estado normal hasta que alguien copia la clave a la VM, y permite
 * desplegar el backend antes de tenerla. Cada motivo se dice en el log con su causa, porque «el push
 * no funciona» sin más obliga a adivinar. NUNCA lanza: un fallo aquí no puede impedir arrancar.
 *
 * Nada del contenido de la clave llega al log. En particular no se reenvía el error de `JSON.parse`:
 * desde Node 20 incluye un trozo del texto que no pudo leer, y en este archivo ese trozo puede ser la
 * clave privada.
 */
export async function createFcmSender(
  path: string | undefined,
  log: StartupLog,
  load: () => Promise<FirebaseAdminApi> = loadFirebaseAdmin,
): Promise<PushSender | null> {
  const file = path?.trim();
  if (!file) {
    log.warn(`push apagado: falta ${SERVICE_ACCOUNT_ENV}`);
    return null;
  }
  if (!existsSync(file)) {
    log.warn(`push apagado: no existe el archivo de ${SERVICE_ACCOUNT_ENV} (${file})`);
    return null;
  }

  let account: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    account = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    log.error(`push apagado: ${file} no se pudo leer como JSON (¿es la clave de cuenta de servicio?)`);
    return null;
  }

  const projectId = account.project_id;
  const clientEmail = account.client_email;
  const privateKey = account.private_key;
  if (typeof projectId !== 'string' || !projectId || typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
    log.error(
      `push apagado: ${file} no es una clave de cuenta de servicio de Firebase (faltan project_id, client_email o private_key)`,
    );
    return null;
  }

  try {
    const admin = await load();
    const app = admin.initializeApp(
      { credential: admin.cert({ projectId, clientEmail, privateKey }), projectId },
      FIREBASE_APP_NAME,
    );
    const messaging = admin.getMessaging(app);
    log.log(`push FCM activo (proyecto ${projectId})`);
    return {
      project: projectId,
      send: async (message) => {
        await messaging.send(message);
      },
    };
  } catch (err) {
    log.error(`push apagado: no se pudo iniciar firebase-admin: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
