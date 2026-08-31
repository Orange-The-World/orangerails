# Stealth Sync: Integration Debugging Guide

> **Who this is for.** A developer, or an AI coding agent, integrating a
> consuming app with Stealth Sync and staring at a failure. This guide is
> deliberately verbose and self-contained: it assumes you can run `curl`
> and read a browser console, and it gives you the exact probe for each
> symptom so you can verify the failing layer instead of guessing.
>
> **The golden rule: probe, do not assume.** The recurring shape of a
> Stealth Sync bug is one layer silently misbehaving while everyone
> debugs a different layer. Each section below pairs a symptom with a
> copy-paste probe that isolates the layer.

## 1. The moving parts (what talks to what)

A Stealth Sync session involves five surfaces. Knowing which one you are
debugging is half the fix.

| # | Surface | Where it runs | What it does |
|---|---------|---------------|--------------|
| 1 | **Consuming app** (your app) | your origin | Opens the widget popup, proxies edge-function calls if configured, receives results via `postMessage` |
| 2 | **Widget popup** | `connect.orangerails.com` | The sync UI. Derives addresses, downloads filters, matches, fetches blocks, seals results. All in the user's browser |
| 3 | **Edge functions** | `<supabase-project>.supabase.co/functions/v1/or-*` | Envelope storage, connection registry, sealed-transaction store, sync cursor |
| 4 | **Filter source** | the filter CDN configured at build time | Serves BIP158 compact block filters as static files: `<height>.gcs.gz` + `<height>.json` sidecar |
| 5 | **Block source** | the block service configured at build time | Serves raw blocks by hash at `/block/<hash>`, chain tip at `/tip`, birthday resolution at `/height?date=` |

The widget bundle is built with Vite: surfaces 3-5 are baked in at
**build time** via `import.meta.env` values. If a URL or allowlist looks
wrong in production, the fix is a **new deployment**, not a config edit
(see §7).

## 2. The message flow (what happens in what order)

```
Consuming app                    Widget popup                   Edge functions
     |                                |                               |
     |--- window.open(/connect...) -->|                               |
     |<-- OR_STEALTH_READY -----------|                               |
     |--- OR_STEALTH_INIT ----------->|                               |
     |      (keys, connection_id,     |                               |
     |       app_user_id, token)      |                               |
     |                                |--- or-stealth-envelope-fetch->|
     |                                |<-- sealed envelope + cursor --|
     |                                |                               |
     |                                |  unseal in browser            |
     |                                |  derive addresses             |
     |                                |  fetch filters (CDN)          |
     |                                |  match in browser             |
     |                                |  fetch matched blocks         |
     |                                |  build + seal transactions    |
     |                                |                               |
     |                                |-- or-stealth-transactions-store ->|  (unless skip_transaction_upload)
     |                                |-- or-stealth-envelope-update ---->|  (sync cursor, always)
     |<-- OR_STEALTH_SYNC_COMPLETE ---|                               |
```

Key details agents get wrong:

- **INIT is answered to READY.** The popup posts `OR_STEALTH_READY` when
  it is actually ready; the opener replies with `OR_STEALTH_INIT`. If the
  opener sends INIT speculatively before READY (for example on a timer),
  a slow popup load can swallow it: `postMessage` to a still-loading
  cross-origin document is silently discarded by the browser. Always
  answer READY, even if a speculative send already fired.
- **Origins are validated on both sides.** The widget checks
  `window.opener`'s origin against its build-time allowlist before
  accepting INIT. The consuming app must check `event.origin ===
  "https://connect.orangerails.com"` before trusting any message.
- **The sync cursor is separate from the transaction upload.** Cursor
  persistence (`or-stealth-envelope-update`) runs after every successful
  sync. The transaction upload (`or-stealth-transactions-store`) is
  skipped entirely when the consuming app sets `skip_transaction_upload`.

## 3. Symptom: "Failed to fetch" on the final connect step

The widget completed discovery ("Found N wallets") but the final call
died. The browser console shows a CORS error naming the blocked URL.

**Probe** (replace the function name with the one in the console error):

```bash
curl -s -i -X OPTIONS \
  'https://<project-ref>.supabase.co/functions/v1/or-link-complete' \
  -H 'Origin: https://connect.orangerails.com' \
  -H 'Access-Control-Request-Method: POST' | grep -i access-control
```

**Healthy:** the response includes
`access-control-allow-origin: https://connect.orangerails.com`.

**Broken:** no `access-control-allow-origin` header at all. The browser
then blocks the response and every fetch fails with the generic
`Failed to fetch`.

**Causes, in order of likelihood:**

1. The origin is missing from `ALLOWED_ORIGINS` in
   `supabase/functions/_shared/http.ts` **on the branch that was actually
   deployed**. The dev and prod Supabase projects deploy from different
   branches; an entry present on one branch is not present on the other
   until it graduates. Diff the file across branches before anything else.
2. The functions were changed but never actually deployed (see §8: a
   deploy pipeline can fail silently for reasons unrelated to your
   change).
3. For consumer-specific origins (your app's own origin, not the widget's):
   those are validated at runtime from the platform record, not the static
   list. Check the `cors_origin` value registered for your platform.

## 4. Symptom: every transaction has `block_height: 0`, or history sorts wrongly

**Probe:**

```bash
curl -s -i 'https://<block-source>/tip' | grep -i access-control-expose
```

**Healthy:** `access-control-expose-headers: X-Block-Hash, X-Block-Height`.

**Why it matters:** browsers hide non-safelisted response headers from
cross-origin JavaScript unless the server explicitly exposes them.
`response.headers.get('X-Block-Height')` returns `null` in that case, with
no error anywhere, and a naive fallback turns that into `0`.

**Current state of the code:** the widget no longer trusts this header
for transaction heights; it uses the height from the filter match, which
it knows first-hand. If you still see zero heights, you are running a
stale widget bundle (see §7).

## 5. Symptom: the sync downloads tens of thousands of filters every time

A sync's scan window is `max(birthday_height, last_block_scanned + 1)`
to tip.

- **First sync**: scanning from the wallet birthday is correct and can
  legitimately be tens of thousands of filters for an old wallet. The
  filter files are small; this is minutes, not hours.
- **Every subsequent sync should be nearly instant.** The widget persists
  `last_block_scanned` via `or-stealth-envelope-update` at the end of
  every successful sync. If re-syncs keep rescanning from birthday:

**Probe** (requires your platform API key; run server-side, never in a
browser):

```bash
curl -s -X POST \
  'https://<project-ref>.supabase.co/functions/v1/or-stealth-envelope-fetch' \
  -H 'Content-Type: application/json' \
  -H 'X-Platform-API-Key: <your-key>' \
  -d '{"connection_id":"<uuid>","app_user_id":"<id>"}' \
  | python3 -m json.tool | grep -E 'last_block_scanned|wallet_birthday'
```

If `last_block_scanned` is `null` after a completed sync, the cursor
write is failing. The write is **not** best-effort: every failure path
throws `[stealth/sync] cursor update failed ...`, the widget shows the
"Sync failed" screen, an `INTERNAL` widget error is posted to the opener,
and `OR_STEALTH_SYNC_COMPLETE` is never sent. It fails loudly on purpose:
a silently NULL cursor makes every future sync rescan from the wallet
birthday. If you are behind a proxy, read section 9b first.

**Resume rules, so you do not fight them:**

- The cursor only moves **forward** through `or-stealth-envelope-update`.
- Two things decide where a sync starts, not one: the recorded scan
  coverage (`stealth_scan_ranges`) and the legacy cursor
  (`last_block_scanned`). **Coverage wins.** The single rule is
  `scanStartHeight()` in `src/stealth/lib/ranges.ts`; when a recorded
  range covers the wallet birthday, the cursor is never consulted.
- Replacing the envelope **clears both**, which is the only way a user
  triggers a full rescan: either re-adding the wallet, or changing the
  wallet birthday (a birthday change is itself an envelope replacement).
  Clearing the cursor alone is **not** enough for a connection that has
  coverage: it changes a stored number and the scan starts in exactly
  the same place. If you are clearing state by hand to force a rescan,
  clear the coverage rows too or nothing will happen.

## 6. Symptom: user changed the wallet birthday but the sync ignores it

The authoritative birthday lives **inside the sealed envelope**, next
to the wallet key material only the user's browser can open. The server
also keeps a plaintext copy of just the date (`wallet_birthday_plaintext`)
as scan metadata; that is a deliberate, documented trade-off in the
privacy model (a date alone reveals nothing about addresses, balances,
or history), and it is what makes the probe below possible. Changing the
birthday means re-sealing and re-submitting the envelope through
`or-stealth-connection-create`, which detects the re-add of the same
wallet (by blind index), replaces the stored envelope, and clears both
halves of the resume state: the sync cursor and the recorded scan
coverage.

If a re-added wallet still syncs with the old birthday, probe the
envelope the server actually has (same envelope-fetch call as §5) and
check `wallet_birthday_plaintext`. If it shows the OLD date, the replace
never landed: you are running edge functions from before the re-add fix,
or the create call failed and the UI swallowed it.

If the date is the NEW one and the sync still starts high, check the
coverage rows for that connection. A range that covers the new birthday
pins the start height regardless of the cursor, so a replacement that
left coverage behind produces exactly this symptom: no rescan, no error.
Edge functions from before that fix cleared the cursor only.

## 7. Symptom: "we deployed the fix but behavior did not change"

The single most common integration trap. Two separate mechanisms cause it:

**a. The widget bundle is stale.** The deployed page can be new while a
lazy-loaded chunk is old, or the whole deployment can be a replay. Verify
by content, not by deploy status:

```bash
# find the entry chunk
curl -s https://connect.orangerails.com/ | grep -o 'assets/index-[^"]*\.js'
# then grep the actual deployed code for the string your fix introduced
curl -s https://connect.orangerails.com/assets/<chunk>.js | grep -c '<distinctive-string-from-your-fix>'
```

Do this for EVERY lazy chunk your change touches, not just the entry
chunk: list them with
`curl -s .../assets/index-<hash>.js | grep -o 'assets/[A-Za-z0-9_-]*\.js' | sort -u`.

**b. A hosting-platform "retry" can replay a stale snapshot.** On
Cloudflare Pages we have observed that retrying a failed deployment
reuses the environment snapshot taken when that deployment was first
created, so config/env changes made since are not picked up. Always
trigger a genuinely new deployment after changing environment values.

## 8. Symptom: edge-function changes never reach production

Check the deploy pipeline before debugging your change. The Supabase CLI
bundles every function on every deploy; **one function that fails to
parse fails the whole deploy**, including functions you never touched.

Local pre-check that mirrors the bundler (requires Bun):

```bash
cat > /tmp/parse_sweep.ts <<'EOF'
const t = new Bun.Transpiler({ loader: "ts" });
const glob = new Bun.Glob("supabase/functions/**/*.ts");
let bad = 0;
for await (const f of glob.scan(".")) {
  try { t.transformSync(await Bun.file(f).text()); }
  catch (e) { bad++; console.log(`PARSE FAIL: ${f}`); }
}
console.log(bad === 0 ? "ALL FILES PARSE" : `${bad} file(s) fail`);
EOF
bun /tmp/parse_sweep.ts
```

Run this after ANY bulk edit across the functions tree. Automated text
sweeps (codemods, find-and-replace tooling) can corrupt import blocks or
unbalance wrapper parentheses, and the failure mode is exactly the silent
one this section describes: a file that does not parse fails every
subsequent deploy, and a fix that "shipped" never actually ran.

## 9. Symptom: the widget hangs at "Syncing..." before any progress

Distinguish these three cases by the console:

1. **No `OR_STEALTH_INIT` received** (widget console logs it waits for
   INIT): the opener-side INIT/READY handshake broke. See §2. Check the
   opener's console for a wrong-origin warning: a `postMessage` to the
   wrong target origin is silently dropped by design.
2. **INIT received, envelope fetch never resolves**: proxy configuration.
   If the consuming app proxies edge calls (`proxy_base_url`), confirm
   the proxy allowlists the function names the widget calls, including
   `or-stealth-envelope-update` (newer widget builds call it after every
   sync).
3. **Progress starts, then stalls at filter download**: check the filter
   CDN is serving (`curl -s -o /dev/null -w '%{http_code}' <filter-base>/<height>.json`),
   and remember the first sync of an old wallet legitimately downloads a
   lot of filters (§5).

## 9b. The cursor write fell back past your proxy

When the widget runs with `proxy_base_url`, the end-of-sync cursor write
goes through your `OR_STEALTH_PROXY_REQUEST` handler like every other
call. A handler set up before `or-stealth-envelope-update` existed will
not recognise the message and will never answer it, so that request is
capped at 15 seconds rather than the normal two-minute timeout: the
cursor write is a single lightweight row update, and failing fast leaves
room to try a second path.

That second path is a direct call to `or-stealth-envelope-update`,
authenticated with the signed-in user's JWT (the edge function accepts
user-JWT auth as well as the platform key). It runs only when a user
token is present, and it announces itself once on the console:

    [stealth/sync] proxy cursor write failed (...); falling back to a
    direct user-JWT call to or-stealth-envelope-update. This bypasses
    your OR_STEALTH_PROXY_REQUEST handler.

If you see that line, sync is working but your proxy is not carrying
this function. Add `or-stealth-envelope-update` to the handler's
allowlist and the warning stops. If both paths fail, the thrown error
carries both causes: the proxy error and the fallback status or network
error, in one message.

**What the fallback means for your users' IP addresses.** On the proxy
path the request is made by your backend, so the end user's IP address
never reaches an Orange Rails host. On the fallback path the browser
calls `or-stealth-envelope-update` directly, so the end user's IP does
reach the Orange Rails host and may appear in Supabase Edge Function
request logs. The request body carries only the connection id, the app
user id and the block height: no wallet, address, or transaction data.
If you do not want end user IPs reaching Orange Rails at all, add
`or-stealth-envelope-update` to your `OR_STEALTH_PROXY_REQUEST` handler
allowlist, which keeps every call on the proxy path and stops the
fallback from ever firing.

## 10. Mock mode: reproduce without a real wallet

Append `?mock=1` to the widget URL to run the sync loop against built-in
fixtures: fixed tip, tiny filter set, a matcher that never matches. No
network calls to filter/block sources. Useful for testing the message
flow and progress UI in isolation; useless for testing matching or
heights (the fixtures produce zero transactions by design).

## 11. Context pack for AI agents

If you are an AI agent debugging an integration, load these files first;
they are the load-bearing ones:

- `src/stealth/lib/sync.ts`: the orchestrator. Scan window, filter
  fetch concurrency, matching, block parsing, spend detection, sealing.
- `src/stealth/widget/routes/sync.tsx`: the widget's sync page. INIT
  handling, envelope fetch, upload, cursor write, SYNC_COMPLETE.
- `src/stealth/lib/postmessage.ts`: every message type and field in the
  opener/popup protocol.
- `supabase/functions/_shared/http.ts`: the CORS allowlist.
- `supabase/functions/_shared/platform-auth.ts`: how callers
  authenticate and how the platform identity is derived server-side.
- `supabase/functions/or-stealth-*/index.ts`: the five storage
  functions. Every read/write is pinned to the calling platform.
- `docs/Stealth-Sync.md`: the architecture and privacy model.
- `docs/Consumer-Integration-Guide.md`: the step-by-step integration.

And hold these invariants when proposing fixes:

1. **Plaintext wallet keys never touch the server.** The xpub lives in a
   sealed envelope only the user's browser can open. Any fix that sends
   an xpub, address list, or match result to a server in plaintext is
   wrong, whatever else it fixes.
2. **Every stealth read/write is pinned to the calling platform**, whose
   identity is derived server-side from the API key hash. Never trust a
   caller-supplied `connection_id` or `app_user_id` alone.
3. **Heights come from the filter match**, not from response headers.
4. **The cursor moves forward; only envelope replacement resets it.**
5. **Verify deployed behavior with a probe before and after the fix.**
   A green deploy is a claim, not a fact.
