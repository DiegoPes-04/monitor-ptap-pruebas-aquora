import { CANAL_AVISOS, CANAL_CRITICAS, type PruebaPushDto } from '@ptap/shared';

/**
 * Reglas del push que no dependen de React Native ni de Expo.
 *
 * Viven aparte, como `notification-pointer.ts`, para poder probarlas con `node --test`: deciden si un
 * aviso sale con banner, si el teléfono deja de publicar por su cuenta y qué se le dice a la persona.
 * Nada de eso se puede dejar a una prueba manual en un teléfono.
 */

/** Cómo se configura un canal de Android, sin los enums de expo-notifications. */
export interface CanalAquora {
  id: string;
  nombre: string;
  descripcion: string;
  /**
   * HIGH es lo mínimo para que Android saque el aviso EMERGENTE (el banner que aparece sobre otras
   * apps). Con DEFAULT —la del canal viejo de avisos— sonaba, pero no se veía.
   */
  importancia: 'HIGH' | 'MAX';
  vibracion: number[];
  /**
   * Pedir saltarse el «no molestar» del sistema. Android solo lo respeta si la persona lo concede en
   * los ajustes del canal; pedirlo no cuesta nada y para un tanque rebosando es lo que se quiere.
   */
  saltarNoMolestar: boolean;
}

/**
 * Los dos canales de Aquora. Los ids salen de `@ptap/shared` porque el backend los nombra en cada
 * push: si no coincidieran, Android publicaría el aviso en un canal de reserva, sin banner.
 *
 * Los dos, visibles en la pantalla de bloqueo (lo pone `device-notifications`): son avisos de planta
 * que hay que poder leer sin desbloquear, no mensajes privados.
 */
export const CANALES_AQUORA: readonly CanalAquora[] = [
  {
    id: CANAL_AVISOS,
    nombre: 'Avisos de planta',
    descripcion: 'Sensores sin refrescar, señales fuera de rango, niveles de tanque y maniobras de válvula.',
    importancia: 'HIGH',
    vibracion: [0, 250, 150, 250],
    saltarNoMolestar: false,
  },
  {
    id: CANAL_CRITICAS,
    nombre: 'Alertas críticas',
    descripcion: 'Tanque rebosando, sin autonomía o planta sin datos. Requieren actuar.',
    importancia: 'MAX',
    // Larga y repetida: tiene que distinguirse de un aviso normal sin mirar la pantalla.
    vibracion: [0, 700, 300, 700, 300, 700],
    saltarNoMolestar: true,
  },
];

/**
 * Canales de las versiones anteriores. Se BORRAN al arrancar: los canales de Android son inmutables,
 * así que la importancia nueva exigió ids nuevos, y sin borrar los viejos aparecerían duplicados en los
 * ajustes del sistema («Avisos de planta» dos veces, uno de ellos muerto).
 */
export const CANALES_RETIRADOS: readonly string[] = ['ptap-alertas', 'ptap-criticas'];

/**
 * En qué quedó el push de este teléfono.
 *  - `activo`: registrado y el servidor empuja. La consulta periódica deja de publicar.
 *  - `servidor-apagado`: registrado, pero el servidor aún no tiene la clave de Firebase.
 *  - `no-disponible`: esta instalación no puede recibir push (web, iPhone, o una APK compilada sin
 *    Firebase). Los avisos llegan por la consulta periódica, como antes.
 *  - `error`: no se pudo registrar ahora (red, servidor). Se reintenta al volver a abrir la app.
 *  - `pendiente`: todavía no se intentó.
 */
export type EstadoPush = 'activo' | 'servidor-apagado' | 'no-disponible' | 'error' | 'pendiente';

/**
 * Lo que dice el servidor al registrar el teléfono, traducido a estado.
 *
 * Solo `pushActivo === true` cuenta como push activo. Cualquier otra respuesta —incluida una rara o
 * de una versión vieja del servidor— deja el teléfono publicando por su cuenta: equivocarse hacia
 * avisar de más es recuperable (Android reemplaza el duplicado por su etiqueta); hacia callar, no.
 */
export function estadoTrasRegistro(respuesta: unknown): EstadoPush {
  const r = respuesta && typeof respuesta === 'object' ? (respuesta as { pushActivo?: unknown }) : {};
  return r.pushActivo === true ? 'activo' : 'servidor-apagado';
}

/**
 * ¿El fallo es que esta APK no trae Firebase? Pasa con una APK compilada sin `google-services.json`:
 * el teléfono no puede tener token de FCM, y no tiene sentido decirle a nadie que «reintente».
 */
export function esFaltaDeFirebase(err: unknown): boolean {
  const texto = err instanceof Error ? err.message : String(err ?? '');
  return /FirebaseApp|google-services|fcm-credentials/i.test(texto);
}

/** Qué se le dice a la persona tras pulsar «Enviar aviso de prueba». */
export function textoDePrueba(r: PruebaPushDto): { tipo: 'success' | 'info' | 'error'; titulo: string; mensaje: string } {
  if (!r.pushActivo) {
    return {
      tipo: 'info',
      titulo: 'El servidor todavía no envía avisos al instante',
      mensaje: 'Mientras tanto, los avisos llegan con la revisión periódica (cada 15 minutos y al abrir la app).',
    };
  }
  if (r.telefonos === 0) {
    return {
      tipo: 'error',
      titulo: 'Este teléfono no está registrado',
      mensaje: 'Cierra la aplicación y vuelve a abrirla con las notificaciones permitidas.',
    };
  }
  if (r.enviados > 0) {
    const varios = r.telefonos > 1 ? ` (a ${r.enviados} de tus ${r.telefonos} teléfonos)` : '';
    return {
      tipo: 'success',
      titulo: 'Aviso de prueba enviado',
      mensaje: `Debería llegar en unos segundos${varios}. Prueba también con la app cerrada y con el teléfono bloqueado.`,
    };
  }
  return {
    tipo: 'error',
    titulo: 'No se pudo enviar el aviso de prueba',
    mensaje: 'Google rechazó el envío. Cierra y vuelve a abrir la aplicación para registrar de nuevo el teléfono.',
  };
}
