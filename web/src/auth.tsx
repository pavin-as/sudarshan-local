import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Permission, type User } from "./api";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (p: Permission) => boolean;
}

const Ctx = createContext<AuthState>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try { setUser((await api<{ user: User }>("/auth/me")).user); }
    catch { setUser(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const out = () => setUser(null);
    const pw = () => setUser((u) => (u ? { ...u, mustChangePassword: true } : u));
    window.addEventListener("sudarshan:logged-out", out);
    window.addEventListener("sudarshan:must-change-password", pw);
    return () => { window.removeEventListener("sudarshan:logged-out", out); window.removeEventListener("sudarshan:must-change-password", pw); };
  }, []);

  const login = async (username: string, password: string) => {
    const r = await api<{ user: User }>("/auth/login", { body: { username, password } });
    setUser(r.user);
    return r.user;
  };
  const logout = async () => { await api("/auth/logout", { method: "POST" }).catch(() => {}); setUser(null); };
  const can = (p: Permission) => !!user?.permissions.includes(p);

  return <Ctx.Provider value={{ user, loading, login, logout, refresh, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
