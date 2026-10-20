import type { BridgeStatus } from '../ports/connectivity-adapter.port';
import type { ExtractedSignal } from './mapping.engine';
import type { LivenessDto, PlantSnapshotDto, SignalDto } from './plant-snapshot.dto';
import { evaluateQuality } from './quality.evaluator';
import type { DeadLetterBuffer } from './dead-letter.buffer';

export interface SnapshotInput {
  plantId: string;
  displayName: string;
  protocolVersion: string;
  dtoVersion: string;
  sequence: number;
  bridgeStatus: BridgeStatus;
  liveness: LivenessDto;
  extracted: ExtractedSignal[];
  deadLetter: DeadLetterBuffer;
  /** La planta no tiene ningún buffer en el mapping (ver `PlantSnapshotDto.integrationPending`). */
  integrationPending?: boolean;
}

/**
 * Snapshot Builder (PASO 3.6): ensambla el DTO por planta aplicando QualityService a cada
 * señal. NUNCA asciende un `inferred` a `confirmed` (el confidence viene tal cual del
 * mapping). Los valores no-finitos se serializan como null (JSON-safe) y quedan usable:false.
 */
export function buildSnapshot(input: SnapshotInput): PlantSnapshotDto {
  const signals: Record<string, SignalDto> = {};

  for (const ex of input.extracted) {
    const verdict = evaluateQuality({
      value: ex.value,
      quality: ex.quality,
      min: ex.min,
      max: ex.max,
      livenessState: input.liveness.state,
    });

    // Dead-letter de anomalías de VALOR (las estructurales ya se registraron en el engine).
    if (!ex.structurallyBroken && verdict.reason === 'INVALID_NUMBER') {
      input.deadLetter.record('INVALID_NUMBER', input.plantId, ex.domainKey, `valor no finito: ${String(ex.value)}`);
    }

    const finite = typeof ex.value === 'number' ? Number.isFinite(ex.value) : true;
    const dto: SignalDto = {
      value: finite ? ex.value : null, // JSON-safe: NaN/Infinity → null
      unit: ex.unit,
      quality: ex.quality,
      usable: verdict.usable,
      mappingStatus: ex.mappingStatus,
      confidence: ex.confidence, // el Builder nunca sube inferred → confirmed
      label: ex.label,
      ts: ex.sourceTimestamp,
    };
    if (verdict.reason) dto.reason = verdict.reason;
    if (verdict.outOfRange) dto.outOfRange = true;
    if (typeof ex.opMin === 'number') dto.opMin = ex.opMin;
    if (typeof ex.opMax === 'number') dto.opMax = ex.opMax;
    if (ex.stateEncoding) dto.stateEncoding = ex.stateEncoding;
    if (ex.flowDomainKey) dto.flowDomainKey = ex.flowDomainKey;
    if (typeof ex.stateTrusted === 'boolean') dto.stateTrusted = ex.stateTrusted;
    // Solo se emite cuando es FALSE, y solo para válvulas: el DTO viaja por WebSocket en cada
    // barrido, así que un `commandable: true` en las decenas de señales que no son válvulas serían
    // bytes repetidos sin significado. Ausente = accionable, que es el caso de todas las de hoy.
    if (!ex.commandable && /^valve\d+$/.test(ex.domainKey)) dto.commandable = false;
    // Los verbos, con la MISMA guarda y por el mismo motivo: solo tienen sentido en una válvula, y
    // publicarlos en las 110 señales serían bytes repetidos en cada emisión. Aquí sí se emite
    // aunque haya verbos (no solo en el caso negativo): el front necesita SABER cuáles hay para no
    // ofrecer un "cerrar" que en ocho plantas vuelve como UNKNOWN_COMMAND.
    if (ex.commands.length > 0 && /^valve\d+$/.test(ex.domainKey)) dto.commands = ex.commands;
    signals[ex.domainKey] = dto;
  }

  const snapshot: PlantSnapshotDto = {
    plantId: input.plantId,
    displayName: input.displayName,
    sequence: input.sequence,
    protocolVersion: input.protocolVersion,
    dtoVersion: input.dtoVersion,
    bridgeStatus: input.bridgeStatus,
    liveness: input.liveness,
    signals,
  };
  // Solo cuando es true, por lo mismo que `commandable`: viaja en cada emisión, y en las doce plantas
  // conectadas sería un `false` repetido sin significado. Ausente = planta conectada.
  if (input.integrationPending) snapshot.integrationPending = true;
  return snapshot;
}
