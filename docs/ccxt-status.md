# CCXT exchange support matrix

**Generated:** 2026-08-07 from `ccxt@4.4.30` introspection.

**Total wired:** 98 exchanges using OR's standard CCXT adapter.

**Skipped:** 11 exchanges using credential shapes that need adapter changes (privateKey+walletAddress for DEX wrappers, accountId+apiKey+secret, apiKey-only sandboxes). Tracked as a Sprint 2 follow-up.

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
| Binance | `binance` | JP, MT | ✅ | ✅ | ✅ | apiKey+secret |
| Kraken | `kraken` | US | ✅ | ✅ | ✅ | apiKey+secret |
| Bybit | `bybit` | VG | ✅ | ✅ | ✅ | apiKey+secret |
| OKX | `okx` | CN, US | ✅ | ✅ | ✅ | apiKey+password+secret |
| Gemini | `gemini` | US | ✅ | ❌ | ❌ | apiKey+secret |
| KuCoin | `kucoin` | SC | ✅ | ✅ | ✅ | apiKey+password+secret |
| Crypto.com | `cryptocom` | MT | ✅ | ✅ | ✅ | apiKey+secret |
| Bitstamp | `bitstamp` | GB | ✅ | ❌ | ✅ | apiKey+secret |
| Bitfinex | `bitfinex` | VG | ✅ | ❌ | ❌ | apiKey+secret |
| Bitget | `bitget` | SG | ✅ | ✅ | ✅ | apiKey+password+secret |
| Gate.io | `gate` | KR | ✅ | ✅ | ✅ | apiKey+secret |
| HTX | `htx` | CN | ✅ | ✅ | ✅ | apiKey+secret |
| MEXC Global | `mexc` | SC | ✅ | ✅ | ✅ | apiKey+secret |
| Upbit | `upbit` | KR | ❌ | ✅ | ✅ | apiKey+secret |
| BingX | `bingx` | US | ❌ | ✅ | ✅ | apiKey+secret |
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
| WhiteBit | `whitebit` | EE | ✅ | ✅ | ❌ | apiKey+secret |
| HollaEx | `hollaex` | KR | ✅ | ✅ | ✅ | apiKey+secret |
| ACE | `ace` | TW | ✅ | ❌ | ❌ | apiKey+secret |
| Alpaca | `alpaca` | US | ✅ | ✅ | ✅ | apiKey+secret |
| AscendEX | `ascendex` | SG | ❌ | ✅ | ✅ | apiKey+secret |
| Bequant | `bequant` | MT | ✅ | ✅ | ✅ | apiKey+secret |
| BigONE | `bigone` | CN | ✅ | ✅ | ✅ | apiKey+secret |
| Binance COIN-M | `binancecoinm` | JP, MT | ✅ | ✅ | ✅ | apiKey+secret |
| Binance US | `binanceus` | US | ✅ | ✅ | ✅ | apiKey+secret |
| Binance USDⓈ-M | `binanceusdm` | JP, MT | ✅ | ✅ | ✅ | apiKey+secret |
| Bit2C | `bit2c` | IL | ✅ | ❌ | ❌ | apiKey+secret |
| bitbank | `bitbank` | JP | ✅ | ❌ | ❌ | apiKey+secret |
| Bitbns | `bitbns` | IN | ✅ | ✅ | ✅ | apiKey+secret |
| Bitcoin.com | `bitcoincom` | KN | ✅ | ✅ | ✅ | apiKey+secret |
| Bitfinex | `bitfinex2` | VG | ✅ | ❌ | ❌ | apiKey+secret |
| BitMart | `bitmart` | US, CN, HK, KR | ✅ | ✅ | ✅ | apiKey+secret+uid |
| BitMEX | `bitmex` | SC | ✅ | ❌ | ❌ | apiKey+secret |
| BitoPro | `bitopro` | TW | ✅ | ✅ | ✅ | apiKey+secret |
| Bitrue | `bitrue` | SG | ✅ | ✅ | ✅ | apiKey+secret |
| Bitso | `bitso` | MX | ✅ | ✅ | ❌ | apiKey+secret |
| BIT.TEAM | `bitteam` | UK | ✅ | ❌ | ❌ | apiKey+secret |
| Bitvavo | `bitvavo` | NL | ✅ | ✅ | ✅ | apiKey+secret |
| BL3P | `bl3p` | NL | ❌ | ❌ | ❌ | apiKey+secret |
| BloFin | `blofin` | US | ✅ | ✅ | ✅ | apiKey+password+secret |
| BTC-Alpha | `btcalpha` | US | ✅ | ✅ | ✅ | apiKey+secret |
| BtcBox | `btcbox` | JP | ❌ | ❌ | ❌ | apiKey+secret |
| BTCTurk | `btcturk` | TR | ✅ | ❌ | ❌ | apiKey+secret |
| CEX.IO | `cex` | GB, EU, CY, RU | ❌ | ❌ | ❌ | apiKey+secret |
| Coinbase Advanced | `coinbaseadvanced` | US | ✅ | ✅ | ✅ | apiKey+secret |
| Coinbase Exchange | `coinbaseexchange` | US | ✅ | ✅ | ✅ | apiKey+password+secret |
| Coinbase International | `coinbaseinternational` | US | ✅ | ✅ | ✅ | apiKey+password+secret |
| CoinCatch | `coincatch` | VG | ✅ | ✅ | ✅ | apiKey+password+secret |
| CoinEx | `coinex` | CN | ✅ | ✅ | ✅ | apiKey+secret |
| Coinlist | `coinlist` | US | ✅ | ❌ | ❌ | apiKey+secret |
| CoinMate | `coinmate` | GB, CZ, EU | ✅ | ❌ | ❌ | apiKey+secret+uid |
| CoinOne | `coinone` | KR | ✅ | ❌ | ❌ | apiKey+secret |
| Coins.ph | `coinsph` | PH | ✅ | ✅ | ✅ | apiKey+secret |
| CoinSpot | `coinspot` | AU | ✅ | ❌ | ❌ | apiKey+secret |
| Currency.com | `currencycom` | BY | ✅ | ✅ | ✅ | apiKey+secret |
| Delta Exchange | `delta` | VC | ✅ | ❌ | ❌ | apiKey+secret |
| Deribit | `deribit` | NL | ✅ | ✅ | ✅ | apiKey+secret |
| DigiFinex | `digifinex` | SG | ✅ | ✅ | ✅ | apiKey+secret |
| EXMO | `exmo` | LT | ✅ | ✅ | ✅ | apiKey+secret |
| FMFW.io | `fmfwio` | KN | ✅ | ✅ | ✅ | apiKey+secret |
| Gate.io | `gateio` | KR | ✅ | ✅ | ✅ | apiKey+secret |
| HTX | `huobi` | CN | ✅ | ✅ | ✅ | apiKey+secret |
| Huobi Japan | `huobijp` | JP | ✅ | ✅ | ✅ | apiKey+secret |
| INDODAX | `indodax` | ID | ❌ | ❌ | ❌ | apiKey+secret |
| Kraken Futures | `krakenfutures` | US | ✅ | ❌ | ❌ | apiKey+secret |
| KuCoin Futures | `kucoinfutures` | SC | ✅ | ✅ | ✅ | apiKey+password+secret |
| Kuna | `kuna` | UA | ✅ | ✅ | ✅ | apiKey+secret |
| Latoken | `latoken` | KY | ✅ | ❌ | ❌ | apiKey+secret |
| Mercado Bitcoin | `mercado` | BR | ✅ | ❌ | ❌ | apiKey+secret |
| NovaDAX | `novadax` | BR | ✅ | ✅ | ✅ | apiKey+secret |
| OceanEx | `oceanex` | BS | ❌ | ❌ | ❌ | apiKey+secret |
| OKCoin | `okcoin` | CN, US | ✅ | ✅ | ✅ | apiKey+password+secret |
| OXFUN | `oxfun` | PA | ✅ | ✅ | ✅ | apiKey+secret |
| p2b | `p2b` | LT | ✅ | ❌ | ❌ | apiKey+secret |
| Paymium | `paymium` | FR, EU | ❌ | ❌ | ❌ | apiKey+secret |
| Phemex | `phemex` | CN | ✅ | ✅ | ✅ | apiKey+secret |
| Poloniex Futures | `poloniexfutures` | US | ✅ | ❌ | ❌ | apiKey+password+secret |
| ProBit | `probit` | SC, KR | ✅ | ✅ | ✅ | apiKey+secret |
| TimeX | `timex` | AU | ✅ | ✅ | ✅ | apiKey+secret |
| Tokocrypto | `tokocrypto` | ID | ✅ | ✅ | ✅ | apiKey+secret |
| tradeogre | `tradeogre` | — | ❌ | ❌ | ❌ | apiKey+secret |
| Waves.Exchange | `wavesexchange` | CH | ✅ | ❌ | ❌ | apiKey+secret |
| WazirX | `wazirx` | IN | ❌ | ✅ | ✅ | apiKey+secret |
| WOO X | `woo` | KY | ✅ | ✅ | ✅ | apiKey+secret |
| XT | `xt` | SC | ✅ | ✅ | ✅ | apiKey+secret |
| YoBit | `yobit` | RU | ✅ | ❌ | ❌ | apiKey+secret |
| Zaif | `zaif` | JP | ❌ | ❌ | ❌ | apiKey+secret |
| Zonda | `zonda` | EE | ✅ | ❌ | ❌ | apiKey+secret |

## Skipped (need adapter changes)

| Exchange | Cred shape required |
|----------|---------------------|
| `bitpanda` | apiKey |
| `blockchaincom` | secret |
| `coinmetro` | token+uid |
| `hyperliquid` | privateKey+walletAddress |
| `idex` | apiKey+privateKey+secret+walletAddress |
| `lykke` | apiKey |
| `ndax` | apiKey+login+password+secret+uid |
| `onetrading` | apiKey |
| `paradex` | privateKey+walletAddress |
| `vertex` | privateKey+walletAddress |
| `woofipro` | accountId+apiKey+secret |
