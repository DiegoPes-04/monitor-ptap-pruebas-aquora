# Checklist de producción — traslado al servidor real

Qué revisar/ajustar para pasar el backend del entorno de desarrollo (simulador, cuentas demo) al
**servidor real** con el **PLC real**. La receta de instalación en el VPS está en
[RUNBOOK_PRODUCCION.md §11](RUNBOOK_PRODUCCION.md); esto es el **endurecimiento** de configuración y datos.

---

## 1. Datos simulados: qué se queda y qué se marca

| Elemento | Estado | Acción |
|---|---|---|
| **Simulador del backend** (`SimulatorBridgeAdapter`) | **Se QUEDA** | Es el arnés de pruebas + modo dev sin PLC (lo usan ~6 tests y `connectivity.module` lo importa en compilación). En prod **no se elige** (`CONNECTIVITY_PROVIDER=opcua`) y ni se instancia. Borrarlo rompe el build y los tests. |
| **Mocks del móvil** | **Ya NO existen** | `mock-data.ts` y `ExampleDataBanner` fueron eliminados. Válvulas (`services/valves.ts`) y Reportes (`services/reports.ts`) hablan con el backend real. En el móvil no queda ningún dato de ejemplo. |
| **Cuentas demo** (`civil@/operador@/jefe@/admin@ptap.co`, `Demo1234!`) | **Se CORTAN** | `npm run db:disable-demo-users -w @ptap/api` antes de exponer. Sembrar un admin real con `db:seed-admin`. |

> El simulador no es "dato falso que estorba": es infraestructura de test. Producción elige el
> adaptador OPC UA; el simulador queda inerte. Es el patrón correcto (dos adaptadores, un puerto).

---

## 2. Variables de entorno para producción (`.env`)

| Variable | Valor en producción | Por qué |
|---|---|---|
| `CONNECTIVITY_PROVIDER` | **`opcua`** | Usar el PLC real, no el simulador |
| `OPC_ENDPOINT` | `opc.tcp://10.10.51.225:59100` | Endpoint del PLC por la IP **interna**, vía VPN/red OT. Desde el 2026-09-21: la planta cerró el path público `181.204.165.66:59200` (vigente 2026-08-19 → 2026-09-21) y no se pedirá reabrirlo — ver [SECURITY_FINDING_P0.md](SECURITY_FINDING_P0.md) |
| `OPCUA_WRITES_ENABLED` | **`true`** (autorizado 2026-08-03) | Canal de escritura ABIERTO por decisión de Operación. Requiere también `OPCUA_ALLOW_INSECURE_WRITES=true` porque el PLC solo admite Anonymous+None (ver §3) |
| `SOCKET_AUTH_REQUIRED` | **sin definir / ≠ false** | El gateway exige JWT. **Nunca** `false` en prod |
| `LOG_LEVEL` | `info` | El log por snapshot ya está en `debug`; en `info` no aparece |
| `CORS_ORIGINS` | `https://aquora.xpertic.co` | Solo el origen real (aplica también al WebSocket) |
| `APP_PUBLIC_URL` | `https://aquora.xpertic.co` | Base de los enlaces de verificación de correo |
| `METRICS_AUTH_TOKEN` | **un token** | Protege `/metrics` (abierto por defecto). Ver §3 |
| `JWT_SECRET`, `PASSWORD_PEPPER_V1_BASE64` | secretos nuevos (64 bytes el pepper) | Nunca los de ejemplo del repo |
| `DB_*` | credenciales del MySQL real | — |
| `EMAIL_TRANSPORT` | `console` (o `smtp` con `SMTP_*`) | Verificación de correo; SMTP real cuando se defina |

---

## 3. Endurecimiento de seguridad

- [ ] **`/metrics` protegido:** define `METRICS_AUTH_TOKEN`. Sin él, el endpoint Prometheus queda
      **abierto** (expone métricas operativas). El guard ya existe (`metrics-auth.guard.ts`, SRV-05);
      solo hay que darle el token.
- [ ] **Cuentas demo desactivadas** (`db:disable-demo-users`) y admin real sembrado.
- [ ] **Arranque solo por `main.ts`** (nunca `start:telemetry` en prod: ese entrypoint desactiva la
      auth del socket y no tiene BD/RBAC).
- [ ] **HTTPS de punta a punta** (nginx + certbot); el Node solo en `127.0.0.1:4000`.
- [ ] **Handshake del socket** exige JWT (SRV-04) — verificado por el default de `SOCKET_AUTH_REQUIRED`.
- [ ] **Rate-limit** activo (login/registro/reenvío) — por defecto ya lo está.
- [ ] **Escritura al PLC ABIERTA y auditada.** Autorizada por Operación el 2026-08-03. Como el
      servidor OPC UA del equipo solo admite Anonymous + None ([SECURITY_FINDING_P0.md](SECURITY_FINDING_P0.md)),
      exige `OPCUA_ALLOW_INSECURE_WRITES=true`: la sesión va **sin cifrar y sin autenticar**, y la
      protección real pasa a ser la red, más el RBAC, el interlock y la doble confirmación de la app.
      Se activa/revierte con `opcua-writes-toggle.sh [--revertir]`. Protocolo de bits en
      [PROTOCOLO_VALVULAS_VORAGINE.md](PROTOCOLO_VALVULAS_VORAGINE.md).

---

## 4. Arranque y base de datos

- [ ] `npm ci` **en el servidor** (no copiar `node_modules`; `argon2` es nativo).
- [ ] `npm run build` (compila `@ptap/shared` → dist y el API → `dist/main.js`).
- [ ] `npm run db:migrate -w @ptap/api` (crea/actualiza tablas; idempotente).
- [ ] `db:seed-admin` con credenciales reales; `db:disable-demo-users`.
- [ ] **Arrancar con PM2**: `cd apps/api && pm2 start ecosystem.config.js` (corre `node dist/main.js`).
      `pm2 save && pm2 startup` para reinicio en reboot.

---

## 5. Red (el punto que decide si hay datos)

- [ ] **La VM alcanza el PLC** por OPC UA (`nc -vz 10.10.51.225 59100`). El acceso es por la red OT:
      la VM (`192.168.30.x`) necesita ruta a `10.10.51.0/24` — verificar con `ip route get 10.10.51.225`.
      El path público está cerrado desde el 2026-09-21 (ver [INCIDENTE_CONEXION_PLC.md](INCIDENTE_CONEXION_PLC.md)).
      Sin esa ruta, la telemetría sale "sin datos" aunque todo lo demás esté OK.
- [ ] Puertos entrantes 80/443; salientes a GitHub/npm/PLC.

---

## 6. Verificación post-despliegue

- [ ] `curl https://aquora.xpertic.co/api/health` → 200
- [ ] `curl https://aquora.xpertic.co/api/health/db` → 200 (MySQL conectado)
- [ ] `curl https://aquora.xpertic.co/api/health/opc` → 200 si el puente está `Connected`; 503 si
      no alcanza el PLC (señal correcta para el monitoreo)
- [ ] Login por HTTPS devuelve JWT; el WebSocket conecta (datos en vivo del PLC real en el tablero)
- [ ] `/metrics` responde 401 sin el token y 200 con él
- [ ] Válvulas y Reportes muestran datos reales del backend (ya no existe ningún banner de ejemplo)

---

## 7. Deuda conocida (no bloquea el despliegue, sí conviene)

- **Válvulas:** el canal real ya está cableado en las 12 plantas y probado en campo. Lo que falta es
  externo: no existe el verbo `close` en el mapping de varias plantas (`UNKNOWN_COMMAND`) y falta el
  actuador físico en otras, así que el read-back devuelve `READBACK_UNCONFIRMED` — correcto, no un
  fallo del canal.
- **Correo:** para envío real, `EMAIL_TRANSPORT=smtp` + `SMTP_*` en el `.env` (ya implementado con
  nodemailer; sin credenciales cae a `console`).
- **Informes:** el directorio `REPORTS_DIR` debe ser escribible y con espacio; opcional
  `REPORTS_AUTO_PLANT` para sembrar el ciclo de 7 días de una planta al arrancar.
- **Retención de auditoría:** `AUDIT_RETENTION_DAYS` (90) y `ROUTE_PROBE_RETENTION_DAYS` (2) — limpieza
  diaria automática para que `audit_log` no crezca sin fin.

> **Ya resuelto:** el build de producción (`npm run build`) compila `@ptap/shared` a JS, así que se
> arranca con `node dist/main.js` bajo PM2 (ecosystem.config.js) — sin el workaround de `tsx`.
