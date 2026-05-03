import pg from 'pg';
import bcrypt from 'bcryptjs';
import { supabaseAdmin, supabaseClient } from './supabase.js';

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: string;
  active: boolean;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_slug: string | null;
}

function getClient() {
  return new pg.Client({
    connectionString: process.env.SUPABASE_POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
  });
}

export async function loginUser(email: string, password: string) {
  const client = getClient();
  try {
    await client.connect();
    const { rows } = await client.query<UserRow>(
      `SELECT u.id, u.name, u.email, u.password_hash, u.role, u.active,
              u.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug
       FROM public.users u
       LEFT JOIN public.tenants t ON t.id = u.tenant_id
       WHERE u.email = $1
       LIMIT 1`,
      [email.toLowerCase().trim()]
    );

    if (!rows.length) {
      return { success: false, error: 'E-mail ou senha incorretos.' };
    }

    const user = rows[0];

    if (!user.active) {
      return { success: false, error: 'Conta desativada. Fale com o administrador.' };
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return { success: false, error: 'E-mail ou senha incorretos.' };
    }

    return {
      success: true,
      user: {
        id:         user.id,
        name:       user.name,
        email:      user.email,
        role:       user.role,
        tenantId:   user.tenant_id   || null,
        tenantName: user.tenant_name || 'Default',
        tenantSlug: user.tenant_slug || 'default',
      },
    };
  } finally {
    await client.end();
  }
}

export async function registerUser(
  name: string,
  email: string,
  password: string,
  role: string,
  tenantId?: string,
) {
  const client = getClient();
  try {
    await client.connect();

    const { rows: existing } = await client.query(
      'SELECT id FROM public.users WHERE email = $1 LIMIT 1',
      [email.toLowerCase().trim()]
    );

    if (existing.length) {
      return { success: false, error: 'Já existe uma conta com este e-mail.' };
    }

    /* Se não foi passado tenant_id, usar o tenant "default" */
    let resolvedTenantId = tenantId || null;
    if (!resolvedTenantId) {
      const { rows: tenantRows } = await client.query<{ id: string }>(
        `SELECT id FROM public.tenants WHERE slug = 'default' LIMIT 1`
      );
      resolvedTenantId = tenantRows[0]?.id || null;
    }

    const password_hash = await bcrypt.hash(password, 10);

    const { rows } = await client.query<{ id: string; name: string; email: string; role: string; tenant_id: string }>(
      `INSERT INTO public.users (name, email, password_hash, role, active, tenant_id)
       VALUES ($1, $2, $3, $4, true, $5)
       RETURNING id, name, email, role, tenant_id`,
      [name.trim(), email.toLowerCase().trim(), password_hash, role, resolvedTenantId]
    );

    const user = rows[0];
    return {
      success: true,
      user: {
        id:       user.id,
        name:     user.name,
        email:    user.email,
        role:     user.role,
        tenantId: user.tenant_id || null,
      },
    };
  } finally {
    await client.end();
  }
}

/* ── Recuperação de senha ────────────────────────────────────────────── */

export async function requestPasswordReset(
  email: string,
  redirectTo: string,
): Promise<{ success: boolean; error?: string }> {
  const normalizedEmail = email.toLowerCase().trim();

  /* 1. Verificar se o e-mail existe na nossa tabela de usuários */
  const client = getClient();
  try {
    await client.connect();
    const { rows } = await client.query(
      'SELECT id FROM public.users WHERE email = $1 LIMIT 1',
      [normalizedEmail],
    );
    /* Não revelar se o e-mail existe — retornar sucesso genérico */
    if (!rows.length) {
      console.log(`[auth] requestPasswordReset: e-mail não encontrado em public.users — resposta genérica`);
      return { success: true };
    }
  } finally {
    await client.end();
  }

  /* 2. Garantir que o usuário existe em auth.users (necessário para resetPasswordForEmail) */
  const { error: genError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'recovery' as const,
    email: normalizedEmail,
    options: { redirectTo },
  });

  if (genError) {
    /* Usuário não existe em auth.users — criar com senha temporária */
    console.log(`[auth] requestPasswordReset: criando usuário em auth.users para "${normalizedEmail}"`);
    const tmpPassword = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const { error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: normalizedEmail,
      email_confirm: true,
      password: tmpPassword,
    });
    if (createErr) {
      console.error(`[auth] requestPasswordReset: falha ao criar em auth.users: ${createErr.message}`);
      return { success: true }; /* resposta genérica — não expor o erro */
    }
  }

  /* 3. Disparar e-mail de recuperação via Supabase (resetPasswordForEmail envia o e-mail de fato) */
  console.log(`[auth] requestPasswordReset: chamando resetPasswordForEmail → redirectTo="${redirectTo}"`);
  const { error: resetErr } = await supabaseAdmin.auth.resetPasswordForEmail(normalizedEmail, { redirectTo });

  if (resetErr) {
    console.error(`[auth] requestPasswordReset: resetPasswordForEmail error: ${resetErr.message}`);
    /* Retornar sucesso genérico mesmo em erro — não revelar detalhes */
    return { success: true };
  }

  console.log(`[auth] requestPasswordReset: e-mail enviado com sucesso para "${normalizedEmail}"`);
  return { success: true };
}

export async function resetPassword(
  accessToken: string,
  newPassword: string,
): Promise<{ success: boolean; error?: string }> {
  /* Verificar token com Supabase e obter o email do usuário */
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(accessToken);

  if (error || !user?.email) {
    return { success: false, error: 'Link inválido ou expirado. Solicite um novo link.' };
  }

  /* Atualizar o hash de senha na nossa tabela de usuários */
  const password_hash = await bcrypt.hash(newPassword, 10);
  const client = getClient();
  try {
    await client.connect();
    const { rows } = await client.query(
      'UPDATE public.users SET password_hash = $1, updated_at = NOW() WHERE email = $2 RETURNING id',
      [password_hash, user.email.toLowerCase()],
    );
    if (!rows.length) {
      return { success: false, error: 'Usuário não encontrado.' };
    }
  } finally {
    await client.end();
  }

  return { success: true };
}
