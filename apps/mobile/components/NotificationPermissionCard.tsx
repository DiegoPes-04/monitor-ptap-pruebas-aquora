import { View, Text, TouchableOpacity, StyleSheet, Linking, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Colors from '../constants/colors';
import { useDeviceNotifications } from '../hooks/useDeviceNotifications';

/**
 * Activar los avisos en el panel del sistema.
 *
 * El permiso se pide DESDE AQUÍ, con un toque, y no automáticamente al abrir la app: tanto los
 * navegadores como Android rechazan las peticiones sin gesto del usuario, y una denegación es
 * difícil de revertir (el diálogo ya no vuelve a aparecer).
 *
 * Cuando la plataforma no puede, se explica por qué en vez de mostrar un botón que no hará nada.
 */
export function NotificationPermissionCard() {
  const { supported, reason, permission, ask } = useDeviceNotifications();

  if (!supported) {
    return (
      <View style={[styles.card, styles.cardMuted]}>
        <Ionicons name="notifications-off-outline" size={20} color={Colors.textSecondary} />
        <View style={styles.body}>
          <Text style={styles.title}>Avisos del sistema no disponibles</Text>
          <Text style={styles.text}>{reason}</Text>
        </View>
      </View>
    );
  }

  if (permission === 'granted') {
    return (
      <View style={[styles.card, styles.cardOk]}>
        <Ionicons name="notifications" size={20} color={Colors.success} />
        <View style={styles.body}>
          <Text style={styles.title}>Avisos activados</Text>
          <Text style={styles.text}>
            Recibirás en el panel del dispositivo los avisos que elijas aquí abajo. Se revisa cada
            15 minutos y al abrir la aplicación.
          </Text>
        </View>
      </View>
    );
  }

  if (permission === 'denied') {
    // En el teléfono se puede llevar a la persona DIRECTO a los ajustes de la app: antes solo se le
    // explicaba dónde buscarlos, y quien había dicho «no» una vez no tenía un camino de vuelta a la
    // vista. Al volver con el permiso concedido, `useDeviceNotifications` lo relee y esta tarjeta
    // pasa sola a «Avisos activados». En web no hay equivalente (ningún navegador deja abrir sus
    // ajustes desde una página), así que ahí se mantiene la explicación.
    const nativo = Platform.OS !== 'web';
    return (
      <View style={[styles.card, styles.cardMuted]}>
        <Ionicons name="notifications-off-outline" size={20} color={Colors.warning} />
        <View style={styles.body}>
          <Text style={styles.title}>Avisos bloqueados</Text>
          {nativo ? (
            <>
              <Text style={styles.text}>
                Los rechazaste antes y el sistema ya no vuelve a preguntar. Para activarlos, abre
                los ajustes de esta aplicación y permite las notificaciones.
              </Text>
              <TouchableOpacity
                style={styles.enlace}
                onPress={() => void Linking.openSettings().catch(() => undefined)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Abrir los ajustes de la aplicación para permitir las notificaciones"
              >
                <Text style={styles.enlaceTexto}>Abrir ajustes</Text>
              </TouchableOpacity>
            </>
          ) : (
            <Text style={styles.text}>
              Los rechazaste antes y el sistema ya no vuelve a preguntar. Para activarlos hay que
              permitirlos a mano en los ajustes del navegador o del teléfono, en los permisos de esta
              aplicación.
            </Text>
          )}
        </View>
      </View>
    );
  }

  return (
    <TouchableOpacity
      style={[styles.card, styles.cardAction]}
      onPress={() => void ask()}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel="Activar los avisos en el panel del dispositivo"
    >
      <Ionicons name="notifications-outline" size={20} color={Colors.primary} />
      <View style={styles.body}>
        <Text style={styles.title}>Activar avisos en el dispositivo</Text>
        <Text style={styles.text}>
          Para enterarte de un sensor caído sin tener la aplicación abierta. Toca para permitirlo.
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={Colors.primary} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: Colors.bg,
    borderWidth: 1,
    borderColor: Colors.divider,
    borderRadius: 12,
    padding: 14,
  },
  cardAction: { borderColor: Colors.primary + '66', backgroundColor: Colors.primary + '0E' },
  cardOk: { borderColor: Colors.success + '55' },
  cardMuted: {},
  body: { flex: 1, gap: 3 },
  title: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  text: { fontSize: 12.5, color: Colors.textSecondary, lineHeight: 17 },
  // Alto de objetivo táctil holgado: se usa con guantes en planta.
  enlace: { alignSelf: 'flex-start', paddingVertical: 10, marginTop: 2 },
  enlaceTexto: { fontSize: 14, fontWeight: '700', color: Colors.primary },
});
