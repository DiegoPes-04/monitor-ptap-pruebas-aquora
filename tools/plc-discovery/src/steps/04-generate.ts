/**
 * ETAPA 04 — Entregables (FASES 9, 10, 12). OFFLINE: no toca el servidor.
 * Emite los 10 documentos de docs/plc/ a partir de los artefactos capturados.
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../config';
import { loadArtifact } from '../lib/artifacts';
import type { AnalysisArtifact } from './03-analyze';
import type { EndpointsArtifact, NodesArtifact, ReadingsArtifact } from '../types';
import { MSG_MEMBERS } from '../heuristics/tokens';
import { buildReport } from '../report/integration-report';

const AVISO =
  'Documento generado por ingeniería inversa de SOLO LECTURA (Browse/Read) sobre el servidor OPC UA de FactoryTalk Optix. ' +
  'No se escribió ninguna variable, no se invocó ningún método y no se creó ninguna subscription. ' +
  'Todo ítem marcado "REQUIERE VALIDACIÓN EN PLANTA" es una hipótesis técnica, NO un hecho confirmado: no debe usarse para control sin validación previa.';

function header(endpoints: EndpointsArtifact, titulo: string): Record<string, unknown> {
  return {
    documento: titulo,
    generadoEl: new Date().toISOString(),
    servidor: {
      endpoint: endpoints.requestedEndpoint,
      endpointAnunciadoPorElServidor: endpoints.hostnameMismatch.announcedByServer,
      producto: endpoints.server.productName,
      estado: endpoints.server.state,
      plc: 'CompactLogix 1769-L27ERM-QBFC1B (fw 33.16) vía RAEtherNet_IPDriver1',
    },
    advertencia: AVISO,
  };
}

function write(dir: string, name: string, data: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`[04] ${name} → ${file}`);
}

export function runGenerate(): void {
  const config = loadConfig();
  const endpoints = loadArtifact<EndpointsArtifact>(config.outputDir, '00_endpoints.json');
  const nodes = loadArtifact<NodesArtifact>(config.outputDir, '01_nodes.json');
  const readings = loadArtifact<ReadingsArtifact>(config.outputDir, '02_readings.json');
  const analysis = loadArtifact<AnalysisArtifact>(config.outputDir, '03_analysis.json');
  const out = config.docsDir;

  // ── 01_inventory.json ────────────────────────────────────────────────────────
  write(out, '01_inventory.json', {
    ...header(endpoints, 'Inventario completo del espacio de direcciones (Fases 1 y 2)'),
    namespaces: nodes.namespaces.map((uri, index) => ({ index, uri })),
    notaNamespace:
      'El índice de namespace de Optix puede cambiar entre reinicios del servidor. El backend DEBE resolver los NodeIds ' +
      'por URI de namespace (readNamespaceArray al conectar), nunca por índice fijo.',
    raices: nodes.roots.map((r) => ({
      etiqueta: r.label,
      ruta: r.path.join('/'),
      nodeId: r.nodeId,
      encontrada: r.found,
      nodos: r.nodeCount,
      error: r.error ?? null,
    })),
    estadisticas: nodes.stats,
    variables: readings.readings.map((r) => ({
      nodeId: r.nodeId,
      browseName: r.browseName,
      displayName: r.displayName,
      rutaCompleta: r.fullBrowsePath,
      padre: r.parentNodeId,
      tipoDato: r.attrs.dataType.name,
      valueRank: r.attrs.valueRank,
      arrayDimensions: r.attrs.arrayDimensions,
      accessLevel: r.attrs.accessLevel,
      userAccessLevel: r.attrs.userAccessLevel,
      legible: r.attrs.accessLevel.currentRead,
      escribible: r.attrs.accessLevel.currentWrite,
      historizing: r.attrs.historizing,
      minimumSamplingInterval: r.attrs.minimumSamplingInterval,
      description: r.attrs.description,
      engineeringUnits: r.attrs.engineeringUnits,
      euRange: r.attrs.euRange,
      instrumentRange: r.attrs.instrumentRange,
      valorActual: r.samples[0]?.value ?? null,
      statusCode: r.samples[0]?.statusCode ?? null,
      sourceTimestamp: r.samples[0]?.sourceTimestamp ?? null,
      serverTimestamp: r.samples[0]?.serverTimestamp ?? null,
      totalMuestras: r.samples.length,
      movimiento: r.movement,
    })),
    notaMuestras:
      'Se conservan valorActual (muestra 1) y el resumen de movimiento. Las 3 muestras crudas completas están en ' +
      'tools/plc-discovery/output/02_readings.json y, por señal, en 03_sensor_map.json.',
  });

  // ── 02_devices.json ──────────────────────────────────────────────────────────
  write(out, '02_devices.json', {
    ...header(endpoints, 'Dispositivos físicos y sitios remotos (Fase 3)'),
    arquitectura: analysis.arquitecturaDetectada,
    limitacionCritica:
      'El PLC maestro NO expone dispositivos: expone buffers de array por sitio. ' +
      'Ningún tanque, bomba, electroválvula, macromedidor ni analítico aparece nombrado en el espacio de direcciones. ' +
      'Los dispositivos listados abajo son INFERIDOS del nombre del buffer y no pueden confirmarse por OPC UA.',
    sitios: analysis.sitios,
    equiposBuscadosNoEncontrados: {
      nota:
        'Se buscaron explícitamente los patrones de nombre habituales (tanque/TK, bomba/BBA, electroválvula/EV/VLV, ' +
        'motor, compuerta, macromedidor, dosificador, cloración, turbidez/NTU, pH, conductividad, OD, ORP, presión/PIT, caudal/FIT, nivel/LIT). ' +
        'Salvo los buffers "TK" (que solo indican que el buffer pertenece a un tanque, sin decir qué contiene cada índice), NINGUNO aparece en el PLC.',
      conclusion:
        'La identificación de dispositivos es IMPOSIBLE por OPC UA en el estado actual del servidor. Requiere el export L5X del programa del PLC.',
    },
  });

  // ── 03_sensor_map.json ───────────────────────────────────────────────────────
  const señalesProceso = analysis.señales.filter(
    (s) => s.direction === 'plc_local→maestro' && !s.movement.allZero,
  );
  write(out, '03_sensor_map.json', {
    ...header(endpoints, 'Mapa de señales de proceso (Fase 4)'),
    metodo:
      'Cada elemento de cada buffer de entrada se trata como una señal independiente. Como el PLC no nombra los elementos, ' +
      'se emiten HIPÓTESIS de magnitud derivadas del valor observado, su rango y su dinámica temporal (3 muestras espaciadas 45 s).',
    totalSeñalesEntrada: analysis.señales.filter((s) => s.direction === 'plc_local→maestro').length,
    señalesConDatoNoNulo: señalesProceso.length,
    señalesEnCero: analysis.señales.filter(
      (s) => s.direction === 'plc_local→maestro' && s.movement.allZero,
    ).length,
    señales: señalesProceso.map((s) => ({
      id: s.id,
      nodeId: s.nodeId,
      indiceArray: s.arrayIndex,
      longitudArray: s.arrayLength,
      sitio: s.site,
      tanque: s.tank,
      tipoDato: s.dataType,
      valorActual: s.samples[0],
      muestras: s.samples,
      rango: { min: s.movement.min, max: s.movement.max },
      cambioDuranteMuestreo: s.movement.changed,
      crecimientoMonotono: s.movement.monotonicNonDecreasing,
      hipotesis: s.hypotheses,
      confianza: s.confidence,
      estado: s.estado,
      procedimientoValidacion: s.procedimientoValidacion,
    })),
  });

  // ── 04_commands.json ─────────────────────────────────────────────────────────
  const buffersComando = [...new Set(analysis.comandosCandidatos.map((s) => s.bufferBrowseName))].sort();
  write(out, '04_commands.json', {
    ...header(endpoints, 'Canal de comandos (Fases 5 y 6)'),
    reglaDeOro:
      'NINGÚN comando está confirmado. La herramienta NUNCA escribió para probar (writeAttemptedByTool=false en todos los casos). ' +
      'Escribir en un índice equivocado de un buffer OUT puede accionar un equipo real. NO IMPLEMENTAR ESCRITURA sin el paso de validación.',
    writeAttemptedByTool: false,
    canalDeComando: {
      descripcion:
        'Los comandos viajan del maestro al PLC local escribiendo en los buffers INT_OUT_<SITIO> / REAL_OUT_<SITIO>, ' +
        'que el maestro transfiere mediante instrucciones MSG_WRITE_*. La codificación (qué bit/índice acciona qué equipo) NO está expuesta.',
      buffersEscribibles: buffersComando,
      totalIndicesEscribibles: analysis.comandosCandidatos.length,
    },
    permisosBackend: {
      nota: 'Mapeo contra el modelo de permisos existente en packages/shared (Permission).',
      electrovalvulas: 'control_valves',
      bombas: 'control_valves',
      consignas: 'adjust_setpoints',
      resetAlarmas: 'acknowledge_alarms',
      rolesConControl: ['operador', 'admin'],
      rolesSinControl: ['jefe (solo supervisión)', 'civil (vista básica)'],
    },
    auditoria: {
      requerida: true,
      motivo:
        'Toda acción de control debe registrarse (usuario, rol, equipo, comando, valor previo, valor solicitado, confirmación por feedback, resultado). ' +
        'No se almacena telemetría, pero sí la bitácora de control: es liviana y aporta trazabilidad, seguridad y diagnóstico.',
      tablaPropuesta: 'control_audit_log (ver 10_integration_report.md)',
    },
    comandos: analysis.comandosCandidatos.map((s) => ({
      id: s.id,
      nodeId: s.nodeId,
      buffer: s.bufferBrowseName,
      indiceArray: s.arrayIndex,
      sitio: s.site,
      tipoDato: s.dataType,
      escribiblePorServidor: s.writableByServer,
      escribiblePorUsuarioActual: s.writableByUser,
      valorActual: s.samples[0],
      equipoAsociado: 'DESCONOCIDO',
      feedbackNodeId: 'DESCONOCIDO — debe determinarse en la validación (qué índice de entrada confirma el efecto)',
      interlocks: 'DESCONOCIDOS — deben leerse del programa del PLC local',
      permisoRequerido: 'control_valves (a confirmar según el equipo real)',
      auditRequired: true,
      writeAttemptedByTool: false,
      confianza: s.confidence,
      estado: 'REQUIERE VALIDACIÓN EN PLANTA',
      procedimientoValidacion: s.procedimientoValidacion,
    })),
  });

  // ── 05_backend_domain.json ───────────────────────────────────────────────────
  write(out, '05_backend_domain.json', {
    ...header(endpoints, 'Modelo de dominio del backend (Fase 9)'),
    principio:
      'El dominio del backend NO refleja la estructura del PLC. El PLC habla de buffers y de índices; el dominio habla de ' +
      'Sitios, Tanques, Sensores y Actuadores. La traducción entre ambos vive exclusivamente en el adaptador OPC UA (capa de infraestructura), ' +
      'de modo que el frontend nunca ve un NodeId ni un índice de array.',
    entidades: [
      {
        nombre: 'Site (Estación remota)',
        descripcion: 'Cada sitio remoto atendido por el PLC maestro. Es el equivalente real de "Plant" en @ptap/shared.',
        campos: [
          { nombre: 'id', tipo: 'string', origen: 'derivado del nombre del buffer (p. ej. "voragine")' },
          { nombre: 'name', tipo: 'string', origen: 'derivado del nombre del buffer' },
          {
            nombre: 'connectionStatus',
            tipo: "'connected' | 'disconnected'",
            origen: 'bits DN/ER/TO de la estructura MSG del sitio — ÚNICA señal con semántica confirmada',
            confianza: 'alta',
          },
        ],
        sitiosDetectados: analysis.sitios.map((s) => s.site),
      },
      {
        nombre: 'Signal (Señal cruda)',
        descripcion:
          'Representación honesta de lo que hoy ofrece el PLC: un elemento de un buffer, con valor y calidad, SIN significado confirmado. ' +
          'Es la entidad puente mientras no exista el mapa de índices.',
        campos: [
          { nombre: 'bufferNodeId', tipo: 'string' },
          { nombre: 'arrayIndex', tipo: 'number' },
          { nombre: 'value', tipo: 'number | boolean' },
          { nombre: 'quality', tipo: 'StatusCode' },
          { nombre: 'sourceTimestamp', tipo: 'string' },
        ],
      },
      {
        nombre: 'Tank / Sensor / Valve / Pump',
        descripcion:
          'Entidades objetivo del frontend. NO SE PUEDEN POBLAR HOY con datos reales: requieren el mapa índice→equipo. ' +
          'Su definición ya existe en packages/shared y NO debe cambiarse; lo que falta es la tabla de mapeo.',
        estado: 'BLOQUEADO — requiere export L5X del PLC o tabla del integrador',
      },
      {
        nombre: 'ControlCommand',
        descripcion: 'Comando operativo con trazabilidad completa (WRITE DOMAIN).',
        campos: [
          { nombre: 'userId / role', tipo: 'string / Role' },
          { nombre: 'deviceId', tipo: 'string' },
          { nombre: 'command', tipo: "'open' | 'close' | 'start' | 'stop' | 'reset' | 'setpoint'" },
          { nombre: 'targetNodeId + arrayIndex', tipo: 'string + number' },
          { nombre: 'previousValue / requestedValue', tipo: 'number' },
          { nombre: 'confirmedByFeedback', tipo: 'boolean' },
          { nombre: 'auditLogged', tipo: 'boolean (siempre true)' },
        ],
        estado: 'BLOQUEADO — requiere validación en planta del mapa de comandos',
      },
    ],
  });

  // ── 06_frontend_mapping.json ─────────────────────────────────────────────────
  write(out, '06_frontend_mapping.json', {
    ...header(endpoints, 'Matriz de correspondencia Frontend ↔ PLC (Fase 10)'),
    contratoActual: 'packages/shared/src/index.ts — Sensor, Tank, Valve, OpcSnapshot, PlantDefinition',
    veredicto:
      'NINGÚN campo del contrato del frontend puede mapearse hoy a una fuente real del PLC con certeza, salvo connectionStatus. ' +
      'El frontend seguirá con datos simulados hasta obtener el mapa de índices del PLC.',
    configObsoleta: {
      archivo: 'apps/api/opc-config.json',
      problema:
        'Declara 8 plantas ficticias (ptap-1…ptap-8) con endpoints opc.tcp://plc-ptap-N:4840 y NodeIds "ns=2;s=PTAPN.Sensors" que NO EXISTEN. ' +
        'El servidor real es uno solo (opc.tcp://10.10.51.225:59100) y los sitios reales son otros.',
      accion: 'Reemplazar por una configuración de un único endpoint + catálogo de sitios reales + mapa de índices (cuando exista).',
      sitiosReales: analysis.sitios.map((s) => s.site),
    },
    matriz: [
      {
        elementoFrontend: 'PlantDefinition.id / .name (selector de planta)',
        propiedadBackend: 'Site.id / Site.name',
        fuentePlc: 'nombre del buffer (sufijo de sitio)',
        nodeId: 'derivado — no es un NodeId único',
        transformacion: 'normalización de nombre (VORAGINE → "voragine" / "La Vorágine")',
        estadoValidacion: 'PARCIAL — los nombres de sitio son ciertos; su correspondencia con las PTAP del negocio debe confirmarse',
      },
      {
        elementoFrontend: 'OpcSnapshot.connectionStatus',
        propiedadBackend: 'Site.connectionStatus',
        fuentePlc: 'MSG_READ_<SITIO>.DN / .ER / .TO',
        nodeId: 'ver 02_devices.json → sitios[].comunicacion.msgNodeIds',
        transformacion: 'DN=true y ER=false y TO=false → "connected"; ER o TO → "disconnected"',
        estadoValidacion: 'CONFIRMADO — semántica estándar de la instrucción MSG de Rockwell',
      },
      {
        elementoFrontend: 'Tank.levelM / .percentage / .volumeM3 / .maxLevelM / .maxVolumeM3',
        propiedadBackend: 'Tank.*',
        fuentePlc: 'algún índice de REAL_TK*_<SITIO> / REAL_IN_<SITIO>',
        nodeId: 'INDETERMINADO',
        transformacion: 'DESCONOCIDA (no hay EURange en ningún tag)',
        estadoValidacion:
          'REQUIERE VALIDACIÓN EN PLANTA — se sabe qué buffer pertenece a qué tanque, pero no qué índice es nivel, volumen o porcentaje. ' +
          'maxLevelM y maxVolumeM3 son datos de ingeniería civil que probablemente NO estén en el PLC: deben configurarse en el backend.',
      },
      {
        elementoFrontend: 'Sensor.value / .unit / .min / .max (presión, caudal, pH, turbidez)',
        propiedadBackend: 'Sensor.*',
        fuentePlc: 'algún índice de REAL_IN_<SITIO>',
        nodeId: 'INDETERMINADO',
        transformacion: 'DESCONOCIDA — ningún tag declara EngineeringUnits ni EURange',
        estadoValidacion:
          'REQUIERE VALIDACIÓN EN PLANTA — unit/min/max NO existen en el PLC y deberán definirse como configuración del backend por instrumento.',
      },
      {
        elementoFrontend: 'Valve.isOpen (electroválvulas)',
        propiedadBackend: 'Valve.isOpen',
        fuentePlc: 'un bit de algún INT_IN_<SITIO> o BIT_<SITIO> (palabra empaquetada)',
        nodeId: 'INDETERMINADO',
        transformacion: 'extracción de bit: (word >> bitIndex) & 1',
        estadoValidacion:
          'REQUIERE VALIDACIÓN EN PLANTA — confirma la nota "packed-INT bit map" ya presente en apps/api/opc-config.json. ' +
          'El mapa de bits sigue sin determinarse.',
      },
      {
        elementoFrontend: 'Acción "abrir/cerrar válvula" (botón de control)',
        propiedadBackend: 'ControlCommand → IndustrialWriterPort.writeCommand',
        fuentePlc: 'un bit/índice de INT_OUT_<SITIO>',
        nodeId: 'ver 04_commands.json',
        transformacion: 'DESCONOCIDA',
        estadoValidacion: 'REQUIERE VALIDACIÓN EN PLANTA — BLOQUEADO. Escribir a ciegas puede accionar un equipo real.',
      },
    ],
    camposSinFuenteEnElPlc: [
      'Sensor.unit, Sensor.min, Sensor.max, Sensor.icon, Sensor.name — metadatos de presentación: deben vivir en configuración del backend, no en el PLC',
      'Tank.maxLevelM, Tank.maxVolumeM3 — capacidad de diseño del tanque: dato de ingeniería, no de PLC',
      'Valve.name, Valve.description — nomenclatura de planta: configuración del backend',
    ],
  });

  // ── 07_transformations.json ──────────────────────────────────────────────────
  const monotonicas = analysis.señales.filter((s) => s.movement.monotonicNonDecreasing);
  write(out, '07_transformations.json', {
    ...header(endpoints, 'Transformaciones RAW ↔ unidades de ingeniería (Fase 7)'),
    hallazgoPrincipal:
      'El PLC entrega valores REAL ya escalados por el programa del PLC local (no hay tags "_RAW" emparejados con tags de ingeniería, ' +
      'y los buffers REAL contienen magnitudes con parte decimal). Sin embargo, NINGÚN tag declara EngineeringUnits ni EURange, ' +
      'de modo que la unidad de cada valor es DESCONOCIDA. No es posible documentar una cadena RAW → escala → offset → unidad.',
    excepcion:
      'Los módulos de E/S del chasis (Local:N:I/Data) SÍ entregan cuentas RAW del conversor A/D del propio CompactLogix. ' +
      'Si el maestro tiene instrumentación local, ahí sí aplicaría un escalamiento RAW→EU, que deberá leerse del programa del PLC.',
    transformacionesConfirmadas: [
      {
        tipo: 'extracción de bit',
        formula: 'estado = (palabraINT >> indiceBit) & 1',
        aplicaA: 'buffers INT_IN_* y BIT_* (estados discretos empaquetados)',
        confianza: 'alta (mecanismo), baja (qué bit es qué equipo)',
        estado: 'MECANISMO CONFIRMADO — ASIGNACIÓN DE BITS REQUIERE VALIDACIÓN EN PLANTA',
      },
      {
        tipo: 'salud de comunicación',
        formula: 'connected = MSG.DN && !MSG.ER && !MSG.TO',
        aplicaA: 'estructuras MSG_READ_* / MSG_WRITE_*',
        confianza: 'alta',
        estado: 'CONFIRMADO',
      },
    ],
    totalizadoresDetectados: monotonicas.map((s) => ({
      id: s.id,
      nodeId: s.nodeId,
      indiceArray: s.arrayIndex,
      sitio: s.site,
      rangoObservado: { min: s.movement.min, max: s.movement.max },
      hipotesis: 'acumulador (volumen tratado / bombeado)',
      estado: 'REQUIERE VALIDACIÓN EN PLANTA',
      nota: 'El crecimiento monótono en 3 muestras es indicio, no prueba: una rampa de proceso se ve igual en una ventana corta.',
    })),
  });

  // ── 08_engineering_units.json ────────────────────────────────────────────────
  write(out, '08_engineering_units.json', {
    ...header(endpoints, 'Unidades de ingeniería (Fase 7 bis)'),
    resultado: {
      tagsConEngineeringUnits: readings.stats.withEngineeringUnits,
      tagsConEURange: readings.readings.filter((r) => r.attrs.euRange).length,
      tagsConInstrumentRange: readings.readings.filter((r) => r.attrs.instrumentRange).length,
      tagsConDescription: readings.readings.filter((r) => r.attrs.description).length,
    },
    conclusion:
      'CERO tags declaran unidades de ingeniería. Esto es esperable: el driver RAEtherNet_IP de Optix expone los tags del ' +
      'controlador Rockwell como variables OPC UA planas (BaseDataVariableType), sin envolverlas en AnalogItemType, que es el ' +
      'tipo que porta EngineeringUnits/EURange/InstrumentRange.',
    implicacion:
      'El catálogo de unidades es responsabilidad del BACKEND. Debe existir una tabla de configuración (por sitio e índice) que ' +
      'declare: magnitud, unidad, rango de ingeniería y límites de alarma. Esa tabla se construye a partir del export L5X del PLC ' +
      'y de la hoja de instrumentación de la planta — no puede derivarse del servidor OPC UA.',
    unidadesEsperadasPorElFrontend: {
      nota: 'Unidades que el contrato @ptap/shared y las pantallas actuales ya asumen; sirven de plantilla para esa tabla.',
      presion: 'psi',
      caudal: 'm³/h (el enunciado también menciona L/s y m³/día)',
      ph: 'pH',
      turbidez: 'NTU',
      nivel: 'm y %',
      volumen: 'm³',
      cloroResidual: 'mg/L',
      conductividad: 'µS/cm',
      oxigenoDisuelto: 'mg/L',
      temperatura: '°C',
    },
  });

  // ── 09_polling_strategy.json ─────────────────────────────────────────────────
  write(out, '09_polling_strategy.json', {
    ...header(endpoints, 'Estrategia de comunicación (Fase 11)'),
    principioClave:
      'CRÍTICO: suscribirse al ARRAY COMPLETO (un MonitoredItem por buffer), NUNCA a cada índice por separado. ' +
      `Hay ${analysis.resumen.totalSeñales} señales pero solo ${new Set(analysis.señales.map((s) => s.nodeId)).size} buffers: ` +
      'un item por buffer reduce la carga sobre el HMI Optix en dos órdenes de magnitud. El backend descompone el array en memoria.',
    subscriptionUnica:
      'Una sola Subscription OPC UA para todo el sistema, con publishingInterval igual al menor intervalo requerido (500 ms) ' +
      'y samplingInterval por MonitoredItem según la tabla. Evita múltiples subscriptions compitiendo por el mismo servidor.',
    reglas: analysis.estrategiaComunicacion,
    consideracionesDeCarga: [
      'El servidor es un HMI de producción (FactoryTalk Optix): no debe saturarse.',
      'El PLC maestro refresca los buffers al ritmo de sus instrucciones MSG (típicamente cientos de ms a segundos). ' +
        'Suscribirse más rápido que ese ciclo no aporta datos nuevos y sí consume recursos.',
      'Recomendación: arrancar con publishingInterval=1000 ms y ajustar tras medir, en lugar de exigir 500 ms de entrada.',
      'El servidor no reportó OperationLimits (valores nulos): el backend debe asumir límites conservadores y batchear las lecturas.',
    ],
  });

  // ── 10_integration_report.md ─────────────────────────────────────────────────
  const md = buildReport({ endpoints, nodes, readings, analysis });
  fs.mkdirSync(out, { recursive: true });
  const mdPath = path.join(out, '10_integration_report.md');
  fs.writeFileSync(mdPath, md, 'utf8');
  console.log(`[04] 10_integration_report.md → ${mdPath}`);

  console.log(`\n[04] 10 entregables generados en ${out}`);
}

if (require.main === module) {
  try {
    runGenerate();
  } catch (err) {
    console.error(`\n[04] FALLÓ: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

void MSG_MEMBERS;
