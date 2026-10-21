/**
 * Puntero de avisos ya anunciados en el panel del teléfono.
 *
 * Lo que protege: un aviso de planta solo puede darse por anunciado si de verdad salió al panel (o
 * si quedó aplazado en la lista de diferidos). Antes el puntero se adelantaba antes de publicar, y
 * un fallo al publicar se tragaba el aviso para siempre: estaba en la bandeja de la app, pero nunca
 * llegó al panel de Android.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { punteroConPush, siguientePuntero } from './notification-pointer';

test('puntero: todo publicado -> avanza hasta el id mas alto', () => {
  assert.equal(siguientePuntero(10, [11, 12, 13], new Set([11, 12, 13])), 13);
});

test('puntero: falla uno en medio -> se detiene justo antes del fallido', () => {
  // El 12 no salio. El 13 si, pero queda por encima del puntero y se reintenta junto con el 12: es
  // preferible republicar el 13 (Android lo reemplaza por su identifier) a perder el 12.
  assert.equal(siguientePuntero(10, [11, 12, 13], new Set([11, 13])), 11);
});

test('puntero: falla el primero -> no se mueve', () => {
  assert.equal(siguientePuntero(10, [11, 12], new Set([12])), 10);
});

test('puntero: solo aplazados -> avanza igual (los recuerda la lista de diferidos, no el puntero)', () => {
  // Con el «no molestar» activo nada suena, pero tampoco se pierde: el aplazado vuelve a evaluarse
  // en cada ciclo desde la lista de diferidos. Si el puntero no avanzara, se re-evaluarian a la vez
  // por las dos vias.
  assert.equal(siguientePuntero(10, [11, 12], new Set([11, 12])), 12);
});

test('puntero: mezcla de aplazados y publicados, todo resuelto -> avanza hasta el final', () => {
  const aplazados = [11, 13];
  const publicados = [12, 14];
  assert.equal(siguientePuntero(10, [11, 12, 13, 14], new Set([...aplazados, ...publicados])), 14);
});

test('puntero: sin candidatos -> se queda donde estaba', () => {
  assert.equal(siguientePuntero(10, [], new Set()), 10);
  assert.equal(siguientePuntero(0, [], new Set()), 0);
});

test('puntero: diferidos con id <= previo no lo mueven, ni aunque fallen', () => {
  // Diferidos de una franja anterior: el puntero ya estaba por encima de ellos.
  assert.equal(siguientePuntero(10, [5, 7], new Set([5, 7])), 10);
  assert.equal(siguientePuntero(10, [5, 7], new Set()), 10);
  // Un diferido viejo que falla no frena a los nuevos: no esta en el tramo que cubre el puntero.
  assert.equal(siguientePuntero(10, [5, 11, 12], new Set([11, 12])), 12);
});

test('puntero: nunca retrocede por debajo de previo', () => {
  assert.equal(siguientePuntero(50, [3, 4, 49], new Set([3])), 50);
});

test('puntero: el orden y los repetidos de la entrada no cambian el resultado', () => {
  assert.equal(siguientePuntero(10, [13, 11, 12, 11], new Set([11, 12, 13])), 13);
  assert.equal(siguientePuntero(10, [13, 12, 11], new Set([11, 13])), 11);
});

// Con push, cada aviso ya lo mostro Android al llegar: la consulta de respaldo no publica nada, pero el
// puntero sigue avanzando para que, si el push se corta, no salgan de golpe dias de avisos viejos.
test('puntero con push: salta al id mas alto sin necesidad de publicar nada', () => {
  assert.equal(punteroConPush(10, [11, 12, 13]), 13);
  assert.equal(punteroConPush(10, [13, 11, 12]), 13, 'el orden de la entrada da igual');
});

test('puntero con push: sin candidatos o con ids viejos, se queda donde estaba (nunca retrocede)', () => {
  assert.equal(punteroConPush(10, []), 10);
  assert.equal(punteroConPush(10, [3, 7]), 10);
  assert.equal(punteroConPush(0, []), 0);
});
