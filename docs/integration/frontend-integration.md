# Guía de integración Frontend ↔ Backend — Monitor PTAP

> **Documento de referencia oficial** para el desarrollador Frontend (humano o IA).
> Generado el 2026-07-10 tras validar el backend contra MySQL y auditar `apps/mobile`.
> Contrato de API formal: [`docs/api/openapi.yaml`](../api/openapi.yaml) · Colección Postman: [`docs/postman/monitor-ptap.postman_collection.json`](../postman/monitor-ptap.postman_collection.json)

---

## 1. Arquitectura del backend

- **NestJS 12 + TypeScript** sobre Express, monorepo npm workspaces (`apps/api`).
- Módulos de dominio en `apps/api/src/modules/` (health, auth, users, plants, snapshots, telemetry, alarms, commands, reports — los cinco últimos son placeholders vacíos).
- Infraestructura en `apps/api/src/infrastructure/`:
  - `connectivity/` — arquitectura de puertos (reader/writer/protocol-adapter). Hoy el adapter es un **simulador** (`connectionStatus: 'mock'`); OPC UA real entrará por el mismo puerto sin cambiar el contrato HTTP.
  - `database/` — pool MySQL (`mysql2/promise`), crea la BD `monitor_ptap` al arrancar si no existe. **Sin tablas de dominio todavía.**
- Tiempo real: **Socket.IO** (gateway en `connectivity.gateway.ts`).
- Tipos compartidos FE/BE: **`@ptap/shared`** (`packages/shared/src/index.ts`) — fuente de verdad del contrato de datos.

## 2. Cómo iniciar el backend

```powershell
# desde la raíz del monorepo
npm ci
npm run dev:api        # tsx watch, puerto 4000
# o compilado:
npm run build -w @ptap/api ; node apps/api/dist/main.js
```

Evidencia esperada en consola: `Conexión MySQL establecida (127.0.0.1:3300/monitor_ptap)` y `Nest application successfully started`. **La app no arranca si MySQL está caído (fail-fast deliberado).**

Frontend web + backend juntos: `node scripts/combined-proxy.js` (puerto 8080 → `/api` y `/socket.io` al 4000, resto al 3000).

## 3. Variables de entorno

Archivo `.env` en la **raíz del monorepo** (plantilla: `.env.example`; el `.env` real está git-ignorado):

| Variable | Ejemplo | Notas |
|---|---|---|
| `PORT` | `4000` | Puerto HTTP del backend |
| `DB_HOST` | `127.0.0.1` | |
| `DB_PORT` | `3300` | ⚠️ En la máquina actual MySQL 9.7 escucha en **3300**; el 3306 lo ocupa otra instancia (MySQL 8.4) con otra contraseña |
| `DB_USER` | `root` | |
| `DB_PASSWORD` | *(secreto)* | Entre comillas dobles si contiene `@` o `#` |
| `DB_NAME` | `monitor_ptap` | Se crea sola al arrancar |
| `PASSWORD_PEPPER_CURRENT_VERSION` | `1` | Para Argon2id (aún sin endpoints que lo usen) |
| `PASSWORD_PEPPER_V1_BASE64` | *(64 bytes base64)* | Generar: `node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"` |

## 4–5. Tecnologías y estructura

Backend: NestJS 12, socket.io 4, mysql2, dotenv, argon2, rxjs. Frontend: Expo SDK 58 (expo-router), React Query v5, nativewind, expo-secure-store. Estructura completa en `docs/architecture/backend-structure.md`.

## 6. Flujo de autenticación — estado real

**No existe autenticación en el backend todavía.** Solo está `PasswordHashingService` (Argon2id + pepper), sin controller ni JWT ni guards. El login/registro del frontend (`apps/mobile/services/api.ts` → `apiLogin`/`apiRegister`) es **100 % mock local**: genera un token falso `ptap-jwt-<timestamp>` y fabrica el rol a partir del prefijo del email. Cuando el backend implemente auth real, el contrato previsto es `POST /api/auth/login → { token, user: AuthUser }` y `POST /api/auth/register`; el frontend guarda el token en `expo-secure-store` (nativo) / `localStorage` (web) con claves `ptap_auth_token` / `ptap_auth_user`.

## 7–13. Endpoints disponibles (contrato completo en openapi.yaml)

| Método | Ruta | Respuesta 200 | Errores |
|---|---|---|---|
| GET | `/api/health` | `{status:'ok', service:'ptap-api', sharedRoles:4}` | — |
| GET | `/api/health/db` | `{status:'ok', database:'monitor_ptap', latencyMs:n}` | 503 si MySQL cae |
| GET | `/api/plants` | `PlantDefinition[]` (8 plantas, `ptap-1`…`ptap-8`) | — |
| GET | `/api/snapshots/:plantId` | `OpcSnapshot` | 404 si el id no existe |

Socket.IO: `ws://localhost:4000` — emitir `opc:subscribe {plantId}` ⇒ recibir `opc:snapshot` (inmediato + cada 5 s). Sin parámetros de query, sin paginación (no aplican todavía). DTOs = interfaces de `@ptap/shared` (`OpcSnapshot`, `Sensor`, `Tank`, `Valve`, `PlantDefinition`).

## 14–15. Validaciones y manejo de errores

**No hay `ValidationPipe` global ni DTOs con class-validator** (no hay endpoints con body). Errores: formato estándar NestJS `{statusCode, message}`; el filtro global convierte excepciones no controladas en 500. `/api/health/db` usa `ServiceUnavailableException` (503) con payload propio.

## 16–18. Convenciones

- **Nombres:** camelCase en JSON; ids de planta `ptap-N`; eventos socket con prefijo `opc:`.
- **Fechas:** ISO-8601 UTC (`timestamp` de snapshot: `new Date().toISOString()`).
- **IDs:** strings legibles (`ptap-1`, `tank-1`, `pressure`) — no UUIDs ni numéricos, hasta que exista BD de dominio.

## 19–21. Paginación, filtrado, ordenamiento

**No implementados.** Las colecciones actuales son pequeñas (8 plantas, 4 sensores, 4 tanques). Cuando existan endpoints con tablas reales (alarmas, auditoría), definir el estándar aquí antes de implementarlo.

## 22–23. Ejemplos de consumo

```ts
// REST (patrón actual del frontend con React Query)
const res = await fetch(`${API_BASE}/snapshots/${encodeURIComponent(plantId)}`);
if (!res.ok) throw new Error(`Request failed: ${res.status}`);
const snapshot: OpcSnapshot = await res.json();

// Socket.IO (aún NO cableado en el móvil; requiere npm i socket.io-client -w @ptap/mobile)
const socket = io(API_ORIGIN);           // ws://host:4000
socket.emit('opc:subscribe', { plantId: 'ptap-1' });
socket.on('opc:snapshot', (s: OpcSnapshot | null) => { /* actualizar UI */ });
```

Respuesta real de `/api/snapshots/ptap-1` (verificada 2026-07-10): `plantId='ptap-1'`, `connectionStatus='mock'`, 4 sensores (`pressure`, `flow`, `ph`, `turbidity`), 4 tanques, sin `valves`.

## 24–28. Qué debe (y no debe) tocar el desarrollador Frontend

**Modificar cuando llegue la integración:**
1. `apps/mobile/services/api.ts` — el **único** archivo donde viven baseURL, wrapper fetch y mocks:
   - `API_BASE = '/api'` es **ruta relativa**: funciona solo en web detrás del proxy 8080. Para nativo, mover a `EXPO_PUBLIC_API_URL` (URL absoluta al host del backend).
   - `apiLogin`/`apiRegister` → cablear a los endpoints reales de auth cuando existan.
   - `fetchReports` → hoy retorna `[]` fijo; esperar contrato real.
   - Añadir header `Authorization: Bearer <token>` al wrapper `api()` cuando haya guards.
2. `apps/mobile/context/AuthContext.tsx` — sin cambios de estructura; el `AuthUser` pasará a venir del backend.
3. Pantalla `estado.tsx` — usa `user.plant` (un **nombre**, p.ej. "PTAP Norte") como id de snapshot: **bug latente**; debe usar el `id` (`ptap-N`) como el resto de pantallas.

**NO modificar:** `packages/shared` sin acordarlo con backend (es el contrato); los queryKeys/estructura de React Query salvo para consolidar (ver riesgos); el flujo de navegación por roles.

**Cómo reemplazar los mocks sin romper la app:** los datos de sensores/tanques/válvulas **ya consumen la API real** — no hay nada que migrar ahí. Solo auth y reportes son mocks, y están aislados en `services/api.ts`: se sustituye el cuerpo de `apiLogin`/`apiRegister`/`fetchReports` por fetch reales manteniendo las firmas, y el resto de la app no se entera.

## 29. Riesgos de integración

1. **URL relativa en nativo** — iOS/Android no resuelven `/api`; sin URL absoluta la app móvil no puede llamar al backend (bloqueante).
2. **Token no viaja** — el wrapper no envía `Authorization`; el día que el backend proteja rutas, todas las pantallas de datos recibirán 401 y hoy eso se ve como **pantalla vacía silenciosa** (no se renderiza `isError`).
3. **`estado.tsx` con nombre en vez de id** → 404/vacío para el rol `civil`.
4. **Triple fetch del mismo snapshot** (queryKeys `['sensores']`, `['valves']`, `['tanks']`) — ineficiencia; consolidar en un `useSnapshot` único.
5. **`connectionStatus` ignorado + LiveBadge estático** — el usuario no distingue datos reales de simulados/obsoletos. En una PTAP esto es un riesgo operativo, no cosmético.
6. **Toggle de válvulas optimista local** — no existe endpoint de comando; el override se pierde en cada refetch (30 s). No prometer control real en UI hasta que exista `commands`.
7. **El proxy combinado no maneja upgrade WebSocket** — `scripts/combined-proxy.js` usa `http.request` plano; Socket.IO a través del 8080 quedaría limitado a long-polling.

## 30. Recomendaciones para la migración (orden sugerido)

1. Parametrizar baseURL (`EXPO_PUBLIC_API_URL`) manteniendo `/api` como fallback web.
2. Corregir `estado.tsx` (id vs nombre) — 1 línea, elimina un bug latente.
3. Consolidar los 3 hooks de snapshot en uno.
4. Mostrar `connectionStatus` real (y quitar el "LIVE" fijo).
5. Cuando exista auth backend: inyectar token en el wrapper + manejar 401 globalmente (logout).
6. Considerar `socket.io-client` para reemplazar el polling de 30 s (el gateway ya funciona y emite cada 5 s).

---

## Anexo — Informe de compatibilidad Frontend ↔ Backend (Fase 5)

| Aspecto | Frontend espera | Backend ofrece | Estado |
|---|---|---|---|
| `GET /api/plants` | `{id, name}[]` | `PlantDefinition[]` | ✅ Compatible |
| `GET /api/snapshots/:plantId` | `OpcSnapshot` (usa `.sensors/.tanks/.valves`) | `OpcSnapshot` completo | ✅ Compatible (frontend ignora `connectionStatus`/`timestamp`) |
| `valves` en snapshot | array (con `?? []`) | El simulador **no lo emite** | ⚠️ Pantalla electroválvulas siempre vacía |
| `POST /api/auth/login` | `{token, user: AuthUser}` | **No existe** | ❌ Faltante (mock en FE) |
| `POST /api/auth/register` | confirmación | **No existe** | ❌ Faltante (mock en FE) |
| `GET /api/reports/...` | `Report[]` (tipo local del FE, no está en shared) | **No existe** | ❌ Faltante (mock `[]`) |
| Comando de válvula | *(no llama a nada — estado local)* | **No existe** | ❌ Faltante en ambos |
| Socket.IO `opc:subscribe`/`opc:snapshot` | *(no lo usa; polling 30 s)* | ✅ Implementado (5 s) | ⚠️ Capacidad desaprovechada |
| Header `Authorization` | No lo envía | No lo exige | ✅ Hoy; ❌ cuando haya guards |
| Códigos de error | Solo distingue `ok`/no-ok | 404/500/503 estándar NestJS | ⚠️ FE no renderiza errores |
| Identificador de planta | `id` (salvo `estado.tsx`: nombre) | `id` (`ptap-N`) | ⚠️ Bug en `estado.tsx` |
