/**
 * The queue coverage map.
 *
 * WHY THIS FILE EXISTS. This estate has had two separate "a drain stopped and
 * nobody noticed" incidents on two different pipelines, months apart, and both
 * were found by a person chasing a customer complaint rather than by any
 * monitor. DL-0460: the Quiltt inbox drain was silently dead for 16 days.
 * DL-1562: the outbound webhook dispatcher was never invoked at all, and 52
 * notifications sat with attempts = 0 for ten weeks.
 *
 * In both cases the evidence was one query away. Nobody was running it, because
 * monitoring was attached to a pipeline rather than to the shape. So the fix is
 * not another per-pipeline alert. It is a map, kept in code, of every queue and
 * who watches it, with a test that fails when a new queue table appears and is
 * not accounted for here. A queue added tomorrow cannot be uncovered by
 * accident; somebody has to write down either a threshold or an owner.
 *
 * WHY AGE, AND ONLY AGE. The age of the oldest undrained row is the one signal
 * that is true no matter WHY a drain stopped: no invoker, broken invoker, dead
 * credential, expired vault secret, or a poison row wedged at the head. Every
 * other signal is a guess about a specific failure. This probe deliberately
 * carries one signal and says out loud, per queue, what it cannot see.
 *
 * WHAT AN AGE PROBE CANNOT SEE, EVER. Both of these have already happened here
 * and neither would have fired this probe, which is why `blindSpots` is a
 * required field rather than a comment:
 *
 *   1. A queue that is empty because nothing can WRITE to it. Rejected
 *      deliveries never become rows, so the table stays clean and young while
 *      the pipeline is completely dead (DL-1505).
 *   2. A row that was DESTROYED rather than drained. If the drain stamps the
 *      same column on give-up as it does on success, a discarded event is
 *      indistinguishable from a delivered one by age alone (DL-1540).
 */

/** Who watches a queue, and on what terms. */
export type QueueCoverage =
  | {
    kind: 'watched';
    /** Fire when the oldest undrained row is older than this. */
    stallHours: number;
  }
  | {
    kind: 'delegated';
    /** The probe that already covers it. Must be a real, deployed function. */
    owner: string;
    /** Why duplicating it here would be worse than deferring. */
    why: string;
  }
  | {
    /**
     * There is no scheduled drain, so age is a meaningless signal: rows sit
     * until something external happens, and that is CORRECT behaviour rather
     * than a stall. Alerting on age here would fire forever for every inactive
     * user and train everyone to ignore this channel.
     *
     * This is not the same as 'delegated'. Delegated means somebody else is
     * watching. This means NOBODY is watching, and we are saying so out loud
     * rather than pretending an age threshold covers it.
     */
    kind: 'unmonitorable';
    /** What would actually have to be built to cover this queue. */
    needs: string;
  };

export interface QueueDefinition {
  /** Table name, exactly as it appears in a migration. */
  table: string;
  /** Column stamped when the row joins the queue. */
  enqueuedAt: string;
  /** Column stamped when the row leaves it. NULL means still queued. */
  drainedAt: string;
  /**
   * Columns that, when non-NULL, mean the row left the queue by some route
   * other than `drainedAt`. Retired, cancelled, superseded. Excluded from the
   * age calculation so a deliberately abandoned row does not alert forever.
   */
  alsoTerminal: string[];
  /**
   * Once `column` (a retry counter) reaches `ceiling`, the drain stops picking
   * the row up and leaves it as it is. Such a row never drains, so it is given
   * up on rather than stalled, and it is left out of the age calculation. This
   * probe does not report those rows at all: say so in `blindSpots`. `ceiling`
   * must equal the drain's own retry limit, and a test compares the two.
   */
  giveUpAt?: { column: string; ceiling: number };
  coverage: QueueCoverage;
  /** What this probe cannot see about this queue. Required, on purpose. */
  blindSpots: string[];
}

export const QUEUES: QueueDefinition[] = [
  {
    table: 'webhook_delivery',
    enqueuedAt: 'created_at',
    drainedAt: 'succeeded_at',
    alsoTerminal: [],
    // or-webhook-dispatch retries a row only while attempts is below its
    // MAX_ATTEMPTS (5) and then leaves it as it is. A test fails if this
    // ceiling stops matching that constant.
    giveUpAt: { column: 'attempts', ceiling: 5 },
    // Two hours matches the threshold or-quiltt-drain-alert already uses, so
    // the two probes agree on what "stalled" means. The dispatcher runs every
    // minute, so two hours is roughly 120 missed drains: far past noise and
    // still far short of the 73 days this queue actually sat untouched.
    coverage: { kind: 'watched', stallHours: 2 },
    blindSpots: [
      'A delivery that returned 2xx while the consumer recorded nothing is ' +
      'stamped succeeded_at and looks perfectly drained here (DL-1565).',
      'A row that exhausted its retries (attempts at the dispatcher ceiling) ' +
      'is left out of the age calculation on purpose: the dispatcher stops ' +
      'picking it up, so it will never drain and is not stalled. This probe ' +
      'does not report those rows at all, so a queue that quietly piles them ' +
      'up looks healthy here. Counting given-up rows is a separate check.',
    ],
  },
  {
    table: 'strike_webhook_events',
    enqueuedAt: 'received_at',
    drainedAt: 'processed_at',
    alsoTerminal: [],
    // VERIFIED 2026-08-24: drainStrikeQueue() is called from exactly one place,
    // or-sync/index.ts, which is the user-initiated sync endpoint. No cron job
    // invokes it, and none can: the drain decrypts with the user's unlock key,
    // which only exists inside a request that user authenticated. So a row here
    // waits for its owner to next open the app, and a week-old row is normal for
    // anyone on holiday. An earlier draft of this file gave this queue a 2 hour
    // threshold, which would have alerted continuously for every inactive user.
    coverage: {
      kind: 'unmonitorable',
      needs:
        'A drain that does not need the user unlock key, or an arrival-rate ' +
        'signal that compares inserts against Strike deliveries. Age cannot ' +
        'work here while the only drain is user-initiated.',
    },
    blindSpots: [
      'Not watched at all, deliberately. See coverage.needs.',
      'This table held zero rows at the time of writing and every inbound ' +
      'Strike delivery was being rejected 401 before insert (DL-1505). An age ' +
      'probe cannot see that: an empty queue and a queue nothing can write to ' +
      'look identical. Whatever closes DL-1505 needs its own arrival signal.',
    ],
  },
  {
    table: 'quiltt_webhook_inbox',
    enqueuedAt: 'received_at',
    drainedAt: 'processed_at',
    alsoTerminal: ['retirement_reason'],
    coverage: {
      kind: 'delegated',
      owner: 'or-quiltt-drain-alert',
      why:
        'Signal C of that probe is this exact query, and signals A, B and D ' +
        'add cron run stats and destroyed-event detection that this one does ' +
        'not have. Two probes posting the same stall to the same Zulip topic ' +
        'is how an alert channel gets muted.',
    },
    blindSpots: [
      'Covered elsewhere. Listed here so the coverage map is complete rather ' +
      'than only listing what this probe happens to watch.',
    ],
  },
];

/**
 * The subset of a query builder that the "still queued" filter needs. Kept
 * structural so a test can pass a recorder instead of a database client.
 */
interface UndrainedQuery<T> {
  is(column: string, value: null): T;
  lt(column: string, value: number): T;
}

/**
 * Narrow a query to the rows of `q` that are still queued: the drain column is
 * NULL, every terminal column is NULL, and the row has not reached its give-up
 * ceiling. One place for the predicate, so the probe and the tests cannot
 * disagree about it.
 */
export function applyUndrainedFilters<T extends UndrainedQuery<T>>(
  query: T,
  q: QueueDefinition,
): T {
  let out = query.is(q.drainedAt, null);
  for (const col of q.alsoTerminal) out = out.is(col, null);
  if (q.giveUpAt) out = out.lt(q.giveUpAt.column, q.giveUpAt.ceiling);
  return out;
}

/** The queues this probe actually queries. */
export function watchedQueues(): QueueDefinition[] {
  return QUEUES.filter((q) => q.coverage.kind === 'watched');
}

/**
 * The queues NOBODY watches.
 *
 * Exported so the health report can carry them on every run, including a run
 * where everything checked came back healthy. A report that lists only what it
 * checked reads exactly like a report where nothing is uncovered, and the whole
 * argument of this probe is that the dangerous queue is the one nobody was
 * thinking about.
 */
export function unmonitoredQueues(): QueueDefinition[] {
  return QUEUES.filter((q) => q.coverage.kind === 'unmonitorable');
}

/**
 * Hours between `enqueuedAt` and now, for the oldest still-queued row.
 * Pure, so the threshold logic is testable without a database.
 */
export function ageHours(oldestEnqueuedAt: string | null, now: Date): number | null {
  if (oldestEnqueuedAt === null) return null;
  const then = new Date(oldestEnqueuedAt).getTime();
  if (Number.isNaN(then)) return null;
  return (now.getTime() - then) / (60 * 60 * 1000);
}

/**
 * The verdict for one queue.
 *
 * THREE states, not two, and that is the whole point. Ruled on #378,
 * 2026-08-01: "I could not check must never report as OK". A boolean forces a
 * failed lookup to collapse into `false`, which reads as healthy, which is
 * exactly how a monitor becomes a thing that reassures you while blind.
 */
export type QueueVerdict =
  /** Queried successfully, oldest undrained row is within threshold. */
  | { state: 'ok'; ageHours: number | null }
  /** Queried successfully, oldest undrained row is past threshold. */
  | { state: 'stalled'; ageHours: number }
  /** Not queried, or the query failed. NEVER treat this as healthy. */
  | { state: 'unknown'; why: string };

/**
 * Turn a lookup result into a verdict.
 *
 * `lookupError` is separate from a null age on purpose. A null age means "no
 * undrained rows", which is the healthiest possible answer. An error means we
 * learned nothing, and those two must never share a return value.
 */
export function classify(
  queue: QueueDefinition,
  oldestEnqueuedAt: string | null,
  now: Date,
  lookupError?: string | null,
): QueueVerdict {
  if (lookupError) {
    return { state: 'unknown', why: `lookup failed: ${lookupError}` };
  }
  if (queue.coverage.kind === 'delegated') {
    return { state: 'unknown', why: `delegated to ${queue.coverage.owner}` };
  }
  if (queue.coverage.kind === 'unmonitorable') {
    return { state: 'unknown', why: `unmonitorable: ${queue.coverage.needs}` };
  }
  const age = ageHours(oldestEnqueuedAt, now);
  if (oldestEnqueuedAt !== null && age === null) {
    // A row exists but its timestamp did not parse. That is a real unknown,
    // not an empty queue, and silently treating it as empty would hide a
    // wedged row behind a clean bill of health.
    return { state: 'unknown', why: `unparseable ${queue.enqueuedAt}` };
  }
  if (age !== null && age > queue.coverage.stallHours) {
    return { state: 'stalled', ageHours: age };
  }
  return { state: 'ok', ageHours: age };
}
