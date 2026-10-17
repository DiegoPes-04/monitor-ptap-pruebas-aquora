/**
 * La aritmética de bits de scripts/test-valvulas-voragine.ts, aparte y PURA: sin red, sin OPC UA,
 * sin reloj, sin disco. Lo que decide QUÉ se escribe en el PLC tiene que poder probarse entero sin
 * un PLC delante (test/voragine-valvulas-bits.test.ts recorre las 65 536 palabras posibles).
 *
 * FUENTE de los bits: integrador del PLC, 2026-10-16. Las dos válvulas de La Vorágine mandan por la
 * MISMA palabra, INT_OUT_VORAGINE[0]:
 *   - entrada (valve2): abrir = bit2 (4),     cerrar = bit3 (8)
 *   - salida  (valve1): abrir = bit12 (4096), cerrar = bit13 (8192)
 * REGLA, textual: «estas señales deben ser sostenidas, es decir que todo el tiempo debe quedar la
 * señal de apertura o la señal de cierre, nunca las dos, siempre una de las dos».
 *
 * Están escritos aquí y NO leídos del mapping a propósito: la herramienta compara los dos y se niega
 * a escribir si no coinciden (`verificarContraMapping`). Un mapping editado a mano no puede cambiar
 * en silencio qué bits toca una herramienta que escribe en un PLC en producción.
 */

export type Valvula = 'entrada' | 'salida';
export type Verbo = 'abrir' | 'cerrar';

export const VALVULAS: Readonly<Record<Valvula, { domainKey: string; label: string; abrir: number; cerrar: number }>> = {
  entrada: { domainKey: 'valve2', label: 'Válvula de entrada', abrir: 1 << 2, cerrar: 1 << 3 },
  salida: { domainKey: 'valve1', label: 'Válvula de salida', abrir: 1 << 12, cerrar: 1 << 13 },
};

/** Los ÚNICOS bits que esta herramienta puede llegar a cambiar: {2, 3, 12, 13} = 12300. */
export const LISTA_BLANCA = VALVULAS.entrada.abrir | VALVULAS.entrada.cerrar | VALVULAS.salida.abrir | VALVULAS.salida.cerrar;

/** Dónde están: planta, buffers y elemento de mando. */
export const PLANTA = 'voragine';
export const BUFFER_MANDO = 'INT_OUT_VORAGINE';
export const BUFFER_ESTADO = 'INT_IN_VORAGINE';
export const BUFFER_PROCESO = 'REAL_IN_VORAGINE';
export const INDICE_MANDO = 0;
/** REAL_IN_VORAGINE: caudal de entrada [0], nivel del tanque [5], caudal de salida [7] (mapping). */
export const INDICES_PROCESO = { caudalEntrada: 0, nivel: 5, caudalSalida: 7 } as const;

export function otraValvula(v: Valvula): Valvula {
  return v === 'entrada' ? 'salida' : 'entrada';
}

export function contrario(verbo: Verbo): Verbo {
  return verbo === 'abrir' ? 'cerrar' : 'abrir';
}

/**
 * Palabra leída → 16 bits SIN signo, para hacer aritmética de bits.
 *
 * El elemento es Int16: con el bit15 puesto el servidor lo entrega NEGATIVO (-32768…-1). Se aceptan
 * las dos representaciones y nada más: un valor fuera de rango, decimal o no numérico es que se está
 * leyendo otra cosa, y sobre eso no se calcula ninguna escritura.
 */
export function aSinSigno16(v: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < -0x8000 || v > 0xffff) {
    throw new Error(`la palabra leída (${String(v)}) no es un entero de 16 bits: no se calcula ninguna escritura sobre ella`);
  }
  return v & 0xffff;
}

/** 16 bits sin signo → Int16 CON signo: lo que cabe en el elemento y lo que el servidor devuelve al releer. */
export function aConSigno16(v: number): number {
  const u = aSinSigno16(v);
  return u >= 0x8000 ? u - 0x10000 : u;
}

export function bitsPuestos(v: number): number[] {
  const u = aSinSigno16(v);
  const bits: number[] = [];
  for (let b = 0; b < 16; b++) if (u & (1 << b)) bits.push(b);
  return bits;
}

export function textoBits(v: number): string {
  return `{${bitsPuestos(v).join(',')}}`;
}

/** Estado del par de una válvula. `sin-senal` (0/0) y `error` (1/1) son los dos que la regla prohíbe. */
export type EstadoPar = 'abrir' | 'cerrar' | 'sin-senal' | 'error';

export function estadoDelPar(palabra: number, valvula: Valvula): EstadoPar {
  const u = aSinSigno16(palabra);
  const p = VALVULAS[valvula];
  const a = (u & p.abrir) !== 0;
  const c = (u & p.cerrar) !== 0;
  if (a && c) return 'error';
  if (a) return 'abrir';
  if (c) return 'cerrar';
  return 'sin-senal';
}

export function describirPar(e: EstadoPar): string {
  switch (e) {
    case 'abrir':
      return 'ABRIR';
    case 'cerrar':
      return 'CERRAR';
    case 'sin-senal':
      return '0/0 SIN SEÑAL';
    case 'error':
      return '1/1 ERROR';
  }
}

/** «4100 {2,12} · entrada ABRIR · salida ABRIR» (+ bits ajenos, si los hay). */
export function describirPalabra(palabra: number): string {
  const u = aSinSigno16(palabra);
  const ajenos = u & ~LISTA_BLANCA;
  return (
    `${aConSigno16(u)} ${textoBits(u)} · entrada ${describirPar(estadoDelPar(u, 'entrada'))} · salida ${describirPar(estadoDelPar(u, 'salida'))}` +
    (ajenos ? ` · bits ajenos ${textoBits(ajenos)}` : '')
  );
}

export interface Plan {
  valvula: Valvula;
  verbo: Verbo;
  /** Palabra leída, 16 bits sin signo. */
  actual: number;
  /** Palabra a escribir, 16 bits sin signo. */
  nuevo: number;
  /** Lo que se manda al servidor: Int16 con signo (el bit15, si estuviera, sale negativo). */
  aEscribir: number;
  cambia: boolean;
  bitsQueCambian: number[];
  parAntes: EstadoPar;
  parDespues: EstadoPar;
  otra: { valvula: Valvula; estado: EstadoPar };
  /** Bits fuera de {2,3,12,13} que esta escritura APAGA (solo con `limpiarAjenos`); 0 si ninguno. */
  ajenosApagados: number;
  avisos: string[];
}

/**
 * Qué escribir para poner `verbo` en `valvula`: `(actual & ~contrario) | verbo`, en UNA escritura.
 *
 * Lanza —y entonces no se escribe nada— si el resultado tocara un bit fuera del par de esa válvula o
 * fuera de la lista blanca, si no dejara el par exactamente en el verbo pedido, o si moviera la otra
 * válvula. Son comprobaciones de algo que la fórmula ya garantiza: están para que un cambio futuro de
 * la fórmula no pueda colar una escritura distinta sin que salte aquí, antes del PLC.
 *
 * Los avisos no detienen nada: dicen en qué estado estaba la palabra (un par en 0/0 o 1/1 es lo que
 * la regla prohíbe y la orden lo corrige; la OTRA válvula en 0/0 o 1/1 se avisa y no se toca).
 *
 * `limpiarAjenos` APAGA, en la misma escritura, los bits que no son de ninguna válvula. Existe por el
 * bit1 (valor 2) que el 2026-10-16 apareció en INT_OUT_VORAGINE[0] antes de cualquier orden: alguien
 * escribió un 2 suelto —probablemente leyendo «.2» como el valor 2 y no como el bit 2— y, como la
 * escritura conserva los bits ajenos, cada orden lo arrastraba (4106 = 4096 + 8 + 2). Solo puede
 * apagar: nunca enciende un bit fuera de la lista blanca, y la otra válvula sigue sin tocarse.
 */
export function planificar(
  palabraLeida: number,
  valvula: Valvula,
  verbo: Verbo,
  opciones: { limpiarAjenos?: boolean } = {},
): Plan {
  const actual = aSinSigno16(palabraLeida);
  const p = VALVULAS[valvula];
  const bitVerbo = p[verbo];
  const bitContrario = p[contrario(verbo)];
  const limpiar = opciones.limpiarAjenos === true;
  const ajenosApagados = limpiar ? actual & ~LISTA_BLANCA & 0xffff : 0;
  const nuevo = ((actual & ~bitContrario) | bitVerbo) & (limpiar ? LISTA_BLANCA : 0xffff);
  const diff = nuevo ^ actual;
  const otra = otraValvula(valvula);

  if ((diff & ~(p.abrir | p.cerrar) & ~ajenosApagados) !== 0) {
    throw new Error(`ABORTADO: la escritura cambiaría bits fuera del par de la ${valvula} (${textoBits(diff)}). No se escribe nada.`);
  }
  if ((diff & ~LISTA_BLANCA & ~ajenosApagados) !== 0 || (nuevo & ~LISTA_BLANCA & ~actual) !== 0) {
    throw new Error(`ABORTADO: la escritura cambiaría bits fuera de la lista blanca {2,3,12,13} (${textoBits(diff)}). No se escribe nada.`);
  }
  if (estadoDelPar(nuevo, valvula) !== verbo) {
    throw new Error(`ABORTADO: el par de la ${valvula} quedaría en ${describirPar(estadoDelPar(nuevo, valvula))}, no en ${verbo.toUpperCase()}. No se escribe nada.`);
  }
  if (estadoDelPar(nuevo, otra) !== estadoDelPar(actual, otra)) {
    throw new Error(`ABORTADO: la escritura movería la ${otra}. No se escribe nada.`);
  }

  const parAntes = estadoDelPar(actual, valvula);
  const estadoOtra = estadoDelPar(actual, otra);
  const avisos: string[] = [];
  if (parAntes === 'error') {
    avisos.push(`el par de la ${valvula} PARTÍA en 1/1 (abrir y cerrar a la vez: ERROR según el integrador). Esta orden lo deja solo en ${verbo.toUpperCase()}.`);
  }
  if (parAntes === 'sin-senal') {
    avisos.push(`el par de la ${valvula} PARTÍA en 0/0 (sin señal, lo que la regla prohíbe; así lo dejaban los pulsos). Esta orden fija la señal.`);
  }
  if (estadoOtra === 'error') {
    avisos.push(`la ${otra} está en 1/1 (ERROR). Esta herramienta NO la toca: corrígela con su propia orden.`);
  }
  if (estadoOtra === 'sin-senal') {
    avisos.push(`la ${otra} está en 0/0 (sin señal). Esta herramienta NO la toca: fíjala con su propia orden.`);
  }
  const ajenos = actual & ~LISTA_BLANCA;
  if (ajenosApagados !== 0) {
    avisos.push(`--sin-ajenos: se APAGAN los bits fuera de {2,3,12,13} (${textoBits(ajenosApagados)}) en esta misma escritura.`);
  } else if (ajenos !== 0) {
    avisos.push(`hay bits fuera de {2,3,12,13} puestos (${textoBits(ajenos)}): se conservan tal cual (para quitarlos, --sin-ajenos).`);
  }

  return {
    valvula,
    verbo,
    actual,
    nuevo,
    aEscribir: aConSigno16(nuevo),
    cambia: nuevo !== actual,
    bitsQueCambian: diff === 0 ? [] : bitsPuestos(diff),
    parAntes,
    parDespues: estadoDelPar(nuevo, valvula),
    otra: { valvula: otra, estado: estadoOtra },
    ajenosApagados,
    avisos,
  };
}

export interface PlanPalabra {
  actual: number;
  nuevo: number;
  aEscribir: number;
  cambia: boolean;
  bitsQueCambian: number[];
  avisos: string[];
}

/**
 * Escribir la palabra ENTERA con un valor exacto: `palabra 0`, luego `palabra 8`.
 *
 * Existe por una decisión de campo del 2026-10-16: con la entrada sin responder, se quiso poner el
 * canal completo a 0 y DESPUÉS solo el bit 3, en dos escrituras separadas, en vez del cambio de par en
 * una sola escritura que hace `planificar`. Va contra la regla del integrador («siempre una de las
 * dos») mientras dura, y por eso se avisa de cada válvula que queda sin señal. Lo que sigue sin
 * admitirse: bits fuera de {2,3,12,13} y abrir+cerrar a la vez en una válvula (el ERROR del integrador).
 */
export function planificarPalabra(palabraLeida: number, valor: number): PlanPalabra {
  if (!Number.isInteger(valor) || valor < 0 || valor > 0xffff) {
    throw new Error(`ABORTADO: ${valor} no es una palabra de 16 bits. No se escribe nada.`);
  }
  if ((valor & ~LISTA_BLANCA) !== 0) {
    throw new Error(`ABORTADO: ${valor} ${textoBits(valor)} tiene bits fuera de {2,3,12,13} (${textoBits(valor & ~LISTA_BLANCA)}). No se escribe nada.`);
  }
  for (const v of ['entrada', 'salida'] as const) {
    if (estadoDelPar(valor, v) === 'error') {
      throw new Error(`ABORTADO: ${valor} pone abrir y cerrar a la vez en la ${v} (ERROR según el integrador). No se escribe nada.`);
    }
  }
  const actual = aSinSigno16(palabraLeida);
  const diff = valor ^ actual;
  const avisos: string[] = [];
  for (const v of ['entrada', 'salida'] as const) {
    if (estadoDelPar(valor, v) === 'sin-senal' && estadoDelPar(actual, v) !== 'sin-senal') {
      avisos.push(`la ${v} pasa de ${describirPar(estadoDelPar(actual, v))} a SIN SEÑAL (0/0): la regla del integrador lo prohíbe; mientras dure, su comportamiento depende de la lógica local.`);
    }
  }
  const ajenos = actual & ~LISTA_BLANCA;
  if (ajenos !== 0) avisos.push(`se APAGAN los bits ajenos ${textoBits(ajenos)}.`);
  return {
    actual,
    nuevo: valor,
    aEscribir: aConSigno16(valor),
    cambia: diff !== 0,
    bitsQueCambian: diff === 0 ? [] : bitsPuestos(diff),
    avisos,
  };
}

// ── Argumentos ──────────────────────────────────────────────────────────────────

export const USO = [
  'Uso (desde apps/api, en la VM):',
  '  npx tsx scripts/test-valvulas-voragine.ts                              solo estado (lectura)',
  '  npx tsx scripts/test-valvulas-voragine.ts --observar 120               solo observar 120 s (lectura)',
  '  npx tsx scripts/test-valvulas-voragine.ts <entrada|salida> <abrir|cerrar>',
  '                                                                         SIMULACRO: qué escribiría (sale con 2)',
  '  npx tsx scripts/test-valvulas-voragine.ts <entrada|salida> <abrir|cerrar> --armar [--observar <seg>]',
  '                                                                         ESCRIBE (cuenta atrás de 5 s) y observa (60 s por defecto)',
  '  ... <entrada|salida> <abrir|cerrar> --sin-ajenos [--armar]             además APAGA los bits que no son de ninguna válvula',
  '  npx tsx scripts/test-valvulas-voragine.ts palabra <valor> [--armar]    escribe la palabra ENTERA con ese valor exacto',
  '                                                                         (solo bits 2,3,12,13; nunca abrir+cerrar a la vez)',
  '  Al final, opcional: opc.tcp://host:puerto  (si no, OPC_ENDPOINT del entorno o del .env)',
].join('\n');

export interface Opciones {
  valvula: Valvula | null;
  verbo: Verbo | null;
  armar: boolean;
  /** Apagar en la misma escritura los bits fuera de {2,3,12,13}. Solo con una orden. */
  sinAjenos: boolean;
  /** Modo `palabra <valor>`: el valor exacto de la palabra entera. null en los demás modos. */
  palabra: number | null;
  /** null = no se pidió (con orden se observan 60 s; sin orden, nada). */
  observarSeg: number | null;
  endpoint: string | null;
}

export const OBSERVAR_POR_DEFECTO_SEG = 60;
export const OBSERVAR_MAX_SEG = 3600;

export function parsearArgumentos(argv: string[]): { ok: true; opciones: Opciones } | { ok: false; error: string } {
  const posicionales: string[] = [];
  let armar = false;
  let sinAjenos = false;
  let observarSeg: number | null = null;
  let endpoint: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--armar') {
      if (armar) return { ok: false, error: '--armar repetido' };
      armar = true;
    } else if (a === '--sin-ajenos') {
      if (sinAjenos) return { ok: false, error: '--sin-ajenos repetido' };
      sinAjenos = true;
    } else if (a === '--observar') {
      if (observarSeg !== null) return { ok: false, error: '--observar repetido' };
      const v = argv[i + 1];
      if (v === undefined || !/^\d+$/.test(v)) return { ok: false, error: `--observar necesita los segundos (entero de 0 a ${OBSERVAR_MAX_SEG})` };
      observarSeg = Number(v);
      if (observarSeg > OBSERVAR_MAX_SEG) return { ok: false, error: `--observar: como mucho ${OBSERVAR_MAX_SEG} s` };
      i++;
    } else if (a.startsWith('opc.tcp://')) {
      if (endpoint) return { ok: false, error: 'dos endpoints' };
      endpoint = a;
    } else if (a.startsWith('-')) {
      return { ok: false, error: `opción desconocida: ${a}` };
    } else {
      posicionales.push(a);
    }
  }

  if (posicionales.length === 0) {
    if (armar) return { ok: false, error: '--armar sin válvula ni verbo: no hay nada que escribir' };
    if (sinAjenos) return { ok: false, error: '--sin-ajenos va con una orden: <entrada|salida> <abrir|cerrar> --sin-ajenos' };
    return { ok: true, opciones: { valvula: null, verbo: null, armar, sinAjenos, palabra: null, observarSeg, endpoint } };
  }
  if (posicionales[0] === 'palabra') {
    if (posicionales.length !== 2 || !/^\d+$/.test(posicionales[1])) {
      return { ok: false, error: 'palabra necesita un valor entero: palabra <0..65535>' };
    }
    const palabra = Number(posicionales[1]);
    if (palabra > 0xffff) return { ok: false, error: `palabra: ${palabra} no cabe en 16 bits` };
    if (sinAjenos) return { ok: false, error: '--sin-ajenos no aplica a palabra: el valor ya es exacto' };
    return { ok: true, opciones: { valvula: null, verbo: null, armar, sinAjenos, palabra, observarSeg, endpoint } };
  }
  if (posicionales.length !== 2) {
    return { ok: false, error: `se esperan exactamente dos palabras, <entrada|salida> <abrir|cerrar>, y hay ${posicionales.length}: ${posicionales.join(' ')}` };
  }
  const [valvula, verbo] = posicionales;
  if (valvula !== 'entrada' && valvula !== 'salida') return { ok: false, error: `válvula desconocida: "${valvula}" (entrada | salida)` };
  if (verbo !== 'abrir' && verbo !== 'cerrar') return { ok: false, error: `verbo desconocido: "${verbo}" (abrir | cerrar)` };
  return { ok: true, opciones: { valvula, verbo, armar, sinAjenos, palabra: null, observarSeg, endpoint } };
}

/** Cuántos segundos observar: los pedidos; si no, 60 tras una orden y 0 en modo solo estado. */
export function segundosDeObservacion(o: Opciones): number {
  if (o.observarSeg !== null) return o.observarSeg;
  return o.valvula || o.palabra !== null ? OBSERVAR_POR_DEFECTO_SEG : 0;
}

/** `2026-10-16T20-24-20-538Z-salida-cerrar.log`: el ISO sin `:` ni `.`, que Windows no admite. */
export function nombreDelLog(fecha: Date, o: Pick<Opciones, 'valvula' | 'verbo'> & { palabra?: number | null }): string {
  const iso = fecha.toISOString().replace(/[:.]/g, '-');
  if (o.palabra !== undefined && o.palabra !== null) return `${iso}-palabra-${o.palabra}.log`;
  return o.valvula && o.verbo ? `${iso}-${o.valvula}-${o.verbo}.log` : `${iso}-observacion.log`;
}

// ── Cuenta atrás ────────────────────────────────────────────────────────────────

/**
 * Cuenta atrás cancelable. Devuelve `true` si llegó a cero y `false` si se canceló (Ctrl+C), en cuyo
 * caso NO se escribe nada. Mira la cancelación cada 100 ms: soltar Ctrl+C a medio segundo del final
 * tiene que bastar. El tiempo y la cancelación se inyectan para poder probarla sin esperar.
 */
export async function cuentaAtras(
  segundos: number,
  d: { esperar: (ms: number) => Promise<void>; cancelado: () => boolean; imprimir: (linea: string) => void },
): Promise<boolean> {
  for (let s = segundos; s > 0; s--) {
    if (d.cancelado()) return false;
    d.imprimir(`  escribiendo en ${s}…  (Ctrl+C cancela; todavía no se ha escrito nada)`);
    for (let decima = 0; decima < 10; decima++) {
      if (d.cancelado()) return false;
      await d.esperar(100);
    }
  }
  return !d.cancelado();
}

// ── Muestras de la observación ──────────────────────────────────────────────────

export interface Muestra {
  /** INT_OUT_VORAGINE[0] tal cual llega (Int16 con signo), o null si no se pudo leer. */
  mando: number | null;
  /** INT_IN_VORAGINE[0..2]. */
  estado: Array<number | null>;
  caudalEntrada: number | null;
  caudalSalida: number | null;
  nivel: number | null;
}

function num(v: number | null, decimales: number): string {
  return v === null || !Number.isFinite(v) ? '—' : v.toFixed(decimales);
}

/** Qué cambió respecto a la muestra anterior. Los reales se comparan a la precisión que se muestra. */
export function cambiosEntreMuestras(antes: Muestra | null, ahora: Muestra): string[] {
  if (!antes) return [];
  const cambios: string[] = [];
  if (antes.mando !== ahora.mando) cambios.push('OUT[0]');
  ahora.estado.forEach((v, i) => {
    if (antes.estado[i] !== v) cambios.push(`IN[${i}]`);
  });
  if (num(antes.caudalEntrada, 2) !== num(ahora.caudalEntrada, 2)) cambios.push('Qent');
  if (num(antes.caudalSalida, 2) !== num(ahora.caudalSalida, 2)) cambios.push('Qsal');
  if (num(antes.nivel, 2) !== num(ahora.nivel, 2)) cambios.push('nivel');
  return cambios;
}

/** Una línea por segundo: mando con sus pares, estado con bits, caudales y nivel, y qué cambió. */
export function lineaDeMuestra(hora: string, m: Muestra, antes: Muestra | null): string {
  const mando =
    m.mando === null
      ? 'OUT[0]=  ilegible'
      : `OUT[0]=${String(m.mando).padStart(6)} ${textoBits(m.mando).padEnd(14)} ent=${describirPar(estadoDelPar(m.mando, 'entrada')).padEnd(13)} sal=${describirPar(estadoDelPar(m.mando, 'salida')).padEnd(13)}`;
  const estado = m.estado
    .map((v, i) => (v === null ? `IN[${i}]=ilegible` : `IN[${i}]=${String(v).padStart(6)} ${textoBits(v)}`))
    .join('  ');
  const proceso = `Qent=${num(m.caudalEntrada, 2)} l/s  Qsal=${num(m.caudalSalida, 2)} l/s  nivel=${num(m.nivel, 2)} m`;
  const cambios = cambiosEntreMuestras(antes, m);
  return `${hora}  ${mando} │ ${estado} │ ${proceso}${cambios.length ? `  ◀ CAMBIÓ: ${cambios.join(', ')}` : ''}`;
}

// ── El mapping ──────────────────────────────────────────────────────────────────

interface BufferCrudo {
  browseName?: string;
  node?: { nsUri?: string; identifier?: string };
}
interface PlantaCruda {
  plantId?: string;
  opcBuffers?: Record<string, BufferCrudo[]>;
  signals?: Array<{
    domainKey?: string;
    writable?: boolean;
    write?: { target?: { channel?: string; sourceBuffer?: string; index?: number }; commands?: Record<string, unknown>; mode?: string; sustained?: unknown };
  }>;
}

function plantaDelMapping(raw: unknown): PlantaCruda {
  const plantas = (raw as { plants?: PlantaCruda[] } | null)?.plants;
  const p = Array.isArray(plantas) ? plantas.find((x) => x.plantId === PLANTA) : undefined;
  if (!p) throw new Error(`el mapping no tiene la planta ${PLANTA}`);
  return p;
}

/** Los tres buffers de La Vorágine, con su nsUri y su identificador (GUID), sacados del mapping. */
export function nodosDelMapping(raw: unknown): { nsUri: string; mando: string; estado: string; proceso: string } {
  const p = plantaDelMapping(raw);
  const buscar = (canal: string, nombre: string): BufferCrudo => {
    const b = (p.opcBuffers?.[canal] ?? []).find((x) => x.browseName === nombre);
    if (!b?.node?.nsUri || !b.node.identifier) throw new Error(`el mapping no declara ${canal}/${nombre} de ${PLANTA} con su nodo`);
    return b;
  };
  const mando = buscar('intOut', BUFFER_MANDO);
  const estado = buscar('intIn', BUFFER_ESTADO);
  const proceso = buscar('realIn', BUFFER_PROCESO);
  const nsUri = mando.node!.nsUri!;
  for (const b of [estado, proceso]) {
    if (b.node!.nsUri !== nsUri) throw new Error(`los buffers de ${PLANTA} no comparten nsUri (${nsUri} / ${String(b.node!.nsUri)})`);
  }
  return { nsUri, mando: mando.node!.identifier!, estado: estado.node!.identifier!, proceso: proceso.node!.identifier! };
}

/**
 * ¿Dice el mapping lo mismo que esta herramienta? Devuelve las discrepancias (vacío = coinciden).
 * Con alguna, la herramienta NO escribe: o el mapping o la herramienta están mal, y escribir con
 * cualquiera de los dos sería escoger a ciegas.
 */
export function verificarContraMapping(raw: unknown): string[] {
  let p: PlantaCruda;
  try {
    p = plantaDelMapping(raw);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  const errores: string[] = [];
  for (const [nombre, v] of Object.entries(VALVULAS) as Array<[Valvula, (typeof VALVULAS)[Valvula]]>) {
    const s = (p.signals ?? []).find((x) => x.domainKey === v.domainKey);
    const w = s?.write;
    if (!s || !s.writable || !w) {
      errores.push(`${nombre} (${v.domainKey}): no es una válvula con mando en el mapping`);
      continue;
    }
    if (w.target?.channel !== 'intOut' || w.target?.sourceBuffer !== BUFFER_MANDO || w.target?.index !== INDICE_MANDO) {
      errores.push(`${nombre} (${v.domainKey}): manda por ${String(w.target?.sourceBuffer)}[${String(w.target?.index)}], no por ${BUFFER_MANDO}[${INDICE_MANDO}]`);
    }
    if (w.commands?.open !== v.abrir || w.commands?.close !== v.cerrar) {
      errores.push(`${nombre} (${v.domainKey}): el mapping dice open=${String(w.commands?.open)} close=${String(w.commands?.close)}; esta herramienta, ${v.abrir}/${v.cerrar}`);
    }
    if (w.mode !== 'bitmask') errores.push(`${nombre} (${v.domainKey}): mode ${String(w.mode)}, no bitmask`);
    if (w.sustained !== true) {
      errores.push(`${nombre} (${v.domainKey}): el mapping NO la declara sostenida — el backend que lo use limpiaría la señal tras cada orden`);
    }
  }
  return errores;
}
