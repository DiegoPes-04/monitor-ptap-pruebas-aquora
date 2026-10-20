import { memo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { CONNECTION_CODES } from '@ptap/shared';
import Colors from '../constants/colors';
import { useAuth } from '../context/AuthContext';
import { useClientNetworkStatus } from '../hooks/useClientNetworkStatus';
import { plcFaultForBanner } from '../services/plant-status';

type Tone = 'danger' | 'warning' | 'neutral';

/**
 * Aviso de corte de datos, en lenguaje de operador, CLASIFICADO por dónde falla y con su CÓDIGO
 * (docs/CATALOGO_ERRORES.md) para reportes precisos. La cadena es DISPOSITIVO → servidor → PLC,
 * y cada tramo tiene su mensaje, su icono, su color y su responsable:
 *
 * Lado del DISPOSITIVO (no se alcanza al servidor) — la acción es distinta en cada uno:
 *  - NET-01 offline     → no está en ninguna red → "conéctate" (es del usuario).
 *  - NET-02 no-internet → red sin salida → "contacta a tu proveedor" (es del ISP).
 *  - NET-03 servidor    → hay internet, el servidor no responde → "avisa al administrador".
 *
 * Lado del SERVIDOR (sí se alcanza el servidor, pero no hay datos del PLC):
 *  - PLC-02 (`Stale`): hubo sesión y el maestro dejó de enviar. Lo ven todos.
 *  - PLC-01 (resto): el servidor no alcanza al PLC. SOLO el admin (`system_config`) lo ve para
 *    escalarlo; un operador no ve banner (ya tiene la última lectura con su hora en las tarjetas).
 *  - Planta en integración (`integrationPending`): ningún PLC-0x. Aún no está conectada al maestro,
 *    así que el estado del puente no habla de ella (ver `plcFaultForBanner`). La pantalla ya explica
 *    en su contenido que está en integración.
 */
function ConnectionBannerBase({
  apiReachable,
  bridgeStatus,
  integrationPending = false,
}: {
  apiReachable: boolean;
  bridgeStatus: string | undefined;
  integrationPending?: boolean;
}) {
  const { hasPermission } = useAuth();
  // Solo diagnostica la red del dispositivo cuando de verdad no se llega al servidor.
  const clientNet = useClientNetworkStatus(!apiReachable);

  if (!apiReachable) {
    switch (clientNet) {
      case 'offline':
        return (
          <Banner
            code={CONNECTION_CODES.NO_NETWORK}
            tone="warning"
            icon="cellular-outline"
            title="No estás conectado a una red"
            detail="Tu dispositivo no está en ninguna red (WiFi o datos apagados, o modo avión). Conéctate a una red para continuar."
          />
        );
      case 'no-internet':
        return (
          <Banner
            code={CONNECTION_CODES.NO_INTERNET}
            tone="warning"
            icon="earth-outline"
            title="Tu red no tiene salida a internet"
            detail="Estás conectado a una red, pero no hay internet (suele ser una caída del proveedor). Contacta a tu proveedor de internet."
          />
        );
      case 'checking':
        return (
          <Banner
            code={CONNECTION_CODES.SERVER_DOWN}
            tone="neutral"
            icon="sync-outline"
            title="Sin conexión con el servidor"
            detail="Comprobando el tipo de problema…"
          />
        );
      default: // 'online' → hay internet, el que no responde es el servidor
        return (
          <Banner
            code={CONNECTION_CODES.SERVER_DOWN}
            tone="danger"
            icon="server-outline"
            title="El servidor no responde"
            detail="Tienes internet, pero el servidor del sistema no está respondiendo (puede estar caído o reiniciándose). Avisa al administrador del sistema."
          />
        );
    }
  }

  // apiReachable: sin bridgeStatus aún, con el puente sano o en una planta en integración, no hay
  // corte del PLC que anunciar.
  const fault = plcFaultForBanner(bridgeStatus, integrationPending);
  if (!fault) return null;

  if (fault === 'master_no_data') {
    return (
      <Banner
        code={CONNECTION_CODES.PLC_NO_DATA}
        tone="warning"
        icon="hardware-chip-outline"
        title="El PLC no está enviando datos"
        detail="La conexión con la planta está activa, pero el equipo dejó de enviar lecturas. Se muestran los últimos valores conocidos."
      />
    );
  }

  // fault === 'route' (PLC-01): solo el admin. El resto no ve banner (ya ve la última lectura).
  if (!hasPermission('system_config')) return null;

  return (
    // La notificación REDIRIGE al diagnóstico con auto-ejecución: al llegar, la prueba de ruta
    // corre sola (probarRuta=1) y ahí recién se muestra el registro — nunca antes.
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => router.push({ pathname: '/(app)/ajustes', params: { probarRuta: '1' } })}
    >
      <Banner
        code={CONNECTION_CODES.PLC_ROUTE}
        tone="danger"
        icon="git-network-outline"
        title="Sin conexión con el PLC (problema de ruta)"
        detail="El servidor no logra llegar al PLC. La causa puede estar en el internet del propio servidor, en la ruta intermedia (VPN, firewall, IP cambiada) o en la planta — sin probar la ruta no se puede afirmar cuál. Toca para abrir el diagnóstico y probar la ruta en vivo."
      />
    </TouchableOpacity>
  );
}

/** Props primitivas (incluida `integrationPending`): el `memo` de fábrica basta. */
export const ConnectionBanner = memo(ConnectionBannerBase);

const TONE_COLOR: Record<Tone, string> = {
  danger: Colors.danger,
  warning: Colors.warning,
  neutral: Colors.neutral,
};

function Banner({
  code,
  tone,
  icon,
  title,
  detail,
}: {
  code: string;
  tone: Tone;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  detail: string;
}) {
  const color = TONE_COLOR[tone];
  return (
    <View
      style={[styles.banner, { backgroundColor: color + '12', borderLeftColor: color }]}
      // Una caída del puente aparece sin que el usuario haga nada: hay que anunciarla, no solo
      // pintarla. `assertive` porque interrumpe legítimamente — significa que el dato dejó de ser
      // fiable.
      accessibilityLiveRegion="assertive"
      accessibilityRole="alert"
      accessibilityLabel={`${title}. ${detail} Código ${code}.`}
    >
      <Ionicons name={icon} size={20} color={color} />
      <View style={styles.texts}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color }]}>{title}</Text>
          <Text style={styles.code}>{code}</Text>
        </View>
        <Text style={styles.detail}>{detail}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    borderLeftWidth: 3,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 8,
  },
  texts: { flex: 1, gap: 3 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { flex: 1, fontSize: 14, fontWeight: '700' },
  // Código discreto pero copiable/dictable, para reportar con precisión (ver CATALOGO_ERRORES.md).
  code: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary, letterSpacing: 0.5 },
  detail: { fontSize: 12.5, lineHeight: 18, color: Colors.textSecondary },
});
