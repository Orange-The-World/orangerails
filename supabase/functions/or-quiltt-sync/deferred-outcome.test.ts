/**
 * Deferred-outcome proof for or-quiltt-sync (DL-0326)
 *
 * Run: deno test supabase/functions/or-quiltt-sync/deferred-outcome.test.ts
 *
 * Does NOT import from index.ts (Deno.serve / env deps make that awkward in
 * a headless test). Instead it inlines the dispatch logic verbatim so the
 * test mirrors what ships. If you change the handled === ... block in
 * index.ts, update this file to match so the proof stays honest.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// --- inline the dispatch and markProcessed logic from index.ts ----------

interface CapturedCall {
  fn:      string;
  eventId: string;
}

function makeClient(calls: CapturedCall[]) {
  return {
    from: (_table: string) => ({
      update: (payload: Record<string, unknown>) => ({
        eq: (_col: string, val: string) => {
          // Distinguish markProcessed (has processed_at) from bumpAttempts (has attempts).
          if ("processed_at" in payload) calls.push({ fn: "markProcessed", eventId: val });
          else calls.push({ fn: "bumpAttempts", eventId: val });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  } as unknown as { from: (t: string) => unknown };
}

async function markProcessed(client: ReturnType<typeof makeClient>, eventId: string) {
  await (client.from("quiltt_webhook_inbox") as any)
    .update({ processed_at: new Date().toISOString() })
    .eq("event_id", eventId);
}

interface Counters {
  processed: number;
  skipped:   number;
  deferred:  number;
  failed:    number;
}

async function dispatch(
  client: ReturnType<typeof makeClient>,
  eventId: string,
  handled: "processed" | "skipped" | "deferred" | string,
  counters: Counters,
): Promise<void> {
  if (handled === "processed") {
    await markProcessed(client, eventId);
    counters.processed++;
  } else if (handled === "skipped") {
    await markProcessed(client, eventId);  // no-op events still mark done
    counters.skipped++;
  } else if (handled === "deferred") {
    // OPK not yet set; leave processed_at null so or-sync session drain can pick this up.
    counters.deferred++;
  } else {
    counters.failed++;
  }
}

// --- tests ---------------------------------------------------------------

Deno.test("'deferred' does NOT call markProcessed (row stays visible to or-sync drain)", async () => {
  const calls: CapturedCall[] = [];
  const client = makeClient(calls);
  const counters: Counters = { processed: 0, skipped: 0, deferred: 0, failed: 0 };

  await dispatch(client, "evt_deferred", "deferred", counters);

  assertEquals(calls.length, 0, "markProcessed must NOT be called for deferred events");
  assertEquals(counters.deferred, 1, "deferred counter incremented");
  assertEquals(counters.skipped, 0, "skipped counter must not be touched");
});

Deno.test("'skipped' (no-op event type) DOES call markProcessed (event permanently closed)", async () => {
  const calls: CapturedCall[] = [];
  const client = makeClient(calls);
  const counters: Counters = { processed: 0, skipped: 0, deferred: 0, failed: 0 };

  await dispatch(client, "evt_skipped", "skipped", counters);

  assertEquals(calls.length, 1, "markProcessed called exactly once");
  assertEquals(calls[0].fn, "markProcessed");
  assertEquals(calls[0].eventId, "evt_skipped");
  assertEquals(counters.skipped, 1);
  assertEquals(counters.deferred, 0, "deferred counter must not be touched");
});

Deno.test("'processed' calls markProcessed (normal happy path unaffected)", async () => {
  const calls: CapturedCall[] = [];
  const client = makeClient(calls);
  const counters: Counters = { processed: 0, skipped: 0, deferred: 0, failed: 0 };

  await dispatch(client, "evt_processed", "processed", counters);

  assertEquals(calls.length, 1, "markProcessed called exactly once");
  assertEquals(calls[0].fn, "markProcessed");
  assertEquals(calls[0].eventId, "evt_processed");
  assertEquals(counters.processed, 1);
  assertEquals(counters.deferred, 0);
});

Deno.test("mixed batch: 'deferred' rows stay unprocessed, 'skipped' row is closed", async () => {
  const calls: CapturedCall[] = [];
  const client = makeClient(calls);
  const counters: Counters = { processed: 0, skipped: 0, deferred: 0, failed: 0 };

  await dispatch(client, "evt_a", "deferred", counters);
  await dispatch(client, "evt_b", "skipped",  counters);
  await dispatch(client, "evt_c", "deferred", counters);

  assertEquals(calls.length, 1,   "only the skipped event called markProcessed");
  assertEquals(calls[0].eventId, "evt_b");
  assertEquals(counters.deferred, 2, "both deferred events counted");
  assertEquals(counters.skipped,  1);
});
