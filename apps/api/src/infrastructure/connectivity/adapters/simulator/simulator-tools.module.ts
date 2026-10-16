import { Module, type Type } from '@nestjs/common';
import { AuthModule } from '../../../../modules/auth/auth.module';
import { ConnectivityModule } from '../../connectivity.module';
import { SimulatorController } from './simulator.controller';

/**
 * Endpoints de diagnóstico del simulador (`/api/opc/sim`). Requiere BD (AuthModule, para los guards),
 * así que solo lo monta el arranque completo (AppModule), y SOLO con el simulador activo.
 */
@Module({
  imports: [ConnectivityModule, AuthModule],
  controllers: [SimulatorController],
})
export class SimulatorToolsModule {
  /**
   * `[SimulatorToolsModule]` con `CONNECTIVITY_PROVIDER=simulator`; `[]` con el PLC real. Se evalúa al
   * cargar AppModule, después de `config/load-env` (main.ts lo importa antes). El default es `opcua`,
   * el mismo de connectivity.config.ts: sin la variable, NO hay endpoints de simulador.
   */
  static siElSimuladorEstaActivo(): Type<SimulatorToolsModule>[] {
    const provider = (process.env.CONNECTIVITY_PROVIDER ?? '').trim().toLowerCase() || 'opcua';
    return provider === 'simulator' ? [SimulatorToolsModule] : [];
  }
}
