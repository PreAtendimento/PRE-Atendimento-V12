import dotenv from 'dotenv';
dotenv.config();

const EVOLUTION_API_URL = '';
const GLOBAL_API_KEY    = process.env.GLOBAL_API_KEY || '';

export interface EvolutionResponse {
  success:    boolean;
  data?:      unknown;
  error?:     string;
  httpStatus?: number;
  urlCalled?: string;
}

/* ── Helper genérico ── */
async function callApi(
  method:       'GET' | 'POST' | 'DELETE',
  path:         string,
  body?:        object,
  overrideUrl?: string,
  overrideKey?: string,
): Promise<EvolutionResponse> {
  const baseUrl = (overrideUrl || EVOLUTION_API_URL).replace(/\/$/, '');
  const apiKey  = overrideKey  || GLOBAL_API_KEY;

  if (!baseUrl) return { success: false, error: 'EVOLUTION_API_URL não configurada.' };
  if (!apiKey)  return { success: false, error: 'Chave da API (apikey) não configurada.' };

  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'apikey': apiKey,
  };

  console.log(`[Evolution GO] ▶ ${method} ${url}`);
  if (body && Object.keys(body).length > 0) console.log('[Evolution GO] Body:', JSON.stringify(body));

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 15_000);

  try {
    const r = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const rawBody = await r.text();
    console.log(`[Evolution GO] ◀ HTTP ${r.status}`, rawBody.slice(0, 600));

    let data: unknown;
    try { data = JSON.parse(rawBody); } catch { data = rawBody; }

    const d = data as Record<string, unknown> | null;
    const errorMsg = !r.ok
      ? ((d?.message as string) || (d?.error as string) || `Erro HTTP ${r.status}`)
      : undefined;

    return {
      success:    r.ok,
      data,
      httpStatus: r.status,
      urlCalled:  `${method} ${url}`,
      ...(errorMsg ? { error: errorMsg } : {}),
    };
  } catch (err: unknown) {
    clearTimeout(timeout);
    const msg = (err as Error).name === 'AbortError'
      ? 'Timeout: sem resposta em 15s'
      : (err as Error).message;
    console.error('[Evolution GO] ✖', msg);
    return { success: false, error: msg, urlCalled: `${method} ${url}` };
  }
}

/* ── 1. Listar todas as instâncias ───────────────────────────────────
   Swagger: GET /instance/all
   Header:  apikey: GLOBAL_API_KEY
   Params:  nenhum
*/
export async function getAllInstances(
  overrideUrl?: string,
  overrideKey?: string,
): Promise<EvolutionResponse> {
  return callApi('GET', '/instance/all', undefined, overrideUrl, overrideKey);
}

/* ── 2. Criar instância ──────────────────────────────────────────────
   Swagger: POST /instance/create
   Header:  apikey: GLOBAL_API_KEY
   Body:    CreateStruct { name, proxy?, token? }
   Resposta: { data: { id, name, token, ... } }
*/
export async function createInstance(
  instanceName: string,
  token?:       string,
  overrideUrl?: string,
  overrideKey?: string,
): Promise<EvolutionResponse> {
  return callApi(
    'POST',
    '/instance/create',
    { name: instanceName, token: token || '' },
    overrideUrl,
    overrideKey,
  );
}

/* ── 3. Conectar instância ───────────────────────────────────────────
   Swagger: POST /instance/connect
   Header:  apikey: <token da instância>
   Body:    ConnectStruct { immediate?, phone?, subscribe?, webhookUrl? }
            (todos os campos opcionais; instância identificada pelo token)
   Resposta: { data: { eventString, jid, webhookUrl } }
*/
export async function connectInstance(
  instanceToken: string,
  overrideUrl?:  string,
  opts?: {
    immediate?:  boolean;
    phone?:      string;
    subscribe?:  string[];
    webhookUrl?: string;
  },
): Promise<EvolutionResponse> {
  if (!instanceToken) {
    return { success: false, error: 'Token da instância não fornecido para conexão.' };
  }
  return callApi(
    'POST',
    '/instance/connect',
    opts ?? {},
    overrideUrl,
    instanceToken,
  );
}

/* ── 4. Obter QR Code ────────────────────────────────────────────────
   Swagger: GET /instance/qr
   Header:  apikey: <token da instância>
   Params:  nenhum (instância identificada pelo token)
   Retorna: HTTP 400 "no QR code available" enquanto gerando → fazer polling.
   Campos na resposta: data.data.Qrcode (base64 PNG), data.data.Code (pairing)
*/
export async function getQrCode(
  instanceToken: string,
  overrideUrl?:  string,
): Promise<EvolutionResponse> {
  if (!instanceToken) {
    return { success: false, error: 'Token da instância não fornecido para buscar QR Code.' };
  }
  return callApi('GET', '/instance/qr', undefined, overrideUrl, instanceToken);
}

/* ── 5. Status da instância ──────────────────────────────────────────
   Swagger: GET /instance/status
   Header:  apikey: <token da instância>
   Params:  nenhum (instância identificada pelo token)
*/
export async function getInstanceStatus(
  instanceToken: string,
  overrideUrl?:  string,
): Promise<EvolutionResponse> {
  if (!instanceToken) {
    return { success: false, error: 'Token da instância não fornecido para verificar status.' };
  }
  return callApi('GET', '/instance/status', undefined, overrideUrl, instanceToken);
}

/* ── 6. Desconectar instância ────────────────────────────────────────
   Swagger: POST /instance/disconnect
   Header:  apikey: <token da instância>
   Params:  nenhum (sem body)
*/
export async function disconnectInstance(
  instanceToken: string,
  overrideUrl?:  string,
): Promise<EvolutionResponse> {
  if (!instanceToken) {
    return { success: false, error: 'Token da instância não fornecido para desconectar.' };
  }
  return callApi('POST', '/instance/disconnect', {}, overrideUrl, instanceToken);
}

/* ── 7. Logout da instância ──────────────────────────────────────────
   Swagger: DELETE /instance/logout
   Header:  apikey: <token da instância>
   Params:  nenhum
   (Remove a sessão WhatsApp — diferente de disconnect que apenas pausa)
*/
export async function logoutInstance(
  instanceToken: string,
  overrideUrl?:  string,
): Promise<EvolutionResponse> {
  if (!instanceToken) {
    return { success: false, error: 'Token da instância não fornecido para logout.' };
  }
  return callApi('DELETE', '/instance/logout', undefined, overrideUrl, instanceToken);
}

/* ── 8. Solicitar código de pareamento ───────────────────────────────
   Swagger: POST /instance/pair
   Header:  apikey: <token da instância>
   Body:    PairStruct { phone, subscribe? }
   (Alternativa ao QR: envia código de pareamento por número de telefone)
*/
export async function pairInstance(
  instanceToken: string,
  phone:         string,
  subscribe?:    string[],
  overrideUrl?:  string,
): Promise<EvolutionResponse> {
  if (!instanceToken) {
    return { success: false, error: 'Token da instância não fornecido para pair.' };
  }
  if (!phone) {
    return { success: false, error: 'Número de telefone é obrigatório para pair.' };
  }
  return callApi(
    'POST',
    '/instance/pair',
    { phone, ...(subscribe ? { subscribe } : {}) },
    overrideUrl,
    instanceToken,
  );
}

/* ── 9. Foto de perfil da instância ─────────────────────────────────
   Swagger: GET /user/profilePicture
   Header:  apikey: <token da instância>
   Resposta esperada: { data: { picture, profilePictureUrl } } ou variante
*/
export async function getProfilePicture(
  instanceToken: string,
  overrideUrl?: string,
): Promise<EvolutionResponse> {
  if (!instanceToken) {
    return { success: false, error: 'Token não fornecido.' };
  }
  return callApi('GET', '/user/profilePicture', undefined, overrideUrl, instanceToken);
}

/* ── 10. Deletar instância ───────────────────────────────────────────
   Swagger: DELETE /instance/delete/{instanceId}
   Header:  apikey: GLOBAL_API_KEY
   Path:    instanceId = UUID da instância (vem de data.id no /instance/create)
*/
export async function deleteInstance(
  instanceUuid: string,
  overrideUrl?: string,
  overrideKey?: string,
): Promise<EvolutionResponse> {
  return callApi(
    'DELETE',
    `/instance/delete/${encodeURIComponent(instanceUuid)}`,
    undefined,
    overrideUrl,
    overrideKey,
  );
}
