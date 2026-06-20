-- ============================================================
-- Per-platform Quiltt config + sink format on platforms table
-- ============================================================
-- Architectural foundation: OR is the multi-tenant Plaid-for-Bitcoin-
-- native-apps gateway. Multiple consumer apps (
-- future) share one BitBest Quiltt application but should each pick
-- their own Quiltt Profile, Connector, and API key without OR-wide
-- secret swaps that break sibling consumers.
--
-- Today: QUILTT_API_KEY, QUILTT_CONNECTOR_ID_LINK, QUILTT_CONNECTOR_ID_
-- RECONNECT, QUILTT_CATALOG_PROFILE_ID live as global Deno.env on every
-- Quiltt-touching edge function. V2 currently uses Quiltt SANDBOX. OWM
-- wants Quiltt PROD. With shared globals, you can only have one or the
-- other — not both at once.
--
-- After this migration:
--   - bitbooks-v2 row keeps sandbox values (V2 testing intact)
--   - orangeway-me + orangeway-me-dev + orangeway-books rows get PROD
--   - Edge functions read from platforms columns per request
--   - QUILTT_*_PROD and QUILTT_*_SANDBOX env vars on OR can be retired
--     (kept as last-resort fallback during the transition window)
--
-- Inbound Quiltt webhook secret (QUILTT_WEBHOOK_SECRET) stays as a global
-- function secret because Quiltt itself issues one webhook subscription
-- per environment, not per OR platform. To run both sandbox + prod
-- Quiltt webhooks against OR, register two distinct webhook endpoint
-- URLs at Quiltt — that's a Quiltt-dashboard config, not OR code.
--
-- Sink format (platforms.sink_format) replaces the caller-driven `format`
-- field in or-sync request bodies. Server-side resolution prevents a
-- buggy or malicious caller from requesting a sink shape that doesn't
-- belong to them. or-sync still accepts the body field for backward
-- compatibility but the platform row wins when both are set.

-- ── 1. Per-platform Quiltt configuration columns ─────────────────────

alter table public.platforms
  add column if not exists quiltt_api_key                text,
  add column if not exists quiltt_api_key_id             text,
  add column if not exists quiltt_connector_id_link      text,
  add column if not exists quiltt_connector_id_reconnect text,
  add column if not exists quiltt_catalog_profile_id     text,
  add column if not exists sink_format                   text;

comment on column public.platforms.quiltt_api_key is
  'Per-platform Quiltt API key (Model A bearer token). Reads override '
  'the global QUILTT_API_KEY env on or-quiltt-* edge functions. NULL '
  'means "fall back to env" during the multi-tenant transition.';

comment on column public.platforms.quiltt_api_key_id is
  'Quiltt API key identifier (the public half). Lets us rotate keys '
  'without code changes — keep both old + new live until traffic moves.';

comment on column public.platforms.quiltt_connector_id_link is
  'Quiltt Connector id used for first-time bank linking. Different '
  'platforms can ship different branding/coverage by pointing at '
  'different Connectors under the same Quiltt Profile.';

comment on column public.platforms.quiltt_connector_id_reconnect is
  'Quiltt Connector id used to repair an expired/MFA-locked connection. '
  'Falls back to quiltt_connector_id_link if NULL.';

comment on column public.platforms.quiltt_catalog_profile_id is
  'Quiltt Profile id this platform mints sessions against. Rate limits '
  '(10/hr, 20/day) bind to this Profile. Multiple platforms can share '
  'one Profile; or each can have its own for isolation.';

comment on column public.platforms.sink_format is
  'Sink adapter slug or-sync uses to shape rows for this platform. '
  'Resolved server-side from the caller''s platform — supersedes the '
  'body.format field. Examples: bitbooks-v2, orangeway-me, orangeway-books.';

-- ── 2. Backfill ──────────────────────────────────────────────────────
-- This migration leaves QUILTT_API_KEY etc. NULL on every row by default.
-- A second migration (run AFTER the operator pastes values into a
-- secrets-only script) will populate them — values cannot land in a
-- committed SQL file. See companion script: scripts/backfill-platform-
-- quiltt-config.sh (NOT in git; lives in jarvis tmpfs at run time).
--
-- Sink format CAN be set here because it's a public slug, not a secret.

update public.platforms set sink_format = 'bitbooks-v2'
  where slug = 'bitbooks-v2' and sink_format is null;

update public.platforms set sink_format = 'orangeway-me'
  where slug in ('orangeway-me', 'orangeway-me-dev', 'orangeway') and sink_format is null;

update public.platforms set sink_format = 'orangeway-books'
  where slug = 'orangeway-books' and sink_format is null;

-- ── 3. Helper view: resolved Quiltt config per platform ──────────────
-- Pure view of (platform_id → quiltt_*). Edge functions can read this
-- via PostgREST + service-role; consumers/end-users never can.

create or replace view public.v_platform_quiltt_config as
select
  id              as platform_id,
  slug,
  tier,
  sink_format,
  -- Per-platform Quiltt config with env fallback handled in app code.
  quiltt_api_key,
  quiltt_api_key_id,
  quiltt_connector_id_link,
  quiltt_connector_id_reconnect,
  quiltt_catalog_profile_id
from public.platforms;

revoke all on public.v_platform_quiltt_config from anon, authenticated;
-- service_role retains access by default (Supabase grants).

comment on view public.v_platform_quiltt_config is
  'Convenience view of per-platform Quiltt config + sink format. '
  'Service-role only — never expose to anon/authenticated. Edge '
  'functions read this with the service-role client to avoid '
  'serializing 5 separate columns each call.';
