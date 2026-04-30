import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import { runMigrations } from './db/migrate.js';
import {
  createInstanceAndPersist,
  listInstances,
  disconnectInstanceService,
  logoutInstanceService,
  deleteInstanceService,
  purgeOrphanedInstance,
} from './services/instanceService.js';
import {
  getQrCode,
  connectInstance,
  getInstanceStatus,
  getAllInstances,
  pairInstance,
} from './services/evolutionGo.js';
import { supabaseAdmin } from './services/supabase.js';
import { createInstanceEvolutionApi } from './services/evolutionApi.js';
import { loginUser, registerUser, requestPasswordReset, resetPassword } from './services/authService.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PORT       = process.env.PORT || 5000;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || 'pre-atendimento-default-secret';

/* ── JWT payload ─────────────────────────────────────────────────────── */
interface JwtPayload {
  userId:   string;
  tenantId: string;
  role:     string;
  name:     string;
  email:    string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

/* ── Middleware de autenticação JWT ─────────────────────────────────── */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Autenticação necessária.' });
    return;
  }
  try {
    const token   = auth.slice(7);
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Token inválido ou expirado. Faça login novamente.' });
  }
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Acesso restrito a administradores.' });
    return;
  }
  next();
}

/* ── Extrai token de instância do metadata ─────────────────────────── */
function extractInstanceToken(meta: Record<string, unknown>): string {
  const newData = (meta.create as Record<string, unknown> | undefined)
    ?.data as Record<string, unknown> | undefined;
  if (newData?.token)  return String(newData.token);
  if (newData?.apikey) return String(newData.apikey);

  const oldData = meta.data as Record<string, unknown> | undefined;
  if (oldData?.token)  return String(oldData.token);
  if (oldData?.apikey) return String(oldData.apikey);

  if (meta.token)  return String(meta.token);
  if (meta.apikey) return String(meta.apikey);
  return '';
}

/* ── Express setup ──────────────────────────────────────────────────── */
const app = express();
app.use(cors());
app.use(express.json());

/* Anti-cache para HTML */
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

/* ── Config ─────────────────────────────────────────────────────────── */
app.get('/api/config', (_req, res) => {
  const supabaseUrl     = process.env.SUPABASE_DB_URL   || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
  const jwtConfigured   = !!process.env.SUPABASE_JWT_SECRET;
  const dbConfigured    = !!process.env.SUPABASE_POSTGRES_URL;
  const missing: string[] = [];
  if (!supabaseUrl)     missing.push('SUPABASE_DB_URL');
  if (!supabaseAnonKey) missing.push('SUPABASE_ANON_KEY');
  if (!jwtConfigured)   missing.push('SUPABASE_JWT_SECRET');
  if (!dbConfigured)    missing.push('SUPABASE_POSTGRES_URL');
  res.json({ supabaseUrl, supabaseAnonKey, jwtConfigured, dbConfigured, ready: missing.length === 0, missing });
});

app.get('/health', (_req, res) => {
  res.json({ message: '✅ PRE-Atendimento-V8 iniciado com sucesso!', version: '1.0.0', status: 'running' });
});

/* ── Auth: Login ─────────────────────────────────────────────────────── */
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ success: false, error: 'E-mail e senha são obrigatórios.' });
    return;
  }
  try {
    const result = await loginUser(email, password);
    if (!result.success || !result.user) {
      res.status(401).json(result);
      return;
    }
    const { id, name, role, tenantId, tenantName, tenantSlug } = result.user;
    const token = signToken({ userId: id, tenantId: tenantId || '', role, name, email: result.user.email });
    res.json({
      success: true,
      token,
      user: { id, name, email: result.user.email, role, tenantId, tenantName, tenantSlug },
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Auth: Register (público — sempre cria role='user') ──────────────── */
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, tenantId } = req.body as {
    name?: string; email?: string; password?: string; tenantId?: string;
  };
  if (!name || !email || !password) {
    res.status(400).json({ success: false, error: 'Nome, e-mail e senha são obrigatórios.' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ success: false, error: 'A senha deve ter pelo menos 6 caracteres.' });
    return;
  }
  try {
    /* Perfil fixo 'user' — criação de admin é exclusiva do painel administrativo */
    const result = await registerUser(name, email, password, 'user', tenantId);
    res.status(result.success ? 201 : 409).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Auth: Recuperar senha — envia e-mail via Supabase ───────────────── */
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email) {
    res.status(400).json({ success: false, error: 'E-mail é obrigatório.' });
    return;
  }
  try {
    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
    const host     = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost:5000';
    const redirectTo = `${protocol}://${host}/reset-password.html`;
    const result = await requestPasswordReset(email, redirectTo);
    /* Sempre retornar 200 para não revelar se o e-mail existe */
    res.json({ success: result.success, error: result.error });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Auth: Redefinir senha com token do Supabase ─────────────────────── */
app.post('/api/auth/reset-password', async (req, res) => {
  const { access_token, password } = req.body as { access_token?: string; password?: string };
  if (!access_token || !password) {
    res.status(400).json({ success: false, error: 'Token e senha são obrigatórios.' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ success: false, error: 'A senha deve ter pelo menos 6 caracteres.' });
    return;
  }
  try {
    const result = await resetPassword(access_token, password);
    res.status(result.success ? 200 : 401).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Auth: Verificar token (para restaurar sessão no frontend) ───────── */
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

/* ── Tenants ─────────────────────────────────────────────────────────── */
app.get('/api/tenants', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tenants')
      .select('id, name, slug, active, created_at')
      .order('created_at', { ascending: true });
    if (error) { res.status(500).json({ success: false, error: error.message }); return; }
    res.json({ success: true, data });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.post('/api/tenants', requireAuth, requireAdmin, async (req, res) => {
  const { name, slug } = req.body as { name?: string; slug?: string };
  if (!name || !slug) {
    res.status(400).json({ success: false, error: 'name e slug são obrigatórios.' });
    return;
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('tenants')
      .insert({ name, slug: slug.toLowerCase().replace(/[^a-z0-9-]/g, '-') })
      .select()
      .single();
    if (error) { res.status(409).json({ success: false, error: error.message }); return; }
    res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Usuários (admin) ────────────────────────────────────────────────── */

app.get('/api/users', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, name, email, role, active, tenant_id, created_at, tenants(name, slug)')
      .order('created_at', { ascending: true });
    if (error) { res.status(500).json({ success: false, error: error.message }); return; }
    res.json({ success: true, data });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { name, email, password, role, tenantId } = req.body as {
    name?: string; email?: string; password?: string; role?: string; tenantId?: string;
  };
  if (!name || !email || !password) {
    res.status(400).json({ success: false, error: 'Nome, e-mail e senha são obrigatórios.' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ success: false, error: 'A senha deve ter pelo menos 6 caracteres.' });
    return;
  }
  try {
    const result = await registerUser(name, email, password, role || 'user', tenantId);
    res.status(result.success ? 201 : 409).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.patch('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role, name, active } = req.body as { role?: string; name?: string; active?: boolean };

  const updates: Record<string, unknown> = {};
  if (role !== undefined)   updates.role   = role;
  if (name !== undefined)   updates.name   = name.trim();
  if (active !== undefined) updates.active = active;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ success: false, error: 'Nenhum campo para atualizar.' });
    return;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .update(updates)
      .eq('id', id)
      .select('id, name, email, role, active, tenant_id')
      .single();

    if (error) { res.status(404).json({ success: false, error: error.message }); return; }
    res.json({ success: true, data });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  /* Impedir que admin se auto-delete */
  if (id === req.user!.userId) {
    res.status(400).json({ success: false, error: 'Você não pode excluir a própria conta.' });
    return;
  }
  try {
    const { error } = await supabaseAdmin.from('users').delete().eq('id', id);
    if (error) { res.status(404).json({ success: false, error: error.message }); return; }
    res.json({ success: true, data: { message: 'Usuário removido com sucesso.' } });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Criar instância ─────────────────────────────────────────────────── */
app.post('/api/instances', requireAuth, async (req, res) => {
  const { instanceName, token, evolutionUrl, apiKey, tenantId } = req.body as {
    instanceName?: string;
    token?:        string;
    evolutionUrl?: string;
    apiKey?:       string;
    tenantId?:     string;
  };

  if (!instanceName || typeof instanceName !== 'string' || instanceName.trim() === '') {
    res.status(400).json({ success: false, error: 'instanceName é obrigatório.' });
    return;
  }

  const user = req.user!;
  /* Admin pode especificar um tenantId diferente; usuário comum usa o próprio */
  const effectiveTenantId = (user.role === 'admin' && tenantId) ? tenantId : (user.tenantId || tenantId || '');

  if (!effectiveTenantId) {
    res.status(400).json({ success: false, error: 'Tenant não identificado. Faça login novamente.' });
    return;
  }

  try {
    const result = await createInstanceAndPersist(
      instanceName.trim(),
      effectiveTenantId,
      user.userId,
      token?.trim()        || undefined,
      evolutionUrl?.trim() || undefined,
      apiKey?.trim()       || undefined,
    );
    res.status(result.success ? 201 : (result.error?.includes('já existe') ? 409 : 502)).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Listar instâncias ───────────────────────────────────────────────── */
app.get('/api/instances', requireAuth, async (req, res) => {
  const user     = req.user!;
  const isAdmin  = user.role === 'admin';
  /* Admin pode filtrar por tenant via query param; usuário comum usa seu próprio tenant */
  const filterTenantId = isAdmin
    ? ((req.query.tenantId as string | undefined)?.trim() || undefined)
    : user.tenantId;
  /* Usuário comum: retorna somente instâncias criadas por ele */
  const filterUserId = isAdmin ? undefined : user.userId;

  try {
    const result = await listInstances(filterTenantId, isAdmin && !filterTenantId, filterUserId);
    res.status(result.success ? 200 : 500).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Helper: buscar token da instância com controle de dono ──────────── */
async function fetchInstanceToken(
  name: string,
  tenantId: string | undefined,
  isAdmin: boolean,
  userId?: string,
): Promise<string> {
  let query = supabaseAdmin.from('instances').select('metadata').eq('instance_name', name);
  if (!isAdmin) {
    if (tenantId) query = query.eq('tenant_id', tenantId);
    if (userId)   query = query.eq('created_by', userId);
  }
  const { data: inst } = await query.maybeSingle();
  if (!inst?.metadata) return '';
  return extractInstanceToken(inst.metadata as Record<string, unknown>);
}

/* ── QR Code ─────────────────────────────────────────────────────────── */
app.get('/api/instances/:name/qrcode', requireAuth, async (req, res) => {
  const { name }  = req.params;
  const user      = req.user!;
  const isAdmin   = user.role === 'admin';
  const evolutionUrl  = (req.query.evolutionUrl  as string | undefined)?.trim() || undefined;
  let   instanceToken = (req.query.instanceToken as string | undefined)?.trim() || '';

  if (!instanceToken) {
    try { instanceToken = await fetchInstanceToken(name, user.tenantId, isAdmin, isAdmin ? undefined : user.userId); } catch { /* ok */ }
  }

  try {
    const result = await getQrCode(instanceToken, evolutionUrl);

    const isPolling400 = !result.success &&
      result.httpStatus === 400 &&
      typeof result.error === 'string' &&
      result.error.toLowerCase().includes('no qr code available');

    if (isPolling400) {
      res.status(202).json({ success: false, polling: true, error: result.error, urlCalled: result.urlCalled });
      return;
    }

    if (result.success) {
      const d     = result.data as Record<string, unknown> | undefined;
      const inner = (d?.data as Record<string, unknown>) || d || {};
      const qr    = inner?.Qrcode || inner?.qrcode || inner?.base64 || '';
      if (!qr) {
        res.status(202).json({ success: false, polling: true, error: 'QR Code ainda sendo gerado. Aguarde…', urlCalled: result.urlCalled });
        return;
      }
    }

    res.status(result.success ? 200 : (result.httpStatus || 502)).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Status da instância ─────────────────────────────────────────────── */
app.get('/api/instances/:name/status', requireAuth, async (req, res) => {
  const { name } = req.params;
  const user     = req.user!;
  const isAdmin  = user.role === 'admin';
  const evolutionUrl  = (req.query.evolutionUrl  as string | undefined)?.trim() || undefined;
  let   instanceToken = (req.query.instanceToken as string | undefined)?.trim() || '';

  let currentDbStatus = '';
  try {
    let q = supabaseAdmin.from('instances').select('metadata, status').eq('instance_name', name);
    if (!isAdmin) {
      if (user.tenantId) q = q.eq('tenant_id', user.tenantId);
      q = q.eq('created_by', user.userId);
    }
    const { data: inst } = await q.maybeSingle();

    if (inst?.metadata) {
      const meta = inst.metadata as Record<string, unknown>;
      if (!instanceToken) instanceToken = extractInstanceToken(meta);
    }
    currentDbStatus = inst?.status || '';
  } catch { /* continua */ }

  try {
    const result = await getInstanceStatus(instanceToken, evolutionUrl);

    if (result.success && result.data) {
      const d        = result.data as Record<string, unknown>;
      const inner    = (d.data as Record<string, unknown>) || {};
      const running  = inner.Connected === true;
      const loggedIn = inner.LoggedIn  === true;

      let newStatus: string | null = null;
      if (loggedIn && currentDbStatus !== 'connected') {
        newStatus = 'connected';
      } else if (!loggedIn && currentDbStatus === 'connected') {
        newStatus = 'active';
      }

      if (newStatus) {
        /* Atualizar status somente na instância do próprio usuário */
        let upd = supabaseAdmin.from('instances').update({ status: newStatus }).eq('instance_name', name);
        if (!isAdmin) {
          if (user.tenantId) upd = upd.eq('tenant_id', user.tenantId);
          upd = upd.eq('created_by', user.userId);
        }
        await upd;
      }

      res.json({ success: result.success, data: result.data, connected: loggedIn, running, dbStatus: newStatus || currentDbStatus });
      return;
    }

    if (currentDbStatus === 'connected') {
      let upd = supabaseAdmin.from('instances').update({ status: 'active' }).eq('instance_name', name);
      if (!isAdmin) {
        if (user.tenantId) upd = upd.eq('tenant_id', user.tenantId);
        upd = upd.eq('created_by', user.userId);
      }
      await upd;
    }
    res.json({ success: true, connected: false, running: false, dbStatus: currentDbStatus });
  } catch (err: unknown) {
    res.status(500).json({ success: false, connected: false, error: (err as Error).message });
  }
});

/* ── Conectar manualmente ────────────────────────────────────────────── */
app.post('/api/instances/:name/connect', requireAuth, async (req, res) => {
  const { name } = req.params;
  const user     = req.user!;
  const isAdmin  = user.role === 'admin';
  const { instanceToken, evolutionUrl, immediate, phone, subscribe, webhookUrl } = req.body as {
    instanceToken?: string; evolutionUrl?: string; immediate?: boolean;
    phone?: string; subscribe?: string[]; webhookUrl?: string;
  };

  let token = instanceToken?.trim() || '';
  if (!token) {
    try { token = await fetchInstanceToken(name, user.tenantId, isAdmin, isAdmin ? undefined : user.userId); } catch { /* ok */ }
  }

  if (!token) {
    res.status(400).json({ success: false, error: 'instanceToken é obrigatório para conectar.' });
    return;
  }

  try {
    const result = await connectInstance(token, evolutionUrl?.trim() || undefined, { immediate, phone, subscribe, webhookUrl });
    res.status(result.success ? 200 : (result.httpStatus || 502)).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Desconectar ──────────────────────────────────────────────────────── */
app.post('/api/instances/:name/disconnect', requireAuth, async (req, res) => {
  const { name } = req.params;
  const user     = req.user!;
  const isAdmin  = user.role === 'admin';
  const { instanceToken, evolutionUrl } = req.body as { instanceToken?: string; evolutionUrl?: string };
  try {
    const result = await disconnectInstanceService(
      name, user.tenantId, isAdmin,
      instanceToken?.trim() || undefined, evolutionUrl?.trim() || undefined,
      isAdmin ? undefined : user.userId,
    );
    res.status(result.success ? 200 : 502).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Logout ───────────────────────────────────────────────────────────── */
app.delete('/api/instances/:name/logout', requireAuth, async (req, res) => {
  const { name } = req.params;
  const user     = req.user!;
  const isAdmin  = user.role === 'admin';
  const { instanceToken, evolutionUrl } = req.body as { instanceToken?: string; evolutionUrl?: string };
  try {
    const result = await logoutInstanceService(
      name, user.tenantId, isAdmin,
      instanceToken?.trim() || undefined, evolutionUrl?.trim() || undefined,
      isAdmin ? undefined : user.userId,
    );
    res.status(result.success ? 200 : 502).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Código de pareamento ─────────────────────────────────────────────── */
app.post('/api/instances/:name/pair', requireAuth, async (req, res) => {
  const { name } = req.params;
  const user     = req.user!;
  const isAdmin  = user.role === 'admin';
  const { instanceToken, evolutionUrl, phone, subscribe } = req.body as {
    instanceToken?: string; evolutionUrl?: string; phone?: string; subscribe?: string[];
  };

  let token = instanceToken?.trim() || '';
  if (!token) {
    try { token = await fetchInstanceToken(name, user.tenantId, isAdmin, isAdmin ? undefined : user.userId); } catch { /* ok */ }
  }

  if (!token) {
    res.status(400).json({ success: false, error: 'instanceToken é obrigatório para pair.' });
    return;
  }
  if (!phone) {
    res.status(400).json({ success: false, error: 'phone é obrigatório para pair.' });
    return;
  }

  try {
    const result = await pairInstance(token, phone, subscribe, evolutionUrl?.trim() || undefined);
    res.status(result.success ? 200 : (result.httpStatus || 502)).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Deletar ──────────────────────────────────────────────────────────── */
app.delete('/api/instances/:name', requireAuth, async (req, res) => {
  const { name } = req.params;
  const user     = req.user!;
  const isAdmin  = user.role === 'admin';
  const { evolutionUrl, apiKey } = req.body as { evolutionUrl?: string; apiKey?: string };
  try {
    const result = await deleteInstanceService(
      name, user.tenantId, isAdmin,
      evolutionUrl?.trim() || undefined, apiKey?.trim() || undefined,
      isAdmin ? undefined : user.userId,
    );
    res.status(result.success ? 200 : 502).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Purgar registro órfão ───────────────────────────────────────────── */
app.delete('/api/instances/:name/purge', requireAuth, async (req, res) => {
  const { name } = req.params;
  const user     = req.user!;
  const isAdmin  = user.role === 'admin';
  try {
    const result = await purgeOrphanedInstance(name, user.tenantId, isAdmin, isAdmin ? undefined : user.userId);
    res.status(result.success ? 200 : 404).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Admin: Atribuir dono de instância ──────────────────────────────── */
app.patch('/api/instances/:name/owner', requireAuth, requireAdmin, async (req, res) => {
  const { name }   = req.params;
  const { userId } = req.body as { userId?: string };

  /* userId ausente na body = erro; userId explicitamente null = remover atribuição */
  if (userId === undefined) {
    res.status(400).json({ success: false, error: 'userId é obrigatório (envie null para remover a atribuição).' });
    return;
  }

  try {
    let owner: { id: string; name: string; email: string; role: string } | null = null;

    if (userId) {
      /* Confirmar que o usuário existe */
      const { data: u, error: ownerErr } = await supabaseAdmin
        .from('users')
        .select('id, name, email, role')
        .eq('id', userId)
        .maybeSingle();

      if (ownerErr || !u) {
        res.status(404).json({ success: false, error: 'Usuário não encontrado.' });
        return;
      }
      owner = u;
    }

    /* Atualizar created_by na instância (null remove a atribuição) */
    const { data, error } = await supabaseAdmin
      .from('instances')
      .update({ created_by: userId || null })
      .eq('instance_name', name)
      .select('id, instance_name, created_by, tenant_id')
      .maybeSingle();

    if (error || !data) {
      res.status(404).json({ success: false, error: error?.message || 'Instância não encontrada.' });
      return;
    }

    res.json({
      success: true,
      data: {
        ...data,
        owner: owner ? { id: owner.id, name: owner.name, email: owner.email, role: owner.role } : null,
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Admin: Listar instâncias na Evolution GO API ───────────────────── */
app.get('/api/admin/instances', requireAuth, requireAdmin, async (req, res) => {
  const evolutionUrl = (req.query.evolutionUrl as string | undefined)?.trim() || undefined;
  const apiKey       = (req.query.apiKey       as string | undefined)?.trim() || undefined;
  try {
    const result = await getAllInstances(evolutionUrl, apiKey);
    res.status(result.success ? 200 : (result.httpStatus || 502)).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Admin: Testar conexão ───────────────────────────────────────────── */
app.post('/api/admin/test-connection', requireAuth, requireAdmin, async (req, res) => {
  const { evolutionUrl, apiKey } = req.body as { evolutionUrl?: string; apiKey?: string };
  const baseUrl = (evolutionUrl?.trim()) || process.env.EVOLUTION_API_URL || '';
  const key     = (apiKey?.trim())      || process.env.GLOBAL_API_KEY    || '';

  if (!baseUrl) { res.status(400).json({ success: false, error: 'URL da API não informada.' }); return; }
  if (!key)     { res.status(400).json({ success: false, error: 'Chave da API não informada.' }); return; }

  const url = `${baseUrl}/instance/all`;
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 10_000);

  try {
    const r = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json', apikey: key }, signal: controller.signal });
    clearTimeout(timeout);
    const text = await r.text();
    if (r.ok) {
      res.json({ success: true, status: r.status, message: 'Conexão estabelecida com sucesso.' });
    } else {
      res.json({ success: false, status: r.status, error: `API retornou HTTP ${r.status}.`, detail: text.slice(0, 300) });
    }
  } catch (err: unknown) {
    clearTimeout(timeout);
    const isTimeout = (err as Error).name === 'AbortError';
    res.status(502).json({ success: false, error: isTimeout ? 'Tempo limite esgotado (10s).' : `Falha de rede: ${(err as Error).message}` });
  }
});

/* ── Evolution API — criar instância ─────────────────────────────────
   Usa exclusivamente EVOLUTION_API_URL + EVOLUTION_GLOBAL_API_KEY.
   Completamente isolado do EVO-GO.
*/
app.post('/api/evo-api/instance/create', requireAuth, async (req: Request, res: Response) => {
  const { instanceName, token } = req.body as { instanceName?: string; token?: string };
  if (!instanceName?.trim()) {
    res.status(400).json({ success: false, error: 'instanceName é obrigatório.' });
    return;
  }
  const result = await createInstanceEvolutionApi(instanceName.trim(), token?.trim());
  res.status(result.success ? 200 : 502).json(result);
});

async function start() {
  try {
    await runMigrations();
  } catch (err) {
    console.error('⚠️  Migrations falharam, servidor iniciará mesmo assim:', err);
  }

  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📦 Supabase: ${process.env.SUPABASE_DB_URL ? '✅ configurado' : '⚠️  não configurado'}`);
  });
}

start();
