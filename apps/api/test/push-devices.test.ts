/**
 * Endpoints del push: alta y baja del teléfono, y el aviso de prueba.
 *
 * Lo que fijan, que es lo que haría daño si se rompiera:
 *  - El teléfono se registra a nombre de QUIEN PIDE (el token de sesión), nunca de lo que diga el
 *    cuerpo; y la baja solo borra un token si es suyo.
 *  - La respuesta dice si el servidor puede empujar (`pushActivo`): de eso depende que la app deje de
 *    publicar por su cuenta. Con el push apagado tiene que decir `false`.
 *  - La prueba va SOLO a los teléfonos de quien la pide.
 *  - Mismos guardas que la bandeja: sin sesión 401, el Civil 403.
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Role } from '@ptap/shared';
import type { Pool } from 'mysql2/promise';
import type { TokenMessage } from 'firebase-admin/messaging';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../src/modules/auth/guards/permission.guard';
import { JwtService } from '../src/modules/auth/jwt.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { MYSQL_POOL } from '../src/infrastructure/database/database.tokens';
import { NotificationRepository } from '../src/modules/notifications/notification.repository';
import { NotificationsController } from '../src/modules/notifications/notifications.controller';
import { NotificationPrefsRepository } from '../src/modules/notifications/notification-prefs.repository';
import { DevicePushTokenRepository } from '../src/modules/notifications/device-push-token.repository';
import { PushDispatcher, PUSH_OPTIONS } from '../src/modules/notifications/push.dispatcher';
import type { PushSender } from '../src/modules/notifications/fcm.sender';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-push-devices';

const CUENTAS: Record<string, { role: Role; plant: string }> = {
  'u-op': { role: 'operador', plant: 'km18' },
  'u-otro': { role: 'operador', plant: 'km18' },
  'u-admin': { role: 'admin', plant: 'voragine' },
  'u-civil': { role: 'civil', plant: 'km18' },
};

/** Tabla `device_push_token` en memoria: token → dueño. Responde a las consultas del repositorio. */
function fakePool(inicial: Record<string, string> = {}) {
  const tabla = new Map<string, string>(Object.entries(inicial));
  const inserts: unknown[][] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (/^\s*INSERT INTO device_push_token/i.test(sql)) {
        inserts.push(params);
        tabla.set(params[1] as string, params[0] as string);
        return [{ affectedRows: 1 }, undefined];
      }
      if (/DELETE FROM device_push_token WHERE token = \? AND user_id = \?/i.test(sql)) {
        const [token, userId] = params as string[];
        const suyo = tabla.get(token) === userId;
        if (suyo) tabla.delete(token);
        return [{ affectedRows: suyo ? 1 : 0 }, undefined];
      }
      if (/DELETE FROM device_push_token WHERE token = \?/i.test(sql)) {
        tabla.delete(params[0] as string);
        return [{ affectedRows: 1 }, undefined];
      }
      if (/SELECT token FROM device_push_token WHERE user_id = \?/i.test(sql)) {
        return [[...tabla].filter(([, u]) => u === params[0]).map(([token]) => ({ token })), undefined];
      }
      return [[], undefined];
    },
  } as unknown as Pool;
  return { pool, tabla, inserts };
}

function emisor(muertos: string[] = []): PushSender & { envios: TokenMessage[] } {
  const envios: TokenMessage[] = [];
  return {
    project: 'p',
    envios,
    send: async (m: TokenMessage) => {
      envios.push(m);
      if (muertos.includes(m.token)) {
        throw Object.assign(new Error('not registered'), {
          code: 'messaging/registration-token-not-registered',
          httpResponse: { status: 404 },
        });
      }
    },
  };
}

async function buildApp(pool: Pool, sender: PushSender | null) {
  @Module({
    controllers: [NotificationsController],
    providers: [
      NotificationRepository,
      NotificationPrefsRepository,
      DevicePushTokenRepository,
      PushDispatcher,
      { provide: PUSH_OPTIONS, useValue: { sender, windowMs: 10, retryDelaysMs: [] } },
      JwtAuthGuard,
      PermissionGuard,
      JwtService,
      { provide: MYSQL_POOL, useValue: pool },
      {
        provide: UsersRepository,
        useValue: {
          findById: async (id: string) =>
            CUENTAS[id]
              ? { id, email: `${id}@ptap.co`, name: id, ...CUENTAS[id], passwordHash: 'x', pepperVersion: 1, isActive: true }
              : null,
        } as unknown as UsersRepository,
      },
    ],
  })
  class PushTestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [PushTestModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  const jwt = moduleRef.get(JwtService) as JwtService;
  const bearer = (sub: string) =>
    `Bearer ${jwt.sign({ sub, email: `${sub}@ptap.co`, name: sub, role: CUENTAS[sub].role, plant: CUENTAS[sub].plant })}`;
  return { app, bearer };
}

const TOKEN_FCM = 'cZx1-AbC_9:APA91bHpQ-ejemplo_de_token';

test('alta: se registra a nombre del token de sesión, no del cuerpo; con el push apagado dice pushActivo:false', async () => {
  const { pool, inserts } = fakePool();
  const { app, bearer } = await buildApp(pool, null);
  try {
    const res = await request(app.getHttpServer())
      .post('/api/notifications/devices')
      .set('Authorization', bearer('u-op'))
      .send({ token: TOKEN_FCM, platform: 'android', appVersion: '1.4.0', userId: 'u-admin' })
      .expect(201);
    assert.deepEqual(res.body, { registrado: true, pushActivo: false });
    assert.deepEqual(inserts, [['u-op', TOKEN_FCM, 'android', '1.4.0']], 'el userId del cuerpo se ignora');
  } finally {
    await app.close();
  }
});

test('alta con el push encendido: pushActivo:true (la app puede dejar de publicar por su cuenta)', async () => {
  const { pool } = fakePool();
  const { app, bearer } = await buildApp(pool, emisor());
  try {
    const res = await request(app.getHttpServer())
      .post('/api/notifications/devices')
      .set('Authorization', bearer('u-op'))
      .send({ token: TOKEN_FCM, platform: 'android' })
      .expect(201);
    assert.deepEqual(res.body, { registrado: true, pushActivo: true });
  } finally {
    await app.close();
  }
});

test('alta: lo que no es un token de FCM de Android se rechaza con 400, sin tocar la base', async () => {
  const { pool, inserts } = fakePool();
  const { app, bearer } = await buildApp(pool, null);
  try {
    for (const cuerpo of [
      { token: 'con espacios dentro', platform: 'android' },
      { token: 'ñandú', platform: 'android' },
      { token: 'x'.repeat(513), platform: 'android' },
      { token: '', platform: 'android' },
      { platform: 'android' },
      { token: TOKEN_FCM, platform: 'ios' },
      { token: TOKEN_FCM },
    ]) {
      await request(app.getHttpServer())
        .post('/api/notifications/devices')
        .set('Authorization', bearer('u-op'))
        .send(cuerpo)
        .expect(400);
    }
    assert.deepEqual(inserts, []);
  } finally {
    await app.close();
  }
});

test('mismos guardas que la bandeja: sin sesión 401, el Civil 403', async () => {
  const { pool, inserts } = fakePool();
  const { app, bearer } = await buildApp(pool, emisor());
  try {
    await request(app.getHttpServer())
      .post('/api/notifications/devices')
      .send({ token: TOKEN_FCM, platform: 'android' })
      .expect(401);
    for (const ruta of ['/api/notifications/devices', '/api/notifications/devices/unregister', '/api/notifications/devices/prueba']) {
      await request(app.getHttpServer())
        .post(ruta)
        .set('Authorization', bearer('u-civil'))
        .send({ token: TOKEN_FCM, platform: 'android' })
        .expect(403);
    }
    assert.deepEqual(inserts, []);
  } finally {
    await app.close();
  }
});

test('baja: solo borra el token si es de quien la pide', async () => {
  const { pool, tabla } = fakePool({ 'tok-mio': 'u-op', 'tok-ajeno': 'u-otro' });
  const { app, bearer } = await buildApp(pool, null);
  try {
    const ajeno = await request(app.getHttpServer())
      .post('/api/notifications/devices/unregister')
      .set('Authorization', bearer('u-op'))
      .send({ token: 'tok-ajeno' })
      .expect(201);
    assert.deepEqual(ajeno.body, { quitado: false });
    assert.equal(tabla.get('tok-ajeno'), 'u-otro', 'el teléfono ajeno sigue registrado');

    const mio = await request(app.getHttpServer())
      .post('/api/notifications/devices/unregister')
      .set('Authorization', bearer('u-op'))
      .send({ token: 'tok-mio' })
      .expect(201);
    assert.deepEqual(mio.body, { quitado: true });
    assert.equal(tabla.has('tok-mio'), false);
  } finally {
    await app.close();
  }
});

test('prueba: va SOLO a los teléfonos de quien la pide, y un token muerto se borra', async () => {
  const { pool, tabla } = fakePool({ 'tok-1': 'u-op', 'tok-muerto': 'u-op', 'tok-ajeno': 'u-otro' });
  const sender = emisor(['tok-muerto']);
  const { app, bearer } = await buildApp(pool, sender);
  try {
    const res = await request(app.getHttpServer())
      .post('/api/notifications/devices/prueba')
      .set('Authorization', bearer('u-op'))
      .expect(201);
    assert.deepEqual(res.body, { pushActivo: true, telefonos: 2, enviados: 1, fallidos: 1 });
    assert.deepEqual(sender.envios.map((m) => m.token).sort(), ['tok-1', 'tok-muerto']);
    assert.ok(!sender.envios.some((m) => m.token === 'tok-ajeno'), 'nada al teléfono de otra persona');
    assert.equal(sender.envios[0].android?.notification?.channelId, 'aquora-avisos');
    assert.equal(sender.envios[0].android?.notification?.tag, 'prueba');
    assert.equal(sender.envios[0].data?.plantId, 'km18');
    assert.equal(tabla.has('tok-muerto'), false, 'el token que FCM ya no reconoce se borra');
  } finally {
    await app.close();
  }
});

test('prueba con el push apagado: lo dice, sin intentar nada', async () => {
  const { pool } = fakePool({ 'tok-1': 'u-op' });
  const { app, bearer } = await buildApp(pool, null);
  try {
    const res = await request(app.getHttpServer())
      .post('/api/notifications/devices/prueba')
      .set('Authorization', bearer('u-op'))
      .expect(201);
    assert.deepEqual(res.body, { pushActivo: false, telefonos: 0, enviados: 0, fallidos: 0 });
  } finally {
    await app.close();
  }
});
