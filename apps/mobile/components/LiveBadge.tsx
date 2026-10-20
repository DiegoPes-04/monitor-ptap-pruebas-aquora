import { memo } from 'react';
import { View, Text } from 'react-native';
import Colors from '../constants/colors';
import type { LivenessState } from '../services/api';
import { livenessBadge } from '../services/plant-status';

/**
 * Badge de frescura REAL (ya no cosmético). Tres estados y solo UNO es una alarma:
 *   verde  EN VIVO   → los valores se están moviendo.
 *   azul   ESTABLE   → la sesión está sana y el proceso quieto. Normal, NO es un fallo:
 *                      un tanque a nivel constante se ve así durante horas.
 *   rojo   CONGELADO → perdimos la conexión con el PLC; lo que se muestre ya no es fiable.
 * Y dos neutros (gris), que no son alarmas:
 *   CONECTANDO…      → carga inicial, aún sin dato: no se alarma con el rojo antes de tiempo.
 *   EN INTEGRACIÓN   → la planta aún no está conectada al PLC maestro (`integrationPending`): su
 *                      `frozen` no es una caída. Ver `services/plant-status.ts`.
 */
function LiveBadgeBase({
  state,
  loading = false,
  integrationPending = false,
}: {
  state: LivenessState;
  loading?: boolean;
  integrationPending?: boolean;
}) {
  const { color, label } = livenessBadge(state, { loading, integrationPending });
  return (
    <View
      // El paso a CONGELADO es información crítica que hoy solo se veía. `polite` hace que un
      // lector de pantalla lo anuncie al cambiar, sin interrumpir lo que esté leyendo.
      accessibilityLiveRegion="polite"
      accessibilityRole="text"
      accessibilityLabel={`Estado de los datos: ${label}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 10,
        backgroundColor: Colors.surface,
        borderTopWidth: 1,
        borderTopColor: Colors.divider,
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, marginRight: 8 }} />
      <Text style={{ fontSize: 12, fontWeight: '600', color: Colors.textSecondary, letterSpacing: 1.2 }}>
        {label}
      </Text>
    </View>
  );
}

/** Props primitivas (incluida `integrationPending`): el `memo` de fábrica basta. */
export const LiveBadge = memo(LiveBadgeBase);
