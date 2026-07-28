/**
 * Tag-store bridge — binds a DNP3 point map to the live tag store so a master's
 * Class 0/1/2/3 polls observe live values and its controls reach real tags.
 *
 * Issue #464. Mirrors `modbus-server/tag-store-bridge.ts` (#462): the protocol
 * layer only knows abstract seams (`updateTag` in, `Dnp3ControlSink` out), and
 * the underlying store is hidden behind the minimal `Dnp3TagStorePort` so the
 * bridge is unit-testable without Redis. `createDnp3TagStorePort()` adapts the
 * real `tagCache` (server/services/cache/tag-cache.ts) to that port.
 *
 * Before this file existed the review's observation held: `setControlSink()` had
 * no caller outside tests, so a running outstation answered every control
 * NOT_SUPPORTED, and nothing fed `updateTag()`, so every point read back as its
 * seeded `bad`/zero placeholder.
 */

import { logError, logWarn } from "../../logger";
import { DNP3_COMMAND_STATUS, type PointQuality } from "./app-objects";
import type { Dnp3ControlCommand, Dnp3ControlOutcome, Dnp3ControlSink } from "./controls";
import { Dnp3PointMap, type PointSample } from "./point-map";

const LOG_SCOPE = "dnp3-outstation";

/**
 * Minimal async port over the live tag store. Reads return the full sample —
 * DNP3 needs the quality and the change timestamp, not just the value — and
 * `undefined` for a tag the store has never seen.
 */
export interface Dnp3TagStorePort {
  read(tagId: string): Promise<PointSample | undefined>;
  write(tagId: string, value: number | boolean): Promise<void>;
}

/** Simple in-memory `Dnp3TagStorePort` for tests and offline/dev usage. */
export class InMemoryDnp3TagStore implements Dnp3TagStorePort {
  private values = new Map<string, PointSample>();

  async read(tagId: string): Promise<PointSample | undefined> {
    return this.values.get(tagId);
  }

  async write(tagId: string, value: number | boolean): Promise<void> {
    const previous = this.values.get(tagId);
    this.values.set(tagId, {
      value,
      quality: previous?.quality ?? "good",
      timestamp: Date.now(),
    });
  }

  /** Test helper: seed a sample directly. */
  seed(tagId: string, sample: PointSample): void {
    this.values.set(tagId, sample);
  }

  /** Test helper: read back the current sample. */
  peek(tagId: string): PointSample | undefined {
    return this.values.get(tagId);
  }
}

/** Map the tag cache's quality enum onto the DNP3 flag-derivation input. */
export function toPointQuality(quality: "GOOD" | "BAD" | "UNCERTAIN"): PointQuality {
  switch (quality) {
    case "GOOD":
      return "good";
    case "UNCERTAIN":
      return "uncertain";
    default:
      return "bad";
  }
}

/**
 * Adapt the live `tagCache` to a `Dnp3TagStorePort` for a given site. Reads pull
 * the latest cached `TagValue`; writes publish a new `TagValue` with GOOD quality
 * and the current timestamp.
 *
 * The import is dynamic so this module (and the pure protocol layer that depends
 * on it transitively) can be unit-tested without pulling in the Redis cache
 * stack — the same arrangement the Modbus bridge uses.
 */
export function createDnp3TagStorePort(siteId: string): Dnp3TagStorePort {
  return {
    async read(tagId: string): Promise<PointSample | undefined> {
      const { tagCache } = await import("../../services/cache/tag-cache.js");
      const tag = await tagCache.getTagValue(siteId, tagId);
      if (!tag) return undefined;

      let value: number | boolean;
      if (typeof tag.value === "string") {
        const n = Number(tag.value);
        // A non-numeric string has no DNP3 representation in any of the five
        // static groups. Report the point as BAD rather than inventing a 0.
        if (!Number.isFinite(n)) {
          return {
            value: 0,
            quality: "bad",
            timestamp: tag.timestamp instanceof Date ? tag.timestamp.getTime() : Date.now(),
          };
        }
        value = n;
      } else {
        value = tag.value;
      }

      return {
        value,
        quality: toPointQuality(tag.quality),
        timestamp: tag.timestamp instanceof Date ? tag.timestamp.getTime() : Date.now(),
      };
    },
    async write(tagId: string, value: number | boolean): Promise<void> {
      const { tagCache } = await import("../../services/cache/tag-cache.js");
      await tagCache.setTagValue(siteId, {
        tagId,
        value,
        quality: "GOOD",
        timestamp: new Date(),
      });
    },
  };
}

/** The subset of `Dnp3Outstation` the poller drives. */
export interface Dnp3TagSink {
  updateTag(tagId: string, sample: PointSample): void;
}

/**
 * Polls every tag named by the point map and pushes it into the outstation, so
 * Class 0 reads reflect live values and Class 1/2/3 events are generated from
 * real changes.
 *
 * Polling (rather than a change subscription) is deliberate and is the honest
 * limitation to know about: the tag cache exposes no change feed, so the event
 * timestamps this produces are the store's own sample timestamps as seen at POLL
 * time, and a change that comes and goes inside one interval is not observed at
 * all. `pollIntervalMs` is therefore the outstation's event resolution.
 *
 * Change detection lives here rather than in the point map: `updateTag` enqueues
 * an event on every call, so pushing every poll would fill the event buffer with
 * identical "events" at the poll rate. A sample is forwarded only when its value
 * or quality differs from the last one forwarded for that tag. The per-point
 * `deadband` declared in the point map is NOT applied by this poller — any
 * change, however small, is forwarded.
 */
export class Dnp3TagStorePoller {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private readonly tagIds: string[];
  /** last sample forwarded per tag, for change detection */
  private readonly lastPushed = new Map<string, { value: number | boolean; quality: PointQuality }>();

  constructor(
    private readonly outstation: Dnp3TagSink,
    private readonly store: Dnp3TagStorePort,
    pointMap: Dnp3PointMap,
    private readonly intervalMs: number,
  ) {
    const ids = new Set<string>();
    for (const type of [
      "binaryInput",
      "analogInput",
      "counter",
      "binaryOutput",
      "analogOutput",
    ] as const) {
      for (const point of pointMap.pointsOfType(type)) ids.add(point.tagId);
    }
    this.tagIds = [...ids];
  }

  /** Tags this poller reads each cycle. */
  get mappedTagIds(): readonly string[] {
    return this.tagIds;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Read every mapped tag once and push the ones that changed. Tags the store
   * does not know are skipped, leaving the point at its seeded `bad`
   * placeholder — reporting a fabricated 0 as GOOD would be worse than
   * reporting nothing.
   *
   * @returns how many tags were pushed into the outstation.
   */
  async pollOnce(): Promise<number> {
    let pushed = 0;
    for (const tagId of this.tagIds) {
      let sample: PointSample | undefined;
      try {
        sample = await this.store.read(tagId);
      } catch (err) {
        logError(err, `DNP3 outstation: tag read failed for ${tagId}`);
        continue;
      }
      if (!sample) continue;

      const previous = this.lastPushed.get(tagId);
      if (
        previous !== undefined &&
        previous.value === sample.value &&
        previous.quality === sample.quality
      ) {
        continue;
      }
      this.lastPushed.set(tagId, { value: sample.value, quality: sample.quality });
      this.outstation.updateTag(tagId, sample);
      pushed += 1;
    }
    return pushed;
  }

  /** Begin polling. Overlapping cycles are skipped, not queued. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      void this.pollOnce()
        .catch((err: unknown) => logError(err, "DNP3 outstation tag poll failed"))
        .finally(() => {
          this.inFlight = false;
        });
    }, this.intervalMs);
    // Do not hold the event loop open just to poll tags.
    this.timer.unref?.();
  }

  /** Stop polling. Safe to call when not running. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export interface TagStoreControlSinkOptions {
  pointMap: Dnp3PointMap;
  store: Dnp3TagStorePort;
  /** Called after each accepted write settles; defaults to logging failures. */
  onWriteError?: (command: Dnp3ControlCommand, err: unknown) => void;
}

/**
 * The production control sink: turns a validated DNP3 control into a tag-store
 * write.
 *
 * ── What "SUCCESS" means here, precisely ─────────────────────────────────────
 * `Dnp3ControlSink` is synchronous because DNP3 must put a CommandStatus in the
 * OPERATE response, while the tag store is async. This sink therefore answers
 * for the *enqueue*: it returns SUCCESS once the write has been accepted onto an
 * in-process, strictly ordered queue. That is NOT a durable acceptance — if the
 * process dies between the response and the store write, the master will have
 * been told SUCCESS for a write that never landed. `pendingWrites` and
 * `settled()` expose the queue so a deployment (or a test) can observe it.
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * Only output points explicitly marked `writable: true` in the point map are
 * written; anything else is refused with NOT_SUPPORTED. Mapping a point makes
 * its status readable, never controllable.
 */
export interface TagStoreControlSink {
  (command: Dnp3ControlCommand): Dnp3ControlOutcome;
  /** Writes accepted but not yet settled. */
  readonly pendingWrites: number;
  /** Resolves when every write accepted so far has settled. */
  settled(): Promise<void>;
}

export function createTagStoreControlSink(
  options: TagStoreControlSinkOptions,
): TagStoreControlSink {
  const { pointMap, store } = options;
  const onWriteError =
    options.onWriteError ??
    ((command: Dnp3ControlCommand, err: unknown): void => {
      logError(
        err,
        `DNP3 outstation: control write to ${command.tagId} failed AFTER the ` +
          "master was told SUCCESS",
      );
    });

  // Serialise writes so two controls on the same tag land in request order.
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;

  // Typed as `Dnp3ControlSink` so this stays signature-compatible with what
  // `Dnp3Outstation.setControlSink()` accepts.
  const sink: Dnp3ControlSink = (command: Dnp3ControlCommand): Dnp3ControlOutcome => {
    const type = command.kind === "binaryOutput" ? "binaryOutput" : "analogOutput";
    const def = pointMap.getPoint(type, command.index);
    if (!def) {
      // The control processor already resolved the point, so this is a
      // defensive check rather than the normal rejection path.
      return { ok: false, status: DNP3_COMMAND_STATUS.NOT_SUPPORTED };
    }
    if (!def.writable) {
      logWarn(
        `DNP3 control refused: ${type} ${command.index} (tag ${def.tagId}) is not ` +
          'marked "writable" in the point map',
        LOG_SCOPE,
      );
      return { ok: false, status: DNP3_COMMAND_STATUS.NOT_SUPPORTED };
    }

    pending += 1;
    queue = queue
      .then(() => store.write(def.tagId, command.value))
      .catch((err: unknown) => onWriteError(command, err))
      .finally(() => {
        pending -= 1;
      });
    return { ok: true };
  };

  // `Object.assign` would evaluate a getter once and freeze its value; these
  // have to stay live, so define them as real accessors on the function.
  return Object.defineProperties(sink, {
    pendingWrites: { get: () => pending, enumerable: true },
    settled: { value: (): Promise<void> => queue, enumerable: true },
  }) as TagStoreControlSink;
}
