import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonResponse({ error: 'Missing Authorization header' }, 401, cors);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return jsonResponse({ error: 'Unauthorized' }, 401, cors);

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    const body = JSON.parse(raw);
    const { api_key, cursor } = body ?? {};
    if (!api_key || typeof api_key !== 'string') return jsonResponse({ error: 'api_key required' }, 400, cors);

    const orBase = Deno.env.get('OR_API_URL') ?? 'https://api.orangerails.com';
    const orRes = await fetch(`${orBase}/sync/blink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key, cursor: cursor ?? null }),
    });

    if (!orRes.ok) {
      const detail = await orRes.text().catch(() => '');
      console.error('OrangeRails error:', orRes.status, detail);
      return jsonResponse({ error: 'OrangeRails sync failed', status: orRes.status }, 502, cors);
    }

    const result = await orRes.json();
    return jsonResponse(result, 200, cors);

  } catch (err) {
    console.error('sync-blink error:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});
