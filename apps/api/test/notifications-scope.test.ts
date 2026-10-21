/**
 * Ámbito por planta de la bandeja de notificaciones.
 *
 * El fallo que fija este test: `listRecent`/`countUnseen`/`markAllSeen` filtraban SOLO por
 * tiempo, así que cualquier cuenta con `view_dashboard` recibía los avisos de las doce plantas.
 * No era un detalle cosmético: `notification-sync` levanta una notificación en el celular por
 * cada aviso no visto, de modo que al operario de Km 18 le sonaba el teléfono por un sensor de
 * Cascajal.
 *
 * Aquí no sirve `PlantScopeGuard`: estas rutas no llevan `:plantId` y el guard es un no-op en
 * ellas. Por eso se prueban las DOS capas — que el controlador calcula el ámbito correcto, y que
 * ese ámbito llega al SQL en vez de resolverse en el cliente.
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Role } from '@ptap/shared';
import type { Pool } from 'mysql2/promise';
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

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-notifications-scope';

/** Quién es quién: el id codifica rol y planta para que `findById` los reconstruya. */
const CUENTAS: Record<string, { role: Role; plant: string }> = {
  'u-operador-km18': { role: 'operador', plant: 'km18' },
  'u-jefe-km18': { role: 'jefe', plant: 'km18' },
  'u-operador-cascajal': { role: 'operador', plant: 'cascajal' },
  'u-admin': { role: 'admin', plant: 'voragine' },
  'u-civil': { role: 'civil', plant: 'km18' },
};

/** Avisos de tres plantas distintas, para que un filtro ausente se note. */
const AVISOS = [
  { id: 3, plant_id: 'km18', kind: 'sensor_stale', severity: 'warning' },
  { id: 2, plant_id: 'cascajal', kind: 'sensor_stale', severity: 'critical' },
  { id: 1, plant_id: 'sirena', kind: 'signal_out_of_range', severity: 'warning' },
];

interface Consulta {
  sql: string;
  params: unknown[];
}

/**
 * Pool falso que registra cada consulta y responde imitando a MySQL: aplica el filtro de planta
 * a partir de los PARÁMETROS, de forma que si el SQL no lo lleva, no se filtra nada — que es
 * exactamente el fallo que se quiere detectar.
 */
function fakePool(): { pool: Pool; consultas: Consulta[] } {
  const consultas: Consulta[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      // Sin fila de preferencias: todo llega, que es el comportamiento por defecto.
      if (/notification_prefs/i.test(sql)) return [[], undefined];
      const planta = typeof params[2] === 'string' ? (params[2] as string) : null;
      const visibles = planta === null ? AVISOS : AVISOS.filter((a) => a.plant_id === planta);

      if (/^\s*SELECT COUNT/i.test(sql)) return [[{ n: visibles.length }], undefined];
      if (/^\s*INSERT IGNORE/i.test(sql)) return [{ affectedRows: visibles.length }, undefined];
      return [
        visibles.map((a) => ({
          ...a,
          subject: null,
          title: `Aviso ${a.id}`,
          message: 'detalle',
          created_at: new Date('2026-08-13T12:00:00Z'),
          seen: 0,
        })),
        undefined,
      ];
    },
  } as unknown as Pool;
  return { pool, consultas };
}

function fakeUsersRepo(): UsersRepository {
  return {
    findById: async (id: string) => {
      const cuenta = CUENTAS[id];
      if (!cuenta) return null;
      return {
        id,
        email: `${id}@ptap.co`,
        name: id,
        role: cuenta.role,
        plant: cuenta.plant,
        passwordHash: 'x',
        pepperVersion: 1,
        isActive: true,
      };
    },
  } as unknown as UsersRepository;
}

async function buildApp(pool: Pool) {
  @Module({
    controllers: [NotificationsController],
    providers: [
      NotificationRepository,
      NotificationPrefsRepository,
      // El controlador también registra teléfonos para el push; aquí apagado, sin leer el entorno.
      DevicePushTokenRepository,
      PushDispatcher,
      { provide: PUSH_OPTIONS, useValue: { sender: null } },
      JwtAuthGuard,
      PermissionGuard,
      JwtService,
      { provide: MYSQL_POOL, useValue: pool },
      { provide: UsersRepository, useValue: fakeUsersRepo() },
    ],
  })
  class NotificationsTestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [NotificationsTestModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  return { app, jwt: moduleRef.get(JwtService) as JwtService };
}

function tokenFor(jwt: JwtService, sub: string): string {
  const { role, plant } = CUENTAS[sub];
  return jwt.sign({ sub, email: `${sub}@ptap.co`, name: sub, role, plant });
}

test('notificaciones: el operador solo recibe los avisos de SU planta', async () => {
  const { pool, consultas } = fakePool();
  const { app, jwt } = await buildApp(pool);
  try {
    const res = await request(app.getHttpServer())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tokenFor(jwt, 'u-operador-km18')}`)
      .expect(200);

    const plantas = [...new Set(res.body.notifications.map((n: { plantId: string }) => n.plantId))];
    assert.deepEqual(plantas, ['km18'], 'no debe colarse ningún aviso de otra planta');

    // La campana tiene que contar lo MISMO que muestra la bandeja: si contara de más, el usuario
    // nunca podría dejarla en cero.
    assert.equal(res.body.unseen, res.body.notifications.length);

    // Y el ámbito debe viajar en el SQL, no aplicarse después en el cliente. Se miran solo las
    // consultas de la bandeja: la de preferencias va por usuario y no tiene planta que acotar.
    const bandeja = consultas.filter((c) => /notification n|INTO notification_seen/i.test(c.sql));
    assert.ok(bandeja.length > 0);
    assert.ok(
      bandeja.every((c) => c.sql.includes('n.plant_id = ?')),
      'todas las consultas de la bandeja deben acotar por planta en SQL',
    );
    assert.ok(bandeja.every((c) => c.params.includes('km18')));
  } finally {
    await app.close();
  }
});

test('notificaciones: el jefe de planta tampoco ve las ajenas', async () => {
  const { pool } = fakePool();
  const { app, jwt } = await buildApp(pool);
  try {
    const res = await request(app.getHttpServer())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tokenFor(jwt, 'u-jefe-km18')}`)
      .expect(200);
    assert.deepEqual(
      [...new Set(res.body.notifications.map((n: { plantId: string }) => n.plantId))],
      ['km18'],
    );
  } finally {
    await app.close();
  }
});

test('notificaciones: dos plantas distintas no comparten bandeja', async () => {
  const { pool } = fakePool();
  const { app, jwt } = await buildApp(pool);
  try {
    const km18 = await request(app.getHttpServer())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tokenFor(jwt, 'u-operador-km18')}`)
      .expect(200);
    const cascajal = await request(app.getHttpServer())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tokenFor(jwt, 'u-operador-cascajal')}`)
      .expect(200);

    const ids = (b: { notifications: { id: number }[] }) => b.notifications.map((n) => n.id);
    assert.deepEqual(ids(km18.body), [3]);
    assert.deepEqual(ids(cascajal.body), [2]);
  } finally {
    await app.close();
  }
});

test('notificaciones: el admin (view_all_plants) sigue viéndolas todas', async () => {
  const { pool, consultas } = fakePool();
  const { app, jwt } = await buildApp(pool);
  try {
    const res = await request(app.getHttpServer())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tokenFor(jwt, 'u-admin')}`)
      .expect(200);

    assert.equal(res.body.notifications.length, AVISOS.length);
    assert.ok(
      consultas.every((c) => !c.sql.includes('n.plant_id = ?')),
      'sin ámbito no debe añadirse el filtro',
    );
  } finally {
    await app.close();
  }
});

test('notificaciones: el contador de la campana va acotado igual que la bandeja', async () => {
  const { pool } = fakePool();
  const { app, jwt } = await buildApp(pool);
  try {
    const operario = await request(app.getHttpServer())
      .get('/api/notifications/unseen-count')
      .set('Authorization', `Bearer ${tokenFor(jwt, 'u-operador-km18')}`)
      .expect(200);
    assert.equal(operario.body.unseen, 1, 'solo el aviso de km18');

    const admin = await request(app.getHttpServer())
      .get('/api/notifications/unseen-count')
      .set('Authorization', `Bearer ${tokenFor(jwt, 'u-admin')}`)
      .expect(200);
    assert.equal(admin.body.unseen, AVISOS.length);
  } finally {
    await app.close();
  }
});

test('notificaciones: marcar como visto no toca los avisos de otras plantas', async () => {
  const { pool, consultas } = fakePool();
  const { app, jwt } = await buildApp(pool);
  try {
    const res = await request(app.getHttpServer())
      .post('/api/notifications/seen')
      .set('Authorization', `Bearer ${tokenFor(jwt, 'u-operador-km18')}`)
      .expect(201);

    assert.equal(res.body.marked, 1, 'solo debe marcar el aviso de su planta');
    const insert = consultas.find((c) => /INSERT IGNORE/i.test(c.sql));
    assert.ok(insert, 'debe haber ejecutado el INSERT de marcado');
    assert.ok(insert.sql.includes('n.plant_id = ?'), 'el marcado también va acotado por planta');
  } finally {
    await app.close();
  }
});

test('notificaciones: el Civil no tiene bandeja (view_dashboard) → 403', async () => {
  const { pool } = fakePool();
  const { app, jwt } = await buildApp(pool);
  try {
    // Sigue siendo cosa del permiso, no del ámbito: el Civil no recibe avisos de proceso.
    await request(app.getHttpServer())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tokenFor(jwt, 'u-civil')}`)
      .expect(403);
  } finally {
    await app.close();
  }
});
