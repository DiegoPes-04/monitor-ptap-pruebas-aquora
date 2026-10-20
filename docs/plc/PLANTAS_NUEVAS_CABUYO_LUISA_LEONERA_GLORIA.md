# Plantas nuevas: Cabuyo, La Luisa, La Leonera y Gloria — ficha para el integrador del PLC

> **Estado (2026-10-19).** Las cuatro plantas están dadas de alta en Aquora **sin señales**: aparecen en
> la app, pero no muestran lecturas ni tienen mando. **Todavía no existen en el PLC maestro**: el
> browse del 2026-07-12 (`apps/api/fixtures/plc-discovery/`) no trae ningún tag que contenga CABUYO,
> LUISA, LEONERA ni GLORIA. Sin nombre de tag, NodeId e índice no hay señal que mapear, y en este
> proyecto no se mapea nada por suposición.
>
> Esta ficha es lo que el integrador debe entregar para conectarlas. Con ella completa, conectarlas es
> un cambio solo de datos en `apps/api/config/opc_mapping.json`.

| Campo | Valor |
|---|---|
| **Plantas** | `cabuyo` (Cabuyo), `luisa` (La Luisa), `leonera` (La Leonera), `gloria` (Gloria) |
| **Estado en el mapping** | `opcBuffers: {}`, `connection` en `unmapped` con DN/ER/TO en `null`, `signals: []` |
| **Servidor** | FactoryTalk Optix del PLC maestro, namespace `AQUATECH4` |
| **Llena la ficha** | el integrador del PLC |
| **Aplica la ficha** | el equipo de Aquora (sección 6) |

---

## 1. Qué tiene cada planta

Equipo declarado por el cliente. Es igual en las cuatro, salvo el tanque de La Leonera:

| Equipo | Cabuyo | La Luisa | La Leonera | Gloria |
|---|---|---|---|---|
| Válvula de **entrada** on/off | sí | sí | sí | sí |
| Válvula de **salida** proporcional (% de apertura + consigna 0–100 %) | sí | sí | sí | sí |
| Caudal de entrada | sí | sí | sí | sí |
| Caudal de salida | sí | sí | sí | sí |
| Presión de entrada | sí | sí | sí | sí |
| Tanque con sensor de nivel | — | — | **sí (1)** | — |

Mientras no estén en el PLC, el backend no les suscribe nada. Su frescura (`liveness`) es `frozen`
desde el arranque, y la app las muestra como plantas sin señales, nunca como "en operación".
Tampoco generan avisos.

Mientras no tengan buffers, el backend las marca con `integrationPending: true` (snapshot,
`GET /api/plants` y estado básico) y la app las muestra **EN INTEGRACIÓN**, en gris: sin "sin
conexión", sin "reintentando" y sin código PLC-0x. Ese estado desaparece solo en cuanto se les
declaren buffers en el mapping (y se reinicie el backend, paso 8 de la sección 6).

---

## 2. Reglas de la entrega (valen para las cuatro)

1. **Nombres de tag exactos**, copiados de *Controller Tags* (Studio 5000) o del browse, letra por
   letra. El token de sitio importa: Aquora reconoce a qué planta pertenece un tag porque su nombre
   **contiene** ese token, y hoy ya hay nombres irregulares que nadie habría adivinado:

   | Planta | Nombre real en el PLC | Lo irregular |
   |---|---|---|
   | San Antonio | `REAL_TK_SAN_ANTONO` | le falta la I de ANTONIO |
   | Alto de los Mangos | `DATOS_REAL_IN_MANGOS` | prefijo `DATOS_` y token `MANGOS` |
   | Soledad | `DATOS_IN_PTAP_SOLEDAD` | segundo buffer de entrada, sin `REAL_` |
   | Cascajal | `MSG_READ_CASCAJAL` | sin `_REAL_` (Soledad usa `MSG_READ_REAL_SOLEDAD`) |
   | La Sirena | `MSG_READ_REAL_TK3_4_SIRENA` | una MSG para dos tanques |

   **Sugerencia** (la que siguen la mayoría de los sitios): tokens `CABUYO`, `LUISA`, `LEONERA` y
   `GLORIA`, y buffers `REAL_IN_<SITIO>` (Float[50]), `INT_IN_<SITIO>` (Int16[20]),
   `INT_OUT_<SITIO>` (Int16[20]), `REAL_OUT_<SITIO>` (si la consigna va como REAL),
   `MSG_READ_REAL_<SITIO>`, `MSG_READ_INT_<SITIO>`, `MSG_WRITE_INT_<SITIO>`. Si ya los crearon con
   otro nombre (por ejemplo `LA_LUISA`), no hace falta cambiarlos: basta con decirnos el nombre
   exacto. Un token no puede estar contenido en el de otro sitio.
2. **Lecturas analógicas en unidades de ingeniería, como REAL.** Aquora **no escala lecturas**: el
   valor del buffer se muestra tal cual. Caudal en l/s, presión en psi (o en bar, si así viene: se
   declara la unidad y los límites en esa unidad), nivel en m y apertura en % de 0 a 100. Si alguna
   llega en cuentas (0–32767) o en mA (4–20), hay que decirlo: no se puede mostrar sin un cambio de
   código previo.
3. **Índices base 0**, como en el PLC: `REAL_IN_X[0]` es el primer elemento.
4. **Un índice, un significado.** Indiquen también qué índices quedan libres o reservados.
5. **Periodo de las MSG** de lectura y de escritura de cada sitio. De ese periodo dependen la
   frescura de los datos y cuánto tarda una orden en llegar al PLC local.

---

## 3. Qué entregar por planta

Las cuatro tablas son iguales. La Leonera agrega la del tanque (sección 4).

### 3.1 Cabuyo (`cabuyo`)

**Tags**

| Qué | Nombre exacto del tag | Tipo y tamaño | Observaciones |
|---|---|---|---|
| Lecturas reales (`REAL_IN_<SITIO>`) | | Float[ ] | |
| Estados enteros (`INT_IN_<SITIO>`) | | Int16[ ] | |
| Mando entero (`INT_OUT_<SITIO>`) | | Int16[ ] | |
| Consignas reales (`REAL_OUT_<SITIO>`) | | Float[ ] | solo si la consigna va como REAL |
| MSG de lectura (`MSG_READ*`, todas) | | MESSAGE | ¿cuál es la primaria (la de DN/ER/TO)? |
| MSG de escritura (`MSG_WRITE*`, todas) | | MESSAGE | |
| Periodo de las MSG | | | lectura: ___ s · escritura: ___ s |

**Lecturas**

| Señal en Aquora | Buffer e índice | Unidad | Rango del instrumento | Rango operativo (si existe) |
|---|---|---|---|---|
| Caudal de entrada (`inletFlow1`) | `____[__]` | l/s | | |
| Caudal de salida (`outletFlow1`) | `____[__]` | l/s | | |
| Presión de entrada (`inletPressure1`) | `____[__]` | psi / bar | | |

**Válvula de entrada on/off (`valve2`)**

| Dato | Valor |
|---|---|
| Palabra de mando | `INT_OUT_____[__]` |
| Bit para ABRIR | bit __ (valor __) |
| Bit para CERRAR | bit __ (valor __) |
| ¿Sostenido o de pulso? | sostenido (queda puesta una de las dos señales) / pulso de ___ ms |
| ¿Hay otros bits de esa palabra en uso? ¿Cuáles? | (Aquora escribe solo sus bits y respeta el resto) |
| Palabra de estado | `INT_IN_____[__]` |
| Codificación del estado | valores o bits de ABIERTA / CERRADA / en recorrido / falla |
| ¿Codificación verificada en campo? | sí / no — por quién y cuándo |

**Válvula de salida proporcional (`valve1`)**

| Dato | Valor |
|---|---|
| % de apertura (realimentación): buffer e índice | `____[__]` |
| Escala de la apertura | 0–100 % / 0–32767 / 4–20 mA / otra: ___ |
| Apertura a partir de la cual se considera abierta | > ___ % (error de cero del transmisor) |
| Consigna: buffer e índice | `REAL_OUT_____[__]` o `INT_OUT_____[__]` |
| Consigna: tipo | REAL / INT |
| Consigna: escala | 0–100 % / 0–32767 / otra: ___ |
| Límites permitidos de la consigna | mínimo ___ % · máximo ___ % |
| Rampa permitida | ___ %/s, o sin rampa |
| ¿Qué hace el PLC local con una consigna fuera de límites? | |
| ¿Existe un modo local/manual que ignore la consigna remota? ¿Dónde se lee? | |

### 3.2 La Luisa (`luisa`)

**Tags**

| Qué | Nombre exacto del tag | Tipo y tamaño | Observaciones |
|---|---|---|---|
| Lecturas reales (`REAL_IN_<SITIO>`) | | Float[ ] | |
| Estados enteros (`INT_IN_<SITIO>`) | | Int16[ ] | |
| Mando entero (`INT_OUT_<SITIO>`) | | Int16[ ] | |
| Consignas reales (`REAL_OUT_<SITIO>`) | | Float[ ] | solo si la consigna va como REAL |
| MSG de lectura (`MSG_READ*`, todas) | | MESSAGE | ¿cuál es la primaria (la de DN/ER/TO)? |
| MSG de escritura (`MSG_WRITE*`, todas) | | MESSAGE | |
| Periodo de las MSG | | | lectura: ___ s · escritura: ___ s |

**Lecturas**

| Señal en Aquora | Buffer e índice | Unidad | Rango del instrumento | Rango operativo (si existe) |
|---|---|---|---|---|
| Caudal de entrada (`inletFlow1`) | `____[__]` | l/s | | |
| Caudal de salida (`outletFlow1`) | `____[__]` | l/s | | |
| Presión de entrada (`inletPressure1`) | `____[__]` | psi / bar | | |

**Válvula de entrada on/off (`valve2`)**

| Dato | Valor |
|---|---|
| Palabra de mando | `INT_OUT_____[__]` |
| Bit para ABRIR | bit __ (valor __) |
| Bit para CERRAR | bit __ (valor __) |
| ¿Sostenido o de pulso? | sostenido (queda puesta una de las dos señales) / pulso de ___ ms |
| ¿Hay otros bits de esa palabra en uso? ¿Cuáles? | (Aquora escribe solo sus bits y respeta el resto) |
| Palabra de estado | `INT_IN_____[__]` |
| Codificación del estado | valores o bits de ABIERTA / CERRADA / en recorrido / falla |
| ¿Codificación verificada en campo? | sí / no — por quién y cuándo |

**Válvula de salida proporcional (`valve1`)**

| Dato | Valor |
|---|---|
| % de apertura (realimentación): buffer e índice | `____[__]` |
| Escala de la apertura | 0–100 % / 0–32767 / 4–20 mA / otra: ___ |
| Apertura a partir de la cual se considera abierta | > ___ % (error de cero del transmisor) |
| Consigna: buffer e índice | `REAL_OUT_____[__]` o `INT_OUT_____[__]` |
| Consigna: tipo | REAL / INT |
| Consigna: escala | 0–100 % / 0–32767 / otra: ___ |
| Límites permitidos de la consigna | mínimo ___ % · máximo ___ % |
| Rampa permitida | ___ %/s, o sin rampa |
| ¿Qué hace el PLC local con una consigna fuera de límites? | |
| ¿Existe un modo local/manual que ignore la consigna remota? ¿Dónde se lee? | |

### 3.3 La Leonera (`leonera`)

**Tags**

| Qué | Nombre exacto del tag | Tipo y tamaño | Observaciones |
|---|---|---|---|
| Lecturas reales (`REAL_IN_<SITIO>`) | | Float[ ] | |
| Estados enteros (`INT_IN_<SITIO>`) | | Int16[ ] | |
| Mando entero (`INT_OUT_<SITIO>`) | | Int16[ ] | |
| Consignas reales (`REAL_OUT_<SITIO>`) | | Float[ ] | solo si la consigna va como REAL |
| Buffer propio del tanque, si lo hay (p. ej. `REAL_TK_<SITIO>`) | | Float[ ] | en otros sitios el tanque llega en un buffer aparte |
| MSG de lectura (`MSG_READ*`, todas) | | MESSAGE | ¿cuál es la primaria (la de DN/ER/TO)? |
| MSG de escritura (`MSG_WRITE*`, todas) | | MESSAGE | |
| Periodo de las MSG | | | lectura: ___ s · escritura: ___ s |

**Lecturas**

| Señal en Aquora | Buffer e índice | Unidad | Rango del instrumento | Rango operativo (si existe) |
|---|---|---|---|---|
| Caudal de entrada (`inletFlow1`) | `____[__]` | l/s | | |
| Caudal de salida (`outletFlow1`) | `____[__]` | l/s | | |
| Presión de entrada (`inletPressure1`) | `____[__]` | psi / bar | | |

**Válvula de entrada on/off (`valve2`)**

| Dato | Valor |
|---|---|
| Palabra de mando | `INT_OUT_____[__]` |
| Bit para ABRIR | bit __ (valor __) |
| Bit para CERRAR | bit __ (valor __) |
| ¿Sostenido o de pulso? | sostenido (queda puesta una de las dos señales) / pulso de ___ ms |
| ¿Hay otros bits de esa palabra en uso? ¿Cuáles? | (Aquora escribe solo sus bits y respeta el resto) |
| Palabra de estado | `INT_IN_____[__]` |
| Codificación del estado | valores o bits de ABIERTA / CERRADA / en recorrido / falla |
| ¿Codificación verificada en campo? | sí / no — por quién y cuándo |

**Válvula de salida proporcional (`valve1`)**

| Dato | Valor |
|---|---|
| % de apertura (realimentación): buffer e índice | `____[__]` |
| Escala de la apertura | 0–100 % / 0–32767 / 4–20 mA / otra: ___ |
| Apertura a partir de la cual se considera abierta | > ___ % (error de cero del transmisor) |
| Consigna: buffer e índice | `REAL_OUT_____[__]` o `INT_OUT_____[__]` |
| Consigna: tipo | REAL / INT |
| Consigna: escala | 0–100 % / 0–32767 / otra: ___ |
| Límites permitidos de la consigna | mínimo ___ % · máximo ___ % |
| Rampa permitida | ___ %/s, o sin rampa |
| ¿Qué hace el PLC local con una consigna fuera de límites? | |
| ¿Existe un modo local/manual que ignore la consigna remota? ¿Dónde se lee? | |

**Tanque:** ver la sección 4.

### 3.4 Gloria (`gloria`)

**Tags**

| Qué | Nombre exacto del tag | Tipo y tamaño | Observaciones |
|---|---|---|---|
| Lecturas reales (`REAL_IN_<SITIO>`) | | Float[ ] | |
| Estados enteros (`INT_IN_<SITIO>`) | | Int16[ ] | |
| Mando entero (`INT_OUT_<SITIO>`) | | Int16[ ] | |
| Consignas reales (`REAL_OUT_<SITIO>`) | | Float[ ] | solo si la consigna va como REAL |
| MSG de lectura (`MSG_READ*`, todas) | | MESSAGE | ¿cuál es la primaria (la de DN/ER/TO)? |
| MSG de escritura (`MSG_WRITE*`, todas) | | MESSAGE | |
| Periodo de las MSG | | | lectura: ___ s · escritura: ___ s |

**Lecturas**

| Señal en Aquora | Buffer e índice | Unidad | Rango del instrumento | Rango operativo (si existe) |
|---|---|---|---|---|
| Caudal de entrada (`inletFlow1`) | `____[__]` | l/s | | |
| Caudal de salida (`outletFlow1`) | `____[__]` | l/s | | |
| Presión de entrada (`inletPressure1`) | `____[__]` | psi / bar | | |

**Válvula de entrada on/off (`valve2`)**

| Dato | Valor |
|---|---|
| Palabra de mando | `INT_OUT_____[__]` |
| Bit para ABRIR | bit __ (valor __) |
| Bit para CERRAR | bit __ (valor __) |
| ¿Sostenido o de pulso? | sostenido (queda puesta una de las dos señales) / pulso de ___ ms |
| ¿Hay otros bits de esa palabra en uso? ¿Cuáles? | (Aquora escribe solo sus bits y respeta el resto) |
| Palabra de estado | `INT_IN_____[__]` |
| Codificación del estado | valores o bits de ABIERTA / CERRADA / en recorrido / falla |
| ¿Codificación verificada en campo? | sí / no — por quién y cuándo |

**Válvula de salida proporcional (`valve1`)**

| Dato | Valor |
|---|---|
| % de apertura (realimentación): buffer e índice | `____[__]` |
| Escala de la apertura | 0–100 % / 0–32767 / 4–20 mA / otra: ___ |
| Apertura a partir de la cual se considera abierta | > ___ % (error de cero del transmisor) |
| Consigna: buffer e índice | `REAL_OUT_____[__]` o `INT_OUT_____[__]` |
| Consigna: tipo | REAL / INT |
| Consigna: escala | 0–100 % / 0–32767 / otra: ___ |
| Límites permitidos de la consigna | mínimo ___ % · máximo ___ % |
| Rampa permitida | ___ %/s, o sin rampa |
| ¿Qué hace el PLC local con una consigna fuera de límites? | |
| ¿Existe un modo local/manual que ignore la consigna remota? ¿Dónde se lee? | |

---

## 4. La Leonera: el tanque

De este tanque no se sabe nada todavía: ni dónde llega el nivel, ni sus dimensiones.

| Dato | Valor | Para qué lo usa Aquora |
|---|---|---|
| Nivel: buffer e índice | `____[__]` | señal `tank1Level` |
| Unidad del nivel | m (si llega en otra, decirlo) | |
| Altura útil (nivel de tanque lleno) | ___ m | `opMax`: rebose y % de llenado |
| Nivel mínimo operativo | ___ m | `opMin`: aviso de nivel bajo y autonomía |
| Volumen, si el PLC lo calcula: buffer e índice | `____[__]` | señal `tank1Volume` (m³) |
| Rango del sensor de nivel | ___ a ___ m | límites de validez (`min`/`max`) |

---

## 5. Cómo se nombran en Aquora (para el equipo)

Es la convención que ya usa el resto del sistema. La app la sigue desde la Fase 2
(`apps/mobile/services/valves.ts`).

| Clave (`domainKey`) | Qué es | Cómo se declara |
|---|---|---|
| `inletFlow1` / `outletFlow1` | caudal de entrada / de salida | `realIn`, `unit: "l/s"` |
| `inletPressure1` | presión de entrada | `realIn`, `unit: "psi"` (o la que entregue el integrador) |
| `valve1Position` | % de apertura de la válvula de **salida** (proporcional) | `realIn`, `unit: "%"`, `min: 0`, `max: 100`, con `label` y `flowDomainKey: "outletFlow1"` |
| `valve1` | mando de la válvula de **salida** | **no se declara** hasta la Fase 4 (consigna); hasta entonces la válvula se ve pero no se manda |
| `valve2` | válvula de **entrada** on/off | como en La Vorágine: palabra de mando en `intOut`, `flowDomainKey: "inletFlow1"` |
| `tank1Level` / `tank1Volume` | nivel (m) y volumen (m³) del tanque, solo La Leonera | `realIn`, con `opMin`/`opMax` del operador |

La numeración es la de La Vorágine: `valve1` es la salida y `valve2` la entrada. `min`/`max` son
límites de validez física (caudal 0–1000 l/s, presión −15 a 232 psi, nivel 0–20 m), no
capacidades de diseño. `opMin`/`opMax` son el rango operativo que entrega el operador.

---

## 6. Qué hace el equipo al recibir la ficha (Fase 3)

**Ruta R3**: toca el contrato OPC UA de producción. Nada de esto se hace antes de que los tags
existan en el PLC.

1. **Herramienta de descubrimiento.** Agregar los tokens de sitio en `tools/plc-discovery`:
   `src/heuristics/tokens.ts` (`SITES`), `src/verify-phase0.ts` (`SITES` y `ORDER`) y
   `src/observe-liveness.ts` (sus listas de sitios). Antes, revisar el `rootPath` de
   `tools/plc-discovery/config/discovery.config.json`: hoy empieza por `"AQUATECH"` y el mapping ya
   usa el namespace `AQUATECH4`.
2. **Browse de SOLO LECTURA** por la VPN, con la fachada `ReadOnlySession`, que no expone escritura.
   Confirma que los tags existen y da sus GUID, tipos y tamaños. También lee DN/ER/TO de la MSG
   primaria. Ninguna escritura.
3. **Mapping, a mano.** En `apps/api/config/opc_mapping.json`, por planta:
   - `opcBuffers` con los buffers reales, cada uno con `{ nsUri: "AQUATECH4", identifier: "g=…" }`;
   - `connection` con la MSG primaria como `sourceBuffer`, DN/ER/TO como nodos, `mappingStatus`
     `mapped` y la `confidence` que respalde la lectura;
   - `signals` con las claves de la sección 5, cada una con su `label`.

   **No correr `npm run generate:mapping`.** Es destructivo: borra las válvulas y devuelve el nsUri
   a `AQUATECH`.
4. **Válvula de entrada (`valve2`).**
   - **Con los códigos del integrador**: write spec en `bitmask` (`sustained: true` si el mando es
     sostenido; `pulse` si es de pulso), con `_riesgo` que diga quién lo entregó y cuándo, y
     `flowDomainKey: "inletFlow1"`. El estado queda en `stateVerified: false` hasta verificarlo en
     campo.
   - **Sin códigos**: patrón ANCLA, `writable: false` con un `_nota` que explique que el índice no
     es por dónde se manda.
5. **Tests.** Actualizar las listas fijas de `apps/api/test/command-mapping.test.ts` (`conCanal`,
   hoy 10; `CON_DOS_VALVULAS`; la entrega del integrador; las listas de `close` y de sostenidas) y
   dar la vuelta a `apps/api/test/plantas-en-integracion.test.ts`, que hoy fija que estas cuatro
   no tienen buffers ni señales. Se ajusta, no se borra.
6. **Generador.** Reflejar los sitios en `apps/api/scripts/generate-mapping.ts` (`SITES`, `ORDER`,
   `SLUG`, `DISPLAY` y sus `notes`), para que una regeneración futura no las borre.
7. **Verificación.** `npm run validate:mapping -w @ptap/api`, `npm test -w @ptap/api` y
   `npm run generate:catalog -w @ptap/api` (regenera `docs/DATA_CATALOG.md`).
8. **Despliegue**, aparte y con confirmación explícita. El backend cachea el mapping y hay que
   reiniciarlo. La lista de plantas de la app está horneada en el APK.

Con buffers declarados, la frescura de cada planta pasa a la regla normal (`live`/`stable`/`frozen`
según se muevan sus datos). La regla de "sin buffers, `frozen` desde el arranque" solo aplica
mientras no tenga ninguno.

**Fase 4, fuera de esta ficha:** mandar la consigna 0–100 % de la válvula de salida. Necesita
autorización explícita de Operación, los datos de la sección 3 sobre la consigna, y cambios de
código que hoy no existen: valor en el comando, escala y límites en el write spec, y read-back con
tolerancia.

---

## 7. Decisiones tomadas por defecto

- **Slugs `cabuyo`, `luisa`, `leonera` y `gloria`** (sin artículo, como `voragine` o `sirena`). El
  slug es la identidad permanente de la planta: queda grabado en `users.plant`, en `command_log` y
  en los avisos. Cambiarlo después cuesta una migración de datos.
- **Nombres visibles provisionales** ("Cabuyo", "La Luisa", "La Leonera", "Gloria", con
  `displayNameProvisional: true`). Se cambian sin costo cuando la planta confirme por escrito su
  nombre oficial.
- **Orden:** al final de la lista, en el orden en que el cliente las nombró.
