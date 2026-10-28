import { useMemo, useState } from 'react';
import { Tabs, Redirect, router } from 'expo-router';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Colors from '../../constants/colors';
import { useAuth } from '../../context/AuthContext';
import { useUnseenNotifications } from '../../hooks/useNotifications';
import { NotificationOptIn } from '../../components/NotificationOptIn';
import { usePendingUsers } from '../../hooks/usePendingUsers';
import { useWebEscape } from '../../hooks/useWebEscape';
import { ROLE_LABELS, ROLE_COLORS, type AuthUser } from '@ptap/shared';

/**
 * Campana de notificaciones AISLADA.
 *
 * Cuenta avisos **NO VISTOS**, no alertas activas. Es la diferencia que pidió operación: la
 * campana se apaga cuando alguien los mira, no cuando el problema se resuelve — un sensor caído
 * hace 15 días deja de gritar en rojo una vez leído, pero sigue en el historial.
 *
 * Vive en su propia hoja para que su sondeo no repinte la cáscara de pestañas entera, igual que
 * el `<Clock />` de `tablero.tsx`.
 */
/**
 * Marca de la barra superior: el icono de Aquora y el nombre.
 *
 * Tres decisiones que evitan los tres defectos que se pidió evitar:
 *
 *  - **No crece la barra.** La fila se fija a 24 px de alto, muy por debajo de los 56 dp del
 *    header, así que react-navigation no tiene nada que estirar. El tamaño de la barra no depende
 *    de este componente.
 *  - **No se pixela.** El icono se sirve en tres densidades (`aquora-mark.png` 32 px, `@2x` 64,
 *    `@3x` 96) y Metro elige la que toca; a 22 px de render, incluso el 1x va sobrado. Y el
 *    nombre es TEXTO, no una imagen del wordmark: el texto es nítido a cualquier densidad por
 *    construcción, así que no hay forma de que se vea borroso.
 *  - **No se corta.** El recorte del icono es exactamente cuadrado (156×156 del logo original) y
 *    se pinta cuadrado, así que la relación de aspecto coincide y no hay nada que recortar.
 *    `contain` es el cinturón de seguridad si algún día se cambia el asset por uno no cuadrado.
 *
 * Se usa el `Image` del core y no `expo-image` —que es lo que recomienda el SDK 56— a propósito:
 * `expo-image` es un módulo NATIVO, así que añadirlo obliga a recompilar la APK y a que todos
 * reinstalen (esta app no tiene actualización automática). Para un icono de 22 px no lo vale, y el
 * `Image` del core sigue soportado en 56. Es además lo que ya usa la pantalla de login.
 */
function BrandTitle() {
  return (
    <View style={styles.marca} accessibilityRole="header">
      <Image
        source={require('../../assets/aquora-mark.png')}
        style={styles.marcaIcono}
        resizeMode="contain"
        // Decorativa: el nombre va al lado como texto, así que un lector de pantalla que
        // anunciara también la imagen diría "Aquora" dos veces.
        accessible={false}
      />
      <Text style={styles.marcaTexto}>AQUORA</Text>
    </View>
  );
}

function AlertBell() {
  const unseen = useUnseenNotifications();
  return (
    <TouchableOpacity
      style={{ marginRight: 16 }}
      hitSlop={8}
      onPress={() => router.push('/(app)/alertas')}
      accessibilityRole="button"
      accessibilityLabel={
        unseen > 0 ? `Notificaciones: ${unseen} sin ver` : 'Notificaciones: ninguna sin ver'
      }
    >
      <View>
        <Ionicons name="notifications-outline" size={24} color="#fff" />
        {unseen > 0 && (
          <View style={styles.notifBadge}>
            <Text style={styles.notifText}>{unseen > 9 ? '9+' : unseen}</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

/** Botón de menú aislado: `usePendingUsers` sondea cada 60 s y no debe repintar la cáscara. */
function MenuButton({ onPress }: { onPress: () => void }) {
  const { count } = usePendingUsers();
  return (
    <TouchableOpacity
      style={{ marginLeft: 16 }}
      hitSlop={8}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `Menú. ${count} cuentas pendientes de aprobar` : 'Menú'}
    >
      <View>
        <Ionicons name="menu" size={24} color="#fff" />
        {/* Punto de aviso: hay cuentas pendientes de aprobar (solo lo ve un admin). */}
        {count > 0 && (
          <View style={styles.menuDot}>
            <Text style={styles.notifText}>{count > 9 ? '9+' : count}</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

function MenuModal({
  visible,
  onClose,
  user,
}: {
  visible: boolean;
  onClose: () => void;
  user: AuthUser | null;
}) {
  const { logout, hasPermission } = useAuth();
  const { count: pendingCount } = usePendingUsers();

  async function handleLogout() {
    onClose();
    await logout();
    router.replace('/(auth)/login');
  }

  function goToUsers() {
    onClose();
    router.push('/(app)/usuarios');
  }

  function goToSettings() {
    onClose();
    router.push('/(app)/ajustes');
  }

  function goToAlerts() {
    onClose();
    router.push('/(app)/alertas');
  }

  const roleColor = user ? ROLE_COLORS[user.role] : Colors.primary;

  // `onRequestClose` solo dispara en Android. En web, Escape no cerraba el menú: había que
  // acertarle al fondo con el ratón.
  useWebEscape(visible, onClose);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={styles.overlay}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Cerrar el menú"
      >
        <Pressable
          style={styles.drawer}
          onPress={() => {}}
          // Aísla el menú del resto del árbol para los lectores de pantalla mientras está abierto.
          accessibilityViewIsModal
          accessibilityRole="menu"
        >
          <View style={styles.drawerHeader}>
            <View style={styles.drawerAvatar}>
              <Ionicons name="person" size={28} color="#fff" />
            </View>
            <Text style={styles.drawerTitle}>{user?.name ?? 'Usuario'}</Text>
            <View style={[styles.roleBadge, { backgroundColor: roleColor + '30' }]}>
              <Text style={[styles.roleText, { color: '#fff' }]}>
                {user ? ROLE_LABELS[user.role] : '—'}
              </Text>
            </View>
            <Text style={styles.drawerSubtitle}>{user?.plant ?? 'Sistema de Monitoreo'}</Text>
          </View>

          {/* Solo Admin: la matriz oficial reserva la gestión de usuarios al Administrador.
              Ocultarlo es comodidad de UI — el backend igual responde 403 a los demás. */}
          {hasPermission('manage_users') && (
            <TouchableOpacity style={styles.drawerItem} onPress={goToUsers}>
              <Ionicons name="people-outline" size={20} color={Colors.textPrimary} />
              <Text style={styles.drawerItemText}>Usuarios</Text>
              {pendingCount > 0 && (
                <View style={styles.pendingPill}>
                  <Text style={styles.pendingPillText}>
                    {pendingCount > 9 ? '9+' : pendingCount} pendiente{pendingCount === 1 ? '' : 's'}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          )}

          <TouchableOpacity style={styles.drawerItem} onPress={goToSettings}>
            <Ionicons name="settings-outline" size={20} color={Colors.textPrimary} />
            <Text style={styles.drawerItemText}>Ajustes</Text>
          </TouchableOpacity>

          {/* Alertas REALES (derivadas del snapshot): solo tienen sentido para roles que ven el
              tablero. El Civil (solo estado básico) no recibe señales, así que no se le ofrece. */}
          {hasPermission('view_dashboard') && (
            <TouchableOpacity style={styles.drawerItem} onPress={goToAlerts}>
              <Ionicons name="notifications-outline" size={20} color={Colors.textPrimary} />
              <Text style={styles.drawerItemText}>Alertas</Text>
            </TouchableOpacity>
          )}

          <View style={styles.drawerDivider} />

          <TouchableOpacity style={styles.drawerLogout} onPress={handleLogout}>
            <Ionicons name="log-out-outline" size={20} color={Colors.danger} />
            <Text style={styles.drawerLogoutText}>Cerrar sesión</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default function AppLayout() {
  const [menuVisible, setMenuVisible] = useState(false);
  const { user, token, isLoading } = useAuth();
  const isCivil = user?.role === 'civil';

  // Opciones de cabecera ESTABLES: se esparcen en 7 `Tabs.Screen`, así que recrearlas en cada
  // render obligaba a react-navigation a re-evaluar las 7. `setMenuVisible` es estable (useState),
  // y los conteos viven ahora dentro de `<AlertBell/>` y `<MenuButton/>`, no aquí.
  const HEADER_OPTS = useMemo(
    () => ({
      headerStyle: { backgroundColor: Colors.primary },
      headerTintColor: '#fff',
      headerTitle: () => <BrandTitle />,
      // Se conserva aunque el título de arriba sea un componente: cuatro pantallas
      // (Estado/Alertas/Usuarios/Ajustes) sobreescriben `headerTitle` con un STRING y heredan
      // este estilo. Quitarlo las dejaba con la tipografía por defecto de react-navigation.
      headerTitleStyle: { fontWeight: '800' as const, fontSize: 16, letterSpacing: 1 },
      headerLeft: () => <MenuButton onPress={() => setMenuVisible(true)} />,
      headerRight: () => <AlertBell />,
    }),
    [],
  );

  // GUARD de sesión para TODAS las rutas de (app). Cubre tres caminos al login:
  //  1. Recargar la página en una ruta profunda (/sensores, /ajustes…) sin sesión — antes la
  //     pantalla se renderizaba igual (solo index.tsx redirigía) y quedaba rota a punta de 401.
  //  2. El cierre AUTOMÁTICO a las 8 h (AuthContext vence el token y deja token=null).
  //  3. Un 401 del backend (token revocado/vencido): onUnauthorized hace logout y esto redirige.
  // Mientras se restaura la sesión persistida no se decide nada (evita el parpadeo al login).
  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg }}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }
  if (!token) return <Redirect href="/(auth)/login" />;

  return (
    <>
      {/* La franja de permiso vive AQUÍ, no en Ajustes. El permiso del sistema no se puede pedir
          solo —los navegadores lo rechazan y Android lo cuenta como denegado para siempre—, así que
          hace falta un gesto del usuario; y hasta ahora ese gesto solo era posible si alguien
          entraba a Ajustes y encontraba la tarjeta. Quien no lo hiciera no recibía un solo aviso en
          el móvil sin manera de enterarse. Montarla en la cáscara también registra la tarea de
          fondo (`useDeviceNotifications`), que era el otro motivo por el que casi nadie los recibía. */}
      <NotificationOptIn />
      {/* Montado solo mientras está abierto: un `<Modal visible={false}>` monta igual su subárbol,
          y con él un segundo observador de `usePendingUsers` que re-renderizaba el cajón cerrado
          cada 60 s. El badge del botón de menú sigue vivo por su cuenta. */}
      {menuVisible && <MenuModal visible onClose={() => setMenuVisible(false)} user={user} />}
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: Colors.primary,
          tabBarInactiveTintColor: Colors.textSecondary,
          tabBarStyle: isCivil
            ? { display: 'none' }
            : {
                backgroundColor: Colors.bg,
                borderTopColor: Colors.divider,
                elevation: 0,
                shadowOpacity: 0,
              },
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        }}
      >
        <Tabs.Screen
          name="tablero"
          options={{
            ...HEADER_OPTS,
            tabBarLabel: 'Tablero',
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons
                name={focused ? 'grid' : 'grid-outline'}
                size={size}
                color={typeof color === 'string' ? color : Colors.primary}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="electrovalvulas"
          options={{
            ...HEADER_OPTS,
            tabBarLabel: 'Válvulas',
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons
                name={focused ? 'toggle' : 'toggle-outline'}
                size={size}
                color={typeof color === 'string' ? color : Colors.primary}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="reportes"
          options={{
            ...HEADER_OPTS,
            tabBarLabel: 'Reportes',
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons
                name={focused ? 'document-text' : 'document-text-outline'}
                size={size}
                color={typeof color === 'string' ? color : Colors.primary}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="estado"
          options={{
            href: null,
            ...HEADER_OPTS,
            headerTitle: 'Estado General',
          }}
        />
        {/* Fuera del tab bar: se entra desde el menú/campana. Solo roles con view_dashboard. */}
        <Tabs.Screen
          name="alertas"
          options={{
            href: null,
            ...HEADER_OPTS,
            headerTitle: 'Alertas',
          }}
        />
        {/* Fuera del tab bar: se entra desde el menú, y solo si el rol tiene manage_users. */}
        <Tabs.Screen
          name="usuarios"
          options={{
            href: null,
            ...HEADER_OPTS,
            headerTitle: 'Usuarios',
          }}
        />
        {/* Fuera del tab bar: se entra desde el menú. Disponible para todos los roles. */}
        <Tabs.Screen
          name="ajustes"
          options={{
            href: null,
            ...HEADER_OPTS,
            headerTitle: 'Ajustes',
          }}
        />
        {/* Fuera del tab bar: se entra desde Ajustes, y el backend solo la sirve con
            `system_config`. La pantalla vuelve a comprobarlo por su cuenta. */}
        <Tabs.Screen
          name="desarrollador"
          options={{
            href: null,
            ...HEADER_OPTS,
            headerTitle: 'Modo desarrollador',
          }}
        />
      </Tabs>
    </>
  );
}

const styles = StyleSheet.create({
  // Altura FIJA y por debajo de los 56 dp del header: así este componente no puede estirar la
  // barra pase lo que pase con el icono o con el tamaño de fuente del sistema.
  marca: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 24 },
  // Cuadrado, igual que el recorte del asset (156x156): la relación coincide y no hay recorte.
  marcaIcono: { width: 22, height: 22 },
  // El nombre como TEXTO: nítido a cualquier densidad, y hereda el color del header.
  marcaTexto: { color: '#fff', fontSize: 17, fontWeight: '800', letterSpacing: 1.5 },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    flexDirection: 'row',
  },
  drawer: {
    width: 280,
    backgroundColor: Colors.bg,
    paddingBottom: 32,
  },
  drawerHeader: {
    backgroundColor: Colors.primary,
    paddingTop: 52,
    paddingBottom: 24,
    paddingHorizontal: 20,
    alignItems: 'flex-start',
  },
  drawerAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  drawerTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  roleBadge: {
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
    alignSelf: 'flex-start',
  },
  roleText: {
    fontSize: 12,
    fontWeight: '700',
  },
  drawerSubtitle: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 13,
    marginTop: 6,
  },
  drawerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  drawerItemText: {
    fontSize: 15,
    color: Colors.textPrimary,
    fontWeight: '500',
  },
  drawerDivider: {
    height: 1,
    backgroundColor: Colors.divider,
    marginHorizontal: 20,
    marginVertical: 8,
  },
  drawerLogout: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  drawerLogoutText: {
    fontSize: 15,
    color: Colors.danger,
    fontWeight: '600',
  },
  notifBadge: {
    position: 'absolute',
    top: -4,
    right: -6,
    backgroundColor: Colors.danger,
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  notifText: { color: '#fff', fontSize: 9, fontWeight: '700' },
  menuDot: {
    position: 'absolute',
    top: -6,
    right: -8,
    backgroundColor: Colors.danger,
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  pendingPill: {
    marginLeft: 'auto',
    backgroundColor: Colors.danger,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  pendingPillText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
