import { useCallback, useMemo } from 'react';
import { View, Text, ScrollView, RefreshControl, StyleSheet, TouchableOpacity, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useSnapshot } from '../../hooks/useSnapshot';
import { useTime } from '../../hooks/useTime';
import { usePlant } from '../../context/PlantContext';
import { useAuth } from '../../context/AuthContext';
import { GaugeCard } from '../../components/GaugeCard';
import { FlowMeterCard } from '../../components/FlowMeterCard';
import { TankGaugeCard } from '../../components/TankGaugeCard';
import { LiveBadge } from '../../components/LiveBadge';
import { PlantSelector } from '../../components/PlantSelector';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { AppUpdateBanner } from '../../components/AppUpdateBanner';
import { DashboardSummary } from '../../components/DashboardSummary';
import { GroupHeader } from '../../components/GroupHeader';
import { DashboardSkeleton } from '../../components/Skeleton';
import { OfflineNotice } from '../../components/OfflineNotice';
import Colors from '../../constants/colors';
import { tanksFromSnapshot } from '../../services/tanks';
import { cardKindFor } from '../../services/signal-kind';
import { dashboardSignals, groupSignals, summarize, type GroupId } from '../../services/signal-groups';
import { setCompact, toggleGroup, useDashboardPrefs } from '../../services/dashboard-prefs';
import { EN_INTEGRACION } from '../../services/plant-status';

/** Icono por domainKey conocido (cosmético). */
const ICONS: Record<string, string> = {
  inletFlow1: 'water-outline',
  inletFlow2: 'water-outline',
  outletFlow1: 'water-outline',
  outletFlow2: 'water-outline',
  inletPressure1: 'speedometer-outline',
  inletPressure2: 'speedometer-outline',
  outletPressure1: 'speedometer-outline',
  outletPressure2: 'speedometer-outline',
  inletTurbidity: 'color-filter-outline',
  outletTurbidity: 'color-filter-outline',
  inletOxygen: 'leaf-outline',
  conductivity: 'flash-outline',
  inletPh: 'flask-outline',
  outletPh: 'flask-outline',
  inletTemperature: 'thermometer-outline',
  outletTemperature: 'thermometer-outline',
  outletChlorine: 'eyedrop-outline',
};

export default function TableroScreen() {
  const { selectedPlant } = usePlant();
  const { hasPermission } = useAuth();
  const canView = hasPermission('view_dashboard');
  // Una SOLA suscripción por planta (compartida vía `plant-stream.ts`, aunque la cáscara de
  // pestañas también pida la misma), y con `enabled` atado al permiso: el Civil que llegue por
  // deep-link no dispara el fetch (403) ni el socket.
  const { data: snapshot, isLoading, isError, refetch, isRefetching } = useSnapshot(selectedPlant.id, canView);

  // Preferencias de presentación (densidad y grupos plegados), persistidas en el dispositivo.
  const prefs = useDashboardPrefs();

  /**
   * Los tanques ocupan la fila entera en pantallas estrechas.
   *
   * El tablero imponía dos columnas siempre. En un teléfono de 360 dp eso deja ~168 dp por tarjeta,
   * y la de tanque es la que más texto lleva: «Autonomía si cierras · 15 h 58 min · 7 h 58 min al
   * 50 %» no cabe ahí de ninguna manera, se pegaba a la etiqueta y se partía en tres líneas.
   *
   * Las tarjetas de señal se quedan en dos columnas a propósito: «6.84 l/s» cabe de sobra, y una
   * sola columna convertiría La Sirena —23 señales— en un scroll interminable.
   */
  const { width } = useWindowDimensions();
  const tanqueAnchoCompleto = width < 400;

  const tanks = useMemo(() => tanksFromSnapshot(snapshot), [snapshot]);

  // Memoizado: antes se recalculaba en CADA render (dos predicados por clave), pese a que `tanks`
  // justo encima sí estaba memoizado.
  const signals = useMemo(() => dashboardSignals(snapshot?.signals), [snapshot]);

  const livenessState = snapshot?.liveness.state ?? 'frozen';
  const frozen = livenessState === 'frozen';
  // Aún no conectada al PLC maestro: su `frozen` no es una caída (ver services/plant-status.ts).
  const integrationPending = snapshot?.integrationPending === true;
  const groups = useMemo(() => groupSignals(signals, frozen), [signals, frozen]);
  // Derivado de los grupos, que ya contaron: recorrer otra vez las señales daría los mismos
  // números con el riesgo de que las dos cuentas se contradigan.
  const summary = useMemo(() => summarize(groups), [groups]);
  const hasContent = tanks.length > 0 || signals.length > 0;

  // El servidor se considera alcanzable si NO hubo error REST, o si aún así el socket ya nos
  // entregó datos (en React Query v5 `setQueryData` no limpia el estado 'error'): así el banner
  // rojo no contradice a las tarjetas que ya muestran datos en vivo.
  const apiReachable = !isError || (!!snapshot && !snapshot.pending);
  // Error DE VERDAD: falló la carga y no hay ni respaldo local que enseñar. Si hay respaldo, manda
  // el diseño de siempre (banner + datos congelados), que informa mejor que una pantalla de error.
  const showError = isError && !snapshot;

  const onToggleGroup = useCallback((id: GroupId) => toggleGroup(id), []);

  // Guard de rol: el tablero detallado es para operador/jefe/admin. El Civil (solo estado
  // básico) no entra aquí ni siquiera por navegación directa. El backend igual responde 403.
  if (!canView) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <View style={styles.centered}>
          <Ionicons name="lock-closed-outline" size={40} color={Colors.textSecondary} />
          <Text style={styles.plantName}>Acceso restringido</Text>
          <Text style={styles.sectionSubtitle}>El tablero detallado no está disponible para tu rol.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <PlantSelector />
      <ConnectionBanner
        apiReachable={apiReachable}
        bridgeStatus={snapshot?.bridgeStatus}
        integrationPending={integrationPending}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} colors={[Colors.primary]} tintColor={Colors.primary} />
        }
      >
        {/*
          El aviso de versión nueva vive AQUÍ además de en login y Ajustes.
          Antes solo estaba en esas dos, así que quien ya tenía la sesión abierta y no entraba a
          Ajustes no se enteraba nunca: dependía de que le caducara la sesión (8 h) para volver a
          ver el login. El tablero es la pantalla que todo el mundo abre.
          Va DENTRO del ScrollView a propósito, para que scrollee con el contenido en vez de
          comerse altura fija; y se auto-oculta en cuanto el versionCode instalado coincide con el
          publicado, así que no puede molestar a quien ya actualizó.
        */}
        <AppUpdateBanner modo="actualizacion" />

        <View style={styles.sectionHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.plantName}>{snapshot?.displayName ?? selectedPlant.name}</Text>
            <Text style={styles.sectionSubtitle}>Tablero en tiempo real</Text>
          </View>
          {hasContent && (
            <TouchableOpacity
              style={styles.densityBtn}
              onPress={() => setCompact(!prefs.compact)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityState={{ selected: prefs.compact }}
              accessibilityLabel={
                prefs.compact ? 'Mostrar el detalle de cada tarjeta' : 'Ver el tablero en modo compacto'
              }
            >
              <Ionicons
                name={prefs.compact ? 'list-outline' : 'grid-outline'}
                size={16}
                color={Colors.textSecondary}
              />
            </TouchableOpacity>
          )}
          <Clock />
        </View>

        {isLoading && !snapshot ? (
          <DashboardSkeleton />
        ) : showError ? (
          <OfflineNotice
            title="No se pudo cargar el tablero."
            detail="No hay conexión con el servidor y este dispositivo aún no tiene ninguna lectura guardada de esta planta."
            onRetry={() => void refetch()}
            retryLabel="Reintentar la carga del tablero"
          />
        ) : !hasContent ? (
          // Tres vacíos DISTINTOS: una planta en integración (aún no conectada al PLC maestro), sin
          // conexión y sin respaldo local aún (pending), o una planta que de verdad no tiene señales
          // en el mapping. Antes los dos últimos decían "no mapeada" y durante un corte eso
          // desinformaba. La integración va primero: su respuesta de espera también es `pending`, y
          // ahí «sin conexión con la planta» se leería como una caída.
          <View style={styles.info}>
            {integrationPending ? (
              <>
                <Text style={styles.infoText}>{EN_INTEGRACION.titulo}</Text>
                <Text style={styles.infoSub}>{EN_INTEGRACION.lecturas}</Text>
              </>
            ) : snapshot?.pending ? (
              <>
                <Text style={styles.infoText}>Sin datos del PLC por ahora (sin conexión con la planta).</Text>
                <Text style={styles.infoSub}>Cuando lleguen lecturas, este dispositivo recordará las últimas y las mostrará aunque la conexión vuelva a caerse.</Text>
              </>
            ) : (
              <>
                <Text style={styles.infoText}>Esta planta no tiene señales mapeadas todavía.</Text>
                <Text style={styles.infoSub}>Sus lecturas aparecerán aquí cuando sus señales estén conectadas al PLC maestro.</Text>
              </>
            )}
          </View>
        ) : (
          <>
            {signals.length > 0 && (
              <DashboardSummary
                total={summary.total}
                anomalies={summary.anomalies}
                noData={summary.noData}
                compact={prefs.compact}
              />
            )}

            {/* Los tanques van primero y NUNCA se pliegan: son la lectura principal de la planta. */}
            {tanks.length > 0 && (
              <View style={styles.grid}>
                {tanks.map((tank) => (
                  <View key={tank.id} style={tanqueAnchoCompleto ? styles.cellFull : styles.cell}>
                    <TankGaugeCard tank={tank} frozen={frozen} plantId={selectedPlant.id} />
                  </View>
                ))}
              </View>
            )}

            {groups.map((group) => {
              // `lockedOpen` gana siempre sobre la preferencia del usuario: un grupo con una señal
              // fuera de rango, sin dato, o con la planta congelada, se muestra sí o sí.
              const collapsed = !group.lockedOpen && prefs.collapsed.includes(group.id);
              return (
                <View key={group.id}>
                  <GroupHeader
                    id={group.id}
                    title={group.title}
                    count={group.entries.length}
                    anomalyCount={group.anomalyCount}
                    noDataCount={group.noDataCount}
                    lockedOpen={group.lockedOpen}
                    collapsed={collapsed}
                    onToggle={onToggleGroup}
                  />
                  {!collapsed && (
                    <View style={styles.grid}>
                      {group.entries.map(([domainKey, signal]) => {
                        const icon = ICONS[domainKey] ?? 'analytics-outline';
                        const Card = cardKindFor(domainKey) === 'flow' ? FlowMeterCard : GaugeCard;
                        return (
                          <View key={domainKey} style={styles.cell}>
                            <Card
                              signal={signal}
                              name={domainKey}
                              icon={icon}
                              frozen={frozen}
                              compact={prefs.compact}
                              plantId={selectedPlant.id}
                            />
                          </View>
                        );
                      })}
                    </View>
                  )}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>

      <LiveBadge state={livenessState} loading={isLoading && !snapshot} integrationPending={integrationPending} />
    </SafeAreaView>
  );
}

/** Reloj aislado: el tick de 1 s re-renderiza SOLO este texto, no todo el tablero (antes
 *  `useTime()` en la pantalla recomputaba señales/tanques cada segundo). */
function Clock() {
  const time = useTime();
  return (
    <Text style={styles.clock}>
      {time.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </Text>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.surface },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  content: { padding: 12 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
    paddingHorizontal: 4,
  },
  plantName: { fontSize: 17, fontWeight: '800', color: Colors.textPrimary },
  sectionSubtitle: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  densityBtn: {
    borderWidth: 1,
    borderColor: Colors.divider,
    borderRadius: 8,
    padding: 6,
  },
  clock: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  cell: { width: '50%' },
  /** Fila entera: para los tanques en pantallas estrechas, donde el texto largo no cabe a la mitad. */
  cellFull: { width: '100%' },
  info: { paddingVertical: 48, alignItems: 'center', gap: 6 },
  infoText: { color: Colors.textSecondary, fontSize: 14, textAlign: 'center' },
  infoSub: { color: Colors.textSecondary, fontSize: 12, marginTop: 6, textAlign: 'center', paddingHorizontal: 20 },
});
