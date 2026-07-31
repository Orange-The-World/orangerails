/**
 * Edge-function error reporting to self-hosted GlitchTip via direct
 * Sentry envelope POSTs.
 *
 * Why we don't use the @sentry/deno SDK
 * -------------------------------------
 * @sentry/deno is npm-imported and pulls ~50 KB+ of dependencies per
 * cold start. Multiplied across 38 functions on Supabase's per-function
 * cold-start budget, the added latency would be noticeable. The Sentry
 * wire protocol's `store` endpoint accepts a single JSON event, so a
 * ~150-line fetch-based reporter does what we need with zero deps.
 *
 * Hosting boundary
 * ----------------
 * pulse.orangerails.com is self-hosted by Orange Rails (GlitchTip,
 * Apache-2.0). No third-party SaaS is in the report path. SENTRY_DSN
 * must only be sourced from the trusted Supabase secret store; if a
 * malicious DSN is injected, every error envelope is exfiltrated.
 *
 * Configuration
 * -------------
 * Reads SENTRY_DSN from the function's environment. When unset (the
 * default for local dev), reportError is a no-op and never makes a
 * network call. Production environments set the DSN via the Supabase
 * project's edge-function secrets.
 *
 * Privacy posture
 * ---------------
 * The OR edge functions handle sealed envelope bytes (never plaintext
 * xpubs or vault keys), Quiltt session tokens (bearer credentials), and
 * Supabase JWTs. The reporter must never let any of those reach the
 * error tracker. We send ONLY:
 *   - the exception type, scrubbed message, and capped stack frames
 *   - the request method + URL pathname (query string and fragment stripped)
 *   - the function name (server_name)
 * No request body. No inbound headers. No client IP. No env bindings.
 *
 * Why we scrub messages
 * ---------------------
 * Upstream APIs (Quiltt, Strike) sometimes echo the failing request or
 * response body into 4xx/5xx error text. If that text gets caught and
 * re-thrown by our handlers, an Authorization header or session token
 * could land in event.exception.values[].value. scrubMessage() removes
 * Bearer tokens, JWT-shaped strings, long hex/base64 runs.
 */

import { errorClassName } from './upstream-errors.ts';

const SENTRY_DSN = Deno.env.get('SENTRY_DSN') ?? '';
const SENTRY_ENVIRONMENT = Deno.env.get('SENTRY_ENVIRONMENT') ?? 'production';
const SENTRY_RELEASE = Deno.env.get('SENTRY_RELEASE') ?? 'dev';

const MAX_FRAMES = 50;
const MAX_FRAME_LEN = 512;
const MAX_MESSAGE_LEN = 1024;

interface ParsedDSN {
  publicKey: string;
  host: string;
  projectId: string;
}

function parseDSN(dsn: string): ParsedDSN | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    return {
      publicKey: u.username,
      host: u.host,
      projectId: u.pathname.replace(/^\//, ''),
    };
  } catch {
    return null;
  }
}

const PARSED = parseDSN(SENTRY_DSN);

function uuidNoDashes(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function scrubMessage(s: string): string {
  let out = s
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, 'Bearer <redacted>')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '<jwt-redacted>')
    .replace(/[A-Fa-f0-9]{32,}/g, '<hex-redacted>')
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '<b64-redacted>');
  if (out.length > MAX_MESSAGE_LEN) out = out.slice(0, MAX_MESSAGE_LEN) + '...<truncated>';
  return out;
}

interface SentryFrame {
  filename: string;
  function?: string;
}

function framesFromStack(stack: string | undefined): SentryFrame[] {
  if (!stack) return [];
  return stack
    .split('\n')
    .slice(1, 1 + MAX_FRAMES)
    .map((line) => {
      const t = scrubMessage(line.trim());
      return { filename: t.length > MAX_FRAME_LEN ? t.slice(0, MAX_FRAME_LEN) : t };
    })
    .filter((f) => f.filename.length > 0);
}

export async function reportError(
  err: unknown,
  fnName: string,
  req?: Request,
): Promise<void> {
  if (!PARSED) return;

  const isErr = err instanceof Error;
  const rawMessage = isErr ? err.message : String(err);
  const message = scrubMessage(rawMessage);
  const stack = isErr ? err.stack : undefined;

  const event = {
    event_id: uuidNoDashes(),
    timestamp: Date.now() / 1000,
    platform: 'javascript',
    level: 'error',
    release: SENTRY_RELEASE,
    environment: SENTRY_ENVIRONMENT,
    server_name: fnName,
    exception: {
      values: [
        {
          // errorClassName, not constructor.name: minified bundles (CCXT is
          // one) mangle the constructor to a single letter, so this field has
          // been reporting types like "C" and grouping unrelated issues
          // together. See _shared/upstream-errors.ts (DL-0421).
          type: isErr ? errorClassName(err) : 'Error',
          value: message,
          stacktrace:
            framesFromStack(stack).length > 0
              ? { frames: framesFromStack(stack) }
              : undefined,
        },
      ],
    },
    tags: { fn: fnName, runtime: 'supabase-edge' },
    request: req
      ? {
          method: req.method,
          // Strip query string + fragment. The pathname is enough to
          // triage; tokens passed as query params or fragments never
          // reach pulse.
          url: new URL(req.url).pathname,
        }
      : undefined,
  };

  try {
    await fetch(
      `https://${PARSED.host}/api/${PARSED.projectId}/store/`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${PARSED.publicKey}, sentry_client=or-edge/1.0`,
        },
        body: JSON.stringify(event),
      },
    );
  } catch {
    // Best-effort. If pulse is unreachable, the function still serves
    // its error response to the caller; the report just gets dropped.
  }
}

/**
 * Wrap a Deno.serve handler so any uncaught exception inside the
 * handler is fire-and-forget reported to GlitchTip before propagating.
 *
 * Most OR edge function handlers wrap their own body in try/catch and
 * return a 500 response rather than throwing. In that common case the
 * wrapper is a no-op safety net; it fires only when something escapes
 * the inner catch (env-missing assertion, programming bug in the catch
 * itself, etc.). That is the intentional posture: redundant rather
 * than primary instrumentation.
 *
 * Usage:
 *   import { wrapSentryHandler } from '../_shared/sentry.ts';
 *   Deno.serve(wrapSentryHandler(async (req) => { ... }, 'or-foo'));
 */
export function wrapSentryHandler(
  handler: (req: Request) => Response | Promise<Response>,
  fnName: string,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      return await handler(req);
    } catch (err) {
      // Fire-and-forget so a slow pulse does not add latency to the
      // error response the user sees. Note: Supabase edge workers can
      // be torn down shortly after the response flushes, so in-flight
      // reports may be dropped on cold-stop. Function logs remain the
      // primary source of truth.
      void reportError(err, fnName, req);
      throw err;
    }
  };
}
