/**
 * Variante WEB del arranque de notificaciones: vacía a propósito.
 *
 * La de verdad es `background-setup.native.ts` (manejador de notificaciones, canales de Android y
 * definición de la tarea de fondo). En web no hay WorkManager y `expo-notifications` no funciona,
 * así que no hay nada que preparar; la pestaña abierta sincroniza por su cuenta desde
 * `useDeviceNotifications`. Metro elige este archivo para web por la extensión de plataforma, y así
 * ningún módulo nativo entra en el bundle web.
 */
export {};
