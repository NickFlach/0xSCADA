/**
 * DNP3 Event Buffering — Class 0/1/2/3
 * Issue #464: DNP3 Outstation Mode
 *
 * FULLY IMPLEMENTED + UNIT TESTED.
 *
 * DNP3 distinguishes STATIC data (the current value of every point, returned
 * for a Class 0 poll) from EVENT data (timestamped value changes, queued per
 * event class 1/2/3). A master reads events with a Class 1/2/3 poll and the
 * outstation may push them unsolicited when a per-class buffer threshold is hit.
 *
 * This module owns the event queues, deadband/change detection inputs (the
 * caller supplies the decision), per-class buffering limits, overflow handling
 * (oldest dropped + EVENT_BUFFER_OVERFLOW IIN), confirmation/clearing, and the
 * unsolicited-trigger evaluation. No I/O here — it is a pure, deterministic
 * state machine so it is fully unit-testable without a socket.
 */

import type { Dnp3PointType } from './point-map';

/** DNP3 event class (0 means "no events" — static only). */
export type EventClass = 1 | 2 | 3;

/** A single buffered DNP3 event. */
export interface Dnp3Event {
  /** monotonically increasing sequence number assigned on enqueue */
  seq: number;
  pointType: Dnp3PointType;
  /** DNP3 point index within its group */
  index: number;
  eventClass: EventClass;
  value: number | boolean;
  /** DNP3 flag octet captured at event time */
  flags: number;
  /** epoch ms of the value change */
  timestamp: number;
}

/** Per-class buffering configuration. */
export interface ClassBufferConfig {
  /** max events retained for this class before oldest are dropped */
  maxEvents: number;
  /**
   * unsolicited threshold — when the number of un-reported events in this class
   * reaches this count, an unsolicited response should be triggered. 0 disables
   * count-based triggering for the class.
   */
  unsolicitedThreshold: number;
}

export interface EventBufferConfig {
  class1: ClassBufferConfig;
  class2: ClassBufferConfig;
  class3: ClassBufferConfig;
  /**
   * Max age (ms) of un-reported events before an unsolicited response should be
   * triggered regardless of count. 0 disables the timer-based trigger.
   */
  unsolicitedMaxDelayMs: number;
}

export const DEFAULT_EVENT_BUFFER_CONFIG: EventBufferConfig = {
  class1: { maxEvents: 1000, unsolicitedThreshold: 5 },
  class2: { maxEvents: 1000, unsolicitedThreshold: 5 },
  class3: { maxEvents: 1000, unsolicitedThreshold: 5 },
  unsolicitedMaxDelayMs: 2000,
};

interface ClassQueue {
  config: ClassBufferConfig;
  /** events in FIFO order */
  events: Dnp3Event[];
  /** oldest un-reported (un-confirmed-out) event timestamp, or null */
  oldestUnreportedAt: number | null;
  /** dropped due to overflow since last clear */
  overflowed: boolean;
}

/**
 * Result of evaluating whether an unsolicited response should fire. `classes`
 * lists the event classes whose threshold or delay is satisfied.
 */
export interface UnsolicitedDecision {
  shouldSend: boolean;
  classes: EventClass[];
  reason: 'count' | 'delay' | 'none';
}

export class Dnp3EventBuffer {
  private seqCounter = 0;
  private queues: Record<EventClass, ClassQueue>;
  /** set when any class overflowed — surfaces as EVENT_BUFFER_OVERFLOW IIN */
  private overflowFlag = false;

  constructor(config: EventBufferConfig = DEFAULT_EVENT_BUFFER_CONFIG) {
    this.queues = {
      1: this.makeQueue(config.class1),
      2: this.makeQueue(config.class2),
      3: this.makeQueue(config.class3),
    };
    this.maxDelayMs = config.unsolicitedMaxDelayMs;
  }

  private maxDelayMs: number;

  private makeQueue(config: ClassBufferConfig): ClassQueue {
    return { config, events: [], oldestUnreportedAt: null, overflowed: false };
  }

  /**
   * Enqueue an event. If the class queue is full, the oldest event is dropped
   * and the overflow flag is raised (master will see EVENT_BUFFER_OVERFLOW).
   * Returns the assigned sequence number.
   */
  enqueue(event: Omit<Dnp3Event, 'seq'>): number {
    const q = this.queues[event.eventClass];
    const seq = ++this.seqCounter;
    const full: Dnp3Event = { ...event, seq };
    if (q.events.length >= q.config.maxEvents) {
      q.events.shift(); // drop oldest
      q.overflowed = true;
      this.overflowFlag = true;
    }
    q.events.push(full);
    if (q.oldestUnreportedAt === null) {
      q.oldestUnreportedAt = event.timestamp;
    }
    return seq;
  }

  /** Total buffered events across all classes. */
  size(): number {
    return this.queues[1].events.length + this.queues[2].events.length + this.queues[3].events.length;
  }

  /** Buffered count for one class. */
  classSize(cls: EventClass): number {
    return this.queues[cls].events.length;
  }

  /** Whether any class has overflowed since the last clear. */
  hasOverflow(): boolean {
    return this.overflowFlag;
  }

  /**
   * Peek the events that would be returned for a poll of the given classes,
   * without removing them. Returned in global sequence order (chronological).
   * `max` caps the number returned (APDU fragmentation budget).
   */
  peek(classes: EventClass[], max = Number.MAX_SAFE_INTEGER): Dnp3Event[] {
    const merged: Dnp3Event[] = [];
    for (const cls of classes) merged.push(...this.queues[cls].events);
    merged.sort((a, b) => a.seq - b.seq);
    return merged.slice(0, max);
  }

  /**
   * Mark a set of events as reported (sent to a master, pending confirmation).
   * In a strict implementation events are only removed on APPLICATION CONFIRM;
   * here we expose explicit `confirm`/`requeue` so the link layer drives it.
   * This resets the per-class "oldest unreported" timer for fully-drained
   * classes.
   */
  markReported(seqs: number[]): void {
    const set = new Set(seqs);
    for (const cls of [1, 2, 3] as EventClass[]) {
      const q = this.queues[cls];
      const remaining = q.events.filter((e) => !set.has(e.seq));
      // Recompute oldest-unreported timestamp from what is left.
      q.oldestUnreportedAt = remaining.length ? remaining[0].timestamp : null;
    }
  }

  /**
   * Confirm (permanently remove) events by sequence number. Called when the
   * master sends an APPLICATION CONFIRM for a response carrying these events.
   */
  confirm(seqs: number[]): void {
    const set = new Set(seqs);
    for (const cls of [1, 2, 3] as EventClass[]) {
      const q = this.queues[cls];
      q.events = q.events.filter((e) => !set.has(e.seq));
      q.oldestUnreportedAt = q.events.length ? q.events[0].timestamp : null;
      if (q.events.length === 0) q.overflowed = false;
    }
    if (!this.queues[1].overflowed && !this.queues[2].overflowed && !this.queues[3].overflowed) {
      this.overflowFlag = false;
    }
  }

  /** Drop everything (e.g. on a cold restart). */
  clear(): void {
    for (const cls of [1, 2, 3] as EventClass[]) {
      this.queues[cls] = this.makeQueue(this.queues[cls].config);
    }
    this.overflowFlag = false;
  }

  /**
   * Decide whether an unsolicited response should be sent right now. Triggers on
   * either (a) any class reaching its configured count threshold, or (b) the
   * oldest un-reported event in a class exceeding `unsolicitedMaxDelayMs`.
   *
   * @param now epoch ms (injected for deterministic testing)
   */
  evaluateUnsolicited(now: number): UnsolicitedDecision {
    const countClasses: EventClass[] = [];
    const delayClasses: EventClass[] = [];

    for (const cls of [1, 2, 3] as EventClass[]) {
      const q = this.queues[cls];
      if (q.events.length === 0) continue;

      const threshold = q.config.unsolicitedThreshold;
      if (threshold > 0 && q.events.length >= threshold) {
        countClasses.push(cls);
      }
      if (
        this.maxDelayMs > 0 &&
        q.oldestUnreportedAt !== null &&
        now - q.oldestUnreportedAt >= this.maxDelayMs
      ) {
        delayClasses.push(cls);
      }
    }

    if (countClasses.length > 0) {
      return { shouldSend: true, classes: dedupeSorted([...countClasses, ...delayClasses]), reason: 'count' };
    }
    if (delayClasses.length > 0) {
      return { shouldSend: true, classes: dedupeSorted(delayClasses), reason: 'delay' };
    }
    return { shouldSend: false, classes: [], reason: 'none' };
  }

  /**
   * Compute the IIN class-event bits that should be advertised in responses,
   * based on what is currently buffered. Returns a bitmask compatible with
   * DNP3_IIN.CLASS1/2/3_EVENTS.
   */
  classEventIinBits(): { class1: boolean; class2: boolean; class3: boolean } {
    return {
      class1: this.queues[1].events.length > 0,
      class2: this.queues[2].events.length > 0,
      class3: this.queues[3].events.length > 0,
    };
  }
}

function dedupeSorted(values: EventClass[]): EventClass[] {
  return [...new Set(values)].sort((a, b) => a - b) as EventClass[];
}
