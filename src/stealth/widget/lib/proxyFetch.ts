/**
 * Parent-proxy fetch helper.
 *
 * When the consuming app sets `proxy_base_url` in OR_STEALTH_INIT, the
 * widget routes edge-function calls through the parent window via
 * postMessage instead of doing cross-origin HTTP. Two reasons:
 *
 *   1. The parent app holds the platform API key server-side and can
 *      attach it to the call without exposing it to the browser.
 *   2. Browser cross-origin auth (cookie/CORS) is finicky and breaks
 *      on consumer apps with auth middleware that redirects preflights.
 *
 * Protocol contract is in postmessage.ts.
 */
import type {
  StealthProxyRequestMessage,
  StealthProxyResponseMessage,
} from '@/stealth/lib/postmessage';

export interface ProxyFetchResult {
  ok: boolean;
  status: number;
  bodyText: string;
  parsed: unknown;
}

export async function proxyFetch(opts: {
  parent: Window;
  parentOrigin: string;
  fn: string;
  body: unknown;
  timeoutMs?: number;
}): Promise<ProxyFetchResult> {
  const requestId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // 2 min default — covers the slow path where the consumer app is
  // forwarding to OR's edge function and OR is doing a database write
  // with index dedup against potentially many existing rows.
  // Sealed-transactions upload at the end of a big first sync can
  // legitimately push past 30s. The widget caller can override.
  const timeoutMs = opts.timeoutMs ?? 120000;

  return await new Promise<ProxyFetchResult>((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== opts.parentOrigin) return;
      const data = event.data as Partial<StealthProxyResponseMessage> | undefined;
      if (!data || data.type !== 'OR_STEALTH_PROXY_RESPONSE') return;
      if (data.request_id !== requestId) return;
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      const body = data.body;
      const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
      const status = typeof data.status === 'number' ? data.status : 0;
      resolve({
        ok: status >= 200 && status < 300,
        status,
        bodyText,
        parsed: body,
      });
    };
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(
        new Error(
          `Stealth proxy_fetch '${opts.fn}' timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    window.addEventListener('message', handler);
    const req: StealthProxyRequestMessage = {
      type: 'OR_STEALTH_PROXY_REQUEST',
      request_id: requestId,
      fn: opts.fn,
      body: opts.body,
    };
    opts.parent.postMessage(req, opts.parentOrigin);
  });
}
