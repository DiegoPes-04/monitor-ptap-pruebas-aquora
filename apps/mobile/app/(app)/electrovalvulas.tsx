import { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useSnapshot } from '../../hooks/useSnapshot';
import { usePlant } from '../../context/PlantContext';
import { useAuth } from '../../context/AuthContext';
import { ValveItem } from '../../components/ValveItem';
import { ValveConfirmDialog } from '../../components/ValveConfirmDialog';
import { ValveResultDialog } from '../../components/ValveResultDialog';
import { PlantSelector } from '../../components/PlantSelector';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { LiveBadge } from '../../components/LiveBadge';
import { ListSkeleton } from '../../components/Skeleton';
import { OfflineNotice } from '../../components/OfflineNotice';
import { valvesFromSnapshot, accionDisponible, type CommandVerdict } from '../../services/valves';
import { useValveSupervisor, type SupervisedValve } from '../../hooks/useValveSupervisor';
import { useDashboardPrefs } from '../../services/dashboard-prefs';
import { EN_INTEGRACION } from '../../services/plant-status';
import Colors from '../../constants/colors';

/**
 * El mando remoto está habilitado en TODAS las plantas que tengan válvula mapeada. Antes solo
 * La Sirena estaba autorizada, por ser la única verificada en campo de punta a punta
 * (docs/PRUEBA_VALVULA_SIRENA.md). Esa lista blanca se retiró por decisión de operación.
 *
 * La protección pasó a ser la doble confirmación (ValveConfirmDialog): ninguna orden sale de un
 * solo toque. El resto de las defensas del backend siguen intactas — RBAC, interlock, idempotencia,
 * read-back y auditoría; ninguna se relajó aquí.
 */

/** Maniobra a la espera de que el operador confirme en el diálogo. */
interface Pendiente {
  valve: SupervisedValve;
  verb: 'open' | 'close';
}

export default function ElectrovalvulasScreen() {
  const { selectedPlant } = usePlant();
  const { hasPermission } = useAuth();
  const canView = hasPermission('view_dashboard'); // el Civil no ve electroválvulas
  const canControl = hasPermission('control_valves');

  const { data: snapshot, isLoading, isError, refetch, isRefetching } = useSnapshot(selectedPlant.id, canView);
  const rawValves = useMemo(() => valvesFromSnapshot(snapshot), [snapshot]);
  const { valves, send, busy } = useValveSupervisor(selectedPlant.id, rawValves);
  const [pendiente, setPendiente] = useState<Pendiente | null>(null);
  /** Veredicto de la última orden, a la espera de acuse de recibo. NUNCA es un toast: ver
   *  `ValveResultDialog`. */
  const [resultado, setResultado] = useState<(CommandVerdict & { valveName: string }) | null>(null);
  const livenessState = snapshot?.liveness.state ?? 'frozen';
  const frozen = livenessState === 'frozen';
  // Aún no conectada al PLC maestro: su `frozen` no es una caída (ver services/plant-status.ts).
  const integrationPending = snapshot?.integrationPending === true;
  const apiReachable = !isError || (!!snapshot && !snapshot.pending);
  const showError = isError && !snapshot;
  const plantName = snapshot?.displayName ?? selectedPlant.name;

  // El hook hidrata además del almacenamiento: antes solo el tablero lo hacía, así que entrar
  // directo a esta pantalla (recarga web en /electrovalvulas) ignoraba la preferencia guardada.
  const { compact } = useDashboardPrefs();

  // Memoizados: eran tres recorridos completos del array en CADA render.
  const { openCount, closedCount, conLecturaDeEstado } = useMemo(
    () => ({
      openCount: valves.filter((v) => v.effectiveState === 'open').length,
      closedCount: valves.filter((v) => v.effectiveState === 'closed').length,
      // Sin señal de estado eléctrico el read-back no puede confirmar la maniobra: hay que avisarlo.
      conLecturaDeEstado: valves.some((v) => v.byState !== null),
    }),
    [valves],
  );

  /** El toque en la lista ya NO ejecuta: solo propone la maniobra y abre la confirmación.
   *  Estable (`useCallback`) para que las N filas compartan la MISMA función y su memo funcione. */
  const onToggle = useCallback(
    (valve: SupervisedValve) => {
      // El verbo lo decide `accionDisponible`, la MISMA función con la que la fila decidió qué
      // botón dibujar. Calcularlo aquí por separado —como se hacía antes— permite que el botón
      // diga "Abrir" y salga un "close" si los dos criterios se separan al evolucionar. Y si la
      // acción está bloqueada no se abre ningún diálogo: la fila no debería haber ofrecido nada.
      const accion = accionDisponible(valve, frozen);
      if (accion.kind !== 'command') return;
      setPendiente({ valve, verb: accion.verb });
    },
    [frozen],
  );

  // Guard de rol de pantalla (coherente con tablero/reportes). Va tras TODOS los hooks: si a
  // alguien le retiran el permiso con la pantalla abierta, el número de hooks no puede cambiar.
  if (!canView) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <View style={styles.centered}>
          <Ionicons name="lock-closed-outline" size={40} color={Colors.textSecondary} />
          <Text style={styles.plantName}>Acceso restringido</Text>
          <Text style={styles.sectionSubtitle}>Las electroválvulas no están disponibles para tu rol.</Text>
        </View>
      </SafeAreaView>
    );
  }

  /** Segundo paso: el operador aceptó en el diálogo. Recién aquí sale la orden al PLC. */
  async function onConfirmar() {
    if (!pendiente) return;
    const { valve, verb } = pendiente;
    setPendiente(null);
    const verdict = await send(valve, verb);
    // A un diálogo con acuse de recibo, NO a un toast: aquí se movió un actuador físico y el
    // veredicto puede ser "enviado pero sin confirmar", que el operador debe leer sí o sí.
    setResultado({ ...verdict, valveName: valve.name });
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
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => {
              void refetch();
            }}
            colors={[Colors.primary]}
            tintColor={Colors.primary}
          />
        }
      >
        <View style={styles.sectionHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.plantName}>{plantName}</Text>
            <Text style={styles.sectionSubtitle}>Electroválvulas</Text>
          </View>
          {valves.length > 0 && (
            <View style={styles.summary}>
              <Text style={[styles.summaryCount, { color: Colors.success }]}>{openCount} abiertas</Text>
              <Text style={styles.summaryDot}> · </Text>
              <Text style={[styles.summaryCount, { color: Colors.danger }]}>{closedCount} cerradas</Text>
            </View>
          )}
        </View>

        {/*
          Aquí había dos franjas fijas y una lista de avisos efímeros. Se quitaron a petición de
          operación: TODO lo que tenga que ver con una válvula va a la bandeja de notificaciones,
          donde queda registrado con quién lo hizo, a qué hora y con la firma de la maniobra — y
          donde lo ve el resto del equipo, no solo quien tuviera esta pantalla abierta.

          Lo que decían no se ha perdido: la advertencia de que esta planta no confirma
          eléctricamente la maniobra vive ahora en el diálogo de confirmación, justo antes de que
          alguien mande la orden, que es cuando sirve para algo.
        */}
        {isLoading && !snapshot ? (
          <ListSkeleton rows={3} label="Cargando las electroválvulas" />
        ) : showError ? (
          <OfflineNotice
            title="No se pudieron cargar las electroválvulas."
            detail="No hay conexión con el servidor y este dispositivo no tiene ninguna lectura guardada de esta planta. Sin estado real no se debe operar una válvula."
            onRetry={() => void refetch()}
            retryLabel="Reintentar la carga de las electroválvulas"
          />
        ) : valves.length === 0 && integrationPending ? (
          // No es «sin válvulas mapeadas» a secas: las tiene en campo, pero la planta aún no está
          // conectada al PLC maestro, y decirlo así evita que alguien lo reporte como una falla.
          <View style={styles.loadingWrap}>
            <Ionicons name="construct-outline" size={34} color={Colors.textSecondary} />
            <Text style={styles.loadingText}>{EN_INTEGRACION.titulo}</Text>
            <Text style={styles.loadingSub}>{EN_INTEGRACION.valvulas}</Text>
          </View>
        ) : valves.length === 0 ? (
          <View style={styles.loadingWrap}>
            <Ionicons name="git-branch-outline" size={34} color={Colors.textSecondary} />
            <Text style={styles.loadingText}>Esta planta no tiene electroválvulas mapeadas.</Text>
            <Text style={styles.loadingSub}>
              Solo aparecen las válvulas declaradas en el mapping de la planta: las de mando
              (INT_OUT/INT_IN) y las proporcionales que reportan su apertura. Los tanques
              retransmitidos por otra planta no tienen canal propio.
            </Text>
          </View>
        ) : (
          valves.map((valve) => (
            <ValveItem
              key={valve.id}
              valve={valve}
              frozen={frozen}
              busy={busy === valve.id}
              compact={compact}
              // Sin canal de comando no hay botón: hacer confirmar una maniobra que solo puede
              // acabar en 404 es peor que no ofrecerla. ValveItem pone la nota en su lugar.
              onToggle={canControl && valve.commandable ? onToggle : undefined}
            />
          ))
        )}

        {valves.length > 0 && !canControl && (
          <Text style={styles.note}>Tu rol puede ver el estado, pero no operar válvulas.</Text>
        )}
      </ScrollView>

      <ValveConfirmDialog
        visible={pendiente !== null}
        valveName={pendiente?.valve.name ?? ''}
        plantName={plantName}
        verb={pendiente?.verb ?? 'open'}
        busy={pendiente !== null && busy === pendiente.valve.id}
        conLecturaDeEstado={conLecturaDeEstado}
        onConfirm={() => void onConfirmar()}
        onCancel={() => setPendiente(null)}
      />

      <ValveResultDialog verdict={resultado} onClose={() => setResultado(null)} />

      <LiveBadge state={livenessState} loading={isLoading && !snapshot} integrationPending={integrationPending} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.surface },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  content: { padding: 14 },
  sectionHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 },
  plantName: { fontSize: 17, fontWeight: '800', color: Colors.textPrimary },
  sectionSubtitle: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  summary: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  summaryCount: { fontSize: 12, fontWeight: '700' },
  summaryDot: { color: Colors.textSecondary, fontSize: 12 },
  notice: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    backgroundColor: Colors.primary + '10',
    borderLeftWidth: 3,
    borderLeftColor: Colors.primary,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  noticeOk: { backgroundColor: Colors.success + '10', borderLeftColor: Colors.success },
  noticeWarn: { backgroundColor: Colors.warning + '12', borderLeftColor: Colors.warning },
  noticeText: { flex: 1, fontSize: 12, lineHeight: 17, color: Colors.textSecondary },
  event: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    borderRadius: 8,
    borderLeftWidth: 3,
    padding: 10,
    marginBottom: 8,
  },
  eventManual: { backgroundColor: Colors.warning + '12', borderLeftColor: Colors.warning },
  eventCmd: { backgroundColor: Colors.primary + '10', borderLeftColor: Colors.primary },
  eventTitle: { fontSize: 12.5, fontWeight: '700', color: Colors.textPrimary },
  eventMsg: { fontSize: 11.5, lineHeight: 16, color: Colors.textSecondary, marginTop: 2 },
  loadingWrap: { paddingVertical: 44, alignItems: 'center', gap: 8 },
  loadingText: { color: Colors.textSecondary, fontSize: 14, textAlign: 'center' },
  loadingSub: { color: Colors.textSecondary, fontSize: 12, textAlign: 'center', paddingHorizontal: 20 },
  note: { fontSize: 12, color: Colors.textSecondary, textAlign: 'center', marginTop: 12, fontStyle: 'italic' },
});
