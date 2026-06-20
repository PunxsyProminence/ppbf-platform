import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

export type UserRole = 'admin' | 'coach' | 'member' | 'guest';

interface AuthContextType {
  session: Session | null;
  user: User | null;
  role: UserRole | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, fullName?: string) => Promise<void>;
  signOut: () => Promise<void>;
  hasRole: (requiredRoles: UserRole | UserRole[]) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<UserRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        supabase.from('user_profiles').select('role').eq('id', session.user.id).single().then(({ data }) => {
          setRole((data?.role as UserRole) || 'member');
        });
      }
      setLoading(false);
    });
  }, []);

  const value: AuthContextType = {
    session,
    user,
    role,
    loading,
    signIn: async (email, password) => { const { error } = await supabase.auth.signInWithPassword({ email, password }); if (error) throw error; },
    signUp: async (email, password, fullName) => { const { error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName } } }); if (error) throw error; },
    signOut: async () => { const { error } = await supabase.auth.signOut(); if (error) throw error; },
    hasRole: (requiredRoles) => {
      if (!role) return false;
      const rolesArray = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];
      return rolesArray.includes(role);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
