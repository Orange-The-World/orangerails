import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../src/index";

const ENV = {
  OR_SUPABASE_URL: "https://upstream.example.com",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

function capture() {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    bodyText?: string;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, _init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input);
      const headers: Record<string, string> = {};
      for (const [k, v] of req.headers) headers[k] = v;
      let bodyText: string | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        try {
          bodyText = await req.clone().text();
        } catch {
          /* ignore */
        }
      }
      calls.push({ url: req.url, method: req.method, headers, bodyText });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

describe("health", () => {
  it("returns local 200 without forwarding", async () => {
    const calls = capture();
    const res = await worker.fetch(new Request("https://api.orangerails.com/health"), ENV);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});

describe("v1 path map", () => {
  it("maps /v1/link/mint-token to or-link-mint-token", async () => {
    const calls = capture();
    await worker.fetch(
      new Request("https://api.orangerails.com/v1/link/mint-token", {
        method: "POST",
        headers: { "x-platform-api-key": "k", "content-type": "application/json" },
        body: '{"a":1}',
      }),
      ENV,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://upstream.example.com/functions/v1/or-link-mint-token");
    expect(calls[0].headers["x-platform-api-key"]).toBe("k");
    expect(calls[0].bodyText).toBe('{"a":1}');
  });

  it("maps /v1/connections/sync to or-sync", async () => {
    const calls = capture();
    await worker.fetch(
      new Request("https://api.orangerails.com/v1/connections/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      ENV,
    );
    expect(calls[0].url).toBe("https://upstream.example.com/functions/v1/or-sync");
  });

  it("maps /v1/quiltt/session-revoke to or-quiltt-session-revoke", async () => {
    const calls = capture();
    await worker.fetch(
      new Request("https://api.orangerails.com/v1/quiltt/session-revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"widget_token":"w","session_token":"s"}',
      }),
      ENV,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://upstream.example.com/functions/v1/or-quiltt-session-revoke");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].bodyText).toBe('{"widget_token":"w","session_token":"s"}');
  });

  it("404 on GET /v1/quiltt/session-revoke (POST-only)", async () => {
    const calls = capture();
    const res = await worker.fetch(
      new Request("https://api.orangerails.com/v1/quiltt/session-revoke"),
      ENV,
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("maps /v1/truth/bitcoin-network to world-gateway/bitcoin-network with query", async () => {
    const calls = capture();
    await worker.fetch(
      new Request("https://api.orangerails.com/v1/truth/bitcoin-network?limit=5", {
        headers: { authorization: "Bearer orw_x" },
      }),
      ENV,
    );
    expect(calls[0].url).toBe(
      "https://upstream.example.com/functions/v1/world-gateway/bitcoin-network?limit=5",
    );
    expect(calls[0].headers["authorization"]).toBe("Bearer orw_x");
  });

  it("404 on unknown /v1 route", async () => {
    const calls = capture();
    const res = await worker.fetch(
      new Request("https://api.orangerails.com/v1/nope", { method: "POST" }),
      ENV,
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("404 on wrong method for known /v1 route", async () => {
    const calls = capture();
    const res = await worker.fetch(
      new Request("https://api.orangerails.com/v1/link/mint-token"),
      ENV,
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("legacy /functions passthrough", () => {
  it("passes path and query straight to upstream", async () => {
    const calls = capture();
    await worker.fetch(
      new Request("https://api.orangerails.com/functions/v1/or-providers?x=1", {
        headers: { authorization: "Bearer t" },
      }),
      ENV,
    );
    expect(calls[0].url).toBe("https://upstream.example.com/functions/v1/or-providers?x=1");
    expect(calls[0].headers["authorization"]).toBe("Bearer t");
  });
});

describe("sync/blink removed", () => {
  it("returns 404 (Blink sync was inlined into the Supabase function)", async () => {
    const calls = capture();
    const res = await worker.fetch(
      new Request("https://api.orangerails.com/sync/blink", { method: "POST" }),
      ENV,
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("catch-all", () => {
  it("returns 404 for unknown roots", async () => {
    const calls = capture();
    const res = await worker.fetch(new Request("https://api.orangerails.com/wat"), ENV);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("handles preflight", async () => {
    const res = await worker.fetch(
      new Request("https://api.orangerails.com/v1/link/mint-token", { method: "OPTIONS" }),
      ENV,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("header hygiene", () => {
  it("strips host and other cf-* headers when forwarding", async () => {
    const calls = capture();
    await worker.fetch(
      new Request("https://api.orangerails.com/v1/providers", {
        headers: {
          host: "api.orangerails.com",
          "cf-ray": "abc",
          "cf-connecting-ip": "1.2.3.4",
          authorization: "Bearer k",
        },
      }),
      ENV,
    );
    const sent = calls[0].headers;
    expect(sent["host"]).toBeUndefined();
    expect(sent["cf-ray"]).toBeUndefined();
    expect(sent["authorization"]).toBe("Bearer k");
  });

  it("re-injects the genuine cf-connecting-ip after stripping it (OR-T1103)", async () => {
    // In production Cloudflare's edge sets this header on every request
    // that reaches the Worker and overwrites anything a caller sent
    // under that name, so the value on the incoming Request here stands
    // in for the genuine edge value. The gateway used to drop it and
    // never replace it, leaving every downstream function with no
    // trustworthy client-IP signal at all.
    const calls = capture();
    await worker.fetch(
      new Request("https://api.orangerails.com/v1/providers", {
        headers: { "cf-connecting-ip": "203.0.113.7" },
      }),
      ENV,
    );
    expect(calls[0].headers["cf-connecting-ip"]).toBe("203.0.113.7");
  });

  it("does not let a caller forge cf-connecting-ip via x-real-ip or x-forwarded-for (OR-C0493)", async () => {
    // No cf-connecting-ip on the incoming request at all here, simulating
    // a caller who has nothing genuine to offer under that name and
    // tries to substitute other, caller-writable headers instead. Those
    // must pass through unchanged and must NOT surface as
    // cf-connecting-ip on the outbound request.
    const calls = capture();
    await worker.fetch(
      new Request("https://api.orangerails.com/v1/providers", {
        headers: {
          "x-real-ip": "6.6.6.6",
          "x-forwarded-for": "6.6.6.6, 7.7.7.7",
        },
      }),
      ENV,
    );
    const sent = calls[0].headers;
    expect(sent["cf-connecting-ip"]).toBeUndefined();
    expect(sent["x-real-ip"]).toBe("6.6.6.6");
    expect(sent["x-forwarded-for"]).toBe("6.6.6.6, 7.7.7.7");
  });
});
