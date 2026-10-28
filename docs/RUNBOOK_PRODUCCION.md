# Runbook de Producción — Monitor PTAP

Documento **único** de despliegue y operación: lo que está montado hoy (§1–§10) y cómo montarlo
desde cero en un servidor nuevo (§11). Absorbe el antiguo `DEPLOY_VPS.md`.

> ⚠️ **Este documento NO contiene secretos.** Contraseñas, tokens, `JWT_SECRET`, pepper y
> credenciales viven SOLO en el `.env` de la VM y en la copia local `.env.production.local`
> (gitignored). Aquí solo se referencia *dónde* están.

> **Dominio de producción: `aquora.xpertic.co`.** El antiguo `ptaps.telcobras.com` quedó descartado
> y no debe usarse en configuración nueva. Trabajo pendiente sobre el dominio y el TLS:
> [`PENDIENTES.md §1`](./PENDIENTES.md).

---

## 1. Topología

Backend + web + base de datos corren en **una VM interna** (`192.168.30.50`, Ubuntu 24.04, 2 vCPU,
47 GB disco). El cliente **nunca** habla con MySQL: siempre pasa por la API.

> 🧠 **La RAM es dinámica (Hyper-V `hv_balloon`), no fija.** En reposo `free` reporta ~2,2 GB; bajo
> carga el hipervisor concede hasta ~7 GB. Los dos valores son correctos, cada uno en su momento —
> conviene saberlo antes de dimensionar nada por lo que muestre `free` en un instante suelto.
> Hay además 2,2 GB de swap.

```
Usuario (móvil/navegador)
   │  HTTPS
   ▼
aquora.xpertic.co ──► 191.102.61.125 ──[NAT 1:1]──► 192.168.30.50
                                                        │
                                                  nginx :80/:443
                                                        │
                          ┌─────────────────────────────┼─────────────────────┐
                          ▼                             ▼                     ▼
                    web SPA (estático)          /api → Node :4000      /descargar/ (APK)
                                                        │
                                                MySQL 127.0.0.1:3306
                                                        │
                             PLC (OPC UA, red de planta) ◄─┘
```

- **Acceso público**: `https://aquora.xpertic.co`, TLS de Let's Encrypt servido por nginx. La sede
  publica la VM con **NAT 1:1 contra `191.102.61.125`** (desde 2026-08-11; antes era un DNAT por
  puerto contra `.123`). El quick tunnel de Cloudflare que se usaba como stopgap **está apagado**.
- **Acceso de operador**: red interna `192.168.30.0/24` vía **VPN L2TP** (perfil Windows `PTAP-VPN`,
  sin PSK) + **SSH por llave** (alias `ptap`, `~/.ssh/id_ed25519`; password deshabilitado). Con la
  NAT 1:1, el SSH también responde en `xpertic_app@191.102.61.125` — útil cuando la VPN se cae.

> 🔒 **La NAT 1:1 cambió el perímetro.** Antes solo se publicaba un puerto concreto; ahora **toda la
> VM está en Internet salvo lo que ufw filtre**, o sea que el firewall pasó de segunda barrera a
> **única** barrera. Verificado desde fuera el 2026-08-11: 443 y 22 abiertos (SSH a propósito,
> solo-llave + fail2ban); **3306, 4000 y 8080 cerrados**. Cualquier cambio en ufw ahora tiene
> consecuencia directa en Internet — revisar `ufw status` antes y después de tocarlo.

## 2. Servicios en la VM

| Servicio | Qué hace | Notas |
|---|---|---|
| **nginx** (:80/:443) | Reverse proxy: web SPA en `/`, API en `/api/`, WebSocket en `/socket.io/`, APK en `/descargar/` | Config en `/etc/nginx/sites-available/ptap`. Cabeceras de seguridad + cache (index no-cache, chunks immutable). 🔴 El snippet `ptap-hmi.conf` quedó obsoleto al retirar el HMI (2026-08-11) pero **sigue incluido y sigue funcionando**: hace `proxy_pass https://10.10.51.225/` (el WinCC Unified de la planta, vivo) y `https://aquora.xpertic.co/hmi/` responde **200 desde Internet sin autenticación alguna**. Retirarlo — ver [`PENDIENTES.md §4`](./PENDIENTES.md) |
| **pm2 → `ptap-api`** | Backend NestJS (`node dist/main.js`) | Arranca en cada reboot (`pm2 startup` systemd), `pm2 save` |
| **MySQL 8** (`ptapapp`) | BD (users, audit_log, command_log, tokens) | Escucha **solo localhost** (`bind-address 127.0.0.1`) |
| ~~**cloudflared**~~ | *(apagado el 2026-08-11)* | Fue el stopgap mientras no había dominio. El binario y `cf-run.sh` siguen en la VM por si hiciera falta un acceso de emergencia |
| **fail2ban** | Anti fuerza-bruta SSH | Activo, jail `sshd` |

## 3. Código y configuración

- Repo en la VM: `~/monitor-ptap`, rama **`dev`**. El servidor solo hace lectura/pull.
- **`.env`** en la raíz del repo EN la VM (`chmod 600`). Copia local durable del operador:
  `.env.production.local` (gitignored). Variables (SIN valores aquí): `PORT`,
  `DB_HOST/PORT/USER/PASSWORD/NAME`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `PASSWORD_PEPPER_*`,
  `APP_PUBLIC_URL`, `CORS_ORIGINS`, `CONNECTIVITY_PROVIDER`, `OPC_ENDPOINT`, `METRICS_AUTH_TOKEN`,
  `EMAIL_TRANSPORT`, `REGISTER_BLOCK_DISPOSABLE`, `RATE_LIMIT_*`, `REQUIRE_EMAIL_VERIFICATION`
  (default off). Los secretos de producción son **frescos**, distintos de los de desarrollo.
- **Web** (SPA Expo) compilada con `API_BASE_URL=` **vacío (mismo origen)** → sirve por cualquier
  hostname sin recompilar. Estáticos en `/var/www/ptap-web`.

## 4. Base de datos y backups

- Migrar/sembrar (paso de despliegue, no runtime): `npm run db:migrate -w @ptap/api` y
  `npm run db:seed-admin -w @ptap/api`.
- **Backups**: `mysqldump` diario por cron (`0 3 * * *`), script `~/deploy-scripts/db-backup.sh`
  (usa `~/.ptapdb.cnf`, `--no-tablespaces`, gzip, **retención 14 días**) → `~/backups/`.
  **Pendiente**: copia OFF-site (hoy los dumps viven en la misma VM).
- **Revisar la BD desde el PC** sin abrir MySQL a la red: túnel SSH `ssh -L 3307:localhost:3306 ptap`
  y conectar un cliente a `127.0.0.1:3307` (user `ptapapp`).
- Los admins **no** se degradan desde la app (regla de "intocables") → gestión por BD/seed.
- ⚠️ **Excepción de La Sirena — NO "corregir".** `jefe.ptap.sirena@gmail.com` se llama
  **JEFE PTAP SIRENA** pero tiene rol **`operador`**, y es deliberado (2026-08-14): en esa planta
  no habrá operarios, así que el jefe asume ambas funciones. Su cuenta de operario se eliminó.
  > La clave para entenderlo: en la matriz, **`jefe` es un subconjunto de `operador`**. Comparten
  > los cinco permisos y el operador añade `control_valves`. Es decir, "jefe + operador combinados"
  > NO necesita un rol nuevo: es exactamente el conjunto de `operador`.
  >
  > Se descartó crear un rol propio (p. ej. `jefe_operador`) porque `ROLE_LABELS` viaja COMPILADO
  > en el front: en la APK y la web publicadas el rol saldría **en blanco** hasta reconstruir ambas.
  > Cuando el front se pueda desplegar, un rol dedicado sería solo cosmético — la capacidad ya es
  > la correcta.
  >
  > La excepción es **por cuenta, no por planta**: nada en el código la ata a Sirena. Si a otro
  > usuario de Sirena se le pone `jefe`, ese no podrá accionar válvulas.

## 5. Seguridad (endurecimiento aplicado)

- **Cleartext de Internet CERRADO**: `ufw` permite el **puerto 80 solo desde rangos privados**
  (10/8, 172.16/12, 192.168/16) + loopback → LAN/VPN y el túnel funcionan, pero las IPs públicas se
  dropean. (El router hace DNAT sin SNAT → preserva la IP de origen.) Regla en
  `~/deploy-scripts/ufw-restrict80.sh`. ufw solo abre 22/80/443.
- **SSH** solo-llave (`PasswordAuthentication no`, `PermitRootLogin no`) + **fail2ban**.
- **MySQL** solo localhost. **`/metrics`** protegido con `METRICS_AUTH_TOKEN`.
- **App**: RBAC por rol (`packages/shared`), guards por endpoint y por pantalla; registro anti-bot
  (allowlist de nombre, honeypot, bloqueo de correos desechables, doble campo correo/contraseña,
  celular 10 dígitos, contraseña con símbolo); `trust proxy` para rate-limit correcto tras el proxy;
  aprobación **manual** del admin como muro anti-bot.
- **Ámbito por planta en los TRES canales** (2026-08-13). `PlantScopeGuard` solo cubre rutas con
  `:plantId`, así que había dos huecos: la bandeja de notificaciones (`cd1dcd6`) y el gateway
  Socket.IO (`93a52de`), donde `opc:subscribe` aceptaba **cualquier** planta y bastaba una cuenta
  autenticada para leer la telemetría en vivo de las doce. `opc:liveness` dejó de ser broadcast
  global. Regla única en todos: `view_all_plants` (Admin) ve todo, el resto solo su planta.
  > ⚠️ En el socket el ámbito sale del **token**, no de la base: el módulo es DB-free a propósito.
  > Si un admin cambia la planta o el rol de alguien, su socket ya abierto conserva el ámbito viejo
  > hasta que reconecte (máx. 8 h, la vida del JWT). Por HTTP el cambio es inmediato.
- **Escritura al PLC**: el canal está **abierto** desde el 2026-08-03, autorizado por Operación, con
  `OPCUA_ALLOW_INSECURE_WRITES=true` — obligado porque el servidor OPC UA del equipo solo admite
  Anonymous + None (ver [`SECURITY_FINDING_P0.md`](./SECURITY_FINDING_P0.md)). La protección real es
  la red, más el RBAC, el interlock y la doble confirmación de la app. Se activa y revierte con
  `bash ~/deploy-scripts/opcua-writes-toggle.sh [--revertir]` (idempotente, con respaldo).
- **Sin secretos en git** ni en el APK; `.env` gitignored.

## 6. Exposición pública

**`https://aquora.xpertic.co`**, con TLS de Let's Encrypt servido directamente por nginx. La sede
publica la VM con **NAT 1:1 contra `191.102.61.125`**, sin traducción de puertos.

Verificado desde fuera de la red el 2026-08-11: `/` y `/api/health` responden **200** con
certificado válido.

- **Certificado**: emitido para `aquora.xpertic.co`, válido **31-jul-2026 → 29-oct-2026**, en
  `/etc/ssl/ptap/`.
- 🔴 **La renovación NO es automática todavía**, por dos motivos que hay que resolver ambos:
  el **puerto 80 sigue cerrado desde Internet** (sin él no hay desafío HTTP-01), y el `certbot.timer`
  del sistema corre como root sobre `/etc/letsencrypt`, mientras que este certificado vive en
  `~/letsencrypt/config` por haberse emitido sin sudo. Ver [`PENDIENTES.md`](./PENDIENTES.md).

### Historial: el quick tunnel de Cloudflare (apagado)

Mientras no hubo dominio se usó un quick tunnel efímero (`cf-run.sh`), que daba una URL
`*.trycloudflare.com` distinta en cada arranque. **Se apagó el 2026-08-11** y su origen se retiró de
`CORS_ORIGINS`.

> ✅ **Resuelto el 2026-08-11.** El APK anterior llevaba horneada la URL del túnel y dejó de
> conectar; se recompiló contra `https://aquora.xpertic.co` y **ya está publicado** en
> `/var/www/ptap-download/monitor-ptap.apk` (35 503 027 B, firma `fac61745…` idéntica a la del APK
> instalado, así que se instala encima sin desinstalar). Con dominio estable, fue la última
> recompilación motivada por un cambio de URL. Ver [`ANDROID_APK.md`](./ANDROID_APK.md).
>
> Nota: ese APK se compiló **antes** del retiro del HMI (commit `622ecaf`), así que todavía muestra
> esa pestaña y falla al tocarla. Pendiente cosmético en [`PENDIENTES.md §1`](./PENDIENTES.md).

> El camino del **named tunnel** de Cloudflare queda descartado, no pendiente: se había planteado
> porque solo había un puerto publicado, y la NAT 1:1 eliminó ese problema.

## 7. Actualizar el sistema (flujo normal)

> **La VM sigue la rama `yosh`**, no `dev`. (Verificado desplegando el 2026-08-05; la versión
> anterior de este runbook decía `dev` y ese push no habría llegado al servidor.)

1. Desarrollo local en `yosh` → `git push origin yosh` (cuenta **LorJosh**, token *classic* con
   scope `repo`).
2. En la VM: `bash ~/deploy.sh` (hace `fetch` + `pull --ff-only` + `npm ci` + migraciones + build +
   `pm2 restart`).
   > 🔴 **Si el commit ELIMINA archivos fuente, antes hay que borrar `dist/` a mano.** `deploy.sh`
   > no lo hace y `tsc` **no borra las salidas de fuentes que ya no existen**. El huérfano deja la
   > API en el peor estado posible: proceso vivo, `pm2` diciendo `online`, **sin escuchar el 4000 y
   > sin un solo log**. Pasó el 2026-08-11 al retirar el HMI (~10 min de caída). Ver **SRV-08** en
   > [`CATALOGO_ERRORES.md`](./CATALOGO_ERRORES.md).
   > ```bash
   > pm2 stop ptap-api
   > rm -rf ~/monitor-ptap/apps/api/dist ~/monitor-ptap/packages/shared/dist
   > cd ~/monitor-ptap && npm run build && pm2 start ptap-api
   > ```
3. Si cambió el **front**: recompilar y publicar la web
   ```bash
   cd ~/monitor-ptap/apps/mobile && API_BASE_URL= npx expo export -p web --clear
   sudo bash ~/deploy-scripts/web-publish.sh
   ```

> ⚠️ **Publicar con `web-publish.sh`, nunca con `web-setup.sh`.** El segundo termina copiando
> `~/ptap-web.nginx` sobre `/etc/nginx/sites-available/ptap`, o sea que **borra los server blocks de
> HTTPS** si ya se corrió `le-nginx.sh`, y el dominio vuelve a HTTP sin avisar. `web-publish.sh`
> solo copia estáticos, respalda la versión anterior en `/var/www/ptap-web.bak-<fecha>` y recarga.

> ⚠️ **Desplegar SIEMPRE por git.** El 2026-08-05 la VM tenía 15 archivos rastreados modificados sin
> commitear, por haberse actualizado copiando archivos a mano; su HEAD llevaba 5 días desfasado del
> código que realmente corría. Hubo que verificar archivo por archivo que la divergencia fuera
> cosmética antes de poder actualizar.

> 🔴 **`pm2 restart --update-env` tumba la API. No usarlo.** pm2 reemplaza el entorno del proceso por
> el del shell que invoca el comando; desde SSH no interactivo ese entorno es mínimo y la API
> **arranca pero nunca escucha en el 4000** — nginx devuelve 502 y `pm2 list` la sigue reportando
> `online`. Un `pm2 restart ptap-api` a secas es lo correcto.

## 8. Verificación tras desplegar

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/api/health      # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/api/health/db   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/api/health/opc  # 200
pm2 status                                                                      # online, estable
npm run -w @ptap/api audit:efficiency                                           # Score 🟢
```

## 9. Scripts operativos (en la VM, `~/deploy-scripts/`)

`deploy.sh` (actualizar backend), `db-backup.sh` (backup diario), `web-setup.sh` (publicar web +
recargar nginx), `cf-run.sh` (túnel de emergencia, normalmente apagado), `ufw-restrict80.sh`
(restringe el 80 a rangos privados — **hoy es justo lo que impide renovar el certificado**, ver §6),
`opcua-writes-toggle.sh` (abrir/cerrar el canal de escritura), `le-cert-user.sh` / `le-nginx.sh` /
`le-renew.sh` (Let's Encrypt), `env-dominio.sh` (CORS y URL pública), y los de build de APK.

## 10. Distribución móvil

- **Android (APK)**: construido EN la VM y alojado para descarga — ver
  [`ANDROID_APK.md`](./ANDROID_APK.md) → "Build en la VM". Enlace: `https://<host>/descargar/`.
- **iOS: FUERA DE ALCANCE por ahora.** Apple no permite instalar por descarga directa como Android.
  Requeriría **Apple Developer Program ($99/año)** + firma + **TestFlight** o **Ad Hoc** (UDID de
  cada iPhone, máx. 100), y **compilar en macOS/Xcode o en EAS Build** — no se puede en
  Windows/Linux. Es la **misma** app Expo (`ios.bundleIdentifier = com.ptap.monitor`), no una app
  nueva. **Alternativa inmediata**: la web en Safari, con "Añadir a pantalla de inicio" como PWA.

---

## 11. Montar desde cero en un servidor nuevo

Procedimiento para una VM/VPS Linux limpia. Absorbe el antiguo `DEPLOY_VPS.md`.

### 11.1 Requisitos

| Componente | Requisito | Por qué |
|---|---|---|
| **OS** | Linux 64-bit **glibc** (Ubuntu 22.04/24.04 LTS o Debian 12). **No Alpine/musl** | Los binarios *prebuilt* de `argon2` son para glibc |
| **Node.js** | **26.12.1** | Versión exacta del proyecto en `.nvmrc` |
| **npm** | 9+ (viene con Node) | El repo usa workspaces |
| **git** | cualquiera | clonar el repo |
| **build-essential + python3** | red de seguridad | por si `argon2` no encuentra su *prebuilt* y compila |
| **PM2** | gestor de proceso | mantener vivo el backend, reiniciar en caída/reboot, logs |
| **nginx** + **certbot** | reverse proxy + TLS | HTTPS 443 → 127.0.0.1:4000 **con WebSocket** |
| **MySQL 8** | local o gestionado | si es gestionado, solo hacen falta credenciales |

**Hardware:** mínimo 1 vCPU · 1 GB RAM · 10 GB SSD. Recomendado 2 vCPU · 2 GB RAM · 20 GB SSD
(`node-opcua` + `node_modules` pesan; deja aire para logs).

> ⚠️ **No copies `node_modules` desde Windows.** `argon2` es nativo y se resuelve por plataforma:
> instala en el servidor con `npm ci`.

### 11.2 Prerrequisitos (una vez)

```bash
# Node 22 vía nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22 && nvm use 22 && nvm alias default 22
node -v            # v22.x

sudo apt-get update
sudo apt-get install -y git build-essential python3 nginx
sudo snap install --classic certbot || sudo apt-get install -y certbot python3-certbot-nginx
npm install -g pm2
```

### 11.3 Código, `.env` y base de datos

```bash
cd ~ && git clone <URL-del-repo> monitor-ptap && cd monitor-ptap
npm ci                                  # instala todos los workspaces (incluye tsx)

node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log('PASSWORD_PEPPER_V1_BASE64=' + require('crypto').randomBytes(64).toString('base64'))"
nano .env
```

`.env` mínimo (el pepper debe decodificar a **exactamente 64 bytes**):

```dotenv
PORT=4000

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=ptapapp
DB_PASSWORD=<contraseña>
DB_NAME=monitor_ptap

JWT_SECRET=<...>
PASSWORD_PEPPER_CURRENT_VERSION=1
PASSWORD_PEPPER_V1_BASE64=<...>
JWT_EXPIRES_IN=8h

APP_PUBLIC_URL=https://aquora.xpertic.co
CORS_ORIGINS=https://aquora.xpertic.co,http://192.168.30.50

CONNECTIVITY_PROVIDER=opcua
OPC_ENDPOINT=opc.tcp://10.10.51.225:59100     # 2026-09-21: vuelta a la interna tras cerrar la planta
                                              # el path público (181.204.165.66:59200, 08-19 → 09-21).
                                              # Requiere ruta 192.168.30.x → 10.10.51.0/24.
OPC_SECURITY_MODE=None
OPC_SECURITY_POLICY=None
OPC_IDENTITY=anonymous

EMAIL_TRANSPORT=console
EMAIL_FROM=Monitor PTAP <no-reply@telcobras.com>
REGISTER_BLOCK_DISPOSABLE=true
METRICS_AUTH_TOKEN=<...>
```

> Conservar `http://192.168.30.50` en `CORS_ORIGINS` para no perder el acceso por LAN/VPN si el
> dominio falla. El gateway de Socket.IO valida `Origin` exacto: si no coincide, el tablero se queda
> sin datos en vivo aunque el HTTP funcione.

```bash
npm run db:migrate -w @ptap/api        # crea las tablas (idempotente)

SEED_ADMIN_EMAIL=admin@telcobras.com \
SEED_ADMIN_PASSWORD='<contraseña-fuerte>' \
SEED_ADMIN_NAME='Administrador' \
SEED_ADMIN_PLANT=voragine \
  npm run db:seed-admin -w @ptap/api
```

### 11.4 Compilar y arrancar con PM2

```bash
cd ~/monitor-ptap
npm run build                    # @ptap/shared → dist, luego el API → dist/main.js

cd apps/api
pm2 start ecosystem.config.js    # node dist/main.js, nombre ptap-api
pm2 save
pm2 startup                      # ejecuta la línea que imprime (reinicio en reboot)
pm2 logs ptap-api
```

> El build de producción resuelve `@ptap/shared` a su JS compilado (`packages/shared/dist`), por eso
> arranca con `node dist/main.js`. En desarrollo se usa `npm run dev:api` (tsx), que resuelve el
> paquete desde su source sin compilar.

Verificación local, antes de nginx:

```bash
curl -s http://127.0.0.1:4000/api/health         # {"status":"ok",...}
curl -s http://127.0.0.1:4000/api/health/db      # {"status":"ok",...}
```

### 11.5 nginx + HTTPS (con WebSocket)

`/etc/nginx/sites-available/ptap`:

```nginx
server {
    listen 80;
    server_name aquora.xpertic.co;

    # Cabeceras de seguridad. `always` para que se envíen también en respuestas de error.
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        # WebSocket (Socket.IO) — imprescindible para la telemetría en vivo:
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

> nginx **no hereda** `add_header` en un `location` que define los suyos. Si añades un bloque con
> `add_header` propio, repite ahí las cabeceras de seguridad.

```bash
sudo ln -s /etc/nginx/sites-available/ptap /etc/nginx/sites-enabled/ptap
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d aquora.xpertic.co
curl -s https://aquora.xpertic.co/api/health     # 200
```

### 11.6 Red y puertos — caveat crítico

- **Inbound:** **443** (HTTPS) y **80** (redirección + renovación de certbot). El Node escucha
  **solo en `127.0.0.1:4000`**, nunca expuesto directo.
- **Outbound:** npm (443) durante `npm ci`; **el PLC por OPC UA** (p. ej. `59100/tcp`); SMTP si se
  activa el correo real.

> 🔴 **El backend DEBE poder alcanzar el PLC.** Hoy el PLC está tras NAT/túnel — ver
> [`INCIDENTE_CONEXION_PLC.md`](./INCIDENTE_CONEXION_PLC.md). **Sin resolver esa ruta (VPN / túnel /
> apertura controlada), la telemetría NO llega aunque el servidor quede perfecto.** Es una decisión
> de red aparte del montaje.

### 11.7 Endurecer y checklist de éxito

Reaplicar el hardening de §5 (ufw, SSH solo-llave, fail2ban, MySQL en localhost, backups).

- [ ] `node -v` = 22.x
- [ ] `pm2 status` → `ptap-api` **online**
- [ ] `curl https://aquora.xpertic.co/api/health` → 200
- [ ] `curl https://aquora.xpertic.co/api/health/db` → 200
- [ ] Login por HTTPS devuelve un JWT
- [ ] La app muestra datos en vivo (WebSocket OK)
- [ ] El backend alcanza el PLC (§11.6) — si no, telemetría "sin datos" pese a todo lo demás OK

---

## 12. Pendientes conocidos

Se llevan en un solo sitio: [`PENDIENTES.md`](./PENDIENTES.md). Los de mayor impacto operativo son
el TLS del dominio (falta publicar 80/443), el **backup off-site** de la BD (hoy solo en la VM) y
rotar el token de GitHub de LorJosh.
