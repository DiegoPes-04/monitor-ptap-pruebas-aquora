# Pruebas locales de válvulas — sin VPN, sin VM, sin PLC

Para ensayar en local la asignación de bits y canales de válvulas (1, 2 o 3 por planta, en la misma
palabra `INT_OUT`, en `bitOut` o en buffers distintos) contra un **PLC simulado**, y que al volver la
VPN solo quede la prueba de campo.

> El simulador ejecuta **lo que dice el mapping**. No sabe si eso es verdad en la planta: un
> `confirmed` en local no prueba nada del PLC real. Lo que solo el campo puede probar está en la
> [checklist del final](#6-pendiente-de-campo-al-volver-la-vpn).

## 1. Arrancar

Requisitos: el repo instalado y **MySQL local** (el del `.env`: login, auditoría, `command_log` y
bandeja lo necesitan). No hace falta VPN, ni la VM, ni correo, ni Odoo (la API no usa Odoo).

```bash
npm run db:migrate -w @ptap/api        # una vez
npm run db:seed-admin -w @ptap/api     # una vez (usa SEED_ADMIN_* del .env)
npm run dev:sim                        # API completa + simulador, escenario "valvulas-de-prueba"
```

Variantes:

```bash
npm run dev:sim -- produccion                      # el mapping REAL contra el simulador
npm run dev:sim -- enclavamiento-latch             # el PLC local enclava con el flanco
npm run dev:sim -- ruta/a/mi-escenario.json        # un escenario propio (nombre, o ruta desde donde lanzas npm)
npm run dev:sim -w @ptap/api -- --check mi-escenario   # solo valida, sin arrancar y sin MySQL
```

Después, la app: `npm run web` (Expo web en `:8081`; `CORS_ORIGINS` debe incluir
`http://localhost:8081`, como en `.env.example`) o la app nativa apuntando a la IP de este equipo.
Entra con el admin sembrado: tiene `control_valves` y ve todas las plantas.

Recién arrancada, espera unos segundos antes de mandar: el interlock exige que la planta esté `live`
(dos frames con algún cambio). Una orden inmediata sale **409 `INTERLOCK_FAILED: snapshot stable`**,
como en producción. Una orden de abrir tarda lo que el sostenido del mapping (45 s), igual que en campo.

**Qué fuerza `dev:sim`, solo en su proceso** (el `.env` no se toca; dotenv no pisa lo ya definido):

| Variable | Valor | Por qué |
|---|---|---|
| `CONNECTIVITY_PROVIDER` | `simulator` | Nunca habla con el PLC real. |
| `OPCUA_WRITES_ENABLED` | `true` | Para poder mandar órdenes. |
| `OPC_SECURITY_MODE` / `OPC_IDENTITY` / `OPC_USERNAME` / `OPC_PASSWORD` | `SignAndEncrypt` / `username` / ficticios | Emula una sesión segura y así pasa la precondición dura del WriteService **igual que la evalúa el adaptador real**. Con provider=simulator no se abre ninguna conexión. |
| `OPCUA_ALLOW_INSECURE_WRITES` | `false` | **No se usa.** Con el PLC real abre escrituras sobre una sesión sin cifrar. |
| `EMAIL_TRANSPORT` | `console` | Ningún correo real. |
| `ROUTE_PROBE_ENABLED` | `false` | Sin VPN la sonda de ruta al PLC solo registraría fallos. |
| `SIM_SCENARIO`, `OPC_MAPPING_PATH` | los del escenario | Toda la app lee **el mismo** mapping. |

Antes de arrancar, `dev:sim` pasa el mapping por **el mismo gate de CI** (`validate:mapping`: schema
y reglas semánticas) y el escenario por su validación contra ese mapping. Si MySQL no responde, lo dice
y sale.

Un mapping de prueba lleva `generatedFrom.simulationOnly: true`: con `CONNECTIVITY_PROVIDER=opcua` el
backend **se niega a arrancar** con él. Sus bits nunca pueden llegar al PLC real.

## 2. Qué simula

| Pieza | Comportamiento |
|---|---|
| Buffers de **salida** | Llevan lo escrito o su valor inicial (0/false, o el del escenario), nunca ruido. Lo escrito aparece en los frames. |
| Buffers de **entrada** sin dueño | Valores sintéticos que cambian: mantienen la planta `live`, que el interlock exige para mandar. |
| **MSG maestro→local** | El PLC local ve una **copia** de la palabra que se refresca cada `msgCycleMs` (8 s, medido en La Sirena). Lo que se pone y se quita entre dos muestreos **no llega**. |
| **MSG de vuelta** | La realimentación llega al maestro cada `feedbackCycleMs` (por defecto, igual que la ida). |
| Válvula | Posición 0→1 en `travelMs`. `hold`: se mueve solo mientras el verbo está en la copia local; si se suelta antes, se queda **a medias**. `latch`: basta el flanco. El verbo contrario a mitad de recorrido lo invierte. |
| **ERROR** | Abrir y cerrar a 1 a la vez. Se registra como **violación** en el instante en que una escritura deja así la palabra del maestro (aunque dure 1 ms), con log `⛔` y contador. La válvula entra en **ERROR** cuando el PLC local lo ve: se para y no sale hasta un rearme. |
| Latencia OPC UA | `ioLatencyMs` por petición; la escritura surte efecto a mitad del viaje. |
| Destino | Con escenario se valida como en el adaptador real: un `sourceBuffer` mal escrito, un canal que no casa o un índice fuera de rango fallan aquí, igual que fallarían en el PLC (`WRITE_REJECTED`). |

**Consecuencia del muestreo**: el PLC local ve el bit un número **entero** de ciclos. Con 45 s
sostenidos y MSG de 8 s son 5 o 6 ciclos (**40 o 48 s**, según la fase), no "entre ~37 y ~53 s".
Un recorrido de hasta 40 s llega siempre al tope; uno de 44 s, solo con algunas fases (hay test).

**Realimentación `auto`** (por defecto). Es un PLC IDEAL: hace lo que el mapping declara y nada más.

- `readBack`: escribe el valor que el WriteService espera para cada estado (`expectedByCommand`, o el
  verbo con `confirmsWrittenValue`, o `expectedValue`). Moviéndose, a medias o en error pone el valor
  neutro: 0 (sin bit14) o `false`, o el `otherStateValue` del escenario.
  **No se emula** si el mapping no declara ningún valor esperado (Carbonero hoy) ni si es **ambiguo**
  (el mismo valor para abrir y para cerrar, como el `16385` de La Vorágine). El aviso sale en el log
  y en el diagnóstico.
- `pulse.until`: vale `equals` solo con el verbo puesto en el PLC local y la válvula en **ese** tope.
  En reposo vale `untilIdleValue` (Vorágine: 1025).
- `valveNState` con `stateEncoding`: los literales declarados (Cascajal: 251 = cerrada).
- Caudal de la válvula (`flowDomainKey`): proporcional a la apertura. Es lo que mira la app cuando
  la palabra de estado no es fiable.

Con `feedback: "none"` no se emula nada (un PLC que no informa). Con `feedbackElements` se declaran
a mano los valores de un elemento por estado (`open`, `closed`, `moving`, `mid`, `error`).

**Diagnóstico** (solo con el simulador; JWT + `system_config`, auditado por `/api/opc`):

```bash
TOKEN=$(curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"...","password":"..."}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:4000/api/opc/sim -H "authorization: Bearer $TOKEN"                    # válvulas, ciclos, contadores
curl -s 'localhost:4000/api/opc/sim/writes?limit=20' -H "authorization: Bearer $TOKEN"  # lo que salió por el cable
curl -s localhost:4000/api/opc/sim/violations -H "authorization: Bearer $TOKEN"         # debe estar vacío
curl -s -X POST localhost:4000/api/opc/sim/valves/sim-tres/valve2/error -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"reason":"probar la app"}'
curl -s -X POST localhost:4000/api/opc/sim/valves/sim-tres/valve2/reset -H "authorization: Bearer $TOKEN"
curl -s -X POST localhost:4000/api/opc/sim/valves/sim-tres/valve2/mode -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"latchMode":"latch"}'
```

## 3. Declarar un escenario (1, 2 o 3 válvulas)

Los escenarios viven en `apps/api/fixtures/sim-scenarios/` y **no tocan** `config/opc_mapping.json`:

| Archivo | Para qué |
|---|---|
| `valvulas-de-prueba.json` | Por defecto. Mapping de prueba con `sim-una` (1 válvula, bit0/bit1), `sim-dos` (2 en `INT_OUT[0]`: 0/1 y 2/3), `sim-tres` (3 en `INT_OUT[0]`: 0/1, 2/3 y 4/5) y `sim-buffers` (absoluta 1/2, máscara 4096/8192 en otro `INT_OUT` con `pulse.until`, dos bobinas en `bitOut`). |
| `enclavamiento-latch.json` | El mismo, con el PLC local en `latch`. |
| `produccion.json` | El mapping REAL con los supuestos de campo. Carbonero con `feedback: none`. |
| `mappings/valvulas-de-prueba.json` | El mapping de prueba. Pasa `validate:mapping`. |

```jsonc
{
  "name": "mi-asignacion",
  "mapping": "mappings/mi-mapping.json",   // relativo a este archivo; ausente = el de la app
  "ioLatencyMs": 50,                        // por petición OPC UA
  "defaults": { "travelMs": 30000, "latchMode": "hold", "initialState": "closed",
                "feedback": "auto", "flowOpen": 10, "msgCycleMs": 8000, "msgPhaseMs": 0 },
  "plants":  { "sim-tres": { "msgCycleMs": 4000, "feedbackCycleMs": 8000 } },
  "valves":  { "sim-tres/valve3": { "latchMode": "latch", "travelMs": 20000,
               "feedbackElements": [{ "element": "INT_IN_SIM_TRES[5]", "open": 1, "closed": 2, "moving": 3 }] } },
  "initialValues": { "sim-tres/INT_OUT_SIM_TRES[0]": 42 }   // p. ej. tres CERRAR enclavados
}
```

Un escenario con un campo desconocido, o que nombre una planta, válvula, verbo, buffer o índice que el
mapping no tiene, **no arranca**: dice qué y por qué. Nunca degrada en silencio a los valores por
defecto.

Para un **mapping de prueba propio**, copia `mappings/valvulas-de-prueba.json`:

- `generatedFrom.simulationOnly: true`, siempre.
- Varias válvulas en la **misma palabra**: `mode: "bitmask"` y `pulse`. Cada una con **sus** bits; que
  no compartan ninguno.
- `validate:mapping` rechaza dos señales en el mismo `canal[índice]` (agrupa por canal, no por buffer).
  La señal `valveN` se **ancla** en otro índice libre y `write.target` apunta a la palabra compartida.
  La app no usa el valor de la señal de válvula para el estado.
- `npm run dev:sim -w @ptap/api -- --check <escenario>` pasa el mapping por el gate de CI.

> **Ojo**: corregir los campos de mando (`writeCommands`, `writeMode`, `writeIndex`) desde el editor de
> mapeo de la app cambia lo que **muestra** la app, pero **no** lo que escribe el WriteService (el
> `CommandMappingResolver` lee el JSON). Las asignaciones de bits van en el JSON.

## 4. Qué cubren los tests

`npm run test:sim -w @ptap/api` (también corren en `npm test`). Usan **relojes falsos**, así que los
sostenidos son los reales (45 s) y la MSG cicla cada 8 s sin esperar de verdad.

| Archivo | Cubre |
|---|---|
| `sim-valvulas-e2e.test.ts` | WriteService real + simulador (+ pipeline real en el primero). **1 válvula**: abrir y cerrar `confirmed` y el estado visible en el snapshot de la app. **2 y 3 válvulas en la misma palabra**: cada orden solo mueve sus bits; la exclusión solo apaga el verbo contrario de la misma válvula; ninguna escritura del historial deja abrir+cerrar a 1. **Concurrencia**: B durante el sostenido de A; barrido de 81 desfases alrededor de la limpieza de A; dos órdenes simultáneas. **Hold/latch y MSG**: sostenido corto entre muestreos (no mueve); sostenido corto que coge un muestreo (a medias en hold, completa en latch); 45 s cubre la MSG si el recorrido es ≤ 40 s. **Carbonero real** sale `sent`. **Buffers distintos** y `bitOut`. |
| `sim-plc.test.ts` | El modelo: salidas sin ruido, valores iniciales, MSG, hold/latch, ERROR y violaciones, realimentación, historial acotado, destino estricto, latencia, perillas. |
| `sim-escenarios.test.ts` | Escenarios versionados y mapping de prueba contra `validate:mapping`; errores de forma y de coherencia; `SIM_SCENARIO`; el mapping de prueba no arranca contra el PLC real (cableado real del módulo). |
| `sim-controller.test.ts` | `/api/opc/sim`: 401/403/200, perillas, validación, 404 sin simulador. |

## 5. Hallazgos de esta tanda

1. **Carrera read-modify-write en la misma palabra — ARREGLADA.** `enCurso` reserva la válvula, no la
   palabra: la limpieza del pulso de A (leer, escribir) y la activación de B (leer, escribir) son dos
   idas al PLC cada una, y se entrelazaban. Con 100 ms por petición: si la orden de B llegaba en los
   ~100 ms **anteriores** a la limpieza de A, **la orden de B se perdía** (bit borrado, eco falso,
   válvula quieta, operador viendo "enviada"); si llegaba en los ~100 ms **posteriores**, **el bit de
   abrir de A resucitaba y quedaba puesto para siempre**. En el barrido del test fallaban 20 de 81
   desfases, y dos órdenes simultáneas perdían la primera. Arreglo mínimo en `write.service.ts`
   (`turnoDe`): un turno por elemento que serializa leer→escribir→eco de la activación y leer→escribir
   de la limpieza. Dura milisegundos, nunca el sostenido.
2. **Rollback en `bitmask` sin pulso pisa la palabra entera — NO arreglado.** Si la confirmación falla,
   `rollbackSteps` escribe `rollbackValue` en absoluto. Con otra válvula en la misma palabra, borra su
   bit (comprobado: `4→5, 5→0`). Hoy no se alcanza: todas las válvulas en máscara del mapping real
   llevan pulso, y `command-mapping.test.ts` lo vigila. **No asignéis válvulas compartidas sin
   `pulse`.**
3. **Overrides de mando desde la app no llegan al WriteService — NO arreglado** (ver §3).
4. **40 o 48 s, no "~37–53 s"** (ver §2): con recorridos de más de 40 s, el sostenido de 45 s no basta
   con todas las fases.

## 6. Pendiente de campo al volver la VPN

El simulador no puede probar nada de esto:

- [ ] **Codificación real**: qué bit o valor abre y cuál cierra cada válvula nueva. Se captura con el
      probador de canales y un testigo humano mirando la válvula, en ventana acordada, con el liveness
      comprobado y el valor previo anotado (procedimiento en `docs/plc/04_commands.json`).
- [ ] **Enclavamiento real** del PLC local: ¿hay que sostener el bit (`hold`) o basta el flanco
      (`latch`)? Pregunta abierta al integrador.
- [ ] **Recorrido real** de cada válvula (aquí se suponen 30 s). Si pasa de 40 s, el sostenido de 45 s
      puede dejarla a medias.
- [ ] **Ciclo real de la MSG** maestro→local de cada sitio (8 s solo está medido en La Sirena) y el de
      vuelta (`MSG_READ`).
- [ ] **Realimentación real**: qué elemento de `INT_IN` cambia y con qué valores (abierta, cerrada,
      moviéndose, error). Hasta entonces, `stateVerified: false`.
- [ ] **ERROR real**: qué hace el PLC con abrir y cerrar a 1. ¿Se enclava? ¿Cómo se rearma? ¿Se ve en
      algún `INT_IN`?
- [ ] **Latencia OPC UA real** por petición. La carrera ya está cerrada, pero conviene medirla.
- [ ] **Tipos de dato reales** (`Int16` con el bit15, `Boolean` en `bitOut`): el simulador no los valida.
- [ ] **Bits ajenos** de la palabra (en Carbonero, del 2 al 15) e **interlocks propios** del PLC local:
      no se conocen y el simulador no los tiene.
- [ ] **Tiempos de cliente**: 45 s de sostenido más latencias reales frente al timeout de la app (~60 s en
      iOS).
