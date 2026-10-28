#!/usr/bin/env bash
#
# Despliegue COMPLETO de la VM, sin una sola pregunta. Corre como `xpertic_app`, sin privilegios
# propios: lo único con root es `/usr/local/sbin/ptap-web-publish`, autorizado con NOPASSWD.
#
#   USO:  bash ~/deploy-scripts/ptap-deploy.sh [rama]        (por defecto: yosh)
#         bash ~/deploy-scripts/ptap-deploy.sh --sin-web     (solo backend)
#
# Recoge en un solo sitio los cuatro tropiezos que costaron caídas de verdad:
#
#  1. **`pm2 restart --update-env` tumba la API.** Reemplaza el entorno del proceso por el del shell
#     que invoca el comando; desde SSH no interactivo ese entorno es mínimo. Aquí se recrea el
#     proceso desde el ecosystem, que conserva `NODE_ENV` y carga secretos desde el `.env` del repo.
#  2. **`git pull` no basta.** La rama local de la VM ha seguido a `yosh` con otro nombre, y un pull
#     respondía "Already up to date" sin traer nada: todo en verde, sin desplegar. Aquí es
#     `fetch` + `reset --hard origin/<rama>`.
#  3. **Un despliegue que ELIMINA archivos deja huérfanos en `dist/`.** `tsc` compila lo que existe
#     pero no borra la salida de lo que ya no está; el 2026-08-11 quedó un `dist/modules/hmi/`
#     huérfano y el proceso arrancó sin escuchar en ningún puerto. Aquí `dist/` se borra antes.
#  4. **`npm ci` solo si cambió el lock.** Reinstalar 900 MB de dependencias en cada despliegue son
#     diez minutos regalados en una VM de 2 CPUs.
#
# Y comprueba la salud al final. Un despliegue que no verifica no es un despliegue: es una apuesta.
set -euo pipefail

REPO="/home/xpertic_app/monitor-ptap"
RAMA="yosh"
CON_WEB=1

for arg in "$@"; do
  case "$arg" in
    --sin-web) CON_WEB=0 ;;
    -*) echo "opción desconocida: $arg" >&2; exit 2 ;;
    *) RAMA="$arg" ;;
  esac
done

cd "$REPO"
echo "=== 1/6  traer $RAMA ==="
LOCK_ANTES="$(md5sum package-lock.json | cut -d' ' -f1)"
git fetch origin
git reset --hard "origin/$RAMA"
git --no-pager log --oneline -1
LOCK_DESPUES="$(md5sum package-lock.json | cut -d' ' -f1)"

echo ""
echo "=== 2/6  runtime y dependencias ==="
NODE_VERSION="$(tr -d '[:space:]' < .nvmrc)"
NODE_HOME="$HOME/.local/node-v$NODE_VERSION"
NODE_BIN="$NODE_HOME/bin/node"

case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) echo "arquitectura no soportada para Node.js: $(uname -m)" >&2; exit 1 ;;
esac

if [[ ! -x "$NODE_BIN" ]] || [[ "$("$NODE_BIN" --version)" != "v$NODE_VERSION" ]]; then
  NODE_ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  NODE_TMP="$(mktemp -d)"
  trap 'rm -rf -- "$NODE_TMP"' EXIT
  curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" \
    --output "$NODE_TMP/$NODE_ARCHIVE"
  curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    --output "$NODE_TMP/SHASUMS256.txt"
  (
    cd "$NODE_TMP"
    awk -v archive="$NODE_ARCHIVE" '$2 == archive { print; found=1 } END { exit !found }' \
      SHASUMS256.txt | sha256sum --check --status
  )
  mkdir -p "$NODE_HOME"
  tar -xJf "$NODE_TMP/$NODE_ARCHIVE" --strip-components=1 -C "$NODE_HOME"
  rm -rf -- "$NODE_TMP"
  trap - EXIT
fi

export PATH="$NODE_HOME/bin:$PATH"
if [[ "$(node --version)" != "v$NODE_VERSION" ]]; then
  echo "Node.js esperado v$NODE_VERSION, encontrado $(node --version)" >&2
  exit 1
fi
echo "  Node.js $(node --version), npm $(npm --version)"

if [[ "$LOCK_ANTES" != "$LOCK_DESPUES" ]]; then
  echo "  package-lock.json cambió: npm ci"
  npm ci
else
  echo "  sin cambios en package-lock.json: se omite npm ci"
fi

echo ""
echo "=== 3/6  migraciones (idempotente) ==="
npm run --silent db:migrate -w @ptap/api

echo ""
echo "=== 4/6  compilar backend ==="
# Ver tropiezo 3: se borra la salida anterior antes de compilar.
rm -rf apps/api/dist packages/shared/dist
npm run --silent build

echo ""
echo "=== 5/6  reiniciar la API ==="
if pm2 describe ptap-api >/dev/null 2>&1; then
  pm2 delete ptap-api
fi
PTAP_NODE_BINARY="$NODE_BIN" pm2 start apps/api/ecosystem.config.js --only ptap-api
pm2 save >/dev/null

# Tras el reinicio, /api/health devuelve 000 unos segundos mientras conecta el puente OPC UA. No es
# una caída: se espera y se reintenta antes de declarar nada.
#
# TRES MINUTOS, y no uno. El 2026-08-31 este script abortó con la API perfectamente sana: había
# esperado 60 s, y en esta VM (2 CPUs) el proceso tardó ~2 min en arrancar porque venía de compilar.
# La API levantó cuatro segundos después de rendirse. Un despliegue que declara un fallo que no
# existe es peor que uno lento: manda a alguien a diagnosticar una caída inventada.
ESPERAS=60
echo -n "  esperando a que escuche (hasta $((ESPERAS * 3)) s): "
INICIO=$SECONDS
for _ in $(seq 1 "$ESPERAS"); do
  CODIGO="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:4000/api/health || true)"
  [[ "$CODIGO" == "200" ]] && break
  echo -n "."
  sleep 3
done
echo " $CODIGO en $((SECONDS - INICIO)) s"

if [[ "$CODIGO" != "200" ]]; then
  # El VEREDICTO va al FINAL, después del volcado de logs, y no antes. Con el mensaje arriba, un
  # `| tail` —que es como se lee esto por SSH— se queda con los logs y esconde justo la línea que
  # dice qué pasó. Pasó de verdad el 2026-08-31.
  pm2 logs ptap-api --lines 20 --nostream --no-color >&2 || true
  echo "" >&2
  echo "  ================================================================" >&2
  echo "  La API no respondió 200 en $((SECONDS - INICIO)) s. NO se publica la web." >&2
  echo "  El backend YA está actualizado y compilado; lo único que falta es" >&2
  echo "  el bundle. Cuando la API responda, publica con:" >&2
  echo "      cd ~/monitor-ptap/apps/mobile && API_BASE_URL= npx expo export -p web --clear" >&2
  echo "      sudo -n /usr/local/sbin/ptap-web-publish" >&2
  echo "  ================================================================" >&2
  exit 1
fi

echo ""
if [[ "$CON_WEB" -eq 1 ]]; then
  echo "=== 6/6  bundle web y publicación ==="
  # API_BASE_URL vacío = mismo origen. No hay URL horneada, así que la web solo se recompila cuando
  # cambia el código, nunca por el dominio.
  ( cd apps/mobile && API_BASE_URL= npx expo export -p web --clear )
  # La única llamada con privilegios. `-n` = no interactivo: si la regla de sudoers no está puesta,
  # falla en el momento con un mensaje claro en vez de quedarse esperando una contraseña que nadie
  # va a escribir.
  sudo -n /usr/local/sbin/ptap-web-publish
else
  echo "=== 6/6  web omitida (--sin-web) ==="
fi

echo ""
echo "=== comprobación final ==="
for RUTA in health health/db health/opc; do
  printf '  %-12s -> HTTP ' "$RUTA"
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 8 "http://127.0.0.1:4000/api/$RUTA" || echo "sin respuesta"
done
printf '  %-12s -> ' "web"
date -r /var/www/ptap-web/index.html "+%Y-%m-%d %H:%M" 2>/dev/null || echo "no publicada"
pm2 list --no-color | grep ptap-api || true
echo ""
echo "Desplegado $(git --no-pager log --oneline -1)"
