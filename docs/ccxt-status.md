# CCXT exchange support matrix

**Generated:** 2026-08-08 from `ccxt@4.5.55` introspection.

**Total wired:** 94 exchanges using OR's standard CCXT adapter.

**Skipped:** 17 exchanges using credential shapes that need adapter changes (privateKey+walletAddress for DEX wrappers, accountId+apiKey+secret, apiKey-only sandboxes). Tracked as a Sprint 2 follow-up.

Regenerate with: `node scripts/generate-ccxt-manifest.mjs`

## What the matrix means

Three CCXT capabilities matter to OR sync:

* **trades** — `fetchMyTrades` available, OR can pull buy/sell history
* **deposits** — `fetchDeposits` available, OR can pull funding events
* **withdrawals** — `fetchWithdrawals` available, OR can pull payouts

If `trades` is false for an exchange, sync surfaces zero transactions until CCXT adds it upstream. That's a CCXT limitation, not OR.

## Matrix

| Exchange | Slug | Countries | Trades | Deposits | Withdrawals | Cred shape |
|----------|------|-----------|--------|----------|-------------|------------|
| Coinbase Advanced | `coinbase` | US | ✅ | ✅ | ✅ | apiKey+secret |
| Binance | `binance` | — | ✅ | ✅ | ✅ | apiKey+secret |
| Kraken | `kraken` | US | ✅ | ✅ | ✅ | apiKey+secret |
| Bybit | `bybit` | VG | ✅ | ✅ | ✅ | apiKey+secret |
| OKX | `okx` | CN, US | ✅ | ✅ | ✅ | apiKey+password+secret |
| Gemini | `gemini` | US | ✅ | ❌ | ❌ | apiKey+secret |
| KuCoin | `kucoin` | SC | ✅ | ✅ | ✅ | apiKey+password+secret |
| Crypto.com | `cryptocom` | MT | ✅ | ✅ | ✅ | apiKey+secret |
| Bitstamp | `bitstamp` | GB | ✅ | ❌ | ✅ | apiKey+secret |
| Bitfinex | `bitfinex` | VG | ✅ | ❌ | ❌ | apiKey+secret |
| Bitget | `bitget` | SG | ✅ | ✅ | ✅ | apiKey+password+secret |
| Gate | `gate` | KR | ✅ | ✅ | ✅ | apiKey+secret |
| HTX | `htx` | CN | ✅ | ✅ | ✅ | apiKey+secret |
| MEXC Global | `mexc` | SC | ✅ | ✅ | ✅ | apiKey+secret |
| Upbit | `upbit` | KR, ID, SG, TH | ❌ | ✅ | ✅ | apiKey+secret |
| BingX | `bingx` | US | ✅ | ✅ | ✅ | apiKey+secret |
| bitFlyer | `bitflyer` | JP | ✅ | ✅ | ✅ | apiKey+secret |
| Bithumb | `bithumb` | KR | ❌ | ❌ | ❌ | apiKey+secret |
| coincheck | `coincheck` | JP, ID | ✅ | ✅ | ✅ | apiKey+secret |
| HitBTC | `hitbtc` | HK | ✅ | ✅ | ✅ | apiKey+secret |
| luno | `luno` | GB, SG, ZA | ✅ | ❌ | ❌ | apiKey+secret |
| Poloniex | `poloniex` | US | ✅ | ✅ | ✅ | apiKey+secret |
| BTC Markets | `btcmarkets` | AU | ✅ | ✅ | ✅ | apiKey+secret |
| HashKey Global | `hashkey` | BM | ✅ | ✅ | ✅ | apiKey+secret |
| Independent Reserve | `independentreserve` | AU, NZ | ✅ | ❌ | ❌ | apiKey+secret |
| LBank | `lbank` | CN | ✅ | ❌ | ❌ | apiKey+secret |
| WhiteBit | `whitebit` | EE | ✅ | ✅ | ✅ | apiKey+secret |
| HollaEx | `hollaex` | KR | ✅ | ✅ | ✅ | apiKey+secret |
| Alpaca | `alpaca` | US | ✅ | ✅ | ✅ | apiKey+secret |
| Apex | `apex` | — | ✅ | ❌ | ❌ | apiKey+password+secret |
| ARKHAM | `arkham` | US | ✅ | ✅ | ✅ | apiKey+secret |
| AscendEX | `ascendex` | SG | ❌ | ✅ | ✅ | apiKey+secret |
| Backpack | `backpack` | JP | ✅ | ✅ | ✅ | apiKey+secret |
| Bequant | `bequant` | MT | ✅ | ✅ | ✅ | apiKey+secret |
| BigONE | `bigone` | CN | ✅ | ✅ | ✅ | apiKey+secret |
| Binance COIN-M | `binancecoinm` | — | ✅ | ✅ | ✅ | apiKey+secret |
| Binance US | `binanceus` | US | ✅ | ✅ | ✅ | apiKey+secret |
| Binance USDⓈ-M | `binanceusdm` | — | ✅ | ✅ | ✅ | apiKey+secret |
| Bit2C | `bit2c` | IL | ✅ | ❌ | ❌ | apiKey+secret |
| bitbank | `bitbank` | JP | ✅ | ❌ | ❌ | apiKey+secret |
| Bitbns | `bitbns` | IN | ✅ | ✅ | ✅ | apiKey+secret |
| BitMart | `bitmart` | US, CN, HK, KR | ✅ | ✅ | ✅ | apiKey+secret+uid |
| BitMEX | `bitmex` | SC | ✅ | ❌ | ❌ | apiKey+secret |
| BitoPro | `bitopro` | TW | ✅ | ✅ | ✅ | apiKey+secret |
| Bitrue | `bitrue` | SG | ✅ | ✅ | ✅ | apiKey+secret |
| Bitso | `bitso` | MX | ✅ | ✅ | ❌ | apiKey+secret |
| BIT.TEAM | `bitteam` | UK | ✅ | ❌ | ❌ | apiKey+secret |
| BitTrade | `bittrade` | JP | ✅ | ✅ | ✅ | apiKey+secret |
| Bitvavo | `bitvavo` | NL | ✅ | ✅ | ✅ | apiKey+secret |
| BloFin | `blofin` | US | ✅ | ✅ | ✅ | apiKey+password+secret |
| BtcBox | `btcbox` | JP | ❌ | ❌ | ❌ | apiKey+secret |
| BTCTurk | `btcturk` | TR | ✅ | ❌ | ❌ | apiKey+secret |
| Bullish | `bullish` | DE | ✅ | ❌ | ❌ | apiKey+secret |
| Bybit EU | `bybiteu` | EU | ✅ | ✅ | ✅ | apiKey+secret |
| BYDFi | `bydfi` | SG | ✅ | ✅ | ✅ | apiKey+secret |
| CEX.IO | `cex` | GB, EU, CY, RU | ❌ | ❌ | ❌ | apiKey+secret |
| Coinbase Advanced | `coinbaseadvanced` | US | ✅ | ✅ | ✅ | apiKey+secret |
| Coinbase Exchange | `coinbaseexchange` | US | ✅ | ✅ | ✅ | apiKey+password+secret |
| Coinbase International | `coinbaseinternational` | US | ✅ | ✅ | ✅ | apiKey+password+secret |
| CoinEx | `coinex` | CN | ✅ | ✅ | ✅ | apiKey+secret |
| CoinMate | `coinmate` | GB, CZ, EU | ✅ | ❌ | ❌ | apiKey+secret+uid |
| CoinOne | `coinone` | KR | ✅ | ❌ | ❌ | apiKey+secret |
| Coins.ph | `coinsph` | PH | ✅ | ✅ | ✅ | apiKey+secret |
| CoinSpot | `coinspot` | AU | ✅ | ❌ | ❌ | apiKey+secret |
| DeepCoin | `deepcoin` | SG | ✅ | ✅ | ✅ | apiKey+password+secret |
| Delta Exchange | `delta` | VC | ✅ | ❌ | ❌ | apiKey+secret |
| Deribit | `deribit` | NL | ✅ | ✅ | ✅ | apiKey+secret |
| DigiFinex | `digifinex` | SG | ✅ | ✅ | ✅ | apiKey+secret |
| EXMO | `exmo` | LT | ✅ | ✅ | ✅ | apiKey+secret |
| FMFW.io | `fmfwio` | KN | ✅ | ✅ | ✅ | apiKey+secret |
| Foxbit | `foxbit` | pt-BR | ✅ | ✅ | ✅ | apiKey+secret |
| Gate | `gateio` | KR | ✅ | ✅ | ✅ | apiKey+secret |
| HTX | `huobi` | CN | ✅ | ✅ | ✅ | apiKey+secret |
| INDODAX | `indodax` | ID | ❌ | ❌ | ❌ | apiKey+secret |
| Kraken Futures | `krakenfutures` | US | ✅ | ❌ | ❌ | apiKey+secret |
| KuCoin Futures | `kucoinfutures` | SC | ✅ | ✅ | ✅ | apiKey+password+secret |
| Latoken | `latoken` | KY | ✅ | ❌ | ❌ | apiKey+secret |
| Mercado Bitcoin | `mercado` | BR | ✅ | ❌ | ❌ | apiKey+secret |
| MyOKX (EEA) | `myokx` | CN, US | ✅ | ✅ | ✅ | apiKey+password+secret |
| NovaDAX | `novadax` | BR | ✅ | ✅ | ✅ | apiKey+secret |
| OKX (US) | `okxus` | CN, US | ✅ | ✅ | ✅ | apiKey+password+secret |
| OXFUN | `oxfun` | PA | ✅ | ✅ | ✅ | apiKey+secret |
| p2b | `p2b` | LT | ✅ | ❌ | ❌ | apiKey+secret |
| Paymium | `paymium` | FR, EU | ❌ | ❌ | ❌ | apiKey+secret |
| Phemex | `phemex` | CN | ✅ | ✅ | ✅ | apiKey+secret |
| Tokocrypto | `tokocrypto` | ID | ✅ | ✅ | ✅ | apiKey+secret |
| Toobit | `toobit` | KY | ✅ | ✅ | ✅ | apiKey+secret |
| Waves.Exchange | `wavesexchange` | CH | ✅ | ❌ | ❌ | apiKey+secret |
| Weex | `weex` | SG | ✅ | ❌ | ❌ | apiKey+password+secret |
| WOO X | `woo` | KY | ✅ | ✅ | ✅ | apiKey+secret |
| XT | `xt` | SC | ✅ | ✅ | ✅ | apiKey+secret |
| YoBit | `yobit` | RU | ✅ | ❌ | ❌ | apiKey+secret |
| Zaif | `zaif` | JP | ❌ | ❌ | ❌ | apiKey+secret |
| Zebpay | `zebpay` | IN | ✅ | ❌ | ❌ | apiKey+secret |

## Skipped (need adapter changes)

| Exchange | Cred shape required |
|----------|---------------------|
| `aftermath` | privateKey+walletAddress |
| `aster` | privateKey |
| `blockchaincom` | secret |
| `coinmetro` | token+uid |
| `cryptomus` | secret+uid |
| `derive` | privateKey+walletAddress |
| `dydx` | (none) |
| `grvt` | privateKey |
| `hibachi` | accountId+apiKey+privateKey |
| `hyperliquid` | privateKey+walletAddress |
| `lighter` | privateKey |
| `modetrade` | accountId+apiKey+secret |
| `ndax` | apiKey+login+password+secret+uid |
| `onetrading` | apiKey |
| `pacifica` | privateKey |
| `paradex` | privateKey+walletAddress |
| `woofipro` | accountId+apiKey+secret |
