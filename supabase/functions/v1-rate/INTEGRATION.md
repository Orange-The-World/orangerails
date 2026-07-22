# ORBI v1-rate Integration Guide

## Endpoint

`POST /functions/v1/v1-rate`
`GET  /functions/v1/v1-rate?asset=BTC&fiat=USD&at=<ISO-8601 UTC>&product=ORBI-M`

Requires `ORBI_RATE_API_ENABLED=true` in function environment (feature flag). Returns 503 when disabled or when the value is anything other than `"true"`.

---

## Authentication

Pass the API key in the `Authorization` header:

```
Authorization: Bearer orbi_sk_<random>
```

Or as `x-api-key: orbi_sk_<random>`.

The function hashes the raw key with SHA-256 and looks it up in `orbi_api_keys.key_hash`. A revoked or unknown key returns 401. A database failure during lookup returns 500.

---

## Key format and minting rules

Keys follow the format `orbi_sk_<random>` where `<random>` is a cryptographically random string.

**Critical: key_prefix must be 16 chars minimum.**

When minting a key and writing a row to `orbi_api_keys`:

| Column | Value |
|---|---|
| `key_hash` | SHA-256 hex of the full raw key |
| `key_prefix` | First **16** chars of the raw key (e.g. `orbi_sk_A1B2C3D4`) |
| `consumer_id` | UUID of the consumer |
| `revoked_at` | NULL (set on revocation) |

The first 8 chars are always `orbi_sk_` (fixed prefix). Chars 9-16 are the start of the random segment and are unique per key. **A key_prefix of only 8 chars (`orbi_sk_`) is the same for every key** and defeats per-consumer rate limiting. Use 16 chars minimum.

Example mint (pseudocode):

```ts
const raw = 'orbi_sk_' + randomHex(32)       // e.g. orbi_sk_a1b2c3d4e5f6...
const keyHash = sha256hex(raw)
const keyPrefix = raw.slice(0, 16)            // 'orbi_sk_a1b2c3d4' -- unique per key
await db.from('orbi_api_keys').insert({ key_hash: keyHash, key_prefix: keyPrefix, consumer_id })
```

---

## Rate limiting

- **60 requests per minute per consumer** (configurable via `RATE_LIMIT_RPM` env var)
- Sliding window, in-memory (resets on function cold start)
- Bucket key: `consumer_id` from `orbi_api_keys` -- unique per consumer, format-independent
- Returns 429 with `Retry-After` header (seconds) when exceeded

---

## Request format

### GET (single lookup)

```
GET /functions/v1/v1-rate?asset=BTC&fiat=USD&at=2026-07-01T12:00:00Z&product=ORBI-M
```

Parameters: `asset` (required), `fiat` (required), `at` (required, ISO-8601 UTC with `Z` suffix), `product` (optional, default `ORBI-M`).

### POST (batch, up to 50 items)

```json
[
  { "asset": "BTC", "fiat": "USD", "at": "2026-07-01T12:00:00Z", "product": "ORBI-M" },
  { "asset": "ETH", "fiat": "USD", "at": "2026-07-01T12:00:00Z" }
]
```

A single-item object (not array) is also accepted.

**Timestamp format:** `at` must be ISO-8601 UTC with a `Z` suffix (e.g. `2026-07-01T12:00:00Z`). Bare dates (`2026-07-01`) and offset timestamps (`2026-07-01T12:00:00+05:00`) return 400.

---

## Products

| Product | Granularity | Assets |
|---|---|---|
| `ORBI-M` | 1-minute bars | BTC, USDC, USDT, DAI, EURC, PYUSD |
| `ORBI-D` | 1-day bars | BTC, USD, EURC |
| `ORBI-D-authority` | 1-day central-bank | USD, EUR, GBP, AUD |

---

## Response

Single item:

```json
{
  "asset": "BTC",
  "fiat": "USD",
  "product": "ORBI-M",
  "requested_at": "2026-07-01T12:00:00Z",
  "resolved_at": "2026-07-01T12:00:00.000Z",
  "rate": "67432.15",
  "provenance": "...",
  "tier": "...",
  "source_authority": "ORBI",
  "fill_type": "exact"
}
```

`fill_type` values: `exact` (data at requested timestamp), `forward_fill` (most recent prior bar), `gap` (no data found, `rate` is null).

Batch response wraps in `{ results: [...], count: N }`.

---

## Error codes

| HTTP | code | Meaning |
|---|---|---|
| 401 | `missing_key` | No Authorization header |
| 401 | `invalid_key` | Key not found or revoked |
| 400 | `bad_params` | Missing required parameters |
| 400 | `bad_json` | Malformed JSON or non-object body/item |
| 400 | `bad_timestamp` | `at` is not ISO-8601 UTC with Z suffix |
| 400 | `bad_product` | Unknown product name |
| 400 | `batch_too_large` | More than 50 items in POST body |
| 400 | `empty_batch` | Empty array in POST body |
| 405 | `method_not_allowed` | Only GET and POST accepted |
| 429 | `rate_limited` | Per-consumer RPM limit exceeded; see Retry-After |
| 500 | `server_error` | Database error (key lookup or rate query) |
| 503 | `not_enabled` | Feature flag off or not set to "true" |
