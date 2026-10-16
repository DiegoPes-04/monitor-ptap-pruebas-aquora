# Protocolo de válvulas — La Vorágine (`voragine`)

> ## ✅ ACTUALIZACIÓN 2026-10-16 — codificación entregada por el integrador del PLC
>
> Las DOS válvulas mandan por la misma palabra, `INT_OUT_VORAGINE[0]`:
>
> | Válvula | `domainKey` | Abrir | Cerrar |
> |---|---|---|---|
> | **Entrada** | `valve2` (caudal `inletFlow1`) | bit2 = `4` | bit3 = `8` |
> | **Salida** | `valve1` (caudal `outletFlow1`) | bit12 = `4096` | bit13 = `8192` |
>
> **La lectura del bit12 como «PULSO» de más abajo era ERRÓNEA: es abrir la salida.** Los valores de la
> salida (4096/8192) son los que el cliente ya había verificado en campo el 2026-08-15.
>
> **Regla del integrador, textual:** «estas señales deben ser sostenidas, es decir que todo el tiempo
> debe quedar la señal de apertura o la señal de cierre, nunca las dos, siempre una de las dos».
>
> En el mapping las dos llevan `sustained: true`: cada orden es UNA escritura read-modify-write,
> `(actual & ~contrario) | verbo`, que pasa el par de un verbo al otro sin 0/0 ni 1/1 y sin tocar la
> otra válvula, y **no se suelta nunca** (sin `pulse`, sin `until`, sin `rollbackValue`). Hasta el
> 2026-10-16 la salida se sostenía hasta `INT_IN[1] = 1` y después se limpiaba, dejándola en 0/0. El
> estado de cada válvula sale de su caudal (`stateVerified: false`); el resultado en la app es ámbar.
> Herramienta de campo: `apps/api/scripts/test-valvulas-voragine.ts` (simulacro sin `--armar`).
>
> El resto de este documento es el registro ORIGINAL del 2026-07-22 y se conserva como tal; donde
> contradiga este recuadro, manda el recuadro.

> # ⛔ NO EJECUTAR — RIESGO FÍSICO
> Este documento REGISTRA el protocolo de mando/estado de válvula del PLC real. **Enviar un pulso o
> escritura puede abrir/cerrar una válvula física y dañar la planta.** Es material de referencia,
> **no** una guía para probar. Hoy el sistema NO puede emitir estos comandos y así debe permanecer
> hasta que el operador confirme la semántica (ver §Estado y §Preguntas abiertas).

**Fuente:** notas de ingeniería del operador (2026-07-22), sin verificar contra L5X ni documento
oficial. **Confianza: UNVERIFIED.**

---

## Estado del canal de escritura (candado)

- `OPCUA_WRITES_ENABLED=false` (`.env` / `.env.example`) — la escritura está prohibida por defecto.
- El mapping de producción (`apps/api/config/opc_mapping.json`) **no** tiene señales `writable` para
  voragine → `CommandMappingResolver` devuelve `null` → `WriteService` responde `TARGET_NOT_WRITABLE`
  (ver `docs/CATALOGO_ERRORES.md`, CMD-01) y la precondición dura de la regla 9 rechaza cualquier
  intento. **Este documento no cambia nada de eso.**

---

## Los dos nodos (ya existen en el mapping como buffers)

| Rol | Buffer | Nodo (nsUri AQUATECH) | Tipo |
|---|---|---|---|
| **COMANDO** (escritura al PLC) | `INT_OUT_VORAGINE` | `ns=9;g=1505CBA4-0BCF-A4FC-7602-DB5BF940BBC6` | `Int16[20]` |
| **ESTADO** (lectura del PLC) | `INT_IN_VORAGINE` | `ns=9;g=002A5DBD-381A-F691-1071-4BFF23ED007C` | `Int16[20]` |

> `INT_OUT_*` = buffer de salida (lo que el backend escribiría hacia el PLC).
> `INT_IN_*` = buffer de entrada (lo que el PLC reporta). Ambos están declarados en el mapping pero
> hoy **sin señales** asociadas (voragine solo mapea `realIn`: caudales, presiones, tanque).

---

## COMANDO — INT_OUT_VORAGINE, array índice 0

| Valor | Bits | Acción |
|---|---|---|
| `4` | bit2 | **ABRIR** (la de ENTRADA — integrador, 2026-10-16) |
| `8` | bit3 | **CERRAR** (la de ENTRADA — integrador, 2026-10-16) |
| `4096` | bit12 | ~~**PULSO**~~ → **ABRIR la de SALIDA** (integrador, 2026-10-16; cerrar la salida = bit13 = `8192`) |

- ⚠️ **ABRIR y CERRAR a la vez → ERROR.** Nunca ambos simultáneamente (interlock: son órdenes
  contradictorias).

## ESTADO — INT_IN_VORAGINE

| Ubicación | Valor | Bits | Significado |
|---|---|---|---|
| Posición 2 del array | `16384` | bit14 | **CERRADA** |
| Posición 2 del array | `16385` | bit14 + bit0 | **ABIERTA** |
| Array 1 | `3098`, `7194`, `1025` | — | **por confirmar** |
| Array 0 | `7194` | — | **por confirmar** |

---

## Análisis de lógica y viabilidad

Cada valor es una **máscara de bits** de una palabra `Int16` (no un número: qué bits están
encendidos). Referencia: 2²=4, 2³=8, 2¹⁰=1024, 2¹¹=2048, 2¹²=4096, 2¹⁴=16384.

### 1. ESTADO (lectura) — lógica coherente ✅
`16384` (cerrada) = solo bit14; `16385` (abierta) = bit14 + bit0. Interpretación consistente:
- **bit14 = "estado válido / válvula presente"** (siempre encendido cuando hay dato).
- **bit0 = abierta(1) / cerrada(0)**.

Difieren en un único bit → patrón de estado clásico y fiable. **Es una lectura: cero riesgo.** Si
algún día se quiere mostrar "abierta/cerrada" en la UI, decodificar `bit0` de la posición 2 es
seguro y directo.

### 2. COMANDO (escritura) — plausible, con una ambigüedad ⚠️
`bit2`=abrir, `bit3`=cerrar, `bit12`=pulso. Que abrir+cerrar dé error encaja (bits contradictorios).
**Ambigüedad sin resolver:** ¿el pulso se **combina** con la dirección o es **independiente**?
- **Modelo A (combinado):** se fija dirección y el pulso la dispara → `4100` (abrir+pulso) /
  `4104` (cerrar+pulso).
- **Modelo B (independiente):** `4` y `8` son órdenes completas; `4096` es un pulso de otra
  acción/válvula.

No se puede decidir sin el operador. **Esta es la razón central para NO probar:** una orden
equivocada actúa sobre una válvula real.

### 3. Valores 3098 / 7194 / 1025 — patrón parcial 🔍
- `3098` = bits {11, 10, 4, 3, 1}
- `7194` = **3098 + 4096** → los mismos bits de `3098` **más el bit de pulso (bit12)**. La relación
  no es casual.
- `1025` = bits {10, 0}
- `bit10` (1024) se repite en `3098` y `1025` → podría ser un segundo flag de "válvula válida"
  (análogo al bit14 del estado), pero **es hipótesis, no hecho**.

No concluyente: se registran como observación cruda, no como semántica confirmada.

### Veredicto
| Parte | ¿Viable? | Riesgo |
|---|---|---|
| Leer estado (bit14/bit0) | Sí, ya | Ninguno (lectura) |
| Comandar válvula (4/8/4096) | Solo con semántica del pulso **confirmada por el operador** y tras el candado de escritura | Alto si se equivoca — **nunca probar en planta real** |
| Interpretar 3098/7194/1025 | No aún | — (solo registrar) |

---

## Preguntas abiertas (resolver con el operador antes de CUALQUIER cableado)

1. ¿Qué válvula específica es (nombre / `domainKey`)? ¿Es la única de voragine?
2. ¿"posición 2" = índice 2 del array de `INT_IN`? ¿ABRIR/CERRAR/PULSO van todos al índice 0 de
   `INT_OUT`?
3. Significado de `3098`, `7194`, `1025` (¿otras válvulas? ¿handshake/secuencia? ¿estados
   intermedios?).
4. PULSO (4096) vs ABRIR/CERRAR (4/8): ¿el pulso es un paso adicional del mismo comando (Modelo A)
   o independiente (Modelo B)?

---

## Si algún día se cablea (fuera del alcance actual)

Trabajo posterior, gatado y con confirmación del operador — **no** parte de este registro:
1. Confirmar §Preguntas abiertas con el operador / L5X.
2. Mapear primero **solo el ESTADO** como señal de lectura (seguro).
3. El comando de escritura: definir `write` spec en el mapping, mantener `OPCUA_WRITES_ENABLED=false`
   hasta pruebas controladas en banco (no en planta), con interlock abrir≠cerrar y read-back del
   estado. Auditar cada intento (ver canal de comandos, Fase 5).
