# Mock Surge Partner API

Stands in for `api.testnet.surge.credit` while we build the Orange Rails Surge connector. Implements every documented endpoint with realistic fixtures plus the documented error codes.

Spec: https://wiki.abascal.ca/doc/surge-Od9bf1GgpE

## Run standalone

```bash
cd server
node mocks/surge-mock.js
# → http://localhost:3099/api/v1
```

Override port with `SURGE_MOCK_PORT=4000`. Override the seeded owner with `TEST_OWNER=0x...`.

## Point the real adapter at it

```bash
SURGE_API_BASE=http://localhost:3099/api/v1 node server/server.js
```

## Token shortcuts

The mock skips EIP-191 verification. Use these literal token strings to exercise auth paths:

| Token             | Result                                              |
| ----------------- | --------------------------------------------------- |
| `mock_good`       | 200, owner = seeded `TEST_OWNER`                    |
| `mock_revoked`    | 401 `auth_token_revoked`                            |
| `mock_wrong_owner`| 403 `auth_owner_mismatch` (token owner = 0x000...0) |
| anything else     | 401 `auth_token_malformed`                          |

## Curl examples

```bash
BASE=http://localhost:3099/api/v1
OWNER=0xf3fE9fa2F90D18937A5f0c824BAfB612f215FB1c

curl $BASE/health
curl -H "Authorization: Bearer mock_good" $BASE/partner/me
curl -H "Authorization: Bearer mock_good" $BASE/owners/$OWNER/positions
curl -H "Authorization: Bearer mock_good" $BASE/owners/$OWNER/summary
curl -H "Authorization: Bearer mock_good" $BASE/owners/$OWNER/accounting-state
curl -H "Authorization: Bearer mock_good" "$BASE/owners/$OWNER/events?limit=10"
```

## Fixtures

- `fixtures/surge-positions.json` — one active position (0.005 BTC pledged, 2,000 USDC borrowed, 5.97% APR, LTV 40%) and one closed position
- `fixtures/surge-summary.json` — aggregate matching the positions file
- `fixtures/surge-accounting-state.json` — same data reshaped into `pledged_btc` + `line_of_credit` buckets
- `fixtures/surge-events.json` — five events spanning loan_opened, collateral_added, borrowed, repaid, collateral_withdrawn

When Surge provides the real sandbox owner + token, replace these JSON files with `curl` output from the live testnet and the connector code does not have to change.
