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
  /**
   * Sequence numbers that have been reported to a master (sent in a response or
   * unsolicited fragment) but not yet APPLICATION-CONFIRMed. Per DNP3 these stay
   * buffered until confirmed, but they MUST NOT re-trigger an unsolicited
   * response — only *un-reported* events drive the count/delay triggers.
   */
  reported: Set<number>;
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
    return { config, events: [], reported: new Set(), oldestUnreportedAt: null, overflowed: false };
  }

  /** Un-reported events for a class, in FIFO order. */
  private unreportedOf(q: ClassQueue): Dnp3Event[] {
    return q.events.filter((e) => !q.reported.has(e.seq));
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
      const dropped = q.events.shift(); // drop oldest
      if (dropped) q.reported.delete(dropped.seq);
      q.overflowed = true;
      this.overflowFlag = true;
    }
    q.events.push(full);
    // A freshly-enqueued event is un-reported; reset the oldest-unreported timer
    // only when no un-reported event was previously pending.
    if (q.oldestUnreportedAt === null) {
      q.oldestUnreportedAt = event.timestamp;
    }
    return seq;
  }

  /** Total buffered events across all classes. */
  size(): number {
    return this.queues[1].events.length + this.queues[2].events.length + this.queues[3].events.length;
  }

  /** Buffered count for one class (incl. reported-but-unconfirmed). */
  classSize(cls: EventClass): number {
    return this.queues[cls].events.length;
  }

  /** Un-reported (trigger-eligible) count for one class. */
  unreportedSize(cls: EventClass): number {
    return this.unreportedOf(this.queues[cls]).length;
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
   * here we keep them buffered but flag them reported so they no longer drive
   * the unsolicited count/delay triggers — preventing an unsolicited storm where
   * the same events re-fire on every evaluation tick. The per-class
   * "oldest unreported" timer is recomputed from what remains un-reported.
   */
  markReported(seqs: number[]): void {
    const set = new Set(seqs);
    for (const cls of [1, 2, 3] as EventClass[]) {
      const q = this.queues[cls];
      for (const e of q.events) {
        if (set.has(e.seq)) q.reported.add(e.seq);
      }
      const unreported = this.unreportedOf(q);
      q.oldestUnreportedAt = unreported.length ? unreported[0].timestamp : null;
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
      for (const seq of set) q.reported.delete(seq);
      const unreported = this.unreportedOf(q);
      q.oldestUnreportedAt = unreported.length ? unreported[0].timestamp : null;
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
      // Only UN-REPORTED events drive the trigger. Reported-but-unconfirmed
      // events stay buffered (DNP3 confirm semantics) but must not re-fire.
      const unreportedCount = this.unreportedOf(q).length;
      if (unreportedCount === 0) continue;

      const threshold = q.config.unsolicitedThreshold;
      if (threshold > 0 && unreportedCount >= threshold) {
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
