# ORBI Rate API v1 — Integration Guide

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
  "requested_at": "2024-03-15T14:32:00Z",
  "resolved_at": "2024-03-15T14:32:00Z",
  "rate": 68432.17,
  "provenance": "coinbase",
  "tier": "1",
  "source_authority": "coinbase",
  "fill_type": "exact"
}
```

**fill_type values:**

* `exact`: a rate exists at this exact UTC minute.
* `forward_fill`: no rate at this minute; the prior available minute was used. `resolved_at` shows which minute.
* `gap`: no rate data exists before this timestamp for this pair. `rate` is null. **Do not treat null as zero.**

## Auth

Header: `Authorization: Bearer <key>` or `x-api-key: <key>`. One key per consumer. Keys are minted by @DBA (see below).

## Rate limits

60 requests/minute per key. Exceeded: HTTP 429 + `Retry-After: N` header (seconds until reset). Use POST batch for bulk lookups.

## Batch limit

50 items per POST. Split larger batches client-side.

## Error reference

| HTTP | error code | Meaning |
|------|------------|---------|
| 400  | bad_params | Missing or invalid asset/fiat/at |
| 400  | bad_timestamp | at is not a valid ISO-8601 UTC timestamp |
| 400  | batch_too_large | Batch exceeds 50 items |
| 400  | empty_batch | Empty array |
| 401  | missing_key | No Authorization header |
| 401  | invalid_key | Key not found or revoked |
| 429  | rate_limited | Too many requests; see Retry-After |
| 5xx  | server_error | Internal error; safe to retry |

## Coverage (as of 2026-07-22)

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

## Minting a new API key (@DBA only)

```bash
# 1. Generate key
python3 -c "import secrets; k='orbi_sk_' + secrets.token_hex(32); print(k)"

# 2. Hash it (SHA-256)
python3 -c "import hashlib, sys; k=sys.argv[1]; print(hashlib.sha256(k.encode()).hexdigest())" "orbi_sk_<hex>"

# 3. Insert (DBA applies to orbi-prod)
INSERT INTO orbi_api_keys (consumer_id, consumer_name, key_hash, key_prefix, created_by)
VALUES ('bitbooks', 'BitBooks V2', '<sha256_hex>', '<first8chars>', 'dba');

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
