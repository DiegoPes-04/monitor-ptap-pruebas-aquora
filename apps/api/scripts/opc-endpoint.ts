/**
 * Endpoint del PLC maestro para las herramientas de campo.
 *
 * Existe porque la IP y el puerto estaban escritos a mano en OCHO scripts. El 2026-08-19 la planta
 * movio el servidor de `10.10.51.225:59100` (interna) a `181.204.165.66:59200` (publica), y los
 * ocho quedaron apuntando a un puerto muerto a la vez: la herramienta no fallaba con un mensaje
 * util, se colgaba intentando conectar. Con un solo sitio, el proximo cambio es una linea.
 *
 * Precedencia: argumento de linea de comandos > OPC_ENDPOINT del entorno > el valor de abajo. Asi
 * un script se puede apuntar a otro servidor sin editar nada, que es lo que hace falta cuando se
 * esta averiguando si el problema es la ruta o el servidor.
 *
 * 2026-09-21: volvio a pasar, y peor — el helper existia pero NINGUN script lo importaba, asi que
 * los once siguieron con el literal a mano. Al cerrar la planta el path publico, todos quedaron
 * otra vez apuntando a un puerto muerto. Ese dia si se completo la refactorizacion: si anades un
 * script nuevo, usa `resolverEndpoint()` — no copies la URL.
 */

/**
 * Ultimo endpoint conocido del PLC maestro. Es un DEFAULT de conveniencia, no la fuente de verdad:
 * la de produccion es `OPC_ENDPOINT` en el `.env` de la VM.
 */
export const OPC_ENDPOINT_POR_DEFECTO = 'opc.tcp://10.10.51.225:59100';

/** Resuelve el endpoint a usar. `argumento` suele ser `process.argv[2]`. */
export function resolverEndpoint(argumento?: string): string {
  const cli = argumento && argumento.startsWith('opc.tcp://') ? argumento : undefined;
  return cli ?? process.env.OPC_ENDPOINT ?? OPC_ENDPOINT_POR_DEFECTO;
}
