/**
 * Outstation-level tests (#464): fail-closed defaults, the SAv5 -> control
 * dispatch path, and a real localhost TCP round trip that proves a master's
 * Class-1 poll comes back with actual event octets.
 *
 * The TCP test uses a real socket and real DNP3 framing — no mocks, no stubs.
 * The outstation binds port 0 so the OS picks a free port.
 */
import { describe, test, expect, afterEach } from 'vitest';
import net from 'net';
import {
  createDnp3Outstation,
  createOutstationContext,
  handleApplicationRequest,
  handleSecureAuthReply,
  Dnp3Outstation,
} from '../index';
import { parseRequest } from '../app-layer';
import { Dnp3PointMap } from '../point-map';
import { Sav5Outstation, computeMac, decodeChallengeObject, encodeReplyObject } from '../secure-auth';
import { DNP3_COMMAND_STATUS, DNP3_FUNCTION } from '../app-objects';
import { buildLinkFrame, extractPayload } from '../link-layer';
import { segment, TransportReassembler } from '../transport';
import type { Dnp3ControlCommand } from '../controls';

const T0 = 0xabcdef;

/** OPERATE of a LATCH_ON CROB on binary output 0, application sequence 1. */
const OPERATE_LATCH_ON = Buffer.from([
  0xc1, DNP3_FUNCTION.OPERATE, 0x0c, 0x01, 0x17, 0x01, 0x00,
  0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
/** The same objects as a SELECT at sequence 0. */
const SELECT_LATCH_ON = Buffer.from([
  0xc0, DNP3_FUNCTION.SELECT, 0x0c, 0x01, 0x17, 0x01, 0x00,
  0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

const POINTS = [
  { tagId: 'pump.run', type: 'binaryInput' as const, index: 3, eventClass: 1 as const },
  { tagId: 'valve.cmd', type: 'binaryOutput' as const, index: 0 },
];

describe('fail-closed defaults', () => {
  test('a default outstation is read-only and is not listening', () => {
    const os = createDnp3Outstation({ pointMap: { points: POINTS } });
    expect(os.config.controls.enabled).toBe(false);
    expect(os.controlsWritable).toBe(false);
    expect(os.listeningPort).toBeNull();
  });

  test('a sink alone does not enable controls', () => {
    const os = createDnp3Outstation({ pointMap: { points: POINTS } });
    os.setControlSink(() => ({ ok: true }));
    expect(os.controlsWritable).toBe(false);

    const result = handleApplicationRequest(os.ctx, parseRequest(OPERATE_LATCH_ON));
    // Echoed CROB, status octet last: NOT_SUPPORTED.
    expect(result.response[result.response.length - 1]).toBe(DNP3_COMMAND_STATUS.NOT_SUPPORTED);
  });

  test('enabling the flag alone does not enable controls either', () => {
    const os = createDnp3Outstation({ pointMap: { points: POINTS }, controls: { enabled: true } });
    expect(os.controlsWritable).toBe(false);
    os.setControlSink(() => ({ ok: true }));
    expect(os.controlsWritable).toBe(true);
  });

  test('both together let a SELECT/OPERATE pair reach the sink', () => {
    const calls: Dnp3ControlCommand[] = [];
    const os = createDnp3Outstation({ pointMap: { points: POINTS }, controls: { enabled: true } });
    os.setControlSink((cmd) => {
      calls.push(cmd);
      return { ok: true };
    });

    handleApplicationRequest(os.ctx, parseRequest(SELECT_LATCH_ON), { now: 1000 });
    expect(calls).toEqual([]);
    const operate = handleApplicationRequest(os.ctx, parseRequest(OPERATE_LATCH_ON), { now: 1100 });
    expect(operate.response[operate.response.length - 1]).toBe(DNP3_COMMAND_STATUS.SUCCESS);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'binaryOutput', index: 0, tagId: 'valve.cmd', value: true });
  });

  test('DIRECT_OPERATE_NR executes but transmits nothing', () => {
    const calls: Dnp3ControlCommand[] = [];
    const os = createDnp3Outstation({ pointMap: { points: POINTS }, controls: { enabled: true } });
    os.setControlSink((cmd) => {
      calls.push(cmd);
      return { ok: true };
    });
    const nr = Buffer.from(OPERATE_LATCH_ON);
    nr[1] = DNP3_FUNCTION.DIRECT_OPERATE_NR;
    const result = handleApplicationRequest(os.ctx, parseRequest(nr));
    expect(result.response.length).toBe(0);
    expect(result.fragments).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('a restart disarms any pending SELECT', () => {
    const os = createDnp3Outstation({ pointMap: { points: POINTS }, controls: { enabled: true } });
    os.setControlSink(() => ({ ok: true }));
    handleApplicationRequest(os.ctx, parseRequest(SELECT_LATCH_ON), { now: 1000 });
    expect(os.ctx.controls.armedSelect).not.toBeNull();
    handleApplicationRequest(os.ctx, parseRequest(Buffer.from([0xc0, DNP3_FUNCTION.WARM_RESTART])));
    expect(os.ctx.controls.armedSelect).toBeNull();
  });
});

describe('Secure Authentication v5 gates and then dispatches a control', () => {
  test('an OPERATE is challenged, and the verified ASDU actually executes', () => {
    const key = Buffer.alloc(16, 0xab);
    const secureAuth = new Sav5Outstation();
    secureAuth.setUpdateKey(1, key);
    const calls: Dnp3ControlCommand[] = [];
    const ctx = createOutstationContext({
      pointMap: new Dnp3PointMap({ points: POINTS }),
      secureAuth,
      controlConfig: { enabled: true, selectTimeoutMs: 5000 },
      controlSink: (cmd) => {
        calls.push(cmd);
        return { ok: true };
      },
    });

    // 1. The master's DIRECT_OPERATE is challenged, not executed.
    const direct = Buffer.from(OPERATE_LATCH_ON);
    direct[1] = DNP3_FUNCTION.DIRECT_OPERATE;
    const req = parseRequest(direct);
    const challenge = handleApplicationRequest(ctx, req, { userNumber: 1, now: 1000 });
    expect(challenge.challenged).toBe(true);
    expect(calls).toEqual([]);

    // 2. The master computes the MAC over the whole critical ASDU.
    const challengeObject = decodeChallengeObject(challenge.response.subarray(8));
    const mac = computeMac(key, challengeObject, req.raw);
    const verify = handleSecureAuthReply(
      ctx,
      encodeReplyObject({ challengeSeq: challengeObject.challengeSeq, userNumber: 1, mac }),
      1200,
    );
    expect(verify.ok).toBe(true);

    // 3. The authorised ASDU is re-dispatched and now reaches the sink.
    if (!verify.ok) throw new Error('unreachable');
    const authorised = parseRequest(verify.criticalAsdu);
    const executed = handleApplicationRequest(ctx, authorised, {
      userNumber: verify.userNumber,
      now: 1200,
      skipSecureAuth: true,
    });
    expect(executed.response[executed.response.length - 1]).toBe(DNP3_COMMAND_STATUS.SUCCESS);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tagId: 'valve.cmd', value: true });
  });

  test('a MAC computed over the wrong ASDU is rejected and nothing executes', () => {
    const key = Buffer.alloc(16, 0xab);
    const secureAuth = new Sav5Outstation();
    secureAuth.setUpdateKey(1, key);
    const calls: Dnp3ControlCommand[] = [];
    const ctx = createOutstationContext({
      pointMap: new Dnp3PointMap({ points: POINTS }),
      secureAuth,
      controlConfig: { enabled: true, selectTimeoutMs: 5000 },
      controlSink: (cmd) => {
        calls.push(cmd);
        return { ok: true };
      },
    });

    const req = parseRequest(OPERATE_LATCH_ON);
    const challenge = handleApplicationRequest(ctx, req, { userNumber: 1, now: 1000 });
    const challengeObject = decodeChallengeObject(challenge.response.subarray(8));
    // Sign a LATCH_OFF while the challenged ASDU was LATCH_ON.
    const tampered = Buffer.from(req.raw);
    tampered[7] = 0x04;
    const mac = computeMac(key, challengeObject, tampered);
    const verify = handleSecureAuthReply(
      ctx,
      encodeReplyObject({ challengeSeq: challengeObject.challengeSeq, userNumber: 1, mac }),
      1200,
    );
    expect(verify.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('live TCP round trip', () => {
  let outstation: Dnp3Outstation | null = null;
  let client: net.Socket | null = null;

  afterEach(async () => {
    client?.destroy();
    client = null;
    await outstation?.stop();
    outstation = null;
  });

  /** Frame an application fragment the way a master would (DIR=1, PRM=1). */
  function masterFrame(appFragment: Buffer, source: number, destination: number): Buffer {
    const parts = segment(appFragment).map((seg) =>
      buildLinkFrame({ control: 0xc4, destination, source, payload: seg }),
    );
    return Buffer.concat(parts);
  }

  /** Resolve with the next complete application fragment the outstation sends. */
  function nextFragment(socket: net.Socket): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const reassembler = new TransportReassembler();
      let buffered = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.off('data', onData);
        reject(new Error('timed out waiting for a DNP3 response'));
      }, 5000);
      function onData(chunk: Buffer): void {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 10) {
          const userDataLen = buffered[2] - 5;
          const blocks = userDataLen > 0 ? Math.ceil(userDataLen / 16) : 0;
          const total = 10 + userDataLen + blocks * 2;
          if (buffered.length < total) return;
          const frame = buffered.subarray(0, total);
          buffered = buffered.subarray(total);
          const extracted = extractPayload(frame);
          if (!extracted) {
            clearTimeout(timer);
            socket.off('data', onData);
            reject(new Error('response frame failed CRC'));
            return;
          }
          const result = reassembler.accept(extracted.payload);
          if (result.fragment) {
            clearTimeout(timer);
            socket.off('data', onData);
            resolve(result.fragment);
            return;
          }
        }
      }
      socket.on('data', onData);
    });
  }

  test('a master polling Class 1 over a real socket receives real g2v2 event octets', async () => {
    outstation = createDnp3Outstation({
      port: 0,
      host: '127.0.0.1',
      localAddress: 10,
      pointMap: { points: POINTS },
    });
    await outstation.start();
    const port = outstation.listeningPort;
    expect(port).not.toBeNull();

    // A real value change on the tag layer becomes a buffered Class-1 event.
    outstation.updateTag('pump.run', { value: true, quality: 'good', timestamp: T0 });
    expect(outstation.ctx.eventBuffer.classSize(1)).toBe(1);

    client = net.createConnection({ port: port!, host: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      client!.once('connect', resolve);
      client!.once('error', reject);
    });

    // READ g60v2 (Class 1), qualifier 0x06, application sequence 0.
    const pending = nextFragment(client);
    client.write(masterFrame(Buffer.from([0xc0, DNP3_FUNCTION.READ, 0x3c, 0x02, 0x06]), 1, 10));
    const fragment = await pending;

    expect([...fragment]).toEqual([
      0xe0, // FIR|FIN|CON, sequence 0
      0x81, // RESPONSE
      // IIN 0x8200 little-endian: CLASS1_EVENTS (0x0200) plus DEVICE_RESTART
      // (0x8000), which a freshly started outstation must report until the
      // master clears it.
      0x00, 0x82,
      0x02, 0x02, 0x17, 0x01, // g2v2, qualifier 0x17, count 1
      0x03, // index 3
      0x81, // flags ONLINE|STATE
      0xef, 0xcd, 0xab, 0x00, 0x00, 0x00, // DNP3 time T0
    ]);

    // The event is still buffered until the master confirms.
    expect(outstation.ctx.eventBuffer.classSize(1)).toBe(1);
    client.write(masterFrame(Buffer.from([0xc0, DNP3_FUNCTION.CONFIRM]), 1, 10));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(outstation.ctx.eventBuffer.classSize(1)).toBe(0);
  });

  test('a control over a real socket is refused while the outstation is read-only', async () => {
    outstation = createDnp3Outstation({ port: 0, host: '127.0.0.1', pointMap: { points: POINTS } });
    await outstation.start();
    client = net.createConnection({ port: outstation.listeningPort!, host: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      client!.once('connect', resolve);
      client!.once('error', reject);
    });

    const direct = Buffer.from(OPERATE_LATCH_ON);
    direct[1] = DNP3_FUNCTION.DIRECT_OPERATE;
    const pending = nextFragment(client);
    client.write(masterFrame(direct, 1, 10));
    const fragment = await pending;

    expect(fragment[1]).toBe(DNP3_FUNCTION.RESPONSE);
    // Echoed CROB with CommandStatus NOT_SUPPORTED in its final octet.
    expect(fragment[fragment.length - 1]).toBe(DNP3_COMMAND_STATUS.NOT_SUPPORTED);
  });
});
