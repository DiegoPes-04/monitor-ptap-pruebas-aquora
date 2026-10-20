# Puesta en marcha local — Monitor PTAP

Guía para levantar el proyecto desde cero tras clonar. Sirve igual para una persona que para un
agente de IA: cada paso trae su **verificación**, y si una falla hay que resolverla antes de seguir
— no encadenes pasos sobre una base rota.

> **Por qué no funciona "solo con clonar":** el archivo `.env` **no se sube a git** (está en
> `.gitignore`, y así debe ser: lleva contraseñas). El clon llega sin él, y la app completa exige
> `DB_PASSWORD`, `JWT_SECRET` y un pepper para arrancar → muere en el primer arranque. Además, la
> base de datos se **crea sola** pero las **tablas no**: hay que migrarlas.

---

## 0. Contexto mínimo (léelo antes de ejecutar)

Monorepo npm workspaces: `apps/api` (backend NestJS), `apps/mobile` (Expo), `packages/shared`.

**Hay DOS arranques distintos y confundirlos es la causa #1 de problemas:**

| Arranque | Comando | ¿MySQL? | ¿Login? |
|---|---|---|---|
| Telemetría (demo) | `npm run start:telemetry -w @ptap/api` | **No** | **No** — no monta `/api/auth/login` ni los guards |
| App completa | `npm run dev:api` | **Sí** | **Sí** — auth, roles, usuarios, comandos |

**La telemetría no se persiste**: MySQL solo guarda usuarios, auditoría y comandos. No busques
tablas de sensores — no existen ni deben existir. Es una regla de diseño (caché en RAM,
snapshot < 50 ms).

### Reglas duras (no las rompas)

1. **Genera secretos NUEVOS para esta máquina.** No reutilices los de otro equipo ni los pongas en
   ningún archivo versionado.
2. **Nunca hagas commit de** `.env`, `apps/api/pki/` (llaves privadas OPC UA) ni `node_modules/`.
   Si `git status` muestra decenas de miles de archivos, el `.gitignore` está roto → **para y
   arréglalo** antes de tocar git (ver §8).
3. **No inventes datos de planta.** Si algo no está mapeado, se queda `unmapped`.

---

## 1. Requisitos previos

```bash
node --version     # debe ser >= 20 (probado en 24)
npm --version
git --version
```

**MySQL** es necesario solo para la app completa. Comprueba que corre y **anota en qué puerto**:

```bash
# Windows
Get-Service | Where-Object { $_.Name -like "*mysql*" }
netstat -ano | findstr "LISTENING" | findstr ":3306 :3307"
# Linux/macOS
systemctl status mysql   # o:  brew services list
```

> ⚠️ Puede haber **más de una instancia** de MySQL en la máquina (p. ej. 3306 y 3300) con
> contraseñas distintas. Confirma cuál usarás **y en qué puerto** antes de seguir. Este error costó
> horas en el equipo original.

**Verificación:** Node ≥ 20 y un servicio MySQL activo con puerto conocido.

---

## 2. Dependencias

```bash
npm install      # desde la RAÍZ del monorepo (instala los 3 workspaces)
```

**Verificación:** `npm run typecheck` termina sin errores en los tres workspaces. Si falla por
módulos faltantes, `npm install` no terminó bien.

---

## 3. Atajo: demo rápida SIN base de datos

Si solo quieres ver datos en pantalla, esto es todo lo que hace falta. No necesita MySQL.

```bash
cp .env.example .env
# Asegúrate de que en .env esté:  CONNECTIVITY_PROVIDER=simulator
npm run start:telemetry -w @ptap/api    # backend de telemetría (sin BD) en :4000
npm run web -w @ptap/mobile             # en otra terminal
```

> Sin `CONNECTIVITY_PROVIDER=simulator`, el backend intenta conectarse al PLC real, que
> probablemente no sea alcanzable desde tu red → el puente quedará reintentando. El proceso arranca
> igual, pero no verás datos.

**No hay login en este modo.** Para auth, roles y comandos sigue con los pasos 4–7.

---

## 4. Crear la base de datos y un usuario de aplicación

La app **no debe correr como `root`**. Genera una contraseña dedicada:

```bash
node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"
```

Ejecuta este SQL **como administrador de MySQL**, sustituyendo `<PASSWORD_APP>`:

```sql
CREATE DATABASE IF NOT EXISTS monitor_ptap
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'ptap_app'@'localhost'   IDENTIFIED BY '<PASSWORD_APP>';
CREATE USER IF NOT EXISTS 'ptap_app'@'127.0.0.1'   IDENTIFIED BY '<PASSWORD_APP>';

GRANT ALL PRIVILEGES ON monitor_ptap.* TO 'ptap_app'@'localhost';
GRANT ALL PRIVILEGES ON monitor_ptap.* TO 'ptap_app'@'127.0.0.1';
FLUSH PRIVILEGES;
```

> **Si no tienes la contraseña de root**, NO intentes adivinarla ni saltarte la autenticación: pide
> a un humano que ejecute ese SQL, o que resetee root con el procedimiento oficial de MySQL
> (`--init-file`), que requiere permisos de administrador del sistema.

**Verificación:**
```bash
node -e "require('mysql2/promise').createConnection({host:'127.0.0.1',port:3306,user:'ptap_app',password:'<PASSWORD_APP>',database:'monitor_ptap'}).then(()=>console.log('CONEXION OK')).catch(e=>console.log('FALLO:',e.code))"
```

---

## 5. Crear el `.env` (raíz del monorepo)

Genera **secretos propios de esta máquina**:

```bash
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log('PASSWORD_PEPPER_V1_BASE64=' + require('crypto').randomBytes(64).toString('base64'))"
```

Crea `.env` en la raíz partiendo de `.env.example`. Mínimo funcional:

```dotenv
PORT=4000

# ── MySQL (del paso 4) ──
DB_HOST=127.0.0.1
DB_PORT=3306                      # ajusta si tu MySQL usa otro puerto
DB_USER=ptap_app
DB_PASSWORD=<PASSWORD_APP>
DB_NAME=monitor_ptap

# ── Puente OPC UA: simulador (sin PLC real) ──
CONNECTIVITY_PROVIDER=simulator

# ── Seguridad (GENERADOS ARRIBA, propios de esta máquina) ──
PASSWORD_PEPPER_CURRENT_VERSION=1
PASSWORD_PEPPER_V1_BASE64=<pepper generado>
JWT_SECRET=<jwt secret generado>
JWT_EXPIRES_IN=8h

# ── CORS: OBLIGATORIO para la app web (NO lo omitas) ──
CORS_ORIGINS=http://localhost:8081

# ── Usuarios de prueba (paso 6) ──
# OBLIGATORIA para sembrar (ya no hay default). Valor de ejemplo, SOLO para entorno local.
SEED_USERS_PASSWORD=Demo1234!
```

Reglas de este archivo:

- `PASSWORD_PEPPER_V1_BASE64` debe decodificar a **exactamente 64 bytes** (el comando de arriba lo
  garantiza). Si no, el login truena.
- **No cambies el pepper después de sembrar usuarios**: sus contraseñas dejarían de validar. Cada
  desarrollador puede tener los suyos; lo único que importa es que el pepper con el que se
  **siembra** sea el mismo con el que luego se **verifica**.
- Sin comillas raras ni espacios sueltos tras el `=`. Entre comillas dobles si la contraseña
  contiene `@` o `#`.
- **`CORS_ORIGINS` no es opcional si vas a usar la web.** Expo corre en `:8081` y llama al backend
  en `:4000`: es cross-origin, y sin esta variable el **navegador** bloquea el login. El síntoma
  engaña — `curl` funciona perfecto (no aplica CORS), así que parece que el backend está bien y que
  las credenciales están mal. Si el backend arranca sin ella, deja este aviso en el log:
  `CORS deshabilitado (CORS_ORIGINS vacío)`.

**Verificación:**
```bash
node -e "require('dotenv').config({path:'.env'});const p=process.env.PASSWORD_PEPPER_V1_BASE64||'';console.log('pepper bytes:',Buffer.from(p,'base64').length,'(debe ser 64) | JWT_SECRET:',(process.env.JWT_SECRET||'').length>0)"
```

---

## 6. Tablas y usuarios

```bash
npm run db:migrate    -w @ptap/api    # crea users, audit_log, command_log (idempotente)
npm run db:seed-users -w @ptap/api    # un usuario por rol (idempotente)
# (alternativa) solo el primer admin, desde SEED_ADMIN_* del .env:
npm run db:seed-admin -w @ptap/api
```

`db:migrate` crea la base `monitor_ptap` si no existe y aplica las migraciones pendientes. Sin este
paso la BD existe pero **vacía** → el login y cualquier ruta que toque `users` fallan con "table
doesn't exist".

Cuentas sembradas, todas con la contraseña de `SEED_USERS_PASSWORD` (obligatoria — sin ella el
script aborta; ya no existe el default público, que estaba escrito en el repo):

| Email | Rol | Qué puede hacer |
|---|---|---|
| `civil@ptap.co` | civil | Vista básica (solo consulta) |
| `operador@ptap.co` | operador | Datos + control (incl. válvulas) |
| `jefe@ptap.co` | jefe | Todo lo del operador **salvo** abrir/cerrar válvulas |
| `admin@ptap.co` | admin | Control total + pantalla Usuarios |

> Estas cuentas se siembran **ya aprobadas** (`is_active = 1`): son la semilla del sistema, no pasan
> por el auto-registro. Antes de exponer el backend fuera de desarrollo, córtalas con
> `npm run db:disable-demo-users -w @ptap/api` (reversible vía `PATCH /api/users/:id/active`).

**Verificación:** `db:migrate` imprime las migraciones aplicadas y `db:seed-users` los 4 usuarios.
Si `db:migrate` da `Access denied`, la credencial del `.env` no coincide con la del paso 4.

---

## 7. Arrancar

Dos procesos, en terminales distintas:

```bash
npm run dev:api                  # backend COMPLETO. Espera "Nest application successfully started"
npm run web -w @ptap/mobile      # app web (Expo) en http://localhost:8081
```

Evidencia esperada en consola: `Conexión MySQL establecida (127.0.0.1:3306/monitor_ptap)` y
`Nest application successfully started`.

> Si solo levantas la app y no el backend, **el login fallará siempre**. Es el error más común.

**Verificación por API, antes de abrir el navegador:**
```bash
curl -s -o /dev/null -w "health: %{http_code}\n" http://localhost:4000/api/health
curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@ptap.co","password":"Demo1234!"}'
```
Debe devolver `{ token, user: { role: "admin", ... } }`. Si devuelve 401 con esas credenciales,
revisa el pepper (§5) y que `db:seed-users` haya corrido.

---

## 8. Verificación final (criterios de aceptación)

El montaje está bien **solo si estos 5 pasan**:

```bash
npm run typecheck                      # 1. limpio en los 3 workspaces
npm test -w @ptap/api                  # 2. 235/235 tests en verde
npm run validate:mapping -w @ptap/api  # 3. "opc_mapping.json válido (16 plantas)"
```
4. `POST /api/auth/login` con `admin@ptap.co` devuelve un JWT (§7).
5. En `http://localhost:8081`: entrar como `civil@ptap.co` cae en *Estado*; como `admin@ptap.co`
   aparece **Usuarios** en el menú ☰. Recargar la página mantiene la sesión.

> El paso 5 hay que hacerlo **en el navegador**, no con `curl`: es el único que detecta que falta
> `CORS_ORIGINS`. Con curl todo parece correcto aunque la web esté rota.

Prueba de que el RBAC es real, no cosmético:
```bash
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"civil@ptap.co","password":"Demo1234!"}' | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
curl -s -o /dev/null -w "civil -> /api/opc/info: %{http_code} (debe ser 403)\n" -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/opc/info
curl -s -o /dev/null -w "sin token -> /api/plants: %{http_code} (debe ser 401)\n" http://localhost:4000/api/plants
```

Comprobación de seguridad antes de tocar git (debe decir que están ignorados):
```bash
git check-ignore -v .env node_modules apps/api/pki
```

---

## Alta de usuarios, aprobación y asignación de roles

Según la **matriz oficial de permisos**, *"Crear, editar y eliminar usuarios"* y *"Asignar roles"*
son atribuciones **exclusivas del Administrador**. El flujo implementado:

1. **Cualquiera se registra** desde la app (`POST /api/auth/register`). El alta **no da acceso**: la
   cuenta nace con `is_active = 0` y la respuesta **no trae token**.
2. **Nace siempre con rol `civil`**. El rol lo fija el **servidor**: la pantalla no tiene selector y
   el schema es `.strict()`, así que mandar `role` en el body devuelve **400**. Nadie puede
   auto-asignarse un rol.
3. **Mientras espera, el login responde 403** con "pendiente de aprobación" — pero solo si la
   contraseña es correcta (ver el recuadro de abajo).
4. **Un administrador la aprueba**: menú ☰ → **Usuarios** → pestaña **Pendientes**, verifica a la
   persona (para eso el registro pide teléfono), pulsa **Aprobar** y le asigna el rol. Por API son
   `PATCH /api/users/:id/active` y `.../role`.
5. **Cada cambio queda auditado** en `audit_log` (`user.active_changed`, `user.role_changed`) con
   quién lo hizo, a quién, y de qué → a qué.

| Método · Ruta | Permiso | Para qué |
|---|---|---|
| `POST /api/auth/register` | público | Alta propia → `civil` + **pendiente**, sin token |
| `GET /api/users` | `manage_users` (admin) | Listar/buscar (`?search=`, `?role=`, `?isActive=`) |
| `PATCH /api/users/:id/active` | `manage_users` (admin) | **Aprobar** / activar / desactivar |
| `PATCH /api/users/:id/role` | `assign_roles` (admin) | Asignar rol |

### Por qué aprobación humana y no verificación por correo

Confirmar un correo solo prueba que alguien tiene acceso a ese buzón — y una cuenta desechable se
crea en treinta segundos. Contra cuentas falsas no aporta nada. Lo que sí frena a un impostor es que
**una persona lo reconozca** antes de dejarlo entrar: por eso el registro pide teléfono y la decisión
la toma un admin. La verificación por correo se puede **sumar** como filtro previo, pero no sustituye
a la aprobación.

> **Sobre los mensajes del login (es a propósito):** con la contraseña **incorrecta** el servidor
> responde siempre `401 Credenciales inválidas`, sea la cuenta inexistente, pendiente o activa. Solo
> **después** de verificar la contraseña admite que la cuenta existe pero está pendiente (`403`). Si
> lo dijera antes, cualquiera podría averiguar qué correos están registrados probando contraseñas al
> azar.

> **Los cambios aplican en la siguiente petición**, no cuando el usuario vuelve a entrar: el guard
> relee su fila en la base en cada petición, así que desactivar una cuenta corta esa sesión en el
> acto y un rol degradado no sobrevive dentro del token. Un admin **no puede** cambiar su propio rol
> ni desactivarse (evita quedarse fuera del sistema).

> **Buscar entre los registrados:** `GET /api/users?search=ana&role=civil&isActive=false`. `search`
> es coincidencia parcial contra **nombre, correo o teléfono**; `isActive=false` es la bandeja de
> pendientes. El filtro se resuelve en **SQL parametrizado**: el navegador nunca recibe los datos
> personales que el filtro excluye.

---

## Errores típicos y su causa real

| Síntoma | Causa real | Solución |
|---|---|---|
| `Falta la variable de entorno DB_PASSWORD` | No hay `.env` o está vacío | §5 |
| `JWT_SECRET` / pepper undefined al arrancar o loguear | Faltan esos secretos en `.env` | §5 |
| `Access denied for user ...` | Credencial/puerto del `.env` ≠ MySQL real. **Ojo con dos instancias** | §1 y §4 |
| Arranca pero el login da error de tabla | No se corrió `db:migrate` | §6 |
| Login dice "Credenciales inválidas" | **Casi siempre el backend no está corriendo**, no la contraseña | `npm run dev:api` |
| **El login falla SOLO en el navegador, pero `curl` funciona** | **Falta `CORS_ORIGINS`** → el navegador bloquea la petición. La consola del navegador dirá `blocked by CORS policy` | `CORS_ORIGINS=http://localhost:8081` y reinicia la API (§5) |
| Login dice "pendiente de aprobación" (403) | No es un fallo: **toda cuenta registrada desde la app nace pendiente**. La contraseña era correcta | Entra como admin → Usuarios → Pendientes → Aprobar |
| `ECONNREFUSED` / no conecta a MySQL | MySQL apagado, puerto o credenciales distintos | Encender MySQL; alinear `DB_PORT`/`DB_PASSWORD` |
| `EADDRINUSE :4000` / `:8081` | Quedó un proceso node vivo | Mata el proceso que ocupa el puerto |
| `Cannot find module ...` | `node_modules` viejo o incompleto | `npm install` en la raíz |
| El puente queda `Disconnected` reintentando | `CONNECTIVITY_PROVIDER=opcua` sin red al PLC | Pon `simulator` |
| TS se queja de una ruta de `expo-router` | Los tipos de rutas se autogeneran | Arranca `npm run web` una vez (regenera `.expo/types`) |
| **`git status` muestra ~56.000 archivos** | **`.gitignore` vacío/roto → `node_modules` sin ignorar** | `git checkout HEAD -- .gitignore`. **Verifica que `.env` y `pki/` estén ignorados ANTES de cualquier commit** |

---

## Qué NO es un fallo (no lo "arregles")

- **Todas las señales salen `confidence: inferred`.** Es correcto: falta el export L5X del PLC. Solo
  se marca `confirmed` con documentación oficial.
- **`san-antonio` y `quijote` sin señales propias.** Sus tanques llegan retransmitidos vía Soledad;
  pendiente de rectificar con el operador.
- **`cabuyo`, `luisa`, `leonera` y `gloria` sin señales y siempre en `frozen`.** Están en
  integración: dadas de alta en el mapping sin buffers hasta que el integrador las suba al PLC
  maestro (ficha en `docs/plc/PLANTAS_NUEVAS_CABUYO_LUISA_LEONERA_GLORIA.md`). No les llega ningún
  dato, y eso es lo que muestran.
- **Con el simulador, los comandos de válvula responden contra un almacén en RAM**, no contra un
  PLC. Es el testbed permanente y así debe ser.
- **`READBACK_UNCONFIRMED` en producción no es un fallo del canal**: hoy falta el actuador físico en
  varias plantas, así que el pulso se escribe pero el estado no cambia. El código lo reporta
  honestamente en vez de mentir "confirmado".
- **El registro solo crea cuentas `civil`.** El rol lo fija el servidor; mandar `role` en el body
  devuelve 400.

---

## Qué es real y qué está simulado

- La **base de datos es MySQL real**; solo guarda `users`, `audit_log` y `command_log`. La
  **telemetría nunca se persiste** — vive en RAM por diseño.
- El **puente OPC UA** puede ser real (`CONNECTIVITY_PROVIDER=opcua`) o **simulado** (`simulator`,
  datos sintéticos para trabajar sin PLC).
- En el móvil **todo el camino de datos es real**: login JWT contra el backend (el rol sale de la
  base), sensores, tanques, válvulas y reportes. La sesión persiste entre reinicios
  (secure-store / localStorage) y un 401 la limpia sola.

---

## Dónde seguir leyendo

| Documento | Para qué |
|---|---|
| [`README.md`](../README.md) | Estado de fases, arquitectura, endpoints, reglas de dominio |
| [`architecture/`](./architecture/) | Diseño del backend y contratos internos |
| [`api/openapi.yaml`](./api/openapi.yaml) | Contrato HTTP completo, con el permiso de cada ruta |
| [`DATA_CATALOG.md`](./DATA_CATALOG.md) | Qué señal existe en cada planta y cómo tratarla |
| [`SECURITY_FINDING_P0.md`](./SECURITY_FINDING_P0.md) | Hallazgo de seguridad abierto del servidor de la planta |
| [`PENDIENTES.md`](./PENDIENTES.md) | Todo lo que falta, en un solo sitio |
| [`RUNBOOK_PRODUCCION.md`](./RUNBOOK_PRODUCCION.md) | Despliegue y operación en la VM |
