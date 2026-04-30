import { useState, useEffect, useCallback } from 'react';

/* ── Types ─────────────────────────────────────────────────────────── */

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  tenantId?: string;
  tenantName?: string;
  tenantSlug?: string;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
}

export interface Instance {
  id: string;
  instance_name: string;
  status: string;
  tenant_id: string;
  created_by: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  created_at: string;
}

export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  tenant_id: string;
  created_at: string;
  tenants?: { name: string; slug: string };
}

/* Backend wraps list/single endpoints in a `data` field */
export interface DataResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/* Auth endpoints return fields at top level (not wrapped in `data`) */
export interface LoginResponse {
  success: boolean;
  token?: string;
  user?: User;
  error?: string;
}

export interface MeResponse {
  success: boolean;
  user?: User;
  error?: string;
}

export interface StatusResponse {
  success: boolean;
  connected?: boolean;
  running?: boolean;
  dbStatus?: string;
  error?: string;
}

export interface QrResponse {
  success: boolean;
  polling?: boolean;
  data?: unknown;
  error?: string;
  urlCalled?: string;
}

export interface ConfigResponse {
  success: boolean;
  supabaseUrl: string;
  supabaseAnonKey: string;
  jwtConfigured: boolean;
  dbConfigured: boolean;
  ready: boolean;
  missing: string[];
}

/* ── Base fetch helper ─────────────────────────────────────────────── */

const BASE = '/api';

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  token?: string | null,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  const json = await res.json() as T;
  return json;
}

/* ── Auth helpers ──────────────────────────────────────────────────── */

export function apiLogin(email: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function apiRegister(
  name: string,
  email: string,
  password: string,
  tenantId?: string,
): Promise<{ success: boolean; error?: string }> {
  return apiFetch('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, password, tenantId }),
  });
}

export function apiForgotPassword(email: string): Promise<{ success: boolean; error?: string }> {
  return apiFetch('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function apiResetPassword(
  access_token: string,
  password: string,
): Promise<{ success: boolean; error?: string }> {
  return apiFetch('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ access_token, password }),
  });
}

export function apiGetMe(token: string): Promise<MeResponse> {
  return apiFetch<MeResponse>('/auth/me', {}, token);
}

/* ── Instances ─────────────────────────────────────────────────────── */

export function apiListInstances(
  token: string,
  tenantId?: string,
): Promise<DataResponse<Instance[]>> {
  const q = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
  return apiFetch<DataResponse<Instance[]>>(`/instances${q}`, {}, token);
}

export function apiCreateInstance(
  token: string,
  payload: {
    instanceName: string;
    token?: string;
    evolutionUrl?: string;
    apiKey?: string;
    tenantId?: string;
  },
): Promise<DataResponse<Instance>> {
  return apiFetch<DataResponse<Instance>>('/instances', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, token);
}

export function apiGetInstanceStatus(token: string, name: string): Promise<StatusResponse> {
  return apiFetch<StatusResponse>(
    `/instances/${encodeURIComponent(name)}/status`,
    {},
    token,
  );
}

export function apiGetQrCode(token: string, name: string): Promise<QrResponse> {
  return apiFetch<QrResponse>(
    `/instances/${encodeURIComponent(name)}/qrcode`,
    {},
    token,
  );
}

export function apiConnectInstance(
  token: string,
  name: string,
  payload?: { instanceToken?: string; evolutionUrl?: string; immediate?: boolean },
): Promise<{ success: boolean; error?: string }> {
  return apiFetch(`/instances/${encodeURIComponent(name)}/connect`, {
    method: 'POST',
    body: JSON.stringify(payload ?? {}),
  }, token);
}

export function apiDisconnectInstance(
  token: string,
  name: string,
): Promise<{ success: boolean; error?: string }> {
  return apiFetch(`/instances/${encodeURIComponent(name)}/disconnect`, {
    method: 'POST',
    body: JSON.stringify({}),
  }, token);
}

export function apiLogoutInstance(
  token: string,
  name: string,
): Promise<{ success: boolean; error?: string }> {
  return apiFetch(`/instances/${encodeURIComponent(name)}/logout`, {
    method: 'DELETE',
    body: JSON.stringify({}),
  }, token);
}

export function apiDeleteInstance(
  token: string,
  name: string,
): Promise<{ success: boolean; error?: string }> {
  return apiFetch(`/instances/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    body: JSON.stringify({}),
  }, token);
}

/* ── Tenants (admin) ───────────────────────────────────────────────── */

export function apiListTenants(token: string): Promise<DataResponse<Tenant[]>> {
  return apiFetch<DataResponse<Tenant[]>>('/tenants', {}, token);
}

export function apiCreateTenant(
  token: string,
  payload: { name: string; slug: string },
): Promise<DataResponse<Tenant>> {
  return apiFetch<DataResponse<Tenant>>('/tenants', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, token);
}

/* ── Users (admin) ─────────────────────────────────────────────────── */

export function apiListUsers(token: string): Promise<DataResponse<AppUser[]>> {
  return apiFetch<DataResponse<AppUser[]>>('/users', {}, token);
}

export function apiCreateUser(
  token: string,
  payload: { name: string; email: string; password: string; role?: string; tenantId?: string },
): Promise<DataResponse<AppUser>> {
  return apiFetch<DataResponse<AppUser>>('/users', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, token);
}

export function apiUpdateUser(
  token: string,
  id: string,
  updates: { name?: string; role?: string; active?: boolean },
): Promise<DataResponse<AppUser>> {
  return apiFetch<DataResponse<AppUser>>(`/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }, token);
}

export function apiDeleteUser(
  token: string,
  id: string,
): Promise<{ success: boolean; error?: string }> {
  return apiFetch(`/users/${id}`, { method: 'DELETE' }, token);
}

export function apiAssignInstanceOwner(
  token: string,
  instanceName: string,
  userId: string | null,
): Promise<{ success: boolean; error?: string }> {
  return apiFetch(`/instances/${instanceName}/owner`, {
    method: 'PATCH',
    body: JSON.stringify({ userId }),
  }, token);
}

export function apiUpdateTenantEvolutionConfig(
  token: string,
  tenantId: string,
  payload: { evolutionApiUrl?: string; evolutionGlobalApiKey?: string },
): Promise<{ success: boolean; error?: string }> {
  return apiFetch(`/tenants/${tenantId}/evolution-config`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  }, token);
}

/* ── Config ────────────────────────────────────────────────────────── */

export function apiGetConfig(): Promise<ConfigResponse> {
  return apiFetch<ConfigResponse>('/config');
}

/* ── useAuth hook ──────────────────────────────────────────────────── */

const TOKEN_KEY = 'pre_token';

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    token: null,
    loading: true,
  });

  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (!stored) {
      setState({ user: null, token: null, loading: false });
      return;
    }
    apiGetMe(stored).then((res) => {
      if (res.success && res.user) {
        setState({ user: res.user, token: stored, loading: false });
      } else {
        localStorage.removeItem(TOKEN_KEY);
        setState({ user: null, token: null, loading: false });
      }
    }).catch(() => {
      localStorage.removeItem(TOKEN_KEY);
      setState({ user: null, token: null, loading: false });
    });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await apiLogin(email, password);
    if (res.success && res.token && res.user) {
      localStorage.setItem(TOKEN_KEY, res.token);
      setState({ user: res.user, token: res.token, loading: false });
    }
    return res;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setState({ user: null, token: null, loading: false });
  }, []);

  return { ...state, login, logout };
}

/* ── useInstances hook ─────────────────────────────────────────────── */

export function useInstances(token: string | null) {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiListInstances(token);
      if (res.success && res.data) {
        setInstances(res.data);
      } else {
        setError(res.error ?? 'Falha ao carregar instâncias.');
      }
    } catch {
      setError('Erro de rede.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { instances, loading, error, refresh };
}
