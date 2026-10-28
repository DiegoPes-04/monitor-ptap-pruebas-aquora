// PM2 — arranque de producción del backend @ptap/api.
//
// Requiere el build previo (en la raíz del repo):  npm ci  &&  npm run build
// (compila @ptap/shared → dist y luego el API → dist/main.js). Ver docs/DEPLOY_VPS.md.
//
// Uso:
//   cd apps/api
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup    # relanzar en cada reboot
module.exports = {
  apps: [
    {
      name: 'ptap-api',
      script: 'dist/main.js', // build de producción (node puro; @ptap/shared ya resuelve a su dist)
      interpreter: process.env.PTAP_NODE_BINARY || 'node',
      cwd: __dirname, // apps/api — el .env de la raíz lo carga la app (config/load-env)
      instances: 1, // NO cluster: el puente OPC UA y las suscripciones Socket.IO son de una sola instancia
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: '600M', // reinicia si una fuga lo lleva alto (node-opcua es pesado)
      time: true, // marca de tiempo en los logs de PM2
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
