// Config dinámica de Expo. Hereda TODO lo estático de app.json (Expo lo carga y lo pasa como
// `config`) y añade lo que depende del BUILD:
//
//  1. extra.apiBaseUrl — la URL del backend, horneada desde la variable de entorno API_BASE_URL.
//     services/api.ts la lee con Constants.expoConfig.extra.apiBaseUrl. Para la APK se construye
//     con API_BASE_URL=https://<tunnel>.trycloudflare.com (Cloudflare Tunnel al backend local).
//     Sin la variable (dev) cae a localhost. Es una URL pública, NO un secreto.
//
//  2. expo-build-properties — endurecimiento + optimización del release Android:
//     - usesCleartextTraffic:false → prohíbe HTTP en claro (todo va por HTTPS; cierra fugas de red).
//     - ProGuard/R8 + shrinkResources → APK más pequeño y ofuscado.
//     - buildArchs: solo arm64-v8a. Es lo que decide si el APK pesa 35 MB o 92 (ver el comentario
//       largo abajo). No se puede dejar en android/gradle.properties: el prebuild lo regenera.
//     - min/target SDK explícitos.
//
//  3. android.permissions acotado al mínimo. Desde el 2026-08 se añaden dos, y solo dos, por los
//     avisos de sensor averiado en el panel de notificaciones:
//       - POST_NOTIFICATIONS: obligatorio desde Android 13 (API 33) para poder mostrar cualquier
//         notificación. Sin él el sistema las descarta en silencio.
//       - VIBRATE: estaba BLOQUEADO explícitamente; se desbloquea porque una notificación sin
//         vibración pasa desapercibida justo en el caso que importa (una planta caída).
//     RECEIVE_BOOT_COMPLETED lo añade `expo-background-task` por su cuenta: es lo que permite que
//     la tarea periódica siga programada tras reiniciar el teléfono.
//
//  4. android.googleServicesFile — la configuración de Firebase (FCM) para los avisos al instante
//     por push, desde la 1.4.0. Va DENTRO de la APK: sin ella el teléfono no puede tener token de
//     FCM. Solo se declara si `google-services.json` existe junto a este archivo: no está en el repo
//     (.gitignore; se copia a mano antes de compilar la APK), y declararlo sin el archivo rompería
//     cualquier otra compilación —la web, un prebuild en otra máquina—. Una APK compilada sin él
//     funciona igual, sin push: los avisos llegan por la consulta periódica de respaldo.
const fs = require('fs');
const path = require('path');

const GOOGLE_SERVICES = path.join(__dirname, 'google-services.json');

module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    apiBaseUrl: process.env.API_BASE_URL ?? 'http://localhost:4000',
  },
  android: {
    ...config.android,
    ...(fs.existsSync(GOOGLE_SERVICES) ? { googleServicesFile: './google-services.json' } : {}),
    permissions: ['INTERNET', 'POST_NOTIFICATIONS', 'VIBRATE'],
    // La plantilla base de Expo agrega permisos "opcionales" al manifest y `permissions` solo
    // AGREGA, nunca los quita — hay que bloquearlos explícitamente (tools:node="remove").
    blockedPermissions: [
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
    ],
  },
  plugins: [
    ...(config.plugins ?? []),
    'expo-notifications',
    'expo-background-task',
    [
      'expo-build-properties',
      {
        android: {
          usesCleartextTraffic: false,
          enableProguardInReleaseBuilds: true,
          enableShrinkResources: true,
          // SOLO arm64. Sin esto el APK pesa 92 MB en vez de 35: el prebuild deja el valor por
          // defecto de React Native (armeabi-v7a, arm64-v8a, x86, x86_64) y las cuatro ABIs suman
          // 72 MB de librerias nativas, de las cuales x86 y x86_64 (40 MB) solo sirven para
          // emuladores. Nadie instala esto en un emulador.
          //
          // Va AQUI y no en android/gradle.properties porque ese archivo lo REGENERA
          // `expo prebuild --clean` y no esta versionado (android/ es gitignored): el ajuste vivia
          // ahi, se perdio en el prebuild del 2026-08-25 y el APK triplico de tamano sin que nada
          // avisara. Declarado en la config, sobrevive a cualquier regeneracion.
          //
          // arm64-v8a es lo que ya se venia sirviendo y funciona en toda la flota. Si alguna vez
          // hay un telefono de 32 bits (Android 7-8 de gama baja), habria que sumar 'armeabi-v7a'
          // (+13 MB); hasta entonces seria peso muerto para todos.
          buildArchs: ['arm64-v8a'],
          minSdkVersion: 24,
          compileSdkVersion: 36,
          targetSdkVersion: 36,
        },
      },
    ],
  ],
});
