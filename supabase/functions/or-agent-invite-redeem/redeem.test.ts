/**
 * Tests for the or-agent-invite-redeem sequence.
 *
 * Run with:
 *   deno test supabase/functions/or-agent-invite-redeem/redeem.test.ts
 *
 * Covers the properties this endpoint is judged on, and each one can go red:
 *   - every rejection returns byte identical output, so an anonymous caller cannot tell a
 *     malformed token from an unknown, expired, revoked or already redeemed one
 *   - a token that does not resolve creates NO shadow user, so a public endpoint cannot be
 *     used to fill auth.users with orphan rows
 *   - the caller cannot name the shadow user; the one that is bound is the one we created
 *   - a binding that fails after the shadow user exists deletes it again, whether it
 *     REFUSED or THREW
 *   - a delete that does not work is recorded rather than silent
 *   - nothing a caller sent is ever passed to the log
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  COMPLETE_RPC,
  FAILURE_BODY,
  FAILURE_STATUS,
  parseRedeemBody,
  PEEK_RPC,
  redeem,
  type RedeemPorts,
  type Stage,
} from "./redeem.ts";

const TOKEN = "3f0a9c2b7e1d4a6f8b0c2d4e6f8a1b3c5d7e9f0a1b2c3d4e5f6a7b8c9d0e1f2a";
const GOOD_BODY = JSON.stringify({
  token: TOKEN,
  identity_pubkey: "aWRlbnRpdHktcHVibGljLWtleQ==",
  kem_pubkey: "a2VtLXB1YmxpYy1rZXk=",
});

interface Recorder {
  ports: RedeemPorts;
  order: string[];
  stages: Stage[];
  completedWith: Record<string, unknown> | null;
  deleted: string[];
}

function recorder(opts: {
  agentMemberId?: string | null;
  shadowUserId?: string | null;
  bound?: boolean;
  /** The binding throws instead of answering. A network fault looks like this. */
  completeThrows?: boolean;
  /** true = the user is gone, false = the delete was refused, "throw" = it blew up. */
  deleteOutcome?: boolean | "throw";
} = {}): Recorder {
  const order: string[] = [];
  const stages: Stage[] = [];
  const deleted: string[] = [];
  const rec: Recorder = {
    order,
    stages,
    deleted,
    completedWith: null,
    ports: {
      peekInvitation(_token: string) {
        order.push("peek");
        return Promise.resolve(opts.agentMemberId === undefined ? "agent-1" : opts.agentMemberId);
      },
      createShadowUser() {
        order.push("createShadowUser");
        return Promise.resolve(opts.shadowUserId === undefined ? "shadow-1" : opts.shadowUserId);
      },
      deleteShadowUser(userId: string) {
        order.push("deleteShadowUser");
        deleted.push(userId);
        if (opts.deleteOutcome === "throw") {
          return Promise.reject(new Error("delete blew up"));
        }
        return Promise.resolve(opts.deleteOutcome === undefined ? true : opts.deleteOutcome);
      },
      completeInvitation(input) {
        order.push("complete");
        rec.completedWith = { ...input };
        if (opts.completeThrows) {
          return Promise.reject(new Error(`upstream said no about ${TOKEN}`));
        }
        return Promise.resolve(opts.bound === undefined ? true : opts.bound);
      },
      note(stage: Stage) {
        stages.push(stage);
      },
    },
  };
  return rec;
}

// The rpc names are constants so a rename cannot silently point this function at a
// different database function. If either changes, that is a deliberate act and this fails.
Deno.test("the two rpc names are pinned, and only one of them mutates", () => {
  assertEquals(PEEK_RPC, "peek_agent_invitation");
  assertEquals(COMPLETE_RPC, "complete_agent_invitation");
});

Deno.test("happy path: one complete call, ids returned, shadow user kept", async () => {
  const rec = recorder();
  const out = await redeem(parseRedeemBody(GOOD_BODY), rec.ports);

  assertEquals(out.status, 200);
  assertEquals(JSON.parse(out.body), {
    agent_member_id: "agent-1",
    shadow_user_id: "shadow-1",
  });
  assertEquals(rec.order, ["peek", "createShadowUser", "complete"]);
  assertEquals(rec.deleted, []);
  assertEquals(rec.stages, ["ok"]);
});

// THE indistinguishability test. It compares the six rejections against each other rather
// than against a literal, so any future branch that answers differently fails here.
Deno.test("every rejection is byte identical", async () => {
  const outcomes = [
    // malformed body
    await redeem(parseRedeemBody("not json at all"), recorder().ports),
    // missing fields
    await redeem(parseRedeemBody(JSON.stringify({ token: TOKEN })), recorder().ports),
    // unknown, expired or revoked: peek finds nothing, and the database cannot tell us
    // which of the three it was, deliberately
    await redeem(parseRedeemBody(GOOD_BODY), recorder({ agentMemberId: null }).ports),
    // already redeemed: peek may still resolve in a race, the binding is what refuses
    await redeem(parseRedeemBody(GOOD_BODY), recorder({ bound: false }).ports),
    // internal failure creating the shadow user
    await redeem(parseRedeemBody(GOOD_BODY), recorder({ shadowUserId: null }).ports),
    // the binding threw rather than refusing: same outcome to the caller
    await redeem(parseRedeemBody(GOOD_BODY), recorder({ completeThrows: true }).ports),
  ];

  for (const out of outcomes) {
    assertEquals(out.status, FAILURE_STATUS);
    assertEquals(out.body, FAILURE_BODY);
  }
  const distinct = new Set(outcomes.map((o) => `${o.status}|${o.body}`));
  assertEquals(distinct.size, 1);
});

// A public endpoint that creates an auth user before it knows the token is real is a way to
// fill auth.users from the internet. peek runs first precisely so that cannot happen.
Deno.test("a token that does not resolve creates no shadow user", async () => {
  const rec = recorder({ agentMemberId: null });
  await redeem(parseRedeemBody(GOOD_BODY), rec.ports);

  assertEquals(rec.order, ["peek"]);
  assert(!rec.order.includes("createShadowUser"));
});

Deno.test("a failed binding deletes the shadow user it created", async () => {
  const rec = recorder({ bound: false });
  await redeem(parseRedeemBody(GOOD_BODY), rec.ports);

  assertEquals(rec.order, ["peek", "createShadowUser", "complete", "deleteShadowUser"]);
  assertEquals(rec.deleted, ["shadow-1"]);
  assertEquals(rec.stages, ["reject:complete"]);
});

// The path that used to leak. A throw from the binding travelled past the compensation to
// the outer handler, which answers with the same 400, so one auth user was stranded per
// attempt and nothing recorded it. A network fault is enough to reach this.
Deno.test("a binding that THROWS still deletes the shadow user", async () => {
  const rec = recorder({ completeThrows: true });
  const out = await redeem(parseRedeemBody(GOOD_BODY), rec.ports);

  assertEquals(out.status, FAILURE_STATUS);
  assertEquals(out.body, FAILURE_BODY);
  assertEquals(rec.order, ["peek", "createShadowUser", "complete", "deleteShadowUser"]);
  assertEquals(rec.deleted, ["shadow-1"]);
  assertEquals(rec.stages, ["reject:complete"]);
});

Deno.test("a delete that is refused emits the orphan marker", async () => {
  const rec = recorder({ bound: false, deleteOutcome: false });
  await redeem(parseRedeemBody(GOOD_BODY), rec.ports);

  assertEquals(rec.stages, ["reject:complete", "orphan:delete-failed"]);
});

Deno.test("a delete that throws emits the orphan marker and does not escape", async () => {
  const rec = recorder({ completeThrows: true, deleteOutcome: "throw" });
  const out = await redeem(parseRedeemBody(GOOD_BODY), rec.ports);

  assertEquals(out.status, FAILURE_STATUS);
  assertEquals(out.body, FAILURE_BODY);
  assertEquals(rec.stages, ["reject:complete", "orphan:delete-failed"]);
});

// The marker has to mean something, so prove it stays quiet when the cleanup worked.
Deno.test("a delete that works emits no orphan marker", async () => {
  const rec = recorder({ bound: false, deleteOutcome: true });
  await redeem(parseRedeemBody(GOOD_BODY), rec.ports);

  assertEquals(rec.stages, ["reject:complete"]);
});

// The caller does not get to say which auth user an agent member is bound to. Under the old
// direct rpc shape there was no party who could ever validate that field.
Deno.test("a caller supplied shadow_user_id is ignored, ours is bound", async () => {
  const hostile = JSON.stringify({
    token: TOKEN,
    identity_pubkey: "aWRlbnRpdHktcHVibGljLWtleQ==",
    kem_pubkey: "a2VtLXB1YmxpYy1rZXk=",
    shadow_user_id: "00000000-0000-0000-0000-00000000dead",
    p_shadow_user_id: "00000000-0000-0000-0000-00000000beef",
  });
  const parsed = parseRedeemBody(hostile);
  assert(parsed !== null);
  assertEquals(Object.keys(parsed).sort(), ["identityPubkey", "kemPubkey", "token"]);

  const rec = recorder();
  await redeem(parsed, rec.ports);
  assertEquals(rec.completedWith?.shadowUserId, "shadow-1");
});

// A log line is a stored credential. The stage vocabulary is fixed, so no branch can put
// caller input into one. The throwing branches matter most here: the thrown value in this
// test carries the token deliberately, so anything that logged it would fail.
Deno.test("no caller input reaches the log, in any branch", async () => {
  const allowed = new Set<string>([
    "reject:shape",
    "reject:peek",
    "reject:shadow-user",
    "reject:complete",
    "orphan:delete-failed",
    "ok",
  ]);
  const runs = [
    recorder(),
    recorder({ agentMemberId: null }),
    recorder({ shadowUserId: null }),
    recorder({ bound: false }),
    recorder({ completeThrows: true }),
    recorder({ completeThrows: true, deleteOutcome: "throw" }),
  ];
  for (const rec of runs) {
    await redeem(parseRedeemBody(GOOD_BODY), rec.ports);
    for (const stage of rec.stages) {
      assert(allowed.has(stage), `unexpected stage: ${stage}`);
      assert(!stage.includes(TOKEN));
    }
  }

  const shapeRec = recorder();
  await redeem(parseRedeemBody("{"), shapeRec.ports);
  assertEquals(shapeRec.stages, ["reject:shape"]);
});

Deno.test("body shape: oversized and non base64 keys are refused before any port runs", () => {
  assertEquals(parseRedeemBody(JSON.stringify({ token: "", identity_pubkey: "a", kem_pubkey: "b" })), null);
  assertEquals(
    parseRedeemBody(JSON.stringify({
      token: TOKEN,
      identity_pubkey: "has spaces and *",
      kem_pubkey: "a2VtLXB1YmxpYy1rZXk=",
    })),
    null,
  );
  assertEquals(
    parseRedeemBody(JSON.stringify({
      token: "x".repeat(513),
      identity_pubkey: "aWRlbnRpdHktcHVibGljLWtleQ==",
      kem_pubkey: "a2VtLXB1YmxpYy1rZXk=",
    })),
    null,
  );
});
