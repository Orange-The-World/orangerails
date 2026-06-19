import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src/index';

const ENV = {
  OR_SUPABASE_URL: 'https://upstream.example.com',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

function capture() {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; bodyText?: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | string, _init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input);
      const headers: Record<string, string> = {};
      for (const [k, v] of req.headers) headers[k] = v;
      let bodyText: string | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try { bodyText = await req.clone().text(); } catch { /* ignore */ }
      }
      calls.push({ url: req.url, method: req.method, headers, bodyText });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

describe('health', () => {
  it('returns local 200 without forwarding', async () => {
    const calls = capture();
    const res = await worker.fetch(new Request('https://api.orangerails.com/health'), ENV);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});

describe('v1 path map', () => {
  it('maps /v1/link/mint-token to or-link-mint-token', async () => {
    const calls = capture();
    await worker.fetch(
      new Request('https://api.orangerails.com/v1/link/mint-token', {
        method: 'POST',
        headers: { 'x-platform-api-key': 'k', 'content-type': 'application/json' },
        body: '{"a":1}',
      }),
      ENV,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://upstream.example.com/functions/v1/or-link-mint-token');
    expect(calls[0].headers['x-platform-api-key']).toBe('k');
    expect(calls[0].bodyText).toBe('{"a":1}');
  });

  it('maps /v1/connections/sync to or-sync', async () => {
    const calls = capture();
    await worker.fetch(
      new Request('https://api.orangerails.com/v1/connections/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      ENV,
    );
    expect(calls[0].url).toBe('https://upstream.example.com/functions/v1/or-sync');
  });

  it('maps /v1/truth/bitcoin-network to world-gateway/bitcoin-network with query', async () => {
    const calls = capture();
    await worker.fetch(
      new Request('https://api.orangerails.com/v1/truth/bitcoin-network?limit=5', {
        headers: { authorization: 'Bearer orw_x' },
      }),
      ENV,
    );
    expect(calls[0].url).toBe('https://upstream.example.com/functions/v1/world-gateway/bitcoin-network?limit=5');
    expect(calls[0].headers['authorization']).toBe('Bearer orw_x');
  });

  it('404 on unknown /v1 route', async () => {
    const calls = capture();
    const res = await worker.fetch(new Request('https://api.orangerails.com/v1/nope', { method: 'POST' }), ENV);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('404 on wrong method for known /v1 route', async () => {
    const calls = capture();
    const res = await worker.fetch(new Request('https://api.orangerails.com/v1/link/mint-token'), ENV);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('legacy /functions passthrough', () => {
  it('passes path and query straight to upstream', async () => {
    const calls = capture();
    await worker.fetch(
      new Request('https://api.orangerails.com/functions/v1/or-providers?x=1', {
        headers: { authorization: 'Bearer t' },
      }),
      ENV,
    );
    expect(calls[0].url).toBe('https://upstream.example.com/functions/v1/or-providers?x=1');
    expect(calls[0].headers['authorization']).toBe('Bearer t');
  });
});

describe('sync/blink removed', () => {
  it('returns 404 , Blink sync was inlined into the Supabase function', async () => {
    const calls = capture();
    const res = await worker.fetch(
      new Request('https://api.orangerails.com/sync/blink', { method: 'POST' }),
      ENV,
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('catch-all', () => {
  it('returns 404 for unknown roots', async () => {
    const calls = capture();
    const res = await worker.fetch(new Request('https://api.orangerails.com/wat'), ENV);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('handles preflight', async () => {
    const res = await worker.fetch(new Request('https://api.orangerails.com/v1/link/mint-token', { method: 'OPTIONS' }), ENV);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('header hygiene', () => {
  it('strips host and cf-* headers when forwarding', async () => {
    const calls = capture();
    await worker.fetch(
      new Request('https://api.orangerails.com/v1/providers', {
        headers: {
          host: 'api.orangerails.com',
          'cf-ray': 'abc',
          'cf-connecting-ip': '1.2.3.4',
          authorization: 'Bearer k',
        },
      }),
      ENV,
    );
    const sent = calls[0].headers;
    expect(sent['host']).toBeUndefined();
    expect(sent['cf-ray']).toBeUndefined();
    expect(sent['cf-connecting-ip']).toBeUndefined();
    expect(sent['authorization']).toBe('Bearer k');
  });
});
