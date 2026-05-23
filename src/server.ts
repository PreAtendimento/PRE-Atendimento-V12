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
  forceDeleteInstance,
} from './services/instanceService.js';
import {
  getQrCode,
  connectInstance,
  getInstanceStatus,
  getAllInstances,
  pairInstance,
  getProfilePicture,
  reconnectInstance,
  updateAdvancedSettings,
} from './services/evolutionGo.js';
import { supabaseAdmin } from './services/supabase.js';
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

function signEmbedToken(payload: JwtPayload): string {
  return jwt.sign({ ...payload, embed: true }, JWT_SECRET, { expiresIn: '30d' });
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

/* ── Helper: resolve config EvoAI CRM (global — tabela system_config) ── */
/* Remove qualquer caractere fora do intervalo ASCII imprimível (32–126) */
function sanitizeHeaderValue(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, '').trim();
}

async function getEvoCRMConfig(): Promise<{ url: string; token: string } | null> {
  const { data } = await supabaseAdmin
    .from('system_config')
    .select('key, value')
    .in('key', ['evo_crm_url', 'evo_crm_token']);
  const url   = (data as { key: string; value: string }[] | null)?.find(r => r.key === 'evo_crm_url')?.value?.trim()   || '';
  const token = sanitizeHeaderValue((data as { key: string; value: string }[] | null)?.find(r => r.key === 'evo_crm_token')?.value || '');
  if (!url || !token) return null;
  return { url, token };
}

/* ── Helper: resolve config EvoGo (global — tabela system_config) ── */
async function getEvoGoConfig(): Promise<{ url: string; key: string }> {
  const { data } = await supabaseAdmin
    .from('system_config')
    .select('key, value')
    .in('key', ['evogo_url', 'evogo_api_key']);

  const url = (data as { key: string; value: string }[] | null)
    ?.find(r => r.key === 'evogo_url')?.value?.trim() || '';
  const key = (data as { key: string; value: string }[] | null)
    ?.find(r => r.key === 'evogo_api_key')?.value?.trim() || '';

  if (!url || !key) {
    throw new Error('EvoGo não configurado. Acesse Configuração → EvoGo.');
  }
  return { url, key };
}

async function getInstanceTenant(name: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from('instances')
    .select('tenant_id')
    .eq('instance_name', name)
    .maybeSingle();
  return (data?.tenant_id as string) || '';
}

/* ── Express setup ──────────────────────────────────────────────────── */
const app = express();
app.use(cors());
app.use(express.json());

/* Permitir embedding em iframe (X-Frame-Options + CSP) */
app.use((_req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});

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
/* ── Bridge de embed: injeta sessão via localStorage e redireciona ── */
app.get('/embed', (req, res) => {
  const token = (req.query.t as string || '').trim();
  if (!token) { res.redirect('/'); return; }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload & { embed?: boolean };
    const session = JSON.stringify({
      userId    : payload.userId,
      email     : payload.email,
      role      : payload.role,
      name      : payload.name,
      tenantId  : payload.tenantId,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<script>
try {
  localStorage.setItem('pa_jwt', ${JSON.stringify(token)});
  localStorage.setItem('pa_session', ${JSON.stringify(session)});
} catch(e) {}
window.location.replace('/dashboard.html');
</script></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f1117;color:#94a3b8">
  <span>Carregando…</span>
</body></html>`);
  } catch {
    res.redirect('/');
  }
});

/* ── Gerar token de embed (30 dias) ────────────────────────────────── */
app.get('/api/admin/embed-token', requireAuth, async (req, res) => {
  try {
    const user  = req.user!;
    const token = signEmbedToken({
      userId  : user.userId,
      email   : user.email,
      role    : user.role,
      name    : user.name,
      tenantId: user.tenantId,
    });
    const host     = req.headers['x-forwarded-host'] || req.headers.host || '';
    const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const baseUrl  = `${protocol}://${host}`;
    res.json({ success: true, token, embedUrl: `${baseUrl}/embed?t=${token}` });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.get('/api/config', (_req, res) => {
  const supabaseUrl     = process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
  const jwtConfigured   = true;
  const dbConfigured    = !!process.env.SUPABASE_POSTGRES_URL;
  const missing: string[] = [];
  if (!supabaseUrl)     missing.push('SUPABASE_DB_URL');
  if (!supabaseAnonKey) missing.push('SUPABASE_ANON_KEY');
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
    console.log(`[FORGOT PASSWORD] email: ${email}`);
    const publicUrl =
      process.env.PUBLIC_APP_URL?.replace(/\/$/, '') ||
      (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null) ||
      (() => {
        const protocol = (req.headers['x-forwarded-proto'] as string)?.split(',')[0].trim() || req.protocol || 'https';
        const host     = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost:5000';
        return `${protocol}://${host}`;
      })();
    const redirectTo = `${publicUrl}/reset-password.html`;
    console.log(`[auth] forgot-password → redirectTo="${redirectTo}"`);
    const result = await requestPasswordReset(email, redirectTo);
    console.log(`[auth] forgot-password → result: success=${result.success}${result.error ? ' error=' + result.error : ''}`);
    /* Sempre retornar 200 + mensagem genérica para não revelar se o e-mail existe */
    res.json({
      success: true,
      message: 'Se este e-mail estiver cadastrado, você receberá o link em instantes. Verifique também a pasta de spam.',
    });
  } catch (err: unknown) {
    console.error('[auth] forgot-password exception:', (err as Error).message);
    res.json({
      success: true,
      message: 'Se este e-mail estiver cadastrado, você receberá o link em instantes. Verifique também a pasta de spam.',
    });
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

app.patch('/api/tenants/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { active } = req.body as { active?: boolean };
  if (typeof active !== 'boolean') {
    res.status(400).json({ success: false, error: 'Campo "active" (boolean) é obrigatório.' });
    return;
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('tenants')
      .update({ active })
      .eq('id', id)
      .select('id, name, slug, active, created_at')
      .single();
    if (error) { res.status(404).json({ success: false, error: error.message }); return; }
    res.json({ success: true, data });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.delete('/api/tenants/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabaseAdmin
      .from('tenants')
      .delete()
      .eq('id', id);
    if (error) { res.status(404).json({ success: false, error: error.message }); return; }
    res.json({ success: true, data: { message: 'Tenant excluído com sucesso.' } });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});


/* ── Usuários (admin) ────────────────────────────────────────────────── */

app.get('/api/users', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, name, email, role, active, tenant_id, created_at, max_instances, tenants(name, slug)')
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
  const { role, name, active, tenantId, maxInstances } = req.body as { role?: string; name?: string; active?: boolean; tenantId?: string | null; maxInstances?: number | null };

  if (maxInstances !== undefined && maxInstances !== null) {
    const v = Number(maxInstances);
    if (!Number.isInteger(v) || v < 1 || v > 5) {
      res.status(400).json({ success: false, error: 'Limite inválido. Use um número inteiro entre 1 e 5.' });
      return;
    }
  }

  const updates: Record<string, unknown> = {};
  if (role !== undefined)         updates.role          = role;
  if (name !== undefined)         updates.name          = name.trim();
  if (active !== undefined)       updates.active        = active;
  if (tenantId !== undefined)     updates.tenant_id     = tenantId ?? null;
  if (maxInstances !== undefined) updates.max_instances = maxInstances ?? null;

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
  const { instanceName, token, tenantId } = req.body as {
    instanceName?: string;
    token?:        string;
    tenantId?:     string;
  };

  if (!instanceName || typeof instanceName !== 'string' || instanceName.trim() === '') {
    res.status(400).json({ success: false, error: 'instanceName é obrigatório.' });
    return;
  }

  const INST_NAME_RE = /^[a-zA-Z0-9_-]+$/;
  if (!INST_NAME_RE.test(instanceName.trim())) {
    res.status(400).json({ success: false, error: 'Nome inválido. Use apenas letras (a-z), números, hífen (-) e underscore (_).' });
    return;
  }

  const user = req.user!;
  /* Admin pode especificar um tenantId diferente; usuário comum usa o próprio */
  const effectiveTenantId = (user.role === 'admin' && tenantId) ? tenantId : (user.tenantId || tenantId || '');

  if (!effectiveTenantId) {
    res.status(400).json({ success: false, error: 'Tenant não identificado. Faça login novamente.' });
    return;
  }

  /* ── Verificar limite de instâncias (somente usuários comuns) ── */
  if (user.role !== 'admin') {
    const { data: userRecord } = await supabaseAdmin
      .from('users')
      .select('max_instances')
      .eq('id', user.userId)
      .maybeSingle();
    const limit = userRecord?.max_instances ?? null;
    if (limit !== null) {
      const { count } = await supabaseAdmin
        .from('instances')
        .select('*', { count: 'exact', head: true })
        .eq('created_by', user.userId);
      if ((count || 0) >= limit) {
        res.status(403).json({ success: false, error: 'Limite de instâncias atingido. Peça ao administrador para aumentar seu limite.' });
        return;
      }
    }
  }

  let _evoCreate: { url: string; key: string };
  try { _evoCreate = await getEvoGoConfig(); }
  catch { res.status(400).json({ success: false, error: 'EvoGo não configurado. Acesse Configuração → EvoGo.' }); return; }

  try {
    const result = await createInstanceAndPersist(
      instanceName.trim(),
      effectiveTenantId,
      user.userId,
      token?.trim() || undefined,
      _evoCreate.url,
      _evoCreate.key,
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
  let   instanceToken = (req.query.instanceToken as string | undefined)?.trim() || '';

  if (!instanceToken) {
    try { instanceToken = await fetchInstanceToken(name, user.tenantId, isAdmin, isAdmin ? undefined : user.userId); } catch { /* ok */ }
  }

  const _qrTid = await getInstanceTenant(name) || user.tenantId || '';
  let _qrEvo: { url: string; key: string };
  try { _qrEvo = await getEvoGoConfig(); }
  catch { res.status(400).json({ success: false, error: 'EvoGo não configurado. Acesse Configuração → EvoGo.' }); return; }

  try {
    const result = await getQrCode(instanceToken, _qrEvo.url);

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

  const _stTid = await getInstanceTenant(name) || user.tenantId || '';
  let _stEvo: { url: string; key: string };
  try { _stEvo = await getEvoGoConfig(); }
  catch { res.status(400).json({ success: false, error: 'EvoGo não configurado. Acesse Configuração → EvoGo.' }); return; }

  try {
    const result = await getInstanceStatus(instanceToken, _stEvo.url);

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

/* ── Foto de perfil da instância ─────────────────────────────────────── */
app.get('/api/instances/:name/picture', requireAuth, async (req, res) => {
  const { name } = req.params;
  const user     = req.user!;
  const isAdmin  = user.role === 'admin';
  try {
    let q = supabaseAdmin.from('instances').select('metadata').eq('instance_name', name);
    if (!isAdmin) {
      if (user.tenantId) q = q.eq('tenant_id', user.tenantId);
      q = q.eq('created_by', user.userId);
    }
    const { data: inst } = await q.maybeSingle();
    if (!inst) return res.status(404).json({ success: false, error: 'Instância não encontrada.' });

    const meta          = inst.metadata as Record<string, unknown>;
    const instanceToken = extractInstanceToken(meta);
    if (!instanceToken) return res.json({ success: true, pictureUrl: null });

    const _picTid = await getInstanceTenant(name) || user.tenantId || '';
    let _picEvoUrl: string | undefined;
    try { const cfg = await getEvoGoConfig(); _picEvoUrl = cfg.url; } catch { _picEvoUrl = undefined; }

    const result = await getProfilePicture(instanceToken, _picEvoUrl);
    if (result.success && result.data) {
      const d     = result.data as Record<string, unknown>;
      const inner = (d.data as Record<string, unknown>) || {};
      const url   =
        inner.picture         || inner.profilePictureUrl || inner.profilePicUrl || inner.avatar ||
        d.picture             || d.profilePictureUrl     || d.profilePicUrl     || d.avatar;
      return res.json({ success: true, pictureUrl: (url as string) || null });
    }
    res.json({ success: true, pictureUrl: null });
  } catch {
    res.json({ success: true, pictureUrl: null });
  }
});

/* ── Conectar manualmente ────────────────────────────────────────────── */
app.post('/api/instances/:name/connect', requireAuth, async (req, res) => {
  const { name } = req.params;
  const user     = req.user!;
  const isAdmin  = user.role === 'admin';
  const { instanceToken, immediate, phone, subscribe, webhookUrl } = req.body as {
    instanceToken?: string; immediate?: boolean;
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

  const _conTid = await getInstanceTenant(name) || user.tenantId || '';
  let _conEvo: { url: string; key: string };
  try { _conEvo = await getEvoGoConfig(); }
  catch { res.status(400).json({ success: false, error: 'EvoGo não configurado. Acesse Configuração → EvoGo.' }); return; }

  try {
    const result = await connectInstance(token, _conEvo.url, { immediate, phone, subscribe, webhookUrl });
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
  const { instanceToken } = req.body as { instanceToken?: string };
  const _disTid = await getInstanceTenant(name) || user.tenantId || '';
  let _disEvo: { url: string; key: string };
  try { _disEvo = await getEvoGoConfig(); }
  catch { res.status(400).json({ success: false, error: 'EvoGo não configurado. Acesse Configuração → EvoGo.' }); return; }
  try {
    const result = await disconnectInstanceService(
      name, user.tenantId, isAdmin,
      instanceToken?.trim() || undefined, _disEvo.url,
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
  const { instanceToken: logoutToken } = req.body as { instanceToken?: string };
  const _logTid = await getInstanceTenant(name) || user.tenantId || '';
  let _logEvo: { url: string; key: string };
  try { _logEvo = await getEvoGoConfig(); }
  catch { res.status(400).json({ success: false, error: 'EvoGo não configurado. Acesse Configuração → EvoGo.' }); return; }
  try {
    const result = await logoutInstanceService(
      name, user.tenantId, isAdmin,
      logoutToken?.trim() || undefined, _logEvo.url,
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
  const { instanceToken, phone, subscribe } = req.body as {
    instanceToken?: string; phone?: string; subscribe?: string[];
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

  const _pairTid = await getInstanceTenant(name) || user.tenantId || '';
  let _pairEvo: { url: string; key: string };
  try { _pairEvo = await getEvoGoConfig(); }
  catch { res.status(400).json({ success: false, error: 'EvoGo não configurado. Acesse Configuração → EvoGo.' }); return; }

  try {
    const result = await pairInstance(token, phone, subscribe, _pairEvo.url);
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
  const _delTid = await getInstanceTenant(name) || user.tenantId || '';
  let _delEvo: { url: string; key: string };
  try { _delEvo = await getEvoGoConfig(); }
  catch { res.status(400).json({ success: false, error: 'EvoGo não configurado. Acesse Configuração → EvoGo.' }); return; }
  try {
    const result = await deleteInstanceService(
      name, user.tenantId, isAdmin,
      _delEvo.url, _delEvo.key,
      isAdmin ? undefined : user.userId,
    );
    res.status(result.success ? 200 : 502).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Force Delete (admin only) — ignora a API, remove só do banco ───── */
app.delete('/api/instances/:name/force', requireAuth, requireAdmin, async (req, res) => {
  const { name } = req.params;
  try {
    const result = await forceDeleteInstance(name);
    res.status(result.success ? 200 : 404).json(result);
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

/* ── Buscar configurações da instância (webhook + avançadas) ─────────── */
app.get('/api/instances/:name/settings', requireAuth, async (req, res) => {
  const { name } = req.params;
  const user     = req.user!;
  const isAdmin  = user.role === 'admin';
  try {
    let query = supabaseAdmin.from('instances').select('metadata').eq('instance_name', name);
    if (!isAdmin) {
      if (user.tenantId) query = query.eq('tenant_id', user.tenantId);
      query = query.eq('created_by', user.userId);
    }
    const { data: inst, error } = await query.maybeSingle();
    if (error || !inst) { res.status(404).json({ success: false, error: 'Instância não encontrada.' }); return; }
    const meta = (inst.metadata as Record<string, unknown>) || {};
    res.json({ success: true, webhook: (meta.webhook as object) || {}, advanced: (meta.advanced as object) || {} });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Salvar configurações de webhook ─────────────────────────────────── */
app.post('/api/instances/:name/webhook', requireAuth, async (req, res) => {
  const { name } = req.params;
  const user     = req.user!;
  const isAdmin  = user.role === 'admin';
  const { url, events, rabbitmq, websocket, nats } = req.body as {
    url?: string; events?: string[]; rabbitmq?: string; websocket?: string; nats?: string;
  };
  try {
    let query = supabaseAdmin.from('instances').select('metadata').eq('instance_name', name);
    if (!isAdmin) {
      if (user.tenantId) query = query.eq('tenant_id', user.tenantId);
      query = query.eq('created_by', user.userId);
    }
    const { data: inst, error } = await query.maybeSingle();
    if (error || !inst) { res.status(404).json({ success: false, error: 'Instância não encontrada.' }); return; }
    const meta = ((inst.metadata as Record<string, unknown>) || {}) as Record<string, unknown>;
    meta.webhook = { url: url || '', events: events || [], rabbitmq: rabbitmq || 'default', websocket: websocket || 'default', nats: nats || 'default' };

    /* Salvar no Supabase */
    let upQuery = supabaseAdmin.from('instances').update({ metadata: meta }).eq('instance_name', name);
    if (!isAdmin) {
      if (user.tenantId) upQuery = upQuery.eq('tenant_id', user.tenantId);
      upQuery = upQuery.eq('created_by', user.userId);
    }
    const { error: upErr } = await upQuery;
    if (upErr) { res.status(500).json({ success: false, error: upErr.message }); return; }

    /* Chamar EvoGo: POST /instance/connect com novos parâmetros de webhook
       (não há endpoint separado de webhook — connect atualiza sem desconectar) */
    const instanceToken = extractInstanceToken(meta);
    if (instanceToken) {
      try {
        const _evo = await getEvoGoConfig();
        await connectInstance(instanceToken, _evo.url, {
          webhookUrl:      url || '',
          subscribe:       events || [],
          rabbitmqEnable:  rabbitmq  === 'enabled' ? 'enabled' : rabbitmq  === 'disabled' ? 'disabled' : '',
          websocketEnable: websocket === 'enabled' ? 'enabled' : websocket === 'disabled' ? 'disabled' : '',
          natsEnable:      nats      === 'enabled' ? 'enabled' : nats      === 'disabled' ? 'disabled' : '',
        });
      } catch (evoErr) {
        console.warn('[Webhook] EvoGo connect falhou (salvo localmente):', (evoErr as Error).message);
      }
    }

    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Salvar configurações avançadas ──────────────────────────────────── */
app.post('/api/instances/:name/advanced', requireAuth, async (req, res) => {
  const { name } = req.params;
  const user     = req.user!;
  const isAdmin  = user.role === 'admin';
  const { alwaysOnline, rejectCall, readMessages, ignoreGroups, ignoreStatus } = req.body as {
    alwaysOnline?: boolean; rejectCall?: boolean; readMessages?: boolean;
    ignoreGroups?: boolean; ignoreStatus?: boolean;
  };
  try {
    let query = supabaseAdmin.from('instances').select('metadata').eq('instance_name', name);
    if (!isAdmin) {
      if (user.tenantId) query = query.eq('tenant_id', user.tenantId);
      query = query.eq('created_by', user.userId);
    }
    const { data: inst, error } = await query.maybeSingle();
    if (error || !inst) { res.status(404).json({ success: false, error: 'Instância não encontrada.' }); return; }
    const meta = ((inst.metadata as Record<string, unknown>) || {}) as Record<string, unknown>;
    meta.advanced = {
      alwaysOnline: !!alwaysOnline, rejectCall: !!rejectCall,
      readMessages: !!readMessages, ignoreGroups: !!ignoreGroups, ignoreStatus: !!ignoreStatus,
    };

    /* Salvar no Supabase */
    let upQuery = supabaseAdmin.from('instances').update({ metadata: meta }).eq('instance_name', name);
    if (!isAdmin) {
      if (user.tenantId) upQuery = upQuery.eq('tenant_id', user.tenantId);
      upQuery = upQuery.eq('created_by', user.userId);
    }
    const { error: upErr } = await upQuery;
    if (upErr) { res.status(500).json({ success: false, error: upErr.message }); return; }

    /* Chamar EvoGo: PUT /instance/{uuid}/advanced-settings
       Auth: token da instância (não GLOBAL_API_KEY) */
    const createData = (meta.create as Record<string, unknown>)?.data as Record<string, unknown> | undefined
                    || (meta.data as Record<string, unknown> | undefined);
    const instanceUuid  = (createData?.id    as string) || '';
    const instanceToken = (createData?.token as string) || '';
    if (instanceUuid && instanceToken) {
      try {
        const _evo = await getEvoGoConfig();
        const advResult = await updateAdvancedSettings(instanceUuid, {
          alwaysOnline:  !!alwaysOnline,
          rejectCall:    !!rejectCall,
          readMessages:  !!readMessages,
          ignoreGroups:  !!ignoreGroups,
          ignoreStatus:  !!ignoreStatus,
        }, _evo.url, instanceToken);
        if (!advResult.success) {
          console.warn('[Advanced] EvoGo retornou erro:', advResult.error);
        }
      } catch (evoErr) {
        console.warn('[Advanced] EvoGo update falhou (salvo localmente):', (evoErr as Error).message);
      }
    } else {
      console.warn('[Advanced] UUID ou token da instância não encontrado no metadata — apenas Supabase atualizado.');
    }

    res.json({ success: true });
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

/* ── Admin: Listar instâncias na EvoGo API ───────────────────── */
app.get('/api/admin/instances', requireAuth, requireAdmin, async (req, res) => {
  const tenantId = req.user!.tenantId || '';
  let _adminEvo: { url: string; key: string };
  try { _adminEvo = await getEvoGoConfig(); }
  catch { res.status(400).json({ success: false, error: 'EvoGo não configurado. Acesse Configuração → EvoGo.' }); return; }
  try {
    const result = await getAllInstances(_adminEvo.url, _adminEvo.key);
    res.status(result.success ? 200 : (result.httpStatus || 502)).json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Admin: Testar conexão ───────────────────────────────────────────── */
app.post('/api/admin/test-connection', requireAuth, requireAdmin, async (req, res) => {
  const { evogoUrl, apiKey } = req.body as { evogoUrl?: string; apiKey?: string };
  let baseUrl = evogoUrl?.trim() || '';
  let key     = apiKey?.trim()   || '';

  /* Se URL ou chave não foram enviadas na request, busca da system_config global */
  if (!baseUrl || !key) {
    try {
      const { data } = await supabaseAdmin
        .from('system_config')
        .select('key, value')
        .in('key', ['evogo_url', 'evogo_api_key']);
      const rows = data as { key: string; value: string }[] | null;
      if (!baseUrl) baseUrl = rows?.find(r => r.key === 'evogo_url')?.value?.trim()     || '';
      if (!key)     key     = rows?.find(r => r.key === 'evogo_api_key')?.value?.trim() || '';
    } catch { /* segue com o que tiver */ }
  }

  if (!baseUrl) { res.status(400).json({ success: false, error: 'URL da API não configurada. Salve a URL antes de testar.' }); return; }
  if (!key)     { res.status(400).json({ success: false, error: 'Chave da API não configurada. Salve a GLOBAL_API_KEY antes de testar.' }); return; }

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


/* ── Monitor — status em lote de todas as instâncias ────────────────── */
app.get('/api/monitor', requireAuth, async (req, res) => {
  const user    = req.user!;
  const isAdmin = user.role === 'admin';
  try {
    const result = await listInstances(
      isAdmin ? undefined : user.tenantId,
      isAdmin,
      isAdmin ? undefined : user.userId,
    );
    const checkedAt = new Date().toISOString();
    const instances = (result.data as Array<Record<string, unknown>>) || [];
    if (!result.success || !instances.length) {
      res.json({ success: true, data: [], checkedAt });
      return;
    }
    /* ── Ajuste 2: separar órfãos antes de chamar a EvoGo API ── */
    const hasId = (inst: Record<string, unknown>): boolean => {
      const meta  = (inst.metadata as Record<string, unknown>) || {};
      const newId = ((meta.create as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.id;
      const oldId = (meta.data as Record<string, unknown> | undefined)?.id;
      return !!(newId || oldId);
    };
    const orphanData = instances
      .filter(inst => !hasId(inst))
      .map(inst => ({ name: inst.instance_name as string, connected: false, orphan: true, checkedAt }));
    const nonOrphans = instances.filter(hasId);

    /* ── Ajuste 1: timeout de 6s por instância via Promise.race ── */
    const settled = await Promise.allSettled(
      nonOrphans.map(async (inst) => {
        const name     = inst.instance_name as string;
        const meta     = (inst.metadata as Record<string, unknown>) || {};
        const token    = extractInstanceToken(meta);
        const tenantId = (inst.tenant_id as string) || '';
        let _monEvoUrl: string | undefined;
        try { const cfg = await getEvoGoConfig(); _monEvoUrl = cfg.url; } catch { _monEvoUrl = undefined; }
        try {
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => { const e = new Error('Monitor timeout'); e.name = 'AbortError'; reject(e); }, 6000)
          );
          const st    = await Promise.race([getInstanceStatus(token, _monEvoUrl), timeoutPromise]);
          const d     = (st.data as Record<string, unknown>) || {};
          const inner = (d.data as Record<string, unknown>) || {};
          const loggedIn = inner.LoggedIn === true;
          return { name, connected: loggedIn, status: loggedIn ? 'connected' : 'disconnected', orphan: false, checkedAt };
        } catch (err: unknown) {
          const isTimeout = (err as Error)?.name === 'AbortError';
          return { name, connected: false, status: isTimeout ? 'failure' : 'error', orphan: false, checkedAt };
        }
      }),
    );
    const activeData = settled.map(r => r.status === 'fulfilled'
      ? r.value
      : { name: '?', connected: false, status: 'failure', orphan: false, checkedAt });
    res.json({ success: true, data: [...orphanData, ...activeData], checkedAt });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Admin: Ler config EvoGo ─────────────────────────────────── */
app.get('/api/admin/config/evogo', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('system_config')
      .select('key, value')
      .in('key', ['evogo_url', 'evogo_api_key']);
    const rows = data as { key: string; value: string }[] | null;
    const url  = rows?.find(r => r.key === 'evogo_url')?.value?.trim()     || '';
    const key  = rows?.find(r => r.key === 'evogo_api_key')?.value?.trim() || '';
    res.json({ success: true, url, keyConfigured: !!key });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Admin: Salvar config EvoGo ──────────────────────────────── */
app.post('/api/admin/config/evogo', requireAuth, requireAdmin, async (req, res) => {
  const { url, key } = req.body as { url?: string; key?: string };
  const cleanUrl = url?.trim() || '';
  const cleanKey = key?.trim() || '';

  if (!cleanUrl && !cleanKey) {
    res.status(400).json({ success: false, error: 'Informe ao menos a URL ou a GLOBAL_API_KEY.' });
    return;
  }
  if (cleanUrl) {
    try { new URL(cleanUrl); } catch {
      res.status(400).json({ success: false, error: 'URL inválida. Informe uma URL completa (ex: https://evogo.exemplo.com).' });
      return;
    }
  }
  try {
    const upserts: { key: string; value: string; updated_at: string }[] = [];
    const now = new Date().toISOString();
    if (cleanUrl) upserts.push({ key: 'evogo_url',     value: cleanUrl, updated_at: now });
    if (cleanKey) upserts.push({ key: 'evogo_api_key', value: cleanKey, updated_at: now });
    const { error } = await supabaseAdmin
      .from('system_config')
      .upsert(upserts, { onConflict: 'key' });
    if (error) { res.status(500).json({ success: false, error: error.message }); return; }
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ══════════════════════════════════════════════════════════════════
   CATÁLOGO — Coleções e Itens (isolado por tenant + created_by)
   ══════════════════════════════════════════════════════════════════ */

/* ── Listar Coleções ────────────────────────────────────────────── */
app.get('/api/catalog/collections', requireAuth, async (req, res) => {
  const user    = req.user!;
  const isAdmin = user.role === 'admin';
  try {
    let q = supabaseAdmin
      .from('catalog_collections')
      .select('id, name, description, created_at')
      .order('created_at', { ascending: true });
    if (!isAdmin) {
      if (user.tenantId) q = q.eq('tenant_id', user.tenantId);
      q = q.eq('created_by', user.userId);
    }
    const { data, error } = await q;
    if (error) { res.status(500).json({ success: false, error: error.message }); return; }
    res.json({ success: true, data });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Criar Coleção ──────────────────────────────────────────────── */
app.post('/api/catalog/collections', requireAuth, async (req, res) => {
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name?.trim()) { res.status(400).json({ success: false, error: 'Nome é obrigatório.' }); return; }
  const user = req.user!;
  try {
    const { data, error } = await supabaseAdmin
      .from('catalog_collections')
      .insert({ name: name.trim(), description: description?.trim() || null, tenant_id: user.tenantId || null, created_by: user.userId })
      .select('id, name, description, created_at')
      .single();
    if (error) { res.status(409).json({ success: false, error: error.message }); return; }
    res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Excluir Coleção ────────────────────────────────────────────── */
app.delete('/api/catalog/collections/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const user    = req.user!;
  const isAdmin = user.role === 'admin';
  try {
    let q = supabaseAdmin.from('catalog_collections').delete().eq('id', id);
    if (!isAdmin) q = q.eq('created_by', user.userId);
    const { error } = await q;
    if (error) { res.status(404).json({ success: false, error: error.message }); return; }
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Listar Itens ───────────────────────────────────────────────── */
app.get('/api/catalog/items', requireAuth, async (req, res) => {
  const user    = req.user!;
  const isAdmin = user.role === 'admin';
  try {
    let q = supabaseAdmin
      .from('catalog_items')
      .select('id, name, description, price, currency, image_url, availability, meta_product_id, collection_id, created_at, catalog_collections(name)')
      .order('created_at', { ascending: true });
    if (!isAdmin) {
      if (user.tenantId) q = q.eq('tenant_id', user.tenantId);
      q = q.eq('created_by', user.userId);
    }
    const { data, error } = await q;
    if (error) { res.status(500).json({ success: false, error: error.message }); return; }
    res.json({ success: true, data });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Criar Item ─────────────────────────────────────────────────── */
app.post('/api/catalog/items', requireAuth, async (req, res) => {
  const { name, description, price, collection_id } = req.body as {
    name?: string; description?: string; price?: number | null; collection_id?: string | null;
  };
  if (!name?.trim()) { res.status(400).json({ success: false, error: 'Nome é obrigatório.' }); return; }
  const user = req.user!;
  try {
    const { data, error } = await supabaseAdmin
      .from('catalog_items')
      .insert({
        name: name.trim(),
        description: description?.trim() || null,
        price: price ?? null,
        collection_id: collection_id || null,
        tenant_id: user.tenantId || null,
        created_by: user.userId,
      })
      .select('id, name, description, price, collection_id, created_at')
      .single();
    if (error) { res.status(409).json({ success: false, error: error.message }); return; }
    res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Editar Item ────────────────────────────────────────────────── */
app.put('/api/catalog/items/:id', requireAuth, async (req, res) => {
  const { id }    = req.params;
  const user      = req.user!;
  const isAdmin   = user.role === 'admin';
  const { name, description, price, availability, image_url, collection_id } = req.body as {
    name?: string; description?: string; price?: number | null;
    availability?: string; image_url?: string; collection_id?: string | null;
  };
  if (!name?.trim()) { res.status(400).json({ success: false, error: 'Nome é obrigatório.' }); return; }
  if (price == null || isNaN(Number(price)) || Number(price) < 0) {
    res.status(400).json({ success: false, error: 'Preço inválido.' }); return;
  }
  try {
    /* ── 1. Buscar item atual para obter meta_product_id (CRM ID) ── */
    let fetchQ = supabaseAdmin
      .from('catalog_items')
      .select('id, meta_product_id')
      .eq('id', id);
    if (!isAdmin) fetchQ = fetchQ.eq('created_by', user.userId);
    const { data: existing } = await fetchQ.maybeSingle();

    /* ── 2. Atualizar no Supabase ── */
    let q = supabaseAdmin
      .from('catalog_items')
      .update({
        name         : name.trim(),
        description  : description?.trim() || null,
        price        : price ?? null,
        availability : availability || 'in stock',
        image_url    : image_url?.trim()  || null,
        collection_id: collection_id      || null,
      })
      .eq('id', id);
    if (!isAdmin) q = q.eq('created_by', user.userId);
    const { data, error } = await q
      .select('id, name, description, price, availability, image_url, collection_id, meta_product_id')
      .single();
    if (error) { res.status(500).json({ success: false, error: error.message }); return; }

    /* ── 3. Sincronizar com EvoAI CRM via PATCH (se tiver CRM ID) ── */
    let crmSynced  = false;
    let crmWarning: string | undefined;
    const crmId    = existing?.meta_product_id;
    if (crmId) {
      const crmCfg = await getEvoCRMConfig();
      if (crmCfg) {
        try {
          const patchUrl = `${crmCfg.url.replace(/\/$/, '')}/api/v1/products/${crmId}`;
          console.log(`[EVO CRM] PATCH ${patchUrl}`);
          const patchRes  = await fetch(patchUrl, {
            method : 'PATCH',
            headers: { 'Content-Type': 'application/json', 'api_access_token': crmCfg.token },
            body   : JSON.stringify({
              product: {
                name         : name.trim(),
                description  : description?.trim() || null,
                default_price: Number(price),
                currency     : 'BRL',
                metadata     : { image_url: image_url?.trim() || null },
              },
            }),
          });
          const patchJson = await patchRes.json() as Record<string, unknown>;
          console.log(`[EVO CRM] PATCH response (${patchRes.status}):`, JSON.stringify(patchJson));
          if (patchRes.ok) {
            crmSynced = true;
          } else {
            crmWarning = (patchJson as any)?.message || (patchJson as any)?.error || 'Falha ao sincronizar com CRM.';
            console.warn('[EVO CRM] PATCH falhou:', crmWarning);
          }
        } catch (crmErr) {
          crmWarning = 'Erro de rede ao sincronizar com CRM.';
          console.warn('[EVO CRM] Exceção no PATCH:', crmErr);
        }
      }
    }

    res.json({
      success   : true,
      data,
      crm_synced: crmSynced,
      ...(crmWarning ? { warning: crmWarning } : {}),
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Excluir Item ───────────────────────────────────────────────── */
app.delete('/api/catalog/items/:id', requireAuth, async (req, res) => {
  const { id }  = req.params;
  const user    = req.user!;
  const isAdmin = user.role === 'admin';
  try {
    /* ── 1. Buscar CRM ID antes de deletar ── */
    let fetchQ = supabaseAdmin
      .from('catalog_items')
      .select('id, meta_product_id')
      .eq('id', id);
    if (!isAdmin) fetchQ = fetchQ.eq('created_by', user.userId);
    const { data: existing } = await fetchQ.maybeSingle();

    /* ── 2. Deletar no Supabase ── */
    let q = supabaseAdmin.from('catalog_items').delete().eq('id', id);
    if (!isAdmin) q = q.eq('created_by', user.userId);
    const { error } = await q;
    if (error) { res.status(404).json({ success: false, error: error.message }); return; }

    /* ── 3. Deletar no EvoAI CRM (se tiver CRM ID) ── */
    let crmDeleted = false;
    let crmWarning: string | undefined;
    const crmId    = existing?.meta_product_id;
    if (crmId) {
      const crmCfg = await getEvoCRMConfig();
      if (crmCfg) {
        try {
          const delUrl = `${crmCfg.url.replace(/\/$/, '')}/api/v1/products/${crmId}`;
          console.log(`[EVO CRM] DELETE ${delUrl}`);
          const delRes = await fetch(delUrl, {
            method : 'DELETE',
            headers: { 'api_access_token': crmCfg.token },
          });
          console.log(`[EVO CRM] DELETE response: ${delRes.status}`);
          if (delRes.ok || delRes.status === 404) {
            crmDeleted = true;
          } else {
            const delJson = await delRes.json().catch(() => ({})) as Record<string, unknown>;
            crmWarning = (delJson as any)?.message || (delJson as any)?.error || `CRM respondeu ${delRes.status}.`;
            console.warn('[EVO CRM] DELETE falhou:', crmWarning);
          }
        } catch (crmErr) {
          crmWarning = 'Erro de rede ao deletar no CRM.';
          console.warn('[EVO CRM] Exceção no DELETE:', crmErr);
        }
      }
    }

    res.json({
      success    : true,
      crm_deleted: crmDeleted,
      ...(crmWarning ? { warning: crmWarning } : {}),
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ══════════════════════════════════════════════════════════════════
   EVO CRM CONFIG — URL + token global (system_config)
   ══════════════════════════════════════════════════════════════════ */

/* ── Ler config EvoAI CRM ───────────────────────────────────────── */
app.get('/api/admin/config/evo-crm', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('system_config')
      .select('key, value')
      .in('key', ['evo_crm_url', 'evo_crm_token']);
    const rows  = data as { key: string; value: string }[] | null;
    const url   = rows?.find(r => r.key === 'evo_crm_url')?.value?.trim()   || '';
    const token = rows?.find(r => r.key === 'evo_crm_token')?.value?.trim() || '';
    res.json({ success: true, url, configured: !!(url && token), tokenConfigured: !!token });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Testar token EvoAI CRM ─────────────────────────────────────── */
app.post('/api/admin/crm/test-token', requireAuth, requireAdmin, async (req, res) => {
  const { url, token } = req.body as { url?: string; token?: string };
  const cleanUrl   = url?.trim() || '';
  let   cleanToken = sanitizeHeaderValue(token || '');
  if (!cleanUrl) {
    res.status(400).json({ success: false, error: 'URL é obrigatória para o teste.' }); return;
  }
  /* token não enviado → tentar usar o salvo no banco */
  if (!cleanToken) {
    const { data } = await supabaseAdmin.from('system_config').select('value').eq('key', 'evo_crm_token').single();
    cleanToken = sanitizeHeaderValue((data as any)?.value || '');
    if (!cleanToken) {
      res.status(400).json({ success: false, error: 'Token não encontrado. Salve o token antes de testar.' }); return;
    }
  }
  try { new URL(cleanUrl); } catch {
    res.status(400).json({ success: false, error: 'URL inválida.' }); return;
  }
  try {
    const testUrl = `${cleanUrl.replace(/\/$/, '')}/api/v1/profile`;
    console.log(`[EVO CRM] TEST ${testUrl}`);
    const r = await fetch(testUrl, {
      headers : { 'api_access_token': cleanToken },
      signal  : AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    const raw        = await r.text();
    const isHtml     = raw.trimStart().startsWith('<');
    const redirected = r.redirected ? ` (redirecionado para ${r.url})` : '';
    console.log(`[EVO CRM] TEST response: HTTP ${r.status}${redirected}, isHtml=${isHtml}, preview=${raw.slice(0,120)}`);
    if (r.status === 401 || r.status === 403) {
      res.json({ success: false, error: `Token inválido ou sem permissão (HTTP ${r.status}).` }); return;
    }
    if (!r.ok) {
      const jsonMsg = (() => { try { return (JSON.parse(raw) as any)?.message; } catch { return null; } })();
      const msg = jsonMsg || (isHtml ? `HTTP ${r.status} — servidor retornou HTML${redirected}. Verifique a URL.` : `HTTP ${r.status}`);
      res.json({ success: false, error: msg }); return;
    }
    if (isHtml) {
      res.json({ success: false, error: `Servidor retornou HTML (HTTP ${r.status})${redirected}. Verifique a URL do CRM.` }); return;
    }
    /* tenta também /api/v1/products como fallback de confirmação */
    res.json({ success: true, message: `Conexão bem-sucedida! Token e URL válidos. (HTTP ${r.status})` });
  } catch (err: unknown) {
    const msg = (err as any)?.name === 'TimeoutError' ? 'Tempo limite excedido (8s). Verifique a URL.' : (err as Error).message;
    res.json({ success: false, error: msg });
  }
});

/* ── Helper: parse seguro de resposta do CRM (aceita HTML sem travar) */
async function safeJsonCRM(r: globalThis.Response): Promise<{ ok: boolean; status: number; body: Record<string, unknown>; raw: string }> {
  const raw = await r.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* HTML ou resposta vazia */ }
  return { ok: r.ok, status: r.status, body, raw };
}

/* ── Listar produtos do EvoAI CRM (proxy) ───────────────────────── */
app.get('/api/admin/crm/products', requireAuth, requireAdmin, async (req, res) => {
  const page     = Number(req.query.page     || 1);
  const per_page = Number(req.query.per_page || 25);
  try {
    const cfg = await getEvoCRMConfig();
    if (!cfg) { res.status(400).json({ success: false, error: 'EvoAI CRM não configurado.' }); return; }
    const url = `${cfg.url.replace(/\/$/, '')}/api/v1/products?page=${page}&per_page=${per_page}`;
    console.log(`[EVO CRM] GET ${url}`);
    const r   = await fetch(url, { headers: { 'api_access_token': cfg.token } });
    const { ok, status, body, raw } = await safeJsonCRM(r);
    if (!ok) {
      const msg = (body as any)?.message || (body as any)?.error || `HTTP ${status}${raw.startsWith('<') ? ' (resposta HTML — verifique URL e token do CRM)' : ''}`;
      res.status(status).json({ success: false, error: msg });
      return;
    }
    res.json({ success: true, data: body });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Listar variantes de um produto do EvoAI CRM (proxy) ─────────── */
app.get('/api/admin/crm/products/:productId/variants', requireAuth, requireAdmin, async (req, res) => {
  const { productId } = req.params;
  try {
    const cfg = await getEvoCRMConfig();
    if (!cfg) { res.status(400).json({ success: false, error: 'EvoAI CRM não configurado.' }); return; }
    const url = `${cfg.url.replace(/\/$/, '')}/api/v1/products/${productId}/variants`;
    console.log(`[EVO CRM] GET ${url}`);
    const r   = await fetch(url, { headers: { 'api_access_token': cfg.token } });
    const { ok, status, body, raw } = await safeJsonCRM(r);
    if (!ok) {
      const msg = (body as any)?.message || (body as any)?.error || `HTTP ${status}${raw.startsWith('<') ? ' (resposta HTML — verifique URL e token do CRM)' : ''}`;
      res.status(status).json({ success: false, error: msg });
      return;
    }
    res.json({ success: true, data: body });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Deletar variante de um produto no EvoAI CRM (proxy) ────────── */
app.delete('/api/admin/crm/products/:productId/variants/:variantId', requireAuth, requireAdmin, async (req, res) => {
  const { productId, variantId } = req.params;
  try {
    const cfg = await getEvoCRMConfig();
    if (!cfg) { res.status(400).json({ success: false, error: 'EvoAI CRM não configurado.' }); return; }
    const url = `${cfg.url.replace(/\/$/, '')}/api/v1/products/${productId}/variants/${variantId}`;
    console.log(`[EVO CRM] DELETE ${url}`);
    const r = await fetch(url, { method: 'DELETE', headers: { 'api_access_token': cfg.token } });
    if (r.status === 204 || r.status === 200) { res.json({ success: true }); return; }
    const { status, body, raw } = await safeJsonCRM(r);
    const msg = (body as any)?.message || (body as any)?.error || `HTTP ${status}${raw.startsWith('<') ? ' (resposta HTML — verifique URL e token do CRM)' : ''}`;
    res.status(status).json({ success: false, error: msg });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Editar variante de um produto no EvoAI CRM (proxy) ─────────── */
app.patch('/api/admin/crm/products/:productId/variants/:variantId', requireAuth, requireAdmin, async (req, res) => {
  const { productId, variantId } = req.params;
  const { name, sku, price_override, stock_quantity, position, attributes_data } = req.body as {
    name?: string; sku?: string; price_override?: number | null;
    stock_quantity?: number | null; position?: number | null; attributes_data?: Record<string, unknown>;
  };
  try {
    const cfg = await getEvoCRMConfig();
    if (!cfg) { res.status(400).json({ success: false, error: 'EvoAI CRM não configurado.' }); return; }
    const url = `${cfg.url.replace(/\/$/, '')}/api/v1/products/${productId}/variants/${variantId}`;
    console.log(`[EVO CRM] PATCH ${url}`);
    const payload: Record<string, unknown> = {};
    if (name            !== undefined) payload.name            = name?.trim() || null;
    if (sku             !== undefined) payload.sku             = sku?.trim()  || null;
    if (price_override  !== undefined) payload.price_override  = price_override  != null ? Number(price_override)  : null;
    if (stock_quantity  !== undefined) payload.stock_quantity  = stock_quantity  != null ? Number(stock_quantity)  : null;
    if (position        !== undefined) payload.position        = position        != null ? Number(position)        : null;
    if (attributes_data !== undefined) payload.attributes_data = attributes_data;
    const r = await fetch(url, {
      method : 'PATCH',
      headers: { 'Content-Type': 'application/json', 'api_access_token': cfg.token },
      body   : JSON.stringify({ variant: payload }),
    });
    const { ok, status, body, raw } = await safeJsonCRM(r);
    console.log(`[EVO CRM] PATCH variant response (${status}):`, raw.slice(0, 200));
    if (!ok) {
      const msg = (body as any)?.message || (body as any)?.error || `HTTP ${status}${raw.startsWith('<') ? ' (resposta HTML — verifique URL e token do CRM)' : ''}`;
      res.status(status).json({ success: false, error: msg });
      return;
    }
    res.json({ success: true, data: body });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Criar variante de um produto no EvoAI CRM (proxy) ──────────── */
app.post('/api/admin/crm/products/:productId/variants', requireAuth, requireAdmin, async (req, res) => {
  const { productId } = req.params;
  const { name, sku, price_override, stock_quantity, position, attributes_data } = req.body as {
    name?: string; sku?: string; price_override?: number | null;
    stock_quantity?: number | null; position?: number | null; attributes_data?: Record<string, unknown>;
  };
  if (!name?.trim()) { res.status(400).json({ success: false, error: 'Nome da variante é obrigatório.' }); return; }
  try {
    const cfg = await getEvoCRMConfig();
    if (!cfg) { res.status(400).json({ success: false, error: 'EvoAI CRM não configurado.' }); return; }
    const url = `${cfg.url.replace(/\/$/, '')}/api/v1/products/${productId}/variants`;
    console.log(`[EVO CRM] POST ${url}`);
    const r = await fetch(url, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'api_access_token': cfg.token },
      body   : JSON.stringify({
        variant: {
          name           : name.trim(),
          sku            : sku?.trim()                                  || null,
          price_override : price_override  != null ? Number(price_override)  : null,
          stock_quantity : stock_quantity  != null ? Number(stock_quantity)  : null,
          position       : position        != null ? Number(position)        : null,
          attributes_data: attributes_data || {},
        },
      }),
    });
    const { ok, status, body, raw } = await safeJsonCRM(r);
    console.log(`[EVO CRM] POST variants response (${status}):`, raw.slice(0, 200));
    if (!ok) {
      const msg = (body as any)?.message || (body as any)?.error || `HTTP ${status}${raw.startsWith('<') ? ' (resposta HTML — verifique URL e token do CRM)' : ''}`;
      res.status(status).json({ success: false, error: msg });
      return;
    }
    res.status(201).json({ success: true, data: body });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Salvar config EvoAI CRM ────────────────────────────────────── */
app.post('/api/admin/config/evo-crm', requireAuth, requireAdmin, async (req, res) => {
  const { url, token } = req.body as { url?: string; token?: string };
  const cleanUrl   = url?.trim()              || '';
  const cleanToken = sanitizeHeaderValue(token || '');
  if (!cleanUrl) {
    res.status(400).json({ success: false, error: 'URL do EvoAI CRM é obrigatória.' }); return;
  }
  try { new URL(cleanUrl); } catch {
    res.status(400).json({ success: false, error: 'URL inválida. Ex: https://api.evoai.app' }); return;
  }
  try {
    const now  = new Date().toISOString();
    const rows: { key: string; value: string; updated_at: string }[] = [
      { key: 'evo_crm_url', value: cleanUrl, updated_at: now },
    ];
    if (cleanToken) {
      rows.push({ key: 'evo_crm_token', value: cleanToken, updated_at: now });
    } else {
      /* token omitido → verificar se já existe um salvo */
      const { data: existing } = await supabaseAdmin
        .from('system_config').select('value').eq('key', 'evo_crm_token').single();
      if (!(existing as any)?.value) {
        res.status(400).json({ success: false, error: 'API Token é obrigatório na primeira configuração.' }); return;
      }
    }
    const { error } = await supabaseAdmin
      .from('system_config')
      .upsert(rows, { onConflict: 'key' });
    if (error) { res.status(500).json({ success: false, error: error.message }); return; }
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ══════════════════════════════════════════════════════════════════
   META CONFIG — Credenciais por tenant salvas no Supabase
   ══════════════════════════════════════════════════════════════════ */

/* ── Ler configuração Meta ──────────────────────────────────────── */
app.get('/api/meta-config', requireAuth, requireAdmin, async (req, res) => {
  const user = req.user!;
  try {
    let q = supabaseAdmin
      .from('tenant_meta_config')
      .select('id, meta_access_token, meta_business_id, meta_catalog_id, meta_waba_id, updated_at');
    if (user.tenantId) q = q.eq('tenant_id', user.tenantId);
    q = (q as any).eq('user_id', user.userId).maybeSingle();
    const { data, error } = await (q as any);
    if (error) { res.status(500).json({ success: false, error: error.message }); return; }
    const masked = data ? {
      ...data,
      meta_access_token: data.meta_access_token
        ? '••••••••' + data.meta_access_token.slice(-4)
        : '',
    } : null;
    res.json({ success: true, data: masked, configured: !!(data?.meta_catalog_id) });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Salvar configuração Meta ───────────────────────────────────── */
app.post('/api/meta-config', requireAuth, requireAdmin, async (req, res) => {
  const user = req.user!;
  const { meta_access_token, meta_business_id, meta_catalog_id, meta_waba_id } = req.body as {
    meta_access_token?: string; meta_business_id?: string;
    meta_catalog_id?: string; meta_waba_id?: string;
  };
  if (!meta_access_token?.trim() || !meta_catalog_id?.trim()) {
    res.status(400).json({ success: false, error: 'META_ACCESS_TOKEN e META_CATALOG_ID são obrigatórios.' });
    return;
  }
  try {
    const payload = {
      tenant_id: user.tenantId || null,
      user_id: user.userId,
      meta_access_token: meta_access_token.trim(),
      meta_business_id: meta_business_id?.trim() || null,
      meta_catalog_id: meta_catalog_id.trim(),
      meta_waba_id: meta_waba_id?.trim() || null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabaseAdmin
      .from('tenant_meta_config')
      .upsert(payload, { onConflict: 'tenant_id,user_id' })
      .select('id, meta_business_id, meta_catalog_id, meta_waba_id, updated_at')
      .single();
    if (error) { res.status(500).json({ success: false, error: error.message }); return; }
    res.json({ success: true, data });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/* ── Criar Produto no Catálogo (EvoAI CRM opcional) ─────────────── */
app.post('/api/catalog/products', requireAuth, async (req, res) => {
  const user = req.user!;
  const {
    name, description, price, image_url, availability, collection_id,
    kind, sku, purchase_url, stock_quantity, status,
  } = req.body as {
    name?: string; description?: string; price?: number | null;
    image_url?: string; availability?: string; collection_id?: string | null;
    kind?: string; sku?: string; purchase_url?: string; stock_quantity?: number | null;
    status?: string;
  };

  if (!name?.trim()) { res.status(400).json({ success: false, error: 'Nome é obrigatório.' }); return; }
  if (price == null || isNaN(Number(price)) || Number(price) < 0) {
    res.status(400).json({ success: false, error: 'Preço é obrigatório e deve ser >= 0.' }); return;
  }
  const avail = availability || 'in stock';

  try {
    /* ── Tentar sincronizar com EvoAI CRM (opcional) ── */
    let crmProductId: string | null = null;
    let crmSynced    = false;
    let crmWarning: string | undefined;

    const crmCfg = await getEvoCRMConfig();
    if (crmCfg) {
      try {
        const slug = (name.trim())
          .toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          + '-' + Date.now().toString(36);

        const payload: Record<string, unknown> = {
          product: {
            name          : name.trim(),
            slug,
            kind          : kind          || 'physical',
            description   : description?.trim()     || null,
            sku           : sku?.trim()             || null,
            default_price : Number(price),
            currency      : 'BRL',
            purchase_url  : purchase_url?.trim()    || null,
            status        : status                  || 'active',
            stock_quantity: stock_quantity != null ? Number(stock_quantity) : null,
            metadata      : { image_url: image_url?.trim() || null },
          },
          labels: [],
        };

        const crmUrl = `${crmCfg.url.replace(/\/$/, '')}/api/v1/products`;
        console.log(`[EVO CRM] POST ${crmUrl}`);
        const crmRes  = await fetch(crmUrl, {
          method : 'POST',
          headers: { 'Content-Type': 'application/json', 'api_access_token': crmCfg.token },
          body   : JSON.stringify(payload),
        });
        const crmJson = await crmRes.json() as Record<string, unknown>;
        console.log(`[EVO CRM] Response (${crmRes.status}):`, JSON.stringify(crmJson));

        if (crmRes.ok && (crmJson as any).id) {
          crmProductId = String((crmJson as any).id);
          crmSynced    = true;
        } else {
          crmWarning = (crmJson as any)?.message || (crmJson as any)?.error || 'Falha ao sincronizar com EvoAI CRM.';
          console.warn('[EVO CRM] Sincronização falhou:', crmWarning);
        }
      } catch (crmErr) {
        crmWarning = 'Erro de rede ao acessar EvoAI CRM (salvo localmente).';
        console.warn('[EVO CRM] Exceção:', crmErr);
      }
    }

    /* ── Sempre salvar no Supabase ── */
    const { data: item, error: dbErr } = await supabaseAdmin
      .from('catalog_items')
      .insert({
        name           : name.trim(),
        description    : description?.trim() || null,
        price          : price ?? null,
        currency       : 'BRL',
        availability   : avail,
        image_url      : image_url?.trim()      || null,
        collection_id  : collection_id           || null,
        meta_product_id: crmProductId,
        tenant_id      : user.tenantId           || null,
        created_by     : user.userId,
      })
      .select('id, name, description, price, image_url, availability, meta_product_id, collection_id, created_at')
      .single();

    if (dbErr) { res.status(500).json({ success: false, error: dbErr.message }); return; }

    res.status(201).json({
      success        : true,
      data           : item,
      crm_synced     : crmSynced,
      crm_product_id : crmProductId,
      ...(crmWarning ? { warning: crmWarning } : {}),
    });
  } catch (err: unknown) {
    console.error('[CATALOG] Exceção:', err);
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

async function start() {
  try {
    await runMigrations();
  } catch (err) {
    console.error('⚠️  Migrations falharam, servidor iniciará mesmo assim:', err);
  }

  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📦 Supabase: ${process.env.SUPABASE_URL ? '✅ configurado' : '⚠️  não configurado'}`);
  });
}

start();
