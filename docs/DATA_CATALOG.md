# Catálogo de datos — Monitor PTAP

> **GENERADO** desde `apps/api/config/opc_mapping.json` (v0.14.0). NO editar a mano:
> se regenera con `npm run generate:catalog -w @ptap/api` (y automáticamente con `generate:mapping`).

Registro de los datos que entrega el backend de telemetría: qué señales existen por
planta, cómo llamarlas y cómo tratarlas en el front. El backend entrega datos estables
y completos con sus metadatos; la **interpretación** de los valores es del equipo
frontend en diálogo con el cliente.

## Cómo consumir los datos

### REST (carga inicial / resincronización)

| Endpoint | Devuelve |
|---|---|
| `GET /api/plants` | Lista de plantas: `plantId`, `displayName`, `liveness`, `bridgeStatus` |
| `GET /api/plants/:plantId/snapshot` | `PlantSnapshotDto` de la planta (cache RAM, sin tocar el PLC) |

Base URL: puerto `:4000` del backend de telemetría (`npm run start:telemetry -w @ptap/api`).
En la app móvil se configura en `app.json → expo.extra.apiBaseUrl`.

### Socket.IO (push en tiempo real — el front NO hace polling)

| Acción | Evento | Payload |
|---|---|---|
| Suscribirse a una planta (al conectar y en cada reconexión) | emit `opc:subscribe` | `{ plantId }` |
| Recibir snapshot (solo cuando algo cambia) | on `opc:snapshot` | `PlantSnapshotDto` |
| Recibir cambios de frescura (broadcast, todas las plantas) | on `opc:liveness` | `{ plantId, state, lastChangeAt, windowSec }` |

`sequence` es monótono por planta: si llega N+2 sin haber visto N+1, hubo un hueco —
resincronizar por REST (el hook `useSnapshot` de la app móvil ya implementa este patrón).

### Contrato `SignalDto` (cada entrada de `snapshot.signals`)

| Campo | Tipo | Significado |
|---|---|---|
| `value` | `number \| boolean \| null` | Valor crudo del PLC. `null` = no hay número (NaN/∞ del PLC o buffer ausente) |
| `unit` | `string \| null` | Unidad de ingeniería (`l/s`, `psi`, `m`, `m³`, `NTU`, `mg/L`, `µS/cm`, `pH`, `°C`) |
| `quality` | `Good \| Bad \| Uncertain` | Calidad OPC UA reportada por el servidor |
| `usable` | `boolean` | Veredicto del backend (calidad + rango de validez + frescura). **Metadato**: no oculta el valor |
| `reason` | `BAD_QUALITY \| INVALID_NUMBER \| OUT_OF_RANGE \| BRIDGE_STALE` | Presente solo si `usable=false`; por qué |
| `mappingStatus` | `mapped \| unmapped` | Si el índice tiene semántica asignada |
| `confidence` | `confirmed \| inferred \| estimated` | Solidez de la semántica (ver Convenciones) |
| `label` | `string \| null` | Nombre humano en español, listo para mostrar |
| `ts` | `string \| null` | SourceTimestamp OPC UA de la última muestra |
| `opMin` / `opMax` | `number` (opcionales) | Rango operativo entregado por el operador. El front lo MUESTRA junto al valor ("Mín: 1.00  Máx: 3.00", como en la app original) para que el cliente interprete la lectura |

### Política de visualización (acordada 2026-07-15)

**Si `value` es un número, se muestra tal cual, en cualquier planta.** Incluye valores
congelados (`BRIDGE_STALE`), negativos o fuera de escala (`OUT_OF_RANGE`): un -57 psi
significa algo y el cliente lo detecta precisamente porque está fuera de escala.
"sin dato" queda reservado para `value: null`. Los metadatos (`usable`, `reason`,
`quality`, `liveness`) viajan siempre en el DTO y quedan a disposición del front y el
cliente para las interpretaciones que acuerden (alarmas, avisos de congelado, etc.).

## Convenciones para el front

- **Identidad = (`plantId`, `domainKey`).** Los índices de array NO son transferibles
  entre plantas: `realIn[5]` es caudal en Montebello y nivel de tanque en Campoalegre.
  Nunca direccionar por índice.
- **domainKeys**: `inlet*`/`outlet*` + magnitud (`inletFlow1`, `outletPressure2`, …).
  Tanques propios: `tank<N>Level` (m) y `tank<N>Volume` (m³).
- **Pantalla Tanques**: se alimenta sola de `tank<N>Level/Volume`. En la app móvil,
  `apps/mobile/services/tanks.ts` concentra la regla: `isTankSignal()` (excluir tanques
  de listados generales de sensores), `EXTERNAL_TANKS` (tanques de otras plantas
  retransmitidos, p. ej. San Antonio y El Quijote vía Soledad) y `FULL_LEVEL_M`
  (niveles de tanque lleno confirmados, para % de llenado).
- **`min`/`max`** = rango de VALIDEZ física (produce `usable`/`OUT_OF_RANGE`, metadato).
  **`opMin`/`opMax`** = rango OPERATIVO/normativo entregado por el operador — insumo
  para alarmas o avisos que el front acuerde con el cliente.
- **`confidence: inferred`** = semántica confirmada por el operador vía HMI, sin
  documento oficial en el repo. `confirmed` exige documento en `docs/plant-documentation/`.
- **`liveness.state`** (`live | idle | stale | unknown`) es la frescura POR PLANTA:
  `unknown/stale` = el PLC maestro no está refrescando ese sitio (las señales llegan
  con el último valor conocido).

## Señales disponibles por planta

### La Vorágine (`voragine`) — 8 señales

Fuente: `INT_OUT_VORAGINE` (Int16[20], nsUri `AQUATECH4`, `g=1505CBA4-0BCF-A4FC-7602-DB5BF940BBC6`)
Fuente: `REAL_IN_VORAGINE` (Float[50], nsUri `AQUATECH4`, `g=93BAFF92-FF57-4877-74E4-B7CC1EFAE6B3`)

| Índice | domainKey | Señal | Unidad | Validez | Rango operativo | Confianza |
|---|---|---|---|---|---|---|
| 0 | `valve1` | Válvula de salida | — | — | — | confirmed |
| 0 | `inletFlow1` | Caudal de entrada | l/s | 0 a 1000 | — | confirmed |
| 1 | `valve2` | Válvula de entrada | — | — | — | confirmed |
| 5 | `tank1Level` | Nivel tanque 1 | m | 0 a 5 | 1 a 1.98 | confirmed |
| 6 | `tank1Volume` | Volumen tanque 1 | m³ | 0 a 10000 | — | confirmed |
| 7 | `outletFlow1` | Caudal de salida | l/s | 0 a 1000 | 1 a 3 | confirmed |
| 12 | `inletPressure1` | Presión de entrada | psi | -15 a 232 | — | confirmed |
| 13 | `outletPressure1` | Presión de salida | psi | -15 a 232 | — | confirmed |

### Soledad (`soledad`) — 19 señales

Fuente: `INT_OUT_SOLEDAD` (Int16[20], nsUri `AQUATECH4`, `g=427B2651-37E3-F583-C156-8620EAD41E7A`)
Fuente: `REAL_IN_SOLEDAD` (Float[50], nsUri `AQUATECH4`, `g=19181A21-F548-3D76-D6D9-EDAA324C20F7`)

| Índice | domainKey | Señal | Unidad | Validez | Rango operativo | Confianza |
|---|---|---|---|---|---|---|
| 0 | `valve1` | Válvula de salida 1 | — | — | — | confirmed |
| 0 | `inletFlow1` | Caudal de entrada | l/s | 0 a 1000 | — | confirmed |
| 2 | `inletTurbidity` | Turbiedad de entrada | NTU | 0 a 1000 | 0.1 a 5 | confirmed |
| 3 | `inletOxygen` | Oxígeno de entrada | mg/L | 0 a 20 | 4 a 15 | confirmed |
| 4 | `conductivity` | Conductividad de entrada | µS/cm | 0 a 10000 | 0.1 a 1000 | confirmed |
| 5 | `inletPh` | pH de entrada | pH | 0 a 14 | 5.5 a 9 | confirmed |
| 6 | `inletTemperature` | Temperatura de entrada | °C | 0 a 50 | 10 a 30 | confirmed |
| 7 | `tank1Level` | Nivel tanque 1 | m | 0 a 5 | 1 a 2.8 | confirmed |
| 8 | `tank1Volume` | Volumen tanque 1 | m³ | 0 a 10000 | — | confirmed |
| 9 | `outletFlow1` | Caudal de salida | l/s | 0 a 1000 | — | confirmed |
| 11 | `outletTurbidity` | Turbiedad de salida | NTU | 0 a 1000 | 0.1 a 1 | confirmed |
| 12 | `outletChlorine` | Cloro de salida | mg/L | 0 a 10 | 0.3 a 2 | confirmed |
| 13 | `outletPh` | pH de salida | pH | 0 a 14 | 6 a 8 | confirmed |
| 14 | `outletTemperature` | Temperatura de salida | °C | 0 a 50 | 10 a 30 | confirmed |
| 20 | `outletPressure1` | Presión de salida | psi | -15 a 232 | 1 a 3 | confirmed |
| 22 | `sanAntonioTankLevel` | Nivel tanque San Antonio | m | 0 a 5 | 1 a 2.5 | inferred |
| 23 | `quijoteTankLevel` | Nivel tanque El Quijote | m | 0 a 5 | 1 a 3 | inferred |
| 30 | `sanAntonioTankVolume` | Volumen tanque San Antonio | m³ | 0 a 10000 | — | inferred |
| 31 | `quijoteTankVolume` | Volumen tanque El Quijote | m³ | 0 a 10000 | — | inferred |

### Montebello (`montebello`) — 7 señales

Fuente: `INT_OUT_MONTEBELLO` (Int16[20], nsUri `AQUATECH4`, `g=11446A3B-37F5-376F-AB42-70AC9D2FC36B`)
Fuente: `REAL_IN_MONTEBELLO` (Float[50], nsUri `AQUATECH4`, `g=EBA8E3EB-53A2-0CCD-3912-501C0F7E4C8F`)

| Índice | domainKey | Señal | Unidad | Validez | Rango operativo | Confianza |
|---|---|---|---|---|---|---|
| 0 | `valve1` | Válvula 1 | — | — | — | confirmed |
| 0 | `inletFlow1` | Caudal de entrada 1 | l/s | 0 a 1000 | — | confirmed |
| 5 | `inletFlow2` | Caudal de entrada 2 | l/s | 0 a 1000 | — | confirmed |
| 10 | `outletFlow1` | Caudal de salida | l/s | 0 a 1000 | — | confirmed |
| 15 | `inletPressure1` | Presión de entrada 1 | psi | -15 a 232 | — | confirmed |
| 16 | `inletPressure2` | Presión de entrada 2 | psi | -15 a 232 | — | confirmed |
| 17 | `outletPressure1` | Presión de salida | psi | -15 a 232 | — | confirmed |

### Cascajal (`cascajal`) — 11 señales

Fuente: `INT_OUT_CASCAJAL` (Int16[20], nsUri `AQUATECH4`, `g=37DF3BEA-3F5A-323A-F63B-1BE2930508C7`)
Fuente: `INT_IN_CASCAJAL` (Int16[20], nsUri `AQUATECH4`, `g=987A872E-DA0B-8C66-51F7-11E6B473591E`)
Fuente: `REAL_IN_CASCAJAL` (Float[50], nsUri `AQUATECH4`, `g=F0C27430-68DC-74D7-BDAB-B9EDCC19F8A7`)

| Índice | domainKey | Señal | Unidad | Validez | Rango operativo | Confianza |
|---|---|---|---|---|---|---|
| 0 | `valve1` | Válvula de salida 1 | — | — | — | confirmed |
| 0 | `outletFlow1` | Caudal de salida 1 | l/s | 0 a 1000 | — | confirmed |
| 1 | `valve2` | Válvula de salida 2 | — | — | — | confirmed |
| 1 | `valve1State` | Estado válvula 1 | — | — | — | confirmed |
| 5 | `tank1Level` | Nivel tanque 1 | m | 0 a 5 | 1 a 3 | confirmed |
| 6 | `tank1Volume` | Volumen tanque 1 | m³ | 0 a 10000 | — | confirmed |
| 7 | `outletFlow2` | Caudal de salida 2 | l/s | 0 a 1000 | — | confirmed |
| 12 | `outletPressure1` | Presión de salida 1 | psi | -15 a 232 | — | confirmed |
| 13 | `outletPressure2` | Presión de salida 2 | psi | -15 a 232 | — | confirmed |
| 14 | `inletFlow1` | Caudal de entrada 1 | l/s | 0 a 1000 | — | confirmed |
| 19 | `inletPressure1` | Presión de entrada | psi | -15 a 232 | — | inferred |

### Km 18 (`km18`) — 9 señales

Fuente: `INT_OUT_KM18` (Int16[20], nsUri `AQUATECH4`, `g=77117D1F-7CFD-82DF-66B8-0C1787E6EF62`)
Fuente: `REAL_IN_KM18` (Float[50], nsUri `AQUATECH4`, `g=1C72A21A-8F36-327C-C0AC-CA7A9AA60D96`)

| Índice | domainKey | Señal | Unidad | Validez | Rango operativo | Confianza |
|---|---|---|---|---|---|---|
| 0 | `valve1` | Válvula 1 | — | — | — | confirmed |
| 0 | `inletFlow1` | Caudal de entrada | l/s | 0 a 1000 | — | confirmed |
| 5 | `tank1Level` | Nivel tanque 1 | m | 0 a 5 | 1 a 2 | confirmed |
| 6 | `tank1Volume` | Volumen tanque 1 | m³ | 0 a 10000 | — | confirmed |
| 7 | `outletFlow1` | Caudal de salida | l/s | 0 a 1000 | — | confirmed |
| 12 | `inletPressure1` | Presión de entrada | psi | -15 a 232 | — | confirmed |
| 13 | `outletPressure1` | Presión de salida | psi | -15 a 232 | — | confirmed |
| 14 | `tank2Level` | Nivel tanque 2 | m | 0 a 5 | 1 a 2 | confirmed |
| 15 | `tank2Volume` | Volumen tanque 2 | m³ | 0 a 10000 | — | confirmed |

### Alto de los Mangos (`alto-los-mangos`) — 7 señales

Fuente: `INT_OUT_ALTO_MANGOS` (Int16[20], nsUri `AQUATECH4`, `g=51716405-AB9C-568A-24F8-7284365397B8`)
Fuente: `DATOS_REAL_IN_MANGOS` (Float[50], nsUri `AQUATECH4`, `g=ECA4ABBE-2E70-B864-5B3D-B2E9D1FB7830`)

| Índice | domainKey | Señal | Unidad | Validez | Rango operativo | Confianza |
|---|---|---|---|---|---|---|
| 0 | `valve1` | Válvula 1 | — | — | — | confirmed |
| 0 | `inletFlow1` | Caudal de entrada | l/s | 0 a 1000 | — | confirmed |
| 5 | `tank1Level` | Nivel tanque 1 | m | 0 a 5 | 1 a 2.5 | confirmed |
| 6 | `tank1Volume` | Volumen tanque 1 | m³ | 0 a 10000 | — | confirmed |
| 7 | `outletFlow1` | Caudal de salida | l/s | 0 a 1000 | — | confirmed |
| 12 | `inletPressure1` | Presión de entrada | psi | -15 a 232 | 1 a 3 | confirmed |
| 13 | `outletPressure1` | Presión de salida | psi | -15 a 232 | 1 a 3 | confirmed |

### Campoalegre (`campoalegre`) — 12 señales

Fuente: `INT_OUT_CAMPOALEGRE` (Int16[20], nsUri `AQUATECH4`, `g=6D54E645-DCEA-C9C8-C768-24252F4E4B08`)
Fuente: `REAL_IN_CAMPOALEGRE` (Float[50], nsUri `AQUATECH4`, `g=E1680D60-7BCD-C892-7257-C4D4AAE41E1C`)

| Índice | domainKey | Señal | Unidad | Validez | Rango operativo | Confianza |
|---|---|---|---|---|---|---|
| 0 | `valve1` | Válvula de salida tanque nuevo | — | — | — | confirmed |
| 0 | `outletFlow1` | Caudal de salida 1 | l/s | 0 a 1000 | — | confirmed |
| 1 | `valve2` | Válvula de salida 2 - Piamonte | — | — | — | confirmed |
| 5 | `tank1Level` | Nivel tanque 1 | m | 0 a 20 | ≥ 1 | confirmed |
| 6 | `tank1Volume` | Volumen tanque 1 | m³ | 0 a 10000 | — | confirmed |
| 7 | `outletFlow2` | Caudal de salida 2 | l/s | 0 a 1000 | — | confirmed |
| 12 | `outletPressure1` | Presión de salida 1 | psi | -15 a 232 | — | confirmed |
| 13 | `outletPressure2` | Presión de salida 2 | psi | -15 a 232 | — | confirmed |
| 14 | `tank2Level` | Nivel tanque 2 | m | 0 a 20 | ≥ 1 | confirmed |
| 15 | `tank2Volume` | Volumen tanque 2 | m³ | 0 a 10000 | — | confirmed |
| 16 | `tank3Level` | Nivel tanque 3 | m | 0 a 20 | ≥ 1 | confirmed |
| 17 | `tank3Volume` | Volumen tanque 3 | m³ | 0 a 10000 | — | confirmed |

### Pichindé (`pichinde`) — 3 señales

Fuente: `INT_OUT_PICHINDE` (Int16[20], nsUri `AQUATECH4`, `g=9FC0167E-8E1C-6CC2-CF08-14AF586F6C15`)
Fuente: `REAL_IN_PICHINDE` (Float[50], nsUri `AQUATECH4`, `g=C9C97734-E939-9008-A41E-9CA37BB7A2D0`)

| Índice | domainKey | Señal | Unidad | Validez | Rango operativo | Confianza |
|---|---|---|---|---|---|---|
| 0 | `valve1` | Válvula 1 | — | — | — | confirmed |
| 10 | `inletPressure1` | Presión de entrada | psi | -15 a 232 | — | inferred |
| 11 | `outletPressure1` | Presión de salida | psi | -15 a 232 | — | inferred |

### Carbonero (`carbonero`) — 13 señales

Fuente: `INT_OUT_CARBONERO` (Int16[20], nsUri `AQUATECH4`, `g=BFC8CF7B-FC4C-21FB-16A4-8EF12A2D9F4B`)
Fuente: `REAL_IN_CARBONERO` (Float[50], nsUri `AQUATECH4`, `g=A1323D1F-4114-A49D-746E-D6DDBB3C7DE3`)

| Índice | domainKey | Señal | Unidad | Validez | Rango operativo | Confianza |
|---|---|---|---|---|---|---|
| 0 | `valve1` | Válvula 1 | — | — | — | confirmed |
| 0 | `inletFlow1` | Caudal de entrada | l/s | 0 a 1000 | — | confirmed |
| 2 | `inletTurbidity` | Turbiedad de entrada | NTU | 0 a 1000 | 0 a 5 | confirmed |
| 3 | `inletOxygen` | Oxígeno de entrada | mg/L | 0 a 20 | 4 a 15 | confirmed |
| 4 | `conductivity` | Conductividad | µS/cm | 0 a 10000 | 0.1 a 1000 | confirmed |
| 5 | `inletPh` | pH de entrada | pH | 0 a 14 | 5.5 a 9 | confirmed |
| 6 | `inletTemperature` | Temperatura de entrada | °C | 0 a 50 | 10 a 30 | confirmed |
| 7 | `tank1Level` | Nivel tanque 1 | m | 0 a 5 | 1 a 2.8 | confirmed |
| 8 | `tank1Volume` | Volumen tanque 1 | m³ | 0 a 10000 | — | confirmed |
| 11 | `outletTurbidity` | Turbiedad de salida | NTU | 0 a 1000 | 0 a 1 | confirmed |
| 13 | `outletPh` | pH de salida | pH | 0 a 14 | 6 a 8 | confirmed |
| 14 | `outletTemperature` | Temperatura de salida | °C | 0 a 50 | 10 a 30 | confirmed |
| 20 | `outletPressure1` | Presión de salida | psi | -15 a 232 | 1 a 3 | confirmed |

### La Sirena (`sirena`) — 23 señales

Fuente: `INT_IN_SIRENA` (Int16[10], nsUri `AQUATECH4`, `g=184E4071-DC15-213A-3DE8-442A4E0A354B`)
Fuente: `INT_OUT_SIRENA` (Int16[20], nsUri `AQUATECH4`, `g=4AB6ECB4-D019-D4F1-A8A8-6177C3FE3278`)
Fuente: `REAL_IN_SIRENA` (Float[50], nsUri `AQUATECH4`, `g=A7B368C5-2F51-723A-8108-500CFEB52374`)

| Índice | domainKey | Señal | Unidad | Validez | Rango operativo | Confianza |
|---|---|---|---|---|---|---|
| 0 | `valve1State` | Estado de la válvula 1 | — | — | — | inferred |
| 0 | `valve1` | Válvula 1 | — | — | — | confirmed |
| 0 | `inletFlow1` | Caudal de entrada | l/s | 0 a 1000 | — | confirmed |
| 2 | `inletTurbidity` | Turbiedad de entrada | NTU | 0 a 1000 | — | confirmed |
| 3 | `inletOxygen` | Oxígeno de entrada | mg/L | 0 a 20 | — | confirmed |
| 4 | `conductivity` | Conductividad de entrada | µS/cm | 0 a 10000 | — | confirmed |
| 5 | `inletPh` | pH de entrada | pH | 0 a 14 | — | confirmed |
| 6 | `inletTemperature` | Temperatura de entrada | °C | 0 a 50 | — | confirmed |
| 7 | `tank1Level` | Nivel tanque 1 | m | 0 a 5 | 1 a 2.8 | confirmed |
| 8 | `tank1Volume` | Volumen tanque 1 | m³ | 0 a 10000 | — | confirmed |
| 9 | `outletFlow1` | Caudal de salida | l/s | 0 a 1000 | — | confirmed |
| 11 | `outletTurbidity` | Turbiedad de salida | NTU | 0 a 1000 | — | confirmed |
| 12 | `outletChlorine` | Cloro de salida | mg/L | 0 a 10 | — | confirmed |
| 13 | `outletPh` | pH de salida | pH | 0 a 14 | — | confirmed |
| 14 | `outletTemperature` | Temperatura de salida | °C | 0 a 50 | — | confirmed |
| 20 | `inletPressure1` | Presión de entrada | psi | -15 a 232 | — | confirmed |
| 21 | `outletPressure1` | Presión de salida | psi | -15 a 232 | — | confirmed |
| 22 | `tank2Level` | Nivel tanque 2 | m | 0 a 5 | 1 a 2.5 | confirmed |
| 23 | `tank3Level` | Nivel tanque 3 | m | 0 a 5 | 1 a 2.5 | confirmed |
| 24 | `tank4Level` | Nivel tanque 4 | m | 0 a 5 | 1 a 2.5 | confirmed |
| 30 | `tank2Volume` | Volumen tanque 2 | m³ | 0 a 10000 | — | confirmed |
| 31 | `tank3Volume` | Volumen tanque 3 | m³ | 0 a 10000 | — | confirmed |
| 32 | `tank4Volume` | Volumen tanque 4 | m³ | 0 a 10000 | — | confirmed |

### Plantas sin señales mapeadas aún

- San Antonio (`san-antonio`)
- El Quijote (`quijote`)
- Cabuyo (`cabuyo`)
- La Luisa (`luisa`)
- La Leonera (`leonera`)
- Gloria (`gloria`)

## Cómo se registra una planta nueva

1. Agregar sus señales a `SIGNALS_BY_SITE` en `apps/api/scripts/generate-mapping.ts`
   (si el sitio tiene varios buffers del mismo canal e igual tamaño, declarar `sourceBuffer`).
2. `npm run generate:mapping -w @ptap/api` (regenera mapping y este catálogo).
3. `npm run validate:mapping -w @ptap/api` y `npm test -w @ptap/api`.
4. Reiniciar el backend de telemetría para que cargue el mapping nuevo.

## Notas vigentes del mapping

- Identidad canónica = plantId (slug). No usar nombres del frontend ni ptap-N.
- CONFIRMACIÓN DE SEMÁNTICA (2026-07-21): el cliente confirmó que la semántica mapeada corresponde a lo que hoy está registrado en cada planta, elevando a confidence:confirmed las confirmaciones que el operador ya había dado por HMI (2026-07-14/15). Antes se mantenían en inferred a la espera del L5X o de un documento oficial. 89 de 96 señales quedan confirmed.
- EXCEPCIONES que siguen en confidence:inferred (7 señales), no por falta de confirmación sino porque hay evidencia abierta que la contradice: (1) cascajal.inletPressure1 lee ~384 psi, por encima del máximo de validez física (232 psi) — índice/unidad/escala a contrastar contra el HMI; (2) los 4 tanques sanAntonioTank*/quijoteTank* mapeados bajo soledad, pendientes de migrar a sus plantas; (3) las 2 presiones de pichinde, mientras el sitio siga bajo sospecha de ser anidado hijo. Se confirmarán al cerrar cada duda.
- Los min/max NO son capacidades de diseño: siguen siendo bounds de validez FÍSICA (caudal 1000 l/s; presión 232 psi = 16 bar; nivel 20 m; volumen 10000 m³) para detectar lecturas imposibles. Sustituirlos por las capacidades reales queda pendiente de que la planta las entregue; confirmar la semántica no las convierte en dimensiones reales.
- Las referencias a nodos usan { nsUri, identifier } SIN índice de namespace. El adaptador de Fase 1 DEBE resolver nsUri → índice vía ReadNamespaceArray en CADA conexión y reconexión (el índice de Optix puede cambiar entre reinicios), usando scripts/resolve-namespaces.ts.
- Si un nsUri del mapping NO está en el NamespaceArray del servidor: NamespaceNotFoundError ⇒ BridgeStatus = Faulted (NO Recovering: no se arregla reintentando). Prohibido fallback a ns=0 o a un índice previo.
- MANGOS y ALTO_MANGOS fusionados en alto-los-mangos (confirmado). SAN_ANTONO normalizado a san-antonio.
- Sin export L5X: casi TODA señal de proceso sigue unmapped (signals: []). Única semántica confirmada por lectura: connection (DN/ER/TO de MSG_READ). Ver docs/plc/OBSERVACIONES_FASE0.md §1 y §2.
- Excepción: montebello.signals mapea 6 señales, TODAS con sourceBuffer REAL_IN_MONTEBELLO (g=EBA8E3EB-53A2-0CCD-3912-501C0F7E4C8F; el canal realIn también tiene TK1/TK2/TK3 de 10 elementos): caudal de entrada 1[0] y 2[5] (verificados en vivo, docs/plc/OBSERVACIONES_FASE0.md §4), caudal de salida[10] l/s; presión de entrada 1[15], de entrada 2[16] y de salida[17] psi (sin rango operativo entregado; confirmación del operador 2026-07-15). confidence: CONFIRMED (cliente, 2026-07-21). El máximo de caudal (1000 l/s) es un bound físico plausible, no la capacidad de diseño.
- PENDIENTE DE RECTIFICAR (montebello): sus tanques NO van en los 50 índices del buffer primario — la app original los muestra y en el maestro existen REAL_IN_TK1/TK2/TK3_MONTEBELLO (Float[10], cada uno con su MSG_READ), pero falta la semántica de índices DENTRO de cada TK (¿cuál es nivel, cuál volumen?). El operador sospecha planta hija / tanques compartidos (¿con Campoalegre?). Cuando se confirme, se mapean con sourceBuffer REAL_IN_TK<N>_MONTEBELLO.
- Excepción: campoalegre.signals mapea outletFlow1 (realIn[0]), outletFlow2 (realIn[7]) en l/s; outletPressure1 (realIn[12]) y outletPressure2 (realIn[13]) en psi; y tanques 1/2/3: nivel en m y volumen en m³ en realIn[5]/[6], realIn[14]/[15] y realIn[16]/[17]. confidence: CONFIRMED (cliente, 2026-07-21) — confirmación del operador desde el HMI de Optix (2026-07-14; identificador verificado: REAL_IN_CAMPOALEGRE = g=E1680D60-7BCD-C892-7257-C4D4AAE41E1C), NO del L5X ni de documento oficial. Rango de presión: instrumento 0–16 bar → max 232 psi. Máximos de nivel (20 m) y volumen (10000 m³) son bounds plausibles, no dimensiones reales del tanque.
- Los índices de array NO son transferibles entre plantas (realIn[5] es nivel de tanque en campoalegre y caudal en montebello). El código debe direccionar señales SIEMPRE por (plantId, domainKey), nunca por índice global.
- Excepción: soledad.signals mapea 18 señales, TODAS con sourceBuffer REAL_IN_SOLEDAD (g=19181A21-F548-3D76-D6D9-EDAA324C20F7) porque el sitio tiene dos buffers realIn de 50 elementos y la heurística de primario empataría. Entrada: caudal[0] l/s, turbiedad[2] NTU, oxígeno[3] mg/L, conductividad[4] µS/cm, pH[5], temperatura[6] °C; tanque 1: nivel[7] m (op 0.75–2.8) y volumen[8] m³; salida: caudal[9] l/s, turbiedad[11] NTU, cloro[12] mg/L, pH[13], temperatura[14] °C, presión[20] psi. confidence: CONFIRMED (cliente, 2026-07-21) — confirmación del operador (2026-07-15).
- PENDIENTE DE RECTIFICAR (soledad): REAL_IN_SOLEDAD trae además tanques de otras plantas — nivel[22]/volumen[30] de SAN ANTONIO (op 1–2.5 m) y nivel[23]/volumen[31] de EL QUIJOTE (op 1–3 m). Se mapearon bajo soledad con domainKeys sanAntonioTank*/quijoteTank* (NO tank2/tank3) para no presentarlos como tanques propios. Si el operador confirma que duplican los buffers REAL_TK_SAN_ANTONO/REAL_TK_QUIJOTE, estas señales migrarán a las plantas san-antonio y quijote.
- Excepción: cascajal.signals mapea 7 señales de REAL_IN_CASCAJAL (g=F0C27430-68DC-74D7-BDAB-B9EDCC19F8A7, único realIn del sitio): caudal de salida 1[0] y 2[7] l/s; tanque 1 nivel[5] m (op 1–3, lleno a 3 m confirmado por operador) y volumen[6] m³; presión de salida 1[12], de salida 2[13] y de entrada[19] psi (sin rango operativo entregado). confidence: CONFIRMED (cliente, 2026-07-21) — confirmación del operador (2026-07-15).
- Excepción: alto-los-mangos.signals mapea 6 señales de DATOS_REAL_IN_MANGOS (g=ECA4ABBE-2E70-B864-5B3D-B2E9D1FB7830, único buffer realIn del sitio fusionado): caudal de entrada[0] y salida[7] l/s; tanque 1 nivel[5] m (lleno a 2.5 m, confirmado por operador) y volumen[6] m³; presión de entrada[12] y salida[13] psi (op 1–3). confidence: CONFIRMED (cliente, 2026-07-21) — confirmación del operador (2026-07-14), NO del L5X ni de documento oficial en el repo.
- Excepción: voragine.signals mapea 6 señales de REAL_IN_VORAGINE (g=93BAFF92-FF57-4877-74E4-B7CC1EFAE6B3, único realIn del sitio): caudal de entrada[0] y salida[7] l/s; presión de entrada[12] y salida[13] psi (sin rango operativo entregado); tanque único = nivel[5]/volumen[6], rango operativo 1–1.97 m y lleno confirmado a 1.97 m. confidence: CONFIRMED (cliente, 2026-07-21) — confirmación del operador (2026-07-15).
- Excepción: km18.signals mapea 8 señales de REAL_IN_KM18 (g=1C72A21A-8F36-327C-C0AC-CA7A9AA60D96, único realIn del sitio): caudal de entrada[0] y salida[7] l/s; presión de entrada[12] y salida[13] psi (sin rango operativo entregado); tanque 1 = nivel[5]/volumen[6] y tanque 2 = nivel[14]/volumen[15], ambos con rango operativo 1–2 m y lleno confirmado a 2 m. confidence: CONFIRMED (cliente, 2026-07-21) — confirmación del operador (2026-07-15).
- Excepción: sirena.signals mapea 21 señales, TODAS con sourceBuffer REAL_IN_SIRENA (g=A7B368C5-2F51-723A-8108-500CFEB52374; el canal realIn también tiene los buffers de tanque REAL_TK2/TK3_SIRENA de 10 elementos). Entrada: caudal[0], turbiedad[2], oxígeno[3], conductividad[4], pH[5], temperatura[6], presión[20]. Salida: caudal[9], turbiedad[11], cloro[12], pH[13], temperatura[14], presión[21]. Tanques PROPIOS con lleno confirmado: 1 = nivel[7]/volumen[8] (op 1–2.8 m); 2 = nivel[22]/volumen[30], 3 = nivel[23]/volumen[31], 4 = nivel[24]/volumen[32] (op 1–2.5 m c/u). OJO: en soledad los índices 22/23/30/31 son tanques de OTRAS plantas — los índices no son transferibles. confidence: CONFIRMED (cliente, 2026-07-21) — confirmación del operador (2026-07-15).
- Excepción: pichinde.signals mapea 2 señales de REAL_IN_PICHINDE (g=C9C97734-E939-9008-A41E-9CA37BB7A2D0, único realIn del sitio): presión de entrada[10] y presión de salida[11] psi (sin rango operativo entregado). confidence: CONFIRMED (cliente, 2026-07-21) — confirmación del operador (2026-07-15). El operador sospecha que el buffer trae más señales y que el sitio podría ser anidado hijo — pendiente de revisar.
- Excepción: carbonero.signals mapea 12 señales de REAL_IN_CARBONERO (g=A1323D1F-4114-A49D-746E-D6DDBB3C7DE3): entrada = caudal[0] l/s, turbiedad[2] NTU, oxígeno[3] mg/L, conductividad[4] µS/cm, pH[5], temperatura[6] °C; tanque 1 = nivel[7] m, volumen[8] m³; salida = turbiedad[11] NTU, pH[13], temperatura[14] °C, presión[20] psi. confidence: CONFIRMED (cliente, 2026-07-21) — confirmación del operador (2026-07-14), NO del L5X ni de documento oficial en el repo.
- Validez de presiones: [-15, 232] psi. El min NO es 0: los transmisores manométricos derivan bajo cero (Campoalegre salida 1 leyó -0.74 psi real el 2026-07-15) y el vacío físico llega a ≈ -14.7 psi. Bajo -15 psi es imposible físico ⇒ OUT_OF_RANGE (sensor/escala dañados; p. ej. Carbonero salida -57 psi). PENDIENTE verificar contra HMI: Cascajal presión de entrada lee 384 psi (¿unidad/índice/escala?).
- opMin/opMax = rango OPERATIVO/normativo entregado por el operador (insumo de alarmas futuras). NO confundir con min/max, que son límites de validez física: una lectura fuera de [opMin,opMax] pero dentro de [min,max] es un dato REAL y usable (p. ej. pH de salida 5.8 o tanque en 0.5 m) que la UI debe mostrar, no descartar.
- Topología de san-antonio y quijote verificada por browse: son sitios mínimos reales (solo un buffer de tanque + MSG_READ). topologyVerified: true.
- PLANTAS EN INTEGRACIÓN (alta 2026-10-19): cabuyo (Cabuyo), luisa (La Luisa), leonera (La Leonera) y gloria (Gloria) están dadas de alta SIN señales, a la espera de que el integrador las suba al PLC maestro. El browse del 2026-07-12 no trae ningún tag suyo: sin buffer, NodeId ni índice no hay nada que mapear y no se inventa nada (opcBuffers: {}, connection unmapped con DN/ER/TO en null, signals: []). Equipo declarado por el cliente en las cuatro: válvula de entrada on/off, válvula de salida proporcional (% de apertura + consigna 0–100 %), caudal de entrada, caudal de salida y presión de entrada; solo La Leonera tiene además 1 tanque con sensor de nivel, con datos aún desconocidos. Lo que el integrador debe entregar por planta y los pasos para conectarlas: docs/plc/PLANTAS_NUEVAS_CABUYO_LUISA_LEONERA_GLORIA.md.
- displayName es provisional (displayNameProvisional: true) hasta confirmación escrita de la planta.
- generatedFrom.namespaces es referencia histórica de la captura, NO fuente de verdad para el runtime.
