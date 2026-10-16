/**
 * Fase 5 — validación del mapping de comandos (criterio de aceptación):
 *  - una señal writable puede ser confirmed o inferred, pero NUNCA estimated;
 *  - una señal writable DEBE declarar su write spec;
 *  - el mapping de PRODUCCIÓN no tiene NINGUNA señal writable (sin L5X → seguro por defecto).
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJson, validateMapping } from '../scripts/validate-mapping';
import {
  bitsCompartidosEntreValvulas,
  loadMapping,
  motivoSecuenciaInvalida,
  motivoSostenidaInvalida,
} from '../src/infrastructure/connectivity/mapping/opc-mapping.loader';
import { CommandMappingResolver } from '../src/modules/commands/command-mapping.resolver';

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

test('mapping de PRODUCCIÓN: la válvula 1 está en las 10 plantas CON canal de comando, y solo La Vorágine tiene una segunda', () => {
  // Invariante (2026-07-30): la ruta de la válvula se replicó a todas las plantas por instrucción
  // del operador («mín. 1 válvula, se escribe por el canal 0, abrir = 4096 en todas»), tras
  // verificarla en campo en Sirena (docs/archivo/PRUEBA_VALVULA_SIRENA.md: pulso capturado por testigo
  // independiente + MSG al PLC sin errores).
  //
  // El límite que este test protege: SOLO las plantas que tienen buffers intOut+intIn pueden tener
  // válvula. `san-antonio` y `quijote` NO los tienen (son tanques retransmitidos en el buffer de
  // Soledad, sin canal propio) → inventarles una válvula escribiría en un buffer inexistente.
  // Si aparece una writable en una planta sin canal, o de otro tipo, este test debe fallar.
  //
  // Desde el 2026-10-16 La Vorágine, Cascajal y Campoalegre tienen una SEGUNDA válvula accionable: el
  // integrador entregó su codificación. Son las únicas: cualquier otra exige lo mismo.
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

  assert.deepEqual(
    writables,
    conCanal.flatMap((id) => (CON_DOS_VALVULAS.includes(id) ? [`${id}/valve1`, `${id}/valve2`] : [`${id}/valve1`])),
    'una valve1 por planta con canal de comando, la valve2 donde el integrador la entregó, y nada más',
  );
  assert.equal(conCanal.length, 10, 'hoy son 10 plantas con canal (san-antonio y quijote no tienen intOut/intIn)');
  for (const sinCanal of ['san-antonio', 'quijote']) {
    assert.ok(!writables.some((w) => w.startsWith(`${sinCanal}/`)), `${sinCanal} NO debe tener válvula: no tiene canal donde escribir`);
  }
});

test('mapping de PRODUCCIÓN: La Vorágine tiene DOS válvulas y las DOS se accionan, por la MISMA palabra (integrador 2026-10-16)', () => {
  // El cliente confirmó el 2026-08-15 que La Vorágine tiene válvula de entrada Y de salida. Hasta el
  // 2026-10-16 la de entrada existía para mostrarse pero NO para mandarse: no se conocía su
  // codificación. Ese día la entregó el integrador del PLC: entrada abrir = bit2 (4) y cerrar = bit3
  // (8), en INT_OUT_VORAGINE[0], la misma palabra que la salida (bits 12/13).
  //
  // Este test se dio la vuelta, no se borró: lo que sigue protegiendo es que la de entrada solo tenga
  // mando con RESPALDO (el `_riesgo` dice de dónde sale y cuándo) y que su índice siga siendo un ancla
  // declarada como tal — el 1 no es por dónde se manda.
  const prod = loadJson(join(__dirname, '..', 'config', 'opc_mapping.json')) as {
    plants: Array<{
      plantId: string;
      signals?: Array<{
        domainKey?: string;
        label?: string;
        index?: number;
        confidence?: string;
        writable?: boolean;
        write?: ProdWrite & { target?: { sourceBuffer?: string; index?: number } };
        flowDomainKey?: string;
        _nota?: string;
      }>;
    }>;
  };

  const conValve2 = prod.plants.filter((p) => (p.signals ?? []).some((s) => s.domainKey === 'valve2')).map((p) => p.plantId);
  assert.deepEqual(conValve2, CON_DOS_VALVULAS, 'una segunda válvula exige su codificación, planta por planta');

  const voragine = prod.plants.find((p) => p.plantId === 'voragine');
  const entrada = (voragine?.signals ?? []).find((s) => s.domainKey === 'valve2');
  const salida = (voragine?.signals ?? []).find((s) => s.domainKey === 'valve1');

  assert.equal(entrada?.writable, true, 'la de entrada se acciona desde el 2026-10-16');
  assert.equal(entrada?.confidence, 'confirmed', 'respaldada por la entrega del integrador');
  assert.deepEqual(entrada?.write?.commands, { open: 4, close: 8 }, 'entrada: bit2 abre, bit3 cierra');
  assert.deepEqual(salida?.write?.commands, { open: 4096, close: 8192 }, 'salida: bit12 abre, bit13 cierra');
  for (const v of [entrada, salida]) {
    assert.equal(v?.write?.target?.sourceBuffer, 'INT_OUT_VORAGINE');
    assert.equal(v?.write?.target?.index, 0, `${v?.domainKey}: las dos mandan por INT_OUT_VORAGINE[0]`);
  }
  // EL ANCLA: la señal de la entrada cuelga del índice 1 (validate-mapping no admite dos señales en
  // intOut[0]) pero manda por el 0. Eso tiene que estar escrito al lado, o el próximo que lea el
  // mapping deducirá del índice algo que no es.
  assert.equal(entrada?.index, 1);
  assert.equal(entrada?._nota, undefined, 'la nota de «sin canal de comando» ya no es verdad: se sustituyó por el _riesgo');
  assert.ok(
    typeof entrada?.write?._riesgo === 'string' && /ANCLA, NO MANDO/.test(entrada.write._riesgo) && entrada.write._riesgo.includes('2026-10-16'),
    'el _riesgo de la entrada explica el ancla y dice de dónde sale la codificación',
  );

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

  // Cascajal y Campoalegre (integrador 2026-10-16): dos salidas en la misma palabra. Mismo patrón que
  // La Vorágine — la segunda cuelga de un ancla, cada una juzgada con SU caudal, y con nombre propio.
  for (const plantId of ['cascajal', 'campoalegre']) {
    const planta = prod.plants.find((p) => p.plantId === plantId);
    const v1 = (planta?.signals ?? []).find((s) => s.domainKey === 'valve1');
    const v2 = (planta?.signals ?? []).find((s) => s.domainKey === 'valve2');
    assert.equal(v2?.index, 1, `${plantId}/valve2: ancla en intOut[1]`);
    assert.ok(/ANCLA/.test(String(v2?.write?._riesgo)), `${plantId}/valve2: el _riesgo explica el ancla`);
    for (const v of [v1, v2]) {
      assert.equal(v?.write?.target?.index, 0, `${plantId}/${v?.domainKey}: manda por INT_OUT[0]`);
      assert.ok(v?.flowDomainKey, `${plantId}/${v?.domainKey}: declara su caudal`);
      assert.ok((planta?.signals ?? []).some((s) => s.domainKey === v?.flowDomainKey), `${plantId}: ${v?.flowDomainKey} existe`);
      assert.doesNotMatch(String(v?.label), /^Válvula \d$/, `${plantId}/${v?.domainKey}: nombre propio, no anónimo`);
    }
    assert.notEqual(v1?.flowDomainKey, v2?.flowDomainKey, `${plantId}: cada válvula con SU caudal`);
  }
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

/**
 * La entrega del integrador del PLC del 2026-10-16: qué bit abre y cuál cierra cada válvula, todas en
 * el elemento 0 de su INT_OUT y todas con señal SOSTENIDA. Es la única fuente de `sustained` en el
 * mapping de producción: una válvula fuera de esta tabla no puede sostener, y una de la tabla no
 * puede tener otros bits. Los pares son contiguos (7/8, 12/13, 2/3, 0/1): confundirlos al teclear es
 * cerrar cuando alguien pidió abrir, o mover la otra válvula de la palabra.
 */
const ENTREGA_INTEGRADOR_2026_10_16: Record<string, { open: number; close: number }> = {
  'voragine/valve1': { open: 4096, close: 8192 }, // salida: bit12 / bit13
  'voragine/valve2': { open: 4, close: 8 }, // entrada: bit2 / bit3
  'soledad/valve1': { open: 1, close: 2 }, // salida 1: bit0 / bit1
  'cascajal/valve1': { open: 128, close: 256 }, // salida 1: bit7 / bit8
  'cascajal/valve2': { open: 4096, close: 8192 }, // salida 2: bit12 / bit13
  'campoalegre/valve1': { open: 128, close: 256 }, // salida tanque nuevo: bit7 / bit8
  'campoalegre/valve2': { open: 4096, close: 8192 }, // salida 2 - Piamonte: bit12 / bit13
};

/** Plantas con dos válvulas en la misma palabra (la segunda cuelga de un ancla en intOut[1]). */
const CON_DOS_VALVULAS = ['voragine', 'cascajal', 'campoalegre'];

interface ProdWrite {
  target?: { sourceBuffer?: string; index?: number };
  commands?: Record<string, number>;
  sequences?: Record<string, Array<{ index: number; value: number }>>;
  latched?: boolean;
  sustained?: boolean;
  _riesgo?: string;
  mode?: string;
  pulse?: { holdMs?: number; until?: { channel?: string; sourceBuffer?: string; index?: number; equals?: number } };
  readBack?: { channel?: string; confirmsWrittenValue?: boolean; expectedValue?: number; stateVerified?: boolean };
  rollbackValue?: number;
}

function valvulasDeProduccion(): Array<{ plantId: string; domainKey: string; w: ProdWrite | undefined }> {
  const prod = loadJson(join(__dirname, '..', 'config', 'opc_mapping.json')) as {
    plants: Array<{ plantId: string; signals?: Array<{ domainKey?: string; writable?: boolean; write?: ProdWrite }> }>;
  };
  return prod.plants.flatMap((p) =>
    (p.signals ?? []).filter((s) => s.writable).map((s) => ({ plantId: p.plantId, domainKey: String(s.domainKey), w: s.write })),
  );
}

test('mapping de PRODUCCIÓN: cada válvula escribe en el canal 0 en máscara de bits, con pulso o SOSTENIDA', () => {
  // Protege la forma verificada en campo: si alguien cambia el índice, el modo o quita el pulso,
  // el comando podría pisar bits ajenos o quedar ENCLAVADO (ver docs/archivo/PRUEBA_VALVULA_SIRENA.md).
  // La Sirena está fuera a propósito: ver su test. Carbonero comparte la forma (canal 0, máscara,
  // pulso) pero NO el 4096: su codificación la dio el integrador (ver su test).
  //
  // El 2026-10-16 el integrador entregó la señal SOSTENIDA para La Vorágine, Soledad, Cascajal y
  // Campoalegre, y ahí lo que hay que proteger es lo contrario — que NADA la suelte. Sin pulso, sin
  // rollbackValue y `sustained`. Las que no están en esa entrega siguen con su pulso.
  const valves = valvulasDeProduccion();
  assert.ok(valves.length > 0);
  for (const { plantId, domainKey, w } of valves) {
    const quien = `${plantId}/${domainKey}`;
    assert.equal(w?.target?.index, 0, `${quien}: se escribe por el canal 0`);
    if (plantId === 'sirena') continue;

    const entrega = ENTREGA_INTEGRADOR_2026_10_16[quien];
    if (entrega) assert.deepEqual(w?.commands, entrega, `${quien}: los bits de la entrega del integrador`);
    else if (plantId !== 'carbonero') assert.equal(w?.commands?.open, 4096, `${quien}: abrir = 4096 (bit12)`);
    assert.equal(w?.mode, 'bitmask', `${quien}: modo bitmask (no pisar bits ajenos de la palabra)`);
    assert.equal(w?.readBack?.channel, 'intIn', `${quien}: el read-back va por el canal de ESTADO`);
    assert.equal(w?.readBack?.confirmsWrittenValue, false, `${quien}: no se confirma releyendo lo escrito`);
    assert.equal(w?.sequences, undefined, `${quien}: sin ladder no se inventa una orden compuesta`);
    if (entrega) {
      assert.equal(w?.sustained, true, `${quien}: señal SOSTENIDA (integrador 2026-10-16)`);
      assert.equal(w?.pulse, undefined, `${quien}: sin pulso — un pulso se limpia, y esta señal no se suelta nunca`);
      assert.equal(w?.rollbackValue, undefined, `${quien}: sin rollbackValue — no se deshace nunca`);
    } else {
      assert.ok((w?.pulse?.holdMs ?? 0) > 0, `${quien}: debe declarar pulso (si no, el bit queda enclavado al confirmar)`);
      assert.equal(w?.sustained, undefined, `${quien}: la señal sostenida exige la entrega del integrador para ESA válvula`);
    }
  }
});

test('mapping de PRODUCCIÓN: CERRAR solo existe donde hay respaldo (campo o integrador)', () => {
  // El verbo `close` es el que de verdad puede hacer daño: abrir de más desperdicia agua, cerrar de
  // más deja a un pueblo sin ella. Por eso no se replica "porque el patrón parece el mismo" — en
  // Vorágine y Sirena lo probó el cliente sobre la planta (2026-08-15); en Carbonero lo entregó el
  // integrador del PLC con captura de RSLogix (2026-10-05); en Soledad, Cascajal y Campoalegre, el
  // integrador el 2026-10-16; en el resto no hay nada que lo respalde.
  // Sin `close` en el mapping, la app responde UNKNOWN_COMMAND: no acciona a ciegas.
  const conCierre = valvulasDeProduccion()
    .filter((v) => v.w?.commands && 'close' in v.w.commands)
    .map((v) => `${v.plantId}/${v.domainKey}=${v.w?.commands?.close}`)
    .sort();
  assert.deepEqual(
    conCierre,
    [
      'carbonero/valve1=2',
      'sirena/valve1=2',
      ...Object.entries(ENTREGA_INTEGRADOR_2026_10_16).map(([quien, c]) => `${quien}=${c.close}`),
    ].sort(),
  );
  for (const [quien, entrega] of Object.entries(ENTREGA_INTEGRADOR_2026_10_16)) {
    const w = valvulasDeProduccion().find((v) => `${v.plantId}/${v.domainKey}` === quien)?.w;
    assert.ok(
      typeof w?._riesgo === 'string' && /integrador/i.test(w._riesgo) && w._riesgo.includes('2026-10-16') && /sosten/i.test(w._riesgo),
      `${quien}: un comando de cierre lleva al lado de dónde sale, cuándo y la regla de la señal sostenida`,
    );
    assert.equal(w?.readBack?.stateVerified, false, `${quien}: el estado no está verificado: el resultado sale en ámbar`);
    assert.equal(entrega.open & entrega.close, 0, `${quien}: abrir y cerrar son bits distintos`);
  }

  const salida = valvulasDeProduccion().find((v) => v.plantId === 'voragine' && v.domainKey === 'valve1')?.w;
  const entrada = valvulasDeProduccion().find((v) => v.plantId === 'voragine' && v.domainKey === 'valve2')?.w;
  // 4096 = bit12 y 8192 = bit13 la salida; 4 = bit2 y 8 = bit3 la entrada: CUATRO bits distintos de la
  // MISMA palabra. Que sean bits contiguos es lo que hace fácil confundirlos al teclear, y confundirlos
  // aquí significa cerrar cuando alguien pidió abrir — o mover la otra válvula.
  assert.deepEqual(salida?.commands, { open: 4096, close: 8192 });
  assert.deepEqual(entrada?.commands, { open: 4, close: 8 });
  for (const [nombre, w] of [['salida', salida], ['entrada', entrada]] as const) {
    assert.equal(w?.mode, 'bitmask', `${nombre}: dos válvulas en la misma palabra: absoluto pisaría la otra`);
    // La regla del integrador (2026-10-16): «todo el tiempo debe quedar la señal de apertura o la de
    // cierre, nunca las dos, siempre una de las dos». Antes la salida se sostenía hasta INT_IN[1] = 1 y
    // después se LIMPIABA — dejándola en 0/0, que es justo lo que la regla prohíbe. Si alguien vuelve a
    // poner un pulso o un `until` aquí, es una regresión.
    assert.equal(w?.sustained, true, `${nombre}: señal SOSTENIDA`);
    assert.equal(w?.pulse, undefined, `${nombre}: ni pulso ni until — nada la suelta`);
    assert.equal(w?.rollbackValue, undefined, `${nombre}: sin rollbackValue — no se deshace nunca`);
    assert.equal(w?.readBack?.stateVerified, false, `${nombre}: el estado no está verificado: el resultado sale en ámbar`);
    assert.ok(
      typeof w?._riesgo === 'string' && /integrador/i.test(w._riesgo) && w._riesgo.includes('2026-10-16') && /sostenidas/.test(w._riesgo),
      `${nombre}: un comando de cierre lleva al lado de dónde sale, cuándo y la regla textual`,
    );
  }
  // Sin la hipótesis de estado de la SALIDA (16385) en la ENTRADA: allí no tiene ninguna base.
  assert.equal(entrada?.readBack?.expectedValue, undefined);
});

test('mapping de PRODUCCIÓN: solo las válvulas de la entrega del integrador sostienen la señal, y ninguna usa ya pulse.until', () => {
  // La señal sostenida nace de una entrega concreta del integrador (2026-10-16). Replicarla a ciegas
  // dejaría bobinas energizadas para siempre en sitios donde nadie ha dicho que haga falta ni que sea
  // seguro — y en esos sitios el pulso sigue siendo lo que se limpia.
  const sostenidas = valvulasDeProduccion().filter((v) => v.w?.sustained === true).map((v) => `${v.plantId}/${v.domainKey}`);
  assert.deepEqual(sostenidas.sort(), Object.keys(ENTREGA_INTEGRADOR_2026_10_16).sort());
  // El `until` era la mitad de La Vorágine que soltaba la señal cuando INT_IN[1] valía 1.
  const conUntil = valvulasDeProduccion().filter((v) => v.w?.pulse?.until).map((v) => v.plantId);
  assert.deepEqual(conUntil, []);
});

// ── ORDEN SOSTENIDA: lo que el validador y el loader RECHAZAN (integrador de La Vorágine, 2026-10-16) ──
//
// «Estas señales deben ser sostenidas, es decir que todo el tiempo debe quedar la señal de apertura o
// la señal de cierre, nunca las dos, siempre una de las dos». Lo que puede romper esa regla desde el
// mapping es: un pulso (se limpia al terminar), un rollbackValue (se vuelve a él), el modo absoluto
// (pisa la otra válvula), un solo verbo (no hay contrario) o verbos que comparten bits (1/1).

const VALVULA_SOSTENIDA = {
  buffer: 'intOut', index: 0, domainKey: 'valve1', label: 'Válvula de salida',
  mappingStatus: 'mapped', confidence: 'confirmed', writable: true,
  write: {
    target: { channel: 'intOut', sourceBuffer: 'INT_OUT_TEST', index: 0 },
    commands: { open: 4096, close: 8192 },
    mode: 'bitmask',
    sustained: true,
    readBack: { channel: 'intOut', sourceBuffer: 'INT_OUT_TEST', index: 0, confirmsWrittenValue: false, stateVerified: false },
    timeoutMs: 5000,
    permission: 'control_valves',
  },
};

/** La válvula sostenida con el write spec tocado. `undefined` en un campo lo quita. */
function sostenidaCon(cambios: Record<string, unknown>): Record<string, unknown> {
  const write: Record<string, unknown> = { ...VALVULA_SOSTENIDA.write, ...cambios };
  for (const [k, v] of Object.entries(cambios)) if (v === undefined) delete write[k];
  return { ...VALVULA_SOSTENIDA, write };
}

/** Escribe un mapping en un archivo temporal (fuera del repo) para pasarlo por el loader real. */
function mappingTemporal(signals: Record<string, unknown>[]): string {
  const doc = mappingWithSignal(signals[0]) as { plants: Array<{ signals: unknown[] }> };
  doc.plants[0].signals = signals;
  const ruta = join(mkdtempSync(join(tmpdir(), 'mapping-sostenida-')), 'opc_mapping.json');
  writeFileSync(ruta, JSON.stringify(doc), 'utf8');
  return ruta;
}

test('sostenida: una válvula sostenida bien formada valida SIN rollbackValue y el loader la carga', () => {
  const r = validateMapping(schema, mappingWithSignal(VALVULA_SOSTENIDA));
  assert.deepEqual(r.errors, []);
  const w = loadMapping(mappingTemporal([VALVULA_SOSTENIDA])).signals[0].write;
  assert.equal(w?.sustained, true);
  assert.equal(w?.pulse, null);
  assert.equal('rollbackValue' in (w ?? {}), false, 'la clave ni aparece: nadie puede leer un undefined como «limpiar a 0»');
});

test('sostenida: sin `sustained`, rollbackValue sigue siendo OBLIGATORIO', () => {
  // La excepción es solo para la orden sostenida; el resto de specs sigue necesitando a qué volver.
  const r = validateMapping(schema, mappingWithSignal(sostenidaCon({ sustained: undefined })));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /rollbackValue/.test(e)), r.errors.join(' | '));
});

test('sostenida: el validador y el loader RECHAZAN sustained + pulse y sustained + rollbackValue, con mensaje claro', () => {
  const casos: Array<[string, Record<string, unknown>, RegExp]> = [
    ['con pulse', { pulse: { holdMs: 45000 } }, /pulse/],
    ['con pulse.until', { pulse: { holdMs: 45000, until: { channel: 'intIn', index: 1, equals: 1 } } }, /pulse/],
    ['con rollbackValue', { rollbackValue: 0 }, /rollbackValue/],
  ];
  for (const [nombre, cambios, motivo] of casos) {
    const senal = sostenidaCon(cambios);
    const r = validateMapping(schema, mappingWithSignal(senal));
    assert.equal(r.ok, false, `${nombre}: validate:mapping debe fallar`);
    // Las dos capas: el schema (la regla del allOf) y la semántica, con el motivo legible.
    assert.ok(r.errors.some((e) => e.startsWith('schema /plants/0/signals/0/write must NOT be valid')), `${nombre}: ${r.errors.join(' | ')}`);
    assert.ok(r.errors.some((e) => /write\.sustained en "valve1"/.test(e) && motivo.test(e)), `${nombre}: ${r.errors.join(' | ')}`);
    // El loader NO arranca: lanza, y el mensaje dice qué válvula y por qué.
    assert.throws(() => loadMapping(mappingTemporal([senal])), (err: Error) => {
      assert.match(err.message, /voragine\/valve1/);
      assert.match(err.message, /SOSTENIDA/);
      assert.match(err.message, motivo);
      return true;
    }, `${nombre}: el loader debe negarse a arrancar`);
  }
});

test('sostenida: el validador y el loader RECHAZAN el modo absoluto, un solo verbo, verbos con bits compartidos, cero y booleanos', () => {
  const casos: Array<[string, Record<string, unknown>, RegExp]> = [
    ['modo absoluto', { mode: 'absolute' }, /bitmask/],
    ['sin modo (absoluto por omisión)', { mode: undefined }, /bitmask/],
    ['un solo verbo', { commands: { open: 4096 } }, /dos verbos/],
    ['verbos con bits compartidos', { commands: { open: 4096, close: 4096 | 8192 } }, /comparte bits/],
    ['un verbo a cero', { commands: { open: 4096, close: 0 } }, /1 a 65535/],
    ['un verbo booleano', { commands: { open: true, close: false } }, /1 a 65535/],
    ['con sequences', { mode: 'bitmask', sequences: { open: [{ index: 0, value: 4096 }] } }, /sequences/],
    ['con latched', { latched: true }, /latched/],
  ];
  for (const [nombre, cambios, motivo] of casos) {
    const senal = sostenidaCon(cambios);
    assert.equal(validateMapping(schema, mappingWithSignal(senal)).ok, false, `${nombre}: validate:mapping debe fallar`);
    assert.throws(() => loadMapping(mappingTemporal([senal])), motivo, `${nombre}: el loader debe negarse a arrancar`);
  }
});

test('sostenida: dos válvulas de la MISMA palabra no pueden compartir bits (validador y loader)', () => {
  // El copia-y-pega que esta regla caza: la entrada con los bits de la salida. Con la señal puesta
  // para siempre, «abrir entrada» abriría la SALIDA y nadie lo vería en una regla por válvula.
  const salida = VALVULA_SOSTENIDA;
  const entradaMal = { ...sostenidaCon({ commands: { open: 4096, close: 8 } }), index: 1, domainKey: 'valve2', label: 'Válvula de entrada' };
  const r = validateMapping(schema, mappingTemporalDoc([salida, entradaMal]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /comparten bits/.test(e) && /valve1/.test(e) && /valve2/.test(e)), r.errors.join(' | '));
  assert.throws(() => loadMapping(mappingTemporal([salida, entradaMal])), /comparten bits/);

  // Con bits disjuntos (la forma real: 4096/8192 y 4/8) pasan los dos.
  const entradaBien = { ...sostenidaCon({ commands: { open: 4, close: 8 } }), index: 1, domainKey: 'valve2', label: 'Válvula de entrada' };
  assert.deepEqual(validateMapping(schema, mappingTemporalDoc([salida, entradaBien])).errors, []);
  assert.equal(loadMapping(mappingTemporal([salida, entradaBien])).signals.filter((s) => s.write?.sustained).length, 2);
});

/** El documento (no la ruta) con varias señales, para `validateMapping`. */
function mappingTemporalDoc(signals: Record<string, unknown>[]): unknown {
  const doc = mappingWithSignal(signals[0]) as { plants: Array<{ signals: unknown[] }> };
  doc.plants[0].signals = signals;
  return doc;
}

test('sostenida: `motivoSostenidaInvalida` acepta la forma real y explica cada rechazo', () => {
  const real = { commands: { open: 4096, close: 8192 }, mode: 'bitmask', pulse: null };
  assert.equal(motivoSostenidaInvalida(real), null, 'pulse: null es «sin pulso» (así lo deja el loader)');
  assert.equal(motivoSostenidaInvalida({ ...real, commands: { open: 4, close: 8 } }), null);
  assert.match(String(motivoSostenidaInvalida({ ...real, pulse: { holdMs: 1 } })), /pulse/);
  assert.match(String(motivoSostenidaInvalida({ ...real, rollbackValue: 0 })), /rollbackValue/);
  assert.match(String(motivoSostenidaInvalida({ ...real, commands: { open: 70000, close: 8192 } })), /65535/);
  assert.match(String(motivoSostenidaInvalida({ ...real, commands: { open: 1.5, close: 8192 } })), /entera/);
});

test('sostenida: `bitsCompartidosEntreValvulas` solo compara válvulas de la MISMA palabra', () => {
  const w = (sourceBuffer: string, index: number, commands: Record<string, number>, sustained = true) => ({
    target: { channel: 'intOut', sourceBuffer, index }, mode: 'bitmask', commands, sustained,
  });
  // Mismos bits en palabras distintas: no hay conflicto (son otras bobinas).
  assert.deepEqual(
    bitsCompartidosEntreValvulas([
      { plantId: 'p', domainKey: 'a', write: w('INT_OUT_A', 0, { open: 1, close: 2 }) },
      { plantId: 'p', domainKey: 'b', write: w('INT_OUT_A', 1, { open: 1, close: 2 }) },
      { plantId: 'q', domainKey: 'c', write: w('INT_OUT_A', 0, { open: 1, close: 2 }) },
    ]),
    [],
  );
  const c = bitsCompartidosEntreValvulas([
    { plantId: 'p', domainKey: 'a', write: w('INT_OUT_A', 0, { open: 1, close: 2 }, false) },
    { plantId: 'p', domainKey: 'b', write: w('INT_OUT_A', 0, { open: 2, close: 4 }, false) },
  ]);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].valvulas, ['a', 'b']);
  assert.equal(c[0].sostenida, false, 'sin sostenidas, el loader solo avisa; validate:mapping sí lo rechaza');
});

test('mapping REAL: La Vorágine carga y el resolver da las DOS válvulas con sus bits', () => {
  // Lo que usará el WriteService en producción: CommandMappingResolver lee el mapping del repositorio.
  const resolver = new CommandMappingResolver();
  const salida = resolver.resolve('voragine', 'valve1');
  const entrada = resolver.resolve('voragine', 'valve2');
  assert.ok(salida && entrada, 'las dos válvulas son accionables');
  assert.deepEqual(salida.write.commands, { open: 4096, close: 8192 });
  assert.deepEqual(entrada.write.commands, { open: 4, close: 8 });
  for (const r of [salida, entrada]) {
    assert.equal(r.write.sustained, true);
    assert.equal(r.write.mode, 'bitmask');
    assert.equal(r.write.pulse, null);
    assert.equal(r.write.rollbackValue, undefined);
    assert.deepEqual(r.write.target, { channel: 'intOut', sourceBuffer: 'INT_OUT_VORAGINE', index: 0 });
    assert.equal(r.write.permission, 'control_valves');
    assert.equal(motivoSostenidaInvalida(r.write), null);
  }
  // Y ninguna válvula fuera de la entrega del integrador tiene una sostenida que el resolver pueda dar;
  // las de la entrega resuelven con sus bits.
  const real = loadMapping(join(__dirname, '..', 'config', 'opc_mapping.json'));
  assert.deepEqual(
    real.signals
      .filter((s) => s.write?.sustained)
      .map((s) => `${s.plantId}/${s.domainKey}`)
      .sort(),
    Object.keys(ENTREGA_INTEGRADOR_2026_10_16).sort(),
  );
  for (const [quien, entrega] of Object.entries(ENTREGA_INTEGRADOR_2026_10_16)) {
    const [plantId, domainKey] = quien.split('/');
    const r = resolver.resolve(plantId, domainKey);
    assert.ok(r, `${quien}: accionable`);
    assert.deepEqual(r.write.commands, entrega, `${quien}: bits de la entrega`);
    assert.equal(r.write.target.index, 0, `${quien}: manda por INT_OUT[0]`);
    assert.equal(motivoSostenidaInvalida(r.write), null, `${quien}: sostenida válida`);
  }
  assert.deepEqual(bitsCompartidosEntreValvulas(real.signals), [], 'ninguna palabra con bits compartidos en producción');
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
