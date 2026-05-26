# on-demand-resolve — Edge Function

ORBI's on-demand rate resolver. Any consuming app (V3, OWM, OWB, future
Tier-3 partner) can request a CONFIRMED ORBI-M rate for ANY minute. If
the rate already exists in `exchange_rates`, it returns immediately.
If not, the function runs the resolve orchestrator, stores the result
with `provenance='on-demand-resolve'`, and returns it.

This is what lets us stop forward-filling every minute of every pair
forever. Forward-fill keeps "right now" warm; on-demand fills any
historical minute a client cares about, lazily.

## How it works

```
client (V3 / OWM / OWB)
   │  POST /functions/v1/on-demand-resolve
   │  body: { source, target, effectiveAt }
   │  apikey: <OR PROD anon key>
   ▼
[Edge Function]
   │
   ├─ rate-limit gate (30/min/ip)
   ├─ validate params
   ├─ SELECT exchange_rates WHERE ... CONFIRMED ─→ HIT  ─→ return (computedOnDemand=false)
   │                                              MISS
   ├─ pick path:
   │    direct  → resolve()         (BTC-USD, EUR, GBP, CAD, AUD, JPY, CHF, MXN, BRL, ARS)
   │    composite → resolveComposite() (BTC-INR, TRY, ZAR via Frankfurter)
   ├─ INSERT exchange_rates (provenance='on-demand-resolve')
   ├─ INSERT exchange_rate_resolutions (audit row)
   └─ return (computedOnDemand=true)
```

The function uses `SUPABASE_SERVICE_ROLE_KEY` for writes (RLS would block
anon-key writes). The function endpoint itself is invokable with the OR
PROD anon key — standard Supabase Edge Function pattern.

## Request

`POST` (or `GET` with querystring) to `https://<project-ref>.supabase.co/functions/v1/on-demand-resolve`

Headers:
- `apikey: <OR PROD anon key>`
- `Content-Type: application/json` (POST only)

Body / querystring:
- `source` — must be `BTC` (only BTC is supported today)
- `target` — 3-letter ISO code (USD, EUR, GBP, CAD, AUD, JPY, CHF, MXN, BRL, ARS, INR, TRY, ZAR)
- `effectiveAt` — ISO timestamp (must be at least 1 minute in the past)

## Response

```json
{
  "rate": 67000.50,
  "rateId": "uuid-...",
  "bucketTs": "2026-03-14T14:34:00.000Z",
  "bucketGranularity": "M",
  "provider": "orbi (tier A, 4 sources)",
  "sourceKind": "CRYPTO_FIAT",
  "pending": false,
  "stale": false,
  "computedOnDemand": true
}
```

`computedOnDemand` flips to `false` on subsequent requests for the same
minute (cache hit).

Error codes:
- `400` — validation failure (missing field, bad timestamp, future timestamp)
- `404` — target currency has no direct sources and isn't composite-eligible
- `405` — method other than GET/POST/OPTIONS
- `429` — per-IP rate limit (30/min)
- `500` — cache lookup failed (database / RLS issue)
- `502` — resolve pipeline failed (all upstream sources down)

## Latency

- Cache hit: ~50-150ms (single indexed SELECT)
- Cache miss (direct pair): ~500-800ms (fan-out to 4-7 exchanges, then write)
- Cache miss (composite): ~600-1000ms (BTC/USD resolve + Frankfurter call + write)

## Client usage

Use `getOrResolveRate()` in `orbi/src/client/rates.ts`:

```ts
import { getOrResolveRate } from '@orange-rails/rates-client';

const rate = await getOrResolveRate(
  'BTC',
  'USD',
  new Date('2025-08-12T16:42:31Z'),
);
// rate.computedOnDemand tells you whether you just paid the cache-miss cost.
```

## Deploy

```bash
cd /home/ubuntu/AIHUB/REPOS/orangerails
supabase functions deploy on-demand-resolve \
  --project-ref <ORANGERAILS_PROD_REF> \
  --no-verify-jwt
```

The `--no-verify-jwt` flag is required because we want browser callers
authenticating with the anon key (not a user JWT). RLS still enforces
that the function can only write via the service role.

Required Supabase Functions secrets (set in the Supabase dashboard, Functions → Settings):

| Name                        | Value                                    |
|-----------------------------|------------------------------------------|
| `SUPABASE_URL`              | OR PROD URL (auto-provided by Supabase)  |
| `SUPABASE_SERVICE_ROLE_KEY` | OR PROD service role key (auto-provided) |

Supabase auto-injects these two into Edge Functions, so no manual setup
is required. The function will fail with a clear error if either is
missing.

## Rollback

```sql
-- All on-demand rates are tagged
DELETE FROM exchange_rates WHERE provenance = 'on-demand-resolve';
-- Audit rows cascade via the rate_id FK if it's CASCADE; otherwise:
DELETE FROM exchange_rate_resolutions
 WHERE rate_id IN (SELECT id FROM exchange_rates WHERE provenance = 'on-demand-resolve');
```

To disable the function entirely without rolling back data:

```bash
supabase functions delete on-demand-resolve --project-ref <ref>
```

## Tests

```bash
cd orbi/edge-functions/on-demand-resolve
deno test --allow-net --allow-env tests/
```

Tests use a mocked Supabase client and mocked resolve functions — no
network or DB needed. CI should run these on every PR that touches
`orbi/edge-functions/` or `orbi/src/calculate/`.

## Smoke test (against deployed PROD function)

```bash
cd /home/ubuntu/AIHUB/REPOS/orangerails/orbi
bun run scripts/test-edge-function.ts
```

The script:
1. Calls with a known minute (cache hit) — asserts `computedOnDemand=false`.
2. Calls with a random old minute (cache miss) — asserts `computedOnDemand=true`.
3. Calls again with the same old minute — asserts `computedOnDemand=false` (now cached).

## Migration dependency

This function writes `provenance='on-demand-resolve'`. The
`exchange_rates_provenance_check` constraint must allow that value.
Apply `orbi/schema/007_extend_provenance_check.sql` before deploying.
