import { Logger, Module } from '@nestjs/common';
import { ConnectivityGateway } from './connectivity.gateway';
import { CONNECTIVITY_ADAPTER, CONNECTIVITY_CONFIG } from './connectivity.tokens';
import { loadConnectivityConfig, type ConnectivityConfig } from './connectivity.config';
import { loadMapping, resolverRutaDelMapping } from './mapping/opc-mapping.loader';
import { SimulatorBridgeAdapter } from './adapters/simulator/simulator-bridge.adapter';
import { asegurarMappingParaPlcReal, opcionesDelEntorno } from './adapters/simulator/sim-scenario';
import { OpcUaConnectivityAdapter } from './adapters/opcua/opcua-connectivity.adapter';
import { BridgeOrchestratorService } from './bridge-orchestrator.service';
import { PlantCache } from './pipeline/plant-cache';
import { TankAutonomyStore } from './pipeline/tank-autonomy.store';
import { PlantPipelineService } from './pipeline/plant-pipeline.service';
import type { ConnectivityAdapter } from './ports/connectivity-adapter.port';

/**
 * Puente crudo + pipeline de dominio (Fases 1-3). DELIBERADAMENTE sin dependencia de
 * MySQL/Auth: lo importa tanto main.ts (app completa) como main.telemetry.ts (arranque
 * de demo sin BD). Observabilidad Fase 4 (OpcController, guards, audit, métricas,
 * logging) vive en OpcObservabilityModule — que SÍ requiere BD (auth) — para que
 * importar este módulo nunca obligue a tener MySQL arriba.
 *
 * Un solo camino de datos: PLC → adapter → pipeline → PlantCache → REST/Socket.IO.
 */
@Module({
  controllers: [],
  providers: [
    // ── Puente crudo ──────────────────────────────────────────────────────────
    { provide: CONNECTIVITY_CONFIG, useFactory: (): ConnectivityConfig => loadConnectivityConfig() },
    {
      provide: CONNECTIVITY_ADAPTER,
      inject: [CONNECTIVITY_CONFIG],
      useFactory: (config: ConnectivityConfig): ConnectivityAdapter => {
        const mapping = loadMapping();
        const logger = new Logger('ConnectivityModule');
        logger.log(
          `Puente OPC UA: provider=${config.provider}, ${mapping.plants.length} plantas, ${mapping.targets.length} buffers de datos`,
        );
        if (config.provider === 'opcua') {
          // Un mapping de PRUEBA del simulador (generatedFrom.simulationOnly) jamás llega al PLC real:
          // sus bits son ensayos, y escribirlos movería equipo que nadie asignó. El backend no arranca.
          asegurarMappingParaPlcReal(mapping);
          return new OpcUaConnectivityAdapter(config.opcua, mapping);
        }
        // Simulador: el escenario de SIM_SCENARIO (o los supuestos por defecto). Uno incoherente con el
        // mapping cargado hace fallar el arranque aquí, con el motivo, en vez de simular otra cosa.
        const opciones = opcionesDelEntorno(mapping, resolverRutaDelMapping());
        logger.log(
          `Simulador: escenario "${opciones.name}"${opciones.source ? ` (${opciones.source})` : ''}, ` +
            `MSG ${opciones.defaults.msgCycleMs} ms, latencia I/O ${opciones.ioLatencyMs} ms`,
        );
        return new SimulatorBridgeAdapter(config.opcua, mapping, opciones);
      },
    },
    BridgeOrchestratorService,

    // ── Pipeline de dominio en RAM (parser → liveness → mapping → quality → DTO) ──
    PlantCache,
    TankAutonomyStore,
    PlantPipelineService,
    ConnectivityGateway,
  ],
  exports: [CONNECTIVITY_ADAPTER, CONNECTIVITY_CONFIG, PlantCache, PlantPipelineService, TankAutonomyStore],
})
export class ConnectivityModule {}
