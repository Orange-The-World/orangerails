/**
 * Quiltt event types this system has decided about, and the alarm that fires
 * when one arrives that it has not.
 *
 * WHY THIS EXISTS. Two profile.deleted webhooks arrived on 2026-09-03, failed
 * routing 25 times each and retired with nobody noticing. That was the first
 * new event type the inbox had ever seen. Nothing in or-quiltt-webhook compares
 * an inbound type against a set we know, and or-quiltt-sync's handleEvent acts
 * on exactly two prefixes and returns 'skipped' for everything else, which the
 * caller then marks processed. So an event type Quiltt invents tomorrow is
 * accepted, stored, marked done and never seen by a human.
 *
 * WHAT THIS CHANGES, AND WHAT IT DOES NOT. Visibility only. An unknown type is
 * still accepted with a 200, still stored in quiltt_webhook_inbox, still drained
 * and still marked processed, exactly as before. Rejecting at the receiver would
 * turn a Quiltt product change into a 4xx retry storm and lose the events
 * entirely, which is strictly worse than the current silence.
 *
 * WHY THE ALARM IS ON THE TYPE AND NOT ON THE UNMAPPED EVENT. mapping-missing is
 * ordinary and live: 93 rows all time, 9 in the last 7 days, and the last 30
 * days are routine connection.synced.errored.repairable. An alarm on that fires
 * constantly and is muted inside a week, which is worse than no alarm because it
 * looks like coverage. A type we have never handled is rare by construction, so
 * this alarm fires almost never and means something every time.
 *
 * PREFIX, NOT AN ENUMERATION OF FULL TYPE STRINGS. Same reasoning the errored
 * branch in or-quiltt-sync already carries: Quiltt's subtype taxonomy is not
 * guaranteed bounded, so matching whole strings would make an ordinary new
 * subtype of a family we handle read as brand new.
 *
 * THE LIST IS A DECISION RECORD, NOT AN INVENTORY OF WHAT ARRIVES. A prefix
 * belongs here once somebody has said what we do about it. Adding one is a
 * single line and it means "we looked at this and chose".
 *
 * BUILT FROM OUR CODE, THEN CLOSED AGAINST PRODUCTION. The list started from
 * our own code: the two dispatch branches, plus the types the or-quiltt-sync
 * header has documented as deliberate no-ops since phase 1. That version would
 * have alarmed on 84 percent of an ordinary week, because four routine types
 * arrive that our code never mentions anywhere. The census on OR-T2148 (read
 * off production by the DBA on 2026-09-04 from quiltt_webhook_inbox, 8,403 rows
 * since 2026-06-11) named all eleven types that have ever arrived, and the list
 * below now covers ten of them. The eleventh is profile.deleted, which is the
 * one we want loud. Measured against the last 7 days of that census: 825 events
 * arrived and this alarm would have fired on 2.
 *
 * Nothing is dropped either way. The only thing at stake in getting the list
 * right is whether the alarm stays believable enough not to be muted.
 */

/**
 * The two fields an alarm is allowed to see. Callers pass whole inbox rows,
 * which also carry the full provider payload; this shape is what keeps the
 * payload out of the alarm by construction rather than by remembering to.
 */
export interface QuilttEventRef {
  event_id: string;
  event_type: string;
}

/** Prefixes or-quiltt-sync/handleEvent actually acts on. */
export const HANDLED_QUILTT_EVENT_TYPE_PREFIXES: readonly string[] = [
  'connection.synced.successful',
  'connection.synced.errored',
];

/**
 * Prefixes we knowingly do nothing about. Being here means the no-op is a
 * decision; being absent means nobody has made one yet.
 *
 * profile.created and account.verified are the no-ops the or-quiltt-sync module
 * header has named since phase 1. The other four were added on 2026-09-04 from
 * the production census (see the header): they arrive, we do nothing with them,
 * and until that census nobody had written down that we had chosen to.
 *
 * balance.created and profile.ready are the two that decide whether this alarm
 * is usable: 692 of the last 825 events between them. We act on neither today,
 * because balances are refreshed on the connection.synced.successful path.
 * Whether balance.created should itself trigger a pull is a genuine question
 * and it is tracked on its own ticket. It is not a reason for this alarm to
 * fire 600 times a week while that question is open.
 *
 * account.created and connection.created are ordinary and have never carried an
 * error, but neither has arrived since 2026-08-21. That is worth knowing and it
 * is not this alarm's job to say so: an alarm on a type that STOPS arriving is
 * a different check from one on a type nobody decided about.
 *
 * account.verified has never arrived at all: 0 rows in 8,403 across nearly
 * three months. It stays because it is a decision somebody recorded, not
 * because traffic confirms it.
 *
 * profile.deleted is deliberately NOT here. Whether a deletion signal obliges
 * us to act is an open question, and until it is answered the event must stay
 * loud. It is 2 events on production, both of which failed routing 25 times and
 * retired with nobody noticing, which is the case this alarm exists for.
 */
export const IGNORED_QUILTT_EVENT_TYPE_PREFIXES: readonly string[] = [
  'profile.created',
  'profile.ready',
  'account.verified',
  'account.created',
  'connection.created',
  'balance.created',
];

export const KNOWN_QUILTT_EVENT_TYPE_PREFIXES: readonly string[] = [
  ...HANDLED_QUILTT_EVENT_TYPE_PREFIXES,
  ...IGNORED_QUILTT_EVENT_TYPE_PREFIXES,
];

/**
 * The one string to grep for, in logs or in the error tracker. Distinct on
 * purpose: it appears nowhere else in this repository, so a search for it
 * returns these events and nothing else.
 */
export const UNKNOWN_EVENT_TYPE_MARKER = 'QUILTT_UNKNOWN_EVENT_TYPE';

/**
 * At most this many individual alarms per batch, with one counted summary line
 * for any overflow. A batch is already bounded by the receiver's 256KB body
 * limit, so in practice this is never reached; it exists so a pathological or
 * hostile batch cannot open hundreds of error-tracker issues in one request.
 * Nothing is silently dropped: the summary states how many were not itemised.
 */
export const MAX_UNKNOWN_ALARMS_PER_BATCH = 25;

const MAX_FIELD_LEN = 120;

/**
 * Alarm fields go into a log line and into an error message, both of which are
 * newline-delimited records elsewhere. A type or id carrying a control
 * character could otherwise forge a second log line. The body is HMAC-verified
 * before we get here, so this is defence in depth rather than the primary
 * control, but a log line is exactly the wrong place to trust an upstream
 * string.
 */
function safeField(v: string): string {
  return v.replace(/[^\x20-\x7e]/g, '?').slice(0, MAX_FIELD_LEN);
}

export function isKnownQuilttEventType(eventType: string): boolean {
  return KNOWN_QUILTT_EVENT_TYPE_PREFIXES.some((p) => eventType.startsWith(p));
}

/**
 * The events in this batch whose type nobody has decided about, deduplicated by
 * event id so a batch that repeats an event alarms once for it.
 *
 * Rows are read, never modified, and only event_id and event_type are read off
 * them.
 */
export function unknownQuilttEventTypes<T extends QuilttEventRef>(
  rows: readonly T[],
): QuilttEventRef[] {
  const seen = new Set<string>();
  const out: QuilttEventRef[] = [];
  for (const row of rows) {
    const eventType = typeof row?.event_type === 'string' ? row.event_type : '';
    const eventId = typeof row?.event_id === 'string' ? row.event_id : '';
    if (!eventType || !eventId) continue;
    if (isKnownQuilttEventType(eventType)) continue;
    if (seen.has(eventId)) continue;
    seen.add(eventId);
    out.push({ event_id: eventId, event_type: eventType });
  }
  return out;
}

/** Where the alarm goes. Injected so a test can read what was emitted. */
export interface UnknownEventTypeSink {
  warn: (line: string) => void;
  capture: (err: Error) => void;
}

/**
 * Emit one log line and one error-tracker capture per unknown-type event.
 *
 * Returns what it alarmed on, so a caller can count it. It does not filter,
 * reorder or mutate `rows`: whatever the caller was going to store, it still
 * stores.
 *
 * Call this once per event, on the path that runs once. In or-quiltt-webhook
 * that is after the inbox insert has succeeded: an insert that fails returns a
 * non-2xx, Quiltt redelivers, and alarming before the insert would alarm again
 * on each redelivery. After a 200 Quiltt does not redeliver, so each accepted
 * event alarms exactly once.
 */
export function alarmOnUnknownQuilttEventTypes<T extends QuilttEventRef>(
  rows: readonly T[],
  sink: UnknownEventTypeSink,
  fnName = 'or-quiltt-webhook',
): QuilttEventRef[] {
  const unknown = unknownQuilttEventTypes(rows);
  const itemised = unknown.slice(0, MAX_UNKNOWN_ALARMS_PER_BATCH);

  for (const ev of itemised) {
    const line = `[${fnName}] ${UNKNOWN_EVENT_TYPE_MARKER} type=${safeField(ev.event_type)} ` +
      `event_id=${safeField(ev.event_id)}`;
    sink.warn(line);
    sink.capture(new Error(line));
  }

  const overflow = unknown.length - itemised.length;
  if (overflow > 0) {
    const line = `[${fnName}] ${UNKNOWN_EVENT_TYPE_MARKER} ${overflow} further unknown-type ` +
      `event(s) in this batch not itemised (cap ${MAX_UNKNOWN_ALARMS_PER_BATCH})`;
    sink.warn(line);
    sink.capture(new Error(line));
  }

  return unknown;
}
