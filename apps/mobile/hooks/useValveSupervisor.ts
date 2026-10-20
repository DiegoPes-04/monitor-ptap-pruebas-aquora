import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sendValveCommand } from '../services/api';
import {
  detectManual,
  interpretCommand,
  vigilaOperacionManual,
  type CommandVerdict,
  type ValveState,
  type ValveView,
} from '../services/valves';

/**
 * Supervisor de electroválvulas: mantiene el estado de la app CONSISTENTE con la realidad física y
 * envía las órdenes por el canal oficial.
 *
 * Dos problemas que resuelve, ambos reportados desde planta:
 *  1. **Operación manual.** A veces la válvula se abre/cierra a mano. Entonces el caudal cruza el
 *     umbral (0.1) pero la lectura eléctrica del PLC no reporta nada. Si la app no lo detecta,
 *     acabaría mandando "abrir" a una válvula ya abierta. Aquí se detecta y el estado mostrado pasa
 *     a seguir al caudal (override) hasta que la lectura eléctrica coincida.
 *
 *     **Ya no genera avisos en pantalla.** Los llevaba dentro de esta pantalla, se descartaban con
 *     un toque, solo los veía quien estuviera mirando y desaparecían al recargar. Todo lo que tenga
 *     que ver con una válvula va ahora a la bandeja de notificaciones, donde lo ve el resto del
 *     equipo y donde queda. Aquí solo se corrige lo que se MUESTRA.
 *  2. **Saber qué pasó de verdad tras una orden.** Se distingue "la señal salió" de "el equipo
 *     respondió" (ver interpretCommand) y, tras enviar, se vigila unos segundos si el estado real
 *     cambió — así el operador no se queda con un "listo" que no ocurrió.
 */

/**
 * Ventana tras una orden nuestra en la que un cambio NO se considera manual.
 *
 * 60 s, no los 15 s de antes: en La Vorágine la señal se SOSTIENE hasta que el PLC confirma, con un
 * tope de 45 s. Con la ventana corta, una maniobra que tardara más de 15 s terminaba fuera de ella y
 * la app avisaba de «válvula abierta manualmente» por una orden que había mandado ella misma.
 */
const COMMAND_WINDOW_MS = 60_000;

export interface SupervisedValve extends ValveView {
  /** Estado que la app muestra: sigue al caudal si se detectó operación manual. */
  effectiveState: ValveState;
  /** true si el estado mostrado viene de un override por operación manual. */
  manualOverride: boolean;
}

export function useValveSupervisor(plantId: string, valves: ValveView[]) {
  const [busy, setBusy] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, ValveState>>({});

  // Lecturas anteriores por válvula, para detectar transiciones.
  const prev = useRef<Record<string, { flow: ValveState | null; state: ValveState | null }>>({});
  const lastCommandAt = useRef<Record<string, number>>({});

  // Al cambiar de planta se descarta todo: los ids de válvula se repiten entre plantas.
  useEffect(() => {
    prev.current = {};
    lastCommandAt.current = {};
    setOverrides({});
  }, [plantId]);

  // Detección de operación manual + limpieza del override cuando el PLC ya coincide.
  useEffect(() => {
    for (const v of valves) {
      // Las proporcionales no se vigilan: su apertura ya refleja quién la mueva (ver la función).
      if (!vigilaOperacionManual(v)) continue;
      const before = prev.current[v.id];
      prev.current[v.id] = { flow: v.byFlow, state: v.byState };
      if (!before) continue; // primera lectura: no hay transición que juzgar

      const commandRecently = Date.now() - (lastCommandAt.current[v.id] ?? 0) < COMMAND_WINDOW_MS;
      const manual = detectManual(before.flow, v.byFlow, before.state, v.byState, commandRecently);

      if (manual) {
        // El estado mostrado pasa a seguir al caudal. El AVISO de que alguien la movió a mano lo
        // publica el servidor en la bandeja (`valve_manual`): así lo ve todo el equipo de la planta
        // y no solo quien tuviera esta pantalla abierta.
        setOverrides((o) => ({ ...o, [v.id]: manual === 'opened' ? 'open' : 'closed' }));
      } else if (v.byState !== null && overrides[v.id] && v.byState === overrides[v.id]) {
        // La lectura eléctrica ya coincide con el override: se deja de forzar.
        setOverrides((o) => {
          const { [v.id]: _drop, ...rest } = o;
          return rest;
        });
      }
    }
    // `overrides` se lee para poder limpiarlo; no debe re-disparar el efecto por sí mismo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valves]);

  // Memoizado: sin esto se creaba un array (y N objetos) nuevos en CADA render, rompiendo la
  // identidad de las props de todas las `ValveItem` y anulando su memo.
  const supervised = useMemo<SupervisedValve[]>(
    () =>
      valves.map((v) => {
        // Por si una recarga del mapping convierte en proporcional una válvula que tenía override.
        const ov = vigilaOperacionManual(v) ? overrides[v.id] : undefined;
        return { ...v, effectiveState: ov ?? v.state, manualOverride: ov !== undefined };
      }),
    [valves, overrides],
  );

  /**
   * Envía la orden. SIEMPRE se envía, incluso si la válvula ya está en ese estado (lo pidió el
   * operador): así el PLC recibe la orden igual y, si el estado de la app estaba desactualizado, la
   * respuesta lo corrige. Se avisa cuando ya estaba en ese estado.
   */
  const send = useCallback(
    async (valve: SupervisedValve, verb: 'open' | 'close'): Promise<CommandVerdict> => {
      setBusy(valve.id);
      lastCommandAt.current[valve.id] = Date.now();
      const yaEstaba = valve.effectiveState === (verb === 'open' ? 'open' : 'closed');
      try {
        const res = await sendValveCommand(plantId, verb, valve.id);
        const verdict = interpretCommand(res, verb, valve.name);
        const message = yaEstaba
          ? `Ya estaba ${verb === 'open' ? 'ABIERTA' : 'CERRADA'}, pero la orden se envió igual.\n\n${verdict.message}`
          : verdict.message;

        // Una orden confirmada es la verdad más fuerte: invalida cualquier override manual.
        if (verdict.ok) {
          setOverrides((o) => {
            const { [valve.id]: _drop, ...rest } = o;
            return rest;
          });
        }
        return { ...verdict, message };
      } finally {
        setBusy(null);
      }
    },
    [plantId],
  );

  return { valves: supervised, send, busy };
}
