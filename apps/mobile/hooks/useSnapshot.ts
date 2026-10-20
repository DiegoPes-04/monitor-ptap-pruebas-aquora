import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSnapshot, type PlantSnapshotDto } from '../services/api';
import { joinPlantStream } from '../services/plant-stream';
import {
  getLastSnapshot,
  lastDataVersion,
  rememberSnapshot,
  subscribeLastData,
} from '../services/last-snapshot-store';

/**
 * Snapshot de una planta en tiempo real:
 *  - Carga inicial por REST (desde cache RAM del backend).
 *  - Push por Socket.IO (opc:snapshot) en cada cambio; opc:liveness parchea el estado.
 *  - sequence: si se detecta un HUECO (llega N+2 sin ver N+1), se re-sincroniza por REST.
 *  - RESPALDO: cada lectura real se recuerda en el dispositivo; si la conexión se cae (o el
 *    backend se reinició con el PLC caído y su cache RAM nació vacía), `data` entrega la última
 *    lectura conocida SIEMPRE marcada `frozen` — se ven los últimos valores, nunca pantalla vacía,
 *    y nunca un dato viejo aparentando frescura.
 */
export function useSnapshot(plantId: string, enabled = true) {
  const queryClient = useQueryClient();
  const queryKey = ['snapshot', plantId];
  const lastSeq = useRef<number>(0);
  /** true si el push por Socket.IO no está disponible → hay que refrescar por REST para no quedarse
   *  con un dato viejo (sin mentir diciendo que la planta está congelada). */
  const [socketDown, setSocketDown] = useState(false);
  // Re-lee el respaldo cuando la hidratación del storage termina (nativo llega async).
  const storeVersion = useSyncExternalStore(subscribeLastData, lastDataVersion, lastDataVersion);

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const snapshot = await fetchSnapshot(plantId);
      rememberSnapshot(snapshot); // ignora respuestas de espera sin señales
      return snapshot;
    },
    staleTime: Infinity, // el push mantiene el dato fresco; no re-fetch por tiempo
    // Normalmente sin poll (el push mantiene fresco y evita duplicar el socket). Se activa solo en
    // dos casos: si la carga REST falló (para que el banner "servidor caído" se despegue solo), o si
    // el socket está caído (sin push, el REST es la única forma de no mostrar un dato viejo).
    refetchInterval: (query) => (query.state.status === 'error' ? 5000 : socketDown ? 10000 : false),
    // `enabled=false` para roles sin view_dashboard (Civil): NO se pide el snapshot detallado
    // (el backend responde 403) NI se abre la suscripción de socket (el gateway aún no valida
    // permisos por planta, así que suscribir al Civil filtraría datos que su rol no debe ver).
    enabled,
  });

  useEffect(() => {
    if (!enabled) return; // Civil: nunca se suscribe al socket de la planta (evita fuga de datos)
    lastSeq.current = 0;
    // Stream COMPARTIDO: aunque varios hooks pidan la misma planta (la cáscara de pestañas vía
    // dos pantallas a la vez), solo se abre UNA suscripción real. Ver `plant-stream.ts`.
    const unsubscribe = joinPlantStream(plantId, {
      onSnapshot: (snapshot: PlantSnapshotDto) => {
        if (lastSeq.current > 0) {
          // Hueco (perdimos un snapshot intermedio) o REINICIO del backend (sequence volvió atrás,
          // p.ej. 500 → 1): en ambos casos re-sincronizar por REST. Antes, con Math.max, un reinicio
          // dejaba la detección muda para siempre porque el nuevo sequence nunca superaba al viejo.
          if (snapshot.sequence > lastSeq.current + 1 || snapshot.sequence < lastSeq.current) {
            void queryClient.invalidateQueries({ queryKey });
          }
        }
        lastSeq.current = snapshot.sequence; // sigue la secuencia real (respeta reinicios)
        queryClient.setQueryData(queryKey, snapshot);
        rememberSnapshot(snapshot);
      },
      onLiveness: (change) => {
        if (change.plantId !== plantId) return;
        queryClient.setQueryData<PlantSnapshotDto>(queryKey, (prev) =>
          prev
            ? { ...prev, liveness: { state: change.state, lastChangeAt: change.lastChangeAt, windowSec: change.windowSec } }
            : prev,
        );
      },
      onConnectionChange: (connected) => {
        // Un socket caído significa "no hay PUSH", NO que la planta esté congelada: el REST sigue
        // siendo fuente de verdad. Marcar `frozen` aquí hacía que la app dijera "CONGELADO" con el
        // puente perfectamente Connected (bug observado en planta el 2026-07-30). En su lugar se
        // pasa a refrescar por REST cada pocos segundos, así el dato sigue siendo fresco de verdad;
        // si el REST TAMBIÉN falla, el fallback de abajo ya marca `frozen` con la última lectura.
        lastSeq.current = 0;
        setSocketDown(!connected);
        if (connected) void queryClient.invalidateQueries({ queryKey });
      },
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plantId, enabled]);

  // Fallback: sin señales frescas (error de red, o backend con cache vacía → `pending`),
  // entrega la última lectura conocida del dispositivo. El estado del puente fresco manda si
  // existe (el banner debe reflejar la realidad actual, no la de la lectura guardada), y el
  // liveness se fuerza a `frozen`: los valores son viejos y así se marcan.
  const data = useMemo<PlantSnapshotDto | undefined>(() => {
    if (!enabled) return undefined;
    const fresh = query.data;
    if (fresh && Object.keys(fresh.signals).length > 0) return fresh;
    // Planta en integración: no tiene señales porque aún no está conectada, no porque se haya caído.
    // Mezclarla con un respaldo viejo le quitaría el `integrationPending` y la pintaría «CONGELADO».
    if (fresh?.integrationPending) return fresh;
    const stored = getLastSnapshot(plantId);
    if (!stored) return fresh;
    return {
      ...stored,
      bridgeStatus: fresh?.bridgeStatus ?? stored.bridgeStatus,
      liveness: { ...stored.liveness, state: 'frozen' },
    };
    // storeVersion: getLastSnapshot lee estado EXTERNO al render; la versión es la señal de
    // que ese estado cambió (hidratación async del storage). El linter no puede saberlo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, plantId, storeVersion, enabled]);

  return { ...query, data };
}
