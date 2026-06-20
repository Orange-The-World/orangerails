# api.orangerails.com — Canonical API Gateway

Single canonical entry point for every external client of Orange Rails.

**Wiki:** `Apps/🚂 Orange Rails/api.orangerails.com — Canonical Gateway/Proposal`

## Routing

| Public path | Forwards to | Notes |
|-------------|-------------|-------|
| `/v1/*` | OR Supabase edge functions, per `V1_ROUTES` map in `src/index.ts` | New canonical client surface |
| `/functions/*` | OR Supabase, transparent passthrough | Migration courtesy; dropped after sunset |
| `/sync/blink` | maintainer infrastructure Express adapter via Cloudflare Tunnel | OR-internal, used by `sync-blink` edge function |
| `/health` | Served locally by the Worker | Liveness only |
| anything else | 404 | Closed by default |

Headers pass through unchanged except `host` and `cf-*` (stripped).

## Environments

- **staging** → `api-staging.orangerails.com`, upstream = OR DEV Supabase
- **production** → `api.orangerails.com`, upstream = OR PROD Supabase

## Deploy

CI deploys via the existing `.github/workflows/pages-deploy.yml` workflow extension. Local deploy from this directory:

```sh
bun install
bunx wrangler deploy --env staging      # or --env production
```

## Tests

```sh
bun test
```

Tests cover route map, header hygiene, legacy passthrough, sync/blink, preflight, and unknown route 404s. Tests do not hit Supabase — `fetch` is stubbed.

## Adding a new public route

1. Add a row to `V1_ROUTES` in `src/index.ts`
2. Add a test in `test/router.test.ts`
3. Update the Proposal doc on the wiki if the API surface is changing meaningfully
