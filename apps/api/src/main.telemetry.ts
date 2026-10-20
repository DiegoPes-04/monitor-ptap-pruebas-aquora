import 'reflect-metadata';
import './config/load-env';
import { Controller, Get, Inject, Module, NotFoundException, Param } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConnectivityModule } from './infrastructure/connectivity/connectivity.module';
import { PlantCache } from './infrastructure/connectivity/pipeline/plant-cache';
import { PlantPipelineService } from './infrastructure/connectivity/pipeline/plant-pipeline.service';
import { LoggingModule } from './infrastructure/logging/logging.module';
import { JsonLogger } from './infrastructure/logging/json-logger.service';

// Demo sin login ni BD: el gateway Socket.IO NO exige JWT en el handshake (en el servidor completo
// sí — SRV-04). Se fija al arranque del proceso, antes de bootstrap(); el gateway lo lee en cada
// conexión. (El gateway solo se instancia dentro de bootstrap → esto corre antes, a tiempo.)
process.env.SOCKET_AUTH_REQUIRED = 'false';

/**
 * Controlador SIN guards a propósito: main.telemetry.ts es el arranque de demo sin BD
 * (ver comentario del módulo abajo) y no debe requerir AuthModule/MySQL. Duplica los dos
 * métodos de PlantsController (que en el arranque completo SÍ lleva JwtAuthGuard) en vez
 * de reutilizar esa clase directamente, para no arrastrar su dependencia de AuthModule aquí.
 */
@Controller('plants')
class TelemetryPlantsController {
  constructor(
    @Inject(PlantPipelineService) private readonly pipeline: PlantPipelineService,
    @Inject(PlantCache) private readonly cache: PlantCache,
  ) {}

  @Get()
  list() {
    return { plants: this.pipeline.listPlants() };
  }

  @Get(':plantId/snapshot')
  snapshot(@Param('plantId') plantId: string) {
    const snapshot = this.cache.get(plantId);
    if (snapshot) return snapshot;

    const known = this.pipeline.listPlants().find((p) => p.plantId === plantId);
    if (!known) throw new NotFoundException(`planta desconocida: ${plantId}`);
    return {
      plantId: known.plantId,
      displayName: known.displayName,
      sequence: 0,
      bridgeStatus: known.bridgeStatus,
      liveness: known.liveness,
      signals: {},
      pending: true,
      ...(known.integrationPending ? { integrationPending: true as const } : {}),
    };
  }
}

/**
 * Entrypoint de TELEMETRÍA: levanta solo el puente OPC UA + pipeline de dominio + REST
 * (/api/plants, /api/plants/:id/snapshot, /api/opc/*) + Socket.IO, SIN la base de datos.
 * Sirve todo lo que el frontend necesita para el caudal en tiempo real sin requerir MySQL
 * (que solo hace falta para auth/usuarios/auditoría — main.ts es el arranque completo).
 *
 * Ejecutar: npm run start:telemetry  (CONNECTIVITY_PROVIDER=opcua para PLC real)
 */
@Module({ imports: [ConnectivityModule, LoggingModule], controllers: [TelemetryPlantsController] })
class TelemetryModule {}

async function bootstrap() {
  const app = await NestFactory.create(TelemetryModule);
  app.useLogger(app.get(JsonLogger));
  app.enableCors({ origin: '*' }); // el front (Expo web) vive en otro origen
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 4000);
}

void bootstrap();
