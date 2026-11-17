import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { auth } from '../firebase';
import { authApi, bootstrapApi } from '../services/api';
import type { EntitlementSummary, User, Workspace } from '../types';
import { syncDeviceIfGranted, unregisterDeviceOnLogout } from '../services/fcm';

export interface BootstrapPayload {
  workspaceName: string;
  adminFullName: string;
  adminEmail: string;
  adminPassword?: string;
  useGoogleAuth?: boolean;
  department?: string;
  designation?: string;
  timezone?: string;
  setupSecret?: string;
}

interface AuthContextValue {
  user: User | null;
  workspace: Workspace | null;
  entitlement: EntitlementSummary | null;
  sessionId: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<User>;
  loginWithGoogle: () => Promise<User>;
  bootstrapWorkspace: (payload: BootstrapPayload) => Promise<User>;
  refreshSession: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function clearStoredSession() {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_session_id');
  localStorage.removeItem('auth_user');
  localStorage.removeItem('auth_workspace');
  localStorage.removeItem('auth_entitlement');
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => readStoredJson<User>('auth_user'));
  const [workspace, setWorkspace] = useState<Workspace | null>(() => readStoredJson<Workspace>('auth_workspace'));
  const [entitlement, setEntitlement] = useState<EntitlementSummary | null>(() =>
    readStoredJson<EntitlementSummary>('auth_entitlement')
  );
  const [sessionId, setSessionId] = useState<string | null>(() =>
    localStorage.getItem('auth_session_id')
  );
  const [isLoading, setIsLoading] = useState(() => Boolean(localStorage.getItem('auth_token')));

  const persistAuthBundle = useCallback(
    (bundle: {
      user: User;
      workspace?: Workspace | null;
      entitlement?: EntitlementSummary | null;
      sessionId?: string | null;
      token?: string;
    }) => {
      if (bundle.token) {
        localStorage.setItem('auth_token', bundle.token);
      }
      if (bundle.sessionId) {
        localStorage.setItem('auth_session_id', bundle.sessionId);
        setSessionId(bundle.sessionId);
      }
      localStorage.setItem('auth_user', JSON.stringify(bundle.user));
      setUser(bundle.user);

      if (bundle.workspace !== undefined) {
        if (bundle.workspace) {
          localStorage.setItem('auth_workspace', JSON.stringify(bundle.workspace));
        } else {
          localStorage.removeItem('auth_workspace');
        }
        setWorkspace(bundle.workspace || null);
      }

      if (bundle.entitlement !== undefined) {
        if (bundle.entitlement) {
          localStorage.setItem('auth_entitlement', JSON.stringify(bundle.entitlement));
        } else {
          localStorage.removeItem('auth_entitlement');
        }
        setEntitlement(bundle.entitlement || null);
      }

      syncDeviceIfGranted(bundle.user.id).catch(() => {});
    },
    []
  );

  const refreshSession = useCallback(async () => {
    const token = localStorage.getItem('auth_token');
    if (!token) return;

    const res = await authApi.me();
    const payload = res.data as any;
    if (payload?.success && payload?.data) {
      persistAuthBundle({
        user: payload.data as User,
        workspace: payload.workspace ?? null,
        entitlement: payload.entitlement ?? null,
        sessionId: payload.sessionId ?? localStorage.getItem('auth_session_id'),
      });
    }
  }, [persistAuthBundle]);

  useEffect(() => {
    let mounted = true;
    const currentToken = localStorage.getItem('auth_token');

    if (!currentToken) {
      setIsLoading(false);
      return;
    }

    authApi
      .me()
      .then((res) => {
        if (!mounted) return;
        const payload = res.data as any;
        if (payload?.success && payload?.data) {
          persistAuthBundle({
            user: payload.data as User,
            workspace: payload.workspace ?? null,
            entitlement: payload.entitlement ?? null,
            sessionId: payload.sessionId ?? localStorage.getItem('auth_session_id'),
          });
        }
      })
      .catch((err) => {
        if (mounted && err?.response?.status === 401) {
          if (localStorage.getItem('auth_token') === currentToken) {
            clearStoredSession();
            setUser(null);
            setWorkspace(null);
            setEntitlement(null);
            setSessionId(null);
          }
        }
      })
      .finally(() => {
        if (mounted) setIsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [persistAuthBundle]);

  const login = async (email: string, password: string): Promise<User> => {
    const existingSessionId = localStorage.getItem('auth_session_id') || undefined;
    try {
      const res = await authApi.login(email, password, existingSessionId);
      const payload = res.data as any;
      if (payload.success && payload.data) {
        persistAuthBundle({
          user: payload.data as User,
          workspace: payload.workspace ?? null,
          entitlement: payload.entitlement ?? null,
          sessionId: payload.sessionId ?? null,
          token: payload.token,
        });
        return payload.data as User;
      }
      throw new Error(payload.error || 'Login failed');
    } catch (err: any) {
      const serverErr = err?.response?.data?.error;
      const errCode = err?.response?.data?.code;
      if (err?.response?.status === 409 || errCode === 'ACTIVE_SESSION_CONFLICT') {
        throw new Error(
          serverErr ||
            'This account is already signed in on another device. Sign out there or wait for the 30-minute session timeout.'
        );
      }
      throw new Error(serverErr || err?.message || 'Login failed');
    }
  };

  const loginWithGoogle = async (): Promise<User> => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const cred = await signInWithPopup(auth, provider);
    const idToken = await cred.user.getIdToken();
    const existingSessionId = localStorage.getItem('auth_session_id') || undefined;

    try {
      const res = await authApi.loginWithFirebase(idToken, existingSessionId);
      const payload = res.data as any;
      if (payload.success && payload.data) {
        persistAuthBundle({
          user: payload.data as User,
          workspace: payload.workspace ?? null,
          entitlement: payload.entitlement ?? null,
          sessionId: payload.sessionId ?? null,
          token: payload.token,
        });
        return payload.data as User;
      }
      throw new Error(payload.error || 'Google sign-in failed');
    } catch (err: any) {
      await signOut(auth).catch(() => {});
      const serverErr = err?.response?.data?.error;
      const errCode = err?.response?.data?.code;
      if (err?.response?.status === 409 || errCode === 'ACTIVE_SESSION_CONFLICT') {
        throw new Error(
          serverErr ||
            'This account is already signed in on another device. Sign out there or wait for the 30-minute session timeout.'
        );
      }
      throw new Error(serverErr || err?.message || 'Google sign-in failed');
    }
  };

  const bootstrapWorkspace = async (input: BootstrapPayload): Promise<User> => {
    let firebaseIdToken: string | undefined;
    let resolvedEmail = input.adminEmail;

    if (input.useGoogleAuth) {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const cred = await signInWithPopup(auth, provider);
      firebaseIdToken = await cred.user.getIdToken();
      resolvedEmail = cred.user.email || input.adminEmail;
    }

    try {
      const res = await bootstrapApi.initializeWorkspace({
        workspaceName: input.workspaceName,
        adminFullName: input.adminFullName,
        adminEmail: resolvedEmail,
        adminPassword: input.useGoogleAuth ? undefined : input.adminPassword,
        firebaseIdToken,
        department: input.department,
        designation: input.designation,
        timezone: input.timezone,
        setupSecret: input.setupSecret,
      });

      const payload = res.data as any;
      if (payload?.success && payload?.data?.user) {
        persistAuthBundle({
          user: payload.data.user as User,
          workspace: payload.data.workspace ?? null,
          entitlement: payload.data.entitlement ?? null,
          sessionId: payload.data.sessionId ?? null,
          token: payload.token,
        });
        return payload.data.user as User;
      }
      throw new Error(payload?.error || 'Workspace initialization failed');
    } catch (err: any) {
      if (firebaseIdToken) {
        await signOut(auth).catch(() => {});
      }
      const serverErr = err?.response?.data?.error;
      throw new Error(serverErr || err?.message || 'Workspace initialization failed');
    }
  };

  const logout = async () => {
    try {
      await unregisterDeviceOnLogout();
      const deviceId = localStorage.getItem('taskflow_device_id') || undefined;
      await authApi.logout(deviceId);
    } catch {
      // ignore
    }
    try {
      await signOut(auth);
    } catch {
      // ignore
    }
    clearStoredSession();
    setUser(null);
    setWorkspace(null);
    setEntitlement(null);
    setSessionId(null);
    window.location.href = '/login';
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        workspace,
        entitlement,
        sessionId,
        isLoading,
        isAuthenticated: !!user,
        login,
        loginWithGoogle,
        bootstrapWorkspace,
        refreshSession,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
