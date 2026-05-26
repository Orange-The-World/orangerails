# Ripio — ToS audit notes

- **Homepage:** https://www.ripio.com/
- **API base URL:** https://app.ripio.com/api/
- **Terms of service URL:** https://www.ripio.com/legales
- **Date read:** 2026-05-26

## ToS fingerprint

- **sha256 of body:** `e9fb4e326a3cebdab6384457b6594486ece8dad87f15b2bec7a1483e8b0e85a9`
- **byte length:** 1097

The fetched page is a client-side-rendered SPA shell — the full Spanish-
language Términos y Condiciones document loads via JavaScript and was not
retrievable in this audit. Founder Spanish-language review of the rendered
page is recommended before activation.

## Endpoint used

- `GET https://app.ripio.com/api/v3/rates/?country=AR` — snapshot of buy/sell
  rates for every market Ripio lists in Argentina. BTC/ARS appears under
  ticker `BTC_ARS`.

This is the same endpoint Ripio's public web rate widget consumes. There is
no separately published developer-API documentation site.

## Relevant clauses

The endpoint is publicly served without authentication and without
robots.txt restriction. Ripio does not publish a per-endpoint rate limit;
the plug-in self-limits to 1 req/sec, which is far below any plausible
abuse threshold given the endpoint serves a static snapshot.

Ripio does not expose OHLC or trade history without a registered account;
this plug-in therefore takes the buy/sell rates only, computes a mid-price,
emits a zero-volume candle, and is classified `B-single-eligible-only`.

## Assessment

Use of `/api/v3/rates/?country=AR` at 1 req/sec for ORBI's read-only
fallback/diversity role for BTC/ARS is consistent with the same posture as
the existing mempool.space plug-in (public ticker, no auth, fallback role).

A founder-level Spanish-language review of the Términos y Condiciones is
recommended before flipping `active=TRUE`.

## Required attribution

Ripio does not publish an attribution requirement for this endpoint. ORBI's
public methodology page will credit Ripio as a data source.
