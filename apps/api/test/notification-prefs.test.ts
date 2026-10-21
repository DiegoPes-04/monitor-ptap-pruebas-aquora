/**
 * Preferencias de notificación: qué SUENA fuera de la app.
 *
 * Solo hay dos modos y valen para todo: con sonido (bandeja + panel del sistema) o silenciado
 * (bandeja, sin sonar fuera). Lo que este test fija, y que costó llegar a ello:
 *
 *  1. **Silenciar NO esconde.** La bandeja y la campana siguen mostrándolo todo. Hubo un filtro en
 *     el servidor que hacía desaparecer lo silenciado del historial; se quitó porque el historial
 *     —el de las válvulas sobre todo— es evidencia, y algo que se puede ocultar sin querer deja de
 *     servir para reclamar nada.
 *  2. **Las maniobras de válvula no se pueden callar.** En estas plantas no hay confirmación
 *     eléctrica de que una válvula se moviera; el registro de quién dio la orden ES la evidencia.
 *  3. La configuración vive en la cuenta, no en el teléfono: sobrevive a cerrar sesión y a cambiar
 *     de dispositivo, que es lo que se pidió.
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Pool } from 'mysql2/promise';
import {
  claveDeItem,
  debeSonar,
  esSilenciable,
  NOTIFICATION_PREFS_DEFAULT,
  type NotificationPrefsDto,
  type Role,
} from '@ptap/shared';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../src/modules/auth/guards/permission.guard';
import { JwtService } from '../src/modules/auth/jwt.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { MYSQL_POOL } from '../src/infrastructure/database/database.tokens';
import { NotificationRepository } from '../src/modules/notifications/notification.repository';
import { NotificationPrefsRepository } from '../src/modules/notifications/notification-prefs.repository';
import { NotificationsController } from '../src/modules/notifications/notifications.controller';
import { DevicePushTokenRepository } from '../src/modules/notifications/device-push-token.repository';
import { PushDispatcher, PUSH_OPTIONS } from '../src/modules/notifications/push.dispatcher';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-notification-prefs';

const USUARIO = { id: 'u-jefe-voragine', role: 'jefe' as Role, plant: 'voragine' };

const AVISOS = [
  { id: 5, plant_id: 'voragine', kind: 'signal_out_of_range', severity: 'warning', subject: 'inletTurbidity' },
  { id: 4, plant_id: 'voragine', kind: 'valve_command', severity: 'info', subject: 'valve1' },
  { id: 3, plant_id: 'voragine', kind: 'sensor_stale', severity: 'warning', subject: null },
  { id: 2, plant_id: 'voragine', kind: 'tank_autonomy', severity: 'warning', subject: 'tank1Level' },
  { id: 1, plant_id: 'voragine', kind: 'tank_level', severity: 'critical', subject: 'tank1Level' },
];

function fakePool(prefs: Record<string, unknown> | null): { pool: Pool; guardadas: unknown[][] } {
  const guardadas: unknown[][] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (/FROM notification_prefs/i.test(sql)) return [prefs ? [prefs] : [], undefined];
      if (/INSERT INTO notification_prefs/i.test(sql)) {
        guardadas.push(params);
        return [{ affectedRows: 1 }, undefined];
      }
      const visibles = AVISOS.filter((a) => !sql.includes('n.plant_id = ?') || params.includes(a.plant_id));
      if (/^\s*SELECT COUNT/i.test(sql)) return [[{ n: visibles.length }], undefined];
      if (/^\s*INSERT IGNORE/i.test(sql)) return [{ affectedRows: visibles.length }, undefined];
      return [
        visibles.map((a) => ({
          ...a,
          title: `Aviso ${a.id}`,
          message: 'detalle',
          action: null,
          created_at: new Date('2026-08-21T12:00:00Z'),
          seen: 0,
        })),
        undefined,
      ];
    },
  } as unknown as Pool;
  return { pool, guardadas };
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
      {
        provide: UsersRepository,
        useValue: {
          findById: async (id: string) =>
            id === USUARIO.id
              ? {
                  ...USUARIO,
                  email: 'jefe@ptap.co',
                  name: 'Jefe',
                  passwordHash: 'x',
                  pepperVersion: 1,
                  isActive: true,
                }
              : null,
        } as unknown as UsersRepository,
      },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  const jwt = moduleRef.get(JwtService) as JwtService;
  const token = jwt.sign({
    sub: USUARIO.id,
    email: 'jefe@ptap.co',
    name: 'Jefe',
    role: USUARIO.role,
    plant: USUARIO.plant,
  });
  return { app, token };
}

const CON_SILENCIOS = {
  kinds_silenciados: JSON.stringify(['signal_out_of_range']),
  items_silenciados: JSON.stringify(['voragine:tank1Level']),
  min_severidad: 'warning',
  silencio_desde: '22:00:00',
  silencio_hasta: '06:00:00',
};

test('sin preferencias guardadas suena todo', async () => {
  const { pool } = fakePool(null);
  const { app, token } = await buildApp(pool);
  try {
    const res = await request(app.getHttpServer())
      .get('/api/notifications/preferences')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    assert.deepEqual(res.body, NOTIFICATION_PREFS_DEFAULT);
  } finally {
    await app.close();
  }
});

test('silenciar NO esconde: la bandeja y la campana siguen enseñándolo todo', async () => {
  const { pool } = fakePool(CON_SILENCIOS);
  const { app, token } = await buildApp(pool);
  try {
    const res = await request(app.getHttpServer())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    assert.equal(res.body.notifications.length, AVISOS.length, 'el historial no se recorta por preferencias');
    assert.equal(res.body.unseen, AVISOS.length);

    const campana = await request(app.getHttpServer())
      .get('/api/notifications/unseen-count')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    assert.equal(campana.body.unseen, res.body.unseen, 'campana y bandeja no pueden discrepar');
  } finally {
    await app.close();
  }
});

test('los ítems silenciados se guardan y se releen a nombre de quien pide', async () => {
  const { pool, guardadas } = fakePool(null);
  const { app, token } = await buildApp(pool);
  try {
    const res = await request(app.getHttpServer())
      .put('/api/notifications/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({
        mutedKinds: [],
        mutedItems: ['voragine:tank1Level', 'voragine:inletTurbidity'],
        minSeverity: 'info',
        quietFrom: null,
        quietTo: null,
      })
      .expect(200);
    assert.deepEqual(res.body.mutedItems, ['voragine:tank1Level', 'voragine:inletTurbidity']);
    assert.equal(guardadas.length, 1);
    // El userId sale del token, jamás del cuerpo: nadie puede callarle los avisos a otra persona.
    assert.equal(guardadas[0][0], USUARIO.id);
  } finally {
    await app.close();
  }
});

test('media franja de silencio se rechaza en vez de guardarse a medias', async () => {
  const { pool } = fakePool(null);
  const { app, token } = await buildApp(pool);
  try {
    await request(app.getHttpServer())
      .put('/api/notifications/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ mutedKinds: [], mutedItems: [], minSeverity: 'info', quietFrom: '22:00', quietTo: null })
      .expect(400);
  } finally {
    await app.close();
  }
});

test('las maniobras de válvula no se pueden callar', () => {
  assert.equal(esSilenciable('valve_command'), false);
  assert.equal(esSilenciable('valve_manual'), false);
  assert.equal(esSilenciable('sensor_stale'), true);

  // Ni con todo silenciado, ni de madrugada, ni pidiendo solo críticos.
  const todoCallado: NotificationPrefsDto = {
    mutedKinds: ['valve_command', 'valve_manual', 'sensor_stale'],
    mutedItems: ['voragine:valve1'],
    minSeverity: 'critical',
    quietFrom: '00:00',
    quietTo: '23:59',
  };
  const maniobra = { kind: 'valve_command', severity: 'info' as const, plantId: 'voragine', subject: 'valve1' };
  assert.equal(debeSonar(maniobra, todoCallado, new Date('2026-08-21T03:00:00')), true);
});

test('debeSonar: tipo silenciado, ítem silenciado y gravedad mínima', () => {
  const prefs: NotificationPrefsDto = {
    mutedKinds: ['signal_out_of_range'],
    mutedItems: [claveDeItem('voragine', 'tank1Level')],
    minSeverity: 'warning',
    quietFrom: null,
    quietTo: null,
  };
  const mediodia = new Date('2026-08-21T12:00:00');

  assert.equal(
    debeSonar({ kind: 'signal_out_of_range', severity: 'critical', plantId: 'voragine', subject: 'x' }, prefs, mediodia),
    false,
    'un tipo callado no suena ni siendo crítico: el silencio explícito se respeta',
  );
  assert.equal(
    debeSonar({ kind: 'tank_level', severity: 'critical', plantId: 'voragine', subject: 'tank1Level' }, prefs, mediodia),
    false,
    'el ítem callado tampoco',
  );
  assert.equal(
    debeSonar({ kind: 'tank_level', severity: 'critical', plantId: 'sirena', subject: 'tank1Level' }, prefs, mediodia),
    true,
    'el silencio es por planta Y señal: el mismo nombre en otra planta sigue sonando',
  );
  assert.equal(
    debeSonar({ kind: 'sensor_stale', severity: 'info', plantId: 'voragine', subject: null }, prefs, mediodia),
    false,
    'por debajo de la gravedad mínima no suena',
  );
  assert.equal(
    debeSonar({ kind: 'sensor_stale', severity: 'warning', plantId: 'voragine', subject: null }, prefs, mediodia),
    true,
  );
});

test('el horario de silencio calla el dispositivo, y lo crítico lo atraviesa', () => {
  const nocturno: NotificationPrefsDto = { ...NOTIFICATION_PREFS_DEFAULT, quietFrom: '22:00', quietTo: '06:00' };
  const madrugada = new Date('2026-08-21T03:00:00');
  const aviso = (severity: 'critical' | 'warning') => ({
    kind: 'tank_level',
    severity,
    plantId: 'voragine',
    subject: 'tank1Level',
  });

  assert.equal(debeSonar(aviso('warning'), nocturno, madrugada), false);
  assert.equal(debeSonar(aviso('critical'), nocturno, madrugada), true, 'un tanque rebosando suena a las 3 a. m.');
  assert.equal(debeSonar(aviso('warning'), nocturno, new Date('2026-08-21T15:00:00')), true);
  // Los bordes: a las 22:00 ya calla, a las 06:00 ya no.
  assert.equal(debeSonar(aviso('warning'), nocturno, new Date('2026-08-21T22:00:00')), false);
  assert.equal(debeSonar(aviso('warning'), nocturno, new Date('2026-08-21T06:00:00')), true);
  assert.equal(debeSonar(aviso('warning'), NOTIFICATION_PREFS_DEFAULT, madrugada), true, 'sin franja, suena siempre');

  // Franja que NO cruza la medianoche, que es la otra rama del cálculo.
  const siesta: NotificationPrefsDto = { ...NOTIFICATION_PREFS_DEFAULT, quietFrom: '13:00', quietTo: '15:00' };
  assert.equal(debeSonar(aviso('warning'), siesta, new Date('2026-08-21T14:00:00')), false);
  assert.equal(debeSonar(aviso('warning'), siesta, new Date('2026-08-21T16:00:00')), true);
});
