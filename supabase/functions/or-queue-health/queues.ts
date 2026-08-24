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
    // Two hours matches the threshold or-quiltt-drain-alert already uses, so
    // the two probes agree on what "stalled" means. The dispatcher runs every
    // minute, so two hours is roughly 120 missed drains: far past noise and
    // still far short of the 73 days this queue actually sat untouched.
    coverage: { kind: 'watched', stallHours: 2 },
    blindSpots: [
      'A delivery that returned 2xx while the consumer recorded nothing is ' +
      'stamped succeeded_at and looks perfectly drained here (DL-1565).',
      'A row that exhausted MAX_ATTEMPTS still has succeeded_at NULL, so it ' +
      'will alert forever rather than being reported as given up. That is ' +
      'deliberate for now: nothing currently retires these rows, and a queue ' +
      'that quietly discards notifications is the worse failure.',
    ],
  },
  {
    table: 'strike_webhook_events',
    enqueuedAt: 'received_at',
    drainedAt: 'processed_at',
    alsoTerminal: [],
    coverage: { kind: 'watched', stallHours: 2 },
    blindSpots: [
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

/** The queues this probe actually queries. */
export function watchedQueues(): QueueDefinition[] {
  return QUEUES.filter((q) => q.coverage.kind === 'watched');
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

/** True when this queue has an undrained row older than its threshold. */
export function isStalled(
  queue: QueueDefinition,
  oldestEnqueuedAt: string | null,
  now: Date,
): boolean {
  if (queue.coverage.kind !== 'watched') return false;
  const age = ageHours(oldestEnqueuedAt, now);
  return age !== null && age > queue.coverage.stallHours;
}
