# Arquitectura del backend — Monitor PTAP

> Documento de arquitectura (entregable Semana 1 del plan de trabajo), **actualizado al estado
> real del sistema**. Describe el diseño implementado y verificado, no un plan.
> Contrato HTTP: [`docs/api/openapi.yaml`](../api/openapi.yaml). Puesta en marcha:
> [`docs/SETUP.md`](../SETUP.md). Datos por planta: [`docs/DATA_CATALOG.md`](../DATA_CATALOG.md).

## 1. Qué resuelve

Leer en tiempo real 13 sitios de tratamiento de agua potable concentrados en un PLC maestro
Allen-Bradley, expuesto por un servidor **FactoryTalk Optix OPC UA**, y presentarlos en una app
móvil/web **sin que el tablero mienta**: un dato congelado se ve congelado, un valor inferido no
se presenta igual que uno confirmado, y una señal en la que no confiamos no se muestra como número.

## 2. Flujo de datos (capas obligatorias, sin saltos)

```
PLC (Allen-Bradley + FactoryTalk Optix OPC UA)
  │  opc.tcp://181.204.165.66:59100
  ▼
OPC UA Adapter ─────────► RawPlantFrame por planta (coalescido)
  │   1 MonitoredItem por BUFFER (nodo array completo), nunca uno por elemento
  │   + watchdog + heartbeat + máquina de estados del puente
  ▼
FrameCoalescer      → un frame por planta por ventana (no uno por buffer)
  ▼
Parser + Sequence   → RawSnapshot { plantId, sequence, buffers } + DeadLetter de anómalos
  ▼
Liveness            → live | idle | stale | unknown  (frescura POR PLANTA)
  ▼
Mapping Engine      → (buffer, índice) → domainKey, desde config/opc_mapping.json
  ▼
Quality Service     → usable / reason (calidad OPC, rango, NaN, frescura)
  ▼
Snapshot Builder    → PlantSnapshotDto (DTO de dominio)
  ▼
PlantCache (RAM, único escritor)
  ▼
REST + Socket.IO ───────► App móvil / web (Expo)
```

**Es el único camino de datos vivo.** El poller legado previo al puente (ports
`IndustrialReader/Writer/ProtocolAdapter`, `ConnectivityService`, `RawFrameCache`) se **eliminó**
al completarse el Mapping Engine; no quedan dos caminos compitiendo.

## 3. Reglas de diseño que no se rompen

1. **La telemetría no se persiste.** Cache solo en RAM. MySQL guarda únicamente usuarios,
   auditoría y comandos.
2. **Cero números mágicos de índice en el código**: toda la semántica vive en `opc_mapping.json`.
3. **El adapter no conoce la PTAP**: solo endpoints, NodeIds y buffers.
4. **El frontend nunca recibe arrays crudos**: solo DTOs de dominio.
5. **El simulador no se elimina**: `SimulatorBridgeAdapter` es el testbed permanente sin PLC.
6. **Un MonitoredItem por buffer**; el diff de elementos lo hace el parser.
7. **SourceTimestamp del PLC**, nunca `Date.now()` para datos de proceso.
8. **Toda la config OPC sale de `.env`**: cero valores quemados.
9. **Escritura al PLC detrás de feature flag + sesión autenticada y cifrada.**
10. Cada dato lleva `value`, `quality`, `usable`, `mappingStatus`, `confidence`, `sourceTimestamp`.
11. **Estado del puente = máquina de estados explícita**, nunca un boolean.
12. **Nada se pierde en silencio**: lo anómalo va al DeadLetter, consultable por endpoint admin.

## 4. Puertos y adaptadores

Un único puerto, `ConnectivityAdapter`, con dos implementaciones seleccionadas por
`CONNECTIVITY_PROVIDER`:

| Provider | Implementación | Uso |
|---|---|---|
| `opcua` | `OpcUaConnectivityAdapter` | PLC real (node-opcua: Subscriptions, PKI, reconexión) |
| `simulator` | `SimulatorBridgeAdapter` | Testbed sin PLC; emula todos los estados del puente |

El puerto expone lectura push (`onFrame`, `onStatusChange`), diagnóstico (`getDiagnostics`,
`getServerInfo`, `getBufferHealth`) y, desde Fase 5, escritura (`writeBufferElement`,
`readBufferElement`, `getWriteSecurity`).

## 5. Estado del puente (`BridgeStatus`)

Máquina de estados explícita con transiciones registradas (timestamp + motivo):

`Connecting → Connected → Recovering | Stale | Disconnected | Faulted`

- **Stale**: sesión viva pero sin notificaciones nuevas (datos congelados).
- **Faulted**: error irrecuperable que exige intervención (p. ej. namespace no resuelto).

Resiliencia en capas: watchdog (sin notificaciones) → reciclaje de subscription → reciclaje de
sesión; heartbeat independiente; reconexión con backoff de node-opcua.

## 6. Estructura del código

```
apps/api/src/
├── main.ts                 # Arranque COMPLETO (requiere MySQL): auth, RBAC, usuarios, comandos
├── main.telemetry.ts       # Arranque de TELEMETRÍA (sin BD): puente + pipeline + REST + Socket.IO
├── config/load-env.ts      # Carga el .env de la raíz del monorepo
├── infrastructure/
│   ├── connectivity/       # ★ El corazón: puente + pipeline (sin BD)
│   │   ├── adapters/opcua|simulator/
│   │   ├── bridge/         # watchdog, heartbeat, frame-coalescer, state-machine
│   │   ├── pipeline/       # parser, liveness, mapping, quality, snapshot, cache, dead-letter
│   │   ├── mapping/        # loader de opc_mapping.json
│   │   ├── ports/          # ConnectivityAdapter (contrato único)
│   │   ├── connectivity.config.ts     # TODA la config OPC desde .env
│   │   ├── connectivity.gateway.ts    # Socket.IO
│   │   └── opc-observability.module.ts # /api/opc/* con RBAC (CON BD; solo main.ts)
│   ├── database/           # Pool MySQL + migrations/ (users, audit_log, command_log)
│   ├── audit/              # AuditLogService + AuditMiddleware (accesos permitidos y denegados)
│   ├── metrics/            # Prometheus (/metrics)
│   ├── logging/            # JsonLogger (pino)
│   └── validation/         # ZodValidationPipe
└── modules/                # Dominios HTTP: auth, users, plants, health, commands
```

**Por qué dos entrypoints:** `main.ts` monta todo y por eso exige MySQL. `main.telemetry.ts` monta
solo el slice de telemetría — todo lo que el móvil necesita para ver datos — y no toca la base de
datos. La observabilidad con RBAC vive en un módulo aparte (`OpcObservabilityModule`) para que
importar `ConnectivityModule` nunca obligue a tener MySQL arriba.

## 7. Seguridad

- **Autenticación**: `POST /api/auth/login` → JWT (8 h). Contraseñas con **Argon2id + pepper**.
- **Auto-registro**: `POST /api/auth/register` crea SIEMPRE rol `civil`; el rol lo fija el
  servidor (el schema es `.strict()`: enviar `role` → 400).
- **Autorización**: permisos granulares de `@ptap/shared` (`ROLE_PERMISSIONS`/`hasPermission`),
  aplicados con `@RequirePermission(...)` + `PermissionGuard`. Es la **misma fuente** que consume
  el móvil para su UI. Solo el Administrador gestiona usuarios y asigna roles.
- **Auditoría**: `AuditMiddleware` registra accesos **permitidos y denegados** (200/401/403);
  los cambios de rol y las transiciones del puente se auditan con detalle.
- **OPC UA**: conmutación por `.env` a `SignAndEncrypt`/`Basic256Sha256` con identidad
  `username` o `certificate`.
- **Hallazgo P0 abierto**: el servidor de la planta acepta `Anonymous + None` — ver
  [`docs/SECURITY_FINDING_P0.md`](../SECURITY_FINDING_P0.md).

## 8. Convenciones de rutas API

- Prefijo global `/api` (excepto `/metrics`, fuera del prefijo por convención de Prometheus).
- Sustantivos en plural y minúsculas: `/api/plants`, `/api/users`.
- kebab-case para nombres compuestos: `/api/opc/dead-letter`.
- Sin verbos en la ruta base; el verbo lo expresa el método HTTP.
- Identificadores como segmentos: `/api/plants/:plantId`.
- Subrecursos cuando hay pertenencia clara: `/api/plants/:plantId/snapshot`, `.../commands`.
- `/api/v1` solo si aparece necesidad real de versionado público; el DTO ya viaja versionado
  (`protocolVersion`/`dtoVersion`).

## 9. Identidad de planta

El `plantId` (**slug canónico**) es la única identidad en todo el sistema: `voragine, soledad,
montebello, cascajal, km18, alto-los-mangos, campoalegre, pichinde, carbonero, sirena,
san-antonio, quijote, cabuyo, luisa, leonera, gloria` (16; las 4 últimas están en integración,
dadas de alta sin señales hasta que el integrador las suba al PLC maestro). Nada de `PTAP Norte`
ni `ptap-1`. Los índices de array **no son
transferibles entre plantas** (`realIn[5]` es caudal en Montebello y nivel de tanque en
Campoalegre): siempre se direcciona por `(plantId, domainKey)`.
