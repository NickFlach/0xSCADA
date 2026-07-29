/**
 * Live fixture for the OpenDNP3 interoperability smoke test.
 *
 * It deliberately exercises every point family, all three event classes,
 * unsolicited responses, and a writable CROB target. The shell harness starts
 * this process only after the pinned OpenDNP3 reference master has been built.
 */
import { createDnp3Outstation } from "../../../server/protocols/dnp3-outstation";

const host = process.env.DNP3_SMOKE_HOST ?? "127.0.0.1";
const port = Number(process.env.DNP3_SMOKE_PORT ?? "20000");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`DNP3_SMOKE_PORT must be a valid TCP port, got ${String(port)}`);
}

const outstation = createDnp3Outstation({
  host,
  port,
  localAddress: 10,
  unsolicitedEnabled: true,
  controls: { enabled: true, selectTimeoutMs: 5_000 },
  pointMap: {
    points: [
      { tagId: "smoke.bi", type: "binaryInput", index: 0, eventClass: 1 },
      { tagId: "smoke.ai", type: "analogInput", index: 0, eventClass: 2 },
      { tagId: "smoke.counter", type: "counter", index: 0, eventClass: 3 },
      {
        tagId: "smoke.bo",
        type: "binaryOutput",
        index: 0,
        eventClass: 1,
        writable: true,
      },
      {
        tagId: "smoke.ao",
        type: "analogOutput",
        index: 0,
        eventClass: 2,
        writable: true,
      },
    ],
  },
});

outstation.setControlSink((command) => {
  process.stdout.write(`CONTROL_EXECUTED ${JSON.stringify(command)}\n`);
  return { ok: true };
});

const initialTimestamp = Date.now();
outstation.updateTag("smoke.bi", {
  value: false,
  quality: "good",
  timestamp: initialTimestamp,
});
outstation.updateTag("smoke.ai", {
  value: 12.5,
  quality: "good",
  timestamp: initialTimestamp,
});
outstation.updateTag("smoke.counter", {
  value: 7,
  quality: "good",
  timestamp: initialTimestamp,
});
outstation.updateTag("smoke.bo", {
  value: false,
  quality: "good",
  timestamp: initialTimestamp,
});
outstation.updateTag("smoke.ao", {
  value: 42,
  quality: "good",
  timestamp: initialTimestamp,
});

// The initial samples define static state; only subsequent changes are events.
outstation.ctx.eventBuffer.clear();

let updateTimer: NodeJS.Timeout | null = null;
let stopping = false;

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  await outstation.stop();
}

async function main(): Promise<void> {
  await outstation.start();
  process.stdout.write(`OUTSTATION_READY ${host}:${port}\n`);

  let high = false;
  let counter = 7;
  updateTimer = setInterval(() => {
    high = !high;
    counter += 1;
    const timestamp = Date.now();
    outstation.updateTag("smoke.bi", {
      value: high,
      quality: "good",
      timestamp,
    });
    outstation.updateTag("smoke.ai", {
      value: high ? 13.5 : 12.5,
      quality: "good",
      timestamp,
    });
    outstation.updateTag("smoke.counter", {
      value: counter,
      quality: "good",
      timestamp,
    });
  }, 250);
}

process.once("SIGINT", () => {
  void stop().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});

main().catch((error: unknown) => {
  process.stderr.write(
    `OUTSTATION_FAILED ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  void stop().finally(() => process.exit(1));
});
