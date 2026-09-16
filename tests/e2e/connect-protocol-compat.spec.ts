import { writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

/**
 * CONNECT PROTOCOL COMPATIBILITY: the previous-version handshake gate.
 *
 * WHY THIS FILE EXISTS
 *
 * connect.orangerails.com is a hosted surface with no version pin. On
 * 2026-06-19 an integrator's connect flow hung on the Stealth Sync screen
 * because the widget had shipped a new handshake and the integrator was
 * still on the old one. The ruling that followed is that the deployed
 * widget accepts a SET of protocol versions, exactly two live at a time
 * (current N and previous N-1), with a 90 day window before N-1 is
 * removed.
 *
 * A supported set is a promise. This file is what makes it true of the
 * artifact rather than true of a document.
 *
 * WHAT IT ASSERTS, AND WHY IT IS SHAPED THIS WAY
 *
 * It drives a full OR_STEALTH_INIT to terminal reply handshake against the
 * BUILT artifact, over a battery of INIT shapes, TWICE: once at the current
 * version and once at the previous one. It then requires the two runs to end
 * identically, message type for message type and error code for error code.
 *
 * The obvious alternative is to assert that an INIT at N-1 is accepted. That
 * check would go green while the N-1 semantics were quietly broken, and that
 * outcome is WORSE than the one we have today. Today a mismatched integrator
 * gets a typed PROTOCOL_VERSION_MISMATCH it can read and act on. A silently
 * wrong N-1 path is wrong behaviour in front of a customer wallet with no
 * error at all. So the assertion is equivalence of the terminal reply, not
 * acceptance of the version.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER
 *
 * No wallet scan, no key material, no credentials, no network. The battery
 * below is chosen so that every case reaches a terminal reply from the
 * widget's own INIT validation, deterministically and offline. That is the
 * protocol layer, which is the layer a version change breaks. It is NOT a
 * statement that a real sync works. Do not read a green tick here as one.
 *
 * WHY IT CANNOT QUIETLY PASS WHEN THERE IS NOTHING TO TEST
 *
 * Today exactly one version is live, so there is no N-1 to drive and the
 * previous-version case has nothing to exercise. A test that skipped here
 * would render green and would keep rendering green forever, which is the
 * precise failure shape this gate was written to end. Instead:
 *
 *   1. The previous-version test ALWAYS RUNS. When there is no N-1 it
 *      asserts that the skip is LEGITIMATE, which is true only while the
 *      supported set has exactly one member. The day the set grows and the
 *      previous version is still not drivable, this test goes red.
 *   2. It writes a machine readable verdict to CONNECT_COMPAT_VERDICT_PATH.
 *      The workflow step reads that file and decides pass, loud skip, or
 *      fail. A MISSING verdict file is a FAILURE there, because a check that
 *      did not report is not a check that passed.
 *
 * PROVING IT CAN GO RED
 *
 * Set CONNECT_COMPAT_NEGATIVE_CONTROL=1. The unsupported-version assertion
 * then expects a code the widget can never send, so the whole machinery runs
 * for real and the assertion genuinely fails. The workflow runs this before
 * the real run and fails the job if the negative control EXITS ZERO. A check
 * nobody has watched go red is untested.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The origin serving the BUILT artifact. Required. There is no default on
 * purpose: a default would let this suite silently test the wrong thing, for
 * example the deployed dev site instead of the build under review, and report
 * green about a bundle nobody is shipping.
 */
const BASE_URL = process.env.CONNECT_COMPAT_BASE_URL ?? '';

/** Where the machine readable verdict is written for the workflow to read. */
const VERDICT_PATH = process.env.CONNECT_COMPAT_VERDICT_PATH ?? 'connect-compat-verdict.json';

/** See "PROVING IT CAN GO RED" above. */
const NEGATIVE_CONTROL = process.env.CONNECT_COMPAT_NEGATIVE_CONTROL === '1';

/**
 * A same-origin blank document to drive the widget from. It is fulfilled by
 * Playwright rather than served by the app, so the harness does not depend on
 * any application page continuing to exist or to load cleanly. Same origin
 * matters: the widget always allows the origin it is itself served from, so
 * no allowlist environment variable has to be baked into the build.
 */
const HARNESS_PATH = '/__connect-compat-harness';

/** Where the widget is mounted. Mirrors STEALTH_WIDGET_PATH. */
const WIDGET_PATH = '/connect/stealth';

/** Per-handshake budget. Generous: a slow runner must not read as a hang. */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * Every terminal widget reply. A reply outside this set (READY, PROGRESS, the
 * proxy pair) means the handshake is still in flight, not finished.
 */
const TERMINAL_TYPES = [
  'OR_STEALTH_ERROR',
  'OR_STEALTH_ADD_COMPLETE',
  'OR_STEALTH_SYNC_COMPLETE',
  'OR_STEALTH_LIST_RESULT',
  'OR_STEALTH_DELETE_COMPLETE',
];

/**
 * A version no build will ever support, used to prove the reject path is
 * typed and terminal rather than a hang. Deliberately far from any plausible
 * real version so it cannot collide with a future bump.
 */
const NEVER_SUPPORTED_VERSION = 999_001;

/**
 * The INIT battery. Every case reaches a terminal reply from the widget's own
 * INIT validation with no network and no credentials, and each one sits at a
 * different rung of that validation ladder, so a change anywhere in it shows
 * up as a divergence between the two versions.
 *
 * The expected code is recorded for readability only. The ASSERTION is that
 * the current and previous versions agree with EACH OTHER, not that either
 * matches a code written down here: pinning the codes would make this file a
 * second, competing specification that goes red every time the copy changes.
 */
const INIT_BATTERY: Array<{ name: string; expectedCodeToday: string; init: Record<string, unknown> }> = [
  {
    name: 'missing app_slug',
    expectedCodeToday: 'INTERNAL',
    init: { app_user_id: 'compat-user', mode: 'add', or_stealth_key_b64: 'AAAA' },
  },
  {
    name: 'widget mode with no key',
    expectedCodeToday: 'INTERNAL',
    init: { app_slug: 'compat', app_user_id: 'compat-user', mode: 'add' },
  },
  {
    name: 'app mode carrying a key',
    expectedCodeToday: 'INTERNAL',
    init: {
      app_slug: 'compat',
      app_user_id: 'compat-user',
      mode: 'add',
      seal_mode: 'app',
      or_stealth_key_b64: 'AAAA',
    },
  },
  {
    name: 'gap_limit out of range',
    expectedCodeToday: 'INVALID_GAP_LIMIT',
    init: {
      app_slug: 'compat',
      app_user_id: 'compat-user',
      mode: 'add',
      or_stealth_key_b64: 'AAAA',
      gap_limit: 0,
    },
  },
  {
    name: 'sync with no connection_id',
    expectedCodeToday: 'CONNECTION_NOT_FOUND',
    init: {
      app_slug: 'compat',
      app_user_id: 'compat-user',
      mode: 'sync',
      or_stealth_key_b64: 'AAAA',
    },
  },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HandshakeResult {
  /** 'TERMINAL' when a terminal reply arrived, 'TIMEOUT' when none did. */
  reason: string;
  /** The OR_STEALTH_READY message, or null if the widget never announced. */
  ready: { protocol_version?: number; supported_protocol_versions?: number[] } | null;
  /** Every OR_STEALTH_ message after READY, reduced to type and code. */
  seen: Array<{ type: string; code: string | null }>;
  /** The terminal reply, or null. */
  terminal: { type: string; code: string | null } | null;
}

/**
 * Drive one full handshake against the built artifact in a fresh iframe:
 * load the widget, wait for OR_STEALTH_READY, post OR_STEALTH_INIT, and
 * collect replies until a terminal one arrives or the budget expires.
 *
 * A TIMEOUT is returned rather than thrown, because "the widget never
 * replied" is a RESULT this gate exists to catch. It is the exact 2026-06-19
 * symptom, and a thrown error would be indistinguishable from the harness
 * itself breaking.
 */
async function handshake(
  page: import('@playwright/test').Page,
  init: Record<string, unknown>,
): Promise<HandshakeResult> {
  return page.evaluate(
    async ({ widgetPath, terminalTypes, initPayload, timeoutMs }) => {
      const origin = window.location.origin;
      const iframe = document.createElement('iframe');
      iframe.setAttribute('style', 'width:900px;height:700px;border:0');

      const result = await new Promise<HandshakeResult>((resolve) => {
        let ready: HandshakeResult['ready'] = null;
        const seen: HandshakeResult['seen'] = [];

        const finish = (reason: string) => {
          window.clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          resolve({
            reason,
            ready,
            seen,
            terminal: seen.find((m) => terminalTypes.includes(m.type)) ?? null,
          });
        };

        const timer = window.setTimeout(() => finish('TIMEOUT'), timeoutMs);

        const onMessage = (event: MessageEvent) => {
          // Only listen to the frame we created. Other app code on the page
          // may postMessage for its own reasons.
          if (event.source !== iframe.contentWindow) return;
          const data = event.data as Record<string, unknown> | undefined;
          if (!data || typeof data.type !== 'string') return;
          if (!data.type.startsWith('OR_STEALTH_')) return;

          if (data.type === 'OR_STEALTH_READY') {
            ready = data as HandshakeResult['ready'];
            // return_callback_origin must equal the real sender origin or the
            // widget refuses before it ever looks at the version.
            iframe.contentWindow?.postMessage(
              { ...initPayload, type: 'OR_STEALTH_INIT', return_callback_origin: origin },
              origin,
            );
            return;
          }

          seen.push({
            type: data.type,
            code: typeof data.code === 'string' ? data.code : null,
          });
          if (terminalTypes.includes(data.type)) finish('TERMINAL');
        };

        window.addEventListener('message', onMessage);
        iframe.src = widgetPath;
        document.body.appendChild(iframe);
      });

      iframe.remove();
      return result;
    },
    {
      widgetPath: WIDGET_PATH,
      terminalTypes: TERMINAL_TYPES,
      initPayload: init,
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
    },
  );
}

/** Compact, stable description of a terminal reply, for comparison and logs. */
function describeTerminal(r: HandshakeResult): string {
  if (r.reason !== 'TERMINAL' || !r.terminal) return `NO TERMINAL REPLY (${r.reason})`;
  return r.terminal.code ? `${r.terminal.type}/${r.terminal.code}` : r.terminal.type;
}

/**
 * The supported set as the ARTIFACT itself advertises it, not as our source
 * claims it. READY carries supported_protocol_versions once the widget speaks
 * more than one version; before that it carries a single protocol_version.
 * Reading it from READY means this gate needs no change on the day the set
 * arrives, and it means the gate is measuring the thing we ship.
 */
function supportedVersionsFrom(ready: HandshakeResult['ready']): number[] {
  if (!ready) return [];
  const advertised = ready.supported_protocol_versions;
  if (Array.isArray(advertised) && advertised.length > 0 && advertised.every((v) => typeof v === 'number')) {
    return [...advertised].sort((a, b) => a - b);
  }
  return typeof ready.protocol_version === 'number' ? [ready.protocol_version] : [];
}

let verdict: Record<string, unknown> = {
  status: 'NOT_REACHED',
  detail: 'The suite did not run to the point of writing a verdict.',
};

function writeVerdict(next: Record<string, unknown>): void {
  verdict = { ...next, written_at_utc: new Date().toISOString(), base_url: BASE_URL };
  writeFileSync(VERDICT_PATH, `${JSON.stringify(verdict, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Connect protocol compatibility', () => {
  // Serial: the three cases build on each other and the verdict file is
  // written once, at the end, by the third.
  test.describe.configure({ mode: 'serial' });

  // A beforeAll guard, NOT a module-level throw. Playwright imports every
  // spec under testDir to enumerate tests, so a module-level throw here would
  // crash collection for the whole repository's suite, including jobs that
  // have no business running this file.
  test.beforeAll(() => {
    if (!BASE_URL) {
      throw new Error(
        'CONNECT_COMPAT_BASE_URL is not set. This suite must be pointed at the origin ' +
          'serving the BUILT artifact under review. There is no default: a default would ' +
          'let it report green about a bundle nobody is shipping.',
      );
    }
    writeVerdict({
      status: 'STARTED',
      detail: 'The suite started and has not yet reached a conclusion.',
    });
  });

  test.beforeEach(async ({ page }) => {
    // Serve the driving document ourselves, on the widget's own origin.
    await page.route(`${BASE_URL}${HARNESS_PATH}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><head><title>connect compat harness</title></head><body></body></html>',
      }),
    );
    await page.goto(`${BASE_URL}${HARNESS_PATH}`);
  });

  test('preflight: the built artifact serves the widget and announces itself', async ({ page }) => {
    // This case exists to separate two failures that look identical from the
    // outside: "the previous version is broken" and "the harness could not
    // reach the widget at all". If this one is red, nothing below it means
    // anything, and the answer is UNKNOWN rather than a protocol regression.
    const widget = await page.request.get(`${BASE_URL}${WIDGET_PATH}`);
    expect(
      widget.status(),
      `The built artifact did not serve ${WIDGET_PATH}. This is a harness or build ` +
        'problem, not a protocol result: nothing below can be trusted until it is fixed.',
    ).toBe(200);

    const result = await handshake(page, {
      app_slug: 'compat',
      app_user_id: 'compat-user',
      mode: 'add',
      or_stealth_key_b64: 'AAAA',
      protocol_version: NEVER_SUPPORTED_VERSION,
    });

    expect(
      result.ready,
      'The widget never sent OR_STEALTH_READY. Either the artifact is not being served ' +
        'from the expected path, or it failed to boot. Not a protocol verdict.',
    ).not.toBeNull();

    const supported = supportedVersionsFrom(result.ready);
    expect(
      supported.length,
      'OR_STEALTH_READY carried neither supported_protocol_versions nor a numeric ' +
        'protocol_version, so the artifact does not say what it speaks and this gate ' +
        'has nothing to measure.',
    ).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(`[connect-compat] artifact advertises supported version(s): ${supported.join(', ')}`);
  });

  test('an unsupported protocol version is refused with a typed terminal reply', async ({ page }) => {
    // The liveness half of this gate, and the half that can fail TODAY with a
    // single version live. It proves the artifact boots, the handshake
    // transport works end to end, and a version it does not speak produces a
    // typed terminal error rather than the silent hang of 2026-06-19.
    const result = await handshake(page, {
      app_slug: 'compat',
      app_user_id: 'compat-user',
      mode: 'add',
      or_stealth_key_b64: 'AAAA',
      protocol_version: NEVER_SUPPORTED_VERSION,
    });

    expect(
      result.reason,
      `An INIT at an unsupported version produced no terminal reply within ` +
        `${HANDSHAKE_TIMEOUT_MS}ms. That is the hang this gate exists to catch: an ` +
        'integrator on the wrong version must get a typed error, not silence.',
    ).toBe('TERMINAL');

    expect(result.terminal?.type).toBe('OR_STEALTH_ERROR');

    // The negative control substitutes a code the widget can never send, so
    // the assertion below fails for real, through the real machinery, with a
    // real handshake behind it. See the header.
    const expectedCode = NEGATIVE_CONTROL
      ? 'CONNECT_COMPAT_NEGATIVE_CONTROL_SENTINEL'
      : 'PROTOCOL_VERSION_MISMATCH';

    expect(
      result.terminal?.code,
      NEGATIVE_CONTROL
        ? 'NEGATIVE CONTROL: this assertion is expected to fail. If it passed, the ' +
            'harness is not asserting anything and every green run above is worthless.'
        : 'An unsupported version must be refused with PROTOCOL_VERSION_MISMATCH. A ' +
            'different code means an integrator cannot tell a version problem from any ' +
            'other failure.',
    ).toBe(expectedCode);
  });

  test('the previous protocol version behaves identically to the current one', async ({ page }) => {
    // ALWAYS RUNS. It never calls test.skip(), because a skipped Playwright
    // case renders green and would keep rendering green for as long as one
    // version is live, which is exactly the shape this gate exists to end.
    const probe = await handshake(page, {
      app_slug: 'compat',
      app_user_id: 'compat-user',
      mode: 'add',
      or_stealth_key_b64: 'AAAA',
      protocol_version: NEVER_SUPPORTED_VERSION,
    });
    const supported = supportedVersionsFrom(probe.ready);
    expect(supported.length, 'No supported version set could be read from the artifact.').toBeGreaterThan(0);

    const current = Math.max(...supported);
    const previous = current - 1;
    const previousIsLive = supported.includes(previous);

    if (!previousIsLive) {
      // The skip is only legal while exactly ONE version is live. If the set
      // has grown and the immediately previous version still is not in it,
      // either the set is wrong or this gate is wrong, and somebody must look.
      // Failing here is the whole reason this case is not a test.skip().
      writeVerdict({
        status: 'SKIPPED',
        supported,
        current,
        previous,
        detail:
          `Only version ${current} is live, so there is no previous version to drive. ` +
          'This is a SKIP, not a pass. It becomes a failure the moment the supported ' +
          'set grows.',
      });

      expect(
        supported.length,
        `The artifact advertises ${supported.length} supported versions (${supported.join(', ')}) ` +
          `but not ${previous}, so the previous-version handshake could not be driven. ` +
          'A skip is only legitimate while exactly one version is live. Either the ' +
          'supported set is wrong, or this gate needs to learn how to drive it.',
      ).toBe(1);

      // eslint-disable-next-line no-console
      console.log(
        `[connect-compat] SKIPPED: only version ${current} is live. Nothing to compare. ` +
          'This is not a pass.',
      );
      return;
    }

    const divergences: string[] = [];
    for (const item of INIT_BATTERY) {
      const atCurrent = await handshake(page, { ...item.init, protocol_version: current });
      const atPrevious = await handshake(page, { ...item.init, protocol_version: previous });

      const a = describeTerminal(atCurrent);
      const b = describeTerminal(atPrevious);
      // eslint-disable-next-line no-console
      console.log(`[connect-compat] ${item.name}: v${current} -> ${a} | v${previous} -> ${b}`);

      if (atPrevious.reason !== 'TERMINAL') {
        divergences.push(
          `${item.name}: v${previous} produced no terminal reply (${atPrevious.reason}). ` +
            'An integrator on the previous version would hang here.',
        );
        continue;
      }
      if (atPrevious.terminal?.code === 'PROTOCOL_VERSION_MISMATCH') {
        divergences.push(
          `${item.name}: v${previous} was refused as an unsupported version, but the ` +
            'artifact advertises it as supported. The set and the behaviour disagree.',
        );
        continue;
      }
      if (a !== b) {
        divergences.push(`${item.name}: v${current} gave ${a} but v${previous} gave ${b}.`);
      }
    }

    writeVerdict({
      status: divergences.length === 0 ? 'RAN_PASS' : 'RAN_FAIL',
      supported,
      current,
      previous,
      cases: INIT_BATTERY.length,
      divergences,
      detail:
        divergences.length === 0
          ? `Drove ${INIT_BATTERY.length} INIT shapes at v${current} and v${previous}; ` +
            'every terminal reply matched.'
          : `${divergences.length} of ${INIT_BATTERY.length} INIT shapes diverged.`,
    });

    expect(
      divergences,
      `The previous protocol version (v${previous}) does not behave like the current one ` +
        `(v${current}) against this build. Every line below is a way an integrator still ` +
        'on the previous version gets different behaviour from the one we promised them:\n' +
        divergences.map((d) => `  - ${d}`).join('\n'),
    ).toEqual([]);
  });
});
