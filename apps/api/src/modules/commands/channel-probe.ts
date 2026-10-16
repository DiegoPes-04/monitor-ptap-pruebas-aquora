import type { LoadedMapping, MonitorTarget } from '../../infrastructure/connectivity/mapping/opc-mapping.loader';

/**
 * Probador de canales: escribir un valor en una posición concreta de un buffer de SALIDA, sostenerlo
 * unos milisegundos y **soltarlo siempre**, para descubrir qué hace ese canal.
 *
 * ## Por qué existe
 *
 * Carbonero es el único sitio sin ninguna evidencia de si su válvula se movió: no tiene caudal, ni
 * presión, ni palabra de estado. Su mapping lleva `open: 4096` HEREDADO de Vorágine y jamás validado
 * allí, y no tiene `close` ninguno. Los dos sitios sí verificados usan codificaciones distintas
 * entre sí (Vorágine `4096`/`8192` como máscara sostenida; La Sirena `1`/`2` absoluto), así que aquí
 * no se deduce: **se captura**. Esta herramienta es la captura.
 *
 * El orden importa y es este, no el contrario: primero se descubre la codificación con el probador,
 * después se escribe en el mapeo. Editar el mapeo para averiguar qué hace un canal sería usar el
 * mapa para explorar el terreno.
 *
 * ## Lo que este módulo NO negocia
 *
 * Escribe en **absoluto**, no como máscara: el probador tiene que poner exactamente el valor que se
 * le pide, o no sirve para averiguar nada.
 *
 * Y por eso mismo, dos límites que no son opcionales:
 *
 *  - **solo canales de SALIDA.** Escribir en un buffer de entrada no prueba nada sobre la planta:
 *    prueba que se puede corromper la lectura que el operador está mirando.
 *  - **el índice tiene que existir** en la longitud declarada del buffer. Un índice fuera de rango
 *    no da un error claro en el PLC; da comportamiento indefinido en un equipo que mueve agua.
 *
 * La auto-liberación (volver a poner el valor anterior, pase lo que pase) vive en el servicio,
 * porque necesita el adaptador. Es la garantía central de la herramienta: el propio mapeo del
 * proyecto lo dice — «dejar una bobina energizada sin que nadie se entere es peor que abortar la
 * maniobra».
 */

/** Canales por los que el backend escribe. Cualquier otro es de lectura y no se toca. */
export const CANALES_DE_SALIDA = ['realOut', 'intOut', 'bitOut', 'msgWrite'] as const;

/**
 * Tope del sostenido. Cinco segundos es de sobra para ver una válvula moverse con un testigo
 * delante, y lo bastante corto para que un olvido, una desconexión o un cierre de la app no puedan
 * dejar una salida energizada de forma peligrosa.
 */
export const HOLD_MS_MAX = 5_000;
export const HOLD_MS_MIN = 1;

export interface ProbeRequest {
  channel: string;
  /** browseName EXACTO del buffer. No se adivina el primario: sondear a ciegas no tiene sentido. */
  sourceBuffer: string;
  index: number;
  value: number | boolean;
  holdMs: number;
}

export type MotivoProbe =
  | 'CANAL_NO_ES_DE_SALIDA'
  | 'BUFFER_DESCONOCIDO'
  | 'BUFFER_DE_OTRO_CANAL'
  | 'INDICE_FUERA_DE_RANGO'
  | 'HOLD_FUERA_DE_RANGO'
  | 'VALOR_INVALIDO'
  | 'SENAL_SOSTENIDA';

export interface RechazoProbe {
  ok: false;
  motivo: MotivoProbe;
  detalle: string;
}

export type VeredictoProbe = { ok: true; buffer: MonitorTarget } | RechazoProbe;

/** ¿Se puede sondear esto? Devuelve el buffer resuelto, que es lo que necesita el servicio. */
export function validarProbe(mapping: LoadedMapping, plantId: string, req: ProbeRequest): VeredictoProbe {
  if (!(CANALES_DE_SALIDA as readonly string[]).includes(req.channel)) {
    return {
      ok: false,
      motivo: 'CANAL_NO_ES_DE_SALIDA',
      detalle: `${req.channel} no es un canal de salida. Escribir en un canal de entrada no prueba nada de la planta: solo corrompe la lectura que el operador está viendo.`,
    };
  }

  if (!Number.isFinite(req.holdMs) || req.holdMs < HOLD_MS_MIN || req.holdMs > HOLD_MS_MAX) {
    return {
      ok: false,
      motivo: 'HOLD_FUERA_DE_RANGO',
      detalle: `El sostenido tiene que estar entre ${HOLD_MS_MIN} y ${HOLD_MS_MAX} ms.`,
    };
  }

  if (typeof req.value === 'number' && !Number.isFinite(req.value)) {
    return { ok: false, motivo: 'VALOR_INVALIDO', detalle: 'El valor tiene que ser un número finito o un booleano.' };
  }

  const buffer = mapping.targets.find((t) => t.plantId === plantId && t.browseName === req.sourceBuffer);
  if (!buffer) {
    return {
      ok: false,
      motivo: 'BUFFER_DESCONOCIDO',
      detalle: `${plantId} no tiene ningún buffer llamado ${req.sourceBuffer}.`,
    };
  }
  if (buffer.channel !== req.channel) {
    return {
      ok: false,
      motivo: 'BUFFER_DE_OTRO_CANAL',
      detalle: `${req.sourceBuffer} es del canal ${buffer.channel}, no de ${req.channel}.`,
    };
  }

  if (!Number.isInteger(req.index) || req.index < 0) {
    return { ok: false, motivo: 'INDICE_FUERA_DE_RANGO', detalle: 'El índice es un entero de 0 en adelante.' };
  }
  if (buffer.arrayLength !== null && req.index >= buffer.arrayLength) {
    return {
      ok: false,
      motivo: 'INDICE_FUERA_DE_RANGO',
      detalle: `${buffer.browseName} declara ${buffer.arrayLength} elementos: el último índice válido es ${buffer.arrayLength - 1}.`,
    };
  }

  // Una palabra que manda válvulas de señal SOSTENIDA no se sondea. El probador escribe en ABSOLUTO,
  // y la regla del integrador (La Vorágine, 2026-10-16) es que en esa palabra quede SIEMPRE puesto
  // abrir o cerrar de cada válvula, nunca los dos y nunca ninguno: cualquier valor de prueba la
  // rompería durante el sostenido aunque después se soltara. Y no hace falta: su codificación ya la
  // entregó el integrador, que es justo lo que el probador sirve para averiguar.
  const sostenidas = mapping.signals.filter(
    (s) =>
      s.plantId === plantId &&
      s.writable &&
      s.write?.sustained === true &&
      s.write.target.channel === req.channel &&
      s.write.target.sourceBuffer === req.sourceBuffer &&
      s.write.target.index === req.index,
  );
  if (sostenidas.length > 0) {
    return {
      ok: false,
      motivo: 'SENAL_SOSTENIDA',
      detalle: `${req.sourceBuffer}[${req.index}] manda ${sostenidas.map((s) => s.label ?? s.domainKey).join(' y ')} con señal SOSTENIDA: siempre tiene que quedar puesto abrir o cerrar, nunca los dos ni ninguno, y una escritura de prueba en absoluto lo rompería. Para accionarlas está el mando normal, que respeta esa regla.`,
    };
  }

  return { ok: true, buffer };
}

/**
 * Las válvulas que mandan por ESE elemento del buffer.
 *
 * Se usa para bloquearlas mientras dura la prueba, y al revés. Sin esto, una orden de abrir podría
 * caer justo en medio de un sondeo sobre la misma palabra: el probador escribe en absoluto y la orden
 * en máscara, y el resultado sería una palabra con las dos direcciones puestas — el estado que el
 * protocolo de estas plantas declara ERROR.
 */
export function valvulasAfectadas(mapping: LoadedMapping, plantId: string, req: ProbeRequest): string[] {
  const claves: string[] = [];
  for (const s of mapping.signals) {
    if (s.plantId !== plantId || !s.writable || !s.write) continue;
    const w = s.write;
    const tocaTarget = w.target.sourceBuffer === req.sourceBuffer && w.target.index === req.index;
    const tocaSecuencia = Object.values(w.sequences ?? {}).some(
      (pasos) => w.target.sourceBuffer === req.sourceBuffer && pasos.some((p) => p.index === req.index),
    );
    if (tocaTarget || tocaSecuencia) claves.push(s.domainKey);
  }
  return claves;
}

/** Foto de los valores de todos los buffers de una planta, para poder comparar después. */
export type FotoBuffers = Map<string, (number | boolean)[]>;

export interface CambioObservado {
  browseName: string;
  index: number;
  de: number | boolean | null;
  a: number | boolean | null;
  /** `domainKey` de la señal que lee ese índice, si alguna: es lo que hace legible el hallazgo. */
  domainKey: string | null;
}

/**
 * Qué se movió entre dos fotos.
 *
 * **Es la mitad útil del probador.** Escribir un valor y no poder ver el efecto deja la pregunta
 * igual que estaba; lo que se busca al sondear es «he puesto 4096 en INT_OUT[0] y ha cambiado
 * INT_IN[1]», que es exactamente cómo se descubre la palabra de estado de un sitio.
 *
 * Se ignora el propio elemento sondeado: que cambie es el hecho conocido, no un hallazgo.
 */
export function cambiosEntre(
  antes: FotoBuffers,
  despues: FotoBuffers,
  mapping: LoadedMapping,
  plantId: string,
  sondeado: { sourceBuffer: string; index: number },
): CambioObservado[] {
  const cambios: CambioObservado[] = [];

  for (const [browseName, valoresDespues] of despues) {
    const valoresAntes = antes.get(browseName);
    if (!valoresAntes) continue;
    const largo = Math.max(valoresAntes.length, valoresDespues.length);
    for (let i = 0; i < largo; i++) {
      if (browseName === sondeado.sourceBuffer && i === sondeado.index) continue;
      const de = i < valoresAntes.length ? valoresAntes[i] : null;
      const a = i < valoresDespues.length ? valoresDespues[i] : null;
      if (de === a) continue;
      cambios.push({ browseName, index: i, de, a, domainKey: quienLee(mapping, plantId, browseName, i) });
    }
  }

  return cambios;
}

function quienLee(mapping: LoadedMapping, plantId: string, browseName: string, index: number): string | null {
  const target = mapping.targets.find((t) => t.plantId === plantId && t.browseName === browseName);
  if (!target) return null;
  for (const s of mapping.signals) {
    if (s.plantId !== plantId || s.index !== index) continue;
    // Con `sourceBuffer` la atribución es exacta; sin él, la señal cuelga del primario de su canal,
    // y aquí basta con que el canal coincida — es una pista para leer la tabla, no una afirmación.
    if (s.sourceBuffer === browseName) return s.domainKey;
    if (!s.sourceBuffer && s.buffer === target.channel) return s.domainKey;
  }
  return null;
}
