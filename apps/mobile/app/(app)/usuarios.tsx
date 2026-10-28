import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { ROLES, ROLE_LABELS, type Role, type UserSummary } from '@ptap/shared';
import { fetchUsers, setUserActive, updateUserRole } from '../../services/users';
import { useAuth } from '../../context/AuthContext';
import { toast } from '../../services/toast-store';
import { UserCard } from '../../components/UserCard';
import Colors from '../../constants/colors';

/** Filtro por estado. `pendientes` (is_active=0) es la bandeja de entrada del admin. */
type StatusFilter = 'todos' | 'pendientes' | 'activos';

const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'pendientes', label: 'Pendientes' },
  { key: 'activos', label: 'Activos' },
  { key: 'todos', label: 'Todos' },
];

function isActiveOf(status: StatusFilter): boolean | undefined {
  if (status === 'pendientes') return false;
  if (status === 'activos') return true;
  return undefined;
}

const PAGE_SIZE = 50;

/**
 * Gestión de usuarios — SOLO Administrador (matriz oficial: "Crear, editar y eliminar
 * usuarios" y "Asignar roles a los usuarios"). El backend es quien manda: exige los permisos
 * `manage_users`/`assign_roles` y responde 403 a cualquier otro rol. Ocultar esta pantalla
 * es comodidad de UI, NO la seguridad.
 *
 * Aquí es donde "alguien confirma" el rol: los usuarios se registran solos y quedan pendientes
 * hasta que un admin los aprueba (y, si corresponde, los eleva). Cada cambio queda auditado.
 *
 * La búsqueda y los filtros se resuelven en el servidor: la pantalla arranca en "Pendientes"
 * porque son las cuentas que esperan una decisión.
 */
export default function UsuariosScreen() {
  const { user: current, hasPermission } = useAuth();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('pendientes');
  const [roleFilter, setRoleFilter] = useState<Role | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  // page vive fuera de React state para no crear una dependencia circular con `load` — se lee/
  // escribe de forma síncrona dentro del propio callback (ver comentario en loadMore).
  const pageRef = useRef(1);

  const load = useCallback(
    async (term: string, statusFilter: StatusFilter, role: Role | null, page: number, append: boolean) => {
      try {
        setError(null);
        const result = await fetchUsers({
          search: term,
          role: role ?? undefined,
          isActive: isActiveOf(statusFilter),
          page,
          limit: PAGE_SIZE,
        });
        setUsers((prev) => (append ? [...prev, ...result.users] : result.users));
        setTotal(result.total);
        pageRef.current = page;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No se pudieron cargar los usuarios');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [],
  );

  // Debounce: cada tecla es una consulta a la BD; 300 ms basta para que se sienta inmediato
  // sin disparar una petición por letra. Cambiar el filtro siempre vuelve a la página 1.
  useEffect(() => {
    const id = setTimeout(() => void load(search, status, roleFilter, 1, false), 300);
    return () => clearTimeout(id);
  }, [load, search, status, roleFilter]);

  const loadMore = useCallback(() => {
    if (loadingMore || users.length >= total) return;
    setLoadingMore(true);
    void load(search, status, roleFilter, pageRef.current + 1, true);
  }, [load, loadingMore, users.length, total, search, status, roleFilter]);

  // Los filtros vigentes, en una ref. Los callbacks de las fichas tienen que ser ESTABLES para que
  // el memo de `UserCard` sirva (si no, cada tecla del buscador repinta las 50 fichas), pero
  // también necesitan recargar con los filtros ACTUALES. Congelarlos en un `useCallback([])` sobre
  // el estado haría que, tras cambiar de filtro, aprobar una cuenta recargara con los filtros
  // viejos.
  const filtersRef = useRef({ search, status, roleFilter });
  useLayoutEffect(() => {
    filtersRef.current = { search, status, roleFilter };
  }, [search, status, roleFilter]);

  const onToggleExpand = useCallback(
    (id: string) => setExpandedId((current) => (current === id ? null : id)),
    [],
  );

  const onChangeRole = useCallback(async (target: UserSummary, role: Role) => {
    setExpandedId(null);
    if (target.role === role) return;
    setBusyId(target.id);
    try {
      const updated = await updateUserRole(target.id, role);
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      toast.success('Rol actualizado', `${updated.name} ahora es ${ROLE_LABELS[role]}.`);
    } catch (err) {
      toast.error('No se pudo cambiar el rol', err instanceof Error ? err.message : 'Intenta de nuevo.');
    } finally {
      setBusyId(null);
    }
  }, []);

  const onToggleActive = useCallback(
    async (target: UserSummary) => {
      setBusyId(target.id);
      try {
        await setUserActive(target.id, !target.isActive);
        // Recargar, no parchear en memoria: al aprobar a alguien desde "Pendientes" la cuenta
        // deja de cumplir el filtro y debe desaparecer de la lista. Parchearla la dejaría ahí,
        // contradiciendo el filtro activo. Vuelve a página 1 (la lista completa pudo cambiar de
        // tamaño/orden).
        const f = filtersRef.current;
        await load(f.search, f.status, f.roleFilter, 1, false);
        toast.success(
          target.isActive ? 'Cuenta desactivada' : 'Cuenta aprobada',
          target.isActive
            ? `${target.name} ya no puede entrar. El cambio aplica en su siguiente petición.`
            : `${target.name} ya puede entrar, con rol ${ROLE_LABELS[target.role]}.`,
        );
      } catch (err) {
        toast.error('No se pudo cambiar el estado', err instanceof Error ? err.message : 'Intenta de nuevo.');
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  // Estable también el `renderItem`: si fuera un arrow inline, la `FlatList` recorrería sus ~50
  // envoltorios de celda en cada tecla del buscador aunque el memo de `UserCard` frene ahí.
  const renderItem = useCallback(
    ({ item }: { item: UserSummary }) => (
      <UserCard
        user={item}
        isSelf={item.id === current?.id}
        busy={busyId === item.id}
        expanded={expandedId === item.id}
        onToggleExpand={onToggleExpand}
        onToggleActive={onToggleActive}
        onChangeRole={onChangeRole}
      />
    ),
    [current?.id, busyId, expandedId, onToggleExpand, onToggleActive, onChangeRole],
  );

  // TODOS los hooks quedan por encima de este early-return: si a un admin lo degradan mientras
  // tiene la pantalla abierta, `hasPermission` pasa a false y el número de hooks no puede cambiar.
  if (!hasPermission('manage_users')) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={40} color={Colors.textSecondary} />
          <Text style={styles.deniedTitle}>Acceso restringido</Text>
          <Text style={styles.deniedBody}>La gestión de usuarios es exclusiva del Administrador.</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      {error && (
        <View style={styles.errorBox}>
          <Ionicons name="alert-circle-outline" size={18} color={Colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <FlatList
        data={users}
        keyExtractor={(u) => u.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={() => void load(search, status, roleFilter, 1, false)} />
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          loadingMore ? <ActivityIndicator size="small" color={Colors.primary} style={styles.footerLoader} /> : undefined
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {status === 'pendientes' && !search && !roleFilter
              ? 'No hay cuentas pendientes de aprobación.'
              : 'Ningún usuario coincide con la búsqueda.'}
          </Text>
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.intro}>
              Las cuentas nuevas se registran como <Text style={styles.bold}>Civil</Text> y quedan{' '}
              <Text style={styles.bold}>pendientes</Text>: nadie entra hasta que las apruebes. Verifica a la
              persona (el teléfono aparece en la ficha), apruébala y asígnale el rol. Todo queda auditado.
            </Text>

            <View style={styles.searchBox}>
              <Ionicons name="search-outline" size={17} color={Colors.textSecondary} />
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder="Buscar por nombre, correo o teléfono"
                placeholderTextColor={Colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {search.length > 0 && (
                <TouchableOpacity
                  onPress={() => setSearch('')}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Limpiar la búsqueda"
                >
                  <Ionicons name="close-circle" size={17} color={Colors.textSecondary} />
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.chips}>
              {STATUS_TABS.map((tab) => (
                <TouchableOpacity
                  key={tab.key}
                  style={[styles.chip, status === tab.key && styles.chipOn]}
                  onPress={() => setStatus(tab.key)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.chipText, status === tab.key && styles.chipTextOn]}>{tab.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.chips}>
              <TouchableOpacity
                style={[styles.chip, roleFilter === null && styles.chipOn]}
                onPress={() => setRoleFilter(null)}
                activeOpacity={0.8}
              >
                <Text style={[styles.chipText, roleFilter === null && styles.chipTextOn]}>Todo rol</Text>
              </TouchableOpacity>
              {ROLES.map((r) => (
                <TouchableOpacity
                  key={r}
                  style={[styles.chip, roleFilter === r && styles.chipOn]}
                  onPress={() => setRoleFilter(roleFilter === r ? null : r)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.chipText, roleFilter === r && styles.chipTextOn]}>{ROLE_LABELS[r]}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        }
        renderItem={renderItem}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 10 },
  deniedTitle: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  deniedBody: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
  list: { padding: 16, gap: 12 },
  footerLoader: { marginVertical: 16 },
  header: { gap: 10, marginBottom: 4 },
  intro: { fontSize: 12.5, lineHeight: 18, color: Colors.textSecondary },
  bold: { fontWeight: '700', color: Colors.textPrimary },
  empty: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', paddingVertical: 28 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    borderWidth: 1, borderColor: Colors.divider,
  },
  searchInput: { flex: 1, fontSize: 14, color: Colors.textPrimary, outlineStyle: 'none' as never },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    borderWidth: 1, borderColor: Colors.divider, backgroundColor: Colors.surface,
  },
  chipOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: 12.5, fontWeight: '600', color: Colors.textSecondary },
  chipTextOn: { color: '#fff' },
  errorBox: {
    flexDirection: 'row', gap: 8, alignItems: 'center',
    backgroundColor: Colors.danger + '15', padding: 12, margin: 16, borderRadius: 10,
  },
  errorText: { flex: 1, color: Colors.danger, fontSize: 13 },
  // Los estilos de la ficha de usuario viven ahora en `components/UserCard.tsx`, junto al markup
  // que los usa. Se borraron de aquí porque habían quedado huérfanos y, peor, divergidos.
});
