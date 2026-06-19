# CHANGELOG

Reverse-chronological log of major changes to Orange Rails , anything that touches the API contract, the deploy surface, or the consumer-app integration shape.

Per-session work continues to be logged in the per-workstream wiki Changelogs (`Apps/🚂 Orange Rails/...` in the maintainer wiki). This file is the integrator-facing record.

---

## 2026-06-16

- `api.orangerails.com` is now the canonical entry point. Cloudflare Worker (`workers/api-gateway/`) proxies clean versioned paths (`/v1/...`) plus a legacy `/functions/v1/...` pass-through to the live OR Supabase project. V2 BitBooks, V3 Vault, Orange Way Manager, Orange Way Books all migrated to this URL today.
- V2 BitBooks platform API key rotated. Old hash retired. Stored in Proton Pass on the OR side.
- `sync-blink` Supabase function inlined the Blink GraphQL adapter. bb-support's Express adapter retired; `api.orangerails.com/sync/blink` proxy path removed from the Worker.
- `or-providers` response now carries `s-maxage=600` + `stale-while-revalidate=60` so the CF Edge / Worker caches the catalog across all consumers.
- `connect.orangerails.com` (Stealth Sync widget host), `blocks.orangerails.com` (BIP158 block source), `stealth.orangerails.com` (filter CDN) all wired through Caddy on bb-support and reachable end-to-end.
- DNS for `orangerails.com` migrated from Porkbun to Cloudflare to unblock Workers Custom Domains.
- Full-review audit completed (maintainer-only audit). 0 critical, 4 high, 11 medium, 7 low. High findings H1 + H2 (agent key wrap), H3 + M6 (RLS path indexes), M1 + M2 (error-leak cleanup) shipped to dev same day.

## 2026-06-04 , 2026-06-15

- Quiltt PROD popup pattern reworked; widget tokens now atomically claimed (PR #229 security hardening).
- Per-platform Quiltt config landed (each app holds its own Quiltt keys in `platforms`).
- OPK rotation guard, fragment scrub, response byte cap, history hardening shipped (PR #229).
- V2 staging dead-Supabase-URL bug surfaced and fully tracked through the gateway migration.

## 2026-05-21

- V2 BitBooks platform key rotation pipeline established (first carrier-over for V3 and Orange Way).

## 2026-05-13

- Registered bitbooks-v3 (V3 Vault) + orangeway (Orange Way Manager / Books) platforms on OR.

## 2026-05-09

- bb-support Express server cut from the OR customer path. Blink GraphQL adapter inlined into the `sync-blink` Supabase function.

## 2026-05-07

- `api.orangerails.com` flipped from a single-region Express server to a Cloudflare Worker. The hostname stayed; the upstream changed.

---

For session-by-session work, see the wiki Changelog under `Apps/🚂 Orange Rails/api.orangerails.com , Canonical Gateway/Changelog` in the maintainer wiki.
