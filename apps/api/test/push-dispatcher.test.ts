/**
 * Avisos por push (FCM): a quién, qué, cuándo y qué pasa cuando Google falla.
 *
 * Lo que fijan estos tests, y por qué importa en una planta en producción:
 *
 *  1. **A quién**: la MISMA regla que la bandeja (permiso, planta y cuenta activa) y las preferencias
 *     de cada uno. Si divergieran, a alguien le sonaría un aviso que luego no encuentra en su bandeja.
 *  2. **Qué**: el mensaje que entiende Android sin la app abierta —canal, etiqueta `n-<id>` que
 *     reemplaza en vez de duplicar, prioridad— y que firebase-admin lo acepta tal cual.
 *  3. **Cuándo**: una ráfaga sale agrupada; lo crítico, uno por uno; y `create()` NO espera al envío.
 *  4. **Fallos**: token muerto → se borra; 429/5xx → reintentos; tiempo agotado → se da por perdido;
 *     sin clave de Firebase → apagado, sin romper nada.
 *
 * Nada aquí habla con Google: el emisor es falso, y donde hace falta firebase-admin solo se usa su
 * validador local o un cargador inyectado.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Pool } from 'mysql2/promise';
import { NOTIFICATION_PREFS_DEFAULT, type NotificationPrefsDto } from '@ptap/shared';
import type { TokenMessage } from 'firebase-admin/messaging';
import {
  DevicePushTokenRepository,
  recibeAvisosDe,
  type Destinatario,
} from '../src/modules/notifications/device-push-token.repository';
import { createFcmSender, type FirebaseAdminApi, type PushSender } from '../src/modules/notifications/fcm.sender';
import type { NotificationPrefsRepository } from '../src/modules/notifications/notification-prefs.repository';
import {
  NotificationRepository,
  type CreatedNotification,
  type NewNotification,
  type NotificationListener,
} from '../src/modules/notifications/notification.repository';
import {
  clasificarError,
  horaDeColombia,
  mensajeDeAviso,
  mensajeDeResumen,
  planDeMensajes,
  PushDispatcher,
  type PushOptions,
} from '../src/modules/notifications/push.dispatcher';

// ── Dobles ───────────────────────────────────────────────────────────────────────────────────────

function aviso(id: number, o: Partial<CreatedNotification> = {}): CreatedNotification {
  return {
    id,
    kind: 'sensor_stale',
    severity: 'warning',
    plantId: 'km18',
    subject: 'outletFlow1',
    title: `Aviso ${id}`,
    message: `Detalle ${id}`,
    action: null,
    day: '2026-10-20',
    createdAt: '2026-10-20T15:00:00.000Z',
    ...o,
  };
}

interface Envio {
  token: string;
  message: TokenMessage;
}

/** Emisor falso: registra cada envío y responde lo que diga `responder` (por defecto, aceptado). */
function emisor(responder: (m: TokenMessage, n: number) => Promise<void> | void = () => undefined): PushSender & { envios: Envio[] } {
  const envios: Envio[] = [];
  return {
    project: 'proyecto-de-prueba',
    envios,
    send: async (message: TokenMessage) => {
      envios.push({ token: message.token, message });
      await responder(message, envios.length);
    },
  };
}

/** Error con la forma de los de firebase-admin (`code`, `httpResponse.status`). */
function errorFcm(code: string, status?: number, message = 'error de FCM'): Error {
  return Object.assign(new Error(message), {
    code,
    ...(status === undefined ? {} : { httpResponse: { status } }),
  });
}

interface Montaje {
  dispatcher: PushDispatcher;
  sender: ReturnType<typeof emisor>;
  borrados: string[];
  consultas: string[];
}

function montar(opts: {
  destinatarios: Record<string, Destinatario[]>;
  prefs?: Record<string, NotificationPrefsDto>;
  sender?: ReturnType<typeof emisor>;
  options?: Partial<PushOptions>;
}): Montaje {
  const borrados: string[] = [];
  const consultas: string[] = [];
  const sender = opts.sender ?? emisor();
  const devices = {
    destinatarios: async (plantId: string) => {
      consultas.push(plantId);
      return opts.destinatarios[plantId] ?? [];
    },
    borrarToken: async (token: string) => {
      borrados.push(token);
    },
    tokensDe: async (userId: string) =>
      Object.values(opts.destinatarios)
        .flat()
        .filter((d) => d.userId === userId)
        .flatMap((d) => d.tokens),
  } as unknown as DevicePushTokenRepository;
  const prefs = {
    get: async (userId: string) => opts.prefs?.[userId] ?? NOTIFICATION_PREFS_DEFAULT,
  } as unknown as NotificationPrefsRepository;
  const notifications = { onCreated: () => undefined } as unknown as NotificationRepository;
  const dispatcher = new PushDispatcher(devices, prefs, notifications, {
    sender,
    windowMs: 20,
    timeoutMs: 200,
    retryDelaysMs: [1, 2, 4],
    // 15:00 en Colombia: fuera de cualquier franja nocturna salvo que el test diga otra cosa.
    now: () => new Date('2026-10-20T20:00:00Z'),
    ...opts.options,
  });
  return { dispatcher, sender, borrados, consultas };
}

const UN_TELEFONO = (userId: string, ...tokens: string[]): Destinatario => ({ userId, tokens });

const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function hasta(condicion: () => boolean, ms = 1000): Promise<void> {
  const fin = Date.now() + ms;
  while (!condicion()) {
    if (Date.now() > fin) throw new Error('la condición no se cumplió a tiempo');
    await esperar(5);
  }
}

// ── 1. A quién ───────────────────────────────────────────────────────────────────────────────────

test('destinatarios: misma regla que la bandeja — permiso, planta y view_all_plants', () => {
  assert.equal(recibeAvisosDe('operador', 'km18', 'km18'), true);
  assert.equal(recibeAvisosDe('jefe', 'km18', 'km18'), true);
  assert.equal(recibeAvisosDe('operador', 'cascajal', 'km18'), false, 'otra planta: no');
  assert.equal(recibeAvisosDe('admin', 'voragine', 'km18'), true, 'view_all_plants: todas');
  assert.equal(recibeAvisosDe('civil', 'km18', 'km18'), false, 'el Civil no recibe avisos de proceso');
  assert.equal(recibeAvisosDe('operador', null, 'km18'), false, 'sin planta asignada no hay ámbito');
  assert.equal(recibeAvisosDe('operador', '', 'km18'), false);
  assert.equal(recibeAvisosDe('superusuario', 'km18', 'km18'), false, 'un rol desconocido no recibe nada');
});

test('destinatarios: la cuenta inactiva se filtra EN SQL, y los teléfonos se agrupan por usuario', async () => {
  // Pool falso que solo filtra por cuenta activa si el SQL lo pide: si el filtro faltara, se notaría.
  const filas = [
    { token: 'tok-op-1', user_id: 'u-op', role: 'operador', plant: 'km18', is_active: 1 },
    { token: 'tok-op-2', user_id: 'u-op', role: 'operador', plant: 'km18', is_active: 1 },
    { token: 'tok-jefe', user_id: 'u-jefe', role: 'jefe', plant: 'km18', is_active: 1 },
    { token: 'tok-otra', user_id: 'u-cascajal', role: 'operador', plant: 'cascajal', is_active: 1 },
    { token: 'tok-admin', user_id: 'u-admin', role: 'admin', plant: 'voragine', is_active: 1 },
    { token: 'tok-civil', user_id: 'u-civil', role: 'civil', plant: 'km18', is_active: 1 },
    { token: 'tok-baja', user_id: 'u-baja', role: 'operador', plant: 'km18', is_active: 0 },
  ];
  const sqls: string[] = [];
  const pool = {
    query: async (sql: string) => {
      sqls.push(sql);
      const activas = /is_active\s*=\s*1/.test(sql) ? filas.filter((f) => f.is_active === 1) : filas;
      return [activas, undefined];
    },
  } as unknown as Pool;

  const d = await new DevicePushTokenRepository(pool).destinatarios('km18');
  assert.deepEqual(
    d.map((x) => [x.userId, x.tokens]),
    [
      ['u-op', ['tok-op-1', 'tok-op-2']],
      ['u-jefe', ['tok-jefe']],
      ['u-admin', ['tok-admin']],
    ],
  );
  assert.match(sqls[0], /JOIN users/);
});

test('destinatarios: cada uno con SUS preferencias — un tipo silenciado no se empuja', async () => {
  const { dispatcher, sender } = montar({
    destinatarios: { km18: [UN_TELEFONO('u-callado', 'tok-a'), UN_TELEFONO('u-normal', 'tok-b')] },
    prefs: { 'u-callado': { ...NOTIFICATION_PREFS_DEFAULT, mutedKinds: ['sensor_stale'] } },
  });
  dispatcher.enqueue(aviso(1));
  await dispatcher.flush();
  assert.deepEqual(
    sender.envios.map((e) => e.token),
    ['tok-b'],
    'a quien lo silenció no le llega; al resto sí',
  );
});

test('«no molestar» en hora de COLOMBIA: calla lo normal, lo crítico lo atraviesa', async () => {
  const nocturno: NotificationPrefsDto = { ...NOTIFICATION_PREFS_DEFAULT, quietFrom: '22:00', quietTo: '06:00' };
  // 08:00 UTC = 03:00 en Colombia, sea cual sea la zona del proceso.
  const madrugada = montar({
    destinatarios: { km18: [UN_TELEFONO('u1', 'tok')] },
    prefs: { u1: nocturno },
    options: { now: () => new Date('2026-08-21T08:00:00Z') },
  });
  madrugada.dispatcher.enqueue(aviso(1, { severity: 'warning' }));
  madrugada.dispatcher.enqueue(aviso(2, { severity: 'critical', kind: 'tank_level' }));
  await madrugada.dispatcher.flush();
  assert.deepEqual(
    madrugada.sender.envios.map((e) => e.message.android?.notification?.tag),
    ['n-2'],
    'a las 3 a. m. solo suena el crítico',
  );

  // 20:00 UTC = 15:00 en Colombia: fuera de la franja.
  const tarde = montar({ destinatarios: { km18: [UN_TELEFONO('u1', 'tok')] }, prefs: { u1: nocturno } });
  tarde.dispatcher.enqueue(aviso(1, { severity: 'warning' }));
  await tarde.dispatcher.flush();
  assert.equal(tarde.sender.envios.length, 1);
});

test('horaDeColombia: la hora local del resultado es la de Bogotá (UTC−5), no la del proceso', () => {
  const h = horaDeColombia(new Date('2026-08-21T08:00:00Z'));
  assert.equal(h.getHours(), 3);
  assert.equal(h.getMinutes(), 0);
  const medianoche = horaDeColombia(new Date('2026-08-21T05:00:00Z'));
  assert.equal(medianoche.getHours(), 0, 'la medianoche es 0, no 24');
  assert.equal(horaDeColombia(new Date('2026-08-21T04:59:00Z')).getHours(), 23);
});

// ── 2. Qué se manda ──────────────────────────────────────────────────────────────────────────────

test('mensaje de un aviso crítico: canal aquora-criticas, etiqueta n-<id>, prioridad alta y MAX', () => {
  const m = mensajeDeAviso(
    aviso(41, {
      severity: 'critical',
      kind: 'tank_level',
      plantId: 'voragine',
      subject: 'tank1Level',
      title: 'Tanque 1 rebosando',
      message: 'Lleva 20 min por encima del máximo.',
      action: 'Cerrar la entrada del tanque 1.',
    }),
  );
  assert.deepEqual(m.notification, {
    title: 'Tanque 1 rebosando',
    body: 'Lleva 20 min por encima del máximo.\n\n▸ Cerrar la entrada del tanque 1.',
  });
  assert.equal(m.android?.priority, 'high', 'entrega inmediata aunque el teléfono esté en reposo');
  assert.deepEqual(m.android?.notification, {
    channelId: 'aquora-criticas',
    tag: 'n-41',
    sound: 'default',
    defaultVibrateTimings: true,
    visibility: 'public',
    priority: 'max',
  });
  assert.deepEqual(m.data, {
    id: '41',
    plantId: 'voragine',
    subject: 'tank1Level',
    kind: 'tank_level',
    tag: 'n-41',
    channelId: 'aquora-criticas',
  });
});

test('mensaje de un aviso normal: canal aquora-avisos, prioridad HIGH, sin la acción en el cuerpo', () => {
  const m = mensajeDeAviso(aviso(7, { subject: null, action: 'Revisar el sensor.' }));
  assert.equal(m.notification?.body, 'Detalle 7', 'lo normal no lleva la acción: igual que la consulta de respaldo');
  assert.equal(m.android?.notification?.channelId, 'aquora-avisos');
  assert.equal(m.android?.notification?.priority, 'high');
  assert.equal(m.android?.notification?.tag, 'n-7');
  assert.equal(m.data?.subject, '', 'FCM solo admite texto en data: sin sujeto, cadena vacía');
  for (const [k, v] of Object.entries(m.data ?? {})) assert.equal(typeof v, 'string', `data.${k} debe ser texto`);
});

test('firebase-admin acepta el mensaje y lo pone en el cable como pide FCM (PRIORITY_MAX, PUBLIC)', () => {
  // Validador LOCAL de firebase-admin: el mismo que corre dentro de `send()` antes de tocar la red.
  // No es una exportación pública; si una versión nueva lo mueve, este test lo dirá.
  const requerir = createRequire(__filename);
  const interno = requerir(join(dirname(requerir.resolve('firebase-admin/messaging')), 'messaging-internal.js')) as {
    validateMessage(m: unknown): void;
  };
  const critico = structuredClone({ ...mensajeDeAviso(aviso(3, { severity: 'critical' })), token: 'tok' });
  interno.validateMessage(critico);
  const n = (critico.android as unknown as { notification: Record<string, unknown> }).notification;
  assert.equal(n.notification_priority, 'PRIORITY_MAX');
  assert.equal(n.visibility, 'PUBLIC');
  assert.equal(n.channel_id, 'aquora-criticas');
  assert.equal(n.default_vibrate_timings, true);
  assert.equal(n.tag, 'n-3');
  assert.equal(n.sound, 'default');

  const normal = structuredClone({ ...mensajeDeAviso(aviso(4)), token: 'tok' });
  interno.validateMessage(normal);
  assert.equal(
    (normal.android as unknown as { notification: Record<string, unknown> }).notification.notification_priority,
    'PRIORITY_HIGH',
  );
  const resumen = structuredClone({ ...mensajeDeResumen([aviso(5), aviso(6), aviso(8)]), token: 'tok' });
  interno.validateMessage(resumen);
});

test('resumen: mismo texto que la app, etiqueta «resumen», id del más reciente', () => {
  const m = mensajeDeResumen([aviso(5, { plantId: 'km18' }), aviso(9, { plantId: 'sirena' }), aviso(6, { plantId: 'km18' })]);
  assert.equal(m.notification?.title, '3 avisos nuevos');
  assert.equal(m.notification?.body, '2 plantas requieren atención. Abre la aplicación para ver el detalle.');
  assert.equal(m.android?.notification?.tag, 'resumen');
  assert.equal(m.android?.notification?.channelId, 'aquora-avisos');
  assert.equal(m.data?.id, '9');
  assert.equal(m.data?.plantId, '', 'de varias plantas: ninguna en concreto');
  const unaPlanta = mensajeDeResumen([aviso(1), aviso(2), aviso(3)]);
  assert.equal(unaPlanta.notification?.body, '1 planta requieren atención. Abre la aplicación para ver el detalle.');
  assert.equal(unaPlanta.data?.plantId, 'km18');
});

// ── 3. Cuándo y cómo se agrupa ───────────────────────────────────────────────────────────────────

test('agrupación: lo crítico sale uno por uno; más de dos normales, en UN resumen', () => {
  const lote = [
    aviso(1),
    aviso(2, { severity: 'critical' }),
    aviso(3),
    aviso(4, { severity: 'critical' }),
    aviso(5, { severity: 'info' }),
  ];
  const tags = planDeMensajes(lote, NOTIFICATION_PREFS_DEFAULT, new Date()).map((m) => m.android?.notification?.tag);
  assert.deepEqual(tags, ['n-2', 'n-4', 'resumen']);

  const dos = planDeMensajes([aviso(1), aviso(3)], NOTIFICATION_PREFS_DEFAULT, new Date());
  assert.deepEqual(
    dos.map((m) => m.android?.notification?.tag),
    ['n-1', 'n-3'],
    'dos normales todavía salen sueltos',
  );
});

test('agrupación: una ráfaga dentro de la ventana sale de UNA vez, con una consulta por planta', async () => {
  const { dispatcher, sender, consultas } = montar({ destinatarios: { km18: [UN_TELEFONO('u1', 'tok')] } });
  dispatcher.enqueue(aviso(1));
  dispatcher.enqueue(aviso(2));
  dispatcher.enqueue(aviso(3));
  assert.equal(sender.envios.length, 0, 'nada sale antes de cerrar la ventana');

  await hasta(() => sender.envios.length > 0);
  await esperar(30);
  assert.deepEqual(
    sender.envios.map((e) => e.message.android?.notification?.tag),
    ['resumen'],
    'los tres en un solo resumen',
  );
  assert.deepEqual(consultas, ['km18'], 'una sola consulta de destinatarios para la ráfaga');
});

test('agrupación: cada teléfono del usuario recibe lo suyo; otra planta, a sus destinatarios', async () => {
  const { dispatcher, sender } = montar({
    destinatarios: {
      km18: [UN_TELEFONO('u-km18', 'tok-1', 'tok-2'), UN_TELEFONO('u-admin', 'tok-admin')],
      sirena: [UN_TELEFONO('u-admin', 'tok-admin')],
    },
  });
  dispatcher.enqueue(aviso(1, { plantId: 'km18' }));
  dispatcher.enqueue(aviso(2, { plantId: 'sirena' }));
  const r = await dispatcher.flush();
  const porToken = (t: string) => sender.envios.filter((e) => e.token === t).map((e) => e.message.android?.notification?.tag);
  assert.deepEqual(porToken('tok-1'), ['n-1']);
  assert.deepEqual(porToken('tok-2'), ['n-1'], 'los dos teléfonos de la misma persona');
  assert.deepEqual(porToken('tok-admin'), ['n-1', 'n-2'], 'el admin recibe las dos plantas');
  assert.equal(r.enviados, 4);
  assert.equal(r.fallidos, 0);
});

// ── 4. Fallos ────────────────────────────────────────────────────────────────────────────────────

test('token NO registrado (UNREGISTERED): se borra y no se le manda nada más; los demás siguen', async () => {
  const sender = emisor((m) => {
    if (m.token === 'tok-muerto') throw errorFcm('messaging/registration-token-not-registered', 404);
  });
  const { dispatcher, borrados } = montar({
    destinatarios: { km18: [UN_TELEFONO('u1', 'tok-muerto', 'tok-vivo')] },
    sender,
  });
  dispatcher.enqueue(aviso(1, { severity: 'critical' }));
  dispatcher.enqueue(aviso(2, { severity: 'critical' }));
  const r = await dispatcher.flush();
  assert.deepEqual(borrados, ['tok-muerto']);
  assert.equal(sender.envios.filter((e) => e.token === 'tok-muerto').length, 1, 'tras el primer rechazo, nada más');
  assert.equal(sender.envios.filter((e) => e.token === 'tok-vivo').length, 2);
  assert.equal(r.tokensBorrados, 1);
});

test('INVALID_ARGUMENT: solo se borra el token si el error habla del token, no si el mensaje está mal', () => {
  assert.equal(
    clasificarError(errorFcm('messaging/invalid-argument', 400, 'The registration token is not a valid FCM registration token')).clase,
    'token-muerto',
  );
  assert.equal(
    clasificarError(errorFcm('messaging/invalid-argument', 400, 'Invalid value at message.android.notification')).clase,
    'fallo',
    'un mensaje mal construido es un error nuestro: borrar el token dejaría a todos sin push',
  );
  assert.equal(clasificarError(errorFcm('messaging/invalid-registration-token')).clase, 'token-muerto');
  assert.equal(clasificarError(errorFcm('messaging/mismatched-credential', 403)).clase, 'fallo');
  assert.equal(clasificarError(new Error('cualquier otra cosa')).clase, 'fallo');
  assert.equal(clasificarError(undefined).clase, 'fallo');
});

test('5xx: se reintenta con espera creciente hasta que entra', async () => {
  const sender = emisor((_m, n) => {
    if (n <= 2) throw errorFcm('messaging/internal-error', 500);
  });
  const { dispatcher, borrados } = montar({ destinatarios: { km18: [UN_TELEFONO('u1', 'tok')] }, sender });
  dispatcher.enqueue(aviso(1));
  const r = await dispatcher.flush();
  assert.equal(sender.envios.length, 3, 'dos fallos y el tercero entra');
  assert.equal(r.enviados, 1);
  assert.deepEqual(borrados, [], 'un 5xx no es culpa del token');
});

test('429 y 503 persistentes: tres reintentos y se da por fallido, sin lanzar', async () => {
  for (const err of [errorFcm('messaging/message-rate-exceeded', 429), errorFcm('messaging/server-unavailable', 503)]) {
    const sender = emisor(() => {
      throw err;
    });
    const { dispatcher } = montar({ destinatarios: { km18: [UN_TELEFONO('u1', 'tok')] }, sender });
    dispatcher.enqueue(aviso(1));
    const r = await dispatcher.flush();
    assert.equal(sender.envios.length, 4, `${err.message}: el intento y tres reintentos`);
    assert.equal(r.fallidos, 1);
  }
});

test('un error que no es 429/5xx NO se reintenta', async () => {
  const sender = emisor(() => {
    throw errorFcm('messaging/mismatched-credential', 403);
  });
  const { dispatcher, borrados } = montar({ destinatarios: { km18: [UN_TELEFONO('u1', 'tok')] }, sender });
  dispatcher.enqueue(aviso(1));
  await dispatcher.flush();
  assert.equal(sender.envios.length, 1);
  assert.deepEqual(borrados, [], 'una credencial de otro proyecto no condena al token');
});

test('tiempo máximo por envío: si FCM no contesta, se da por fallido y NO se repite', async () => {
  const sender = emisor(() => new Promise<void>(() => undefined)); // nunca contesta
  const { dispatcher } = montar({
    destinatarios: { km18: [UN_TELEFONO('u1', 'tok')] },
    sender,
    options: { timeoutMs: 40 },
  });
  dispatcher.enqueue(aviso(1));
  const t0 = Date.now();
  const r = await dispatcher.flush();
  assert.ok(Date.now() - t0 < 1000, 'no se queda colgado esperando a Google');
  assert.equal(r.fallidos, 1);
  assert.equal(sender.envios.length, 1, 'pudo haber llegado: repetirlo lo haría sonar dos veces');
});

test('si fallan los destinatarios (base caída), flush no lanza', async () => {
  const devices = {
    destinatarios: async () => {
      throw new Error('ECONNREFUSED');
    },
  } as unknown as DevicePushTokenRepository;
  const prefs = { get: async () => NOTIFICATION_PREFS_DEFAULT } as unknown as NotificationPrefsRepository;
  const notifications = { onCreated: () => undefined } as unknown as NotificationRepository;
  const sender = emisor();
  const d = new PushDispatcher(devices, prefs, notifications, { sender, windowMs: 10 });
  d.enqueue(aviso(1));
  const r = await d.flush();
  assert.equal(r.enviados, 0);
  assert.equal(sender.envios.length, 0);
});

// ── 5. Apagado sin credenciales ──────────────────────────────────────────────────────────────────

function registro() {
  const lineas: string[] = [];
  return {
    lineas,
    log: (m: string) => void lineas.push(`LOG ${m}`),
    warn: (m: string) => void lineas.push(`WARN ${m}`),
    error: (m: string) => void lineas.push(`ERROR ${m}`),
  };
}

test('sin FIREBASE_SERVICE_ACCOUNT_PATH: push apagado, con el motivo en el log', async () => {
  const r = registro();
  assert.equal(await createFcmSender(undefined, r), null);
  assert.equal(await createFcmSender('   ', r), null);
  assert.ok(r.lineas.every((l) => l === 'WARN push apagado: falta FIREBASE_SERVICE_ACCOUNT_PATH'), r.lineas.join('\n'));
});

test('clave inexistente, ilegible o incompleta: apagado, y el contenido de la clave NO llega al log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptap-push-'));
  try {
    const r = registro();
    assert.equal(await createFcmSender(join(dir, 'no-existe.json'), r), null);
    assert.match(r.lineas.at(-1) ?? '', /no existe el archivo/);

    const roto = join(dir, 'roto.json');
    // JSON cortado a mitad de la clave. Sin cabecera PEM a propósito: es un texto falso, y así ningún
    // escáner de secretos lo confunde con una clave de verdad.
    writeFileSync(roto, '{"private_key": "clave-privada-SECRETO-QUE-NO-DEBE-SALIR');
    assert.equal(await createFcmSender(roto, r), null);
    assert.match(r.lineas.at(-1) ?? '', /no se pudo leer como JSON/);
    assert.ok(!r.lineas.join('\n').includes('SECRETO'), 'ni un trozo de la clave en el log');

    const incompleto = join(dir, 'incompleto.json');
    writeFileSync(incompleto, JSON.stringify({ project_id: 'p' }));
    let cargado = false;
    const sender = await createFcmSender(incompleto, r, async () => {
      cargado = true;
      throw new Error('no debía cargarse');
    });
    assert.equal(sender, null);
    assert.equal(cargado, false, 'firebase-admin ni se carga si la clave no sirve');
    assert.match(r.lineas.at(-1) ?? '', /no es una clave de cuenta de servicio/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('con clave: arranca firebase-admin (cargador falso) y dice el proyecto; send llega a messaging.send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptap-push-'));
  try {
    const clave = join(dir, 'sa.json');
    writeFileSync(
      clave,
      JSON.stringify({ project_id: 'aquora-test', client_email: 'sa@aquora-test.iam', private_key: 'clave-de-mentira' }),
    );
    const llamadas: string[] = [];
    const enviados: unknown[] = [];
    const falso = {
      cert: (c: unknown) => {
        llamadas.push(`cert ${JSON.stringify(c)}`);
        return { credencial: true };
      },
      initializeApp: (opts: { projectId?: string }, nombre?: string) => {
        llamadas.push(`initializeApp ${opts.projectId} ${nombre}`);
        return { app: true };
      },
      getMessaging: () => ({
        send: async (m: unknown) => {
          enviados.push(m);
          return 'projects/aquora-test/messages/1';
        },
      }),
    } as unknown as FirebaseAdminApi;
    const r = registro();
    const sender = await createFcmSender(clave, r, async () => falso);
    assert.ok(sender);
    assert.equal(sender.project, 'aquora-test');
    assert.deepEqual(r.lineas, ['LOG push FCM activo (proyecto aquora-test)']);
    assert.equal(llamadas[1], 'initializeApp aquora-test aquora-push');
    await sender.send({ token: 't', data: { a: 'b' } });
    assert.deepEqual(enviados, [{ token: 't', data: { a: 'b' } }]);
    assert.ok(!r.lineas.join('\n').includes('clave-de-mentira'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatcher apagado: no encola, no consulta nada, y la prueba responde pushActivo:false', async () => {
  const { dispatcher, sender, consultas } = montar({
    destinatarios: { km18: [UN_TELEFONO('u1', 'tok')] },
    options: { sender: null },
  });
  assert.equal(dispatcher.active, false);
  dispatcher.enqueue(aviso(1));
  const r = await dispatcher.flush();
  assert.equal(r.avisos, 0, 'sin push no se acumula nada');
  assert.deepEqual(consultas, []);
  assert.equal(sender.envios.length, 0);
  assert.deepEqual(await dispatcher.sendTest('u1', 'km18'), { pushActivo: false, telefonos: 0, enviados: 0, fallidos: 0 });
});

test('arranque sin la variable de entorno: onModuleInit deja el push apagado y se engancha igual', async () => {
  const previo = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  try {
    let oyente: NotificationListener | null = null;
    const notifications = {
      onCreated: (l: NotificationListener | null) => {
        oyente = l;
      },
    } as unknown as NotificationRepository;
    const d = new PushDispatcher({} as DevicePushTokenRepository, {} as NotificationPrefsRepository, notifications);
    await d.onModuleInit();
    assert.equal(d.active, false);
    assert.notEqual(oyente, null, 'el oyente queda puesto: si mañana hay clave, basta reiniciar');
    d.onModuleDestroy();
    assert.equal(oyente, null, 'al apagar se suelta');
  } finally {
    if (previo !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT_PATH = previo;
  }
});

// ── 6. create() no espera al push ────────────────────────────────────────────────────────────────

const NUEVO: NewNotification = {
  kind: 'valve_command',
  severity: 'info',
  plantId: 'voragine',
  subject: 'valve1',
  title: 'Ana abrió la salida',
  message: 'Orden enviada.',
  action: null,
  day: '2026-10-20',
  eventId: 'e1',
};

function poolConInsertId(insertId: number | undefined, falla?: { code: string }): Pool {
  return {
    query: async () => {
      if (falla) throw Object.assign(new Error(falla.code), falla);
      return [{ insertId, affectedRows: 1 }, undefined];
    },
  } as unknown as Pool;
}

test('create() vuelve en cuanto inserta, aunque el oyente tarde (o no termine nunca)', async () => {
  const repo = new NotificationRepository(poolConInsertId(77));
  const recibidos: CreatedNotification[] = [];
  // Lo que importa no es solo que sea rápido: es que el oyente corra DESPUÉS de que quien llamó a
  // create() ya tenga su respuesta y haya seguido con lo suyo (en una maniobra, contestar al mando).
  let elLlamadorYaSiguio = false;
  const vistoPorElOyente: boolean[] = [];
  repo.onCreated(async (n) => {
    vistoPorElOyente.push(elLlamadorYaSiguio);
    recibidos.push(n);
    await new Promise<void>(() => undefined); // un push colgado para siempre
  });

  const t0 = Date.now();
  const creado = await repo.create(NUEVO);
  elLlamadorYaSiguio = true;
  const ms = Date.now() - t0;

  assert.equal(creado, true);
  assert.ok(ms < 100, `create() tardó ${ms} ms`);
  await hasta(() => recibidos.length === 1);
  assert.deepEqual(vistoPorElOyente, [true], 'el oyente corre después de que create() devolvió');
  assert.equal(recibidos[0].id, 77);
  assert.equal(recibidos[0].title, NUEVO.title);
  assert.equal(recibidos[0].eventId, 'e1');
  assert.match(recibidos[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('create(): un oyente que revienta no cambia el resultado ni deja promesas sin atender', async () => {
  const repo = new NotificationRepository(poolConInsertId(5));
  let llamado = 0;
  repo.onCreated(() => {
    llamado++;
    throw new Error('push roto');
  });
  const sinAtender: unknown[] = [];
  const alRechazo = (e: unknown) => void sinAtender.push(e);
  process.on('unhandledRejection', alRechazo);
  try {
    assert.equal(await repo.create(NUEVO), true);
    await hasta(() => llamado === 1);
    await esperar(20);
    assert.deepEqual(sinAtender, []);
  } finally {
    process.off('unhandledRejection', alRechazo);
  }
});

test('create(): sin aviso nuevo (duplicado) o sin insertId, el oyente no se entera', async () => {
  let llamado = 0;
  const oyente = () => {
    llamado++;
  };
  const duplicado = new NotificationRepository(poolConInsertId(9, { code: 'ER_DUP_ENTRY' }));
  duplicado.onCreated(oyente);
  assert.equal(await duplicado.create(NUEVO), false);

  const sinId = new NotificationRepository(poolConInsertId(undefined));
  sinId.onCreated(oyente);
  assert.equal(await sinId.create(NUEVO), true, 'el aviso se guardó igual');

  await esperar(20);
  assert.equal(llamado, 0);
});
