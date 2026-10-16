import { Logger } from '@nestjs/common';
import { bufferDeLaSenal } from '../../mapping/mapping-overrides';
import type { LoadedMapping, MonitorTarget, SignalMapping, WriteSpec } from '../../mapping/opc-mapping.loader';
import {
  configDePlanta,
  configDeValvula,
  partirElemento,
  type SimFeedbackElement,
  type SimLatchMode,
  type SimPlantConfig,
  type SimValue,
  type SimValveConfig,
  type SimulatorOptions,
} from './sim-scenario';

/**
 * PLC SIMULADO: el maestro (lo que ve OPC UA), el PLC local de cada sitio y sus válvulas.
 *
 * Existe para poder probar en local, sin VPN ni PLC, lo que de verdad importa de una asignación de
 * bits: qué se escribe en la palabra, si una orden pisa a otra válvula, si el sostenido llega a cubrir
 * el ciclo de la MSG y qué ve la app cuando la válvula se mueve. Todo sale del MAPPING (regla 2): qué
 * elemento manda cada válvula, qué valor es abrir y cuál cerrar, dónde está su realimentación. Nada de
 * eso está escrito aquí; lo único que pone el escenario son los parámetros físicos (recorrido,
 * enclavamiento, ciclo de la MSG), que el mapping no tiene.
 *
 * ## El modelo
 *
 *  - **Memoria del maestro**: un valor por elemento (`plantId/BUFFER[indice]`). Lo que escribe el
 *    backend queda ahí y es lo que devuelven las lecturas y los frames. Los buffers de SALIDA nunca
 *    llevan ruido: o lo que se escribió, o su valor inicial (0/false, o el del escenario).
 *  - **MSG maestro→local**: el PLC local no ve la palabra del maestro en tiempo real, sino una COPIA
 *    que se refresca cada `msgCycleMs` (≈8 s medido en La Sirena). Un bit que se pone y se quita entre
 *    dos refrescos no llega nunca. Con `msgCycleMs: 0` la copia es instantánea.
 *  - **Válvulas**: posición 0 (cerrada) → 1 (abierta) a velocidad `1/travelMs`. Con `hold` se mueven
 *    SOLO mientras el verbo está puesto en la copia local; con `latch`, basta el flanco.
 *  - **Realimentación**: el PLC local escribe en los buffers de ENTRADA lo que el código espera leer
 *    (read-back, `pulse.until`, palabra de estado, caudal), y eso vuelve al maestro cada
 *    `feedbackCycleMs` (la MSG_READ).
 *  - **ERROR**: abrir y cerrar a 1 a la vez. Se registra como VIOLACIÓN en el instante en que una
 *    escritura deja la palabra del maestro así (aunque dure 1 ms y el PLC local no llegue a verlo), y
 *    la válvula entra en ERROR —se para y se queda ahí hasta un reset— cuando el PLC local lo ve.
 *
 * El tiempo lo pasa siempre quien llama (`ahora`): esta clase no tiene temporizadores, se evalúa en
 * cada observación (lectura, escritura, frame). Eso la hace exacta e independiente de la cadencia de
 * los frames, y con relojes falsos en los tests, determinista.
 */

export type SimValveState = 'closed' | 'opening' | 'open' | 'closing' | 'mid' | 'error';

/** Canales de SALIDA: los escribe el maestro, nunca llevan valores sintéticos. */
const CANALES_DE_SALIDA = new Set(['realOut', 'intOut', 'bitOut', 'msgWrite']);
/** Canales de ENTRADA de proceso: sin dueño, llevan valores sintéticos para que la planta esté viva. */
const CANALES_DE_ENTRADA = new Set(['realIn', 'intIn', 'bitIn']);
const CANALES_BOOLEANOS = new Set(['bitIn', 'bitOut']);
const CANALES_ENTEROS = new Set(['intIn', 'intOut']);
const EPS = 1e-9;
const MAX_TRANSICIONES = 50;
const MAX_VIOLACIONES = 500;

export interface SimElementRef {
  plantId: string;
  channel: string;
  sourceBuffer: string;
  index: number;
}

export function claveDeElemento(e: { plantId: string; sourceBuffer: string; index: number }): string {
  return `${e.plantId}/${e.sourceBuffer}[${e.index}]`;
}

/** Una escritura del BACKEND sobre el maestro. El historial es la prueba de lo que salió por el cable. */
export interface SimWrite {
  seq: number;
  at: string;
  ms: number;
  plantId: string;
  channel: string;
  sourceBuffer: string;
  index: number;
  value: SimValue;
  previous: SimValue;
}

/** Una escritura que dejó ABRIR y CERRAR de la misma válvula a 1 a la vez en la palabra del maestro. */
export interface SimViolation {
  at: string;
  ms: number;
  writeSeq: number;
  plantId: string;
  valve: string;
  element: string;
  value: SimValue;
  previous: SimValue;
  reason: string;
}

export interface SimTransition {
  at: string;
  ms: number;
  from: SimValveState;
  to: SimValveState;
  reason: string;
}

export interface SimFeedbackView {
  element: string;
  origin: 'readBack' | 'until' | 'stateWord' | 'flow' | 'scenario';
  value: SimValue | null;
}

export interface SimValveView {
  plantId: string;
  domainKey: string;
  label: string | null;
  state: SimValveState;
  /** 0 = cerrada, 1 = abierta. */
  position: number;
  latchMode: SimLatchMode;
  travelMs: number;
  /** +1 abriendo, −1 cerrando, 0 quieta. */
  drive: -1 | 0 | 1;
  openVerb: string | null;
  closeVerb: string | null;
  /** ¿Ve el PLC LOCAL el verbo puesto (su copia de la palabra)? */
  localOpenActive: boolean;
  localCloseActive: boolean;
  error: { at: string; reason: string } | null;
  errorsTotal: number;
  violationsTotal: number;
  feedback: SimFeedbackView[];
  transitions: SimTransition[];
  warnings: string[];
}

export interface SimPlantView extends SimPlantConfig {
  plantId: string;
}

export interface SimulationReport {
  scenario: { name: string; source: string | null; mappingPath: string | null };
  ioLatencyMs: number;
  plants: SimPlantView[];
  valves: SimValveView[];
  writesTotal: number;
  violationsTotal: number;
  errorsTotal: number;
}

interface Condicion {
  clave: string;
  descripcion: string;
  cumple: (v: SimValue | undefined) => boolean;
}

interface Regla {
  clave: string;
  /** Booleano o numérico: decide el valor "neutro" y el redondeo. */
  booleano: boolean;
  entero: boolean;
  origen: SimFeedbackView['origin'];
  /** undefined = no escribir (se queda lo que hubiera). */
  valor: (v: Valvula) => SimValue | undefined;
  /** La válvula dueña de la regla; se fija al registrarla. */
  valvula?: Valvula;
}

interface Valvula {
  plantId: string;
  domainKey: string;
  clave: string;
  label: string | null;
  cfg: SimValveConfig;
  verboAbrir: string | null;
  verboCerrar: string | null;
  abrirSi: Condicion[];
  cerrarSi: Condicion[];
  posicion: number;
  drive: -1 | 0 | 1;
  abrirLocal: boolean;
  cerrarLocal: boolean;
  abrirAntes: boolean;
  cerrarAntes: boolean;
  error: { at: string; reason: string } | null;
  erroresTotal: number;
  violacionesTotal: number;
  estado: SimValveState;
  transiciones: SimTransition[];
  reglas: Regla[];
  avisos: string[];
}

interface Planta {
  plantId: string;
  cfg: SimPlantConfig;
  valvulas: Valvula[];
  /** Elementos de la palabra de mando que el PLC local copia en cada ciclo de la MSG. */
  clavesDeMando: Set<string>;
  canalDe: Map<string, string>;
  copiaLocal: Map<string, SimValue>;
  reglas: Regla[];
}

/**
 * Señal sintética de una entrada sin dueño: la misma onda que el simulador emitió siempre (un seno por
 * índice), con dos decimales. `Math.round(x·100)/100` en vez de `Number(x.toFixed(2))`: mismo valor y
 * una fracción del coste, que importa porque se calcula para cada elemento de cada frame.
 */
function valorSintetico(booleano: boolean, ahora: number, index: number): SimValue {
  const t = ahora / 1000;
  return booleano ? Math.sin(t + index) > 0 : Math.round((50 + 40 * Math.sin(t / 5 + index)) * 100) / 100;
}

function energiza(v: SimValue): boolean {
  return v !== 0 && v !== false;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** El primer instante de muestreo ESTRICTAMENTE posterior a `despues`. */
function siguienteInstante(despues: number, t0: number, fase: number, ciclo: number): number {
  const base = t0 + fase;
  if (despues < base) return base;
  return base + (Math.floor((despues - base) / ciclo) + 1) * ciclo;
}

function esInstante(t: number, t0: number, fase: number, ciclo: number): boolean {
  const desde = t - t0 - fase;
  return desde >= 0 && desde % ciclo === 0;
}

/**
 * Condiciones para que el PLC local considere puesto un verbo, leídas del write spec:
 *  - orden simple en `bitmask`: todos los bits del valor puestos en la palabra;
 *  - orden simple en `absolute`: la palabra vale exactamente eso;
 *  - orden compuesta (`sequences`): cada posición ENERGIZADA del verbo con su valor.
 * Un verbo que vale 0/false no energiza nada (igual que en `WriteService.applyValue`): no mueve.
 */
function condicionesDelVerbo(plantId: string, w: WriteSpec, verbo: string | null): Condicion[] {
  if (!verbo) return [];
  const pasos = w.sequences?.[verbo];
  if (pasos) {
    return pasos
      .filter((p) => energiza(p.value))
      .map((p) => ({
        clave: claveDeElemento({ plantId, sourceBuffer: w.target.sourceBuffer, index: p.index }),
        descripcion: `${w.target.sourceBuffer}[${p.index}] = ${String(p.value)}`,
        cumple: (v: SimValue | undefined) => v === p.value,
      }));
  }
  const valor = w.commands[verbo];
  if (valor === undefined || !energiza(valor)) return [];
  const clave = claveDeElemento({ plantId, sourceBuffer: w.target.sourceBuffer, index: w.target.index });
  if (w.mode === 'bitmask' && typeof valor === 'number') {
    const mascara = valor & 0xffff;
    if (mascara === 0) return [];
    return [
      {
        clave,
        descripcion: `${w.target.sourceBuffer}[${w.target.index}] & ${mascara}`,
        cumple: (v) => typeof v === 'number' && (v & mascara) === mascara,
      },
    ];
  }
  return [{ clave, descripcion: `${w.target.sourceBuffer}[${w.target.index}] = ${String(valor)}`, cumple: (v) => v === valor }];
}

function activo(condiciones: Condicion[], leer: (clave: string) => SimValue | undefined): boolean {
  return condiciones.length > 0 && condiciones.every((c) => c.cumple(leer(c.clave)));
}

export class SimulatedPlc {
  private readonly logger = new Logger('SimuladorPLC');
  private readonly maestro = new Map<string, SimValue>();
  /** `plantId/browseName` → buffer: se consulta por elemento en cada frame, tiene que ser O(1). */
  private readonly buffers = new Map<string, MonitorTarget>();
  private readonly escritosPorBackend = new Set<string>();
  private readonly plantas = new Map<string, Planta>();
  private readonly valvulas: Valvula[] = [];
  private readonly valvulasPorClave = new Map<string, Valvula[]>();
  /** Elementos de entrada con dueño (realimentación o valor inicial): nunca llevan ruido. */
  private readonly conDueno = new Set<string>();
  private readonly historial: SimWrite[] = [];
  private readonly violaciones: SimViolation[] = [];
  private secuencia = 0;
  private escriturasTotal = 0;
  private violacionesTotal = 0;
  private erroresTotal = 0;
  private ultimo: number;
  private readonly sinteticos: boolean;
  private readonly capacidad: number;

  /**
   * @param opts null = modo heredado: sin válvulas ni MSG, solo memoria y entradas sintéticas (lo que
   *   usan los tests anteriores a este simulador).
   * @param t0 instante de arranque: origen de las fases de la MSG.
   */
  constructor(
    private readonly mapping: LoadedMapping,
    private readonly opts: SimulatorOptions | null,
    private readonly t0: number,
  ) {
    this.ultimo = t0;
    for (const t of mapping.targets) this.buffers.set(`${t.plantId}/${t.browseName}`, t);
    this.sinteticos = opts?.syntheticInputs ?? true;
    this.capacidad = opts?.historyCapacity ?? 5_000;
    if (!opts) return;

    for (const [ref, valor] of Object.entries(opts.initialValues)) {
      const corte = ref.indexOf('/');
      const partes = partirElemento(ref.slice(corte + 1));
      if (!partes) continue;
      const clave = claveDeElemento({ plantId: ref.slice(0, corte), sourceBuffer: partes.buffer, index: partes.index });
      this.maestro.set(clave, valor);
      const buffer = this.buffer(ref.slice(0, corte), partes.buffer);
      if (buffer && CANALES_DE_ENTRADA.has(buffer.channel)) this.conDueno.add(clave);
    }

    for (const s of mapping.signals) {
      if (s.writable && s.write) this.construirValvula(s, s.write, opts);
    }
    // Arranque sincronizado: la copia local nace igual que el maestro y la realimentación ya refleja
    // el estado inicial de cada válvula. Sin esto, el primer frame enseñaría un estado que nadie pidió.
    for (const p of this.plantas.values()) {
      for (const clave of p.clavesDeMando) p.copiaLocal.set(clave, this.valorMaestro(clave, p.canalDe.get(clave) ?? 'intOut'));
      // Lo que ya estuviera puesto al arrancar NO cuenta como flanco: en `latch` solo mueve una orden
      // nueva. En `hold`, en cambio, un bit que arranca puesto mueve la válvula (como en el PLC real).
      const leerLocal = (c: string) => p.copiaLocal.get(c);
      for (const v of p.valvulas) {
        v.abrirAntes = activo(v.abrirSi, leerLocal);
        v.cerrarAntes = activo(v.cerrarSi, leerLocal);
      }
      this.recalcularMando(p, t0, 'arranque');
      this.publicarRealimentacion(p);
    }
  }

  // ── API para el adaptador ─────────────────────────────────────────────────────────

  /** Lleva el modelo hasta `ahora`: muestreos de la MSG, recorrido de las válvulas, realimentación. */
  advance(ahora: number): void {
    if (!(ahora > this.ultimo)) return;
    for (let guarda = 0; guarda < 10_000_000; guarda++) {
      let t = Infinity;
      for (const p of this.plantas.values()) {
        if (p.cfg.msgCycleMs > 0) t = Math.min(t, siguienteInstante(this.ultimo, this.t0, p.cfg.msgPhaseMs, p.cfg.msgCycleMs));
        if (p.cfg.feedbackCycleMs > 0) {
          t = Math.min(t, siguienteInstante(this.ultimo, this.t0, p.cfg.feedbackPhaseMs, p.cfg.feedbackCycleMs));
        }
      }
      if (t > ahora) break;
      this.integrar(t);
      for (const p of this.plantas.values()) {
        if (p.cfg.msgCycleMs > 0 && esInstante(t, this.t0, p.cfg.msgPhaseMs, p.cfg.msgCycleMs)) this.muestrearMando(p, t);
      }
      for (const p of this.plantas.values()) {
        if (p.cfg.feedbackCycleMs > 0 && esInstante(t, this.t0, p.cfg.feedbackPhaseMs, p.cfg.feedbackCycleMs)) {
          this.publicarRealimentacion(p);
        }
      }
    }
    this.integrar(ahora);
  }

  /** Lectura de un elemento, como la vería un cliente OPC UA en `ahora`. */
  leer(ref: SimElementRef, ahora: number): SimValue {
    this.advance(ahora);
    return this.valorActual(ref, ahora);
  }

  /** Escritura del BACKEND sobre el maestro. Queda en el historial y se comprueba la exclusión. */
  escribir(ref: SimElementRef, valor: SimValue, ahora: number): SimWrite {
    this.advance(ahora);
    const clave = claveDeElemento(ref);
    const previo = this.valorActual(ref, ahora);
    this.maestro.set(clave, valor);
    this.escritosPorBackend.add(clave);

    const registro: SimWrite = {
      seq: ++this.secuencia,
      at: iso(ahora),
      ms: ahora,
      plantId: ref.plantId,
      channel: ref.channel,
      sourceBuffer: ref.sourceBuffer,
      index: ref.index,
      value: valor,
      previous: previo,
    };
    this.historial.push(registro);
    this.escriturasTotal++;
    if (this.historial.length > this.capacidad) this.historial.splice(0, this.historial.length - this.capacidad);

    for (const v of this.valvulasPorClave.get(clave) ?? []) {
      const leerMaestro = (c: string) => this.valorMaestro(c, this.plantas.get(v.plantId)?.canalDe.get(c) ?? 'intOut');
      if (activo(v.abrirSi, leerMaestro) && activo(v.cerrarSi, leerMaestro)) this.registrarViolacion(v, registro);
    }

    // Con la MSG instantánea el PLC local ve la escritura en el acto.
    const planta = this.plantas.get(ref.plantId);
    if (planta && planta.cfg.msgCycleMs === 0 && planta.clavesDeMando.has(clave)) this.muestrearMando(planta, ahora);
    return registro;
  }

  /** ¿Escribió el backend alguna vez en este elemento? (perilla heredada `setWriteConfirms`). */
  fueEscritoPorBackend(ref: SimElementRef): boolean {
    return this.escritosPorBackend.has(claveDeElemento(ref));
  }

  /**
   * Valores de un buffer completo para un frame. Es el camino caliente (todos los buffers de todas las
   * plantas en cada tick): mismo resultado que `valorActual` elemento a elemento, sin búsquedas.
   */
  valoresDelBuffer(target: MonitorTarget, ahora: number): (number | boolean)[] {
    this.advance(ahora);
    const largo = target.arrayLength ?? 4;
    const prefijo = `${target.plantId}/${target.browseName}[`;
    const booleano = CANALES_BOOLEANOS.has(target.channel);
    const conRuido = this.sinteticos && CANALES_DE_ENTRADA.has(target.channel) && this.buffers.has(`${target.plantId}/${target.browseName}`);
    const valores: (number | boolean)[] = new Array(largo);
    for (let i = 0; i < largo; i++) {
      const clave = prefijo + i + ']';
      const v = this.maestro.get(clave);
      if (v !== undefined) valores[i] = v;
      else if (!conRuido || this.conDueno.has(clave)) valores[i] = booleano ? false : 0;
      else valores[i] = valorSintetico(booleano, ahora, i);
    }
    return valores;
  }

  // ── Diagnóstico y perillas (endpoints /api/opc/sim y tests) ──────────────────────

  informe(ahora: number): SimulationReport {
    this.advance(ahora);
    return {
      scenario: {
        name: this.opts?.name ?? 'heredado (sin modelo de válvulas)',
        source: this.opts?.source ?? null,
        mappingPath: this.opts?.mappingPath ?? null,
      },
      ioLatencyMs: this.opts?.ioLatencyMs ?? 0,
      plants: [...this.plantas.values()].map((p) => ({ plantId: p.plantId, ...p.cfg })),
      valves: this.valvulas.map((v) => this.vista(v)),
      writesTotal: this.escriturasTotal,
      violationsTotal: this.violacionesTotal,
      errorsTotal: this.erroresTotal,
    };
  }

  valvula(plantId: string, domainKey: string, ahora: number): SimValveView | null {
    this.advance(ahora);
    const v = this.buscar(plantId, domainKey);
    return v ? this.vista(v) : null;
  }

  escrituras(): SimWrite[] {
    return [...this.historial];
  }

  violacionesRegistradas(): SimViolation[] {
    return [...this.violaciones];
  }

  /** Mete la válvula en ERROR como lo haría el PLC (para probar cómo lo vive la app). */
  forzarError(plantId: string, domainKey: string, motivo: string, ahora: number): SimValveView | null {
    this.advance(ahora);
    const v = this.buscar(plantId, domainKey);
    if (!v) return null;
    this.entrarEnError(v, ahora, motivo);
    const p = this.plantas.get(plantId);
    if (p && p.cfg.feedbackCycleMs === 0) this.publicarRealimentacion(p);
    return this.vista(v);
  }

  /** Sale del ERROR. El mando se recalcula con lo que el PLC local ve en ese momento. */
  rearmar(plantId: string, domainKey: string, ahora: number): SimValveView | null {
    this.advance(ahora);
    const v = this.buscar(plantId, domainKey);
    const p = this.plantas.get(plantId);
    if (!v || !p) return null;
    if (v.error) {
      v.error = null;
      this.logger.warn(`[sim] ${v.clave}: ERROR rearmado a mano`);
    }
    this.recalcularMando(p, ahora, 'rearme');
    return this.vista(v);
  }

  cambiarModo(plantId: string, domainKey: string, modo: SimLatchMode, ahora: number): SimValveView | null {
    this.advance(ahora);
    const v = this.buscar(plantId, domainKey);
    const p = this.plantas.get(plantId);
    if (!v || !p) return null;
    v.cfg = { ...v.cfg, latchMode: modo };
    this.logger.log(`[sim] ${v.clave}: modo de enclavamiento → ${modo}`);
    this.recalcularMando(p, ahora, `modo ${modo}`);
    return this.vista(v);
  }

  // ── Interno: memoria ──────────────────────────────────────────────────────────────

  private buffer(plantId: string, browseName: string): MonitorTarget | undefined {
    return this.buffers.get(`${plantId}/${browseName}`);
  }

  private valorMaestro(clave: string, canal: string): SimValue {
    const v = this.maestro.get(clave);
    if (v !== undefined) return v;
    return CANALES_BOOLEANOS.has(canal) ? false : 0;
  }

  private valorActual(ref: SimElementRef, ahora: number): SimValue {
    const clave = claveDeElemento(ref);
    const v = this.maestro.get(clave);
    if (v !== undefined) return v;
    const booleano = CANALES_BOOLEANOS.has(ref.channel);
    // Solo las ENTRADAS de un buffer conocido llevan ruido. Una salida que nadie escribió vale 0/false:
    // es lo que hay en un PLC recién arrancado, y lo que permite leer un frame sin adivinar.
    if (!this.sinteticos || !CANALES_DE_ENTRADA.has(ref.channel) || this.conDueno.has(clave) || !this.buffer(ref.plantId, ref.sourceBuffer)) {
      return booleano ? false : 0;
    }
    return valorSintetico(booleano, ahora, ref.index);
  }

  // ── Interno: dinámica ─────────────────────────────────────────────────────────────

  private integrar(hasta: number): void {
    if (hasta <= this.ultimo) return;
    const desde = this.ultimo;
    for (const v of this.valvulas) this.mover(v, desde, hasta);
    this.ultimo = hasta;
    for (const p of this.plantas.values()) if (p.cfg.feedbackCycleMs === 0) this.publicarRealimentacion(p);
  }

  private mover(v: Valvula, desde: number, hasta: number): void {
    if (v.error || v.drive === 0) return;
    const objetivo = v.drive > 0 ? 1 : 0;
    const restante = Math.abs(objetivo - v.posicion);
    if (restante > EPS) {
      const necesario = v.cfg.travelMs > 0 ? restante * v.cfg.travelMs : 0;
      const dt = hasta - desde;
      if (dt >= necesario) {
        v.posicion = objetivo;
        const llegada = desde + necesario;
        if (v.cfg.latchMode === 'latch') v.drive = 0;
        this.actualizarEstado(v, llegada, 'fin de recorrido');
        return;
      }
      v.posicion += (v.drive * dt) / v.cfg.travelMs;
      v.posicion = Math.min(1, Math.max(0, v.posicion));
      this.actualizarEstado(v, hasta, 'recorrido');
      return;
    }
    if (v.cfg.latchMode === 'latch') {
      v.drive = 0;
      this.actualizarEstado(v, hasta, 'ya estaba en el tope');
    }
  }

  private muestrearMando(p: Planta, t: number): void {
    for (const clave of p.clavesDeMando) p.copiaLocal.set(clave, this.valorMaestro(clave, p.canalDe.get(clave) ?? 'intOut'));
    this.recalcularMando(p, t, 'ciclo MSG');
  }

  private recalcularMando(p: Planta, t: number, motivo: string): void {
    const leerLocal = (c: string) => p.copiaLocal.get(c);
    for (const v of p.valvulas) {
      const abrir = activo(v.abrirSi, leerLocal);
      const cerrar = activo(v.cerrarSi, leerLocal);
      v.abrirLocal = abrir;
      v.cerrarLocal = cerrar;
      if (abrir && cerrar) {
        if (!v.error) {
          const detalle = [...v.abrirSi, ...v.cerrarSi].map((c) => c.descripcion).join(' y ');
          this.entrarEnError(v, t, `el PLC local ve ABRIR y CERRAR a 1 a la vez (${detalle})`);
        }
      } else if (!v.error) {
        if (v.cfg.latchMode === 'hold') v.drive = abrir ? 1 : cerrar ? -1 : 0;
        else if (abrir && !v.abrirAntes) v.drive = 1;
        else if (cerrar && !v.cerrarAntes) v.drive = -1;
        if (v.drive !== 0 && v.cfg.travelMs === 0) v.posicion = v.drive > 0 ? 1 : 0;
        if (v.cfg.latchMode === 'latch' && ((v.drive > 0 && v.posicion >= 1 - EPS) || (v.drive < 0 && v.posicion <= EPS))) {
          v.drive = 0;
        }
      }
      v.abrirAntes = abrir;
      v.cerrarAntes = cerrar;
      this.actualizarEstado(v, t, motivo);
    }
    if (p.cfg.feedbackCycleMs === 0) this.publicarRealimentacion(p);
  }

  /** Copia al maestro lo que el PLC local está informando (la MSG_READ de vuelta). */
  private publicarRealimentacion(p: Planta): void {
    for (const r of p.reglas) {
      if (!r.valvula) continue;
      const valor = r.valor(r.valvula);
      if (valor !== undefined) this.maestro.set(r.clave, valor);
    }
  }

  private estadoDe(v: Valvula): SimValveState {
    if (v.error) return 'error';
    if (v.drive > 0 && v.posicion < 1 - EPS) return 'opening';
    if (v.drive < 0 && v.posicion > EPS) return 'closing';
    if (v.posicion >= 1 - EPS) return 'open';
    if (v.posicion <= EPS) return 'closed';
    return 'mid';
  }

  private actualizarEstado(v: Valvula, t: number, motivo: string): void {
    const nuevo = this.estadoDe(v);
    if (nuevo === v.estado) return;
    const tr: SimTransition = { at: iso(t), ms: t, from: v.estado, to: nuevo, reason: motivo };
    v.transiciones.push(tr);
    if (v.transiciones.length > MAX_TRANSICIONES) v.transiciones.shift();
    v.estado = nuevo;
    if (nuevo !== 'error') this.logger.log(`[sim] ${v.clave}: ${tr.from} → ${tr.to} (${motivo}, posición ${v.posicion.toFixed(3)})`);
  }

  private entrarEnError(v: Valvula, t: number, motivo: string): void {
    v.error = { at: iso(t), reason: motivo };
    v.drive = 0;
    v.erroresTotal++;
    this.erroresTotal++;
    this.logger.error(`⛔ [sim] ${v.clave} en ERROR: ${motivo}. La válvula se para y no se mueve hasta un rearme.`);
    this.actualizarEstado(v, t, motivo);
  }

  private registrarViolacion(v: Valvula, w: SimWrite): void {
    const detalle = [...v.abrirSi, ...v.cerrarSi].map((c) => c.descripcion).join(' y ');
    const violacion: SimViolation = {
      at: w.at,
      ms: w.ms,
      writeSeq: w.seq,
      plantId: v.plantId,
      valve: v.domainKey,
      element: claveDeElemento(w),
      value: w.value,
      previous: w.previous,
      reason: `la escritura #${w.seq} dejó ABRIR y CERRAR a 1 a la vez en el maestro (${detalle})`,
    };
    this.violaciones.push(violacion);
    if (this.violaciones.length > MAX_VIOLACIONES) this.violaciones.shift();
    this.violacionesTotal++;
    v.violacionesTotal++;
    this.logger.error(
      `⛔ [sim] VIOLACIÓN en ${v.clave}: ${violacion.reason}; ${String(w.previous)} → ${String(w.value)} en ${violacion.element}`,
    );
  }

  private buscar(plantId: string, domainKey: string): Valvula | undefined {
    return this.valvulas.find((v) => v.plantId === plantId && v.domainKey === domainKey);
  }

  private vista(v: Valvula): SimValveView {
    return {
      plantId: v.plantId,
      domainKey: v.domainKey,
      label: v.label,
      state: this.estadoDe(v),
      position: Math.round(v.posicion * 1000) / 1000,
      latchMode: v.cfg.latchMode,
      travelMs: v.cfg.travelMs,
      drive: v.drive,
      openVerb: v.verboAbrir,
      closeVerb: v.verboCerrar,
      localOpenActive: v.abrirLocal,
      localCloseActive: v.cerrarLocal,
      error: v.error,
      errorsTotal: v.erroresTotal,
      violationsTotal: v.violacionesTotal,
      feedback: v.reglas.map((r) => ({ element: r.clave, origin: r.origen, value: this.maestro.get(r.clave) ?? null })),
      transitions: [...v.transiciones],
      warnings: [...v.avisos],
    };
  }

  // ── Construcción del modelo desde el mapping ──────────────────────────────────────

  private planta(plantId: string, opts: SimulatorOptions): Planta {
    let p = this.plantas.get(plantId);
    if (!p) {
      p = {
        plantId,
        cfg: configDePlanta(opts, plantId),
        valvulas: [],
        clavesDeMando: new Set(),
        canalDe: new Map(),
        copiaLocal: new Map(),
        reglas: [],
      };
      this.plantas.set(plantId, p);
    }
    return p;
  }

  private construirValvula(s: SignalMapping, w: WriteSpec, opts: SimulatorOptions): void {
    const cfg = configDeValvula(opts, s.plantId, s.domainKey);
    const verboAbrir = cfg.verbs.open in w.commands ? cfg.verbs.open : null;
    const verboCerrar = cfg.verbs.close in w.commands ? cfg.verbs.close : null;
    const v: Valvula = {
      plantId: s.plantId,
      domainKey: s.domainKey,
      clave: `${s.plantId}/${s.domainKey}`,
      label: s.label,
      cfg,
      verboAbrir,
      verboCerrar,
      abrirSi: condicionesDelVerbo(s.plantId, w, verboAbrir),
      cerrarSi: condicionesDelVerbo(s.plantId, w, verboCerrar),
      posicion: cfg.initialState === 'open' ? 1 : 0,
      drive: 0,
      abrirLocal: false,
      cerrarLocal: false,
      abrirAntes: false,
      cerrarAntes: false,
      error: null,
      erroresTotal: 0,
      violacionesTotal: 0,
      estado: cfg.initialState === 'open' ? 'open' : 'closed',
      transiciones: [],
      reglas: [],
      avisos: [],
    };
    if (!verboAbrir && !verboCerrar) {
      v.avisos.push(`sin verbos "${cfg.verbs.open}"/"${cfg.verbs.close}" en write.commands: la válvula simulada no se mueve`);
    }

    const p = this.planta(s.plantId, opts);
    p.valvulas.push(v);
    this.valvulas.push(v);
    for (const c of [...v.abrirSi, ...v.cerrarSi]) {
      p.clavesDeMando.add(c.clave);
      p.canalDe.set(c.clave, w.target.channel);
      const lista = this.valvulasPorClave.get(c.clave) ?? [];
      if (!lista.includes(v)) lista.push(v);
      this.valvulasPorClave.set(c.clave, lista);
    }

    const reglas = [
      ...(cfg.feedback === 'auto' ? this.reglasAutomaticas(s, w, v) : []),
      ...this.reglasDelEscenario(s.plantId, v, cfg.feedbackElements),
    ];
    // Lo declarado a mano en el escenario MANDA sobre lo deducido para el mismo elemento.
    const manuales = new Set(reglas.filter((r) => r.origen === 'scenario').map((r) => r.clave));
    for (const r of reglas) {
      if (r.origen !== 'scenario' && manuales.has(r.clave)) continue;
      if (p.reglas.some((otra) => otra.clave === r.clave)) {
        v.avisos.push(`${r.clave} (${r.origen}): otra regla de realimentación ya escribe en ese elemento; se queda la primera`);
        continue;
      }
      r.valvula = v;
      v.reglas.push(r);
      p.reglas.push(r);
      this.conDueno.add(r.clave);
      if (this.maestro.has(r.clave)) {
        v.avisos.push(`${r.clave}: tenía valor inicial en el escenario, pero lo pisa la realimentación de la válvula`);
      }
    }
    for (const a of v.avisos) this.logger.warn(`[sim] ${v.clave}: ${a}`);
  }

  /** Elemento de un buffer de ENTRADA de la planta, o null con aviso. */
  private elementoDeEntrada(
    v: Valvula,
    canal: string,
    sourceBuffer: string,
    index: number,
    que: string,
  ): { clave: string; booleano: boolean; entero: boolean } | null {
    const b = this.buffer(v.plantId, sourceBuffer);
    if (!b || b.channel !== canal) {
      v.avisos.push(`${que}: ${canal}/${sourceBuffer} no existe en la planta; no se emula`);
      return null;
    }
    if (b.arrayLength !== null && index >= b.arrayLength) {
      v.avisos.push(`${que}: ${sourceBuffer}[${index}] fuera de rango (${b.arrayLength}); no se emula`);
      return null;
    }
    // Un elemento de SALIDA lo escribe el maestro, no el PLC local: emularlo pisaría el eco del mando.
    if (CANALES_DE_SALIDA.has(canal)) return null;
    return {
      clave: claveDeElemento({ plantId: v.plantId, sourceBuffer, index }),
      booleano: CANALES_BOOLEANOS.has(canal),
      entero: CANALES_ENTEROS.has(canal),
    };
  }

  private neutro(v: Valvula, booleano: boolean): SimValue {
    const o = v.cfg.otherStateValue;
    if (o !== null) return o;
    return booleano ? false : 0;
  }

  /**
   * Realimentación DEDUCIDA del mapping. Es un PLC ideal: hace exactamente lo que el mapping dice que
   * hará, y nada que el mapping no diga. Por eso NO se emula:
   *  - un read-back sin valor esperado declarado (Carbonero hoy): inventar uno daría un verde falso;
   *  - un read-back AMBIGUO, que espera el mismo valor para abrir y para cerrar (el `expectedValue`
   *    único de La Vorágine): ese número no puede decir en qué tope está la válvula.
   */
  private reglasAutomaticas(s: SignalMapping, w: WriteSpec, v: Valvula): Regla[] {
    const reglas: Regla[] = [];
    const rb = w.readBack;
    const rbBuffer = rb.sourceBuffer ?? w.target.sourceBuffer;
    const esElMando = rbBuffer === w.target.sourceBuffer && rb.index === w.target.index;
    let claveReadBack: string | null = null;

    if (!esElMando) {
      const el = this.elementoDeEntrada(v, rb.channel, rbBuffer, rb.index, 'readBack');
      if (el) {
        claveReadBack = el.clave;
        const declarado = (verbo: string | null): SimValue | undefined => {
          if (!verbo) return undefined;
          const porVerbo = rb.expectedByCommand?.[verbo];
          if (porVerbo !== undefined) return porVerbo;
          if (rb.confirmsWrittenValue) return w.commands[verbo];
          return rb.expectedValue;
        };
        const abierta = declarado(v.verboAbrir);
        const cerrada = declarado(v.verboCerrar);
        if (abierta === undefined && cerrada === undefined) {
          v.avisos.push(`readBack ${el.clave}: el mapping no declara qué valor confirma cada verbo; no se emula (resultado esperado: sent/failed, como en campo)`);
        } else if (abierta !== undefined && cerrada !== undefined && abierta === cerrada) {
          v.avisos.push(`readBack ${el.clave}: AMBIGUO, abrir y cerrar esperan el mismo valor (${String(abierta)}); no puede decir en qué tope está, no se emula`);
        } else {
          reglas.push({
            clave: el.clave,
            booleano: el.booleano,
            entero: el.entero,
            origen: 'readBack',
            valor: (x) => {
              const estado = this.estadoDe(x);
              if (estado === 'open' && abierta !== undefined) return abierta;
              if (estado === 'closed' && cerrada !== undefined) return cerrada;
              return this.neutro(x, el.booleano);
            },
          });
        }
      }
    }

    const until = w.pulse?.until;
    if (until) {
      const buffer = until.sourceBuffer ?? rb.sourceBuffer ?? w.target.sourceBuffer;
      const el = this.elementoDeEntrada(v, until.channel, buffer, until.index, 'pulse.until');
      if (el && el.clave === claveReadBack) {
        v.avisos.push(`pulse.until ${el.clave}: es el mismo elemento que el readBack; se emula solo como readBack`);
      } else if (el) {
        const reposo: SimValue =
          v.cfg.untilIdleValue ?? (typeof until.equals === 'boolean' ? !until.equals : until.equals === 0 ? 1 : 0);
        reglas.push({
          clave: el.clave,
          booleano: el.booleano,
          entero: el.entero,
          origen: 'until',
          // El final de carrera de la dirección MANDADA: vale `equals` solo con el verbo puesto en el PLC
          // local y la válvula en ese tope. En reposo, el valor de reposo (Vorágine: 1025, no 1).
          valor: (x) => {
            if (x.error) return reposo;
            if (x.abrirLocal && !x.cerrarLocal && x.posicion >= 1 - EPS) return until.equals;
            if (x.cerrarLocal && !x.abrirLocal && x.posicion <= EPS) return until.equals;
            return reposo;
          },
        });
      }
    }

    // Palabra de estado `valveNState` con convención LITERAL (stateEncoding), si no es ya el readBack.
    const estado = this.mapping.signals.find((x) => x.plantId === s.plantId && x.domainKey === `${s.domainKey}State`);
    if (estado?.stateEncoding) {
      const b = bufferDeLaSenal(this.mapping, s.plantId, estado.buffer, estado.sourceBuffer);
      const el = b ? this.elementoDeEntrada(v, b.channel, b.browseName, estado.index, `${estado.domainKey}`) : null;
      if (el && el.clave !== claveReadBack) {
        const enc = estado.stateEncoding;
        reglas.push({
          clave: el.clave,
          booleano: el.booleano,
          entero: el.entero,
          origen: 'stateWord',
          valor: (x) => {
            const e = this.estadoDe(x);
            if (e === 'open' && enc.open !== undefined) return enc.open;
            if (e === 'closed' && enc.closed !== undefined) return enc.closed;
            return this.neutro(x, el.booleano);
          },
        });
      }
    }

    // Caudal de ESA válvula (flowDomainKey): proporcional a la apertura. Es lo que mira la app cuando la
    // palabra de estado no es fiable (La Sirena) o no existe (Carbonero).
    if (s.flowDomainKey) {
      const caudal = this.mapping.signals.find((x) => x.plantId === s.plantId && x.domainKey === s.flowDomainKey);
      const b = caudal ? bufferDeLaSenal(this.mapping, s.plantId, caudal.buffer, caudal.sourceBuffer) : undefined;
      const el = caudal && b ? this.elementoDeEntrada(v, b.channel, b.browseName, caudal.index, `caudal ${s.flowDomainKey}`) : null;
      if (el) {
        reglas.push({
          clave: el.clave,
          booleano: el.booleano,
          entero: el.entero,
          origen: 'flow',
          valor: (x) => {
            const q = x.posicion * x.cfg.flowOpen;
            return el.entero ? Math.round(q) : Math.round(q * 100) / 100;
          },
        });
      }
    }
    return reglas;
  }

  private reglasDelEscenario(plantId: string, v: Valvula, elementos: SimFeedbackElement[]): Regla[] {
    const reglas: Regla[] = [];
    for (const e of elementos) {
      const partes = partirElemento(e.element);
      const b = partes ? this.buffer(plantId, partes.buffer) : undefined;
      if (!partes || !b) {
        v.avisos.push(`feedbackElements ${e.element}: no existe en ${plantId}`);
        continue;
      }
      const el = this.elementoDeEntrada(v, b.channel, b.browseName, partes.index, `feedbackElements ${e.element}`);
      if (!el) {
        if (CANALES_DE_SALIDA.has(b.channel)) v.avisos.push(`feedbackElements ${e.element}: es una SALIDA; el PLC local no la escribe`);
        continue;
      }
      reglas.push({
        clave: el.clave,
        booleano: el.booleano,
        entero: el.entero,
        origen: 'scenario',
        valor: (x) => {
          switch (this.estadoDe(x)) {
            case 'open':
              return e.open;
            case 'closed':
              return e.closed;
            case 'opening':
            case 'closing':
              return e.moving ?? e.mid;
            case 'mid':
              return e.mid ?? e.moving;
            case 'error':
              return e.error ?? e.mid ?? e.moving;
          }
        },
      });
    }
    return reglas;
  }
}
