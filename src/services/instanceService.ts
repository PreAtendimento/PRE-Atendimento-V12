import { supabaseAdmin } from './supabase.js';
import {
  createInstance    as callCreate,
  connectInstance   as callConnect,
  disconnectInstance as callDisconnect,
  logoutInstance    as callLogout,
  deleteInstance    as callDelete,
} from './evolutionGo.js';

/* Extrai o token da instância da resposta do /instance/create. */
function extractInstanceToken(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;

  const inner = d.data as Record<string, unknown> | undefined;
  if (inner?.token)  return String(inner.token);
  if (inner?.apikey) return String(inner.apikey);

  const hash = d.hash as Record<string, unknown> | undefined;
  if (hash?.token)  return String(hash.token);
  if (hash?.apikey) return String(hash.apikey);

  if (d.token)  return String(d.token);
  if (d.apikey) return String(d.apikey);

  return '';
}

/* ── Buscar UUID e token da instância no banco ──────────────────────────
   Filtros aplicados para usuário comum (isAdmin=false):
     - tenant_id = tenantId  (isola pelo tenant)
     - created_by = userId   (isola pelo dono — bloqueio principal)
   Admin não recebe nenhum filtro restritivo.
*/
async function getInstanceMeta(
  instanceName: string,
  tenantId?: string,
  isAdmin = false,
  userId?: string,
): Promise<{ uuid: string; token: string; found: boolean }> {
  let query = supabaseAdmin
    .from('instances')
    .select('metadata')
    .eq('instance_name', instanceName);

  if (!isAdmin) {
    if (tenantId) query = query.eq('tenant_id', tenantId);
    if (userId)   query = query.eq('created_by', userId);
  }

  const { data: inst } = await query.maybeSingle();

  if (!inst?.metadata) return { uuid: '', token: '', found: !!inst };
  const meta = inst.metadata as Record<string, unknown>;

  /* Tentar ler UUID de create.data primeiro */
  const newData = (meta.create as Record<string, unknown> | undefined)
    ?.data as Record<string, unknown> | undefined;
  const oldData = meta.data as Record<string, unknown> | undefined;

  const uuid =
    (newData?.id  as string | undefined) ||
    (oldData?.id  as string | undefined) || '';

  /* Token: primeiro tenta campo de topo (salvo explicitamente), depois os aninhados */
  const token =
    (meta.token   as string | undefined) ||
    (newData?.token as string | undefined) ||
    (oldData?.token as string | undefined) || '';

  if (uuid || token) return { uuid, token, found: true };

  return { uuid: '', token: '', found: true };
}

/* ── Criar e persistir instância (API-first, sem ghost records) ─── */
export async function createInstanceAndPersist(
  instanceName: string,
  tenantId:     string,
  createdBy:    string,
  token?:       string,
  overrideUrl?: string,
  overrideKey?: string,
) {
  /* 1. Verificar duplicata no tenant */
  const { data: existing } = await supabaseAdmin
    .from('instances')
    .select('id, instance_name, status')
    .eq('instance_name', instanceName)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (existing) {
    return {
      success: false,
      error: `Instância "${instanceName}" já existe com status "${existing.status}".`,
    };
  }

  /* 2. Chamar API PRIMEIRO */
  console.log('[instanceService] ▶ Passo 1/2: criar instância na API');
  const createResult = await callCreate(instanceName, token, overrideUrl, overrideKey);

  if (!createResult.success) {
    console.error(`[instanceService] ✖ API recusou criar "${instanceName}": ${createResult.error}`);
    return {
      success:    false,
      error:      createResult.error || 'A API rejeitou a criação da instância.',
      httpStatus: createResult.httpStatus,
    };
  }

  /* 3. Conectar */
  let connectResult = null;
  const instanceToken = extractInstanceToken(createResult.data);

  if (instanceToken) {
    console.log('[instanceService] ▶ Passo 2/2: conectar instância');
    connectResult = await callConnect(instanceToken, overrideUrl);
  } else {
    console.warn('[instanceService] ⚠️  Token não encontrado — pulando connect');
  }

  /* 4. Persistir no banco vinculado ao tenant e ao usuário criador */
  const { data: record, error: insertError } = await supabaseAdmin
    .from('instances')
    .insert({
      instance_name: instanceName,
      status:        'active',
      provider:      'evo-go',
      tenant_id:     tenantId,
      created_by:    createdBy,
      metadata: {
        create:  createResult.data  ?? null,
        connect: connectResult?.data ?? null,
        token:   instanceToken       || null,
      },
    })
    .select()
    .single();

  if (insertError || !record) {
    console.error('[instanceService] ✖ Erro ao persistir:', insertError?.message);
    return {
      success: true,
      data: {
        instance_name:    instanceName,
        status:           'active',
        tenant_id:        tenantId,
        instance_token:   instanceToken || null,
        create_response:  createResult.data,
        connect_response: connectResult?.data ?? null,
      },
      warning: 'Instância criada na API mas não foi possível salvar localmente: ' + (insertError?.message || ''),
    };
  }

  await supabaseAdmin.from('instance_logs').insert({
    instance_id: record.id,
    event:   'created',
    payload: {
      create:  createResult.data,
      connect: connectResult ? { success: connectResult.success, data: connectResult.data } : null,
    },
  });

  return {
    success: true,
    data: {
      ...record,
      status:           'active',
      instance_token:   instanceToken || null,
      create_response:  createResult.data,
      connect_response: connectResult?.data ?? null,
    },
  };
}

/* ── Listar instâncias ────────────────────────────────────────────────
   Admin (isAdmin=true): retorna todas as instâncias de todos os tenants.
   Usuário comum: retorna APENAS as do próprio tenant E criadas pelo próprio usuário.
*/
export async function listInstances(tenantId?: string, isAdmin = false, userId?: string) {
  let query = supabaseAdmin
    .from('instances')
    .select('id, instance_name, status, provider, created_at, updated_at, metadata, tenant_id, created_by')
    .order('created_at', { ascending: false });

  if (!isAdmin) {
    if (tenantId) query = query.eq('tenant_id', tenantId);
    if (userId)   query = query.eq('created_by', userId);
  }

  const { data, error } = await query;
  if (error) return { success: false, error: error.message };
  return { success: true, data };
}

/* ── Desconectar ───────────────────────────────────────────────────── */
export async function disconnectInstanceService(
  instanceName:   string,
  tenantId?:      string,
  isAdmin?:       boolean,
  instanceToken?: string,
  overrideUrl?:   string,
  userId?:        string,
) {
  let token = instanceToken || '';
  if (!token) {
    const meta = await getInstanceMeta(instanceName, tenantId, isAdmin, userId);
    if (!meta.found) return { success: false, error: `Instância "${instanceName}" não encontrada ou sem permissão.` };
    token = meta.token;
  }

  const result = await callDisconnect(token, overrideUrl);

  if (result.success) {
    let upd = supabaseAdmin.from('instances').update({ status: 'inactive' }).eq('instance_name', instanceName);
    if (!isAdmin) {
      if (tenantId) upd = upd.eq('tenant_id', tenantId);
      if (userId)   upd = upd.eq('created_by', userId);
    }
    await upd;

    let q = supabaseAdmin.from('instances').select('id').eq('instance_name', instanceName);
    if (!isAdmin) {
      if (tenantId) q = q.eq('tenant_id', tenantId);
      if (userId)   q = q.eq('created_by', userId);
    }
    const { data: inst } = await q.maybeSingle();
    if (inst?.id) {
      await supabaseAdmin.from('instance_logs').insert({
        instance_id: inst.id, event: 'disconnected', payload: result.data as object ?? {},
      });
    }
  }

  return { success: result.success, data: result.data, error: result.error };
}

/* ── Logout ────────────────────────────────────────────────────────── */
export async function logoutInstanceService(
  instanceName:   string,
  tenantId?:      string,
  isAdmin?:       boolean,
  instanceToken?: string,
  overrideUrl?:   string,
  userId?:        string,
) {
  let token = instanceToken || '';
  if (!token) {
    const meta = await getInstanceMeta(instanceName, tenantId, isAdmin, userId);
    if (!meta.found) return { success: false, error: `Instância "${instanceName}" não encontrada ou sem permissão.` };
    token = meta.token;
  }

  const result = await callLogout(token, overrideUrl);

  if (result.success) {
    let upd = supabaseAdmin.from('instances').update({ status: 'inactive' }).eq('instance_name', instanceName);
    if (!isAdmin) {
      if (tenantId) upd = upd.eq('tenant_id', tenantId);
      if (userId)   upd = upd.eq('created_by', userId);
    }
    await upd;

    let q = supabaseAdmin.from('instances').select('id').eq('instance_name', instanceName);
    if (!isAdmin) {
      if (tenantId) q = q.eq('tenant_id', tenantId);
      if (userId)   q = q.eq('created_by', userId);
    }
    const { data: inst } = await q.maybeSingle();
    if (inst?.id) {
      await supabaseAdmin.from('instance_logs').insert({
        instance_id: inst.id, event: 'logout', payload: result.data as object ?? {},
      });
    }
  }

  return { success: result.success, data: result.data, error: result.error };
}

/* ── Deletar ──────────────────────────────────────────────────────────
   - Sem UUID: registro órfão → deletar do banco diretamente.
   - Com UUID: chamar API → só limpar banco após confirmação.
   - Controle de acesso: admin pode deletar qualquer; usuário só o que criou.
*/
export async function deleteInstanceService(
  instanceName: string,
  tenantId?:    string,
  isAdmin?:     boolean,
  overrideUrl?: string,
  overrideKey?: string,
  userId?:      string,
) {
  const meta = await getInstanceMeta(instanceName, tenantId, isAdmin, userId);

  if (!meta.found) {
    return { success: false, error: `Instância "${instanceName}" não encontrada ou sem permissão.` };
  }

  if (!meta.uuid) {
    console.warn(`[deleteInstanceService] UUID não encontrado para "${instanceName}" — removendo registro órfão.`);
    let q = supabaseAdmin.from('instances').select('id').eq('instance_name', instanceName);
    if (!isAdmin) {
      if (tenantId) q = q.eq('tenant_id', tenantId);
      if (userId)   q = q.eq('created_by', userId);
    }
    const { data: inst } = await q.maybeSingle();
    if (inst?.id) {
      await supabaseAdmin.from('instance_logs').delete().eq('instance_id', inst.id);
    }
    let del = supabaseAdmin.from('instances').delete().eq('instance_name', instanceName);
    if (!isAdmin) {
      if (tenantId) del = del.eq('tenant_id', tenantId);
      if (userId)   del = del.eq('created_by', userId);
    }
    await del;
    return { success: true, data: { message: 'Registro órfão removido do banco local.' }, orphan: true };
  }

  const result = await callDelete(meta.uuid, overrideUrl, overrideKey);
  const apiOk = result.success || result.httpStatus === 404;

  if (!apiOk) {
    console.error(`[deleteInstanceService] API recusou deleção de "${instanceName}": HTTP ${result.httpStatus}`);
    return {
      success:    false,
      error:      result.error || `A API retornou HTTP ${result.httpStatus}.`,
      httpStatus: result.httpStatus,
    };
  }

  let q = supabaseAdmin.from('instances').select('id').eq('instance_name', instanceName);
  if (!isAdmin) {
    if (tenantId) q = q.eq('tenant_id', tenantId);
    if (userId)   q = q.eq('created_by', userId);
  }
  const { data: inst } = await q.maybeSingle();
  if (inst?.id) {
    await supabaseAdmin.from('instance_logs').delete().eq('instance_id', inst.id);
  }

  let del = supabaseAdmin.from('instances').delete().eq('instance_name', instanceName);
  if (!isAdmin) {
    if (tenantId) del = del.eq('tenant_id', tenantId);
    if (userId)   del = del.eq('created_by', userId);
  }
  await del;

  return { success: true, data: result.data };
}

/* ── Force Delete (admin) — remove do banco ignorando a API ──────────
   Usado quando a API recusa o delete mas o registro precisa ser removido.
   Exclusivo para admins — não aplica filtro de tenant/usuário.
*/
export async function forceDeleteInstance(instanceName: string) {
  const { data: inst } = await supabaseAdmin
    .from('instances')
    .select('id')
    .eq('instance_name', instanceName)
    .maybeSingle();

  if (!inst) {
    return { success: false, error: `Instância "${instanceName}" não encontrada.` };
  }

  if (inst.id) {
    await supabaseAdmin.from('instance_logs').delete().eq('instance_id', inst.id);
  }

  const { error: delErr } = await supabaseAdmin
    .from('instances')
    .delete()
    .eq('instance_name', instanceName);

  if (delErr) return { success: false, error: delErr.message };

  console.log(`[forceDeleteInstance] ✅ "${instanceName}" removido do banco (force).`);
  return { success: true, data: { message: `Instância "${instanceName}" removida forçadamente do banco.` } };
}

/* ── Purgar registro órfão ─────────────────────────────────────────── */
export async function purgeOrphanedInstance(
  instanceName: string,
  tenantId?:    string,
  isAdmin?:     boolean,
  userId?:      string,
) {
  let query = supabaseAdmin
    .from('instances')
    .select('id, instance_name, status')
    .eq('instance_name', instanceName);

  if (!isAdmin) {
    if (tenantId) query = query.eq('tenant_id', tenantId);
    if (userId)   query = query.eq('created_by', userId);
  }

  const { data: inst, error } = await query.maybeSingle();

  if (error) return { success: false, error: error.message };
  if (!inst) return { success: false, error: `Instância "${instanceName}" não encontrada ou sem permissão.` };

  if (inst.id) {
    await supabaseAdmin.from('instance_logs').delete().eq('instance_id', inst.id);
  }

  let del = supabaseAdmin.from('instances').delete().eq('instance_name', instanceName);
  if (!isAdmin) {
    if (tenantId) del = del.eq('tenant_id', tenantId);
    if (userId)   del = del.eq('created_by', userId);
  }
  const { error: delErr } = await del;

  if (delErr) return { success: false, error: delErr.message };

  console.log(`[purgeOrphanedInstance] ✅ "${instanceName}" removido do banco local.`);
  return { success: true, data: { message: `Instância "${instanceName}" removida do banco local.` } };
}
