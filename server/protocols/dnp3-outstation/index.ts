/**
 * DNP3 Outstation — TCP Server
 * Issue #464: [wave:2c] Build DNP3 Outstation Mode
 *
 * Wires the protocol cores (point-map, event-buffer, event-object encoder,
 * controls, secure-auth, link CRC, transport, APDU assembly) into a TCP
 * outstation that DNP3 masters (e.g. opendnp3) can poll. The request-dispatch
 * covers the conformance-critical paths:
 *   - Class 0 read      -> all static data (BI/AI/Counter/BO status/AO status)
 *   - Class 1/2/3 read  -> buffered events serialised as g2/g11/g22/g32/g42
 *                          objects with index-prefixed qualifiers, split across
 *                          response fragments and cleared only on CONFIRM
 *   - SELECT / OPERATE / DIRECT-OPERATE of g12v1 CROB and g41v1..v4 analog
 *     output blocks, with real select-before-operate arming (OFF BY DEFAULT —
 *     see the safety note below)
 *   - Unsolicited responses on Class 1/2/3 buffer thresholds
 *   - SAv5 challenge/verify on critical function codes, and dispatch of the
 *     ASDU once the reply's MAC verifies
 *
 * ── SAFETY: the write path is fail-closed ────────────────────────────────────
 * DNP3 controls move live plant state. They are rejected with CommandStatus
 * NOT_SUPPORTED unless BOTH `config.controls.enabled` is explicitly true (it
 * defaults to false) AND the embedder installs a control sink via
 * `setControlSink()`. A default-constructed outstation is read-only.
 *
 * ── NOT WIRED INTO SERVER STARTUP ────────────────────────────────────────────
 * Nothing here starts a listener on import. `start()` must be called
 * explicitly. Exposing the outstation on a network interface is deliberately
 * left to a separate change: it needs its own network-policy review because a
 * DNP3 master that reaches this port can drive the control path.
 *
 * ── Known remaining gaps (honest list) ───────────────────────────────────────
 *   - One master association. The application-layer confirm state lives in a
 *     per-connection `OutstationSession`, but the event buffer is shared, so if
 *     two masters connect at once the first CONFIRM drains events for both.
 *     DNP3 outstations conventionally serve a single master.
 *   - Full secondary link-confirm + frame-count-bit (FCB) state machine.
 *   - WRITE g80v1 (master clearing the DEVICE_RESTART IIN bit).
 *   - Group-120 free-format object framing (qualifier 0x5B); the SAv5 objects
 *     use the simple count-1 header this module also emits.
 *   - Unconfirmed events are re-sent on the next Class poll (correct), but
 *     there is no independent retry timer.
 *   - DNP3 serial transport (this is TCP only).
 */

import net from 'net';
import { z } from 'zod';
import { log, logError, logWarn } from '../../logger';
import { Dnp3PointMap, Dnp3PointMapConfigSchema, deriveFlags, type PointSample, type Dnp3PointType } from './point-map';
import {
  Dnp3EventBuffer,
  DEFAULT_EVENT_BUFFER_CONFIG,
  type EventBufferConfig,
  type EventClass,
} from './event-buffer';
import {
  buildEventObjects,
  DEFAULT_EVENT_VARIATIONS,
  type EventVariationPolicy,
} from './event-objects';
import {
  Dnp3ControlProcessor,
  type Dnp3ControlConfig,
  type Dnp3ControlSink,
} from './controls';
import {
  Sav5Outstation,
  isCriticalFunction,
  encodeChallengeObject,
  decodeReplyObject,
  type Sav5VerifyResult,
} from './secure-auth';
import {
  parseRequest,
  buildResponseHeader,
  buildClass0Blocks,
  buildIin,
  classReadTargets,
  APP_CTRL_SEQ_MASK,
  type ParsedRequest,
} from './app-layer';
import { DNP3_FUNCTION, DNP3_GROUP } from './app-objects';
import {
  buildLinkFrame,
  buildResponseControl,
  extractPayload,
  DNP3_LINK_FUNCTION,
} from './link-layer';
import { segment, TransportReassembler, TRANSPORT_SEQ_MASK } from './transport';

/** Octets of application header (APP_CONTROL + FUNCTION + IIN) on a response. */
const APP_HEADER_LEN = 4;

export const Dnp3OutstationConfigSchema = z.object({
  /** TCP listen port. DNP3 default is 20000; 0 asks the OS for a free port. */
  port: z.number().int().min(0).max(65535).default(20000),
  /** Bind host. */
  host: z.string().default('0.0.0.0'),
  /** This outstation's DNP3 link address. */
  localAddress: z.number().int().min(0).max(0xffff).default(10),
  /** Whether unsolicited responses are enabled at startup. */
  unsolicitedEnabled: z.boolean().default(false),
  /**
   * Maximum application fragment the outstation will transmit. IEEE 1815 caps
   * responses at 2048 octets; larger event sets are split across fragments.
   */
  maxTxFragmentSize: z.number().int().min(64).max(2048).default(2048),
  /** Which event variations to emit (time representation per event type). */
  eventVariations: z
    .object({
      binary: z.enum(['no-time', 'absolute-time', 'relative-time']).default('absolute-time'),
      counter: z.enum(['no-time', 'absolute-time']).default('absolute-time'),
      analog: z.enum(['no-time', 'absolute-time']).default('absolute-time'),
    })
    .default({}),
  /**
   * DNP3 control (SELECT/OPERATE/DIRECT-OPERATE) policy. Disabled by default:
   * the outstation is read-only until an operator opts in AND a control sink is
   * installed.
   */
  controls: z
    .object({
      enabled: z.boolean().default(false),
      selectTimeoutMs: z.number().int().positive().default(5000),
    })
    .default({}),
  /** Point map. */
  pointMap: Dnp3PointMapConfigSchema.default({ points: [] }),
});

export type Dnp3OutstationConfig = z.input<typeof Dnp3OutstationConfigSchema>;
type ResolvedConfig = z.infer<typeof Dnp3OutstationConfigSchema>;

/** One fragment of an application response, plus what it commits the outstation to. */
export interface Dnp3ResponseFragment {
  /** the application fragment octets (header + objects) */
  bytes: Buffer;
  /** application sequence number carried in the fragment header */
  seq: number;
  /** CON bit — the master must send an application CONFIRM for this fragment */
  con: boolean;
  /** event-buffer sequence numbers carried; removed from the buffer on CONFIRM */
  eventSeqs: number[];
}

/**
 * Per-master-association application-layer state. An outstation may only have
 * one response outstanding at a time, so this holds the fragment awaiting a
 * CONFIRM plus any fragments queued behind it.
 */
export interface OutstationSession {
  pendingFragments: Dnp3ResponseFragment[];
  awaitingConfirm: Dnp3ResponseFragment | null;
}

export function createSession(): OutstationSession {
  return { pendingFragments: [], awaitingConfirm: null };
}

/** Per-connection link/transport state. */
interface ConnectionState {
  socket: net.Socket;
  reassembler: TransportReassembler;
  /** master's link address learned from the first frame */
  masterAddress: number;
  /** running transport-function sequence number for transmitted segments */
  transportSeq: number;
  /** application-layer response state for this association */
  session: OutstationSession;
  rxBuffer: Buffer;
}

/**
 * Context object passed to the pure request handler so it can be unit tested
 * without a live socket.
 */
export interface OutstationContext {
  pointMap: Dnp3PointMap;
  eventBuffer: Dnp3EventBuffer;
  secureAuth: Sav5Outstation;
  /** control (write) path — fail-closed unless enabled AND given a sink */
  controls: Dnp3ControlProcessor;
  /** which event variations to emit */
  eventVariations: EventVariationPolicy;
  /** max application fragment size for responses */
  maxTxFragmentSize: number;
  /** default association state, used when no per-connection session is passed */
  session: OutstationSession;
  /** set false until the master clears it; surfaces DEVICE_RESTART IIN */
  restartPending: boolean;
  unsolicitedEnabled: boolean;
}

/** Build an `OutstationContext` with the module's defaults applied. */
export function createOutstationContext(opts?: {
  pointMap?: Dnp3PointMap;
  eventBuffer?: Dnp3EventBuffer;
  secureAuth?: Sav5Outstation;
  controlConfig?: Dnp3ControlConfig;
  controlSink?: Dnp3ControlSink | null;
  eventVariations?: EventVariationPolicy;
  maxTxFragmentSize?: number;
  restartPending?: boolean;
  unsolicitedEnabled?: boolean;
}): OutstationContext {
  const pointMap = opts?.pointMap ?? new Dnp3PointMap();
  return {
    pointMap,
    eventBuffer: opts?.eventBuffer ?? new Dnp3EventBuffer(DEFAULT_EVENT_BUFFER_CONFIG),
    secureAuth: opts?.secureAuth ?? new Sav5Outstation(),
    controls: new Dnp3ControlProcessor(
      pointMap,
      opts?.controlConfig ?? { enabled: false, selectTimeoutMs: 5000 },
      opts?.controlSink ?? null,
    ),
    eventVariations: opts?.eventVariations ?? DEFAULT_EVENT_VARIATIONS,
    maxTxFragmentSize: opts?.maxTxFragmentSize ?? 2048,
    session: createSession(),
    restartPending: opts?.restartPending ?? false,
    unsolicitedEnabled: opts?.unsolicitedEnabled ?? false,
  };
}

/** Outcome of handling one application request. */
export interface Dnp3RequestResult {
  /** the fragment to transmit now; empty when there is nothing to send */
  response: Buffer;
  /** all fragments produced (the first is `response`); empty for no-response funcs */
  fragments: Dnp3ResponseFragment[];
  challenged: boolean;
}

const NO_RESPONSE: Dnp3RequestResult = { response: Buffer.alloc(0), fragments: [], challenged: false };

/**
 * Handle one parsed application request and return the application response
 * fragment bytes (no link/transport framing). PURE apart from the outstation
 * state it is given — no I/O. This is the primary unit-test surface for the
 * application layer.
 *
 * SAv5: when a critical function arrives and a key is provisioned we do NOT
 * execute it; instead we return a g120v1 challenge fragment. The master's
 * g120v2 reply is verified via `handleSecureAuthReply`, after which the caller
 * re-dispatches the authorised ASDU with `skipSecureAuth`.
 */
export function handleApplicationRequest(
  ctx: OutstationContext,
  req: ParsedRequest,
  opts?: { userNumber?: number; now?: number; session?: OutstationSession; skipSecureAuth?: boolean },
): Dnp3RequestResult {
  const now = opts?.now ?? Date.now();
  const userNumber = opts?.userNumber ?? 1;
  const session = opts?.session ?? ctx.session;

  // ── Secure Authentication: challenge critical requests ──────────────────
  if (!opts?.skipSecureAuth && isCriticalFunction(req.func) && ctx.secureAuth.hasUser(userNumber)) {
    // The Critical ASDU is the whole application fragment (IEEE 1815 §7.5.2.2),
    // so the MAC covers the function code and application control octet too.
    const challenge = ctx.secureAuth.issueChallenge(userNumber, req.raw, { now });
    const header = buildResponseHeader({ seq: req.seq, iin: currentIin(ctx) });
    // g120v1 object header (qualifier 0x5B free-format is spec; we use a simple
    // count-1 header here as the integration seam — see module doc).
    const objHeader = Buffer.from([DNP3_GROUP.SECURE_AUTH, 0x01, 0x07, 0x01]);
    const body = encodeChallengeObject(challenge);
    const bytes = Buffer.concat([header, objHeader, body]);
    return {
      response: bytes,
      fragments: [{ bytes, seq: req.seq, con: false, eventSeqs: [] }],
      challenged: true,
    };
  }

  // An application CONFIRM refers to the fragment already in flight; every other
  // request abandons an unconfirmed response (IEEE 1815 §4.2.2).
  if (req.func === DNP3_FUNCTION.CONFIRM) {
    return handleConfirm(ctx, req, session);
  }
  session.pendingFragments = [];
  session.awaitingConfirm = null;

  switch (req.func) {
    case DNP3_FUNCTION.READ:
      return dispatchFragments(handleRead(ctx, req), session);

    case DNP3_FUNCTION.SELECT:
    case DNP3_FUNCTION.OPERATE:
    case DNP3_FUNCTION.DIRECT_OPERATE:
    case DNP3_FUNCTION.DIRECT_OPERATE_NR:
      return handleControlRequest(ctx, req, now);

    case DNP3_FUNCTION.ENABLE_UNSOLICITED:
      ctx.unsolicitedEnabled = true;
      return singleFragment(emptyResponse(ctx, req.seq), req.seq);

    case DNP3_FUNCTION.DISABLE_UNSOLICITED:
      ctx.unsolicitedEnabled = false;
      return singleFragment(emptyResponse(ctx, req.seq), req.seq);

    case DNP3_FUNCTION.COLD_RESTART:
    case DNP3_FUNCTION.WARM_RESTART:
      ctx.eventBuffer.clear();
      ctx.controls.disarm();
      ctx.restartPending = true;
      return singleFragment(emptyResponse(ctx, req.seq), req.seq);

    default: {
      // Unknown / unsupported function code — respond with IIN2 bit set.
      const header = buildResponseHeader({
        seq: req.seq,
        iin: currentIin(ctx) | buildIin({ noFuncSupport: true }),
      });
      logWarn(`DNP3 outstation: unsupported function code 0x${req.func.toString(16)}`);
      return singleFragment(header, req.seq);
    }
  }
}

/** Wrap a single already-built fragment (no events, no confirm needed). */
function singleFragment(bytes: Buffer, seq: number): Dnp3RequestResult {
  return { response: bytes, fragments: [{ bytes, seq, con: false, eventSeqs: [] }], challenged: false };
}

/**
 * Queue a multi-fragment response on the session and return its first fragment.
 * Fragments that carry events (or that are not final) set CON, so the master's
 * CONFIRM both releases the next fragment and clears the reported events.
 */
function dispatchFragments(fragments: Dnp3ResponseFragment[], session: OutstationSession): Dnp3RequestResult {
  if (fragments.length === 0) return NO_RESPONSE;
  const [first, ...rest] = fragments;
  session.pendingFragments = rest;
  session.awaitingConfirm = first.con ? first : null;
  return { response: first.bytes, fragments, challenged: false };
}

/**
 * Application CONFIRM from the master: permanently remove the events carried by
 * the confirmed fragment and release the next fragment, if any.
 */
function handleConfirm(ctx: OutstationContext, req: ParsedRequest, session: OutstationSession): Dnp3RequestResult {
  const awaiting = session.awaitingConfirm;
  if (!awaiting) return NO_RESPONSE;
  if (awaiting.seq !== req.seq) {
    logWarn(`DNP3 outstation: CONFIRM seq ${req.seq} does not match outstanding fragment seq ${awaiting.seq}`);
    return NO_RESPONSE;
  }
  if (awaiting.eventSeqs.length > 0) {
    ctx.eventBuffer.confirm(awaiting.eventSeqs);
  }
  session.awaitingConfirm = null;
  const next = session.pendingFragments.shift();
  if (!next) return NO_RESPONSE;
  session.awaitingConfirm = next.con ? next : null;
  return { response: next.bytes, fragments: [next], challenged: false };
}

/** Handle a control function code (SELECT / OPERATE / DIRECT-OPERATE). */
function handleControlRequest(ctx: OutstationContext, req: ParsedRequest, now: number): Dnp3RequestResult {
  const result = ctx.controls.process(req, now);
  if (req.func === DNP3_FUNCTION.DIRECT_OPERATE_NR) {
    // "No response" variant: the operation runs, nothing is transmitted.
    return NO_RESPONSE;
  }
  const header = buildResponseHeader({ seq: req.seq, iin: currentIin(ctx) | result.iin });
  return singleFragment(Buffer.concat([header, result.objects]), req.seq);
}

/**
 * Handle a Class 0/1/2/3 read request, producing one or more response
 * fragments. Static (Class 0) object blocks come first, then buffered events in
 * the event buffer's chronological order; both are packed to respect
 * `maxTxFragmentSize`.
 */
function handleRead(ctx: OutstationContext, req: ParsedRequest): Dnp3ResponseFragment[] {
  const targets = classReadTargets(req);
  // Default (no recognised class object, or explicit class 0): all static data.
  const wantStatic = targets.class0 || (!targets.class1 && !targets.class2 && !targets.class3);

  const eventClasses: EventClass[] = [];
  if (targets.class1) eventClasses.push(1);
  if (targets.class2) eventClasses.push(2);
  if (targets.class3) eventClasses.push(3);

  // IIN is sampled before reporting: the class-event bits stay set while events
  // remain buffered (they are only dropped on CONFIRM), which is what tells the
  // master more data is pending.
  const iin = currentIin(ctx);
  const budget = Math.max(1, ctx.maxTxFragmentSize - APP_HEADER_LEN);

  interface PackedFragment {
    blocks: Buffer[];
    eventSeqs: number[];
    used: number;
  }
  const packed: PackedFragment[] = [];
  let current: PackedFragment = { blocks: [], eventSeqs: [], used: 0 };

  if (wantStatic) {
    for (const block of buildClass0Blocks(ctx.pointMap, budget)) {
      if (current.used > 0 && current.used + block.length > budget) {
        packed.push(current);
        current = { blocks: [], eventSeqs: [], used: 0 };
      }
      current.blocks.push(block);
      current.used += block.length;
    }
  }

  let pending = eventClasses.length > 0 ? ctx.eventBuffer.peek(eventClasses) : [];
  while (pending.length > 0) {
    const encoded = buildEventObjects(pending, {
      pointMap: ctx.pointMap,
      policy: ctx.eventVariations,
      maxBytes: budget - current.used,
    });
    if (encoded.encodedSeqs.length === 0) {
      if (current.used === 0) {
        // Nothing fits even in an empty fragment: the configured fragment size
        // is smaller than a single event object. Say so rather than looping.
        logWarn(
          `DNP3 outstation: maxTxFragmentSize=${ctx.maxTxFragmentSize} cannot carry one event object; ` +
            `${pending.length} event(s) withheld`,
        );
        break;
      }
      packed.push(current);
      current = { blocks: [], eventSeqs: [], used: 0 };
      continue;
    }
    current.blocks.push(encoded.bytes);
    current.eventSeqs.push(...encoded.encodedSeqs);
    current.used += encoded.bytes.length;
    pending = pending.slice(encoded.encodedSeqs.length);
    if (pending.length > 0) {
      packed.push(current);
      current = { blocks: [], eventSeqs: [], used: 0 };
    }
  }

  if (current.used > 0 || packed.length === 0) packed.push(current);

  const lastIndex = packed.length - 1;
  const fragments = packed.map((frag, i) => {
    const seq = (req.seq + i) & APP_CTRL_SEQ_MASK;
    // Non-final fragments must be confirmed before the next is sent; fragments
    // carrying events must be confirmed before those events can be dropped.
    const con = frag.eventSeqs.length > 0 || i < lastIndex;
    const header = buildResponseHeader({ seq, fir: i === 0, fin: i === lastIndex, con, iin });
    return { bytes: Buffer.concat([header, ...frag.blocks]), seq, con, eventSeqs: frag.eventSeqs };
  });

  // Reported-but-unconfirmed events stay buffered (and are re-sent on the next
  // poll) but must stop driving the unsolicited count/delay triggers.
  const reported = fragments.flatMap((f) => f.eventSeqs);
  if (reported.length > 0) ctx.eventBuffer.markReported(reported);

  return fragments;
}

/** Build an empty (header-only) response carrying current IIN. */
function emptyResponse(ctx: OutstationContext, seq: number): Buffer {
  return buildResponseHeader({ seq, iin: currentIin(ctx) });
}

/** Compute the IIN word reflecting current outstation state. */
function currentIin(ctx: OutstationContext): number {
  const ev = ctx.eventBuffer.classEventIinBits();
  return buildIin({
    deviceRestart: ctx.restartPending,
    class1Events: ev.class1,
    class2Events: ev.class2,
    class3Events: ev.class3,
    eventBufferOverflow: ctx.eventBuffer.hasOverflow(),
  });
}

/**
 * Handle a g120v2 Secure-Auth reply. Verifies the MAC and, on success, returns
 * the now-authorised critical ASDU so the caller can dispatch it. PURE.
 */
export function handleSecureAuthReply(
  ctx: OutstationContext,
  replyObjectBody: Buffer,
  now: number = Date.now(),
): Sav5VerifyResult {
  const reply = decodeReplyObject(replyObjectBody);
  return ctx.secureAuth.verifyReply(reply, now);
}

/**
 * The DNP3 TCP outstation network object. Owns the listening socket and the
 * per-connection link/transport reassembly; delegates all decision logic to the
 * pure handlers above.
 */
export class Dnp3Outstation {
  private server: net.Server | null = null;
  private connections = new Set<ConnectionState>();
  private unsolicitedTimer: NodeJS.Timeout | null = null;
  private unsolicitedSeq = 0;
  private boundPort: number | null = null;
  readonly config: ResolvedConfig;
  readonly ctx: OutstationContext;

  constructor(config: Dnp3OutstationConfig = {}, eventBufferConfig: EventBufferConfig = DEFAULT_EVENT_BUFFER_CONFIG) {
    this.config = Dnp3OutstationConfigSchema.parse(config);
    const pointMap = new Dnp3PointMap(this.config.pointMap);
    this.ctx = {
      pointMap,
      eventBuffer: new Dnp3EventBuffer(eventBufferConfig),
      secureAuth: new Sav5Outstation(),
      controls: new Dnp3ControlProcessor(pointMap, this.config.controls, null),
      eventVariations: this.config.eventVariations,
      maxTxFragmentSize: this.config.maxTxFragmentSize,
      session: createSession(),
      restartPending: true, // a fresh outstation reports DEVICE_RESTART
      unsolicitedEnabled: this.config.unsolicitedEnabled,
    };
  }

  /** Provision an SAv5 Update Key for a user. */
  setUpdateKey(userNumber: number, key: Buffer): void {
    this.ctx.secureAuth.setUpdateKey(userNumber, key);
  }

  /**
   * Install the seam through which DNP3 controls reach live tag state. Until
   * this is called — and unless `controls.enabled` was set — every SELECT /
   * OPERATE / DIRECT-OPERATE is rejected with CommandStatus NOT_SUPPORTED.
   */
  setControlSink(sink: Dnp3ControlSink | null): void {
    this.ctx.controls.setSink(sink);
    if (sink && !this.config.controls.enabled) {
      logWarn('DNP3 outstation: control sink installed but controls.enabled is false — controls stay rejected');
    }
  }

  /** Whether controls can currently reach plant state. */
  get controlsWritable(): boolean {
    return this.ctx.controls.writable;
  }

  /**
   * The port actually bound, or null when not listening. Differs from
   * `config.port` when the OS assigned an ephemeral port (`port: 0`).
   */
  get listeningPort(): number | null {
    return this.boundPort;
  }

  /**
   * Push a tag update into the outstation. Updates the static value and, if the
   * point has an event class, enqueues a DNP3 event. Triggers an unsolicited
   * response evaluation.
   */
  updateTag(tagId: string, sample: PointSample): void {
    const changedKeys = this.ctx.pointMap.applyTagUpdate(tagId, sample);
    for (const key of changedKeys) {
      const [type, idxStr] = key.split(':') as [Dnp3PointType, string];
      const index = Number(idxStr);
      const def = this.ctx.pointMap.getPoint(type, index);
      if (!def || !def.eventClass) continue;
      const resolved = this.ctx.pointMap.resolve(def.type, def.index);
      if (!resolved) continue;
      this.ctx.eventBuffer.enqueue({
        pointType: def.type,
        index: def.index,
        eventClass: def.eventClass,
        value: resolved.sample.value,
        flags: deriveFlags(resolved),
        timestamp: resolved.sample.timestamp || Date.now(),
      });
    }
    this.maybeSendUnsolicited();
  }

  /** Start listening for masters. */
  async start(): Promise<void> {
    if (this.server) return;
    this.server = net.createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => {
        this.server!.off('error', reject);
        const address = this.server!.address();
        this.boundPort = typeof address === 'object' && address !== null ? address.port : null;
        log(
          `DNP3 outstation listening on ${this.config.host}:${this.boundPort ?? this.config.port} ` +
            `(link addr ${this.config.localAddress}, controls ${this.ctx.controls.writable ? 'ENABLED' : 'disabled'})`,
        );
        resolve();
      });
    });
    // Periodic unsolicited evaluation for the delay-based trigger.
    this.unsolicitedTimer = setInterval(() => this.maybeSendUnsolicited(), 500);
  }

  /** Stop the outstation and close all connections. */
  async stop(): Promise<void> {
    if (this.unsolicitedTimer) {
      clearInterval(this.unsolicitedTimer);
      this.unsolicitedTimer = null;
    }
    for (const conn of this.connections) conn.socket.destroy();
    this.connections.clear();
    this.ctx.controls.disarm();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      this.boundPort = null;
    }
  }

  private onConnection(socket: net.Socket): void {
    const conn: ConnectionState = {
      socket,
      reassembler: new TransportReassembler(),
      masterAddress: 1,
      transportSeq: 0,
      session: createSession(),
      rxBuffer: Buffer.alloc(0),
    };
    this.connections.add(conn);
    log(`DNP3 master connected from ${socket.remoteAddress}:${socket.remotePort}`);

    socket.on('data', (chunk) => {
      conn.rxBuffer = Buffer.concat([conn.rxBuffer, chunk]);
      this.drainRx(conn);
    });
    socket.on('error', (err) => logError(err, 'DNP3 outstation socket error'));
    socket.on('close', () => {
      this.connections.delete(conn);
      // A dropped link invalidates any armed SELECT.
      this.ctx.controls.disarm();
      log('DNP3 master disconnected');
    });
  }

  /**
   * Pull complete link frames out of the rx buffer and process them.
   * TODO: this length-based framing is the happy path; a malformed length
   * should resync on the next 0x0564 start pattern.
   */
  private drainRx(conn: ConnectionState): void {
    while (conn.rxBuffer.length >= 10) {
      if (conn.rxBuffer[0] !== 0x05 || conn.rxBuffer[1] !== 0x64) {
        // Resync: drop one byte and retry.
        conn.rxBuffer = conn.rxBuffer.subarray(1);
        continue;
      }
      const userDataLen = conn.rxBuffer[2] - 5;
      const blocks = userDataLen > 0 ? Math.ceil(userDataLen / 16) : 0;
      const totalLen = 10 + userDataLen + blocks * 2;
      if (conn.rxBuffer.length < totalLen) return; // wait for more
      const frame = conn.rxBuffer.subarray(0, totalLen);
      conn.rxBuffer = conn.rxBuffer.subarray(totalLen);
      this.processFrame(conn, frame);
    }
  }

  private processFrame(conn: ConnectionState, frame: Buffer): void {
    const extracted = extractPayload(frame);
    if (!extracted) {
      logWarn('DNP3 outstation: dropped frame with bad CRC');
      return;
    }
    conn.masterAddress = extracted.header.source;

    // Link-layer service frames (no user data) — answer link status, etc.
    if (extracted.payload.length === 0) {
      if (extracted.header.func === DNP3_LINK_FUNCTION.REQUEST_LINK_STATUS) {
        this.sendLinkStatus(conn);
      }
      return;
    }

    const result = conn.reassembler.accept(extracted.payload);
    if (result.error || !result.fragment) return;

    let req: ParsedRequest;
    try {
      req = parseRequest(result.fragment);
    } catch (err) {
      logError(err, 'DNP3 outstation: failed to parse application request');
      return;
    }

    // SAv5 reply (g120v2) arriving from the master.
    if (req.func === DNP3_FUNCTION.WRITE && req.objects.some((o) => o.group === DNP3_GROUP.SECURE_AUTH)) {
      this.processSecureAuthReply(conn, req);
      return;
    }

    const { response } = handleApplicationRequest(this.ctx, req, {
      userNumber: 1,
      session: conn.session,
    });
    if (response.length > 0) {
      this.sendFragment(conn, response);
    }
    // A successful read with the device-restart bit acknowledged clears it once
    // the master writes IIN1.7 = 0 (WRITE g80v1). TODO: handle that write.
  }

  /**
   * Verify a g120v2 reply and, on success, execute the ASDU it authorises.
   * The reply object body follows the 4-octet object header this module emits
   * for group 120 (see the free-format TODO in the module doc).
   */
  private processSecureAuthReply(conn: ConnectionState, req: ParsedRequest): void {
    let verify: Sav5VerifyResult;
    try {
      verify = handleSecureAuthReply(this.ctx, req.rawObjects.subarray(4));
    } catch (err) {
      logError(err, 'DNP3 outstation: malformed SAv5 reply');
      return;
    }
    if (!verify.ok) {
      logWarn(`DNP3 SAv5: reply rejected (${verify.error})`);
      return;
    }

    let authorised: ParsedRequest;
    try {
      authorised = parseRequest(verify.criticalAsdu);
    } catch (err) {
      logError(err, 'DNP3 outstation: authorised ASDU failed to parse');
      return;
    }
    log(`DNP3 SAv5: reply verified, dispatching authorised function 0x${authorised.func.toString(16)}`);
    const { response } = handleApplicationRequest(this.ctx, authorised, {
      userNumber: verify.userNumber,
      session: conn.session,
      skipSecureAuth: true,
    });
    if (response.length > 0) {
      this.sendFragment(conn, response);
    }
  }

  /** Frame + send one application response fragment to the master. */
  private sendFragment(conn: ConnectionState, appFragment: Buffer): void {
    const segments = segment(appFragment, conn.transportSeq);
    conn.transportSeq = (conn.transportSeq + segments.length) & TRANSPORT_SEQ_MASK;
    for (const seg of segments) {
      const control = buildResponseControl(DNP3_LINK_FUNCTION.UNCONFIRMED_USER_DATA);
      const frame = buildLinkFrame({
        control,
        destination: conn.masterAddress,
        source: this.config.localAddress,
        payload: seg,
      });
      conn.socket.write(frame);
    }
  }

  private sendLinkStatus(conn: ConnectionState): void {
    const control = buildResponseControl(DNP3_LINK_FUNCTION.LINK_STATUS);
    const frame = buildLinkFrame({
      control,
      destination: conn.masterAddress,
      source: this.config.localAddress,
      payload: Buffer.alloc(0),
    });
    conn.socket.write(frame);
  }

  /**
   * Evaluate the unsolicited trigger and, if due, push an unsolicited response
   * to every connected master. Honours the enable flag. Connections with a
   * response already awaiting confirmation are skipped — an outstation may only
   * have one outstanding response per association.
   */
  private maybeSendUnsolicited(now: number = Date.now()): void {
    if (!this.ctx.unsolicitedEnabled) return;
    const decision = this.ctx.eventBuffer.evaluateUnsolicited(now);
    if (!decision.shouldSend) return;

    const events = this.ctx.eventBuffer.peek(decision.classes);
    if (events.length === 0) return;
    const encoded = buildEventObjects(events, {
      pointMap: this.ctx.pointMap,
      policy: this.ctx.eventVariations,
      maxBytes: Math.max(1, this.ctx.maxTxFragmentSize - APP_HEADER_LEN),
    });
    if (encoded.encodedSeqs.length === 0) return;

    const seq = this.unsolicitedSeq & APP_CTRL_SEQ_MASK;
    this.unsolicitedSeq = (this.unsolicitedSeq + 1) & APP_CTRL_SEQ_MASK;
    const header = buildResponseHeader({
      seq,
      unsolicited: true,
      con: true, // events are only dropped once the master confirms
      iin: currentIin(this.ctx),
    });
    const fragment: Dnp3ResponseFragment = {
      bytes: Buffer.concat([header, encoded.bytes]),
      seq,
      con: true,
      eventSeqs: encoded.encodedSeqs,
    };

    let sent = 0;
    for (const conn of this.connections) {
      if (conn.session.awaitingConfirm) continue;
      conn.session.awaitingConfirm = fragment;
      this.sendFragment(conn, fragment.bytes);
      sent += 1;
    }
    if (sent === 0) return;
    this.ctx.eventBuffer.markReported(encoded.encodedSeqs);
    log(
      `DNP3 outstation: sent unsolicited response (classes ${decision.classes.join(',')}, ` +
        `reason ${decision.reason}, ${encoded.encodedSeqs.length} event(s))`,
    );
  }
}

/** Factory mirroring the modbus driver convention. */
export function createDnp3Outstation(config?: Dnp3OutstationConfig): Dnp3Outstation {
  return new Dnp3Outstation(config);
}
