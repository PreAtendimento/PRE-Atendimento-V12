export interface EvoApiResponse {
  success:     boolean;
  data?:       unknown;
  error?:      string;
  httpStatus?: number;
  urlCalled?:  string;
}

export async function createInstanceEvolutionApi(
  instanceName: string,
  evolutionApiUrl:        string,
  evolutionGlobalApiKey:  string,
  token?:       string,
): Promise<EvoApiResponse> {
  const baseUrl = evolutionApiUrl.replace(/\/$/, '');
  const apiKey  = evolutionGlobalApiKey;

  if (!baseUrl) return { success: false, error: 'EVOLUTION_API_URL não configurada para este tenant.' };
  if (!apiKey)  return { success: false, error: 'EVOLUTION_GLOBAL_API_KEY não configurada para este tenant.' };

  const url = `${baseUrl}/instance/create`;
  console.log(`[Evolution API] ▶ POST ${url}`);

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 15_000);

  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body:    JSON.stringify({ name: instanceName, token: token || '' }),
      signal:  controller.signal,
    });
    clearTimeout(timeout);

    const rawBody = await r.text();
    console.log(`[Evolution API] ◀ HTTP ${r.status}`, rawBody.slice(0, 600));

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
      urlCalled:  `POST ${url}`,
      ...(errorMsg ? { error: errorMsg } : {}),
    };
  } catch (err: unknown) {
    clearTimeout(timeout);
    const msg = (err as Error).name === 'AbortError'
      ? 'Timeout: sem resposta em 15s'
      : (err as Error).message;
    console.error('[Evolution API] ✖', msg);
    return { success: false, error: msg, urlCalled: `POST ${url}` };
  }
}
