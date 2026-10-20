import { classifyBridge } from '@ptap/shared';
import Colors from '../constants/colors';
import type { LivenessState } from './api';

/**
 * Cómo se PRESENTA el estado de conexión de una planta: el badge inferior del tablero y de
 * electroválvulas, el veredicto de la vista Civil y si el banner anuncia un corte del PLC.
 *
 * Vive aquí, y no dentro de cada componente, porque las tres piezas tienen que decir lo mismo de la
 * misma planta, y porque es lógica pura que se puede probar sin React.
 *
 * **Planta en integración** (`integrationPending`, del backend). Una planta dada de alta en el mapping
 * sin un solo buffer —Cabuyo, La Luisa, La Leonera y Gloria desde el 2026-10-19— está en `frozen` desde
 * el arranque, porque no le llega nada. Con solo eso, la app pintaba «CONGELADO · SIN CONEXIÓN» en
 * rojo y el Civil leía «Reintentando automáticamente»: quien lo veía entendía una CAÍDA de una planta
 * que todavía no se ha conectado nunca. Para estas plantas no hay rojo, ni «sin conexión», ni
 * «reintentando», ni código PLC-0x: no hay nada caído que reportar. La app no lleva su propia lista de
 * plantas en integración; lo dice el backend, que lo saca del mapping, y deja de decirlo solo el día
 * que se les declaren buffers.
 */

/** Los textos de «en integración», en un solo sitio para que las pantallas no se contradigan. */
export const EN_INTEGRACION = {
  /** Badge inferior. */
  badge: 'EN INTEGRACIÓN',
  titulo: 'Planta en integración',
  /** Tablero: quien lo lee ve lecturas. */
  lecturas: 'Todavía no está conectada al PLC maestro. Sus lecturas aparecerán aquí cuando el integrador la conecte.',
  /** Electroválvulas. */
  valvulas: 'Todavía no está conectada al PLC maestro. Sus válvulas aparecerán aquí cuando el integrador la conecte.',
  /** Vista Civil: no ve lecturas, ve si la planta funciona. */
  civil: 'Todavía no está conectada al PLC maestro. Su estado aparecerá aquí cuando el integrador la conecte.',
} as const;

const LIVENESS: Record<LivenessState, { color: string; label: string }> = {
  live: { color: Colors.success, label: 'EN VIVO' },
  stable: { color: Colors.primaryLight, label: 'ESTABLE' },
  frozen: { color: Colors.danger, label: 'CONGELADO · SIN CONEXIÓN' },
};

/**
 * Color y texto del badge de frescura.
 *
 * Orden: «en integración» primero, porque es un hecho del mapping y no del enlace (su liveness es
 * `frozen` siempre, y no por una caída). Luego la carga inicial, que no debe alarmar en rojo antes
 * del primer dato. Por último, los tres estados de siempre.
 */
export function livenessBadge(
  state: LivenessState,
  opts: { loading?: boolean; integrationPending?: boolean } = {},
): { color: string; label: string } {
  if (opts.integrationPending) return { color: Colors.neutral, label: EN_INTEGRACION.badge };
  if (opts.loading) return { color: Colors.neutral, label: 'CONECTANDO…' };
  return LIVENESS[state];
}

/** Iconos que puede devolver `systemHealth` (todos existen en Ionicons; lo comprueba el typecheck). */
export type HealthIcon = 'construct-outline' | 'close-circle' | 'checkmark-circle' | 'alert-circle' | 'help-circle-outline';

/**
 * Veredicto de "¿el sistema está funcionando?" para la vista Civil — la única pregunta que
 * el Civil necesita responder según la matriz oficial. Combina el estado del PUENTE con la
 * FRESCURA de datos (liveness), porque un puente Connected que ya no recibe datos no está
 * realmente "operativo": está congelado. La paleta es la misma que LiveBadge (coherencia).
 *
 * Una planta en integración va antes que todo: su `frozen` no significa que se haya perdido nada, y
 * el estado del puente es el de las OTRAS plantas, no el suyo.
 *
 * El parámetro se mantiene como `string` a propósito (aunque el DTO ya viene tipado con los 6
 * estados desde @ptap/shared — DEF-08): el `default` cubre cualquier valor inesperado de un
 * backend más nuevo sin romper la pantalla.
 */
export function systemHealth(
  bridgeStatus: string | undefined,
  liveness: LivenessState,
  integrationPending = false,
): { icon: HealthIcon; color: string; title: string; desc: string } {
  if (integrationPending) {
    return { icon: 'construct-outline', color: Colors.neutral, title: EN_INTEGRACION.titulo, desc: EN_INTEGRACION.civil };
  }

  // `frozen` manda sobre todo lo demás: si perdimos la fuente, da igual lo que diga el resto.
  if (liveness === 'frozen') {
    return { icon: 'close-circle', color: Colors.danger, title: 'Sin conexión con la planta', desc: 'No se están recibiendo datos en este momento. Reintentando automáticamente.' };
  }

  switch (bridgeStatus) {
    // Con la sesión sana, `live` y `stable` son AMBOS funcionamiento normal: una planta en
    // régimen estable (tanque a nivel constante) no es una avería y no debe alarmar al Civil.
    case 'Connected':
      return { icon: 'checkmark-circle', color: Colors.success, title: 'Sistema operativo', desc: 'La planta está en funcionamiento y enviando datos.' };
    case 'Recovering':
    case 'Stale':
    case 'Connecting':
      return { icon: 'alert-circle', color: Colors.warning, title: 'Sistema con intermitencias', desc: 'La conexión con la planta es inestable en este momento.' };
    case 'Disconnected':
    case 'Faulted':
      return { icon: 'close-circle', color: Colors.danger, title: 'Sistema fuera de línea', desc: 'No hay conexión con la planta en este momento.' };
    default:
      return { icon: 'help-circle-outline', color: Colors.neutral, title: 'Estado no disponible', desc: 'Aún no se reciben datos de la planta.' };
  }
}

/**
 * Qué corte del lado del SERVIDOR anuncia el banner para esta planta (PLC-01 `route`, PLC-02
 * `master_no_data`), o `null` si ninguno.
 *
 * En una planta en integración nunca hay corte que anunciar: el puente es el del PLC maestro, al que
 * esa planta todavía no está conectada, así que su estado no habla de ella. Un PLC-02 ahí diría que
 * «el equipo dejó de enviar lecturas» de una planta que no ha enviado ninguna. Los avisos del lado del
 * DISPOSITIVO (NET-0x) no pasan por aquí: esos hablan del teléfono, no de la planta.
 */
export function plcFaultForBanner(
  bridgeStatus: string | undefined,
  integrationPending = false,
): 'route' | 'master_no_data' | null {
  if (!bridgeStatus || integrationPending) return null;
  const fault = classifyBridge(bridgeStatus);
  return fault === 'ok' ? null : fault;
}
