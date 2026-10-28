const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  ...expoConfig,
  prettierConfig,
  {
    settings: {
      'import/parsers': {
        '@typescript-eslint/parser': [],
        [require.resolve('@typescript-eslint/parser')]: ['.ts', '.tsx', '.d.ts'],
      },
    },
  },
  {
    // expo/no-dynamic-env-var existe porque Expo INLINEA las EXPO_PUBLIC_* en build (un acceso
    // dinámico allí devuelve undefined en runtime). El backend es Node puro: process.env[name]
    // es legítimo y sus helpers de config lo usan a propósito. Solo se apaga para el API.
    files: ['apps/api/**/*.ts'],
    rules: { 'expo/no-dynamic-env-var': 'off' },
  },
  {
    // Archivos de configuración CommonJS de Node (ecosystem de PM2, app.config.js de Expo, etc.):
    // __dirname/module/require son globales legítimos de Node, no del bundle. Se declaran para que no
    // salten como no-undef. app.config.js lo ejecuta el CLI de Expo en Node, nunca entra en la app, y
    // usa __dirname para saber si google-services.json está junto a él.
    files: ['**/ecosystem.config.js', 'apps/mobile/app.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly', process: 'readonly' },
    },
  },
  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    // Keep diagnostics visible for existing session, plant, and timer synchronization effects.
    rules: { 'react-hooks/set-state-in-effect': 'warn' },
  },
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.expo/**',
      '**/coverage/**',
    ],
  },
];
