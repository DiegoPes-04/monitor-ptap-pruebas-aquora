import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import type { AuthUser, Permission } from '@ptap/shared';
import { hasPermission as checkPermission } from '@ptap/shared';
import { setAuthToken, setOnUnauthorized } from '../services/api';
import { resetSocket } from '../services/socket';
// Claves, almacenamiento y lectura del `exp` viven en `session-store` para que la tarea de segundo
// plano —que corre sin React— pueda leer la misma sesión. Ver ese módulo.
import { TOKEN_KEY, USER_KEY, storage, tokenExpiryMs } from '../services/session-store';

interface AuthContextType {
  token: string | null;
  user: AuthUser | null;
  isLoading: boolean;
  login: (token: string, user: AuthUser) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (perm: Permission) => boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restaura la sesión persistida y deja el cliente REST listo con ese token. Una sesión
  // VENCIDA (el token pasó sus 8 h) se descarta aquí mismo: recargar la página no la revive
  // y el usuario cae en el login, no en una app que fallará con 401 en cada petición.
  useEffect(() => {
    Promise.all([
      storage.getItem(TOKEN_KEY),
      storage.getItem(USER_KEY),
    ])
      .then(([storedToken, storedUser]) => {
        const exp = storedToken ? tokenExpiryMs(storedToken) : null;
        if (storedToken && exp !== null && exp <= Date.now()) {
          void storage.deleteItem(TOKEN_KEY);
          void storage.deleteItem(USER_KEY);
          return; // sin sesión: el guard de rutas manda al login
        }
        setToken(storedToken ?? null);
        setAuthToken(storedToken ?? null); // el JWT restaurado viaja en las peticiones
        setUser(storedUser ? (JSON.parse(storedUser) as AuthUser) : null);
      })
      .finally(() => setIsLoading(false));
  }, []);

  // Un 401 del backend (token vencido/revocado) limpia la sesión persistida.
  useEffect(() => {
    setOnUnauthorized(() => {
      void logout();
    });
    return () => setOnUnauthorized(null);
  }, []);

  // Cierre AUTOMÁTICO al vencer el token (8 h): sin esto, una app abierta pero quieta (sin
  // peticiones) seguiría mostrando la sesión como viva más allá de su expiración. Al dispararse,
  // logout() deja token=null y el guard de (app)/_layout redirige al login solo.
  useEffect(() => {
    if (!token) return;
    const exp = tokenExpiryMs(token);
    if (exp === null) return; // sin exp legible: el 401 del backend hará el cierre
    const remaining = exp - Date.now();
    if (remaining <= 0) {
      void logout();
      return;
    }
    const timer = setTimeout(() => void logout(), remaining);
    return () => clearTimeout(timer);
  }, [token]);

  // En nativo los timers de JS se estrangulan con la app en background: si el token vence estando
  // en segundo plano, el setTimeout de arriba puede no haber disparado. Al volver a primer plano se
  // re-evalúa la expiración para cerrar la sesión de inmediato (no esperar al 401 de la próxima
  // petición, que podría no ocurrir si todo se sirve de cache/push).
  useEffect(() => {
    if (!token) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const exp = tokenExpiryMs(token);
      if (exp !== null && exp <= Date.now()) void logout();
    });
    return () => sub.remove();
  }, [token]);

  const login = useCallback(async (newToken: string, newUser: AuthUser) => {
    await Promise.all([
      storage.setItem(TOKEN_KEY, newToken),
      storage.setItem(USER_KEY, JSON.stringify(newUser)),
    ]);
    setAuthToken(newToken);
    // Cierra cualquier socket previo para que el próximo se abra con ESTE token (no el de una
    // sesión anterior que hubiera quedado abierta).
    resetSocket();
    setToken(newToken);
    setUser(newUser);
  }, []);

  const logout = useCallback(async () => {
    await Promise.all([
      storage.deleteItem(TOKEN_KEY),
      storage.deleteItem(USER_KEY),
    ]);
    setAuthToken(null);
    // Corta el stream de datos del usuario que sale: sin esto el WS seguiría vivo y recibiendo
    // snapshots con el JWT ya sin sesión.
    resetSocket();
    setToken(null);
    setUser(null);
  }, []);

  const hasPermission = useCallback(
    (perm: Permission): boolean => (user ? checkPermission(user.role, perm) : false),
    [user],
  );

  // El valor del provider se memoiza: envuelve TODA la app, y con un objeto literal nuevo en cada
  // render cualquier cambio de estado aquí invalidaba a los ~10 consumidores de `useAuth()`,
  // incluida la cáscara de pestañas. Con `login`/`logout`/`hasPermission` estables, el valor solo
  // cambia cuando cambia de verdad la sesión.
  const value = useMemo(
    () => ({ token, user, isLoading, login, logout, hasPermission }),
    [token, user, isLoading, login, logout, hasPermission],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
