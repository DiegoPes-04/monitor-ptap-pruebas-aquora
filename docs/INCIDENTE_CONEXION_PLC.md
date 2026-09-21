# Incidente: se perdió el acceso al PLC maestro

**Fecha:** 2026-07-21 · **Estado:** **cerrado el 2026-09-21** — se confirmó el cierre del puerto
público y se migró a la ruta interna por VPN (ver §9)
**Impacto:** el monitoreo no recibe datos de **ninguna** de las 12 plantas desde ~15:47.

> **Resumen en una línea:** el servidor OPC UA `181.204.165.66` dejó de ser alcanzable desde
> internet. Las plantas siguen operando y enviando datos al PLC maestro con normalidad; lo que se
> perdió es la **ruta de red** entre el servidor de monitoreo y ese maestro.

---

## 1. Qué se observa

La aplicación muestra "sin dato" en todas las plantas y el puente OPC UA queda en `Connecting`,
reintentando con backoff cada 30 s de forma indefinida (comportamiento correcto y esperado).

## 2. Evidencia técnica

Pruebas hechas desde el equipo de monitoreo el 2026-07-21, **sin pasar por la aplicación**
(`Test-NetConnection`, TCP crudo):

| Destino | Puerto | Resultado |
|---|---|---|
| `8.8.8.8` (internet general) | 53 | ✅ **alcanzable** |
| `181.204.165.66` (PLC maestro) | **59100** (OPC UA) | ❌ **inalcanzable** |
| `181.204.165.66` (mismo host) | 80 | ❌ **inalcanzable** |

**Dos detalles que acotan la causa:**

1. **El host completo no responde**, no solo el puerto OPC UA. Si únicamente se hubiera caído el
   servicio OPC UA, el puerto 59100 daría *conexión rechazada* y el host seguiría respondiendo en
   otros puertos.
2. **Cada intento tarda ~21 s en fallar** (timeout), no falla al instante. Un *timeout* significa
   que los paquetes salen y **nadie contesta** — típico de un cortafuegos que los descarta, de un
   host apagado o de una dirección que ya no corresponde a ese equipo. Un *rechazo* inmediato, en
   cambio, indicaría que el host está vivo pero sin nada escuchando.

La conectividad a internet del equipo de monitoreo **funciona correctamente**, así que el problema
no está en la red del monitoreo.

### Actualización 2026-07-22 — prueba de ruta automatizada + hallazgo del ping

La app ya incluye la prueba de ruta en vivo (Ajustes → "Probar ruta ahora", o
`GET /api/diagnostics/route-check`) y un **registro continuo** (una muestra cada 5 min,
`GET /api/diagnostics/route-history`). Resultado de hoy:

```
servidor → internet : 8.8.8.8:53            → OK (60 ms)      ← la red del monitoreo está BIEN
ping ICMP al host   : 181.204.165.66        → OK (21 ms)      ← ¡EL HOST ESTÁ VIVO!
servidor → PLC      : 181.204.165.66:59100  → TIMEOUT (5 s)   ← el TCP al puerto muere
IP pública del servidor de monitoreo: 181.234.151.111
```

**El ping cambia el diagnóstico.** Un `Test-NetConnection 181.204.165.66 -Port 59100` manual
confirmó lo mismo: `PingSucceeded: True (21 ms)` + `TcpTestSucceeded: False`. Es decir:

- El host **existe, está encendido y en línea** en esa IP (descarta la hipótesis B — IP cambiada —
  y la C — planta sin internet/equipo apagado).
- Lo que muere es **específicamente el TCP** hacia el puerto: un cortafuegos lo está **filtrando**
  (veredicto **PLC-12**). Las pruebas del 21-jul solo eran TCP (59100 y 80), por eso el host
  parecía "muerto"; nunca se probó ICMP.

**Conclusión: la hipótesis A es ahora la más probable con diferencia** — se aplicó un bloqueo de
cortafuegos (posiblemente la mitigación P0 que este proyecto solicitó). La pregunta al admin OT se
reduce a una sola: *¿se cerró/filtró el `59100/tcp` al exterior, y por qué vía nos dan acceso
(VPN)?* — y la respuesta correcta NO es reabrir el puerto a internet (§7).

## 3. Descartado: no es un fallo de la aplicación

- El resto de la cadena (sesión OPC UA → parser → mapeo → calidad → snapshot → API → pantalla) se
  verificó el mismo día con el adaptador **simulador**: entrega valores correctos, en movimiento y
  con estado `EN VIVO`. Es el mismo código que se usa contra el PLC real.
- El mapeo de señales (`opc_mapping.json`) se comparó contra la versión anterior: los identificadores
  de nodo, buffers e índices están **intactos**.
- La suite automatizada del backend pasa completa.

## 4. Hipótesis (por probabilidad)

**A. Se cerró el puerto al exterior.** Es exactamente la mitigación nº 1 que este proyecto solicitó
por escrito en [`SECURITY_FINDING_P0.md`](SECURITY_FINDING_P0.md): *"cerrar el puerto 59100/tcp al
exterior; el acceso debe ocurrir solo por VPN o red OT segregada"*. Si se aplicó, el síntoma sería
**idéntico al observado**. Sería una buena noticia de seguridad que solo requiere darnos una vía de
acceso apropiada.

**B. Cambió la IP pública de la planta.** El servidor se anuncia internamente como
`10.10.51.225:59100` detrás de NAT; se accedía por la IP pública `181.204.165.66`. Si esa IP es
dinámica y rotó, el destino actual ya no es el equipo correcto.

**C. Caída del enlace a internet de la planta** o del propio equipo servidor.

## 5. Qué necesitamos del administrador OT

1. **¿Se cerró el puerto `59100/tcp` hacia internet** (o se aplicó alguna restricción de red nueva)
   el 2026-07-21 alrededor de las 15:45?
2. **¿Sigue siendo `181.204.165.66` la dirección pública** del sitio? Si cambió, ¿cuál es la nueva?
3. **Si el acceso pasa a ser por VPN**: ¿qué credenciales/perfil se nos entrega y desde qué equipo se
   permite conectar?

## 6. Qué haremos al recibir respuesta

Ningún cambio de código; solo configuración (`.env`), y el servicio se recupera solo:

| Escenario | Acción |
|---|---|
| IP pública nueva | `OPC_ENDPOINT=opc.tcp://<IP nueva>:59100` |
| Acceso por VPN a la red OT | Conectar la VPN y `OPC_ENDPOINT=opc.tcp://10.10.51.225:59100` (la dirección interna que el servidor ya anuncia) |
| Servidor caído | Ninguna acción por nuestra parte: el puente reconecta solo al volver el servicio |

**Nota:** el puente reintenta indefinidamente, así que **no hace falta reiniciar nada** cuando el
enlace se restablezca: los datos reaparecen por sí solos.

## 7. Recordatorio de seguridad

Si la hipótesis A es la correcta, conviene **no revertir** el cierre del puerto. Exponer un servidor
OT directamente a internet es el hallazgo P0 de este proyecto: hoy ese endpoint acepta sesiones
anónimas sin cifrar y con tags escribibles. La vía correcta es VPN o red segregada, no reabrir el
puerto.

## 8. Cómo alertar de un corte (monitoreo)

El enlace al PLC es **externo** y no lo podemos garantizar desde el código; lo que sí garantizamos es
que un corte sea **detectable**. El backend expone dos señales; el monitor que las vigila es
infraestructura de despliegue (no vive en el repo), y el "alertar solo tras N minutos" (para no
disparar por un reintento momentáneo) se configura **en el monitor**, no en el código — así ops ajusta
el umbral sin redeploy.

| Señal | Qué exponer al monitor | Regla sugerida |
|---|---|---|
| **Healthcheck HTTP** (público, sin JWT) | `GET /api/health/opc` → **200** solo si el puente está `Connected`; **503** en cualquier otro estado (incluido `Connecting`, el caso del corte real). El cuerpo trae `bridgeStatus` y `plcReachable` para el detalle. | Uptime-monitor (UptimeRobot, Pingdom, healthcheck de Kubernetes/Docker): "alertar tras **N** fallos consecutivos / **5 min** en 503". |
| **Métrica Prometheus** | `opc_bridge_status{state="Connected"}` (gauge; 1 = en ese estado). Ya expuesta en `/api/metrics`. | Alertmanager: `opc_bridge_status{state="Connected"} == 0 **for: 5m**`. |

**Importante:** el health reporta el estado **instantáneo**. Un 503 aislado durante un reintento
normal es esperado; solo debe alertar si **persiste** (de ahí el `for: 5m` / umbral de N fallos). Al
restablecerse el enlace, el puente vuelve a `Connected` solo y el health regresa a 200 sin
intervención (ver §6).

---

## 9. Cierre (2026-09-21)

**Se confirmó la hipótesis A:** la planta cerró el acceso público al servidor OPC UA — lo que el
hallazgo del ping del 22-jul (host vivo, TCP filtrado) ya señalaba. El endpoint público
`181.204.165.66:59200` no volverá a abrirse.

**Acción aplicada** — la fila "Acceso por VPN a la red OT" de la tabla de decisión de §6:

```
OPC_ENDPOINT=opc.tcp://10.10.51.225:59100
```

Sin cambios de código en el puente: solo configuración, tal como anticipaba §6. La VM alcanza esa
dirección por ruta directa desde `192.168.30.x`, sin NAT.

**No se pidió reabrir el puerto público**, en línea con §7 y con
[SECURITY_FINDING_P0.md](SECURITY_FINDING_P0.md). El incidente forzó la postura que el hallazgo P0
ya recomendaba: el acceso OT va por VPN o red segregada, no por internet.

**Deuda técnica saldada en el mismo cambio:** los 11 scripts de campo que tenían la IP y el puerto
escritos a mano ahora usan `resolverEndpoint()` de `apps/api/scripts/opc-endpoint.ts` — el helper que
se creó en agosto para este propósito y que ningún script llegó a importar. Los dos defaults del
backend (`connectivity.config.ts`, `route-check.service.ts`) apuntaban además a una combinación que
nunca existió (`181.204.165.66:59100`, IP pública con puerto interno); quedaron corregidos.

**Requisito de red permanente:** la VM necesita ruta a `10.10.51.0/24`. Si se pierde, el síntoma es
idéntico al de este incidente. Verificar con `nc -vz 10.10.51.225 59100` e `ip route get 10.10.51.225`
antes de sospechar de la aplicación.
