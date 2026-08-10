// supabase/functions/_shared/net-guard.ts
// SSRF guard: rejects user-supplied URLs that target private or reserved hosts.
// Call assertPublicHttpUrl per-request (not just at credential parse time) to
// defeat DNS rebinding. Returns the parsed URL on success; throws NetGuardError
// on violation so callers surface a typed error without leaking internals.

export class NetGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetGuardError';
  }
}

export type ResolveDnsFn = (host: string, recordType: 'A' | 'AAAA') => Promise<string[]>;

export interface NetGuardOpts {
  resolveDns?: ResolveDnsFn;
}

/** Returns true when the IPv4 quad is in a private or reserved range. */
function isBlockedIPv4(a: number, b: number, c: number, d: number): boolean {
  if (a === 127) return true;                                  // loopback 127.0.0.0/8
  if (a === 10) return true;                                   // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;           // private 172.16.0.0/12
  if (a === 192 && b === 168) return true;                     // private 192.168.0.0/16
  if (a === 169 && b === 254) return true;                     // link-local + metadata 169.254.0.0/16
  if (a === 100 && (b & 0xc0) === 64) return true;            // CGNAT per RFC 6598
  if (a === 0 && b === 0 && c === 0 && d === 0) return true;  // unspecified 0.0.0.0
  return false;
}

function assertPublicIPv4(ip: string): void {
  const parts = ip.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    throw new NetGuardError(`Invalid IPv4 address: ${ip}`);
  }
  if (isBlockedIPv4(parts[0], parts[1], parts[2], parts[3])) {
    throw new NetGuardError(`Blocked address (private or reserved): ${ip}`);
  }
}

/** Returns true when the IPv6 address string (brackets stripped) is private or reserved. */
function isBlockedIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === '::1') return true;                            // loopback
  if (lower === '::') return true;                             // unspecified
  // Link-local fe80::/10: first 16-bit group masked to 0xffc0 equals 0xfe80.
  const firstGroup = lower.split(':')[0];
  const firstU16 = parseInt(firstGroup || '0', 16);
  if ((firstU16 & 0xffc0) === 0xfe80) return true;            // fe80::/10
  // Unique-local fc00::/7 (fc and fd prefixes): first byte masked to 0xfe equals 0xfc.
  const firstByte = firstU16 >> 8;
  if ((firstByte & 0xfe) === 0xfc) return true;               // fc00::/7
  // IPv4-mapped ::ffff:... blocks all (defeats ::ffff:127.0.0.1 etc.)
  if (lower.startsWith('::ffff:')) return true;
  if (lower.startsWith('0:0:0:0:0:ffff:')) return true;
  return false;
}

function assertPublicIPv6(addr: string): void {
  if (isBlockedIPv6(addr)) {
    throw new NetGuardError(`Blocked address (private or reserved): ${addr}`);
  }
}

async function defaultResolveDns(host: string, recordType: 'A' | 'AAAA'): Promise<string[]> {
  try {
    return await Deno.resolveDns(host, recordType);
  } catch {
    return [];
  }
}

/**
 * Validates rawUrl as a safe public HTTPS URL. Rejects:
 *   - non-https schemes (https-only; http for public IPs is a future opt-in)
 *   - userinfo (user:pass@)
 *   - IP literals in loopback, private, link-local, CGNAT, unique-local,
 *     unspecified, or IPv4-mapped-IPv6 ranges
 *   - hostnames resolving to any blocked address (checked per-request to defeat
 *     DNS rebinding; both A and AAAA records are validated)
 *
 * opts.resolveDns overrides DNS resolution for unit tests.
 * Returns the parsed URL on success.
 * Throws NetGuardError on any violation.
 */
export async function assertPublicHttpUrl(
  rawUrl: string,
  opts?: NetGuardOpts,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetGuardError(`Malformed URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:') {
    throw new NetGuardError(`URL must use https:, got: ${url.protocol}`);
  }

  if (url.username || url.password) {
    throw new NetGuardError('URL must not contain userinfo (user:pass@host)');
  }

  // Deno keeps brackets on IPv6 literals ([::1] stays [::1]); strip them before parsing.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ipv4Re = /^\d+\.\d+\.\d+\.\d+$/;

  if (ipv4Re.test(host)) {
    assertPublicIPv4(host);
  } else if (host.includes(':')) {
    // IPv6 literal (url.hostname already stripped brackets)
    assertPublicIPv6(host);
  } else {
    // Hostname: resolve DNS and check every resolved address (A + AAAA)
    const resolve = opts?.resolveDns ?? defaultResolveDns;
    const [aRecords, aaaaRecords] = await Promise.all([
      resolve(host, 'A'),
      resolve(host, 'AAAA'),
    ]);
    for (const ip of aRecords) {
      assertPublicIPv4(ip);
    }
    for (const ip of aaaaRecords) {
      assertPublicIPv6(ip);
    }
  }

  return url;
}
