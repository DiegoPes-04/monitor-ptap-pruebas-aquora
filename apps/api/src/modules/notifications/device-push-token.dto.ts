import { z } from 'zod';

/**
 * Token de FCM tal como lo entrega el teléfono.
 *
 * Solo ASCII imprimible y sin espacios, hasta 512: es lo que admite la columna (`ascii_bin`). Fuera de
 * eso MySQL rechazaría el INSERT con un 500; mejor un 400 que diga qué falla. No se valida el formato
 * exacto de Google a propósito: lo cambia sin avisar, y quien decide si un token vale es FCM al enviar
 * (y entonces se borra solo).
 */
const token = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x7E]+$/, 'Token de push con caracteres no válidos');

/**
 * Alta de un teléfono para recibir avisos por push.
 *
 * Solo Android: el token que da `getDevicePushTokenAsync()` en iOS es de APNs, no de FCM, y mandarle
 * un mensaje de FCM fallaría siempre. Si algún día hay app de iPhone, entra aquí con su propio camino.
 */
export const registrarDispositivoSchema = z.object({
  token,
  platform: z.literal('android'),
  appVersion: z.string().trim().min(1).max(32).nullish(),
});
export type RegistrarDispositivoDto = z.infer<typeof registrarDispositivoSchema>;

/** Baja de un teléfono (al cerrar sesión). */
export const quitarDispositivoSchema = z.object({ token });
export type QuitarDispositivoDto = z.infer<typeof quitarDispositivoSchema>;
