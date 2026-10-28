# Requisitos del servidor (aprovisionamiento del VPS)

Lista para entregar a quien provisiona la **máquina virtual** (parte "en cero absoluto"). Cubre
sistema operativo, hardware, software a instalar, red/puertos, accesos/credenciales y el flujo de
**GitHub para seguir actualizando** la rama de forma remota.

- **Qué se monta:** el **backend** del proyecto (`@ptap/api`) — API REST + WebSocket en tiempo real
  + puente OPC UA al PLC. El móvil es un cliente aparte (APK).
- **Runbook de instalación paso a paso (comandos):** [RUNBOOK_PRODUCCION.md](RUNBOOK_PRODUCCION.md).

---

## 1. Sistema operativo

> **Recomendado: Linux — Ubuntu Server 24.04 LTS (64-bit).** El proyecto está pensado para Linux
> (menos RAM, binarios nativos de `argon2` listos, gestión estándar por CLI). **Evitar Alpine/musl.**
>
> Windows Server *también* podría correr Node, pero pesa más (más RAM), la gestión por consola es
> menos natural y algunos módulos se comportan distinto. **Si es posible elegir, pedir Linux.**

---

## 2. Hardware

El backend es liviano; lo que decide el tamaño es **dónde vive la base de datos MySQL**:

| Recurso | Con MySQL **externo/gestionado** | Con MySQL **en la misma VM** |
|---|---|---|
| **CPU** | | 2 vCPU |
| **RAM** || **2 GB mín · 4 GB** recomendado |
| **Disco** | **30 GB** SSD |  |

Desglose del disco: SO (~8–10 GB) + `node_modules` del proyecto (~1.5–2 GB, `node-opcua` es grande)
+ logs + (si MySQL local) datos que crecen despacio (`audit_log`, muestras de ruta). SSD siempre.

> Si el proveedor da un **MySQL gestionado** aparte, elige la columna izquierda (más barato). Si la
> VM viene sola y hay que instalar MySQL en ella, usa la derecha.

---

## 3. Software a instalar (la VM viene vacía)

| Capa | Paquete | Para qué |
|---|---|---|
| **Runtime** | **Node.js 26.12.1** + npm incluido | Runtime fijado por `.nvmrc`; versión publicada con correcciones de seguridad recientes |
| **Control de versiones** | **git** | Clonar y actualizar el código desde GitHub |
| **Gestor de proceso** | **PM2** (`npm i -g pm2`) *(o systemd)* | Mantener el backend vivo, reiniciar en caída/reboot, logs |
| **Reverse proxy + TLS** | **nginx** + **certbot** (Let's Encrypt) | HTTPS en 443 → app en 4000, **con WebSocket** |
| **Compilación (respaldo)** | **build-essential** (gcc/g++/make) + **python3** | Solo si `argon2` no encuentra su binario *prebuilt* |
| **Utilidades** | curl, unzip, ca-certificates, **ufw** (firewall) | Instalación, descargas, seguridad de puertos |
| **Reloj** | **NTP** (systemd-timesyncd, ya en Ubuntu) | Hora correcta = JWT/expiración y certificados TLS válidos |
| **Base de datos** *(solo si NO es gestionada)* | **MySQL Server 8.x** (o MariaDB 10.6+) | Usuarios, auditoría, comandos, verificación de correo |

**Lenguaje/dependencias del proyecto:** TypeScript sobre Node. Todas las librerías se instalan con
`npm ci` **en la VM** (no copiar `node_modules` de otra máquina). La **única dependencia nativa** es
`argon2` (usa *prebuilt* en Linux glibc). El resto es JS puro (`@nestjs/*`, `socket.io`, `mysql2`,
`node-opcua`, `jsonwebtoken`, `helmet`, `zod`, `pino`, …).

---

## 4. Red y puertos

- **Entrantes (abrir en el firewall/VPS):**
  - **443/tcp** (HTTPS) — el acceso público a la API/WebSocket.
  - **80/tcp** — redirección a 443 y renovación del certificado (certbot).
  - **22/tcp** (SSH) — administración (idealmente restringido por IP).
- **Salientes (deben estar permitidos):**
  - **A GitHub** (443 HTTPS o 22 SSH) — para clonar/actualizar el código.
  - **Al registro npm** (443) — durante `npm ci`.
  - **⚠️ Al PLC por OPC UA** (p. ej. **59100/tcp** hacia la IP/host del PLC). **CRÍTICO:** si la VM
    no alcanza el PLC, la telemetría sale "sin datos" aunque todo lo demás esté perfecto. Hoy el PLC
    está tras NAT/túnel (ver [INCIDENTE_CONEXION_PLC.md](INCIDENTE_CONEXION_PLC.md)); resolver esa
    ruta (VPN/túnel) es requisito de red, no del hosting.
- El proceso Node escucha **solo en `127.0.0.1:4000`** (nunca expuesto directo; entra por nginx).

---

## 5. Accesos y credenciales a conseguir (antes de montar)

- [ ] **Acceso SSH** a la VM (usuario + clave; IP pública fija IPv4).
- [ ] **Dominio + DNS:** `aquora.xpertic.co` con permiso para crear un registro **A** apuntando a
      la IP de la VM (necesario para el certificado TLS).
- [ ] **Repositorio GitHub** (privado): acceso de **lectura** para la VM — vía *deploy key* SSH
      (recomendado) o un *Personal Access Token*. Ver §6.
- [ ] **MySQL:** credenciales del gestionado (host/usuario/contraseña/base) **o** decidir instalarlo
      en la VM.
- [ ] **Ruta al PLC** resuelta (IP/host alcanzable + puerto OPC UA).
- [ ] **Secretos a generar en la VM** (no se piden a nadie): `JWT_SECRET` y
      `PASSWORD_PEPPER_V1_BASE64` (64 bytes) — comandos en [RUNBOOK_PRODUCCION.md](RUNBOOK_PRODUCCION.md) §5.

---

## 6. GitHub: clonar y **seguir actualizando** la rama de forma remota

El servidor sigue la rama **`yosh`** (donde se sube el trabajo). El repo es privado, así que la VM
necesita acceso de lectura.

### 6.1 Dar acceso a la VM (una vez) — *deploy key* SSH (recomendado)
```bash
# En la VM:
ssh-keygen -t ed25519 -C "vps-ptaps" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```
Copiar esa clave pública y pegarla en **GitHub → repo → Settings → Deploy keys → Add deploy key**
(solo lectura). Luego:
```bash
git clone git@github.com:sebas4284/monitor-ptap.git
cd monitor-ptap
git checkout yosh
```
*(Alternativa sin deploy key: `git clone https://<TOKEN>@github.com/sebas4284/monitor-ptap.git`.)*

### 6.2 Actualizar cuando haya cambios nuevos (script `update.sh` en la VM)
```bash
#!/usr/bin/env bash
set -e
cd ~/monitor-ptap
git fetch origin
git checkout yosh
git pull --ff-only origin yosh
npm ci                                   # si cambiaron dependencias
npm run db:migrate -w @ptap/api          # si hay migraciones nuevas (idempotente)
pm2 restart ptap-api
pm2 save
echo "Actualizado a $(git rev-parse --short HEAD)"
```
Correrlo cada vez que se suba a `yosh`: `bash ~/update.sh`.

### 6.3 (Opcional) Auto-despliegue con GitHub Actions
El repo ya trae CI (typecheck + lint + tests, `.github/workflows/ci.yml`). Más adelante se puede
añadir un workflow de *deploy* que, al hacer *push* a `yosh`, entre por SSH a la VM y ejecute
`update.sh`. Requiere guardar la clave SSH y el host como *secrets* del repo. Es opcional; el
`update.sh` manual cubre el día a día.

---

## 7. Dos condiciones que deben cumplirse (o no funciona)

1. **Proceso persistente + WebSocket + root.** El backend es un servicio que corre 24/7 y usa
   WebSocket (Socket.IO). Necesita poder instalar PM2/nginx y abrir puertos → **hace falta un VPS
   con root/sudo real**, no un hosting compartido "jaulado". Verificar con `sudo -v` y `node -v`.
2. **La VM alcanza el PLC** (§4). Es el punto que decide si llega la telemetría.

### Cómo se arranca (detalle en RUNBOOK_PRODUCCION.md §11.4)
Se ejecuta con **`node dist/main.js`** bajo PM2 (`ecosystem.config.js`). `npm run build` compila
primero `@ptap/shared` a JS y luego el API, así que ya no hace falta el workaround de `tsx` que se
usaba cuando el paquete compartido solo existía como TypeScript.

---

## Resumen de una línea para el proveedor
> **VPS Linux (Ubuntu Server 24.04 LTS), 2 vCPU, 2 GB RAM (4 GB si MySQL va en la misma VM), 20–40 GB
> SSD, IP pública fija, con root/SSH; puertos 80/443 entrantes y salida permitida hacia GitHub, npm y
> el PLC (OPC UA). Software a instalar: Node.js 26.12.1, git, PM2, nginx + certbot, build-essential +
> python3 (y MySQL 8 solo si no es gestionado).**
