import { memo, useEffect, useState } from 'react';
import { View, Animated, Easing, StyleSheet, type ViewStyle } from 'react-native';
import Colors from '../constants/colors';

/**
 * Esqueletos de carga. Sustituyen a los textos "Cargando tablero…" / "Cargando electroválvulas…":
 * dan idea de QUÉ va a aparecer y de cuánto, en vez de dejar la pantalla en blanco con una frase.
 *
 * El latido es de opacidad, así que **sí** puede correr en el driver nativo: no cuesta hilo de JS,
 * al contrario que la barra de nivel del tanque (que anima ancho y no puede).
 */
function usePulse(): Animated.Value {
  const [pulse] = useState(() => new Animated.Value(0.4));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return pulse;
}

function SkeletonBlock({ pulse, style }: { pulse: Animated.Value; style?: ViewStyle }) {
  return <Animated.View style={[styles.block, style, { opacity: pulse }]} />;
}

/**
 * Rejilla de tarjetas fantasma, con la misma forma que el tablero real (2 columnas).
 *
 * Un ÚNICO `Animated.Value` para todos los bloques: `Animated.loop` sobre una secuencia se
 * reinicia desde el hilo de JS en cada vuelta, así que seis bloques con su propio pulso serían
 * seis despertares de JS cada 750 ms — justo durante el arranque en frío, que es cuando el
 * esqueleto se ve más tiempo. Además todos montan en el mismo frame, así que compartirlo se ve
 * idéntico.
 */
function DashboardSkeletonBase({ cards = 6 }: { cards?: number }) {
  const pulse = usePulse();
  return (
    <View
      style={styles.grid}
      accessibilityRole="progressbar"
      accessibilityLabel="Cargando el tablero"
    >
      {Array.from({ length: cards }, (_, i) => (
        <View key={i} style={styles.cell}>
          <SkeletonBlock pulse={pulse} style={styles.card} />
        </View>
      ))}
    </View>
  );
}

/** Filas fantasma, con la forma de la lista de electroválvulas. Comparten un solo pulso. */
function ListSkeletonBase({ rows = 4, label }: { rows?: number; label: string }) {
  const pulse = usePulse();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label}>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonBlock key={i} pulse={pulse} style={styles.row} />
      ))}
    </View>
  );
}

export const DashboardSkeleton = memo(DashboardSkeletonBase);
export const ListSkeleton = memo(ListSkeletonBase);

const styles = StyleSheet.create({
  block: {
    backgroundColor: Colors.bg,
    borderWidth: 1,
    borderColor: Colors.divider,
    borderRadius: 16,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '50%' },
  card: { height: 150, margin: 5 },
  row: { height: 82, marginBottom: 8, borderRadius: 14 },
});
