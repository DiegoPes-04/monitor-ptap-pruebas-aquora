/**
 * Editar el mapeo desde la app: qué se acepta y qué no.
 *
 * Estos tests son la red que hace que la función sea admisible. Un override mal validado no da un
 * error visible: da un tablero que enseña un número plausible sacado del sitio equivocado, que es
 * exactamente el fallo de los 409,50 psi de Cascajal — seis horas para descubrirlo, y solo porque
 * alguien se fijó en que 409,50 es 4095/10.
 *
 * Así que se prueba con saña lo que rechaza, no lo que acepta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aplicarOverrides,
  aplicarSobreRaw,
  bufferDeLaSenal,
  fusionar,
  soloCambios,
  validarParche,
  valoresActuales,
  type MappingOverride,
} from '../src/infrastructure/connectivity/mapping/mapping-overrides';
import { join } from 'node:path';
import { loadJson, validateMapping } from '../scripts/validate-mapping';
import { loadMapping, type LoadedMapping, type WriteSpec } from '../src/infrastructure/connectivity/mapping/opc-mapping.loader';
import { mappingPatchSchema } from '../src/modules/mapping/mapping-patch.schema';

/**
 * El write spec de la válvula, con la forma REAL del mapeo de producción: `open: 4096` heredado de
 * La Vorágine, sin `close`, en modo bitmask. Es exactamente lo que hay hoy en 8 de las 10 plantas y
 * lo que esta función existe para poder corregir.
 */
const WRITE: WriteSpec = {
  target: { channel: 'intOut', sourceBuffer: 'INT_OUT_CASCAJAL', index: 0 },
  commands: { open: 4096 },
  mode: 'bitmask',
  readBack: { channel: 'intIn', sourceBuffer: 'INT_IN_CASCAJAL', index: 1, confirmsWrittenValue: false, stateVerified: false },
  timeoutMs: 3000,
  rollbackValue: 0,
  permission: 'control_valves',
  pulse: null,
};

/** Mapping con la forma real de Cascajal: realIn de 50, un intOut de válvula y un buffer corto. */
function mappingCascajal(): LoadedMapping {
  return {
    version: '0.14.0',
    protocolVersion: 'v2',
    dtoVersion: 'v1',
    plants: [{ plantId: 'cascajal', displayName: 'Cascajal', livenessWindowSec: null }],
    targets: [
      { plantId: 'cascajal', browseName: 'REAL_IN_CASCAJAL', channel: 'realIn', node: { nsUri: 'AQUATECH4', identifier: 'g=F0C27430' }, arrayLength: 50, dataType: 'Float' },
      { plantId: 'cascajal', browseName: 'TK1_CASCAJAL', channel: 'realIn', node: { nsUri: 'AQUATECH4', identifier: 'g=TK1' }, arrayLength: 10, dataType: 'Float' },
      { plantId: 'cascajal', browseName: 'INT_OUT_CASCAJAL', channel: 'intOut', node: { nsUri: 'AQUATECH4', identifier: 'g=37DF3BEA' }, arrayLength: 20, dataType: 'Int16' },
    ],
    signals: [
      { plantId: 'cascajal', buffer: 'realIn', index: 0, domainKey: 'outletFlow1', label: 'Caudal de salida 1', unit: 'l/s', min: 0, max: 1000, opMin: 1, opMax: 3, mappingStatus: 'mapped', confidence: 'confirmed', writable: false },
      { plantId: 'cascajal', buffer: 'realIn', index: 19, domainKey: 'inletPressure1', label: 'Presion de entrada', unit: 'psi', min: -15, max: 232, mappingStatus: 'mapped', confidence: 'confirmed', writable: false },
      { plantId: 'cascajal', buffer: 'intOut', sourceBuffer: 'INT_OUT_CASCAJAL', index: 0, domainKey: 'valve1', label: 'Valvula 1', unit: null, min: null, max: null, mappingStatus: 'mapped', confidence: 'confirmed', writable: true, write: WRITE },
    ],
    raw: {
      plants: [
        {
          plantId: 'cascajal',
          signals: [
            { buffer: 'realIn', index: 0, domainKey: 'outletFlow1', unit: 'l/s', min: 0, max: 1000, opMin: 1, opMax: 3, mappingStatus: 'mapped', confidence: 'confirmed', writable: false },
            { buffer: 'realIn', index: 19, domainKey: 'inletPressure1', unit: 'psi', min: -15, max: 232, mappingStatus: 'mapped', confidence: 'confirmed', writable: false },
            {
              buffer: 'intOut',
              sourceBuffer: 'INT_OUT_CASCAJAL',
              index: 0,
              domainKey: 'valve1',
              mappingStatus: 'mapped',
              confidence: 'confirmed',
              writable: true,
              write: {
                target: { channel: 'intOut', sourceBuffer: 'INT_OUT_CASCAJAL', index: 0 },
                commands: { open: 4096 },
                mode: 'bitmask',
                readBack: { channel: 'intIn', sourceBuffer: 'INT_IN_CASCAJAL', index: 1, confirmsWrittenValue: false, stateVerified: false },
                timeoutMs: 3000,
                rollbackValue: 0,
                permission: 'control_valves',
              },
            },
          ],
        },
      ],
    },
  };
}

function override(domainKey: string, patch: MappingOverride['patch']): MappingOverride {
  return { plantId: 'cascajal', domainKey, patch, by: 'Admin', at: '2026-08-31T10:00:00.000Z' };
}

function senal(m: LoadedMapping, domainKey: string) {
  const s = m.signals.find((x) => x.domainKey === domainKey);
  assert.ok(s, `falta ${domainKey} en el fixture`);
  return s;
}

// ── Aplicación ──────────────────────────────────────────────────────────────────

test('override: mueve el índice y baja la confianza a inferred', () => {
  // Bajar la confianza no es decorativo: dice que detrás de ese índice ya no hay un documento de la
  // planta, sino la decisión de una persona. El tablero lo muestra y quien lo lea lo sabe.
  const m = aplicarOverrides(mappingCascajal(), [override('inletPressure1', { index: 21 })]);
  assert.equal(senal(m, 'inletPressure1').index, 21);
  assert.equal(senal(m, 'inletPressure1').confidence, 'inferred');
});

test('override: NO muta el mapping base', () => {
  // Es lo que permite recalcular el efectivo desde cero en cada cambio. Sin esto, dos ediciones
  // seguidas se apilarían y revertir no podría volver al JSON sin reiniciar el proceso.
  const base = mappingCascajal();
  aplicarOverrides(base, [override('inletPressure1', { index: 21, unit: 'bar' })]);
  assert.equal(senal(base, 'inletPressure1').index, 19, 'el base tiene que seguir intacto');
  assert.equal(senal(base, 'inletPressure1').unit, 'psi');
  assert.equal(senal(base, 'inletPressure1').confidence, 'confirmed');
});

test('override: una válvula SÍ se edita, mando incluido (cambio del 2026-08-31)', () => {
  // Hasta hoy esto estaba prohibido: el schema exigía `confidence: confirmed` a lo escribible y el
  // aplicador se negaba a tocarlo. Se abrió a propósito, porque 8 de las 10 plantas llevan un
  // `open: 4096` heredado que nadie verificó y la única forma de corregirlo era editar el JSON y
  // desplegar. Lo que NO cambió: la señal cae a `inferred`, y eso es lo que hace que la pantalla de
  // mando pueda avisar de que ese valor no está verificado en campo.
  const m = aplicarOverrides(mappingCascajal(), [
    override('valve1', { writeCommands: { open: 4096, close: 8192 } }),
  ]);
  assert.deepEqual(senal(m, 'valve1').write?.commands, { open: 4096, close: 8192 });
  assert.equal(senal(m, 'valve1').confidence, 'inferred');
});

test('override: editar el mando NO muta el write spec del mapping base', () => {
  // `{...s}` es copia superficial: sin clonar `write` y su `target`, el override se escribiría dentro
  // del mapeo base y el efectivo dejaría de poder recalcularse desde él — que es justo lo que
  // permite revertir sin reiniciar el proceso.
  const base = mappingCascajal();
  aplicarOverrides(base, [override('valve1', { writeCommands: { close: 1 }, writeIndex: 3 })]);
  assert.deepEqual(senal(base, 'valve1').write?.commands, { open: 4096 }, 'el base intacto');
  assert.equal(senal(base, 'valve1').write?.target.index, 0);
});

test('override: uno que apunta a una señal inexistente se ignora sin romper nada', () => {
  // Pasa cuando el JSON renombra una señal y la fila vieja se queda en la base. No puede resucitar
  // una señal ni impedir que el backend arranque.
  const m = aplicarOverrides(mappingCascajal(), [override('senalQueYaNoExiste', { index: 3 })]);
  assert.equal(m.signals.length, 3);
});

test('override: sin overrides devuelve el MISMO objeto (sin trabajo tirado)', () => {
  const base = mappingCascajal();
  assert.equal(aplicarOverrides(base, []), base);
});

test('override: un null borra el valor; un campo ausente lo deja como estaba', () => {
  const m = aplicarOverrides(mappingCascajal(), [override('outletFlow1', { opMin: null })]);
  assert.equal(senal(m, 'outletFlow1').opMin, null, 'opMin se borra');
  assert.equal(senal(m, 'outletFlow1').opMax, 3, 'opMax no se tocó');
  assert.equal(senal(m, 'outletFlow1').unit, 'l/s');
});

test('override: fusionar y valoresActuales son coherentes entre sí', () => {
  const s = fusionar(senal(mappingCascajal(), 'outletFlow1'), { index: 5, unit: 'm3/h' });
  const v = valoresActuales(s);
  assert.equal(v.index, 5);
  assert.equal(v.unit, 'm3/h');
  assert.equal(v.min, 0);
});

// ── Qué cambia de verdad ────────────────────────────────────────────────────────

test('cambios: solo se guardan los campos DISTINTOS de lo que ya rige', () => {
  const s = senal(mappingCascajal(), 'outletFlow1');
  const cambios = soloCambios(s, { index: 0, unit: 'm3/h', min: 0 });
  assert.deepEqual(cambios, { unit: 'm3/h' }, 'index y min eran iguales: no son un cambio');
});

test('cambios: poner null donde había valor SÍ es un cambio', () => {
  const s = senal(mappingCascajal(), 'outletFlow1');
  assert.deepEqual(soloCambios(s, { opMin: null }), { opMin: null });
});

// ── Validación: lo que se rechaza ───────────────────────────────────────────────

test('validar: señal desconocida', () => {
  const v = validarParche(mappingCascajal(), 'cascajal', 'noExiste', { index: 1 });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.motivo, 'SENAL_DESCONOCIDA');
});

test('validar: una válvula SÍ se edita', () => {
  assert.equal(validarParche(mappingCascajal(), 'cascajal', 'valve1', { index: 1 }).ok, true);
  assert.equal(
    validarParche(mappingCascajal(), 'cascajal', 'valve1', { writeCommands: { open: 4096, close: 8192 } }).ok,
    true,
  );
});

test('validar: los campos de MANDO se rechazan en una señal de lectura', () => {
  // No se ignoran en silencio: mandarlos ahí es señal de que quien lo hizo cree estar tocando otra
  // cosa, y devolverle un 200 lo dejaría convencido de haber configurado algo.
  const v = validarParche(mappingCascajal(), 'cascajal', 'outletFlow1', { writeCommands: { open: 1 } });
  assert.equal(v.ok === false && v.motivo, 'MANDO_EN_SENAL_DE_LECTURA');
});

test('validar: el índice de MANDO se comprueba contra su propio buffer', () => {
  // INT_OUT_CASCAJAL declara 20 elementos ⇒ el último válido es el 19. Un índice de mando fuera de
  // rango no da un error claro en el PLC: da comportamiento indefinido en un equipo que mueve agua.
  const v = validarParche(mappingCascajal(), 'cascajal', 'valve1', { writeIndex: 20 });
  assert.equal(v.ok === false && v.motivo, 'INDICE_FUERA_DE_RANGO');
  assert.match(v.ok === false ? v.detalle : '', /19/);
  assert.equal(validarParche(mappingCascajal(), 'cascajal', 'valve1', { writeIndex: 19 }).ok, true);
});

test('validar: un verbo con nombre ilegal', () => {
  const v = validarParche(mappingCascajal(), 'cascajal', 'valve1', { writeCommands: { '2abrir': 1 } });
  assert.equal(v.ok === false && v.motivo, 'COMANDOS_INVALIDOS');
});

test('validar: dos verbos con el MISMO valor', () => {
  // Si abrir y cerrar escriben lo mismo, el equipo no puede distinguirlos: una de las dos órdenes
  // hará lo contrario de lo que dice su botón, y el registro dirá que se hizo lo que se pidió.
  const v = validarParche(mappingCascajal(), 'cascajal', 'valve1', { writeCommands: { open: 4096, close: 4096 } });
  assert.equal(v.ok === false && v.motivo, 'COMANDOS_INVALIDOS');
  assert.match(v.ok === false ? v.detalle : '', /distinguir/);
});

test('validar: una válvula sin ningún verbo no se puede accionar', () => {
  const v = validarParche(mappingCascajal(), 'cascajal', 'valve1', { writeCommands: {} });
  assert.equal(v.ok === false && v.motivo, 'COMANDOS_INVALIDOS');
});

test('validar: una orden COMPUESTA no se edita desde la app', () => {
  // Sus reglas de secuencia —desenergizar antes de energizar, como mucho una posición activa al
  // final— son las que impiden la ventana con las dos direcciones puestas a la vez, que el
  // protocolo declara ERROR. Un parche que toque commands sin recalcular la secuencia las rompe.
  const m = mappingCascajal();
  const v = m.signals.find((x) => x.domainKey === 'valve1');
  if (v?.write) v.write.sequences = { open: [{ index: 1, value: 0 }, { index: 0, value: 1 }] };

  const r = validarParche(m, 'cascajal', 'valve1', { writeCommands: { open: 7 } });
  assert.equal(r.ok === false && r.motivo, 'SECUENCIA_NO_EDITABLE');
});

test('validar: abierta y cerrada no pueden leerse con el mismo valor', () => {
  const v = validarParche(mappingCascajal(), 'cascajal', 'valve1', { stateOpen: 16384, stateClosed: 16384 });
  assert.equal(v.ok === false && v.motivo, 'ESTADO_INVALIDO');
  assert.equal(validarParche(mappingCascajal(), 'cascajal', 'valve1', { stateOpen: 16385, stateClosed: 16384 }).ok, true);
});

test('cambios: el mismo mapa de comandos NO cuenta como cambio', () => {
  // Comparado con !== un objeto SIEMPRE sale distinto, y cada guardado registraría un cambio que no
  // existe: la historia de quién tocó qué dejaría de poder leerse.
  const s = senal(mappingCascajal(), 'valve1');
  assert.deepEqual(soloCambios(s, { writeCommands: { open: 4096 } }), {});
  assert.deepEqual(soloCambios(s, { writeCommands: { open: 4097 } }), { writeCommands: { open: 4097 } });
});

test('validar: sin cambios se rechaza en vez de guardar una fila vacía', () => {
  const v = validarParche(mappingCascajal(), 'cascajal', 'outletFlow1', { index: 0 });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.motivo, 'SIN_CAMBIOS');
});

test('validar: el índice tiene que caber en el buffer declarado', () => {
  // REAL_IN_CASCAJAL declara 50 elementos ⇒ el último válido es el 49. Un override al 50 no daría
  // un error visible: daría un dead-letter INDEX_OUT_OF_RANGE en CADA muestra y una señal muda.
  const v = validarParche(mappingCascajal(), 'cascajal', 'outletFlow1', { index: 50 });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.motivo, 'INDICE_FUERA_DE_RANGO');
  assert.match(v.ok === false ? v.detalle : '', /49/, 'el mensaje dice cuál es el último válido');

  assert.equal(validarParche(mappingCascajal(), 'cascajal', 'outletFlow1', { index: 49 }).ok, true);
});

test('validar: el índice se comprueba contra el buffer NUEVO, no contra el viejo', () => {
  // El caso que se cuela solo: la señal está en el realIn de 50 y se la manda al TK1 de 10 dejando
  // el índice 19. Validar contra el buffer anterior lo habría aceptado.
  const v = validarParche(mappingCascajal(), 'cascajal', 'inletPressure1', { sourceBuffer: 'TK1_CASCAJAL' });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.motivo, 'INDICE_FUERA_DE_RANGO');

  // Con un índice que cabe en el buffer nuevo, sí pasa.
  const ok = validarParche(mappingCascajal(), 'cascajal', 'inletPressure1', {
    sourceBuffer: 'TK1_CASCAJAL',
    index: 4,
  });
  assert.equal(ok.ok, true);
});

test('validar: un buffer que no existe en esa planta', () => {
  const v = validarParche(mappingCascajal(), 'cascajal', 'outletFlow1', { sourceBuffer: 'REAL_IN_OTRA' });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.motivo, 'BUFFER_DESCONOCIDO');
});

test('validar: no se puede saltar de canal', () => {
  // Cambiar realIn por intOut cambia el TIPO del dato (Float → Int16). Eso no es corregir un
  // índice: es otra señal.
  const v = validarParche(mappingCascajal(), 'cascajal', 'outletFlow1', { sourceBuffer: 'INT_OUT_CASCAJAL' });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.motivo, 'BUFFER_DE_OTRO_CANAL');
});

test('validar: rangos invertidos, tanto los físicos como los operativos', () => {
  const a = validarParche(mappingCascajal(), 'cascajal', 'outletFlow1', { min: 10, max: 5 });
  assert.equal(a.ok === false && a.motivo, 'RANGO_INVERTIDO');
  const b = validarParche(mappingCascajal(), 'cascajal', 'outletFlow1', { opMin: 9, opMax: 2 });
  assert.equal(b.ok === false && b.motivo, 'RANGO_INVERTIDO');
});

test('validar: el rango invertido se detecta CRUZANDO el valor guardado', () => {
  // Solo se manda `min`, y queda por encima del `max` que ya tenía la señal. Validar el parche
  // aislado lo habría aceptado.
  const v = validarParche(mappingCascajal(), 'cascajal', 'outletFlow1', { min: 2000 });
  assert.equal(v.ok === false && v.motivo, 'RANGO_INVERTIDO');
});

test('validar: unidad vacía o kilométrica', () => {
  const a = validarParche(mappingCascajal(), 'cascajal', 'outletFlow1', { unit: '   ' });
  assert.equal(a.ok === false && a.motivo, 'UNIDAD_INVALIDA');
  const b = validarParche(mappingCascajal(), 'cascajal', 'outletFlow1', { unit: 'metros cúbicos por hora' });
  assert.equal(b.ok === false && b.motivo, 'UNIDAD_INVALIDA');
  assert.equal(validarParche(mappingCascajal(), 'cascajal', 'outletFlow1', { unit: 'm3/h' }).ok, true);
});

test('validar: quitar el sourceBuffer vuelve al buffer primario del canal', () => {
  const m = mappingCascajal();
  const v = validarParche(m, 'cascajal', 'inletPressure1', { sourceBuffer: null, index: 19 });
  assert.equal(v.ok, false, 'index 19 ya era el actual y sourceBuffer ya era null: no hay cambio');
  assert.equal(v.ok === false && v.motivo, 'SIN_CAMBIOS');
});

test('buffer primario: gana el de más elementos del canal', () => {
  const m = mappingCascajal();
  assert.equal(bufferDeLaSenal(m, 'cascajal', 'realIn', null)?.browseName, 'REAL_IN_CASCAJAL');
  assert.equal(bufferDeLaSenal(m, 'cascajal', 'realIn', 'TK1_CASCAJAL')?.browseName, 'TK1_CASCAJAL');
});

// ── El documento crudo (lo que se revalida contra el schema) ─────────────────────

test('raw: el parche llega al documento y la confianza baja', () => {
  const m = mappingCascajal();
  const doc = aplicarSobreRaw(m.raw, [override('inletPressure1', { index: 21, unit: 'bar' })]) as {
    plants: { signals: Record<string, unknown>[] }[];
  };
  const s = doc.plants[0].signals.find((x) => x.domainKey === 'inletPressure1');
  assert.equal(s?.index, 21);
  assert.equal(s?.unit, 'bar');
  assert.equal(s?.confidence, 'inferred');
});

test('raw: un null BORRA la clave en vez de dejar un null ilegal', () => {
  // El schema declara estos campos como number/string opcionales: un `null` explícito haría el
  // documento inválido, y el rechazo llegaría al guardar sin que nadie entendiera por qué.
  const m = mappingCascajal();
  const doc = aplicarSobreRaw(m.raw, [override('outletFlow1', { opMin: null })]) as {
    plants: { signals: Record<string, unknown>[] }[];
  };
  const s = doc.plants[0].signals.find((x) => x.domainKey === 'outletFlow1');
  assert.equal('opMin' in (s ?? {}), false, 'la clave se borra');
  assert.equal(s?.opMax, 3);
});

test('raw: no muta el documento original', () => {
  // El `raw` lo usa resolveNamespaces() al arrancar el puente: mutarlo sería corromper la fuente de
  // los NodeIds en caliente.
  const m = mappingCascajal();
  aplicarSobreRaw(m.raw, [override('inletPressure1', { index: 21 })]);
  const original = (m.raw as { plants: { signals: Record<string, unknown>[] }[] }).plants[0].signals;
  assert.equal(original.find((x) => x.domainKey === 'inletPressure1')?.index, 19);
});

test('raw: el mando de una válvula llega al documento, anidado donde toca', () => {
  const m = mappingCascajal();
  const doc = aplicarSobreRaw(m.raw, [
    override('valve1', { writeCommands: { open: 4096, close: 8192 }, writeIndex: 2, stateOpen: 16385 }),
  ]) as { plants: { signals: Record<string, unknown>[] }[] };
  const s = doc.plants[0].signals.find((x) => x.domainKey === 'valve1');
  const write = s?.write as { commands: Record<string, number>; target: { index: number } };

  assert.deepEqual(write.commands, { open: 4096, close: 8192 });
  assert.equal(write.target.index, 2, 'el índice de mando va dentro de write.target, no en la señal');
  assert.deepEqual(s?.stateEncoding, { open: 16385 });
  assert.equal(s?.confidence, 'inferred');
});

test('raw: borrar las dos mitades del estado quita la clave entera', () => {
  // El schema exige minProperties: 1 en stateEncoding. Dejar {} lo haría inválido y el rechazo
  // llegaría al guardar, sin que nadie entendiera por qué.
  const m = mappingCascajal();
  const doc = aplicarSobreRaw(m.raw, [override('valve1', { stateOpen: null, stateClosed: null })]) as {
    plants: { signals: Record<string, unknown>[] }[];
  };
  const s = doc.plants[0].signals.find((x) => x.domainKey === 'valve1');
  assert.equal('stateEncoding' in (s ?? {}), false);
});

test('raw: a una señal de LECTURA no se le inventa un write spec', () => {
  // Un documento con write en una señal no-writable lo rechaza el schema («el write spec solo puede
  // existir en una señal writable»), así que colarlo aquí produciría un mapeo ilegal.
  const m = mappingCascajal();
  const doc = aplicarSobreRaw(m.raw, [override('outletFlow1', { writeCommands: { open: 1 } })]) as {
    plants: { signals: Record<string, unknown>[] }[];
  };
  const s = doc.plants[0].signals.find((x) => x.domainKey === 'outletFlow1');
  assert.equal('write' in (s ?? {}), false);
});

// ── La forma del cuerpo de la petición ──────────────────────────────────────────

test('cuerpo: un campo que no existe se RECHAZA en vez de ignorarse', () => {
  // El peor final posible sería un 200 tras mandar `indice` en vez de `index`: la persona se va
  // convencida de haber corregido algo.
  assert.equal(mappingPatchSchema.safeParse({ indice: 3 }).success, false);
  assert.equal(mappingPatchSchema.safeParse({ index: 3, nsUri: 'AQUATECH4' }).success, false);
});

test('cuerpo: un cuerpo vacío se rechaza', () => {
  assert.equal(mappingPatchSchema.safeParse({}).success, false);
});

test('cuerpo: index entero y no negativo; null no vale para index', () => {
  assert.equal(mappingPatchSchema.safeParse({ index: 3.5 }).success, false);
  assert.equal(mappingPatchSchema.safeParse({ index: -1 }).success, false);
  assert.equal(mappingPatchSchema.safeParse({ index: null }).success, false);
  assert.equal(mappingPatchSchema.safeParse({ index: 0 }).success, true);
});

test('cuerpo: los rangos y la unidad SÍ aceptan null (borrar es una corrección)', () => {
  assert.equal(mappingPatchSchema.safeParse({ opMin: null }).success, true);
  assert.equal(mappingPatchSchema.safeParse({ unit: null }).success, true);
  assert.equal(mappingPatchSchema.safeParse({ min: Number.NaN }).success, false);
});

// ── Válvulas de señal SOSTENIDA (La Vorágine, integrador 2026-10-16) ─────────────────────────
//
// La app puede tocar `writeCommands`, `writeMode` y `writeIndex` de una válvula, pero no `pulse`,
// `rollbackValue` ni `sustained`. Lo que tiene que impedir es que esos tres campos dejen una válvula
// sostenida en algo que el loader se negaría a cargar — o que haga 1/1 o 0/0, o que mueva a la otra.

/** El mapeo REAL: las dos válvulas de La Vorágine, sostenidas en INT_OUT_VORAGINE[0]. */
function mappingReal(): LoadedMapping {
  return loadMapping(join(__dirname, '..', 'config', 'opc_mapping.json'));
}

test('sostenida: un parche no puede pasar una válvula sostenida a modo absoluto', () => {
  const v = validarParche(mappingReal(), 'voragine', 'valve1', { writeMode: 'absolute' });
  assert.equal(v.ok === false && v.motivo, 'MANDO_INCOMPATIBLE_CON_SOSTENIDA');
  assert.match(v.ok === false ? v.detalle : '', /SOSTENIDA/);
});

test('sostenida: un parche no puede dejarla con un solo verbo, con un verbo a cero o con booleanos', () => {
  const casos: Array<Record<string, number | boolean>> = [
    { open: 4096 },
    { open: 4096, close: 0 },
    { open: true, close: false },
    { open: 4096, close: 4096 | 8192 },
  ];
  for (const writeCommands of casos) {
    const v = validarParche(mappingReal(), 'voragine', 'valve1', { writeCommands });
    assert.equal(v.ok === false && v.motivo, 'MANDO_INCOMPATIBLE_CON_SOSTENIDA', JSON.stringify(writeCommands));
  }
});

test('sostenida: un parche no puede darle a una válvula los bits de la OTRA de la misma palabra', () => {
  // El copia-y-pega: la entrada con el 4096 de la salida. «Abrir entrada» abriría la SALIDA.
  const v = validarParche(mappingReal(), 'voragine', 'valve2', { writeCommands: { open: 4096, close: 8 } });
  assert.equal(v.ok === false && v.motivo, 'BITS_COMPARTIDOS');
  assert.match(v.ok === false ? v.detalle : '', /valve1/);
  // Y moverla a otra palabra donde no choca con nadie sí se puede (es una corrección de índice).
  assert.equal(validarParche(mappingReal(), 'voragine', 'valve2', { writeIndex: 2 }).ok, true);
  // Unos bits nuevos, válidos y que no pisan a nadie, también.
  assert.equal(validarParche(mappingReal(), 'voragine', 'valve1', { writeCommands: { open: 1024, close: 2048 } }).ok, true);
});

test('sostenida: una fila VIEJA que la dejaría inválida no se aplica en caliente (rige la del repositorio)', () => {
  // Guardada antes de que la válvula fuera sostenida, o tocada a mano en la base. Lo de lectura sí
  // se aplica; el mando, no.
  const base = mappingReal();
  const m = aplicarOverrides(base, [
    { plantId: 'voragine', domainKey: 'valve1', patch: { writeMode: 'absolute', writeCommands: { open: 4096 }, unit: 'ZZ' }, by: 'x', at: null },
  ]);
  const s = m.signals.find((x) => x.plantId === 'voragine' && x.domainKey === 'valve1');
  assert.equal(s?.write?.mode, 'bitmask');
  assert.deepEqual(s?.write?.commands, { open: 4096, close: 8192 });
  assert.equal(s?.write?.sustained, true);
  assert.equal(s?.unit, 'ZZ', 'la parte de lectura del parche sí se aplicó');
});

test('sostenida: el documento resultante tampoco pasaría el schema (la tercera red del servicio)', () => {
  // MappingOverrideService valida el documento ENTERO contra el schema antes de guardar nada. Con el
  // mapeo real y un parche de modo absoluto sobre la salida, ese documento no es legal.
  const raw = loadJson(join(__dirname, '..', 'config', 'opc_mapping.json'));
  const schema = loadJson(join(__dirname, '..', 'config', 'opc_mapping.schema.json')) as object;
  const doc = aplicarSobreRaw(raw, [
    { plantId: 'voragine', domainKey: 'valve1', patch: { writeMode: 'absolute' }, by: 'x', at: null },
  ]);
  const r = validateMapping(schema, doc);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /write\/mode/.test(e)), r.errors.join(' | '));
});
