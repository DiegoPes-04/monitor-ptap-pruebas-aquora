export type Role = 'civil' | 'operador' | 'jefe' | 'admin';

export type Permission =
  /** Estado básico de la planta: "¿opera?" y "¿hay agua?". Lo tienen TODOS los roles —
   *  es lo único que la matriz oficial concede al Civil. */
  | 'view_basic_status'
  | 'view_dashboard'
  /** Consultar plantas DISTINTAS a la del propio usuario. Cada cuenta está vinculada a una
   *  planta (`user.plant`); sin este permiso, pedir otra devuelve 403. Solo el Admin, que por
   *  la matriz oficial tiene control total, supervisa las 12. */
  | 'view_all_plants'
  | 'control_valves'
  | 'acknowledge_alarms'
  | 'adjust_setpoints'
  | 'view_event_logs'
  | 'manage_users'
  | 'assign_roles'
  | 'configure_alarms'
  | 'export_data'
  | 'system_config';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  plant: string;
}

/**
 * Usuario tal como lo expone la API de administración (GET /api/users). NUNCA lleva
 * password_hash ni pepper_version. Fuente única compartida backend↔móvil.
 */
export interface UserSummary {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: Role;
  plant: string;
  isActive: boolean;
  /** Correo verificado (anti-bot). Un admin NO puede activar una cuenta con esto en false. */
  emailVerified: boolean;
  lastLoginAt: string | null;
  createdAt: string | null;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'mock';

/**
 * De dónde viene un corte de datos, en el lenguaje del producto (no de OPC UA):
 *   ok            → todo fluye.
 *   ip            → el DISPOSITIVO no alcanza al servidor (su propia red/internet). Lo detecta
 *                   el cliente cuando la petición falla, no el backend.
 *   route         → el SERVIDOR no alcanza al PLC (la ruta de red intermedia: VPN, firewall,
 *                   IP cambiada). Es un problema de infraestructura que solo el admin debe ver
 *                   y escalar; a un operador no le aporta y lo alarmaría en vano.
 *   master_no_data→ el servidor SÍ tuvo sesión con el PLC pero el maestro dejó de enviar datos.
 */
export type ConnectionFault = 'ok' | 'ip' | 'route' | 'master_no_data';

/**
 * Clasifica un corte a partir del estado del puente. NO cubre 'ip': esa se decide en el
 * cliente (si la API responde, no es un problema de IP del usuario), así que esta función
 * asume que el backend fue alcanzable.
 *
 * - `Connected`  → 'ok': hay sesión y datos.
 * - `Stale`      → 'master_no_data': hubo sesión y el dato paró → el maestro dejó de enviar.
 * - resto (`Connecting`/`Disconnected`/`Recovering`/`Faulted`) → 'route': no se pudo
 *   establecer o sostener la sesión con el PLC. `Faulted` se incluye a propósito: es un fallo
 *   técnico (p. ej. namespace que ya no resuelve) que el admin debe escalar, no algo que deba
 *   alarmar a un operador.
 */
export function classifyBridge(bridgeStatus: string): Exclude<ConnectionFault, 'ip'> {
  if (bridgeStatus === 'Connected') return 'ok';
  if (bridgeStatus === 'Stale') return 'master_no_data';
  return 'route';
}

/**
 * Códigos de los cortes de conexión que ve el usuario, para reportes precisos. La nomenclatura
 * completa del proyecto vive en docs/CATALOGO_ERRORES.md; estos son los que la app muestra en el
 * banner y en el informe exportable. `NET-*` = lado del dispositivo; `PLC-*` = lado del servidor.
 */
export const CONNECTION_CODES = {
  /** El dispositivo no está conectado a ninguna red (WiFi/datos apagados). */
  NO_NETWORK: 'NET-01',
  /** Hay red pero sin salida a internet (problema del proveedor). */
  NO_INTERNET: 'NET-02',
  /** Hay internet pero el servidor del sistema no responde. */
  SERVER_DOWN: 'NET-03',
  /** El servidor no alcanza el PLC (ruta de red intermedia). Solo admin. */
  PLC_ROUTE: 'PLC-01',
  /** Hubo sesión con el PLC pero el maestro dejó de enviar datos. */
  PLC_NO_DATA: 'PLC-02',
} as const;

export type ConnectionCode = (typeof CONNECTION_CODES)[keyof typeof CONNECTION_CODES];

// ── Contrato del snapshot de planta (DEF-08: fuente ÚNICA backend↔móvil) ─────────────
// Antes el móvil duplicaba estos tipos a mano en services/api.ts (con `bridgeStatus: string`,
// perdiendo la verificación de los 6 estados) sin barrera técnica que forzara la sincronía.
// Ahora ambos lados importan de aquí: un campo nuevo o un estado nuevo se declara UNA vez.

/** Estado del puente OPC UA servidor↔PLC. Espejo exacto de la máquina de estados del backend. */
export type BridgeStatus =
  | 'Connecting'
  | 'Connected'
  | 'Recovering'
  | 'Stale'
  | 'Disconnected'
  | 'Faulted';

export type OpcQuality = 'Good' | 'Bad' | 'Uncertain';

/**
 * Frescura de datos de la planta. La diferencia entre los dos últimos es la salud de la SESIÓN,
 * no el reloj: `stable` = sesión sana con valores quietos (operación NORMAL, datos válidos);
 * `frozen` = perdimos la fuente y el dato ya no es fiable.
 */
export type LivenessState = 'live' | 'stable' | 'frozen';

/** Razón por la que una señal no es usable (QualityService del backend). */
export type UnusableReason = 'BAD_QUALITY' | 'INVALID_NUMBER' | 'BRIDGE_STALE';

export type Confidence = 'confirmed' | 'inferred' | 'estimated';

export interface SignalDto {
  value: number | boolean | null;
  unit: string | null;
  quality: OpcQuality;
  usable: boolean;
  reason?: UnusableReason;
  /** true si el valor cae fuera de [min, max] del mapping. Informativo/alerta — el valor
   * SIGUE mostrándose (nunca se oculta por esto solo). */
  outOfRange?: boolean;
  mappingStatus: 'mapped' | 'unmapped';
  confidence: Confidence;
  label: string | null;
  /** SourceTimestamp del PLC (regla 7: nunca Date.now() para datos). */
  ts: string | null;
  /** Rango operativo/normativo entregado por el operador; el front lo muestra junto al valor. */
  opMin?: number;
  opMax?: number;
  /**
   * Convención de la palabra de estado de una válvula, cuando la planta NO usa la máscara de bits
   * (bit14 = estado válido, bit0 = abierta) de Vorágine/Sirena.
   *
   * Nace de Cascajal: el operador verificó en campo que `INT_IN[1]` vale `251` con la válvula
   * cerrada. Ese valor no tiene el bit14, así que el decodificador de bits lo descartaba como
   * "el PLC no reporta estado válido" y la planta se quedaba sin estado. Declarando aquí los
   * valores literales, cada sitio puede traer su propia convención sin que el front adivine.
   *
   * Ausente ⇒ se aplica la regla de bits de siempre. Un valor que no coincida con ninguno de los
   * declarados NO se interpreta: se prefiere no afirmar nada antes que inventar un estado.
   */
  stateEncoding?: { closed?: number; open?: number };
  /**
   * Solo en señales de VÁLVULA: qué caudal corresponde a ESA válvula, para inferir su estado.
   *
   * Sin esto, el front aplica una preferencia fija (salida y luego entrada) que es una SUPOSICIÓN:
   * acierta o falla según dónde esté físicamente cada válvula, y el código no tenía forma de
   * saberlo. Declararlo convierte un dato de campo en configuración.
   *
   * Y la diferencia no es cosmética. Elegir el caudal equivocado miente justo en el caso que
   * importa: una válvula de SALIDA cerrada con la entrada llenando el tanque, o una de ENTRADA
   * cerrada con el tanque vaciándose aguas abajo. En ambos hay caudal en el lado que no manda, y
   * la app diría "abierta" con la válvula cerrada.
   *
   * La Sirena declara `outletFlow1`: su única válvula es la de salida (operador, 2026-08-15).
   */
  flowDomainKey?: string;
  /**
   * Solo en palabras de ESTADO de válvula: ¿se puede derivar el estado de este registro?
   *
   * `false` = el registro se sigue leyendo y mostrando como DIAGNÓSTICO, pero no se usa para
   * decidir si la válvula está abierta. La Sirena está así desde el 2026-08-15: su `INT_IN[0]`
   * pasó de 16384 a 17408 mientras entraban 23,33 l/s, y ninguna de las convenciones conocidas lo
   * explica (bit10 está encendido en casi todas las plantas, con caudal y sin él).
   *
   * Se conserva mapeado a propósito en vez de borrarlo: es lo que permite que
   * `ValveStateObserver` siga acumulando evidencia y algún día se pueda decodificar de verdad.
   * Borrarlo dejaba al sistema ciego justo donde falta conocimiento.
   */
  stateTrusted?: boolean;
  /**
   * Solo en señales de VÁLVULA: `false` = la válvula existe y se muestra, pero NO se puede accionar
   * desde la app porque no tiene canal de comando en el mapping.
   *
   * **Ausente significa que sí se acciona**, que es el caso de las diez válvulas de hoy: así el
   * campo no cambia el comportamiento de nada existente ni de un front antiguo que lo ignore.
   *
   * Existe porque el front pintaba el botón de abrir/cerrar para TODA válvula del snapshot, sin más
   * condición que el permiso del rol. Con una válvula sin mando —la de ENTRADA de La Vorágine, cuya
   * frecuencia de bits aún no conocemos— el operador confirmaba la maniobra en un diálogo y solo
   * después recibía el 404 del backend. Hacerle confirmar una orden que jamás podía salir es peor
   * que no ofrecerle el botón.
   *
   * Se llama `commandable` y no `writable` a propósito: en un DTO que habla de OPC UA, "writable"
   * se confundiría con el AccessLevel del nodo, que es otra cosa —y que en ese buffer vale
   * `CurrentWrite` aunque la válvula no tenga comando definido.
   */
  commandable?: boolean;
  /**
   * Solo en señales de VÁLVULA: qué VERBOS declara su mapping, p. ej. `['open', 'close']`.
   *
   * Es `commandable` un nivel más abajo, y nace del mismo error. `commandable` evitó ofrecer botón
   * en una válvula sin canal de mando; esto evita ofrecer un VERBO que ese canal no tiene: hoy solo
   * La Vorágine y La Sirena declaran `close`, así que en las otras ocho un "cerrar" sale al backend
   * para volver con `UNKNOWN_COMMAND`. Hacerle confirmar al operador una maniobra que no puede
   * salir es exactamente lo que el campo anterior se propuso terminar.
   *
   * **Ausente significa que la señal NO es una válvula.** Un array vacío no debería ocurrir: una
   * señal `writable` sin verbos no pasa la validación del mapping.
   */
  commands?: string[];
}

/**
 * ¿El valor viola el rango OPERATIVO entregado por el operador (`opMin`/`opMax`)?
 *
 * Vive en `@ptap/shared` y no en cada lado a propósito. Cuando el tablero tenía su propio criterio
 * y la campana otro, una señal por debajo de su mínimo generaba alerta pero su grupo del tablero
 * se dejaba plegar — el tablero escondía algo de lo que la campana ya avisaba. Una sola definición
 * evita esa clase de contradicción entre pantallas, y ahora también entre backend y front.
 */
export function isOutOfOperatingRange(s: SignalDto): boolean {
  if (typeof s.value !== 'number') return false;
  const below = typeof s.opMin === 'number' && s.value < s.opMin;
  const above = typeof s.opMax === 'number' && s.value > s.opMax;
  return below || above;
}

/** ¿Esta señal generaría alguna alerta de rango (física u operativa)? */
export function hasRangeAnomaly(s: SignalDto): boolean {
  return Boolean(s.outOfRange) || isOutOfOperatingRange(s);
}

export interface LivenessDto {
  state: LivenessState;
  lastChangeAt: string | null;
  windowSec: number;
}

export interface PlantSnapshotDto {
  plantId: string;
  displayName: string;
  sequence: number;
  /** Opcionales EN EL CABLE: la respuesta `pending` del arranque de telemetría no los incluye.
   *  El SnapshotBuilder del backend los emite siempre. */
  protocolVersion?: string;
  dtoVersion?: string;
  bridgeStatus: BridgeStatus;
  liveness: LivenessDto;
  signals: Record<string, SignalDto>;
  /** true si aún no hay snapshot en cache para esa planta (respuesta de espera, sin señales). */
  pending?: boolean;
  /**
   * Cuánto aguanta cada tanque. Ausente mientras el detector no haya hecho su primer barrido: es
   * preferible no enseñar nada a enseñar un número viejo.
   */
  autonomy?: TankAutonomyDto[];
  /**
   * `true` = la planta está dada de alta en el mapping, pero el mapping no le declara NINGÚN buffer
   * de datos: existe y todavía no está conectada al PLC maestro (Cabuyo, La Luisa, La Leonera y
   * Gloria desde el 2026-10-19). Desaparece solo, sin tocar la app, en cuanto se le declaren buffers.
   *
   * Existe porque `liveness: frozen` no distingue los dos casos: la app pintaba «CONGELADO · SIN
   * CONEXIÓN» en rojo, y la vista Civil «Reintentando automáticamente», para una planta que nunca se
   * ha conectado. Quien lo leía entendía una CAÍDA. La liveness sigue en `frozen`, que es la verdad
   * del dato; este campo dice POR QUÉ.
   *
   * Solo se emite cuando es true, como `commandable`: ausente = planta conectada, que es el caso de
   * las doce de siempre, y un front antiguo que lo ignore se comporta como antes. Es estático: sale
   * del mapping y no cambia sin reiniciar el backend.
   */
  integrationPending?: true;
}

/**
 * Autonomía de un tanque: cuánto falta para el 50 % y para quedarse vacío.
 *
 * El cliente lo pidió (2026-08-20) para poder decidir ANTES de cerrar la entrada. El número lo
 * calcula el backend con un temporizador estable —banda muerta de 0,2 l/s y salto de régimen de
 * 0,6 l/s— porque recalcularlo con el caudal instantáneo lo hacía saltar de 5 h a 3 h y volver, y
 * así no sirve para decidir nada.
 */
export interface TankAutonomyDto {
  /** Número de tanque, para casarlo con `tank<N>Level` del mismo snapshot. */
  tankN: number;
  /** Horas hasta bajar al 50 %. 0 si ya está por debajo; null si no se puede calcular. */
  hoursTo50: number | null;
  /** Horas hasta quedar vacío. null si no se puede calcular. */
  hoursTo0: number | null;
  /** Caudal (l/s) con el que se fijó el temporizador. */
  flowLps: number;
  /**
   * Qué SIGNIFICA el número, que no es lo mismo según el estado de la entrada:
   *  - `vaciado_real`: la entrada está cerrada y el tanque se vacía de verdad. Es una cuenta atrás.
   *  - `proyeccion_24h`: la entrada está abierta y el tanque NO se vacía. Es un supuesto —«si
   *    cerraras ahora»— con el consumo medio del día. Presentarlo como cuenta atrás sería mentir.
   */
  basis: 'vaciado_real' | 'proyeccion_24h';
}

/**
 * Tipos de aviso. Fuente de verdad compartida: el backend los emite y el móvil los agrupa.
 *
 * `valve_command` y `valve_manual` son la traza de las válvulas y NO se pueden silenciar (ver
 * `KINDS_NO_SILENCIABLES`).
 */
export type NotificationKind =
  | 'sensor_stale'
  | 'signal_out_of_range'
  | 'tank_level'
  | 'tank_autonomy'
  | 'valve_command'
  | 'valve_manual'
  | 'signature_broken';

export type NotificationSeverity = 'critical' | 'warning' | 'info';

/**
 * Lo que NO se puede callar, pase lo que pase.
 *
 * Las maniobras de válvula son el registro que SUSTITUYE a la confirmación que el PLC no da: en
 * estas plantas no hay forma electrónica de saber si una válvula se abrió, así que la evidencia es
 * quién dio la orden y cuándo. Si alguien pudiera apagar ese aviso, dejaría de ser evidencia.
 *
 * `signature_broken` va por lo mismo llevado al extremo: avisa de que ESE registro fue alterado.
 * Poder silenciarlo sería poder tapar la manipulación.
 */
export const KINDS_NO_SILENCIABLES: readonly NotificationKind[] = [
  'valve_command',
  'valve_manual',
  'signature_broken',
];

export function esSilenciable(kind: string): boolean {
  return !KINDS_NO_SILENCIABLES.includes(kind as NotificationKind);
}

/**
 * Qué avisos SUENAN fuera de la app. Contrato único backend↔móvil.
 *
 * **Solo hay dos modos, y valen para todo:** con sonido (llega a la bandeja Y al panel del sistema)
 * o silenciado (llega a la bandeja, no suena fuera). Silenciar NUNCA esconde nada: el aviso sigue
 * en el historial y sigue contando en la campana. La diferencia entre «no me molestes con esto» y
 * «esto no existió» es la que hace falta cuando hay que reclamar algo tres semanas después.
 *
 * Se declara lo que se silencia, nunca lo que se permite: así un tipo de aviso nuevo alcanza a todo
 * el mundo en vez de quedar mudo hasta que cada uno lo active.
 */
export interface NotificationPrefsDto {
  /** Tipos que no suenan fuera de la app. Vacío = todos suenan. */
  mutedKinds: string[];
  /**
   * Ítems concretos que no suenan fuera, como `plantId:subject` (p. ej. `voragine:tank1Level`).
   *
   * Es el silenciado «directo» desde el tablero: el sensor que lleva tres semanas averiado y del
   * que ya no hace falta que suene el teléfono, sin dejar de recibir el resto de esa planta.
   */
  mutedItems: string[];
  /** Gravedad mínima que suena fuera. `info` = todo suena. */
  minSeverity: NotificationSeverity;
  /**
   * Franja de «no molestar» en hora LOCAL del dispositivo, `HH:MM`. `null` = sin silencio.
   *
   * `from > to` significa que cruza la medianoche (22:00–06:00), que es el caso normal.
   */
  quietFrom: string | null;
  quietTo: string | null;
}

/** Lo que rige cuando el usuario nunca ha tocado sus preferencias: todo suena. */
export const NOTIFICATION_PREFS_DEFAULT: NotificationPrefsDto = {
  mutedKinds: [],
  mutedItems: [],
  minSeverity: 'info',
  quietFrom: null,
  quietTo: null,
};

/** Clave de un ítem silenciable. Planta + señal, porque el mismo `subject` existe en varias plantas. */
export function claveDeItem(plantId: string, subject: string): string {
  return `${plantId}:${subject}`;
}

/** Lo mínimo que hace falta para decidir si un aviso suena. */
export interface AvisoSonable {
  kind: string;
  severity: NotificationSeverity;
  plantId: string;
  subject: string | null;
}

/**
 * ¿Este aviso debe SONAR fuera de la app ahora mismo?
 *
 * Vive en `shared` porque la decide el cliente —depende del reloj del teléfono— y aun así tiene que
 * ser la misma regla en móvil y en web. Nunca decide si el aviso EXISTE: eso no se filtra en
 * ninguna parte.
 *
 * El orden de las comprobaciones es el orden de las prioridades:
 *  1. Las maniobras de válvula suenan siempre. No son silenciables por diseño.
 *  2. Lo crítico atraviesa el «no molestar» —un tanque rebosando suena a las cuatro de la mañana—
 *     pero NO atraviesa un silenciado explícito: si alguien calló ese sensor a propósito, se
 *     respeta.
 */
export function debeSonar(aviso: AvisoSonable, prefs: NotificationPrefsDto, ahora: Date): boolean {
  if (!esSilenciable(aviso.kind)) return true;

  if (prefs.mutedKinds.includes(aviso.kind)) return false;
  if (aviso.subject && prefs.mutedItems.includes(claveDeItem(aviso.plantId, aviso.subject))) return false;

  const orden: Record<NotificationSeverity, number> = { info: 0, warning: 1, critical: 2 };
  if (orden[aviso.severity] < (orden[prefs.minSeverity] ?? 0)) return false;

  if (aviso.severity === 'critical') return true;
  if (!prefs.quietFrom || !prefs.quietTo) return true;

  const min = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const ahoraMin = ahora.getHours() * 60 + ahora.getMinutes();
  const desde = min(prefs.quietFrom);
  const hasta = min(prefs.quietTo);
  // Franja que cruza la medianoche: dentro es "después de desde O antes de hasta".
  const enSilencio = desde <= hasta ? ahoraMin >= desde && ahoraMin < hasta : ahoraMin >= desde || ahoraMin < hasta;
  return !enSilencio;
}

/** Cambio de liveness para el evento Socket.IO `opc:liveness`. */
export interface LivenessChange {
  plantId: string;
  state: LivenessState;
  lastChangeAt: string | null;
  windowSec: number;
}

/**
 * Vista MÍNIMA de la planta para el rol Civil. Whitelist deliberada, no un snapshot recortado:
 * NO viaja `signals`, así que el dispositivo del Civil nunca recibe caudales ni presiones.
 */
export interface PlantBasicStatusDto {
  plantId: string;
  displayName: string;
  bridgeStatus: BridgeStatus;
  liveness: LivenessDto;
  /** null = la planta no tiene señales de tanque mapeadas (no se puede afirmar ni negar). */
  waterAvailable: boolean | null;
  /**
   * Mismo campo y misma regla que `PlantSnapshotDto.integrationPending`. El Civil puede verlo: no es
   * una lectura de la planta, es la razón por la que no hay ninguna.
   */
  integrationPending?: true;
}

/** Elemento de GET /api/plants. */
export interface PlantListItem {
  plantId: string;
  displayName: string;
  liveness: LivenessDto;
  bridgeStatus: BridgeStatus;
  /** Mismo campo y misma regla que `PlantSnapshotDto.integrationPending`. */
  integrationPending?: true;
}

export interface Sensor {
  id: string;
  name: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  status: 'ok' | 'warning' | 'error';
  icon: string;
}

export interface Valve {
  id: string;
  name: string;
  description: string;
  isOpen: boolean;
}

export interface Tank {
  id: string;
  name: string;
  percentage: number;
  levelM: number;
  maxLevelM: number;
  volumeM3: number;
  maxVolumeM3: number;
}

export interface OpcSnapshot {
  plantId: string;
  timestamp: string;
  connectionStatus: ConnectionStatus;
  sensors: Sensor[];
  tanks: Tank[];
  valves?: Valve[];
}

export interface PlantDefinition {
  id: string;
  name: string;
}

export const ROLES: Role[] = ['civil', 'operador', 'jefe', 'admin'];

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  // El Civil solo observa el estado básico: es exactamente lo que la matriz oficial le
  // concede ("ver si el sistema funciona" y "ver si hay agua"), y nada más.
  civil: ['view_basic_status'],
  operador: [
    'view_basic_status',
    'view_dashboard',
    'control_valves',
    'acknowledge_alarms',
    'adjust_setpoints',
    'view_event_logs',
  ],
  jefe: [
    'view_basic_status',
    'view_dashboard',
    'acknowledge_alarms',
    'adjust_setpoints',
    'view_event_logs',
  ],
  admin: [
    'view_basic_status',
    'view_dashboard',
    'view_all_plants',
    'control_valves',
    'acknowledge_alarms',
    'adjust_setpoints',
    'view_event_logs',
    'manage_users',
    'assign_roles',
    'configure_alarms',
    'export_data',
    'system_config',
  ],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Todos los permisos, en el orden de la matriz oficial (para renderizarla en la UI). */
export const PERMISSIONS: Permission[] = [
  'view_basic_status',
  'view_dashboard',
  'view_all_plants',
  'acknowledge_alarms',
  'adjust_setpoints',
  'view_event_logs',
  'control_valves',
  'manage_users',
  'assign_roles',
  'configure_alarms',
  'export_data',
  'system_config',
];

/** Texto de cada permiso, tal como aparece en la matriz oficial del cronograma. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  view_basic_status: 'Ver si el sistema funciona y si hay agua disponible',
  view_dashboard: 'Ver el panel principal y los datos en tiempo real',
  view_all_plants: 'Consultar todas las plantas, no solo la propia',
  acknowledge_alarms: 'Reconocer y silenciar alarmas activas',
  adjust_setpoints: 'Ajustar parámetros o setpoints de operación',
  view_event_logs: 'Ver los registros de eventos del sistema',
  control_valves: 'Abrir y cerrar válvulas',
  manage_users: 'Crear, editar y eliminar usuarios',
  assign_roles: 'Asignar roles a los usuarios',
  configure_alarms: 'Configurar los límites de las alarmas',
  export_data: 'Exportar el historial completo de datos',
  system_config: 'Acceder a la configuración general del sistema',
};

export const ROLE_LABELS: Record<Role, string> = {
  civil: 'Civil',
  operador: 'Operador',
  jefe: 'Jefe PTAP',
  admin: 'Administrador',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  civil: 'Vista básica',
  operador: 'Datos y control',
  jefe: 'Datos, sin control',
  admin: 'Control total',
};

export const ROLE_COLORS: Record<Role, string> = {
  civil: '#78909C',
  operador: '#1565C0',
  jefe: '#6A1B9A',
  admin: '#B71C1C',
};

// El RBAC del backend (Fase 4) gatea por permiso granular usando ROLE_PERMISSIONS/
// hasPermission (arriba) — la MISMA fuente que consume el móvil para features de UI.
// Se retiró el antiguo sistema paralelo de tiers (RoleTier/ROLE_TIER/tierAtLeast) porque
// no podía expresar la matriz oficial (p. ej. `jefe` = todo lo del operador salvo válvulas).
