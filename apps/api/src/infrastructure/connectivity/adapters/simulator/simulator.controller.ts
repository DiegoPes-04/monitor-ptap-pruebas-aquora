import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../../../../modules/auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../../../modules/auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../../../modules/auth/guards/permission.guard';
import { plantIdParamSchema } from '../../../validation/plant-id.schema';
import { ZodValidationPipe } from '../../../validation/zod-validation.pipe';
import { CONNECTIVITY_ADAPTER } from '../../connectivity.tokens';
import type { ConnectivityAdapter } from '../../ports/connectivity-adapter.port';
import { SimulatorBridgeAdapter } from './simulator-bridge.adapter';
import type { SimValveView } from './simulated-plc';

const valveKeySchema = z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_.]*$/);
const errorBodySchema = z.object({ reason: z.string().min(1).max(200).optional() }).strict();
const modeBodySchema = z.object({ latchMode: z.enum(['hold', 'latch']) }).strict();
const limitSchema = z.coerce.number().int().min(1).max(5_000).optional();

/**
 * Diagnóstico del SIMULADOR de válvulas: qué ve el PLC simulado, qué se escribió, qué violó la
 * exclusión abrir/cerrar, y tres perillas para probar cómo lo vive la app (forzar ERROR, rearmar,
 * cambiar hold/latch).
 *
 * Solo existe con `CONNECTIVITY_PROVIDER=simulator`: el módulo no se registra con el PLC real (ver
 * SimulatorToolsModule) y, por si alguien lo registrara, cada ruta comprueba que el adaptador vivo es
 * el simulador y si no responde 404. Mismo blindaje que el resto de `/api/opc/*`: JWT + `system_config`
 * (solo admin), y la auditoría de accesos la aplica AuditMiddleware por el prefijo `/api/opc`.
 */
@Controller('opc/sim')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SimulatorController {
  constructor(@Inject(CONNECTIVITY_ADAPTER) private readonly adapter: ConnectivityAdapter) {}

  private sim(): SimulatorBridgeAdapter {
    if (!(this.adapter instanceof SimulatorBridgeAdapter)) {
      throw new NotFoundException('El diagnóstico del simulador solo existe con CONNECTIVITY_PROVIDER=simulator');
    }
    return this.adapter;
  }

  private encontrada(v: SimValveView | null, plantId: string, valveKey: string): SimValveView {
    if (!v) throw new NotFoundException(`el simulador no tiene la válvula ${plantId}/${valveKey}`);
    return v;
  }

  /** Escenario, ciclos MSG por planta y estado de cada válvula simulada. */
  @Get()
  @RequirePermission('system_config')
  report() {
    return this.sim().getSimulationReport();
  }

  /** Escrituras del backend sobre el maestro, más recientes al final. */
  @Get('writes')
  @RequirePermission('system_config')
  writes(@Query('limit', new ZodValidationPipe(limitSchema)) limit?: number) {
    const todas = this.sim().getWriteHistory();
    return { total: todas.length, writes: limit ? todas.slice(-limit) : todas };
  }

  /** Escrituras que dejaron abrir y cerrar a 1 a la vez. En un sistema sano: vacío. */
  @Get('violations')
  @RequirePermission('system_config')
  violations() {
    const violations = this.sim().getViolations();
    return { total: violations.length, violations };
  }

  @Get('valves/:plantId/:valveKey')
  @RequirePermission('system_config')
  valve(
    @Param('plantId', new ZodValidationPipe(plantIdParamSchema)) plantId: string,
    @Param('valveKey', new ZodValidationPipe(valveKeySchema)) valveKey: string,
  ) {
    return this.encontrada(this.sim().getSimulatedValve(plantId, valveKey), plantId, valveKey);
  }

  /** Mete la válvula en ERROR, como lo declararía el PLC. Se queda así hasta `reset`. */
  @Post('valves/:plantId/:valveKey/error')
  @RequirePermission('system_config')
  forceError(
    @Param('plantId', new ZodValidationPipe(plantIdParamSchema)) plantId: string,
    @Param('valveKey', new ZodValidationPipe(valveKeySchema)) valveKey: string,
    @Body(new ZodValidationPipe(errorBodySchema)) body: z.infer<typeof errorBodySchema>,
  ) {
    return this.encontrada(this.sim().forceValveError(plantId, valveKey, body.reason), plantId, valveKey);
  }

  @Post('valves/:plantId/:valveKey/reset')
  @RequirePermission('system_config')
  reset(
    @Param('plantId', new ZodValidationPipe(plantIdParamSchema)) plantId: string,
    @Param('valveKey', new ZodValidationPipe(valveKeySchema)) valveKey: string,
  ) {
    return this.encontrada(this.sim().resetValve(plantId, valveKey), plantId, valveKey);
  }

  /** `hold` (se mueve solo con el bit sostenido) o `latch` (basta el flanco): la duda abierta con el integrador. */
  @Post('valves/:plantId/:valveKey/mode')
  @RequirePermission('system_config')
  mode(
    @Param('plantId', new ZodValidationPipe(plantIdParamSchema)) plantId: string,
    @Param('valveKey', new ZodValidationPipe(valveKeySchema)) valveKey: string,
    @Body(new ZodValidationPipe(modeBodySchema)) body: z.infer<typeof modeBodySchema>,
  ) {
    return this.encontrada(this.sim().setValveLatchMode(plantId, valveKey, body.latchMode), plantId, valveKey);
  }
}
