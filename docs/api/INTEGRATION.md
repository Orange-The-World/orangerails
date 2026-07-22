# ORBI Rate API v1 -- Integration Guide

## Quick start

```bash
# Single lookup (GET)
curl -H "Authorization: Bearer $ORBI_API_KEY" \
  "https://<project-ref>.supabase.co/functions/v1/v1-rate?asset=BTC&fiat=USD&at=2024-03-15T14:32:00Z"

# Batch lookup (POST, up to 50 items)
curl -X POST \
  -H "Authorization: Bearer $ORBI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"asset":"BTC","fiat":"USD","at":"2024-03-15T14:32:00Z"},{"asset":"BTC","fiat":"USD","at":"2024-03-16T09:00:00Z"}]' \
  "https://<project-ref>.supabase.co/functions/v1/v1-rate"
```

## Response shape

```json
{
  "asset": "BTC",
  "fiat": "USD",
  "product": "ORBI-M",
  "requested_at": "2024-03-15T14:32:00Z",
  "resolved_at": "2024-03-15T14:32:00Z",
  "rate": 68432.17,
  "provenance": "coinbase",
  "tier": "1",
  "source_authority": "ORBI",
  "fill_type": "exact"
}
```

**fill_type values:**

* `exact`: a rate exists at this exact UTC minute (or day for ORBI-D products).
* `forward_fill`: no rate at this minute; the prior available minute was used. `resolved_at` shows which minute.
* `gap`: no rate data exists before this timestamp for this pair. `rate` is null. **Do not treat null as zero.**

## Product parameter

The `product` field selects which ORBI dataset to query. It defaults to `ORBI-M`. Each request item may specify a different product.

| Product | Granularity | Covered pairs | Notes |
|---------|-------------|---------------|-------|
| `ORBI-M` (default) | 1 minute | BTC, USDC, USDT, DAI, EURC, PYUSD vs any fiat | Highest resolution; use for minute-level crypto rates |
| `ORBI-D` | 1 day | BTC, USD, EURC | Daily bars; use for end-of-day prices |
| `ORBI-D-authority` | 1 day | USD, EUR, GBP, AUD (fiat vs fiat) | Central-bank derived fiat pairs |

**Choosing the wrong product returns `fill_type: gap`.** A fiat pair like EUR/USD queried with `ORBI-M` (the default) returns no data because ORBI-M only covers crypto. Use `ORBI-D-authority` for fiat-to-fiat lookups.

GET example with explicit product:

```bash
curl -H "Authorization: Bearer $ORBI_API_KEY" \
  "https://<project-ref>.supabase.co/functions/v1/v1-rate?asset=EUR&fiat=USD&at=2024-03-15T00:00:00Z&product=ORBI-D-authority"
```

POST example mixing products in one batch:

```json
[
  {"asset":"BTC","fiat":"USD","at":"2024-03-15T14:32:00Z","product":"ORBI-M"},
  {"asset":"EUR","fiat":"USD","at":"2024-03-15T00:00:00Z","product":"ORBI-D-authority"}
]
```

## Data currency note

As of 2026-07-22, the ORBI feed is approximately 4 days behind real time (latest confirmed bucket: 2026-07-18 03:14 UTC). A "latest rate" call for today will resolve to a row from several days ago with `fill_type: forward_fill`. This is a known data-lag issue tracked separately from this API. Callers should check `resolved_at` and flag any result where the gap between `requested_at` and `resolved_at` exceeds their tolerance.

## Auth

Header: `Authorization: Bearer <key>` or `x-api-key: <key>`. One key per consumer. Keys are minted by @DBA (see below).

## Rate limits

60 requests/minute **per consumer** (the rate-limit bucket is `consumer_id`, not the key string or key prefix). If one consumer holds multiple keys, all keys share one bucket. Exceeded: HTTP 429 + `Retry-After: N` header (seconds until reset). Use POST batch for bulk lookups.

## Batch limit

50 items per POST. Split larger batches client-side.

## Error reference

| HTTP | error code | Meaning |
|------|------------|---------|
| 400  | bad_params | Missing or invalid asset/fiat/at |
| 400  | bad_timestamp | at is not a valid ISO-8601 UTC timestamp |
| 400  | bad_product | product is not one of: ORBI-M, ORBI-D, ORBI-D-authority |
| 400  | batch_too_large | Batch exceeds 50 items |
| 400  | empty_batch | Empty array |
| 401  | missing_key | No Authorization header |
| 401  | invalid_key | Key not found or revoked |
| 429  | rate_limited | Too many requests; see Retry-After |
| 5xx  | server_error | Internal error; safe to retry |

## Coverage (ORBI-M, as of 2026-07-22)

| Pair | Status | Notes |
|------|--------|-------|
| BTC/USD | Green (100%) | Minute-level back to 2010 |
| BTC/EUR | Green (100%) | Minute-level back to ~2012 |
| BTC/MXN | Yellow (86%) | Via Bitso; gaps pre-2015 |
| BTC/GBP | Yellow (63%) | Gaps in early years |
| BTC/CAD | Yellow (32%) | Sparse pre-2016 |
| BTC/CHF | Yellow (28%) | Sparse |
| BTC/AUD | Yellow (21%) | Sparse |
| BTC/JPY | Red (4.5%) | Mostly gaps; expect fill_type=gap |
| BTC/BRL | Red (1.6%) | Mostly gaps |
| BTC/INR | Red (1.5%) | Mostly gaps |

Red-tier pairs will return `fill_type: gap` for most historical timestamps. Always check `fill_type` before using the rate.

## Testing note

The `exchange_rates` table exists on the ORBI production Supabase project only. There is no dev replica. Integration tests must target the prod project. Unit tests should mock the Supabase client.

## Minting a new API key (@DBA only)

```bash
# 1. Generate key
python3 -c "import secrets; k='orbi_sk_' + secrets.token_hex(32); print(k)"

# 2. Hash it (SHA-256)
python3 -c "import hashlib, sys; k=sys.argv[1]; print(hashlib.sha256(k.encode()).hexdigest())" "orbi_sk_<hex>"

# 3. Insert (DBA applies to orbi-prod)
#    key_prefix = first 16 chars of the generated key (e.g. "orbi_sk_ab3x9k2p")
#    These 16 chars are unique per minted key (8-char fixed prefix + 8 random chars).
INSERT INTO orbi_api_keys (consumer_id, consumer_name, key_hash, key_prefix, created_by)
VALUES ('bitbooks', 'BitBooks V2', '<sha256_hex>', 'orbi_sk_ab3x9k2p', 'dba');

# 4. Share ONLY the raw key with the consumer. Never the hash.
```

## Querying usage (SQL)

```sql
-- Requests by consumer by day
SELECT consumer_id, DATE_TRUNC('day', served_at) AS day, COUNT(*)
FROM orbi_usage_log
GROUP BY 1, 2
ORDER BY 2 DESC, 1;
```
