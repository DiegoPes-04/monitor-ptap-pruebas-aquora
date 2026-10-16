# Cierre de emergencia por turbiedad — protocolo acordado, SIN implementar

> **Estado: diseño. No hay una sola línea de código de esto en el sistema.**
> Acordado con el cliente el 2026-08-20. Se escribe ahora, mientras el razonamiento está fresco,
> para que cuando llegue el momento no se reconstruya de memoria.

## Qué se acordó

Si la turbiedad sube cerca de un umbral determinado y la planta **tiene válvula de entrada**, se
entra en **cierre de emergencia** de esa válvula, y no se reabre hasta que la turbiedad vuelva a un
nivel que la planta considere óptimo.

La lógica es correcta y el objetivo no se discute: agua turbia entrando al proceso es agua que no se
puede potabilizar bien, y cerrar la entrada es la respuesta.

## Por qué hoy no se puede hacer en ninguna planta

Hacen falta **dos** cosas a la vez, y no hay ni una sola planta que reúna ambas.

| | Turbiedad mapeada | Válvula de ENTRADA accionable |
|---|---|---|
| Soledad | ✅ `inletTurbidity` (op 0,1–5 NTU) y `outletTurbidity` (op 0,1–1) | ❌ no tiene válvula mapeada |
| Carbonero | ✅ `inletTurbidity` (op 0–5) y `outletTurbidity` (op 0–1) | ❌ |
| La Sirena | ✅ turbiedad de entrada y salida, **pero sin rango operativo declarado** | ❌ su única válvula es la de SALIDA |
| **La Vorágine** | ❌ ninguna señal de calidad: solo caudales, nivel, volumen y presiones | ✅ `valve2` de entrada accionable desde el 2026-10-16 (integrador: bit2 abre, bit3 cierra en `INT_OUT_VORAGINE[0]`, señal sostenida) — sin probar aún en campo |

Las nueve plantas restantes no tienen ninguna señal de calidad de agua.

Es decir: la única válvula de entrada que existe en el mapping está en la planta que **no** mide
turbiedad, y las tres que sí la miden **no** tienen válvula de entrada. El protocolo no es
implementable hasta que eso cambie.

## Qué haría falta, en orden

1. **Una planta con las dos cosas.** O se mapea la turbiedad de Vorágine (si el sensor existe y
   llega al PLC), o se consigue el canal de comando de la válvula de entrada en Soledad o Carbonero.
2. **El umbral de disparo y el de reapertura, en NTU**, dados por la planta. No son el mismo número:
   ver la histéresis más abajo.
3. **La decisión de seguridad** de la sección siguiente, tomada explícitamente por escrito.

## La decisión que no se puede heredar

Un cierre automático **cambia la naturaleza del sistema**: pasa de vigilar a controlar.

Hoy toda escritura al PLC exige un actor humano con permiso `control_valves`, pasa por un interlock
que verifica que los datos estén frescos, y queda en `audit_log` con nombre y hora. No existe ninguna
ruta que escriba sin una petición HTTP de una persona — lo comprobé recorriendo `WriteService`: su
único llamante es `commands.controller.ts`.

Automatizarlo obliga a inventar un actor de sistema, y con él se pierden tres cosas a la vez: el
RBAC deja de poder atribuir la orden a alguien, la guarda de ámbito por planta desaparece (vive en el
controlador, no en el servicio), y el registro de auditoría queda con usuario nulo.

Y sobre todo: **un sensor de turbiedad sucio cerraría el agua del pueblo de madrugada** sin que nadie
lo confirme. Los sensores de turbiedad se ensucian, es su modo de fallo más común, y ensuciarse
significa leer alto. El fallo más probable del sensor produce exactamente la acción más dañina.

Si aun así se decide automatizar, el patrón coherente con este repositorio sería:

- un rol de servicio explícito, no reutilizar `admin`;
- un flag propio, tipo `OPCUA_AUTOCONTROL_ENABLED`, a la misma altura que la precondición dura de
  escrituras;
- **corroboración con una segunda señal** antes de actuar: turbiedad alta *y* algo más que la
  respalde. Un solo número decidiendo un corte de suministro es demasiado poco.

**Recomendación:** empezar por avisar y que cierre una persona. El campo `action` de las
notificaciones existe justo para eso, y el operario tiene el botón a un toque. Si se comprueba que el
aviso llega tarde de forma sistemática, entonces se automatiza — con datos de cuántas veces pasó, no
por si acaso.

## Histéresis: por qué el umbral de cierre y el de reapertura no pueden ser el mismo

Si se cierra a 5 NTU y se reabre a 5 NTU, un valor oscilando alrededor de 5 abre y cierra la válvula
continuamente. Eso destroza el actuador y deja la red con golpes de presión.

Hacen falta dos números separados: cerrar por encima del umbral de emergencia, reabrir solo cuando se
baje del umbral **óptimo**, que debe estar claramente por debajo. Más un tiempo mínimo de
permanencia: la turbiedad tiene que mantenerse buena un rato antes de reabrir, no un instante.

## Lo que sí se puede hacer hoy, sin esperar a nada

Soledad y Carbonero **ya tienen** rangos operativos declarados en sus turbiedades. Eso significa que
el detector de rango que ya existe genera avisos cuando se salen — sin código nuevo.

Lo que hoy falta ahí es solo severidad: con el arreglo del 2026-08-18, una violación del rango
operativo en una señal de calidad de agua sale **crítica**, que es lo correcto. Conviene verificar en
la bandeja que esos avisos están llegando y que la turbiedad de salida de Soledad (máximo operativo
1 NTU) se está respetando, antes de hablar de automatizar nada.
