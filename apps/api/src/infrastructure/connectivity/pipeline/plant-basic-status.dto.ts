import type { PlantBasicStatusDto } from '@ptap/shared';
import type { PlantSnapshotDto } from './plant-snapshot.dto';

/**
 * Vista MÍNIMA de una planta para el rol Civil: exactamente las dos preguntas que la matriz
 * oficial le concede ("¿el sistema funciona?" y "¿hay agua disponible?"), y nada más.
 *
 * Es una whitelist deliberada, no un snapshot recortado: aquí NO viaja `signals`, así que el
 * dispositivo del Civil nunca recibe caudales, presiones ni estados de válvula. Añadir campos
 * a este DTO es una decisión de producto (¿puede el Civil ver esto?), no un detalle técnico.
 *
 * DEF-08: el tipo vive en @ptap/shared (fuente única backend↔móvil); aquí queda la LÓGICA
 * de proyección y se re-exporta el tipo para los consumidores del pipeline.
 */
export type { PlantBasicStatusDto } from '@ptap/shared';

/**
 * Cota (m) bajo la cual un tanque se considera prácticamente vacío. Umbral operativo
 * provisional: sin la capacidad real confirmada del tanque no se puede juzgar "nivel bajo"
 * en porcentaje. Vivía en la pantalla del Civil; al derivarse el veredicto aquí, este es
 * ahora su único lugar.
 */
const EMPTY_LEVEL_M = 0.2;

/** Nivel de tanque PROPIO de la planta (`tank1Level`, `tank2Level`, …). Los tanques de otras
 *  plantas retransmitidos usan claves con nombre propio (`sanAntonioTankLevel`), así que este
 *  patrón los excluye por construcción: no deciden el agua de la planta portadora. */
const OWN_TANK_LEVEL = /^tank\d+Level$/;

/**
 * Hay agua si TODOS los tanques propios con lectura numérica superan la cota de vacío.
 * Sin lecturas de tanque devuelve null — el Civil verá "sin datos", nunca un falso "hay agua".
 */
function waterAvailability(snapshot: PlantSnapshotDto): boolean | null {
  const levels = Object.entries(snapshot.signals)
    .filter(([domainKey]) => OWN_TANK_LEVEL.test(domainKey))
    .map(([, signal]) => signal.value)
    .filter((value): value is number => typeof value === 'number');

  if (levels.length === 0) return null;
  return levels.every((levelM) => levelM > EMPTY_LEVEL_M);
}

/** Proyecta el snapshot de dominio a la vista básica. El snapshot completo NUNCA sale de aquí. */
export function toBasicStatus(snapshot: PlantSnapshotDto): PlantBasicStatusDto {
  return {
    plantId: snapshot.plantId,
    displayName: snapshot.displayName,
    bridgeStatus: snapshot.bridgeStatus,
    liveness: snapshot.liveness,
    waterAvailable: waterAvailability(snapshot),
    // Entra en la whitelist a propósito: no es una lectura, es la razón de que no haya ninguna. Sin
    // él, el Civil leía «Sin conexión… Reintentando» en una planta que aún no se ha conectado nunca.
    ...(snapshot.integrationPending ? { integrationPending: true as const } : {}),
  };
}
