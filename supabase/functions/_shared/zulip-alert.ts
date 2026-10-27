/**
 * Post a message to a Zulip stream. Used for operational alerts that must
 * reach a human directly, not through GlitchTip (dead, DL-0603).
 *
 * Same request shape as the postToZulip() already used by
 * or-queue-health/index.ts, pulled out here so a second caller (or-sync,
 * OR-T0335) does not have to duplicate the fetch/auth boilerplate. Returns
 * false (never throws) on any failure so a chat outage cannot take down the
 * caller's own request handling; callers must check the return value if
 * "did the page actually go out" matters to them.
 *
 * Env vars: ZULIP_BOT_EMAIL, ZULIP_API_KEY, ZULIP_API_URL
 */
export async function postToZulip(stream: string, topic: string, message: string): Promise<boolean> {
  const botEmail = Deno.env.get('ZULIP_BOT_EMAIL');
  const apiKey = Deno.env.get('ZULIP_API_KEY');
  const apiUrl = Deno.env.get('ZULIP_API_URL');

  if (!botEmail || !apiKey || !apiUrl) {
    console.error(`[zulip-alert] Zulip env vars missing; alert not posted to #${stream}`);
    return false;
  }

  const params = new URLSearchParams({
    type: 'stream',
    to: stream,
    topic,
    content: message,
  });

  try {
    const res = await fetch(`${apiUrl}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(`${botEmail}:${apiKey}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[zulip-alert] post to #${stream} failed (${res.status}): ${text.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[zulip-alert] post to #${stream} threw:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
