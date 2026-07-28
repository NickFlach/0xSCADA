/**
 * DNP3 Outstation — application layer, outstation object, and startup path
 * Issue #464: [wave:2c] Build DNP3 Outstation Mode
 *
 * Wires the protocol cores (point-map, event-buffer, event-object encoder,
 * controls, secure-auth, link CRC, transport, APDU assembly) into an outstation
 * that DNP3 masters can poll. The socket, peer admission and link-frame
 * reassembly live in `server.ts`; this file owns the decisions. The
 * request-dispatch covers the conformance-critical paths:
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
 * `setControlSink()`. A default-constructed outstation is read-only, and
 * `startDnp3Outstation()` installs a sink only when DNP3_OUTSTATION_ALLOW_CONTROLS
 * is set — which itself requires an SAv5 Control Direction Session Key or an
 * explicit declaration that the deployment accepts unauthenticated controls.
 *
 * ── SERVER STARTUP ───────────────────────────────────────────────────────────
 * Nothing here starts a listener on import. `startDnp3Outstation()` (below) is
 * the startup path `server/index.ts` calls, and it does nothing at all unless
 * DNP3_OUTSTATION_ENABLED=true. See `config.ts` for the gates and `server.ts`
 * for the listener itself.
 *
 * ── Known remaining gaps (honest list) ───────────────────────────────────────
 *   - One master association. The application-layer confirm state lives in a
 *     per-connection `OutstationSession`, but the event buffer is shared, so if
 *     two masters connect at once the first CONFIRM drains events for both.
 *     DNP3 outstations conventionally serve a single master.
 *   - Full secondary link-confirm + frame-count-bit (FCB) state machine.
 *   - Unconfirmed events are re-sent on the next Class poll (correct), but
 *     there is no independent retry timer.
 *   - DNP3 serial transport (this is TCP only).
 *   - SAv5 session-key establishment/key-wrap and aggressive mode are not
 *     implemented. A deployment provisions the already-established Control
 *     Direction Session Key and is limited to one authenticated association.
 *   - The automated OpenDNP3 3.1.2 smoke covers startup, static/event polls,
 *     unsolicited responses and SELECT/OPERATE. SAv5 remains covered by this
 *     repository's deterministic handshake and live-dispatch tests.
 */

import { z } from "zod";
import { log, logError, logWarn } from "../../logger";
import {
  Dnp3PointMap,
  Dnp3PointMapConfigSchema,
  deriveFlags,
  type PointSample,
  type Dnp3PointType,
} from "./point-map";
import {
  Dnp3EventBuffer,
  DEFAULT_EVENT_BUFFER_CONFIG,
  type EventBufferConfig,
  type EventClass,
} from "./event-buffer";
import {
  buildEventObjects,
  DEFAULT_EVENT_VARIATIONS,
  type EventVariationPolicy,
} from "./event-objects";
import {
  Dnp3ControlProcessor,
  type Dnp3ControlConfig,
  type Dnp3ControlSink,
} from "./controls";
import {
  Sav5Outstation,
  isCriticalFunction,
  encodeChallengeObject,
  decodeReplyObject,
  type Sav5VerifyResult,
} from "./secure-auth";
import {
  parseRequest,
  buildResponseHeader,
  buildFreeFormat16Object,
  buildClass0Blocks,
  buildIin,
  classReadTargets,
  APP_CTRL_SEQ_MASK,
  type ParsedRequest,
} from "./app-layer";
import { DNP3_FUNCTION, DNP3_GROUP } from "./app-objects";
import {
  createSession,
  type Dnp3ResponseFragment,
  type OutstationSession,
} from "./session";
import {
  Dnp3TcpServer,
  DEFAULT_BIND_HOST,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_RX_BUFFER_BYTES,
  DEFAULT_MAX_TX_QUEUE_BYTES,
  DEFAULT_PORT,
  DEFAULT_SOCKET_TIMEOUT_MS,
  DNP3_MAX_LINK_FRAME_BYTES,
  type Dnp3ApplicationDispatcher,
} from "./server";
import {
  createDnp3TagStorePort,
  createTagStoreControlSink,
  Dnp3TagStorePoller,
  type Dnp3TagStorePort,
} from "./tag-store-bridge";
import {
  describeDnp3OutstationConfig,
  isDnp3OutstationEnabled,
  loadDnp3OutstationConfig,
  loadDnp3PointMapFile,
} from "./config";
import { isLoopbackHost } from "../peer-allowlist";

/** Octets of application header (APP_CONTROL + FUNCTION + IIN) on a response. */
const APP_HEADER_LEN = 4;

export const Dnp3OutstationConfigSchema = z.object({
  /** TCP listen port. DNP3 default is 20000; 0 asks the OS for a free port. */
  port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
  /**
   * Bind host. Loopback by default: DNP3 does not authenticate the TCP peer, so
   * a routable bind must be an explicit act (see `config.ts`, which additionally
   * refuses one without a peer allowlist).
   */
  host: z.string().default(DEFAULT_BIND_HOST),
  /**
   * Peer IPs/CIDRs allowed to connect, checked at accept time. Loopback only by
   * default; `/0` wildcards are refused.
   */
  allowedPeers: z.array(z.string().min(1)).min(1).optional(),
  /** Hard cap on simultaneous master associations. */
  maxConnections: z
    .number()
    .int()
    .min(1)
    .max(64)
    .default(DEFAULT_MAX_CONNECTIONS),
  /** Idle socket timeout in ms (0 disables). */
  socketTimeoutMs: z.number().int().min(0).default(DEFAULT_SOCKET_TIMEOUT_MS),
  /**
   * Per-connection receive-buffer bound. Must fit at least one maximum-size
   * link frame; a peer that exceeds it without completing a frame is dropped.
   */
  maxRxBufferBytes: z
    .number()
    .int()
    .min(DNP3_MAX_LINK_FRAME_BYTES)
    .max(1_048_576)
    .default(DEFAULT_MAX_RX_BUFFER_BYTES),
  /**
   * Per-connection transmit-queue bound. A Class 0 READ is 17 octets and asks
   * for the whole static database, so a peer that pipelines requests and stops
   * reading is the real memory risk; passing this bound drops the connection.
   */
  maxTxQueueBytes: z
    .number()
    .int()
    .min(4096)
    .max(67_108_864)
    .default(DEFAULT_MAX_TX_QUEUE_BYTES),
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
      binary: z
        .enum(["no-time", "absolute-time", "relative-time"])
        .default("absolute-time"),
      counter: z.enum(["no-time", "absolute-time"]).default("absolute-time"),
      analog: z.enum(["no-time", "absolute-time"]).default("absolute-time"),
    })
    .default({}),
  /** SAv5 user whose Control Direction Session Key protects critical requests. */
  sav5UserNumber: z.number().int().min(1).max(0xffff).default(1),
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

export {
  createSession,
  type Dnp3ResponseFragment,
  type OutstationSession,
} from "./session";
export {
  Dnp3LinkFrameReader,
  Dnp3TcpServer,
  DNP3_MAX_LINK_FRAME_BYTES,
  type Dnp3ApplicationDispatcher,
  type Dnp3TcpServerConfig,
} from "./server";
export * from "./config";
export * from "./tag-store-bridge";

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
    eventBuffer:
      opts?.eventBuffer ?? new Dnp3EventBuffer(DEFAULT_EVENT_BUFFER_CONFIG),
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

const NO_RESPONSE: Dnp3RequestResult = {
  response: Buffer.alloc(0),
  fragments: [],
  challenged: false,
};

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
  opts?: {
    userNumber?: number;
    now?: number;
    session?: OutstationSession;
    skipSecureAuth?: boolean;
  },
): Dnp3RequestResult {
  const now = opts?.now ?? Date.now();
  const userNumber = opts?.userNumber ?? 1;
  const session = opts?.session ?? ctx.session;

  if (!opts?.skipSecureAuth && req.func === DNP3_FUNCTION.AUTH_REQUEST_NO_ACK) {
    const object = req.objects[0];
    if (
      req.objectsComplete &&
      req.objects.length === 1 &&
      object?.group === DNP3_GROUP.SECURE_AUTH &&
      object.variation === 7 &&
      object.qualifier === 0x5b &&
      object.count === 1 &&
      object.freeFormat?.length === 1
    ) {
      ctx.secureAuth.clearAssociation(session.sav5AssociationId);
    }
    return NO_RESPONSE;
  }

  if (
    !opts?.skipSecureAuth &&
    ctx.secureAuth.isWaiting(session.sav5AssociationId, now)
  ) {
    logWarn(
      `DNP3 SAv5: discarded function 0x${req.func.toString(16)} while association is waiting for a reply`,
    );
    return NO_RESPONSE;
  }

  if (isCriticalFunction(req.func) && !req.objectsComplete) {
    logWarn(
      `DNP3 outstation: rejected mutating function 0x${req.func.toString(16)} with incomplete object parsing`,
    );
    if (req.func === DNP3_FUNCTION.DIRECT_OPERATE_NR) return NO_RESPONSE;
    const response = buildResponseHeader({
      seq: req.seq,
      iin: currentIin(ctx) | buildIin({ parameterError: true }),
    });
    return singleFragment(response, req.seq);
  }

  // ── Secure Authentication: challenge critical requests ──────────────────
  if (
    !opts?.skipSecureAuth &&
    isCriticalFunction(req.func) &&
    ctx.secureAuth.hasUser(userNumber)
  ) {
    // The Critical ASDU is the whole application fragment (IEEE 1815 §7.5.2.2),
    // so the MAC covers the function code and application control octet too.
    const challenge = ctx.secureAuth.issueChallenge(
      userNumber,
      session.sav5AssociationId,
      req.raw,
      { now, appSeq: req.seq },
    );
    const header = buildResponseHeader({
      seq: req.seq,
      functionCode: DNP3_FUNCTION.AUTH_RESPONSE,
      iin: currentIin(ctx),
    });
    const body = encodeChallengeObject(challenge);
    const bytes = Buffer.concat([
      header,
      buildFreeFormat16Object(DNP3_GROUP.SECURE_AUTH, 1, body),
    ]);
    ctx.secureAuth.bindChallengeFragment(session.sav5AssociationId, bytes);
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

    case DNP3_FUNCTION.WRITE:
      return handleWrite(ctx, req);

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
      logWarn(
        `DNP3 outstation: unsupported function code 0x${req.func.toString(16)}`,
      );
      return singleFragment(header, req.seq);
    }
  }
}

/** Wrap a single already-built fragment (no events, no confirm needed). */
function singleFragment(bytes: Buffer, seq: number): Dnp3RequestResult {
  return {
    response: bytes,
    fragments: [{ bytes, seq, con: false, eventSeqs: [] }],
    challenged: false,
  };
}

/** IIN1.7 is the DEVICE_RESTART bit addressed by WRITE g80v1. */
const DEVICE_RESTART_IIN_INDEX = 7;

/**
 * Handle the standard WRITE g80v1 used by masters to acknowledge a device
 * restart. No other database writes are exposed here.
 *
 * A conforming master writes the single packed bit at IIN index 7 to zero after
 * it has completed startup integrity. Supporting this small write is important:
 * without it the outstation advertises DEVICE_RESTART forever and reference
 * masters continuously repeat their startup sequence.
 */
function handleWrite(
  ctx: OutstationContext,
  req: ParsedRequest,
): Dnp3RequestResult {
  const object = req.objects[0];
  if (
    req.objects.length !== 1 ||
    !object ||
    object.group !== DNP3_GROUP.INTERNAL_INDICATIONS ||
    object.variation !== 1
  ) {
    const response = buildResponseHeader({
      seq: req.seq,
      iin: currentIin(ctx) | buildIin({ objectUnknown: true }),
    });
    return singleFragment(response, req.seq);
  }

  const { range, data } = object;
  if (
    !range ||
    !data ||
    range.start !== DEVICE_RESTART_IIN_INDEX ||
    range.stop !== DEVICE_RESTART_IIN_INDEX ||
    data.length !== 1 ||
    (data[0] & 0x01) !== 0
  ) {
    const response = buildResponseHeader({
      seq: req.seq,
      iin: currentIin(ctx) | buildIin({ parameterError: true }),
    });
    return singleFragment(response, req.seq);
  }

  ctx.restartPending = false;
  return singleFragment(emptyResponse(ctx, req.seq), req.seq);
}

/**
 * Queue a multi-fragment response on the session and return its first fragment.
 * Fragments that carry events (or that are not final) set CON, so the master's
 * CONFIRM both releases the next fragment and clears the reported events.
 */
function dispatchFragments(
  fragments: Dnp3ResponseFragment[],
  session: OutstationSession,
): Dnp3RequestResult {
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
function handleConfirm(
  ctx: OutstationContext,
  req: ParsedRequest,
  session: OutstationSession,
): Dnp3RequestResult {
  const awaiting = session.awaitingConfirm;
  if (!awaiting) return NO_RESPONSE;
  if (awaiting.seq !== req.seq) {
    logWarn(
      `DNP3 outstation: CONFIRM seq ${req.seq} does not match outstanding fragment seq ${awaiting.seq}`,
    );
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
function handleControlRequest(
  ctx: OutstationContext,
  req: ParsedRequest,
  now: number,
): Dnp3RequestResult {
  const result = ctx.controls.process(req, now);
  if (req.func === DNP3_FUNCTION.DIRECT_OPERATE_NR) {
    // "No response" variant: the operation runs, nothing is transmitted.
    return NO_RESPONSE;
  }
  const header = buildResponseHeader({
    seq: req.seq,
    iin: currentIin(ctx) | result.iin,
  });
  return singleFragment(Buffer.concat([header, result.objects]), req.seq);
}

/**
 * Handle a Class 0/1/2/3 read request, producing one or more response
 * fragments. Static (Class 0) object blocks come first, then buffered events in
 * the event buffer's chronological order; both are packed to respect
 * `maxTxFragmentSize`.
 */
function handleRead(
  ctx: OutstationContext,
  req: ParsedRequest,
): Dnp3ResponseFragment[] {
  const targets = classReadTargets(req);
  // Default (no recognised class object, or explicit class 0): all static data.
  const wantStatic =
    targets.class0 || (!targets.class1 && !targets.class2 && !targets.class3);

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

  let pending =
    eventClasses.length > 0 ? ctx.eventBuffer.peek(eventClasses) : [];
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
    const header = buildResponseHeader({
      seq,
      fir: i === 0,
      fin: i === lastIndex,
      con,
      iin,
    });
    return {
      bytes: Buffer.concat([header, ...frag.blocks]),
      seq,
      con,
      eventSeqs: frag.eventSeqs,
    };
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
  replyAppSeq: number,
  session: OutstationSession = ctx.session,
  now: number = Date.now(),
): Sav5VerifyResult {
  const reply = decodeReplyObject(replyObjectBody);
  return ctx.secureAuth.verifyReply(
    reply,
    session.sav5AssociationId,
    replyAppSeq,
    now,
  );
}

/**
 * The DNP3 TCP outstation. Owns the outstation state (point map, event buffer,
 * controls, SAv5) and the application-layer decisions; the listening socket,
 * peer admission and link-frame reassembly belong to `Dnp3TcpServer`, which
 * calls back into this class through `Dnp3ApplicationDispatcher`.
 */
export class Dnp3Outstation implements Dnp3ApplicationDispatcher {
  private tcp: Dnp3TcpServer | null = null;
  private unsolicitedTimer: NodeJS.Timeout | null = null;
  private unsolicitedSeq = 0;
  readonly config: ResolvedConfig;
  readonly ctx: OutstationContext;

  constructor(
    config: Dnp3OutstationConfig = {},
    eventBufferConfig: EventBufferConfig = DEFAULT_EVENT_BUFFER_CONFIG,
  ) {
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

  /** Provision the current SAv5 Control Direction Session Key for a user. */
  setControlDirectionKey(userNumber: number, key: Buffer): void {
    if (this.config.maxConnections !== 1) {
      throw new Error(
        "SAv5 key provisioning requires maxConnections=1 because session keys are association-scoped",
      );
    }
    this.ctx.secureAuth.setControlDirectionKey(userNumber, key);
  }

  /**
   * Install the seam through which DNP3 controls reach live tag state. Until
   * this is called — and unless `controls.enabled` was set — every SELECT /
   * OPERATE / DIRECT-OPERATE is rejected with CommandStatus NOT_SUPPORTED.
   */
  setControlSink(sink: Dnp3ControlSink | null): void {
    this.ctx.controls.setSink(sink);
    if (sink && !this.config.controls.enabled) {
      logWarn(
        "DNP3 outstation: control sink installed but controls.enabled is false — controls stay rejected",
      );
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
    return this.tcp?.boundPort ?? null;
  }

  /** Accepted, still-open master associations. */
  get connectionCount(): number {
    return this.tcp?.connectionCount ?? 0;
  }

  /** Connections refused since start (allowlist misses + cap overflow). */
  get rejectedConnectionCount(): number {
    return this.tcp?.rejectedConnectionCount ?? 0;
  }

  /**
   * Push a tag update into the outstation. Updates the static value and, if the
   * point has an event class, enqueues a DNP3 event. Triggers an unsolicited
   * response evaluation.
   */
  updateTag(tagId: string, sample: PointSample): void {
    const changedKeys = this.ctx.pointMap.applyTagUpdate(tagId, sample);
    for (const key of changedKeys) {
      const [type, idxStr] = key.split(":") as [Dnp3PointType, string];
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

  /**
   * Start listening for masters.
   *
   * The socket, its peer allowlist, the connection cap and the bounded frame
   * reassembly all live in `Dnp3TcpServer`; this only supplies the configuration
   * and the application dispatcher (itself).
   *
   * @throws when the peer allowlist does not parse, or the port cannot be bound.
   *   Either way no listener exists afterwards.
   */
  async start(): Promise<void> {
    if (this.tcp) return;
    const tcp = new Dnp3TcpServer(this, {
      host: this.config.host,
      port: this.config.port,
      localAddress: this.config.localAddress,
      allowedPeers: this.config.allowedPeers,
      maxConnections: this.config.maxConnections,
      socketTimeoutMs: this.config.socketTimeoutMs,
      maxRxBufferBytes: this.config.maxRxBufferBytes,
      maxTxQueueBytes: this.config.maxTxQueueBytes,
    });
    await tcp.start();
    this.tcp = tcp;
    log(
      `DNP3 outstation ready on ${this.config.host}:${tcp.boundPort ?? this.config.port} ` +
        `(link addr ${this.config.localAddress}, controls ${this.ctx.controls.writable ? "ENABLED" : "disabled"})`,
    );
    // Periodic unsolicited evaluation for the delay-based trigger.
    this.unsolicitedTimer = setInterval(() => this.maybeSendUnsolicited(), 500);
  }

  /** Stop the outstation and close all connections. */
  async stop(): Promise<void> {
    if (this.unsolicitedTimer) {
      clearInterval(this.unsolicitedTimer);
      this.unsolicitedTimer = null;
    }
    this.ctx.controls.disarm();
    if (this.tcp) {
      await this.tcp.stop();
      this.tcp = null;
    }
  }

  // ── Dnp3ApplicationDispatcher ──────────────────────────────────────────────

  /**
   * Handle one parsed application request for an association and return the
   * fragment to transmit (empty for the no-response functions).
   */
  dispatch(req: ParsedRequest, session: OutstationSession): Buffer {
    const { response } = handleApplicationRequest(this.ctx, req, {
      userNumber: this.config.sav5UserNumber,
      session,
    });
    return response;
  }

  /**
   * Verify a qualifier-0x5B g120v2 reply and, on success, execute the ASDU it
   * authorises.
   */
  dispatchSecureAuthReply(
    req: ParsedRequest,
    session: OutstationSession,
  ): Buffer {
    const object = req.objects[0];
    if (
      req.func !== DNP3_FUNCTION.AUTH_REQUEST ||
      req.objects.length !== 1 ||
      !req.objectsComplete ||
      !object ||
      object.group !== DNP3_GROUP.SECURE_AUTH ||
      object.variation !== 2 ||
      object.qualifier !== 0x5b ||
      object.count !== 1 ||
      object.freeFormat?.length !== 1
    ) {
      // A Reply attempt is single-use. Malformed FC20 framing must not leave
      // the queued critical ASDU reusable under the same challenge. FC21 is
      // exclusively the no-ack Error carrier and is not itself a Reply event.
      if (req.func === DNP3_FUNCTION.AUTH_REQUEST) {
        this.ctx.secureAuth.clearAssociation(session.sav5AssociationId);
      }
      logWarn(
        "DNP3 SAv5: malformed AUTH_REQUEST; expected one qualifier-0x5B g120v2 object",
      );
      return Buffer.alloc(0);
    }

    let verify: Sav5VerifyResult;
    try {
      verify = handleSecureAuthReply(
        this.ctx,
        object.freeFormat[0],
        req.seq,
        session,
      );
    } catch (err) {
      this.ctx.secureAuth.clearAssociation(session.sav5AssociationId);
      logError(err, "DNP3 outstation: malformed SAv5 reply");
      return Buffer.alloc(0);
    }
    if (!verify.ok) {
      logWarn(`DNP3 SAv5: reply rejected (${verify.error})`);
      return Buffer.alloc(0);
    }

    let authorised: ParsedRequest;
    try {
      authorised = parseRequest(verify.criticalAsdu);
    } catch (err) {
      logError(err, "DNP3 outstation: authorised ASDU failed to parse");
      return Buffer.alloc(0);
    }
    log(
      `DNP3 SAv5: reply verified, dispatching authorised function 0x${authorised.func.toString(16)}`,
    );
    const { response } = handleApplicationRequest(this.ctx, authorised, {
      userNumber: verify.userNumber,
      session,
      skipSecureAuth: true,
    });
    return response;
  }

  /** A dropped link invalidates any armed SELECT. */
  onAssociationClosed(session: OutstationSession): void {
    this.ctx.controls.disarm();
    this.ctx.secureAuth.clearAssociation(session.sav5AssociationId);
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

    const sent = this.tcp?.broadcastUnsolicited(fragment) ?? 0;
    if (sent === 0) return;
    this.ctx.eventBuffer.markReported(encoded.encodedSeqs);
    log(
      `DNP3 outstation: sent unsolicited response (classes ${decision.classes.join(",")}, ` +
        `reason ${decision.reason}, ${encoded.encodedSeqs.length} event(s))`,
    );
  }
}

/** Factory mirroring the modbus driver convention. */
export function createDnp3Outstation(
  config?: Dnp3OutstationConfig,
): Dnp3Outstation {
  return new Dnp3Outstation(config);
}

// ── Startup path ────────────────────────────────────────────────────────────

const LOG_SCOPE = "dnp3-outstation";

/** A started outstation plus everything that has to be torn down with it. */
export interface Dnp3OutstationService {
  outstation: Dnp3Outstation;
  /** Live tag poller feeding `updateTag`. */
  poller: Dnp3TagStorePoller;
  /** Stop the listener and the poller. Idempotent. */
  stop(): Promise<void>;
}

export interface StartDnp3OutstationOptions {
  /** Environment to read configuration from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** File reader seam for the point map, so the bootstrap is testable. */
  readFile?: (path: string) => string;
  /** Tag backing store. Defaults to the live `tagCache` for the site. */
  tagStore?: Dnp3TagStorePort;
}

/**
 * Start DNP3 Outstation Mode from validated configuration. This is the function
 * `server/index.ts` calls at boot.
 *
 * Returns `null` — having done nothing at all, no socket, no timer — when the
 * feature is not explicitly enabled. That is the default for every deployment.
 *
 * @throws {Dnp3OutstationConfigError} when enabled with configuration (or a
 *   point map) that cannot produce a safe listener. No socket is bound: the
 *   failure is terminal for the listener, never a fallback to permissive
 *   defaults.
 */
export async function startDnp3Outstation(
  options: StartDnp3OutstationOptions = {},
): Promise<Dnp3OutstationService | null> {
  const env = options.env ?? process.env;

  if (!isDnp3OutstationEnabled(env)) {
    return null;
  }

  const config = loadDnp3OutstationConfig(env);
  const pointMapConfig = loadDnp3PointMapFile(
    config.pointMapFile,
    options.readFile,
  );

  const outstation = new Dnp3Outstation({
    host: config.host,
    port: config.port,
    localAddress: config.localAddress,
    allowedPeers: config.allowedPeers,
    maxConnections: config.maxConnections,
    socketTimeoutMs: config.socketTimeoutMs,
    maxRxBufferBytes: config.maxRxBufferBytes,
    maxTxQueueBytes: config.maxTxQueueBytes,
    sav5UserNumber: config.sav5UserNumber,
    unsolicitedEnabled: config.unsolicitedEnabled,
    controls: {
      enabled: config.allowControls,
      selectTimeoutMs: config.selectTimeoutMs,
    },
    pointMap: pointMapConfig,
  });

  if (config.sav5ControlKeyHex) {
    outstation.setControlDirectionKey(
      config.sav5UserNumber,
      Buffer.from(config.sav5ControlKeyHex, "hex"),
    );
  }

  const store = options.tagStore ?? createDnp3TagStorePort(config.siteId);

  // The control sink exists ONLY when controls were opted into. With the opt-in
  // off there is no sink at all, so SELECT/OPERATE are answered NOT_SUPPORTED by
  // `Dnp3ControlProcessor` — the same fail-closed answer a bare library gives.
  if (config.allowControls) {
    outstation.setControlSink(
      createTagStoreControlSink({ pointMap: outstation.ctx.pointMap, store }),
    );
    const writable = pointMapConfig.points.filter((p) => p.writable);
    // Say plainly what an unauthenticated peer will be able to actuate.
    logWarn(
      `DNP3 Outstation Mode has CONTROLS ENABLED: ${writable.length} of ` +
        `${pointMapConfig.points.length} mapped points are writable by a master ` +
        `(${writable.map((p) => `${p.type}:${p.index}→${p.tagId}`).join(", ") || "none"}). ` +
        (config.sav5ControlKeyHex
          ? `SAv5 challenges those commands for user ${config.sav5UserNumber}; reads and the ` +
            "TCP peer itself remain unauthenticated."
          : "SAv5 is NOT provisioned, so these commands carry no authentication at all — " +
            "the peer allowlist and network segmentation are the only controls in front of " +
            "these tags."),
      LOG_SCOPE,
    );
  }

  if (!isLoopbackHost(config.host)) {
    logWarn(
      `DNP3 Outstation Mode is bound to the non-loopback address ${config.host}. ` +
        `Peers are restricted to [${config.allowedPeers.join(", ")}], but DNP3 does ` +
        "not authenticate the TCP peer and does not authenticate reads at all; keep " +
        "this listener on a segmented control network.",
      LOG_SCOPE,
    );
  }

  const poller = new Dnp3TagStorePoller(
    outstation,
    store,
    outstation.ctx.pointMap,
    config.pollIntervalMs,
  );
  // Seed the static database before the first master can poll it, so a Class 0
  // read never reports placeholder values on a freshly started outstation. The
  // seed is the outstation's STARTING STATE, not a set of changes, so the events
  // it enqueues are discarded — reporting them would tell a master that every
  // point changed at boot.
  await poller.pollOnce();
  outstation.ctx.eventBuffer.clear();

  await outstation.start();
  poller.start();

  log(
    `DNP3 Outstation Mode started — ${describeDnp3OutstationConfig(config)}, ` +
      `${pointMapConfig.points.length} mapped points, ` +
      `polling ${poller.mappedTagIds.length} tag(s) every ${config.pollIntervalMs}ms`,
    LOG_SCOPE,
  );

  return {
    outstation,
    poller,
    async stop(): Promise<void> {
      poller.stop();
      await outstation.stop();
    },
  };
}
