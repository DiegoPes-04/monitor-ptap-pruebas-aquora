/**
 * La aritmética de la herramienta de campo de La Vorágine (scripts/voragine-valvulas-bits.ts): lo que
 * decide QUÉ se escribe en INT_OUT_VORAGINE[0] cuando alguien la arma delante de la planta.
 *
 * Integrador del PLC, 2026-10-16: entrada abrir = bit2 (4) / cerrar = bit3 (8); salida abrir = bit12
 * (4096) / cerrar = bit13 (8192); y «todo el tiempo debe quedar la señal de apertura o la señal de
 * cierre, nunca las dos, siempre una de las dos». Se prueba sobre las 65 536 palabras posibles: es
 * barato, y una herramienta que escribe en un PLC en producción no se prueba con tres ejemplos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadJson } from '../scripts/validate-mapping';
import {
  LISTA_BLANCA,
  OBSERVAR_POR_DEFECTO_SEG,
  VALVULAS,
  aConSigno16,
  aSinSigno16,
  bitsPuestos,
  cambiosEntreMuestras,
  contrario,
  cuentaAtras,
  describirPalabra,
  estadoDelPar,
  lineaDeMuestra,
  nodosDelMapping,
  nombreDelLog,
  otraValvula,
  parsearArgumentos,
  planificarPalabra,
  planificar,
  segundosDeObservacion,
  verificarContraMapping,
  type Muestra,
  type Valvula,
  type Verbo,
} from '../scripts/voragine-valvulas-bits';

const VALVULAS_Y_VERBOS: Array<[Valvula, Verbo]> = [
  ['entrada', 'abrir'],
  ['entrada', 'cerrar'],
  ['salida', 'abrir'],
  ['salida', 'cerrar'],
];

test('bits: los del integrador, y la lista blanca es exactamente {2, 3, 12, 13}', () => {
  assert.deepEqual(VALVULAS.entrada, { domainKey: 'valve2', label: 'Válvula de entrada', abrir: 4, cerrar: 8 });
  assert.deepEqual(VALVULAS.salida, { domainKey: 'valve1', label: 'Válvula de salida', abrir: 4096, cerrar: 8192 });
  assert.equal(LISTA_BLANCA, 12300);
  assert.deepEqual(bitsPuestos(LISTA_BLANCA), [2, 3, 12, 13]);
});

test('mapping REAL: los bits, el buffer y la señal sostenida coinciden con los de la herramienta', () => {
  // Si alguien cambia el mapping o la herramienta y no el otro, esto falla aquí — y la herramienta,
  // en campo, se negaría a escribir (verificarContraMapping).
  const raw = loadJson(join(__dirname, '..', 'config', 'opc_mapping.json'));
  assert.deepEqual(verificarContraMapping(raw), []);
  const nodos = nodosDelMapping(raw);
  assert.equal(nodos.nsUri, 'AQUATECH4');
  assert.equal(nodos.mando, 'g=1505CBA4-0BCF-A4FC-7602-DB5BF940BBC6', 'INT_OUT_VORAGINE');
  assert.equal(nodos.estado, 'g=002A5DBD-381A-F691-1071-4BFF23ED007C', 'INT_IN_VORAGINE');
  assert.equal(nodos.proceso, 'g=93BAFF92-FF57-4877-74E4-B7CC1EFAE6B3', 'REAL_IN_VORAGINE');
});

test('mapping: si no coincide con la herramienta, se dice qué y por qué', () => {
  const raw = loadJson(join(__dirname, '..', 'config', 'opc_mapping.json')) as {
    plants: Array<{ plantId: string; signals: Array<{ domainKey: string; write?: Record<string, unknown> }> }>;
  };
  const v = raw.plants.find((p) => p.plantId === 'voragine')!;
  const entrada = v.signals.find((s) => s.domainKey === 'valve2')!;
  entrada.write!.commands = { open: 4096, close: 8 };
  delete entrada.write!.sustained;
  const errores = verificarContraMapping(raw);
  assert.ok(errores.some((e) => /entrada \(valve2\).*open=4096/.test(e)), errores.join(' | '));
  assert.ok(errores.some((e) => /NO la declara sostenida/.test(e)), errores.join(' | '));
});

test('signo: Int16 con bit15 llega negativo y se normaliza en los dos sentidos', () => {
  assert.equal(aSinSigno16(-28672), 36864); // bit15 + bit12
  assert.equal(aConSigno16(36864), -28672);
  assert.equal(aConSigno16(-28672), -28672);
  assert.equal(aConSigno16(4100), 4100);
  assert.equal(aSinSigno16(-1), 0xffff);
  for (const malo of [Number.NaN, 1.5, 65536, -32769, Number.POSITIVE_INFINITY]) {
    assert.throws(() => aSinSigno16(malo), /no es un entero de 16 bits/, String(malo));
  }
});

test('plan: en las 65 536 palabras, el par queda en el verbo, la otra válvula y los demás bits intactos', () => {
  for (let palabra = 0; palabra <= 0xffff; palabra++) {
    for (const [valvula, verbo] of VALVULAS_Y_VERBOS) {
      const p = planificar(palabra, valvula, verbo);
      const par = VALVULAS[valvula];
      const otra = otraValvula(valvula);
      // La fórmula, literal: (actual & ~contrario) | verbo, en UNA escritura.
      assert.equal(p.nuevo, ((palabra & ~par[contrario(verbo)]) | par[verbo]) & 0xffff);
      if (estadoDelPar(p.nuevo, valvula) !== verbo) assert.fail(`${palabra} ${valvula} ${verbo}: el par no queda en ${verbo}`);
      if (estadoDelPar(p.nuevo, otra) !== estadoDelPar(palabra, otra)) assert.fail(`${palabra} ${valvula} ${verbo}: mueve la ${otra}`);
      if (((p.nuevo ^ palabra) & ~(par.abrir | par.cerrar)) !== 0) assert.fail(`${palabra} ${valvula} ${verbo}: toca bits fuera del par`);
      if (((p.nuevo ^ palabra) & ~LISTA_BLANCA) !== 0) assert.fail(`${palabra}: fuera de la lista blanca`);
      // Lo que va al servidor es el Int16 con signo de lo calculado.
      if (aSinSigno16(p.aEscribir) !== p.nuevo || p.aEscribir < -0x8000 || p.aEscribir > 0x7fff) assert.fail(`${palabra}: signo mal normalizado`);
      // Idempotente: aplicar la misma orden sobre el resultado no cambia nada.
      if (planificar(p.nuevo, valvula, verbo).cambia) assert.fail(`${palabra} ${valvula} ${verbo}: no es idempotente`);
    }
  }
});

test('plan: la palabra llega con signo o sin él y el plan es el mismo', () => {
  // INT_OUT con el bit15 puesto lo devuelve el servidor negativo. Da igual cómo llegue.
  for (const u of [0x8000, 0x9004, 0xffff, 0xa008]) {
    for (const [valvula, verbo] of VALVULAS_Y_VERBOS) {
      const conSigno = planificar(aConSigno16(u), valvula, verbo);
      const sinSigno = planificar(u, valvula, verbo);
      assert.equal(conSigno.nuevo, sinSigno.nuevo);
      assert.equal(conSigno.aEscribir, sinSigno.aEscribir);
      assert.ok(conSigno.aEscribir < 0, 'con el bit15 puesto, se escribe negativo: es lo que cabe en un Int16');
    }
  }
});

test('plan: abrir→cerrar en UNA escritura, sin pasar por 0/0 ni por 1/1', () => {
  // Salida abierta y entrada cerrada → cerrar salida: 4096|8 pasa a 8192|8 directamente.
  const p = planificar(4096 | 8, 'salida', 'cerrar');
  assert.equal(p.nuevo, 8192 | 8);
  assert.equal(p.parAntes, 'abrir');
  assert.equal(p.parDespues, 'cerrar');
  assert.deepEqual(p.bitsQueCambian, [12, 13]);
  assert.deepEqual(p.avisos, []);
  assert.equal(describirPalabra(p.nuevo), '8200 {3,13} · entrada CERRAR · salida CERRAR');
});

test('plan: avisa si el par partía en 1/1 o 0/0, y si la OTRA está en 1/1 o 0/0 (sin tocarla)', () => {
  const desdeError = planificar(4 | 8 | 4096, 'entrada', 'abrir');
  assert.equal(desdeError.nuevo, 4 | 4096);
  assert.ok(desdeError.avisos.some((a) => /PARTÍA en 1\/1/.test(a)));

  const desdeCero = planificar(0, 'salida', 'abrir');
  assert.equal(desdeCero.nuevo, 4096);
  assert.ok(desdeCero.avisos.some((a) => /PARTÍA en 0\/0/.test(a)));
  assert.ok(desdeCero.avisos.some((a) => /la entrada está en 0\/0/.test(a)), 'y la otra también, sin tocarla');
  assert.equal(estadoDelPar(desdeCero.nuevo, 'entrada'), 'sin-senal', 'la herramienta NO arregla la otra por su cuenta');

  const otraEnError = planificar(4 | 8 | 8192, 'salida', 'abrir');
  assert.ok(otraEnError.avisos.some((a) => /la entrada está en 1\/1/.test(a)));
  assert.equal(otraEnError.nuevo & 12, 12, 'la entrada sigue en 1/1: se avisa, no se toca');

  const ajenos = planificar(1024 | 8192 | 8, 'salida', 'abrir');
  assert.equal(ajenos.nuevo, 1024 | 4096 | 8);
  assert.ok(ajenos.avisos.some((a) => /fuera de \{2,3,12,13\}/.test(a)));
});

test('plan --sin-ajenos: el 2 suelto del 2026-10-16 se apaga en la MISMA escritura, sin tocar las válvulas', () => {
  // Lo que había en campo: 4106 = {1,3,12} — entrada CERRAR, salida ABRIR y un bit1 (valor 2) que no es
  // de ninguna válvula y que cada orden arrastraba.
  const abrir = planificar(4106, 'entrada', 'abrir', { limpiarAjenos: true });
  assert.equal(abrir.nuevo, 4100, 'entrada ABRIR + salida ABRIR, sin el 2');
  assert.equal(abrir.ajenosApagados, 2);
  assert.deepEqual(abrir.bitsQueCambian, [1, 2, 3]);
  assert.equal(abrir.otra.estado, 'abrir', 'la salida no se toca');
  assert.ok(abrir.avisos.some((a) => /se APAGAN/.test(a)));

  const cerrar = planificar(abrir.nuevo, 'entrada', 'cerrar', { limpiarAjenos: true });
  assert.equal(cerrar.nuevo, 4104, 'entrada CERRAR + salida ABRIR');
  assert.deepEqual(cerrar.bitsQueCambian, [2, 3]);

  // Ya con el verbo pero con el ajeno puesto: sí hay algo que escribir (quitar el 2).
  const soloAjeno = planificar(4096 | 8 | 2, 'entrada', 'cerrar', { limpiarAjenos: true });
  assert.equal(soloAjeno.cambia, true);
  assert.equal(soloAjeno.nuevo, 4104);
  assert.equal(planificar(4104, 'entrada', 'cerrar', { limpiarAjenos: true }).cambia, false, 'idempotente');

  // Sin la opción, el comportamiento de siempre: se conserva.
  assert.equal(planificar(4106, 'entrada', 'abrir').nuevo, 4102);

  // Nunca toca la otra válvula aunque esté en 1/1 o 0/0, y nunca enciende un bit ajeno.
  for (let palabra = 0; palabra <= 0xffff; palabra += 37) {
    for (const valvula of ['entrada', 'salida'] as const) {
      for (const verbo of ['abrir', 'cerrar'] as const) {
        const p = planificar(palabra, valvula, verbo, { limpiarAjenos: true });
        const otra = valvula === 'entrada' ? 4096 | 8192 : 4 | 8;
        assert.equal(p.nuevo & otra, palabra & otra, `${palabra} ${valvula} ${verbo}: la otra válvula intacta`);
        assert.equal(p.nuevo & ~(4 | 8 | 4096 | 8192), 0, `${palabra}: sin bits ajenos`);
      }
    }
  }
});

test('palabra: valor exacto, primero 0 y después solo el bit 3 (decisión de campo 2026-10-16)', () => {
  const cero = planificarPalabra(4106, 0);
  assert.equal(cero.nuevo, 0);
  assert.equal(cero.cambia, true);
  assert.ok(cero.avisos.some((a) => /la entrada pasa de CERRAR a SIN SEÑAL/i.test(a)));
  assert.ok(cero.avisos.some((a) => /la salida pasa de ABRIR a SIN SEÑAL/i.test(a)), 'se avisa de que la salida pierde su señal');
  assert.ok(cero.avisos.some((a) => /bits ajenos \{1\}/.test(a)));

  const bit3 = planificarPalabra(0, 8);
  assert.equal(bit3.nuevo, 8);
  assert.deepEqual(bit3.bitsQueCambian, [3]);

  assert.equal(planificarPalabra(4104, 4104).cambia, false);
  assert.throws(() => planificarPalabra(0, 2), /fuera de \{2,3,12,13\}/, 'el 2 suelto no se puede volver a escribir');
  assert.throws(() => planificarPalabra(0, 12), /abrir y cerrar a la vez en la entrada/);
  assert.throws(() => planificarPalabra(0, 4096 | 8192), /abrir y cerrar a la vez en la salida/);

  const r = parsearArgumentos(['palabra', '0', '--armar', '--observar', '30']);
  assert.ok(r.ok);
  assert.equal(r.opciones.palabra, 0);
  assert.equal(r.opciones.valvula, null);
  assert.equal(segundosDeObservacion({ ...r.opciones, observarSeg: null }), OBSERVAR_POR_DEFECTO_SEG);
  for (const malo of [['palabra'], ['palabra', 'x'], ['palabra', '70000'], ['palabra', '8', '--sin-ajenos'], ['palabra', '8', '9']]) {
    assert.equal(parsearArgumentos(malo).ok, false, malo.join(' '));
  }
});

test('palabra --canal 1: solo 0, 4 u 8 en INT_OUT_VORAGINE[1] (prueba de la entrada, 2026-10-17)', () => {
  assert.equal(planificarPalabra(0, 4, 1).nuevo, 4);
  assert.equal(planificarPalabra(4, 0, 1).nuevo, 0);
  assert.equal(planificarPalabra(0, 8, 1).nuevo, 8);
  assert.ok(planificarPalabra(0, 8, 1).avisos.some((a) => /un solo elemento/.test(a)), 'avisa de que el MSG enviaba solo el elemento 0');
  assert.ok(planificarPalabra(1024, 4, 1).avisos.some((a) => /se APAGAN/.test(a)), 'lo que hubiera en el canal 1 se dice');
  assert.throws(() => planificarPalabra(0, 4096, 1), /solo se admiten los bits de la entrada/, 'nada de la salida en el canal 1');
  assert.throws(() => planificarPalabra(0, 2, 1), /solo se admiten los bits de la entrada/);
  assert.throws(() => planificarPalabra(0, 12, 1), /abrir y cerrar a la vez/);

  const r = parsearArgumentos(['palabra', '8', '--canal', '1', '--armar']);
  assert.ok(r.ok);
  assert.equal(r.opciones.canal, 1);
  for (const malo of [['--canal', '1'], ['entrada', 'cerrar', '--canal', '1'], ['palabra', '8', '--canal', '2'], ['palabra', '8', '--canal']]) {
    assert.equal(parsearArgumentos(malo).ok, false, malo.join(' '));
  }
  const fecha = new Date('2026-10-17T14:00:00.000Z');
  assert.equal(nombreDelLog(fecha, { valvula: null, verbo: null, palabra: 8, canal: 1 }), '2026-10-17T14-00-00-000Z-palabra-canal1-8.log');
});

test('argumentos: --sin-ajenos solo con una orden', () => {
  const r = parsearArgumentos(['entrada', 'cerrar', '--sin-ajenos', '--armar']);
  assert.ok(r.ok);
  assert.equal(r.opciones.sinAjenos, true);
  assert.equal(parsearArgumentos(['--sin-ajenos']).ok, false, 'sin orden no hay nada que limpiar');
  assert.equal(parsearArgumentos(['entrada', 'cerrar', '--sin-ajenos', '--sin-ajenos']).ok, false);
});

test('plan: si la palabra ya tiene el verbo, no hay nada que escribir', () => {
  const p = planificar(4096 | 8, 'salida', 'abrir');
  assert.equal(p.cambia, false);
  assert.deepEqual(p.bitsQueCambian, []);
});

test('argumentos: sin nada = solo estado; con orden = simulacro salvo --armar; 60 s de observación por defecto', () => {
  const r0 = parsearArgumentos([]);
  assert.ok(r0.ok);
  assert.deepEqual(r0.opciones, { valvula: null, verbo: null, armar: false, sinAjenos: false, palabra: null, canal: 0, observarSeg: null, endpoint: null });
  assert.equal(segundosDeObservacion(r0.opciones), 0);

  const r1 = parsearArgumentos(['salida', 'cerrar']);
  assert.ok(r1.ok);
  assert.equal(r1.opciones.armar, false, 'sin --armar no se escribe');
  assert.equal(segundosDeObservacion(r1.opciones), OBSERVAR_POR_DEFECTO_SEG);

  const r2 = parsearArgumentos(['entrada', 'abrir', '--armar', '--observar', '15', 'opc.tcp://10.0.0.1:4840']);
  assert.ok(r2.ok);
  assert.deepEqual(r2.opciones, { valvula: 'entrada', verbo: 'abrir', armar: true, sinAjenos: false, palabra: null, canal: 0, observarSeg: 15, endpoint: 'opc.tcp://10.0.0.1:4840' });

  const r3 = parsearArgumentos(['--observar', '120']);
  assert.ok(r3.ok);
  assert.equal(segundosDeObservacion(r3.opciones), 120);
});

test('argumentos: lo ambiguo o mal escrito se rechaza, nunca se adivina', () => {
  const malos: string[][] = [
    ['salida'],
    ['salida', 'abrir', 'cerrar'],
    ['sala', 'abrir'],
    ['salida', 'abre'],
    ['abrir', 'salida'],
    ['--armar'],
    ['salida', 'abrir', '--armar', '--armar'],
    ['--observar'],
    ['--observar', '-1'],
    ['--observar', '1.5'],
    ['--observar', '3601'],
    ['salida', 'abrir', '--forzar'],
    ['opc.tcp://a:1', 'opc.tcp://b:2'],
  ];
  for (const argv of malos) assert.equal(parsearArgumentos(argv).ok, false, argv.join(' '));
});

test('log: el nombre lleva fecha ISO sin caracteres que Windows no admite, válvula y verbo', () => {
  const fecha = new Date('2026-10-16T20:24:20.538Z');
  assert.equal(nombreDelLog(fecha, { valvula: 'salida', verbo: 'cerrar' }), '2026-10-16T20-24-20-538Z-salida-cerrar.log');
  assert.equal(nombreDelLog(fecha, { valvula: null, verbo: null }), '2026-10-16T20-24-20-538Z-observacion.log');
});

test('cuenta atrás: llega a cero si nadie cancela, y Ctrl+C la para ANTES de escribir', async () => {
  const lineas: string[] = [];
  const completa = await cuentaAtras(5, { esperar: async () => undefined, cancelado: () => false, imprimir: (l) => lineas.push(l) });
  assert.equal(completa, true);
  assert.equal(lineas.length, 5);
  assert.match(lineas[0], /en 5/);

  // Cancelación a mitad: a los 23 «ticks» de 100 ms (2,3 s).
  let ticks = 0;
  const cancelada = await cuentaAtras(5, {
    esperar: async () => {
      ticks += 1;
    },
    cancelado: () => ticks >= 23,
    imprimir: () => undefined,
  });
  assert.equal(cancelada, false);
  assert.equal(ticks, 23, 'se para en la décima siguiente, no al final del segundo');
});

test('observación: marca «◀ CAMBIÓ» con lo que cambió, y los reales a la precisión que se muestra', () => {
  const a: Muestra = { mando: 8200, estado: [7192, 1025, 0], caudalEntrada: 6.931, caudalSalida: 1.61, nivel: 1.52 };
  const b: Muestra = { ...a, mando: 4104, estado: [7192, 1, 0], caudalEntrada: 6.932 };
  assert.deepEqual(cambiosEntreMuestras(null, a), []);
  assert.deepEqual(cambiosEntreMuestras(a, b), ['OUT[0]', 'IN[1]']);
  const linea = lineaDeMuestra('15:42:07', b, a);
  assert.match(linea, /OUT\[0\]=  4104 \{3,12\}/);
  assert.match(linea, /ent=CERRAR/);
  assert.match(linea, /sal=ABRIR/);
  assert.match(linea, /◀ CAMBIÓ: OUT\[0\], IN\[1\]$/);
  assert.doesNotMatch(lineaDeMuestra('15:42:08', b, b), /CAMBIÓ/);
  assert.match(lineaDeMuestra('15:42:09', { ...b, mando: null }, b), /OUT\[0\]=  ilegible/);
});
