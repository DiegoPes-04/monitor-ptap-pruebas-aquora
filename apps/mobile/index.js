// Punto de entrada de la app (package.json → "main").
//
// Antes era directamente `expo-router/entry`. Se interpone este archivo para cargar PRIMERO el
// arranque de notificaciones (`services/background-setup`): define la tarea de fondo y el manejador
// de notificaciones en el ámbito global del bundle. Es lo único que se ejecuta cuando WorkManager
// despierta la app con el proceso muerto, porque en ese caso no se monta React y nada de lo que
// viva en un componente llega a correr.
//
// En nativo Metro resuelve `background-setup.native.ts`; en web, `background-setup.ts`, que está
// vacío.
import './services/background-setup';
import 'expo-router/entry';
