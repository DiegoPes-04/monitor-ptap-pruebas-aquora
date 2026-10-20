import { useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchBasicStatus, type PlantBasicStatusDto } from '../services/api';
import {
  getLastBasicStatus,
  lastDataVersion,
  rememberBasicStatus,
  subscribeLastData,
} from '../services/last-snapshot-store';

/** Cada cuánto se refresca el estado básico. No es telemetría de operación: para responder
 *  "¿opera?" y "¿hay agua?" un refresco cada 15 s es de sobra. */
const REFRESH_MS = 15_000;

/**
 * Estado básico de una planta para el rol Civil.
 *
 * A diferencia de `useSnapshot`, esto es **solo REST**: NO abre suscripción a Socket.IO.
 * Es deliberado — el canal `opc:snapshot` empuja el snapshot COMPLETO, así que suscribir
 * al Civil ahí le entregaría por push exactamente los datos detallados que este endpoint
 * evita. Al no suscribirse, esa vía queda cerrada por construcción.
 *
 * RESPALDO (última lectura del dispositivo): si el servidor no responde, o responde sin
 * veredicto de agua (cache RAM vacía tras un reinicio con el PLC caído), se muestra el último
 * veredicto conocido con el liveness forzado a `frozen` — el Civil ve "sin conexión" como
 * estado del sistema, pero conserva la última información de agua en vez de un vacío.
 */
export function useBasicStatus(plantId: string) {
  const storeVersion = useSyncExternalStore(subscribeLastData, lastDataVersion, lastDataVersion);

  const query = useQuery({
    queryKey: ['basic-status', plantId],
    queryFn: async () => {
      const status = await fetchBasicStatus(plantId);
      rememberBasicStatus(status); // ignora respuestas sin veredicto de agua
      return status;
    },
    refetchInterval: REFRESH_MS,
  });

  const data = useMemo<PlantBasicStatusDto | undefined>(() => {
    const fresh = query.data;
    if (fresh && fresh.waterAvailable !== null) return fresh;
    // Planta en integración: sin veredicto de agua porque aún no está conectada. El respaldo le
    // forzaría `frozen` sin el `integrationPending`, y el Civil leería «Sin conexión… Reintentando».
    if (fresh?.integrationPending) return fresh;
    const stored = getLastBasicStatus(plantId);
    if (!stored) return fresh;
    return {
      ...stored,
      // El estado ACTUAL del puente manda si el servidor respondió; el agua es la última conocida.
      bridgeStatus: fresh?.bridgeStatus ?? stored.bridgeStatus,
      liveness: { ...stored.liveness, state: 'frozen' },
    };
    // storeVersion: getLastBasicStatus lee estado EXTERNO al render; la versión es la señal de
    // que ese estado cambió (hidratación async del storage). El linter no puede saberlo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, plantId, storeVersion]);

  return { ...query, data };
}
