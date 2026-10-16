/**
 * `/api/opc/sim` — el diagnóstico del simulador de válvulas, con los guards REALES (supertest):
 *  - sin JWT → 401; operador (sin system_config) → 403; admin → 200, como el resto de /api/opc/*;
 *  - forzar ERROR, rearmar y cambiar hold/latch se ven en el estado de la válvula;
 *  - con un adaptador que NO es el simulador, 404: estas rutas no existen contra el PLC real.
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { INestApplication, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Role } from '@ptap/shared';
import { CONNECTIVITY_ADAPTER } from '../src/infrastructure/connectivity/connectivity.tokens';
import type { OpcUaConfig } from '../src/infrastructure/connectivity/connectivity.config';
import { loadMapping } from '../src/infrastructure/connectivity/mapping/opc-mapping.loader';
import { SimulatorBridgeAdapter } from '../src/infrastructure/connectivity/adapters/simulator/simulator-bridge.adapter';
import { SimulatorController } from '../src/infrastructure/connectivity/adapters/simulator/simulator.controller';
import { opcionesPorDefecto } from '../src/infrastructure/connectivity/adapters/simulator/sim-scenario';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../src/modules/auth/guards/permission.guard';
import { JwtService } from '../src/modules/auth/jwt.service';
import { UsersRepository, type UserRecord } from '../src/modules/users/users.repository';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-sim-controller';
Logger.overrideLogger(false);

const RUTA_PRUEBA = join(__dirname, '..', 'fixtures', 'sim-scenarios', 'mappings', 'valvulas-de-prueba.json');

const usuarios = {
  findById: async (id: string): Promise<UserRecord | null> => {
    const role = id.replace(/^u-/, '');
    return { id, email: `${role}@ptap.co`, name: role, role, plant: 'sim-una', passwordHash: 'x', pepperVersion: 1, isActive: true } as UserRecord;
  },
} as unknown as UsersRepository;

function opcua(): OpcUaConfig {
  return {
    securityMode: 'SignAndEncrypt',
    identity: { type: 'username', userName: 'simulador', password: 'simulador' },
    publishingIntervalMs: 60_000,
    samplingIntervalMs: 60_000,
    coalesceWindowMs: 10,
    watchdogTimeoutMs: 600_000,
    heartbeatIntervalMs: 600_000,
    heartbeatMaxFailures: 2,
    subscriptionRecycleMaxAttempts: 2,
  } as unknown as OpcUaConfig;
}

async function app(adapter: unknown): Promise<{ app: INestApplication; jwt: JwtService }> {
  @Module({
    controllers: [SimulatorController],
    providers: [
      JwtAuthGuard,
      PermissionGuard,
      JwtService,
      { provide: UsersRepository, useValue: usuarios },
      { provide: CONNECTIVITY_ADAPTER, useValue: adapter },
    ],
  })
  class SimControllerTestModule {}
  const ref = await Test.createTestingModule({ imports: [SimControllerTestModule] }).compile();
  const a = ref.createNestApplication();
  a.setGlobalPrefix('api');
  await a.init();
  return { app: a, jwt: ref.get(JwtService) };
}

function token(jwt: JwtService, role: Role): string {
  return jwt.sign({ sub: `u-${role}`, email: `${role}@ptap.co`, name: role, role, plant: 'sim-una' });
}

test('sim-controller: sin JWT 401, operador 403, admin 200 — mismo blindaje que /api/opc/*', async () => {
  const sim = new SimulatorBridgeAdapter(opcua(), loadMapping(RUTA_PRUEBA), { ...opcionesPorDefecto(), name: 'controller' });
  const { app: a, jwt } = await app(sim);
  try {
    await request(a.getHttpServer()).get('/api/opc/sim').expect(401);
    await request(a.getHttpServer()).get('/api/opc/sim').set('Authorization', `Bearer ${token(jwt, 'operador')}`).expect(403);
    await request(a.getHttpServer())
      .post('/api/opc/sim/valves/sim-una/valve1/error')
      .set('Authorization', `Bearer ${token(jwt, 'operador')}`)
      .send({})
      .expect(403);
    const r = await request(a.getHttpServer()).get('/api/opc/sim').set('Authorization', `Bearer ${token(jwt, 'admin')}`).expect(200);
    assert.equal(r.body.scenario.name, 'controller');
    assert.equal(r.body.valves.length, 9);
  } finally {
    await a.close();
  }
});

test('sim-controller: forzar ERROR, rearmar y cambiar el modo se reflejan en la válvula; validación de entrada', async () => {
  const sim = new SimulatorBridgeAdapter(opcua(), loadMapping(RUTA_PRUEBA), { ...opcionesPorDefecto(), name: 'controller' });
  const { app: a, jwt } = await app(sim);
  const admin = `Bearer ${token(jwt, 'admin')}`;
  try {
    const err = await request(a.getHttpServer())
      .post('/api/opc/sim/valves/sim-tres/valve2/error')
      .set('Authorization', admin)
      .send({ reason: 'probar el aviso de la app' })
      .expect(201);
    assert.equal(err.body.state, 'error');
    assert.equal(err.body.error.reason, 'probar el aviso de la app');

    const vista = await request(a.getHttpServer()).get('/api/opc/sim/valves/sim-tres/valve2').set('Authorization', admin).expect(200);
    assert.equal(vista.body.state, 'error');

    const rearme = await request(a.getHttpServer()).post('/api/opc/sim/valves/sim-tres/valve2/reset').set('Authorization', admin).expect(201);
    assert.equal(rearme.body.state, 'closed');

    const modo = await request(a.getHttpServer())
      .post('/api/opc/sim/valves/sim-tres/valve2/mode')
      .set('Authorization', admin)
      .send({ latchMode: 'latch' })
      .expect(201);
    assert.equal(modo.body.latchMode, 'latch');

    await request(a.getHttpServer()).post('/api/opc/sim/valves/sim-tres/valve2/mode').set('Authorization', admin).send({ latchMode: 'pulso' }).expect(400);
    await request(a.getHttpServer()).post('/api/opc/sim/valves/sim-tres/valve9/reset').set('Authorization', admin).expect(404);
    await request(a.getHttpServer()).get('/api/opc/sim/valves/SIM_MAL/valve1').set('Authorization', admin).expect(400);

    const writes = await request(a.getHttpServer()).get('/api/opc/sim/writes?limit=5').set('Authorization', admin).expect(200);
    assert.deepEqual(writes.body, { total: 0, writes: [] });
    const violations = await request(a.getHttpServer()).get('/api/opc/sim/violations').set('Authorization', admin).expect(200);
    assert.deepEqual(violations.body, { total: 0, violations: [] });
  } finally {
    await a.close();
  }
});

test('sim-controller: con un adaptador que NO es el simulador, las rutas responden 404', async () => {
  const noSimulador = { provider: 'opcua' };
  const { app: a, jwt } = await app(noSimulador);
  try {
    await request(a.getHttpServer()).get('/api/opc/sim').set('Authorization', `Bearer ${token(jwt, 'admin')}`).expect(404);
    await request(a.getHttpServer())
      .post('/api/opc/sim/valves/sim-una/valve1/error')
      .set('Authorization', `Bearer ${token(jwt, 'admin')}`)
      .send({})
      .expect(404);
  } finally {
    await a.close();
  }
});
