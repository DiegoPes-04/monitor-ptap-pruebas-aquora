/**
 * Fase 5 — validación del mapping de comandos (criterio de aceptación):
 *  - una señal writable puede ser confirmed o inferred, pero NUNCA estimated;
 *  - una señal writable DEBE declarar su write spec;
 *  - el mapping de PRODUCCIÓN no tiene NINGUNA señal writable (sin L5X → seguro por defecto).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadJson, validateMapping } from '../scripts/validate-mapping';
import { motivoSecuenciaInvalida } from '../src/infrastructure/connectivity/mapping/opc-mapping.loader';

const schema = loadJson(join(__dirname, '..', 'config', 'opc_mapping.schema.json')) as object;

const OUT_BUFFER = { browseName: 'INT_OUT_TEST', node: { nsUri: 'AQUATECH', identifier: 's=IntOutTest' } };

function mappingWithSignal(signal: Record<string, unknown>): unknown {
  return {
    version: '1.0.0',
    protocolVersion: 'v2',
    dtoVersion: 'v1',
    plants: [
      {
        plantId: 'voragine',
        displayName: 'La Vorágine',
        displayNameProvisional: true,
        opcBuffers: { intOut: [OUT_BUFFER] },
        connection: { done: null, error: null, timeout: null, mappingStatus: 'unmapped', confidence: 'inferred' },
        signals: [signal],
      },
    ],
  };
}

const VALID_WRITE = {
  target: { channel: 'intOut', sourceBuffer: 'INT_OUT_TEST', index: 3 },
  commands: { openValve: 1, closeValve: 0 },
  readBack: { channel: 'intOut', sourceBuffer: 'INT_OUT_TEST', index: 3, confirmsWrittenValue: true },
  timeoutMs: 60,
  rollbackValue: 0,
  permission: 'control_valves',
};

test('mapping: una señal writable SÍ puede ser inferred (cambio del 2026-08-31)', () => {
  // Hasta el 2026-08-31 el schema exigía `confirmed` a toda señal escribible, y era correcto
  // mientras el mapeo solo se editaba por git con revisión. Al abrir la edición desde la app dejó de
  // serlo por el motivo contrario al que parece: forzar `confirmed` obligaría a que una codificación
  // capturada en campo y tecleada en un móvil se declarara respaldada por documentación oficial, y
  // después nadie podría distinguir cuál se verificó de verdad.
  const result = validateMapping(schema, mappingWithSignal({
    buffer: 'intOut', index: 3, domainKey: 'valveEV01', label: 'Válvula EV01',
    mappingStatus: 'mapped', confidence: 'inferred', writable: true, write: VALID_WRITE,
  }));
  assert.equal(result.ok, true, `debería validar, hubo: ${result.errors.join(' | ')}`);
});

test('mapping: una señal writable NUNCA puede ser estimated', () => {
  // Es el límite que sí se conserva: `estimated` significa derivado o calculado, y un valor
  // calculado no es un canal de mando. Abrir `inferred` no abre esto.
  const result = validateMapping(schema, mappingWithSignal({
    buffer: 'intOut', index: 3, domainKey: 'valveEV01', label: 'Válvula EV01',
    mappingStatus: 'mapped', confidence: 'estimated', writable: true, write: VALID_WRITE,
  }));
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /confidence|then/i.test(e)),
    `esperaba error de confidence, hubo: ${result.errors.join(' | ')}`,
  );
});

test('mapping: señal writable SIN write spec es rechazada por el schema', () => {
  const result = validateMapping(schema, mappingWithSignal({
    buffer: 'intOut', index: 3, domainKey: 'valveEV01',
    mappingStatus: 'mapped', confidence: 'confirmed', writable: true,
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /write/i.test(e)), `esperaba error de write requerido, hubo: ${result.errors.join(' | ')}`);
});

test('mapping: señal writable confirmed + write spec válido es aceptada', () => {
  const result = validateMapping(schema, mappingWithSignal({
    buffer: 'intOut', index: 3, domainKey: 'valveEV01',
    label: 'Válvula EV01', mappingStatus: 'mapped', confidence: 'confirmed', writable: true, write: VALID_WRITE,
  }));
  assert.equal(result.ok, true, `errores: ${result.errors.join(' | ')}`);
});

test('mapping: write.target.sourceBuffer inexistente es rechazado (validación semántica)', () => {
  const result = validateMapping(schema, mappingWithSignal({
    buffer: 'intOut', index: 3, domainKey: 'valveEV01',
    mappingStatus: 'mapped', confidence: 'confirmed', writable: true,
    write: { ...VALID_WRITE, target: { channel: 'intOut', sourceBuffer: 'NO_EXISTE', index: 3 } },
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /NO_EXISTE/.test(e)));
});

test('mapping de PRODUCCIÓN: la válvula 1 está en las 10 plantas CON canal de comando, y en ninguna más', () => {
  // Invariante (2026-07-30): la ruta de la válvula se replicó a todas las plantas por instrucción
  // del operador («mín. 1 válvula, se escribe por el canal 0, abrir = 4096 en todas»), tras
  // verificarla en campo en Sirena (docs/archivo/PRUEBA_VALVULA_SIRENA.md: pulso capturado por testigo
  // independiente + MSG al PLC sin errores).
  //
  // El límite que este test protege: SOLO las plantas que tienen buffers intOut+intIn pueden tener
  // válvula. `san-antonio` y `quijote` NO los tienen (son tanques retransmitidos en el buffer de
  // Soledad, sin canal propio) → inventarles una válvula escribiría en un buffer inexistente.
  // Si aparece una writable en una planta sin canal, o de otro tipo, este test debe fallar.
  const prod = loadJson(join(__dirname, '..', 'config', 'opc_mapping.json')) as {
    plants: Array<{
      plantId: string;
      opcBuffers?: Record<string, Array<{ browseName?: string }>>;
      signals?: Array<{ domainKey?: string; writable?: boolean }>;
    }>;
  };

  const conCanal = prod.plants.filter((p) => p.opcBuffers?.intOut?.[0] && p.opcBuffers?.intIn?.[0]).map((p) => p.plantId);
  const writables = prod.plants.flatMap((p) =>
    (p.signals ?? []).filter((s) => s.writable === true).map((s) => `${p.plantId}/${s.domainKey}`),
  );

  assert.deepEqual(writables, conCanal.map((id) => `${id}/valve1`), 'una valve1 por planta con canal de comando, y nada más');
  assert.equal(conCanal.length, 10, 'hoy son 10 plantas con canal (san-antonio y quijote no tienen intOut/intIn)');
  for (const sinCanal of ['san-antonio', 'quijote']) {
    assert.ok(!writables.some((w) => w.startsWith(`${sinCanal}/`)), `${sinCanal} NO debe tener válvula: no tiene canal donde escribir`);
  }
});

test('mapping de PRODUCCIÓN: La Vorágine tiene DOS válvulas y solo la de salida se acciona', () => {
  // El cliente confirmó el 2026-08-15 que La Vorágine tiene válvula de entrada Y de salida. De la
  // de entrada no se conoce su frecuencia de bits, así que existe para mostrarse pero NO para
  // mandarse.
  //
  // Este test hace falta porque la regla de «una valve1 por planta» filtra por `writable === true`:
  // una segunda válvula NO writable se colaría sin que ningún test se enterara, y con ella la
  // tentación de irle poniendo un write spec «provisional».
  const prod = loadJson(join(__dirname, '..', 'config', 'opc_mapping.json')) as {
    plants: Array<{
      plantId: string;
      signals?: Array<{ domainKey?: string; label?: string; writable?: boolean; write?: unknown; flowDomainKey?: string; _nota?: string }>;
    }>;
  };

  const conValve2 = prod.plants.filter((p) => (p.signals ?? []).some((s) => s.domainKey === 'valve2')).map((p) => p.plantId);
  assert.deepEqual(conValve2, ['voragine'], 'una segunda válvula exige confirmarla en campo, planta por planta');

  const voragine = prod.plants.find((p) => p.plantId === 'voragine');
  const entrada = (voragine?.signals ?? []).find((s) => s.domainKey === 'valve2');
  const salida = (voragine?.signals ?? []).find((s) => s.domainKey === 'valve1');

  // LO QUE DE VERDAD PROTEGE: que nadie le ponga mando a la de entrada sin dato de campo.
  assert.equal(entrada?.writable, false, 'la de entrada NO se acciona: no se conoce su frecuencia de bits');
  assert.equal(entrada?.write, undefined, 'sin write spec: inventarlo sería accionar equipo a ciegas');
  assert.ok(typeof entrada?._nota === 'string' && entrada._nota.length > 200, 'su índice es un ancla y eso debe estar escrito al lado');

  // Cada una con SU caudal, y declarado. Sin declararlo, el orden por defecto del front prefiere la
  // salida: la de ENTRADA se juzgaría con el caudal de salida y diría "abierta" con la entrada
  // cerrada y el tanque vaciándose aguas abajo.
  assert.equal(entrada?.flowDomainKey, 'inletFlow1');
  assert.equal(salida?.flowDomainKey, 'outletFlow1');
  for (const key of ['inletFlow1', 'outletFlow1']) {
    assert.ok((voragine?.signals ?? []).some((s) => s.domainKey === key), `${key} debe existir en la planta`);
  }

  // Anónimas no: con dos válvulas, "Válvula 1" y "Válvula 2" no le dicen nada a quien las opera.
  assert.match(String(salida?.label), /salida/i);
  assert.match(String(entrada?.label), /entrada/i);
});

// Hallazgo de campo 2026-07-30: replicar `valve1State` (intIn[0]) a ciegas publicaba un estado
// INVENTADO. Leyendo INT_IN[0] real: solo sirena tiene el patrón limpio 16384 (bit14); montebello
// (30250) y km18 (30101) tienen bit14 encendido por casualidad y habrían afirmado CERRADA/ABIERTA en
// falso. Este test impide que vuelva a colarse un estado sin verificar.
test('mapping de PRODUCCIÓN: solo las plantas con estado VERIFICADO exponen valve1State', () => {
  const prod = loadJson(join(__dirname, '..', 'config', 'opc_mapping.json')) as {
    plants: Array<{ plantId: string; signals?: Array<{ domainKey?: string }> }>;
  };
  const conEstado = prod.plants
    .filter((p) => (p.signals ?? []).some((s) => s.domainKey === 'valve1State'))
    .map((p) => p.plantId);
  assert.deepEqual(conEstado, ['cascajal', 'sirena'], 'añadir otra planta exige confirmar su índice/patrón en campo primero');

  // LA REGLA QUE DE VERDAD IMPORTA: exponer la palabra no es lo mismo que creerle. Cada una que
  // esté mapeada debe declarar POR QUÉ se le hace caso — o declarar que no se le hace.
  const porPlanta = new Map(
    prod.plants.map((p) => [
      p.plantId,
      (p.signals ?? []).find((s) => s.domainKey === 'valve1State') as
        | { stateEncoding?: { closed?: number }; stateTrusted?: boolean }
        | undefined,
    ]),
  );

  // Cascajal: el operador verificó en campo (2026-08-13) que su INT_IN[1] vale 251 con la válvula
  // cerrada. Declara `stateEncoding` en vez de confiar en la máscara de bits heredada.
  assert.deepEqual(porPlanta.get('cascajal')?.stateEncoding, { closed: 251 });

  // Sirena: se conserva MAPEADA a propósito —es la evidencia que necesita ValveStateObserver— pero
  // NO decide. Su INT_IN[0] pasó de 16384 a 17408 (= bit14 + bit10) con 23,33 l/s entrando: la app
  // decía CERRADA con la válvula claramente abierta. Y bit10 no significa "abierta", está encendido
  // en casi todas las plantas, con caudal (Carbonero) y sin él (Soledad, 0,00 l/s). El patrón
  // bit14/bit0 del protocolo de Vorágine no lo cumple ni la propia Vorágine, cuyo INT_IN[0] hoy es
  // 7176 y NO tiene bit14. Su veredicto sale del caudal de SALIDA, que es evidencia física.
  assert.equal(porPlanta.get('sirena')?.stateTrusted, false, 'la palabra de Sirena no está verificada: no puede decidir');
});

interface ProdWrite {
  target?: { index?: number };
  commands?: Record<string, number>;
  sequences?: Record<string, Array<{ index: number; value: number }>>;
  latched?: boolean;
  _riesgo?: string;
  mode?: string;
  pulse?: { holdMs?: number; until?: { channel?: string; sourceBuffer?: string; index?: number; equals?: number } };
  readBack?: { channel?: string; confirmsWrittenValue?: boolean; expectedValue?: number; stateVerified?: boolean };
  rollbackValue?: number;
}

function valvulasDeProduccion(): Array<{ plantId: string; w: ProdWrite | undefined }> {
  const prod = loadJson(join(__dirname, '..', 'config', 'opc_mapping.json')) as {
    plants: Array<{ plantId: string; signals?: Array<{ writable?: boolean; write?: ProdWrite }> }>;
  };
  return prod.plants.flatMap((p) => (p.signals ?? []).filter((s) => s.writable).map((s) => ({ plantId: p.plantId, w: s.write })));
}

test('mapping de PRODUCCIÓN: cada válvula escribe en el canal 0 con pulso y máscara de bits', () => {
  // Protege la forma verificada en campo: si alguien cambia el índice, el modo o quita el pulso,
  // el comando podría pisar bits ajenos o quedar ENCLAVADO (ver docs/archivo/PRUEBA_VALVULA_SIRENA.md).
  // La Sirena está fuera a propósito: ver el test siguiente. Carbonero comparte la forma (canal 0,
  // máscara, pulso) pero NO el 4096: su codificación la dio el integrador (ver su test).
  const valves = valvulasDeProduccion();
  assert.ok(valves.length > 0);
  for (const { plantId, w } of valves) {
    assert.equal(w?.target?.index, 0, `${plantId}: se escribe por el canal 0`);
    if (plantId === 'sirena') continue;

    if (plantId !== 'carbonero') assert.equal(w?.commands?.open, 4096, `${plantId}: abrir = 4096 (bit12)`);
    assert.equal(w?.mode, 'bitmask', `${plantId}: modo bitmask (no pisar bits ajenos de la palabra)`);
    assert.ok((w?.pulse?.holdMs ?? 0) > 0, `${plantId}: debe declarar pulso (si no, el bit queda enclavado al confirmar)`);
    assert.equal(w?.readBack?.channel, 'intIn', `${plantId}: el read-back va por el canal de ESTADO`);
    assert.equal(w?.readBack?.confirmsWrittenValue, false, `${plantId}: un pulso no se confirma releyendo lo escrito`);
    assert.equal(w?.sequences, undefined, `${plantId}: sin ladder no se inventa una orden compuesta`);
  }
});

test('mapping de PRODUCCIÓN: CERRAR solo existe donde hay respaldo (campo o integrador)', () => {
  // El verbo `close` es el que de verdad puede hacer daño: abrir de más desperdicia agua, cerrar de
  // más deja a un pueblo sin ella. Por eso no se replica "porque el patrón parece el mismo" — en
  // Vorágine y Sirena lo probó el cliente sobre la planta (2026-08-15); en Carbonero lo entregó el
  // integrador del PLC con captura de RSLogix (2026-10-05); en el resto no hay nada que lo respalde.
  // Sin `close` en el mapping, la app responde UNKNOWN_COMMAND: no acciona a ciegas.
  const conCierre = valvulasDeProduccion()
    .filter((v) => v.w?.commands && 'close' in v.w.commands)
    .map((v) => `${v.plantId}=${v.w?.commands?.close}`)
    .sort();
  assert.deepEqual(conCierre, ['carbonero=2', 'sirena=2', 'voragine=8192']);

  const voragine = valvulasDeProduccion().find((v) => v.plantId === 'voragine')?.w;
  // 4096 = bit12 y 8192 = bit13: dos bits distintos de la MISMA palabra, cada uno como pulso. Que
  // sean bits contiguos es lo que hace fácil confundirlos al teclear, y confundirlos aquí significa
  // cerrar cuando alguien pidió abrir.
  assert.deepEqual(voragine?.commands, { open: 4096, close: 8192 });
  assert.equal(voragine?.mode, 'bitmask', 'dos comandos en la misma palabra: absoluto pisaría el otro');
  assert.ok((voragine?.pulse?.holdMs ?? 0) > 0, 'sin pulso, abrir dejaría el bit puesto y cerrar no podría actuar');
  assert.ok(typeof voragine?._riesgo === 'string', 'un comando de cierre debe llevar al lado qué lo respalda');

  // La señal es SOSTENIDA hasta que el PLC confirma. Se compara el VALOR ENTERO: INT_IN[1] vale
  // 1025 = bits{0,10} en reposo, así que una condición por bit0 se cumpliría en el primer instante y
  // cortaría la señal antes de que la válvula llegara a moverse.
  assert.deepEqual(voragine?.pulse?.until, {
    channel: 'intIn', sourceBuffer: 'INT_IN_VORAGINE', index: 1, equals: 1,
  });

  // El tope NO es libre. nginx no es el problema (proxy_read_timeout 300s, verificado en la VM el
  // 2026-08-15): lo es el cliente, cuyo `fetch` no fija timeout y hereda el de la plataforma (~60 s
  // en iOS). Pasarse deja al operador viendo un error de red con la orden viva en el PLC, que es lo
  // que invita a pulsar otra vez. 45 s + read-back cabe con margen.
  const tope = voragine?.pulse?.holdMs ?? 0;
  assert.ok(tope <= 45_000, `el tope del sostenido (${tope} ms) debe caber en el presupuesto de la cadena front→nginx→API`);
  assert.ok(tope >= 10_000, 'un tope demasiado corto cortaría la maniobra a mitad, que es el problema que esto arregla');
});

test('mapping de PRODUCCIÓN: ninguna otra planta sostiene la señal', () => {
  // El sostenido nace de una válvula motorizada concreta. Replicarlo a ciegas dejaría bobinas
  // energizadas hasta 45 s en sitios donde nadie ha comprobado que haga falta ni que sea seguro.
  const conSostenido = valvulasDeProduccion().filter((v) => v.w?.pulse?.until).map((v) => v.plantId);
  assert.deepEqual(conSostenido, ['voragine']);
});

test('mapping de PRODUCCIÓN: La Sirena — 1 abre, 2 cierra, 0 limpia (entrega oficial)', () => {
  // VERIFICADO EN CAMPO Y CERRADO por el cliente el 2026-08-15. Un solo canal, `INT_OUT[0]`, con
  // tres valores. Esta forma sustituye a dos intentos del mismo día que nunca llegaron a producción
  // —el 4096/bit12 heredado de Vorágine y una orden compuesta c0/c1 con relé de inversión—, y por
  // eso el test los nombra: si alguien vuelve a ver esas formas en el mapping, es una regresión, no
  // una evolución.
  const sirena = valvulasDeProduccion().find((v) => v.plantId === 'sirena')?.w;

  assert.deepEqual(sirena?.commands, { open: 1, close: 2 });
  assert.equal(sirena?.target?.index, 0);
  assert.equal(sirena?.mode, 'absolute', '1, 2 y 0 son valores del canal, no bits de una máscara');
  assert.equal(sirena?.sequences, undefined, 'la orden compuesta quedó descartada por la lectura de campo');
  assert.equal(sirena?.latched, undefined, 'ya no es sostenida indefinida: se limpia con 0');

  // Lo que el cliente fijó explícitamente: el 2 se sostiene 45 s antes de limpiar. Un pulso corto
  // dejaría la maniobra a medias, que es exactamente lo que hacía el de 300 ms.
  assert.equal(sirena?.pulse?.holdMs, 45_000);
  assert.equal(sirena?.pulse?.until, undefined, 'la parada por caudal es una actualización futura, no está aquí');

  // El 0 no es decorativo: es el valor con el que `clearPulse` limpia el canal en modo absoluto.
  // Si alguien lo cambiara, la válvula se quedaría con el 1 o el 2 puesto para siempre.
  assert.equal(sirena?.rollbackValue, 0, 'tras 1 o 2 SIEMPRE se vuelve a escribir 0');
  assert.ok(typeof sirena?._riesgo === 'string' && sirena._riesgo.length > 200);
});

test('mapping de PRODUCCIÓN: Carbonero — bit0 abre, bit1 cierra, en la MISMA palabra (integrador 2026-10-05)', () => {
  // Entregado por el integrador del PLC con captura de RSLogix, NO probado aún en campo. Sustituye al
  // `open: 4096` heredado de Vorágine, que nunca se validó aquí. Mismos valores que Sirena (1 y 2),
  // pero distinto modo: aquí son BITS de una palabra que puede llevar otros, así que `bitmask`.
  const carbonero = valvulasDeProduccion().find((v) => v.plantId === 'carbonero')?.w;

  assert.deepEqual(carbonero?.commands, { open: 1, close: 2 });
  assert.equal(carbonero?.target?.index, 0);
  assert.equal(carbonero?.mode, 'bitmask', 'bit0 y bit1 de una palabra compartida: absoluto pisaría los demás bits');
  assert.equal(carbonero?.sequences, undefined);
  assert.equal(carbonero?.latched, undefined, 'se suelta siempre; nunca se queda puesta');

  // Temporización PROVISIONAL, pendiente del integrador (pulso o sostenido, recorrido): sostenido por
  // reloj como Sirena. Con la MSG ciclando cada ~8 s, un pulso corto puede no llegar al PLC local.
  assert.equal(carbonero?.pulse?.holdMs, 45_000);
  assert.equal(carbonero?.pulse?.until, undefined, 'no se conoce ninguna realimentación');
  assert.equal(carbonero?.rollbackValue, 0);

  // El estado NO está verificado y su valor esperado no se inventa: el 16385 era de la convención de
  // Vorágine, nunca se observó en Carbonero, y con `close` habría confirmado un cierre sobre una
  // palabra que en esa convención significa ABIERTA.
  assert.equal(carbonero?.readBack?.channel, 'intIn');
  assert.equal(carbonero?.readBack?.stateVerified, false, 'el resultado tiene que salir en ámbar, no en verde');
  assert.equal(carbonero?.readBack?.expectedValue, undefined);

  assert.ok(
    typeof carbonero?._riesgo === 'string' && /integrador/i.test(carbonero._riesgo) && carbonero._riesgo.includes('2026-10-05'),
    'un comando de cierre debe llevar al lado de dónde sale y cuándo',
  );
});

// Las reglas ELÉCTRICAS de una orden compuesta se comprueban al CARGAR, no al accionar: una
// secuencia mal escrita debe descubrirse en `validate:mapping` o en el arranque, no con el operador
// delante del tablero y la válvula a medio recorrido. Un spec que las incumple se descarta entero y
// la señal queda no-writable — el lado seguro.
test('loader: las reglas eléctricas de una orden compuesta', () => {
  const spec = {
    target: { channel: 'intOut', sourceBuffer: 'INT_OUT_TEST', index: 0 },
    commands: { open: 1 as number | boolean },
    mode: 'absolute' as const,
  };
  const ok = motivoSecuenciaInvalida('open', [{ index: 1, value: 0 }, { index: 0, value: 1 }], spec);
  assert.equal(ok, null, `la secuencia buena debe pasar, y dijo: ${ok}`);

  const casos: Array<[string, Array<{ index: number; value: number }>, RegExp]> = [
    ['energiza dos direcciones', [{ index: 1, value: 1 }, { index: 0, value: 1 }], /energizadas a la vez/],
    ['desenergiza al final', [{ index: 0, value: 1 }, { index: 1, value: 0 }], /desenergiza DESPU/],
    ['no toca el canal primario', [{ index: 1, value: 0 }], /canal primario/],
    ['contradice a commands', [{ index: 1, value: 0 }, { index: 0, value: 7 }], /commands dice/],
    ['repite una posición', [{ index: 0, value: 0 }, { index: 0, value: 1 }], /dos veces/],
    ['vacía', [], /vac/],
  ];
  for (const [nombre, pasos, esperado] of casos) {
    const motivo = motivoSecuenciaInvalida('open', pasos, spec);
    assert.ok(motivo && esperado.test(motivo), `${nombre}: se esperaba ${esperado}, hubo: ${motivo}`);
  }

  // Una secuencia escribe POSICIONES completas del array; bitmask hablaría de bits dentro de una
  // palabra. Mezclar los dos modelos produce escrituras que nadie puede razonar.
  assert.ok(motivoSecuenciaInvalida('open', [{ index: 0, value: 1 }], { ...spec, mode: 'bitmask' }));
});

test('mapping de PRODUCCIÓN: la válvula de La Sirena declara cuál es SU caudal', () => {
  // El operador confirmó (2026-08-15) que la única válvula de Sirena es la de SALIDA. Se declara
  // explícitamente aunque coincida con la preferencia por defecto: esa preferencia es una
  // SUPOSICIÓN del código, y aquí es un dato de campo verificado. Elegir el caudal equivocado
  // miente justo en el caso que importa — la válvula de salida cerrada con la entrada llenando el
  // tanque: hay caudal en el lado que no manda, y se afirmaría "abierta" con la válvula cerrada.
  const prod = loadJson(join(__dirname, '..', 'config', 'opc_mapping.json')) as {
    plants: { plantId: string; signals?: { domainKey?: string; flowDomainKey?: string }[] }[];
  };
  // Vorágine se suma el 2026-08-15: el cliente confirmó que su válvula también actúa sobre la
  // salida, al probar en planta que 4096/8192 mueven `outletFlow1`.
  for (const plantId of ['sirena', 'voragine']) {
    const planta = prod.plants.find((p) => p.plantId === plantId);
    const valvula = (planta?.signals ?? []).find((s) => s.domainKey === 'valve1');
    assert.equal(valvula?.flowDomainKey, 'outletFlow1', `${plantId}: la válvula declara su caudal`);

    // Y el caudal declarado tiene que EXISTIR en esa planta, o el método se queda sin dato.
    assert.ok(
      (planta?.signals ?? []).some((s) => s.domainKey === 'outletFlow1'),
      `${plantId}: la señal declarada en flowDomainKey debe estar mapeada en la misma planta`,
    );
  }
});
