import type { RawPlantFrame } from '../ports/connectivity-adapter.port';
import type { LivenessDto, LivenessState } from './plant-snapshot.dto';

interface PlantLiveness {
  lastKnown: Map<string, string>; // browseName → firma de valores (para detectar CAMBIO real)
  lastChangeAt: string | null; // sourceTimestamp del último CAMBIO observado; null = nunca
  windowSec: number;
  /** Cuándo empezamos a observar esta planta. Acota el "aún no vi ningún cambio" del arranque. */
  firstSeenAt: number;
  /** El mapping no le declara NINGÚN buffer de datos: ningún adaptador le entregará un frame. */
  sinBuffers: boolean;
}

/**
 * Frescura de datos (PASO 3.3). TRES estados, y la clave es que el veredicto cruza DOS cosas:
 * cuánto hace que un valor cambió Y si la sesión con el PLC sigue sana.
 *
 *   live   → hubo un cambio en los últimos liveSec (con la sesión sana).
 *   stable → sesión sana y los valores no se mueven, pero DENTRO de la ventana `windowSec`. Es
 *            OPERACIÓN NORMAL: un tanque a nivel constante o una presión sostenida no son una
 *            avería, y sus datos VALEN.
 *   frozen → o la sesión NO está sana (perdimos la fuente), o lleva MÁS de `windowSec` sin que
 *            cambie un solo valor. En ambos casos lo que se muestra ya no representa la planta.
 *
 * Por qué se puede afirmar "stable" sin mentir: el puente mantiene un heartbeat y la
 * suscripción OPC UA su keepalive. Si el puente sigue `Connected`, la sesión respondió hace
 * segundos — luego la ausencia de cambios es del PROCESO, no del enlace. Sin ese cruce, la
 * versión anterior marcaba `stale` por reloj y además invalidaba las señales, de modo que una
 * planta en régimen estable aparecía "congelada" y "sin dato" estando perfectamente bien.
 *
 * ⚠️ **Pero ese arreglo se pasó de largo y dejó un agujero** (detectado el 2026-08-15): al quitar
 * el criterio de reloj se quitó TODA cota superior. `windowSec` se configuraba, se exponía en el
 * DTO y no se consultaba en ninguna parte, así que con el puente `Connected` una planta con datos
 * de **24 días** devolvía `stable`, indistinguible de un tanque quieto durante 30 segundos. Así
 * pasaron inadvertidas tres plantas muertas en campo y 41 h en las que NOSOTROS dejamos de
 * entregar frames.
 *
 * El equilibrio correcto no es "sin cota" ni "cota de segundos", sino la cota LARGA que ya existía
 * declarada: `windowSec` (5 min por defecto). Una planta en régimen estable sigue viéndose
 * `stable`; una que lleva días sin moverse se ve `frozen`, que es la verdad.
 *
 * Un CAMBIO = el valor de algún buffer difiere del anterior conocido. La PRIMERA vez que vemos
 * un buffer NO es un cambio (no hay delta): con la sesión sana eso es `stable`, no un error.
 *
 * DN/ER/TO están descartados como fuente (inobservables por Optix, Fase 0.3): NO se usan.
 */
export class LivenessTracker {
  private readonly plants = new Map<string, PlantLiveness>();

  constructor(
    private readonly liveSec: number,
    private readonly defaultWindowSec: number,
  ) {}

  /**
   * Registra el default por planta (del mapping) antes de recibir frames.
   *
   * `tieneBuffers = false` es una planta dada de alta en el mapping SIN un solo buffer de datos:
   * Cabuyo, La Luisa, La Leonera y Gloria desde el 2026-10-19, a la espera de que el integrador las
   * suba al PLC maestro. El beneficio de la duda del arranque (`stable` durante la ventana) existe
   * porque la primera muestra de cada buffer no cuenta como cambio; aquí no va a llegar ningún buffer,
   * así que no hay duda que conceder. Concederla pintaba ESTABLE —y «Sistema operativo, enviando
   * datos» en la vista Civil— durante los primeros `windowSec` de cada arranque una planta que no
   * está en el PLC. Es `frozen` desde el principio: con tres estados, lo único cierto es que no llega
   * nada. Si algún día llegara un frame suyo, manda la regla normal.
   */
  configurePlant(plantId: string, windowSec: number | null, tieneBuffers = true): void {
    const entry = this.ensure(plantId);
    entry.windowSec = windowSec ?? this.defaultWindowSec;
    entry.sinBuffers = !tieneBuffers;
  }

  /** Procesa un frame y devuelve true si detectó un cambio real (para el diff aguas abajo). */
  ingest(frame: RawPlantFrame): boolean {
    const entry = this.ensure(frame.plantId);
    let changed = false;
    for (const buf of frame.buffers) {
      const sig = JSON.stringify(buf.values);
      const prev = entry.lastKnown.get(buf.browseName);
      if (prev !== undefined && prev !== sig) changed = true; // 1ª vez no cuenta
      entry.lastKnown.set(buf.browseName, sig);
    }
    if (changed) {
      entry.lastChangeAt = frame.buffers[0]?.sourceTimestamp ?? frame.receivedAt;
    }
    return changed;
  }

  /**
   * @param sourceHealthy true si la sesión con el PLC está viva (puente `Connected`, heartbeat
   *   respondiendo). Es lo que separa "no se mueve" (stable) de "no llega" (frozen).
   */
  get(plantId: string, sourceHealthy: boolean, now = Date.now()): LivenessDto {
    const entry = this.ensure(plantId);
    return {
      state: this.stateOf(entry, sourceHealthy, now),
      lastChangeAt: entry.lastChangeAt,
      windowSec: entry.windowSec,
    };
  }

  private stateOf(entry: PlantLiveness, sourceHealthy: boolean, now: number): LivenessState {
    // Sin sesión sana no se puede afirmar nada de la planta: da igual lo reciente que sea el
    // último cambio, el dato que tenemos ya no está respaldado por nadie.
    if (!sourceHealthy) return 'frozen';

    // Sin buffers de datos en el mapping y sin un solo frame recibido: no hay nada que esperar
    // (ver `configurePlant`).
    if (entry.sinBuffers && entry.lastKnown.size === 0) return 'frozen';

    // Conectados pero aún sin haber visto un solo cambio. Es el estado del arranque (la primera
    // muestra de cada buffer no cuenta como cambio: no hay delta contra el que comparar), así que
    // se concede el beneficio de la duda DURANTE la ventana. Pasada la ventana sin ver moverse
    // nada, ya no es "acabamos de arrancar": es que no llega nada.
    if (!entry.lastChangeAt) {
      const esperandoSec = (now - entry.firstSeenAt) / 1000;
      return esperandoSec > entry.windowSec ? 'frozen' : 'stable';
    }

    const ageSec = (now - new Date(entry.lastChangeAt).getTime()) / 1000;
    if (ageSec <= this.liveSec) return 'live';
    // La cota larga. Es lo que distingue "el proceso está quieto" de "esto no se actualiza".
    return ageSec > entry.windowSec ? 'frozen' : 'stable';
  }

  private ensure(plantId: string): PlantLiveness {
    let entry = this.plants.get(plantId);
    if (!entry) {
      entry = { lastKnown: new Map(), lastChangeAt: null, windowSec: this.defaultWindowSec, firstSeenAt: Date.now(), sinBuffers: false };
      this.plants.set(plantId, entry);
    }
    return entry;
  }
}
