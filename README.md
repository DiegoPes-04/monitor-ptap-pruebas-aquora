# Monitor PTAP

Sistema de **monitoreo en tiempo real de 16 Plantas de Tratamiento de Agua Potable (PTAP)**,
conectadas a través de un PLC maestro Allen-Bradley expuesto por un servidor **FactoryTalk
Optix OPC UA**. Doce están en operación. Cabuyo, La Luisa, La Leonera y Gloria están en
integración: dadas de alta sin señales hasta que el integrador las suba al PLC maestro (ficha en
[`docs/plc/PLANTAS_NUEVAS_CABUYO_LUISA_LEONERA_GLORIA.md`](docs/plc/PLANTAS_NUEVAS_CABUYO_LUISA_LEONERA_GLORIA.md)).
El backend lee los buffers crudos del PLC, los procesa por un pipeline de capas y los publica a
la app móvil/web por REST y Socket.IO.

> **Estado real (2026-08-05):** el puente OPC UA está **vivo contra el PLC real** y la telemetría
> viaja de punta a punta (PLC → backend → móvil) en tiempo real. La telemetría vive **solo en RAM**
> (nunca se persiste). **Las 6 fases están ejecutadas** (245/245 tests, typecheck limpio en todo el
> monorepo, `validate:mapping` OK).
>
> **El canal de escritura al PLC está ABIERTO** desde el 2026-08-03, autorizado por Operación: se
> pueden comandar válvulas en las 12 plantas desde la app, con doble confirmación, RBAC, interlock,
> idempotencia y read-back. Requiere `OPCUA_ALLOW_INSECURE_WRITES=true` porque el servidor OPC UA del
> equipo solo admite Anonymous + None (hallazgo P0 abierto) — la protección real es perimetral, no
> del protocolo. **Alcance real hoy:** falta el actuador físico en varias plantas y el verbo `close`
> no existe en todo el mapping, así que muchos comandos devuelven `READBACK_UNCONFIRMED` o
> `UNKNOWN_COMMAND`: es la respuesta correcta, no un fallo del canal.
>
> El grueso de las señales de proceso sigue `unmapped` a la espera del export L5X del PLC.
> Detalle en [§0 Estado de fases](#estado-de-fases). Lo que falta, en
> [`docs/PENDIENTES.md`](docs/PENDIENTES.md).

---

## Índice

0. [Estado de fases](#estado-de-fases)
1. [Propósito y alcance](#propósito-y-alcance)
2. [Arquitectura](#arquitectura)
3. [Índice del repositorio](#índice-del-repositorio)
4. [Stack técnico y por qué](#stack-técnico-y-por-qué)
5. [Requisitos previos](#requisitos-previos)
6. [Instalación](#instalación)
7. [Configuración (.env)](#configuración-env)
8. [Cómo levantar el proyecto](#cómo-levantar-el-proyecto)
9. [Acceso externo (Cloudflare Tunnel)](#acceso-externo-cloudflare-tunnel)
10. [API REST y eventos Socket.IO](#api-rest-y-eventos-socketio)
11. [Pruebas, typecheck y scripts de mapping](#pruebas-typecheck-y-scripts-de-mapping)
12. [Empaquetado Android (APK)](#empaquetado-android-apk)
13. [Optimizaciones de rendimiento aplicadas](#optimizaciones-de-rendimiento-aplicadas)
14. [Reglas de dominio y convenciones](#reglas-de-dominio-y-convenciones)
15. [Guía para nuevos desarrolladores](#guía-para-nuevos-desarrolladores)
16. [Documentación de referencia](#documentación-de-referencia)

---

## Estado de fases

| Fase | Alcance | Estado | Evidencia |
|------|---------|--------|-----------|
| **0** | Contratos (`opc_mapping.schema.json`/`.json`), hallazgo de seguridad P0 | ✅ Completa | `npm run validate:mapping` → 16 plantas OK (4 en integración, sin señales); `docs/SECURITY_FINDING_P0.md`, `docs/plc/OBSERVACIONES_FASE0.md` |
| **1** | Adaptador OPC UA real, `BridgeStatus`, watchdog, heartbeat, reconexión, `/api/opc/status`\|`info`\|`buffers` | ✅ Completa | `bridge-state-machine.ts`, `watchdog.ts`, `heartbeat-monitor.ts`; tests de bridge en verde |
| **2** | Parser + sequence + dead letter + cache RAM + Socket.IO con datos reales | ✅ Completa | `plant-pipeline.service.ts`, `/api/opc/dead-letter`; caudal de Montebello confirmado contra el PLC (`docs/plc/OBSERVACIONES_FASE0.md` §4). Replay contra tramas REALES: `test/plc-replay.test.ts` |
| **3** | Mapping Engine + Quality Service + Snapshot Builder + `dtoVersion` | ✅ Completa | `mapping.engine.ts`, `quality.evaluator.ts`, `snapshot.builder.ts` |
| **4** | JWT/RBAC, seguridad OPC (SignAndEncrypt+certificado), `/health/opc`, métricas Prometheus, audit log en MySQL, helmet/rate-limit | ✅ Completa | `AuthModule` (login, guards), `users`/`audit_log` en MySQL (`db:migrate`/`db:seed-admin`), `apps/api/test/opcua-security-switch.test.ts` (username **y** certificate probados contra un `OPCUAServer` local real), `GET /api/health/opc`, `GET /metrics`, `docs/OPTIX_CLIENT_CERT_TRUST.md` |
| **5** | Canal de escritura (comandos) con interlocks, idempotencia y feature flag | ✅ Completa y **ABIERTA en producción** (autorizada 2026-08-03; 10 señales `valve1` writable en el mapping) | `write.service.ts`, `commands.controller.ts` (`POST /api/plants/:id/commands`), `command-log.repository.ts` (idempotencia MySQL); `test/write-service.test.ts` (24), `test/commands-e2e.test.ts`, `test/command-mapping.test.ts`. Prueba física real: `docs/archivo/PRUEBA_VALVULA_SIRENA.md` |
| **7** | Bandeja de notificaciones + detector de sensores congelados | ✅ Completa (2026-08-06) | Migración `0009`, `modules/notifications/`, `stale-data.detector.ts`; `test/stale-data-detector.test.ts` (13). En el front: bandeja con historial de 72 h, campana por **no vistos**, y avisos en el panel del sistema (Android por notificación local, sin Firebase) |
| **6** | Validación operacional: caos, carga, latencia, soak 24–72 h | ✅ Completa | `test/operational-resilience.test.ts` (6 escenarios de caos), `scripts/operational-validation.ts` (carga/latencia), `scripts/soak-test.ts` + `scripts/soak-report.ts` (**24 h saldadas**: crecimiento de RSS 0 %, 0 fugas de handles, 48 ciclos de caos), `docs/OPERATIONAL_VALIDATION.md` |

Verificado el 2026-08-05: `npm run typecheck` limpio en **todo el monorepo** (`@ptap/api`,
`@ptap/mobile`, `@ptap/shared`), `npm test -w @ptap/api` → **245/245 tests OK** en 31 archivos
(incluye handshake real contra un servidor OPC UA local con SignAndEncrypt+Basic256Sha256, y replay
del pipeline contra tramas reales capturadas del PLC), `npm run validate:mapping -w @ptap/api` →
mapping válido. `npm run lint` pasa con **0 errores** y 58 warnings de estilo (`array-type`,
`import/first`).

> ⚠️ **Hueco de cobertura conocido:** el script `typecheck` solo cubre `src/**`. Ni `test/` ni
> `scripts/` los typechequea ningún script ni el CI. Ver [`docs/PENDIENTES.md §4`](docs/PENDIENTES.md).

**Novedades de Fase 4 para desarrolladores:**
- `POST /api/auth/login` (`{ email, password } → { token, user: AuthUser }`, mismo shape que ya
  espera `apps/mobile/services/auth.ts`) y `@UseGuards(JwtAuthGuard, PermissionGuard)` en
  `/api/opc/*`, `/api/plants/*`, `/api/users/*`. El RBAC gatea por **permiso granular**
  (`@RequirePermission('system_config')`, etc.) usando `ROLE_PERMISSIONS`/`hasPermission()` de
  `@ptap/shared` — la **misma** fuente que consume el móvil para features de UI. Se retiró el
  antiguo sistema paralelo de tiers (`RoleTier`/`ROLE_TIER`/`tierAtLeast`) porque no podía
  expresar la matriz oficial (p. ej. `jefe` = todo lo del operador **salvo** `control_valves`).
  Una ruta sin `@RequirePermission` solo exige un JWT válido (cualquier rol autenticado).
- `npm run db:migrate -w @ptap/api` crea `users`+`audit_log`; `npm run db:seed-admin -w @ptap/api`
  siembra el primer admin desde `SEED_ADMIN_*` (`.env`).
- `OpcController` (antes en `ConnectivityModule`) se movió a `OpcObservabilityModule` — así
  `main.telemetry.ts` (demo sin MySQL) sigue arrancando sin BD; solo `main.ts` (app completa)
  expone `/api/opc/*` con RBAC.
- `GET /metrics` vive **fuera** del prefijo `/api` (convención Prometheus); `GET /api/health/opc`
  devuelve 503 en `Stale`/`Faulted`.
- El gateway Socket.IO **ya exige JWT en el handshake** (SRV-04): el token viaja en `auth.token` y
  `resetSocket()` lo renueva en cada cambio de identidad. Cubierto por `test/gateway-auth.test.ts`.

> El **mobile app** consume el pipeline real en **todas** sus pantallas (`services/api.ts`): sensores,
> tanques, válvulas y reportes. **No queda ningún mock** — `mock-data.ts` fue eliminado.
> El **login ya es real**: `services/auth.ts` llama a `POST /api/auth/login`, el rol sale de MySQL
> (no del email), el JWT viaja en cada petición REST y la sesión persiste (secure-store/
> localStorage), con un 401 limpiándola automáticamente. **Hay auto-registro**, pero la cuenta nace
> `civil` y **pendiente**: la habilita un admin (ver §Gestión de usuarios). Las cuentas de demo se
> siembran ya aprobadas con `npm run db:seed-users -w @ptap/api`. Ojo: el login exige el arranque
> COMPLETO (`npm run dev:api`); `start:telemetry` no monta `/api/auth/login` ni los guards.

---

## Propósito y alcance

El operador debe poder ver el estado real de cada PTAP **sin que el tablero mienta**: un dato
congelado debe verse como congelado, un valor inferido no debe verse igual que uno confirmado,
y una señal en la que no confiamos no se muestra como número. Ese principio de honestidad
atraviesa todo el diseño.

- **Sí hace:** leer buffers OPC UA, detectar frescura por planta, mapear señales conocidas a
  dominio, evaluar calidad, exponer DTOs por REST + push por Socket.IO.
- **También hace (desde 2026-08-03):** escribir al PLC para comandar válvulas, con doble
  confirmación en la app, RBAC, interlock, idempotencia y read-back de verificación.
- **No hace:** persistir telemetría en MySQL (vive solo en RAM, por diseño), ni inventar semántica
  de señales sin evidencia documental.

---

## Arquitectura

Flujo obligatorio de capas, sin saltos:

```
PLC (Allen-Bradley + FactoryTalk Optix OPC UA)
  │  opc.tcp://181.204.165.66:59100  (Anonymous + SecurityPolicy None — hallazgo P0)
  ▼
OPC UA Adapter ──────────► emite RawPlantFrame por planta (coalescido)
  │   (1 MonitoredItem por buffer; watchdog + heartbeat + máquina de estados)
  ▼
FrameCoalescer  → un frame por planta por ventana (no uno por buffer)
  ▼
Parser + Sequence  → RawSnapshot { plantId, sequence, buffers } + DeadLetter de anómalos
  ▼
Liveness (4 estados: live | idle | stale | unknown, por frescura de datos)
  ▼
Mapping Engine  → buffer+index → domainKey (desde config/opc_mapping.json)
  ▼
Quality Service → usable / reason (rango, NaN, calidad OPC, frescura)
  ▼
Snapshot Builder → PlantSnapshotDto (DTO de dominio)
  ▼
PlantCache (RAM, único escritor)
  ▼
REST  +  Socket.IO  ────────►  App móvil / web (Expo)
```

**Estado del puente** = máquina de estados explícita (`BridgeStatus`), nunca un boolean:
`Connecting | Connected | Recovering | Stale | Disconnected | Faulted`. Toda transición pasa
por una única clase (`BridgeStateMachine`) y se registra con timestamp y motivo.

Dos adaptadores implementan el mismo puerto `ConnectivityAdapter` y se eligen con
`CONNECTIVITY_PROVIDER`:
- **`opcua`** → PLC real (`OpcUaConnectivityAdapter`).
- **`simulator`** → testbed sin PLC (`SimulatorBridgeAdapter`), capaz de emular todos los
  estados del bridge (Stale, Faulted, reciclaje, heartbeat).

---

## Índice del repositorio

```txt
monitor-ptap/
├── apps/
│   ├── api/                         # Backend NestJS (bridge OPC UA + pipeline + REST + Socket.IO)
│   │   ├── config/
│   │   │   ├── opc_mapping.json          # Contrato de mapping (fuente de semántica; NO editar a mano)
│   │   │   └── opc_mapping.schema.json   # JSON Schema del mapping
│   │   ├── fixtures/plc-discovery/       # Evidencia congelada de topología (fuente del generador)
│   │   ├── scripts/
│   │   │   ├── generate-mapping.ts       # Genera opc_mapping.json (idempotente)
│   │   │   ├── validate-mapping.ts       # Valida schema + reglas semánticas
│   │   │   ├── resolve-namespaces.ts     # nsUri → índice de namespace
│   │   │   ├── read-opcua-node.ts        # Lectura puntual de un nodo (debug)
│   │   │   ├── migrate.ts                # Runner de migraciones SQL (users, audit_log)
│   │   │   └── seed-admin-user.ts        # Siembra el primer usuario admin desde SEED_ADMIN_*
│   │   ├── src/
│   │   │   ├── main.ts                    # Arranque COMPLETO (requiere MySQL)
│   │   │   ├── main.telemetry.ts          # Arranque de TELEMETRÍA (bridge+pipeline+REST+socket, sin BD)
│   │   │   ├── config/load-env.ts         # Carga .env de la raíz del monorepo
│   │   │   ├── infrastructure/
│   │   │   │   ├── database/               # Pool MySQL + migrations/ (users, audit_log)
│   │   │   │   ├── audit/                  # ★ Fase 4: AuditLogService, AuditMiddleware (accesos), eventos de conexión
│   │   │   │   ├── metrics/                # ★ Fase 4: MetricsService, /metrics, subscriber de métricas
│   │   │   │   ├── logging/                # ★ Fase 4: JsonLogger (pino), eventos estructurados
│   │   │   │   ├── validation/             # ★ Fase 4: ZodValidationPipe, schema de plantId
│   │   │   │   ├── http-hardening.config.ts # ★ Fase 4: CORS/rate-limit desde .env
│   │   │   │   └── connectivity/           # ★ El corazón del sistema (Fases 1-3, sin BD)
│   │   │   │       ├── adapters/opcua/     #   Adaptador OPC UA real (+ identidad certificate, Fase 4)
│   │   │   │       ├── adapters/simulator/ #   Adaptador simulado (testbed)
│   │   │   │       ├── bridge/             #   watchdog, heartbeat-monitor, frame-coalescer, state-machine
│   │   │   │       ├── pipeline/           #   parser/liveness/mapping/quality/snapshot/cache/dead-letter
│   │   │   │       ├── ports/              #   ConnectivityAdapter (contrato único del puente)
│   │   │   │       ├── mapping/            #   Loader de opc_mapping.json
│   │   │   │       ├── connectivity.config.ts    # TODA la config OPC/liveness desde .env
│   │   │   │       ├── connectivity.module.ts    # Wiring DI (sin BD — usado por main.ts Y main.telemetry.ts)
│   │   │   │       ├── opc-observability.module.ts # ★ Fase 4: OpcController + RBAC/audit/métricas (CON BD; solo main.ts)
│   │   │   │       ├── connectivity.gateway.ts   # Socket.IO (opc:snapshot / opc:liveness) — JWT en el handshake
│   │   │   │       ├── bridge-orchestrator.service.ts  # Ciclo de vida + retry del adaptador
│   │   │   │       └── opc.controller.ts   # /api/opc/status|info|buffers|dead-letter (RBAC, Fase 4)
│   │   │   └── modules/                    # Dominios HTTP: auth, users, plants, health (+/opc), commands, hmi, reports
│   │   └── test/                          # Suite (node:test + tsx) — 245 tests en 31 archivos (ver §11)
│   └── mobile/                       # App Expo (Android / iOS / Web)
│       ├── app/                          # Rutas (expo-router): (auth)/login, (app)/tablero…
│       ├── components/                   # GaugeCard, TankGaugeCard, ValveItem, LiveBadge, PlantSelector…
│       ├── hooks/                        # useSnapshot (REST + Socket.IO), useAlerts, useValveSupervisor…
│       ├── services/
│       │   ├── api.ts                     # Cliente REST REAL (cero mocks en toda la app)
│       │   ├── socket.ts                  # Cliente Socket.IO
│       │   ├── valves.ts / reports.ts     # Válvulas y reportes contra el backend real
│       │   └── auth.ts                    # Login JWT real contra /api/auth/login
│       ├── context/                      # PlantContext (12 slugs canónicos), AuthContext
│       └── constants/colors.ts
├── packages/
│   └── shared/                      # @ptap/shared: roles, permisos y tipos compartidos (única fuente)
├── tools/
│   └── plc-discovery/               # Herramienta standalone de ingeniería inversa OPC UA (solo lectura)
├── docs/                            # Documentación técnica, hallazgos y evidencia (ver §13)
├── .env / .env.example             # Configuración local (el .env NO se commitea)
└── package.json                    # Workspaces + scripts del monorepo
```

---

## Stack técnico y por qué

| Área | Elección | Motivo |
|------|----------|--------|
| **Monorepo** | npm workspaces (`apps/*`, `packages/*`) | Sin herramienta extra; comparte tipos vía `@ptap/shared`. |
| **Lenguaje** | TypeScript estricto (sin `any` silencioso) | Errores tipados por capa; contrato explícito PLC↔dominio↔front. |
| **Backend** | NestJS 12 + Express | DI e inyección por módulos encajan con la arquitectura de capas. |
| **OPC UA** | `node-opcua` | Cliente OPC UA maduro (Subscriptions, MonitoredItems, PKI, reconexión). |
| **Tiempo real** | Socket.IO 4 (`@nestjs/platform-socket.io`) | Push por planta solo en cambios; el front no hace polling. |
| **Base de datos** | MySQL (`mysql2`) | **Solo** auth/usuarios/auditoría/config. **Nunca** telemetría (regla 1). |
| **Runtime dev** | `tsx` | Ejecuta TS sin build; `tsx watch` para hot-reload. |
| **Tests** | Runner nativo `node:test` + `tsx` (no Jest) | Cero config; rápido; suficiente para lógica pura y de temporizadores. |
| **Mapping** | JSON + JSON Schema (`ajv`) + generador idempotente | La semántica vive en datos versionados, no en el código (regla 2). |
| **Móvil** | Expo ~58 + React Native 0.88 + expo-router | Un solo código para Android/iOS/Web. |
| **Estado datos móvil** | TanStack React Query 5 | Cache + estados de carga; el socket parchea la cache. |
| **Estilos móvil** | NativeWind 4 (Tailwind) + estilos inline | Consistencia visual sin CSS aparte. |
| **Formato config PLC** | `opc_mapping.json` con `{ nsUri, identifier }` sin índice de ns | El índice de namespace de Optix cambia entre reinicios → se resuelve en runtime. |
| **Timestamps** | `SourceTimestamp` del PLC, nunca `Date.now()` para proceso (regla 7) | El dato lleva la hora del PLC; `receivedAt` es solo metadato de transporte. |

---

## Requisitos previos

- **Node.js 26.12.1 o superior**. La versión exacta del proyecto está en `.nvmrc`; incluye `npm`.
- **Git Bash** o PowerShell (Windows).
- **MySQL** corriendo en `127.0.0.1:3306` — **solo** si vas a levantar el backend COMPLETO
  (`main.ts`). El arranque de **telemetría** no lo necesita. En Windows, si no tienes MySQL
  instalado como servicio, se puede instalar con `winget install --id Oracle.MySQL` e
  inicializarlo a mano (`mysqld --initialize-insecure --datadir=<ruta>`, luego correrlo como
  proceso normal con `mysqld --datadir=<ruta>`) — útil cuando no tienes permisos de administrador
  para registrarlo como servicio de Windows.
- **Acceso de red** al PLC (`opc.tcp://181.204.165.66:59100`) para el modo `opcua`.
  Sin red al PLC, usa `CONNECTIVITY_PROVIDER=simulator`.
- Para el móvil: la app **Expo Go** en un dispositivo, un emulador, o simplemente el navegador
  (modo web).
- **Solo para compilar el `.apk` de Android** (no hace falta para desarrollar): JDK 17
  (`winget install --id Microsoft.OpenJDK.17`) y Android SDK (platform-tools + `platforms;android-36`
  + `build-tools`) — ver [§12 Empaquetado Android](#empaquetado-android-apk) y `docs/ANDROID_APK.md`.
- **Solo para exponer el proyecto fuera de tu red local** (que otro dispositivo/persona lo use sin
  estar en tu wifi): `cloudflared` (`winget install --id Cloudflare.cloudflared`) — ver
  [§9 Acceso externo](#acceso-externo-cloudflare-tunnel).
- **Solo para probar el flujo de verificación de correo sin un proveedor SMTP real**:
  [Mailpit](https://mailpit.axllent.dev/) (`winget install --id axllent.mailpit`), un servidor SMTP
  de pruebas que captura los correos localmente (UI en `http://localhost:8025`) en vez de
  enviarlos — ver `EMAIL_TRANSPORT` en la sección de configuración.

---

## Instalación

Desde la raíz del monorepo (instala todos los workspaces):

```bash
npm ci
```

> **SDK 58:** Expo Go para SDK 58 todavía no está publicado en las tiendas. Para probar en un
> dispositivo, usa una development build o una APK compilada con `npm run build:android`.

---

## Configuración (.env)

El backend lee un **único `.env` en la raíz** del monorepo (`monitor-ptap/.env`). Copia el
ejemplo y ajústalo:

```bash
cp .env.example .env
```

Claves relevantes (todas documentadas en `.env.example`):

| Variable | Default | Para qué |
|----------|---------|----------|
| `CONNECTIVITY_PROVIDER` | `opcua` | `opcua` (PLC real) o `simulator` (sin PLC). |
| `OPC_ENDPOINT` | `opc.tcp://181.204.165.66:59100` | Endpoint OPC UA. |
| `OPCUA_PUBLISHING_INTERVAL_MS` | `1000` | Ritmo de publicación de la Subscription. |
| `OPCUA_SAMPLING_INTERVAL_MS` | `500` | Muestreo del servidor. |
| `OPCUA_COALESCE_WINDOW_MS` | `1000` | Ventana de coalescing (un frame por planta). |
| `OPCUA_REQUESTED_LIFETIME_COUNT` / `..._MAX_KEEPALIVE_COUNT` | `100` / `10` | Vida de la Subscription (lifetime ≥ 3×keepalive o el backend no arranca). |
| `OPCUA_HEARTBEAT_MAX_FAILURES` | `2` | Fallos consecutivos → `Recovering`. |
| `LIVENESS_LIVE_SEC` / `LIVENESS_WINDOW_SEC` | `10` / `300` | Umbrales de frescura (live / stale). |
| `DB_PASSWORD` | *(vacío)* | **Obligatorio solo para el backend COMPLETO** (`main.ts`). |
| `JWT_SECRET` | *(vacío, obligatorio)* | Firma de tokens (Fase 4). El backend completo no arranca sin esto. |
| `SEED_ADMIN_EMAIL`/`PASSWORD`/`NAME`/`PLANT` | *(vacío)* | Solo los lee `npm run db:seed-admin -w @ptap/api` (no el runtime). |
| `OPC_AUTO_ACCEPT_UNKNOWN_CERTIFICATE` | `false` | `true` solo para bootstrap/desarrollo; nunca en producción contra la planta (ver `docs/OPTIX_CLIENT_CERT_TRUST.md`). |
| `CORS_ORIGINS` | *(vacío)* | Orígenes permitidos, separados por coma; vacío = CORS deshabilitado en `main.ts` (y el arranque lo avisa en el log). **Para la web de Expo pon `http://localhost:8081`**: corre en otro puerto que el backend, así que sin esto el *navegador* bloquea el login. `curl` no lo detecta — no aplica CORS. Si además expones la web por un túnel de Cloudflare (§9), agrega también esa URL HTTPS aquí (coma-separada) — el gateway Socket.IO hereda esta misma allowlist. |
| `EMAIL_TRANSPORT` | `console` | `console` (default; escribe el link de verificación en el log, sin envío real — cómodo para dev) o `smtp` (envío real vía nodemailer con las `SMTP_*` de abajo). Con `smtp` pero sin `SMTP_HOST`/`USER`/`PASS` completos, cae a `console` con aviso. |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_SECURE` | *(vacío)* | Credenciales SMTP reales. **Para probar el flujo de verificación sin un proveedor real ni arriesgar credenciales**, apunta esto a un servidor local como Mailpit (`SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`, `SMTP_USER`/`SMTP_PASS` cualquier valor) — Mailpit acepta cualquier credencial y muestra los correos capturados en `http://localhost:8025`, sin enviarlos a ninguna bandeja real. |
| `APP_PUBLIC_URL` | `http://localhost:PORT` | Base del enlace de verificación de correo (`GET /api/auth/verify-email?token=...`). Debe ser una URL que la persona que registra la cuenta pueda abrir: la IP LAN si prueban desde otro dispositivo en tu red, o la URL del túnel de Cloudflare (§9) si prueban desde fuera. |
| `EMAIL_VERIFICATION_TTL_HOURS` | `24` | Vigencia del enlace de verificación. Vencido, hay que pedir uno nuevo con `POST /api/auth/resend-verification`. |
| `REGISTER_BLOCK_DISPOSABLE` | `true` | Bloquea dominios de correo desechables (mailinator, yopmail, guerrillamail…) en el auto-registro. |

> El móvil apunta por defecto a `http://localhost:4000`. Para un **dispositivo físico en tu misma
> red**, define `API_BASE_URL` como variable de entorno antes de `expo start --web`/`prebuild` con
> la IP LAN del backend (p. ej. `$env:API_BASE_URL = "http://192.168.1.x:4000"` en PowerShell —
> **ojo con las comillas**, sin ellas PowerShell intenta ejecutar la URL como comando). Para un
> dispositivo **fuera de tu red**, usa la URL del túnel de Cloudflare en su lugar (§9). El valor se
> hornea en `apps/mobile/app.config.js` → `extra.apiBaseUrl` (leído por `services/api.ts`).

> **Caché de Expo al cambiar `API_BASE_URL`:** si vuelves a correr `expo start --web` con un
> `API_BASE_URL` distinto y el bundle sigue sirviendo el valor viejo, borra
> `apps/mobile/.expo/web/cache` (o usa `npm run web:fast`, que ya corre con `--clear`) — Expo cachea
> la config resuelta por archivo, no por variable de entorno.

---

## Cómo levantar el proyecto

### Opción rápida (demo del caudal, sin MySQL)

Dos terminales:

```bash
# Terminal 1 — backend de telemetría (bridge + pipeline + REST + Socket.IO) en :4000
npm run start:telemetry -w @ptap/api

# Terminal 2 — app móvil en el navegador
npm run web -w @ptap/mobile
```

Abre la web de Expo, selecciona **Montebello** y verás los dos caudales (`inletFlow1`,
`inletFlow2`) en l/s, marcados como *inferido*, con el badge en verde (**EN VIVO**). Los sitios
congelados aparecen como `unknown`.

### Arranque independiente por parte

| Qué | Comando | Notas |
|-----|---------|-------|
| **Backend telemetría** (sin BD) | `npm run start:telemetry -w @ptap/api` | Bridge + pipeline + REST + Socket.IO en `:4000`. |
| **Backend completo** (con BD) | `npm run dev:api` *(raíz)* | `tsx watch src/main.ts`. Requiere `DB_PASSWORD` en `.env`. |
| **Móvil (Expo, todo)** | `npm run dev:mobile` *(raíz)* | `expo start` (elige Android / iOS / web). |
| **Móvil (solo web)** | `npm run web` *(raíz)* | `expo start --web`. |
| **Modo simulador** (sin PLC) | `CONNECTIVITY_PROVIDER=simulator npm run start:telemetry -w @ptap/api` | Emula frames y estados del bridge. |

> **`main.ts` vs `main.telemetry.ts`:** `main.ts` monta toda la app (auth, usuarios, comandos…)
> y por eso exige MySQL. `main.telemetry.ts` monta **solo** el slice de telemetría — todo lo que
> el móvil necesita para el caudal — y no toca la base de datos. Desde Fase 4, `/api/opc/*` (con
> RBAC) solo existe en `main.ts`: `main.telemetry.ts` expone únicamente `/api/plants/*` (sin
> guards, a propósito) para poder seguir demostrándose sin MySQL.

---

## Acceso externo (Cloudflare Tunnel)

Por defecto, el backend y la web solo son alcanzables dentro de tu red local (o de tu propia
máquina). Para que **dispositivos fuera de tu red** (celular con datos móviles, otro computador en
otra red) puedan usar el proyecto, hay dos caminos:

### Túnel rápido (`trycloudflare.com`) — para probar

Gratis, sin cuenta ni dominio, pero la URL **cambia cada vez que reinicias `cloudflared`** — no
sirve para algo que varias personas usen de forma estable.

```bash
# Terminal aparte por cada servicio que quieras exponer
cloudflared tunnel --url http://localhost:4000   # backend/API
cloudflared tunnel --url http://localhost:8081   # web (opcional, si no vas a usar el .apk)
```

Cada uno imprime una URL `https://algo-al-azar.trycloudflare.com`. Luego:

1. Agrega la URL de la **web** a `CORS_ORIGINS` en `.env` (coma-separada) y reinicia el backend.
2. Pon la URL de la **API** en `APP_PUBLIC_URL` (para que el link de verificación de correo sea
   abrible desde fuera) y reinicia el backend.
3. Vuelve a levantar la web con `API_BASE_URL` = la URL del túnel de la API (no la IP LAN):
   ```powershell
   $env:API_BASE_URL = "https://<tu-tunel-api>.trycloudflare.com"
   npm run web:fast -w @ptap/mobile
   ```
4. Comparte la URL del túnel **web** — cualquiera con esa URL, desde cualquier red, puede entrar.

### Túnel con nombre (dominio propio) — para algo estable

URL fija que sobrevive reinicios. Requiere un dominio tuyo dado de alta en Cloudflare (gratis, el
dominio en sí puede costar unos pocos dólares/año si no tienes uno):

```bash
cloudflared login                                        # autoriza tu cuenta/dominio en el navegador
cloudflared tunnel create ptap                            # crea el túnel, guarda credenciales locales
cloudflared tunnel route dns ptap api.tudominio.com       # DNS para la API
cloudflared tunnel route dns ptap app.tudominio.com       # DNS para la web
```

Luego un `config.yml` (junto a las credenciales, típicamente `~/.cloudflared/config.yml`) con las
reglas de ingreso:

```yaml
tunnel: ptap
credentials-file: /ruta/a/<tunnel-id>.json
ingress:
  - hostname: api.tudominio.com
    service: http://localhost:4000
  - hostname: app.tudominio.com
    service: http://localhost:8081
  - service: http_status:404
```

Y `cloudflared tunnel run ptap` — las URLs quedan fijas para siempre, mientras el túnel esté
corriendo. `docs/ANDROID_APK.md` §7 documenta cómo reconstruir el `.apk` cuando cambia la URL del
túnel rápido; con túnel con nombre, esto **no vuelve a hacer falta**.

---

## API REST y eventos Socket.IO

Prefijo global: **`/api`** (excepto `/metrics`, fuera del prefijo por convención de Prometheus).

### Autenticación (Fase 4)

| Método · Ruta | Devuelve |
|---------------|----------|
| `POST /api/auth/login` | `{ email, password } → { token, user: AuthUser }` — mismo shape que ya espera `apps/mobile/services/auth.ts`. Rate-limit propio (`LOGIN_RATE_LIMIT_*`). **401** genérico si las credenciales son malas; **403** si son buenas pero la cuenta está pendiente/desactivada. |
| `POST /api/auth/register` | `{ name, email, phone?, plant, password } → { status: 'pending_approval', email, message }` — alta propia. **Sin token**: la cuenta nace `is_active = 0` y no puede entrar hasta que un admin la apruebe. Nace **SIEMPRE con rol `civil`**: el rol lo fija el servidor y el schema es `.strict()`, así que enviar `role` → **400**. Mismo rate-limit que login. Al registrarse se envía (o se loguea, según `EMAIL_TRANSPORT`) un enlace de verificación de correo — ver fila siguiente. Password: mín. 8 caracteres, con mayúscula+minúscula+dígito; el body de error 400 de Zod no trae un `message` legible por campo (solo `fieldErrors`), así que la app hoy solo puede mostrar "HTTP 400" genérico si algo no cumple. |
| `GET /api/auth/verify-email?token=...` | Verifica el correo (`email_verified=1` en MySQL) siguiendo el enlace enviado al registrarse. Token de un solo uso, vence en `EMAIL_VERIFICATION_TTL_HOURS` (24h default). **Precondición para poder activarse**: `PATCH /api/users/:id/active` con `isActive:true` rechaza con 400 si el correo no está verificado. |
| `POST /api/auth/resend-verification` | `{ email }` → reenvía el enlace (invalida el anterior). Respuesta genérica siempre (no revela si el correo existe). **No hay botón para esto en la app todavía** — solo se puede invocar directo (curl/Postman) si el enlace original venció o se perdió. |

> **El orden del login es la defensa:** la contraseña se verifica **antes** de mirar `is_active`. Con
> la contraseña mala siempre sale el mismo `401`, exista o no el correo — si el 403 saliera antes,
> cualquiera podría enumerar los correos registrados probando contraseñas al azar.

### Gestión de usuarios (Fase 4) — solo Administrador

La matriz oficial reserva *"Crear, editar y eliminar usuarios"* y *"Asignar roles"* al Admin:

| Método · Ruta | Permiso | Devuelve |
|---------------|---------|----------|
| `GET /api/users` | `manage_users` (admin) | Lista de usuarios (`UserSummary`, sin secretos) + `total`. Filtra en **SQL parametrizado**: `?search=` (nombre/correo/teléfono), `?role=`, `?isActive=` (`false` = pendientes). Query inválida → **400**. Paginación opcional `?page=&limit=` (`limit` máx. 100) — **sin estos dos parámetros, devuelve todo** (compatibilidad); `apps/mobile/app/(app)/usuarios.tsx` los usa con scroll infinito sobre el `FlatList`. `role`/`is_active` están indexados en MySQL (migración `0006_add_users_indexes.sql`) — el filtro por defecto de la pestaña "Pendientes" ya no hace full table scan. |
| `PATCH /api/users/:id/active` | `manage_users` (admin) | **Aprueba** (`true` sobre una cuenta nueva), activa o desactiva; audita `user.active_changed`. |
| `PATCH /api/users/:id/role` | `assign_roles` (admin) | Asigna rol; audita `user.role_changed` (quién, a quién, de→a). |

Flujo: **el usuario se registra → queda pendiente → un admin lo verifica (por eso se pide teléfono),
lo aprueba y, si corresponde, lo eleva** desde la pantalla "Usuarios" del móvil (menú ☰, solo admin;
pestaña *Pendientes*). Un admin no puede cambiar su propio rol ni desactivarse (evita perder el acceso).

> **Los cambios aplican en la siguiente petición, no al reingresar.** `JwtAuthGuard` relee al usuario
> en la base en cada petición (`UsersRepository.findById`, que filtra `is_active = 1`) y puebla
> `request.user` con **la fila, no con el payload del token**. El JWT es una credencial —prueba quién
> firmó el login—, no una autorización: desactivar una cuenta corta esa sesión en el acto y un rol
> degradado no sobrevive dentro del token. Cuesta una consulta por clave primaria por petición.

> **Por qué aprobación humana Y verificación de correo (las dos, no una u otra):** confirmar un
> correo solo prueba que alguien tiene acceso a ese buzón, y una cuenta desechable se crea en
> treinta segundos — contra cuentas fantasma no aporta nada por sí sola. Lo que frena a un impostor
> es que una persona lo reconozca. Por eso la verificación de correo (`GET /api/auth/verify-email`)
> se sumó como **filtro de ruido previo**, no como reemplazo: `PATCH /api/users/:id/active` con
> `isActive:true` exige `email_verified=1` (si no, 400) — un admin no puede aprobar por error una
> cuenta cuyo dueño ni siquiera abrió el correo. La aprobación humana sigue siendo la barrera real.

El resto de rutas (salvo `/api/health*` y `/metrics`) exige `Authorization: Bearer <token>`. El
RBAC gatea por **permiso granular** (`@RequirePermission(...)`, sobre `hasPermission()` de
`@ptap/shared`): sin token → `401`; sin el permiso requerido → `403`. Una ruta sin
`@RequirePermission` solo exige un JWT válido (cualquier rol autenticado). Los accesos —
**permitidos y denegados** — se registran en `audit_log` vía `AuditMiddleware`.

### REST (pipeline de dominio) — cualquier rol autenticado

| Método · Ruta | Devuelve |
|---------------|----------|
| `GET /api/plants` | Lista de las 16 plantas con su `liveness` y `bridgeStatus`. Las 4 en integración no tienen buffers: salen siempre `frozen`. |
| `GET /api/plants/:plantId/snapshot` | `PlantSnapshotDto` desde cache RAM (<50 ms; nunca toca el PLC). |

> **Divergencia conocida con la matriz oficial (decisión de producto pendiente):** la matriz dice
> que el **Civil** solo debe ver estado básico ("¿hay agua?"), pero hoy estas lecturas están
> abiertas a todo rol autenticado (incluido `civil`). Restringirlo requiere un endpoint de estado
> básico y tocar el móvil; se posterga a una fase de frontend.

### REST (observabilidad del puente) — solo en `main.ts` (app completa)

| Método · Ruta | Permiso | Devuelve |
|---------------|---------|----------|
| `GET /api/opc/status` | (autenticado) | Diagnóstico: bridgeStatus, notificaciones, reconexiones, heartbeat, por planta. |
| `GET /api/opc/info` | `system_config` (admin) | Metadata del servidor OPC UA. |
| `GET /api/opc/buffers` | `system_config` (admin) | Salud por buffer (NodeId resuelto o faulted). |
| `GET /api/opc/dead-letter` | `system_config` (admin) | Señales anómalas descartadas (regla 12), con contadores. |
| `GET /api/health/opc` | público | Health industrial: `plcReachable`, `bridgeStatus`, `subscriptionAlive`, contadores… `503` si `Stale`/`Faulted`. |
| `GET /metrics` | público (o `METRICS_AUTH_TOKEN`) | Métricas Prometheus: `opc_notifications_total`, `opc_bridge_status`, `opc_quality_good/bad_total`, `opc_subscription_latency_ms`, `opc_dead_letter_total`, etc. |

### REST (comandos de escritura — Fase 5) — solo en `main.ts` (app completa)

| Método · Ruta | Permiso | Devuelve |
|---------------|---------|----------|
| `POST /api/plants/:plantId/commands` | el que declare la señal writable en el mapping (p. ej. `control_valves`; el jefe NO lo tiene) | `{ command, target, idempotencyKey? } → CommandResult` (`status: confirmed\|failed\|rejected`, con `previousValue`/`writtenValue`/`confirmedValue`/`interlockSequence`). |

API de **dominio**, nunca de NodeIds: `target` es el `domainKey` de una señal `writable` del mapping,
que el WriteService traduce a buffer/bit. **Precondición dura** (regla 9): rechaza todo con
`WRITES_DISABLED_INSECURE_SESSION` si `OPCUA_WRITES_ENABLED=false` **o** la sesión OPC UA no es
autenticada+cifrada. Flujo por comando: RBAC (permiso del mapping) → interlock (`bridgeStatus`
Connected + snapshot fresco) → write → read-back con timeout → `confirmed`/`failed` (+ rollback
best-effort) → **audit log siempre** (`command.execute`, con valor previo/confirmado y `sequence`
del interlock). Idempotencia durable en MySQL (`command_log`): un `idempotencyKey` repetido no
re-ejecuta el comando. **Hoy el mapping de producción no tiene señales `writable`** (sin L5X) →
todo comando real responde `TARGET_NOT_WRITABLE`. Códigos: 200 confirmado · 502 fallido ·
401 sin token · 403 permiso/insegura · 404 target no writable · 409 interlock/en-progreso.

Migración: `npm run db:migrate -w @ptap/api` crea `command_log` (además de `users`/`audit_log`).

### Socket.IO

- Cliente emite: `opc:subscribe` `{ plantId }` → entra a la room de la planta y recibe su snapshot actual.
- Servidor emite: `opc:snapshot` (por planta, **solo en cambios**) y `opc:liveness` (broadcast, en cambios de estado).

### DTO principal (`PlantSnapshotDto`)

```jsonc
{
  "plantId": "montebello",
  "displayName": "Montebello",
  "sequence": 22,               // monótono por planta; el cliente detecta huecos
  "bridgeStatus": "Connected",
  "liveness": { "state": "live", "lastChangeAt": "…", "windowSec": 300 },
  "signals": {
    "inletFlow1": {
      "value": 14.19, "unit": "l/s", "quality": "Good",
      "usable": true, "mappingStatus": "mapped", "confidence": "inferred",
      "label": "Caudal de entrada 1", "ts": "…"   // SourceTimestamp del PLC
    }
  }
}
```

> El camino de datos legado anterior al puente (poller `ConnectivityService`, ports
> `IndustrialReader/Writer/ProtocolAdapter`, `RawFrameCache` y la ruta `GET /api/snapshots/:plantId`)
> se **eliminó** al completarse el Mapping Engine: hoy hay **un solo camino de datos vivo**.

---

## Pruebas, typecheck y scripts de mapping

```bash
# Typecheck de todos los workspaces
npm run typecheck                     # (raíz)

# Suite del backend (node:test + tsx) — 92 tests
npm test -w @ptap/api
#   subgrupos:
npm run test:bridge   -w @ptap/api    # watchdog, heartbeat, coalescer, state machine, config
npm run test:pipeline -w @ptap/api    # liveness, quality, mapping engine, cache/sequence
npm run test:mapping  -w @ptap/api    # contrato opc_mapping.json contra el schema
npm run test:auth     -w @ptap/api    # JwtAuthGuard/PermissionGuard (unit + e2e con supertest, incl. caso jefe)
npm run test:health   -w @ptap/api    # computeOpcHealth() — 503 en Stale/Faulted
npm run test:metrics  -w @ptap/api    # MetricsService expone las métricas Prometheus requeridas
npm run test:audit    -w @ptap/api    # AuditLogService, AuditMiddleware (200/401/403), eventos de conexión
npm run test:security -w @ptap/api    # conmutación real a SignAndEncrypt+username/certificate
                                       # contra un OPCUAServer local (no un mock)
npm run test:commands -w @ptap/api    # Fase 5: WriteService (precondición dura, interlock, idempotencia,
                                       # read-back), RBAC del endpoint, y schema del write spec
npm run test:users    -w @ptap/api    # registro, verificación de correo, admin de usuarios (RBAC,
                                       # aprobar/activar, cambio de rol, guard rails de auto-admin)
npm run test:reports   -w @ptap/api   # generación/listado/descarga de informes CSV
npm run test:diagnostics -w @ptap/api # prueba de ruta al PLC (route-check/route-history)

# Mapping (la semántica vive en datos, no en código)
npm run generate:mapping -w @ptap/api # regenera config/opc_mapping.json (idempotente)
npm run validate:mapping -w @ptap/api # valida schema + reglas semánticas

# Base de datos (Fase 4 — users + audit_log + command_log; el resto del dominio sigue pendiente)
# Migraciones actuales (apps/api/src/infrastructure/database/migrations/), aplicadas en orden y
# de forma idempotente por scripts/migrate.ts (tabla schema_migrations lleva el registro):
#   0001_create_users · 0002_create_audit_log · 0003_create_command_log ·
#   0004_add_users_phone · 0005_email_verification · 0006_add_users_indexes
npm run db:migrate     -w @ptap/api   # crea/actualiza las tablas si no existen (idempotente)
npm run db:seed-users  -w @ptap/api   # siembra las 4 cuentas demo (civil/operador/jefe/admin@ptap.co)
                                       # con la contraseña de SEED_USERS_PASSWORD (.env) — OBLIGATORIA,
                                       # ya no existe un default público
npm run db:seed-admin  -w @ptap/api   # siembra solo el primer admin desde SEED_ADMIN_* (.env)
npm run db:disable-demo-users -w @ptap/api  # desactiva las 4 cuentas demo antes de exponer el
                                       # backend fuera de desarrollo (reversible por PATCH .../active)
```

> **Las 4 cuentas demo usan la contraseña que definas en `SEED_USERS_PASSWORD` (.env)** — ya no hay
> un default público tipo `Demo1234!` escrito en el repo. Aun así, siguen siendo cuentas de **demo**
> conocidas por su correo (`civil@ptap.co`, `operador@ptap.co`, `jefe@ptap.co`, `admin@ptap.co`):
> antes de exponer el backend fuera de tu máquina, córtalas con `npm run db:disable-demo-users`
> (reversible al instante vía `PATCH /api/users/:id/active`).

> **Nota de tooling:** los archivos en `test/` no están en el `include` de `tsconfig.json` (por
> diseño, para no mezclarse con el `build` de `src/`), pero eso hace que `tsx`/esbuild use el
> transform de decoradores "nuevo estilo" (incompatible con los decoradores de Nest) si no se le
> indica lo contrario. Por eso todos los scripts `test*` fijan `TSX_TSCONFIG_PATH=tsconfig.test.json`
> (un tsconfig auxiliar que sí incluye `test/`) antes de invocar `node --import tsx --test`. Si
> agregas un test nuevo que declare clases con decoradores de Nest (`@Controller`, `@Injectable`…),
> ejecútalo siempre vía `npm run test:*` (nunca `node --import tsx --test` a secas) o fallará con
> `Cannot read properties of undefined (reading 'value')`.

---

## Empaquetado Android (APK)

Guía completa en `docs/ANDROID_APK.md`. Resumen de lo que hace falta y por qué:

- **Toolchain** (solo para compilar, no para desarrollar): JDK 17 y Android SDK
  (`platform-tools`, `platforms;android-36`, `build-tools`) — ver instalación en §5.
- **`apps/mobile/android/gradle.properties`** → `reactNativeArchitectures=arm64-v8a`. Se restringió
  de las 4 arquitecturas por defecto (`armeabi-v7a,arm64-v8a,x86,x86_64`) a solo `arm64-v8a`: `x86`/
  `x86_64` son **exclusivas de emulador**, ningún celular real las usa, y compilarlas de más
  multiplicaba el tiempo de build nativo (CMake/ninja) hasta 4x. Si necesitas probar en el emulador
  de Android Studio, añade `x86_64` de vuelta.
- **`compileSdkVersion`/`targetSdkVersion` = 36** en `apps/mobile/app.config.js` (plugin
  `expo-build-properties`) — subido desde 35 porque una dependencia transitiva de AndroidX
  (`androidx.core:1.18.0`) lo exige; sin esto, `assembleRelease` falla en `checkReleaseAarMetadata`.
- **Permisos del manifest acotados a `INTERNET`**: la plantilla base de Expo agrega
  `SYSTEM_ALERT_WINDOW`/`VIBRATE`/`READ_EXTERNAL_STORAGE`/`WRITE_EXTERNAL_STORAGE` "opcionales" que
  el proyecto no necesita. `android.permissions` de Expo solo **agrega** permisos, nunca quita los
  de la plantilla — hay que bloquearlos explícitamente con `android.blockedPermissions` en
  `app.config.js` (`tools:node="remove"` en el manifest final) para que el APK realmente pida
  únicamente `INTERNET`.
- **Firma de release**: keystore fuera del repo (`C:/keys/monitor-ptap-release.keystore` en esta
  máquina — nunca versionado), configurado en `apps/mobile/android/gradle.properties`
  (`MONITORPTAP_UPLOAD_*`) y `apps/mobile/android/app/build.gradle` (`signingConfigs.release`).
  **Ambos archivos se regeneran con `expo prebuild --clean`** y hay que volver a aplicar estos
  cambios manualmente después (no sobreviven al clean).
- **Windows: límite de 260 caracteres de ruta.** El build nativo (CMake/ninja) de módulos como
  `react-native-gesture-handler`/`react-native-screens` falla con `Filename longer than 260
  characters` si el repo vive en una ruta larga (`C:\Users\<user>\Documents\GitHub\monitor-ptap\...`).
  Arreglo de dos partes: (1) habilitar rutas largas de Windows (registro, requiere admin —
  `HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled=1` + `git config --system
  core.longpaths true`), y (2) acortar la carpeta de build de CMake en
  `apps/mobile/android/app/build.gradle` (`externalNativeBuild.cmake.buildStagingDirectory`, p. ej.
  `C:/cxx-ptap`) — solo el registro alcanza a bajar el total por debajo de 260, pero acortar la
  carpeta de staging da más margen.
- **API_BASE_URL horneada en el build**: la APK nativa habla HTTPS con el backend
  (`usesCleartextTraffic:false`), así que necesita una URL pública — ver
  [§9 Acceso externo](#acceso-externo-cloudflare-tunnel) para el túnel de Cloudflare que provee esa
  URL.

Comando final (con el toolchain listo y el túnel corriendo):

```powershell
$env:API_BASE_URL = "https://<tu-tunel-api>.trycloudflare.com"
cd apps/mobile
npx expo prebuild -p android --clean
# reaplicar signingConfig + reactNativeArchitectures + build cache en gradle.properties/build.gradle
cd android
.\gradlew.bat assembleRelease
# APK en: apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

---

## Optimizaciones de rendimiento aplicadas

Auditoría de "por qué se siente lento" (build, apertura de la app, panel admin) y lo que se corrigió:

| Área | Antes | Después |
|------|-------|---------|
| **Build Android** | 4 arquitecturas de CPU compiladas (2 de ellas solo útiles para emulador); sin caché de Gradle | Solo `arm64-v8a`; `org.gradle.caching`/`org.gradle.configuration-cache` activados; heap del daemon subido (2GB→3GB) |
| **Backend — compresión** | Sin gzip/brotli en ninguna respuesta | `compression()` middleware en `apps/api/src/main.ts` |
| **Backend — pool MySQL** | `connectionLimit: 10`, cola sin límite (`queueLimit` default 0 = infinita) | `connectionLimit: 20`, `queueLimit: 50` (falla rápido bajo sobrecarga en vez de acumular latencia) — `apps/api/src/infrastructure/database/database.module.ts` |
| **`GET /api/users`** | Sin `LIMIT`, devolvía toda la tabla siempre; `role`/`is_active` sin índice (full table scan en el filtro por defecto de "Pendientes") | Paginado (`?page=&limit=`, compatible sin params); índices `idx_users_role`/`idx_users_active` (migración `0006`) |
| **Polling redundante** | `hooks/useSnapshot.ts` heredaba `refetchInterval: 30_000` del `QueryClient` global aunque ya recibe todo por push de Socket.IO (`staleTime: Infinity`) | `refetchInterval: false` explícito — el socket es la única fuente de refresco |
| **Bundle web** | Un solo archivo JS con **todas** las pantallas (admin, civil, operador) sin importar el rol que entra | Expo Router **Async Routes** (`asyncRoutes: "production"` en `app.json`) — cada ruta es un chunk separado; verificado con `expo export --platform web` (18 archivos en vez de 1) |
| **Ícono de la app** | `assets/icon.png` en 393KB | Recomprimido a 210KB (paleta adaptativa 256 colores, mismo contenido visual) |
| **Reportes CSV** | Se sentían "lentos" | **No es un bug**: por diseño toman ~1h (`REPORT_SAMPLE_INTERVAL_MS` × `REPORT_SAMPLE_COUNT` = 60 muestras × 1/min). El CSV en sí es trivial; ajustable solo si aceptas menos resolución temporal. |

**Pendiente/fuera de alcance, por si se retoma:** `opc:liveness` es un `server.emit` sin room (a
diferencia de `opc:snapshot`, que sí está scoped por planta) — bajo impacto hoy (payload chico, solo
en cambios de estado), pero a revisar si crece mucho el número de plantas/usuarios simultáneos. La
arquitectura backend es single-instance por diseño (PM2 `instances:1`, fork mode) porque el puente
OPC UA y el estado de Socket.IO viven en RAM de un solo proceso — no es un bug, es una restricción
arquitectónica.

---

## Reglas de dominio y convenciones

Reglas que **nunca** se rompen (resumen):

1. **Cache solo en RAM.** El backend no persiste telemetría en MySQL (solo auth/usuarios/config).
2. **Cero números mágicos de índice** en el código: toda semántica vive en `opc_mapping.json`.
3. El OPC UA Adapter **no conoce la PTAP**: solo endpoints, NodeIds y buffers.
4. El frontend **nunca recibe arrays crudos**: solo DTOs de dominio.
5. El simulador **no se elimina**: es el testbed permanente.
6. **Un MonitoredItem por buffer** (nodo array completo), nunca uno por elemento.
7. **SourceTimestamp del PLC**, nunca `Date.now()` para datos de proceso.
8. **Toda la config OPC sale de `.env`**: cero valores quemados.
9. **Escritura al PLC prohibida** hasta Fase 5 (feature flag + sesión segura).
10. Cada dato lleva `value`, `quality`, `usable`, `mappingStatus`, `confidence` y `sourceTimestamp`.
    Un `inferred` **no** se presenta igual que un `confirmed`.
11. Estado del bridge = máquina de estados explícita, con transiciones registradas.
12. **Nada se pierde en silencio**: lo anómalo va al DeadLetter (consultable por endpoint admin).

**Identidad de planta:** el `plantId` (slug canónico) es la única identidad en todo el sistema
(los 16 slugs: `voragine, soledad, montebello, cascajal, km18, alto-los-mangos, campoalegre,
pichinde, carbonero, sirena, san-antonio, quijote, cabuyo, luisa, leonera, gloria`; las 4 últimas
están en integración, sin señales). Nada de `PTAP Norte` ni `ptap-1`.

---

## Guía para nuevos desarrolladores

- **Entender el puente:** empieza por `apps/api/src/infrastructure/connectivity/` — es el corazón.
  Los adaptadores (`adapters/`) hablan OPC UA; el `pipeline/` transforma buffers en DTOs.
- **Añadir una pantalla móvil:** crea una ruta en `apps/mobile/app/(app)/`.
- **Consumir datos en el móvil:** usa `hooks/useSnapshot.ts` (REST + Socket.IO ya integrados).
- **Mapear una señal nueva:** edítala en `apps/api/scripts/generate-mapping.ts`
  (`SIGNALS_BY_SITE`) y corre `npm run generate:mapping`. **Nunca** edites `opc_mapping.json` a mano.
- **Tipos/roles/permisos compartidos:** agrégalos en `packages/shared/src/index.ts` e impórtalos
  desde `@ptap/shared` en ambos lados.
- **Config nueva del PLC:** añádela en `connectivity.config.ts` leyéndola de `.env` (regla 8).
- **Endpoint nuevo que requiera auth:** `@UseGuards(JwtAuthGuard, PermissionGuard)` +
  `@RequirePermission('<permiso>')` (de `@ptap/shared`), e importa `AuthModule` en el módulo del controller
  (guards resueltos vía DI, no globales — así `main.telemetry.ts` sigue sin requerir MySQL).

---

## Documentación de referencia

**Empieza aquí:** [`docs/SETUP.md`](docs/SETUP.md) si acabas de clonar ·
[`docs/PENDIENTES.md`](docs/PENDIENTES.md) si quieres saber qué falta.

### Puesta en marcha y operación

| Documento | Contenido |
|-----------|-----------|
| [`docs/SETUP.md`](docs/SETUP.md) | Puesta en marcha desde cero (MySQL, `.env`, migraciones, usuarios de prueba), con verificación en cada paso y tabla de errores típicos. Sirve para personas y para agentes. |
| [`docs/RUNBOOK_PRODUCCION.md`](docs/RUNBOOK_PRODUCCION.md) | **Despliegue y operación**: lo que está montado hoy en la VM (§1–10) y cómo montarlo desde cero en un servidor nuevo (§11: PM2, nginx, certbot — sin Docker). |
| [`docs/REQUISITOS_SERVIDOR.md`](docs/REQUISITOS_SERVIDOR.md) | Requisitos para aprovisionar la máquina (SO, hardware, software, puertos, accesos). |
| [`docs/CHECKLIST_PRODUCCION.md`](docs/CHECKLIST_PRODUCCION.md) | Endurecimiento antes de exponer: variables de entorno, cuentas demo, seguridad. |
| [`docs/ANDROID_APK.md`](docs/ANDROID_APK.md) | Compilar el `.apk`: toolchain, keystore de firma, checklist de seguridad y qué hacer cuando cambia la URL. Ver también [§12](#empaquetado-android-apk). |
| [`docs/DOMINIO_AQUORA_CLOUDFLARE.md`](docs/DOMINIO_AQUORA_CLOUDFLARE.md) | Dominio `aquora.xpertic.co` y TLS: el camino de Cloudflare y por qué se acabó yendo por Let's Encrypt. |
| [`docs/dns/`](docs/dns/) | Zonas BIND para importar en Cloudflare (excluyentes entre sí — leer su README). |

### Estado, pendientes e incidentes

| Documento | Contenido |
|-----------|-----------|
| [`docs/PENDIENTES.md`](docs/PENDIENTES.md) | **Único tracker de pendientes**: bloqueado por infraestructura, pendiente de desplegar, decisiones del cliente y deuda técnica. |
| [`docs/INCIDENTE_CONEXION_PLC.md`](docs/INCIDENTE_CONEXION_PLC.md) | Incidente **abierto**: pérdida de acceso al PLC maestro. |
| [`docs/OPERATIONAL_VALIDATION.md`](docs/OPERATIONAL_VALIDATION.md) | Fase 6 **completa**: caos, carga, latencia, replay y el soak de 24 h (crecimiento de RSS 0 %). |
| [`docs/PLAN_CONSOLA_ADMIN_1.4.0.md`](docs/PLAN_CONSOLA_ADMIN_1.4.0.md) | **Plan de implementación de la 1.4.0**: revisión por planta, ayuda, tutorial, modo desarrollador y novedades. Cinco fases para ejecutar de una en una. |
| [`docs/CATALOGO_ERRORES.md`](docs/CATALOGO_ERRORES.md) | Catálogo de códigos de error: código → archivo → causa → responsable. |
| [`docs/archivo/`](docs/archivo/) | **Evidencia histórica congelada** (auditorías fechadas, pruebas de campo). No refleja el estado actual — leer su README. |

### Seguridad

| Documento | Contenido |
|-----------|-----------|
| [`docs/SECURITY_FINDING_P0.md`](docs/SECURITY_FINDING_P0.md) | Hallazgo P0 **abierto**: el servidor OPC UA del PLC acepta Anonymous + SecurityPolicy None. Es la razón de que la escritura exija `OPCUA_ALLOW_INSECURE_WRITES`. |
| [`docs/SEGURIDAD_FRONTEND.md`](docs/SEGURIDAD_FRONTEND.md) | Postura de seguridad del frontend/móvil. |
| [`docs/OPTIX_CLIENT_CERT_TRUST.md`](docs/OPTIX_CLIENT_CERT_TRUST.md) | Confiar el certificado de cliente del gateway en FactoryTalk Optix (y el del servidor, en el gateway). |

### El PLC: contrato, señales y evidencia

| Documento | Contenido |
|-----------|-----------|
| [`docs/DATA_CATALOG.md`](docs/DATA_CATALOG.md) | Catálogo de señales por planta. **Generado** desde el mapping — no editar a mano. |
| [`docs/plc/OBSERVACIONES_FASE0.md`](docs/plc/OBSERVACIONES_FASE0.md) | Las cuatro observaciones de solo lectura contra el PLC real, como una sola investigación: verificación del contrato, por qué DN/ER/TO **no** sirven como estado de conexión, cómo se llegó al modelo de frescura de 3 estados, y la validación del caudal de Montebello. |
| [`docs/plc/`](docs/plc/) | Los 10 entregables de la ingeniería inversa OPC UA (`tools/plc-discovery`). |
| [`docs/PROTOCOLO_VALVULAS_VORAGINE.md`](docs/PROTOCOLO_VALVULAS_VORAGINE.md) | Protocolo de comando y estado de válvulas (semántica de bits). |

### Contratos y arquitectura

| Documento | Contenido |
|-----------|-----------|
| [`docs/architecture/`](docs/architecture/) | Arquitectura del backend + métodos y contratos internos. |
| [`docs/api/openapi.yaml`](docs/api/openapi.yaml), [`docs/postman/`](docs/postman/) | Contrato HTTP completo, con el permiso de cada ruta. |
| [`docs/integration/frontend-integration.md`](docs/integration/frontend-integration.md) | Guía de integración frontend ↔ backend. |
