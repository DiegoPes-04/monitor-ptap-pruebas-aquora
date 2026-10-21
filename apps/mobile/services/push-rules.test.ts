/**
 * Reglas del push en el telefono: canales, cuando deja de publicar por su cuenta y que se le dice a
 * la persona.
 *
 * Lo que protegen:
 *  - El banner emergente. El canal de avisos estaba en importancia DEFAULT (suena, pero no sale el
 *    aviso sobre otras apps); los canales son inmutables, asi que el arreglo exige ids nuevos y que
 *    coincidan con los que nombra el servidor en cada push.
 *  - Que el telefono no se quede mudo: solo deja de publicar por su cuenta si el SERVIDOR dice que
 *    empuja (`pushActivo: true`). Con el servidor sin clave, sigue la consulta de respaldo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANAL_AVISOS, CANAL_CRITICAS } from '@ptap/shared';
import {
  CANALES_AQUORA,
  CANALES_RETIRADOS,
  esFaltaDeFirebase,
  estadoTrasRegistro,
  textoDePrueba,
} from './push-rules';

test('canales: los ids son los que nombra el servidor en el push', () => {
  assert.deepEqual(
    CANALES_AQUORA.map((c) => c.id),
    [CANAL_AVISOS, CANAL_CRITICAS],
  );
  assert.equal(CANAL_AVISOS, 'aquora-avisos');
  assert.equal(CANAL_CRITICAS, 'aquora-criticas');
});

test('canales: los avisos normales con importancia HIGH (banner) y los criticos MAX', () => {
  const porId = Object.fromEntries(CANALES_AQUORA.map((c) => [c.id, c]));
  assert.equal(porId[CANAL_AVISOS].importancia, 'HIGH', 'con DEFAULT suena pero no sale el banner');
  assert.equal(porId[CANAL_CRITICAS].importancia, 'MAX');
  assert.equal(porId[CANAL_CRITICAS].saltarNoMolestar, true);
  assert.equal(porId[CANAL_AVISOS].saltarNoMolestar, false, 'solo lo critico pide saltarse el no molestar');
  const total = (v: number[]) => v.reduce((s, x) => s + x, 0);
  assert.ok(
    total(porId[CANAL_CRITICAS].vibracion) > total(porId[CANAL_AVISOS].vibracion),
    'lo critico vibra mas largo: se distingue sin mirar la pantalla',
  );
});

test('canales: los viejos se retiran y ninguno nuevo reutiliza su id (los canales son inmutables)', () => {
  assert.deepEqual([...CANALES_RETIRADOS], ['ptap-alertas', 'ptap-criticas']);
  for (const c of CANALES_AQUORA) assert.ok(!CANALES_RETIRADOS.includes(c.id), c.id);
});

test('registro: solo pushActivo === true deja de publicar por su cuenta', () => {
  assert.equal(estadoTrasRegistro({ registrado: true, pushActivo: true }), 'activo');
  assert.equal(estadoTrasRegistro({ registrado: true, pushActivo: false }), 'servidor-apagado');
  // Cualquier respuesta rara deja la consulta de respaldo publicando: peor avisar de mas que callar.
  for (const raro of [{}, { pushActivo: 'true' }, { pushActivo: 1 }, null, undefined, 'ok', 42]) {
    assert.equal(estadoTrasRegistro(raro), 'servidor-apagado', JSON.stringify(raro));
  }
});

test('registro: una APK sin google-services.json se reconoce y no se presenta como fallo pasajero', () => {
  assert.equal(
    esFaltaDeFirebase(new Error('Default FirebaseApp is not initialized in this process com.ptap.monitor.')),
    true,
  );
  assert.equal(esFaltaDeFirebase(new Error('Network request failed')), false);
  assert.equal(esFaltaDeFirebase(undefined), false);
});

test('aviso de prueba: cada respuesta del servidor tiene su mensaje', () => {
  assert.equal(textoDePrueba({ pushActivo: false, telefonos: 0, enviados: 0, fallidos: 0 }).tipo, 'info');
  assert.equal(textoDePrueba({ pushActivo: true, telefonos: 0, enviados: 0, fallidos: 0 }).titulo, 'Este teléfono no está registrado');
  const ok = textoDePrueba({ pushActivo: true, telefonos: 1, enviados: 1, fallidos: 0 });
  assert.equal(ok.tipo, 'success');
  assert.ok(!ok.mensaje.includes('teléfonos'), 'con un solo telefono no se habla de varios');
  assert.match(
    textoDePrueba({ pushActivo: true, telefonos: 2, enviados: 1, fallidos: 1 }).mensaje,
    /a 1 de tus 2 teléfonos/,
  );
  assert.equal(textoDePrueba({ pushActivo: true, telefonos: 1, enviados: 0, fallidos: 1 }).tipo, 'error');
});
