import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase.js';
import type { SessionUser } from '@shared/types';

interface AuthContextType {
  user: SessionUser | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (
    email: string,
    password: string,
    metadata: Record<string, unknown>,
  ) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider = ({ children }: AuthProviderProps) => {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session);
      setUser(session ? await resolveSessionUser(session) : null);
      setLoading(false);
    });

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setSession(session);
      setUser(session ? await resolveSessionUser(session) : null);
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return { error };
  };

  const signUp = async (email: string, password: string, metadata: Record<string, unknown>) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: metadata,
      },
    });
    return { error };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const value = {
    user,
    session,
    loading,
    signIn,
    signUp,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

// Base identity from the Supabase user. The role is deliberately NOT taken from
// user_metadata (which the user can edit). It defaults to the least-privileged
// 'participant' and is replaced with the authoritative value from the backend in
// resolveSessionUser(). app_metadata.role is server-controlled and safe to honor
// if present, but it is currently unused, so the backend profile is the source of truth.
function mapSupabaseUser(user: User): SessionUser {
  const metadata = user.user_metadata || {};
  const appMetadata = user.app_metadata || {};

  return {
    id: user.id,
    email: user.email,
    role: ((appMetadata.role as string | undefined) || 'participant') as SessionUser['role'],
    agency: (appMetadata.agency_name || metadata.agency_name) as string | undefined,
    displayName: (metadata.full_name || user.email || 'User') as string | undefined,
  };
}

const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

// Resolve the authoritative SessionUser by reading the server-side profile.
// The role/agency returned here come from user_profiles (which users cannot edit
// after the lockdown migration), never from client-editable metadata. On any
// failure we fall back to the least-privileged identity so the UI never grants
// elevated access by default.
async function resolveSessionUser(session: Session): Promise<SessionUser> {
  const base = mapSupabaseUser(session.user);
  try {
    const res = await fetch(`${API_BASE_URL}/api/profile`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (res.ok) {
      const body = (await res.json()) as {
        data?: { role?: string; agency_name?: string; full_name?: string };
      };
      const profile = body.data;
      if (profile) {
        return {
          ...base,
          role: (profile.role || base.role) as SessionUser['role'],
          agency: profile.agency_name ?? base.agency,
          displayName: profile.full_name ?? base.displayName,
        };
      }
    }
  } catch {
    // Network/parse failure -> keep least-privilege base identity.
  }
  return base;
}
