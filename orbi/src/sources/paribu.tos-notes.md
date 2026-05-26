# Paribu — ToS audit notes

- **Homepage:** https://www.paribu.com/
- **API base URL:** https://www.paribu.com/ticker (no dedicated docs site)
- **Terms of service URL:** https://www.paribu.com/yardim/sozlesmeler/kullanici-sozlesmesi
- **Date read:** 2026-05-26

## ToS fingerprint

- **sha256 of body:** `53e82e2adfeff686bee12b37043fca31c088b10529d0d33b7b5d20a8fa0f3524`
- **byte length:** 366405

(Turkish-language Kullanıcı Sözleşmesi.)

## Endpoint used

- `GET https://www.paribu.com/ticker` — returns a snapshot of every market in
  one JSON document. BTC/TRY appears under key `BTC_TL`.

This is the same endpoint Paribu's own public website consumes for its market
ticker widget; there is no separate documented developer API.

## Relevant clauses

The full agreement is in Turkish. The `/ticker` endpoint is publicly served
without authentication, throttling, or robots.txt restriction. Paribu does
not publish a dedicated public API documentation site or per-endpoint rate
limit guidance — ORBI's plug-in self-limits to 1 req/sec.

Paribu does not expose OHLC or trade history without a registered account;
this plug-in therefore takes only a single-value `last` ticker, emits a
zero-volume candle, and is classified `B-single-eligible-only` (does not vote
in the volume-weighted median).

A founder-level Turkish-language review of the Kullanıcı Sözleşmesi is
recommended before flipping `active=TRUE`.

## Assessment

Use of the public `/ticker` endpoint at low frequency for ORBI's read-only
fallback role is consistent with the same posture as the existing
mempool.space plug-in (public ticker, no auth, fallback-only).

## Required attribution

Paribu does not publish an attribution requirement for this endpoint. ORBI's
public methodology page will credit Paribu as a data source.
