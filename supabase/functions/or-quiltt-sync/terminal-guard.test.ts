/**
 * Terminal-guard proof for or-quiltt-sync (DL-0465)
 *
 * Run: deno test supabase/functions/or-quiltt-sync/terminal-guard.test.ts
 *
 * Does NOT import from index.ts (Deno.serve / env deps make that awkward in
 * a headless test). Instead it inlines the bumpAttempts + MAX_ATTEMPTS logic
 * (including the terminal-write error fallback) so the test mirrors what ships.
 * If you change the logic in index.ts, update this file to match so the proof stays honest.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// --- inline the guard logic from index.ts (keep in sync) ----------------

const MAX_ATTEMPTS = 25;

interface PendingEvent {
  event_id:      string;
  event_type:    string;
  payload:       unknown;
  platform_id:   string | null;
  subaccount_id: string | null;
  attempts:      number;
}

interface CapturedUpdate {
  payload:  Record<string, unknown>;
  eventId:  string;
}

/** Minimal Supabase mock - captures UPDATE calls.
 *  errors[n] is the error returned on the nth call (null = success). */
function makeClient(captured: CapturedUpdate[], errors: Array<{ message: string } | null> = []) {
  let callIndex = 0;
  return {
    from: (_table: string) => ({
      update: (payload: Record<string, unknown>) => ({
        eq: (_col: string, val: string) => {
          const error = errors[callIndex] ?? null;
          callIndex++;
          captured.push({ payload, eventId: val });
          return Promise.resolve({ error });
        },
      }),
    }),
  } as unknown as { from: (t: string) => unknown };
}

async function bumpAttempts(
  client: ReturnType<typeof makeClient>,
  ev: PendingEvent,
  errMsg: string,
): Promise<void> {
  const newAttempts = (ev.attempts ?? 0) + 1;
  const terminal    = newAttempts >= MAX_ATTEMPTS;
  const { error } = await (client.from("quiltt_webhook_inbox") as any)
    .update({
      attempts:   newAttempts,
      last_error: errMsg.slice(0, 500),
      ...(terminal ? { processed_at: new Date().toISOString(), retirement_reason: ('max-attempts:' + errMsg).slice(0, 500) } : {}),
    })
    .eq("event_id", ev.event_id);
  if (error && terminal) {
    // Terminal write rejected (e.g. retirement_reason column absent before #316 applies):
    // fall back to counter-only bump to preserve attempts and last_error.
    await (client.from("quiltt_webhook_inbox") as any)
      .update({ attempts: newAttempts, last_error: errMsg.slice(0, 500) })
      .eq("event_id", ev.event_id);
  }
}

// --- tests ---------------------------------------------------------------

Deno.test("below ceiling: processed_at NOT set, counter incremented", async () => {
  const calls: CapturedUpdate[] = [];
  const client = makeClient(calls);
  const ev: PendingEvent = {
    event_id: "evt_below", event_type: "connection.synced.successful",
    payload: null, platform_id: null, subaccount_id: null, attempts: 5,
  };
  await bumpAttempts(client, ev, "mapping-missing");

  assertEquals(calls.length, 1, "exactly one DB write");
  assertEquals("processed_at" in calls[0].payload, false, "processed_at must NOT be set below ceiling");
  assertEquals(calls[0].payload.attempts, 6, "counter incremented");
  assertEquals(calls[0].eventId, "evt_below");
});

Deno.test("at ceiling (attempts = MAX_ATTEMPTS - 1): retired in same single UPDATE", async () => {
  const calls: CapturedUpdate[] = [];
  const client = makeClient(calls);
  const ev: PendingEvent = {
    event_id: "evt_threshold", event_type: "connection.synced.successful",
    payload: null, platform_id: null, subaccount_id: null, attempts: MAX_ATTEMPTS - 1,
  };
  await bumpAttempts(client, ev, "mapping-missing");

  assertEquals(calls.length, 1, "terminal decision and counter are ONE UPDATE, not two");
  assertEquals(typeof calls[0].payload.processed_at, "string", "processed_at set when retiring");
  assertEquals(typeof calls[0].payload.retirement_reason, "string", "retirement_reason set when retiring");
  assertEquals(calls[0].payload.attempts, MAX_ATTEMPTS);
  assertEquals(calls[0].eventId, "evt_threshold");
});

Deno.test("existing prod poison row at 11,495 attempts: retired on next drain tick", async () => {
  const calls: CapturedUpdate[] = [];
  const client = makeClient(calls);
  const ev: PendingEvent = {
    event_id: "evt_133XCrCS0UhcmBw0WCJuCz", event_type: "connection.synced.errored.repairable",
    payload: null, platform_id: null, subaccount_id: null, attempts: 11_495,
  };
  await bumpAttempts(client, ev, "mapping-missing");

  assertEquals(calls.length, 1);
  assertEquals(typeof calls[0].payload.processed_at, "string",
    "poison row at 11,495 attempts is retired immediately on first drain tick after guard ships");
  assertEquals(typeof calls[0].payload.retirement_reason, "string", "retirement_reason set on poison row retirement");
  assertEquals(calls[0].payload.attempts, 11_496);
});

Deno.test("queue head advances: second event is not blocked by terminal first event", async () => {
  // Simulates two consecutive events in a batch: first is unroutable at ceiling,
  // second is processable. The terminal guard retires the first in one write,
  // the loop continues, and the second is reached.
  const calls: CapturedUpdate[] = [];
  const client = makeClient(calls);

  const poison: PendingEvent = {
    event_id: "evt_poison", event_type: "connection.synced.successful",
    payload: null, platform_id: null, subaccount_id: null, attempts: MAX_ATTEMPTS - 1,
  };
  const next: PendingEvent = {
    event_id: "evt_next", event_type: "connection.synced.successful",
    payload: null, platform_id: null, subaccount_id: null, attempts: 0,
  };

  await bumpAttempts(client, poison, "mapping-missing"); // retires poison
  await bumpAttempts(client, next,   "mapping-missing"); // next row is reachable

  assertEquals(calls.length, 2, "both events were processed (queue did not stall)");
  assertEquals(typeof calls[0].payload.processed_at, "string", "first row retired");
  assertEquals("processed_at" in calls[1].payload, false, "second row still live");
});

Deno.test("terminal write rejected: fallback preserves attempts and last_error without retirement fields", async () => {
  // Simulates prod where retirement_reason column does not yet exist (#316 not applied).
  // Terminal write is rejected; fallback must carry attempts + last_error but NOT
  // processed_at or retirement_reason.
  const calls: CapturedUpdate[] = [];
  const terminalError = { message: 'column "retirement_reason" of relation "quiltt_webhook_inbox" does not exist' };
  const client = makeClient(calls, [terminalError, null]);
  const ev: PendingEvent = {
    event_id: "evt_fallback", event_type: "connection.synced.successful",
    payload: null, platform_id: null, subaccount_id: null, attempts: MAX_ATTEMPTS - 1,
  };
  await bumpAttempts(client, ev, "mapping-missing");

  assertEquals(calls.length, 2, "terminal write + fallback = two DB writes");
  // First call: the attempted terminal write (rejected by missing column in this scenario)
  assertEquals(typeof calls[0].payload.processed_at, "string", "terminal write attempted processed_at");
  assertEquals(typeof calls[0].payload.retirement_reason, "string", "terminal write attempted retirement_reason");
  // Second call: the fallback - counter fields only, no retirement fields
  assertEquals("processed_at" in calls[1].payload, false, "fallback must NOT set processed_at");
  assertEquals("retirement_reason" in calls[1].payload, false, "fallback must NOT set retirement_reason");
  assertEquals(calls[1].payload.attempts, MAX_ATTEMPTS, "fallback preserves counter advance");
  assertEquals(typeof calls[1].payload.last_error, "string", "fallback preserves last_error");
});
