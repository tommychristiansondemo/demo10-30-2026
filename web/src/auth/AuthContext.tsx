import { Hub } from 'aws-amplify/utils';
import { getCurrentUser, signOut as amplifySignOut } from 'aws-amplify/auth';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { Me, Role } from '../api/types';

const RANK: Record<Role, number> = { Viewer: 0, Analyst: 1, Operator: 2, Admin: 3 };

interface AuthState {
  status: 'loading' | 'signedOut' | 'signedIn';
  me?: Me;
  error?: string;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  can: (role: Role) => boolean;
  feature: (flag: string) => boolean;
}

const Ctx = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [me, setMe] = useState<Me>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      await getCurrentUser();
    } catch {
      setStatus('signedOut');
      setMe(undefined);
      return;
    }
    try {
      setMe(await api.get<Me>('/v1/me'));
      setError(undefined);
      setStatus('signedIn');
    } catch (e) {
      setError((e as Error).message);
      setStatus('signedOut');
    }
  }, []);

  useEffect(() => {
    void refresh();
    return Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedIn' || payload.event === 'signInWithRedirect') void refresh();
      if (payload.event === 'signedOut') { setStatus('signedOut'); setMe(undefined); }
    });
  }, [refresh]);

  const value: AuthState = {
    status,
    me,
    error,
    refresh,
    signOut: async () => { await amplifySignOut(); },
    can: (role) => !!me && RANK[me.user.role] >= RANK[role],
    feature: (flag) => !!me?.config.features[flag],
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
