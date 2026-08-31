/**
 * or-agent-invite-redeem: the redemption sequence, with every side effect injected.
 *
 * WHY THIS IS A SEPARATE FILE FROM index.ts
 * index.ts is wiring: it builds the service_role client and starts Deno.serve. Everything
 * that decides an outcome lives here, so the sequence is testable with no network, no
 * database and no deployed function, and so a reader can check the two properties this
 * endpoint is judged on by reading one short file:
 *   1. exactly one MUTATING rpc is ever called, named by a constant declared here
 *   2. every rejection returns the same status and the same bytes
 *
 * WHAT THIS ENDPOINT IS, said honestly and on purpose. It is a PUBLIC endpoint. The
 * gateway JWT check is off (supabase/config.toml) because the invitee has no session at
 * redemption time, and turning it on would change nothing that matters: the anon key ships
 * inside every browser bundle. The raw invitation token stays the only thing between a
 * caller and a key binding. What this design buys is not secrecy. It is ONE controlled
 * path that we own, can instrument, and can rate limit later. Do not write anywhere, in
 * code, in a PR or to a client, that redemption is no longer anonymously reachable. It is.
 */

/** Read only. Validates the token and tells us which agent member it belongs to. */
export const PEEK_RPC = "peek_agent_invitation";

/** The ONLY mutating call this function makes. Nothing else may be added beside it. */
export const COMPLETE_RPC = "complete_agent_invitation";

/**
 * The one and only rejection.
 *
 * Malformed, unknown, expired, revoked, already redeemed, and any internal failure all
 * return these exact bytes with this exact status. Anything that distinguishes them tells
 * an anonymous caller whether a token it guessed exists, which is the one fact this
 * endpoint must never give away. Internal failures are folded in as well: keeping them
 * separate would cost debuggability nothing that the stage markers do not already give us,
 * and would hand back a distinguishable response for free.
 */
export const FAILURE_STATUS = 400;
export const FAILURE_BODY = JSON.stringify({ error: "invitation_not_redeemable" });

export interface RedeemRequest {
  token: string;
  identityPubkey: string;
  kemPubkey: string;
}

export interface RedeemPorts {
  /** Read only. Returns the agent_member id for a LIVE invitation, null for every other case. */
  peekInvitation(token: string): Promise<string | null>;
  /** Creates the shadow auth.users row this redemption will bind. Returns its id, or null. */
  createShadowUser(): Promise<string | null>;
  /** Best effort compensation when the binding fails after the shadow user was created. */
  deleteShadowUser(userId: string): Promise<void>;
  /** The single mutating call. True only when the agent member was actually activated. */
  completeInvitation(input: RedeemRequest & { shadowUserId: string }): Promise<boolean>;
  /** Stage marker only. NEVER receives caller input. See STAGES below. */
  note(stage: Stage): void;
}

/**
 * The complete set of things this function is allowed to say about a request.
 *
 * A log line is a stored credential. The raw token is a bearer credential with a seven day
 * window, so it is never logged, in any branch, and neither is its digest. That includes
 * error text: a database error message is the one place the token could plausibly resurface,
 * so no error message from the rpc path is logged or re-thrown. The cost is real, we lose
 * the upstream reason for an infrastructure failure, and the stage marker plus the function
 * invocation timestamp is what we accept instead.
 */
export type Stage =
  | "reject:shape"
  | "reject:peek"
  | "reject:shadow-user"
  | "reject:complete"
  | "ok";

export interface RedeemOutcome {
  status: number;
  body: string;
}

const MAX_TOKEN_CHARS = 512;
const MAX_PUBKEY_CHARS = 512;

/** base64 and base64url, which is what the database side already accepts for both keys. */
const BASE64ISH = /^[A-Za-z0-9+/_=-]+$/;

function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > maxChars) return null;
  return value;
}

/**
 * Parse the request body into the three fields this endpoint accepts.
 *
 * NOTE WHAT IS NOT HERE: shadow_user_id. The caller does not get to name the auth user that
 * an agent member is bound to, and a value supplied by the browser is silently ignored
 * rather than honoured. Under the old direct-rpc shape there was by construction no party
 * who could validate that field, because the caller has no session and there is no auth.uid
 * to compare it against. This function creates the shadow user itself, so the value the
 * database stores is one we minted seconds earlier rather than one the caller chose.
 */
export function parseRedeemBody(raw: string): RedeemRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;

  const token = boundedString(body.token, MAX_TOKEN_CHARS);
  const identityPubkey = boundedString(body.identity_pubkey, MAX_PUBKEY_CHARS);
  const kemPubkey = boundedString(body.kem_pubkey, MAX_PUBKEY_CHARS);
  if (token === null || identityPubkey === null || kemPubkey === null) return null;

  // Shape only. The database revalidates both keys and is the authority on them. This check
  // exists so obvious garbage is rejected before we create an auth user for it.
  if (!BASE64ISH.test(identityPubkey) || !BASE64ISH.test(kemPubkey)) return null;

  return { token, identityPubkey, kemPubkey };
}

/**
 * The sequence.
 *
 * ORDER IS LOAD BEARING. peek is read only and runs FIRST, so a caller with a wrong,
 * expired, revoked or already redeemed token causes zero writes. Creating the shadow user
 * first would hand anyone on the internet an unbounded way to fill auth.users with orphan
 * rows, which is a worse endpoint than the one we are replacing.
 *
 * If the binding fails after the shadow user exists, the user is deleted again. The only
 * way to leak an orphan is for the worker to die between those two steps, which is why the
 * address is random rather than derived from the agent member: a derived address would be
 * permanently occupied by that orphan and would brick every later retry for that agent.
 */
export async function redeem(
  request: RedeemRequest | null,
  ports: RedeemPorts,
): Promise<RedeemOutcome> {
  const failure: RedeemOutcome = { status: FAILURE_STATUS, body: FAILURE_BODY };

  if (request === null) {
    ports.note("reject:shape");
    return failure;
  }

  const agentMemberId = await ports.peekInvitation(request.token);
  if (agentMemberId === null) {
    ports.note("reject:peek");
    return failure;
  }

  const shadowUserId = await ports.createShadowUser();
  if (shadowUserId === null) {
    ports.note("reject:shadow-user");
    return failure;
  }

  const bound = await ports.completeInvitation({ ...request, shadowUserId });
  if (!bound) {
    ports.note("reject:complete");
    await ports.deleteShadowUser(shadowUserId);
    return failure;
  }

  ports.note("ok");
  return {
    status: 200,
    body: JSON.stringify({ agent_member_id: agentMemberId, shadow_user_id: shadowUserId }),
  };
}
