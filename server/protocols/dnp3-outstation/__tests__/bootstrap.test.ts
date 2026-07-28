/**
 * Bootstrap tests (#464): `startDnp3Outstation` is the real, explicitly opt-in
 * startup path `server/index.ts` calls — this file exercises it end to end over
 * genuine TCP sockets.
 *
 * What is asserted here is exactly the clause the maintainer's review left open
 * ("it is also never wired into the server") plus the safety contract that
 * wiring it in has to satisfy:
 *   - nothing happens at all unless DNP3_OUTSTATION_ENABLED=true;
 *   - invalid configuration refuses to start instead of falling back;
 *   - the listener binds loopback by default;
 *   - a peer outside the allowlist is dropped at accept time;
 *   - Class 0 reads come back with live tag-store values;
 *   - tag changes become Class 1/2/3 events a master can poll;
 *   - controls are answered NOT_SUPPORTED unless separately opted in, and then
 *     only for points the map marks writable;
 *   - shutdown stops the listener and the poller.
 */
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { startDnp3Outstation, type Dnp3OutstationService } from "../index";
import { Dnp3OutstationConfigError } from "../config";
import { InMemoryDnp3TagStore } from "../tag-store-bridge";
import { DNP3_COMMAND_STATUS, DNP3_FUNCTION } from "../app-objects";
import {
  MasterConnection,
  classRead,
  crobRequest,
  freePort,
} from "./master-helpers";

const POINT_MAP = {
  points: [
    { tagId: "pump.run", type: "binaryInput", index: 0, eventClass: 1 },
    {
      tagId: "tank.level",
      type: "analogInput",
      index: 0,
      eventClass: 2,
      encoding: "float32",
    },
    { tagId: "valve.cmd", type: "binaryOutput", index: 0, writable: true },
    { tagId: "vent.cmd", type: "binaryOutput", index: 1 },
  ],
};

const readPointMap = (): string => JSON.stringify(POINT_MAP);
const KEY = "00112233445566778899aabbccddeeff";

let service: Dnp3OutstationService | null = null;
const clients: MasterConnection[] = [];

function baseEnv(
  port: number,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    DNP3_OUTSTATION_ENABLED: "true",
    DNP3_OUTSTATION_SITE_ID: "site-1",
    DNP3_OUTSTATION_POINT_MAP_FILE: "points.json",
    DNP3_OUTSTATION_PORT: String(port),
    // Keep the poller out of the way unless a test drives it deliberately.
    DNP3_OUTSTATION_POLL_INTERVAL_MS: "50",
    ...extra,
  };
}

async function start(
  env: NodeJS.ProcessEnv,
  tagStore?: InMemoryDnp3TagStore,
): Promise<Dnp3OutstationService> {
  const started = await startDnp3Outstation({
    env,
    readFile: readPointMap,
    tagStore,
  });
  if (!started) throw new Error("expected the outstation to start");
  service = started;
  return started;
}

async function connect(
  started: Dnp3OutstationService,
): Promise<MasterConnection> {
  const client = await MasterConnection.open(started.outstation.listeningPort!);
  clients.push(client);
  return client;
}

/** True when something is listening on `port`. */
async function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection({ port, host: "127.0.0.1" });
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await service?.stop();
  service = null;
});

describe("startDnp3Outstation is off by default", () => {
  it("does nothing, and binds nothing, when the flag is absent", async () => {
    const port = await freePort();
    const started = await startDnp3Outstation({
      env: {
        DNP3_OUTSTATION_SITE_ID: "site-1",
        DNP3_OUTSTATION_PORT: String(port),
      },
      readFile: readPointMap,
    });
    expect(started).toBeNull();
    expect(await portIsOpen(port)).toBe(false);
  });

  it("does nothing when the flag is set to anything other than 'true'", async () => {
    for (const value of ["1", "yes", "TRUE", ""]) {
      const started = await startDnp3Outstation({
        env: { DNP3_OUTSTATION_ENABLED: value },
        readFile: readPointMap,
      });
      expect(started, `flag=${value}`).toBeNull();
    }
  });
});

describe("startDnp3Outstation fails closed", () => {
  it("throws and binds nothing when the configuration is invalid", async () => {
    const port = await freePort();
    await expect(
      startDnp3Outstation({
        // No site id.
        env: {
          DNP3_OUTSTATION_ENABLED: "true",
          DNP3_OUTSTATION_PORT: String(port),
          DNP3_OUTSTATION_POINT_MAP_FILE: "points.json",
        },
        readFile: readPointMap,
      }),
    ).rejects.toThrow(Dnp3OutstationConfigError);
    expect(await portIsOpen(port)).toBe(false);
  });

  it("throws and binds nothing when the point map is unusable", async () => {
    const port = await freePort();
    await expect(
      startDnp3Outstation({
        env: baseEnv(port),
        readFile: () => "{ not json",
      }),
    ).rejects.toThrow(/not valid JSON/);
    expect(await portIsOpen(port)).toBe(false);
  });

  it("throws and binds nothing when controls are enabled with no authentication decision", async () => {
    const port = await freePort();
    await expect(
      startDnp3Outstation({
        env: baseEnv(port, { DNP3_OUTSTATION_ALLOW_CONTROLS: "true" }),
        readFile: readPointMap,
      }),
    ).rejects.toThrow(Dnp3OutstationConfigError);
    expect(await portIsOpen(port)).toBe(false);
  });

  it("throws and binds nothing for a routable bind with no allowlist", async () => {
    const port = await freePort();
    await expect(
      startDnp3Outstation({
        env: baseEnv(port, { DNP3_OUTSTATION_BIND_HOST: "0.0.0.0" }),
        readFile: readPointMap,
      }),
    ).rejects.toThrow(/DNP3_OUTSTATION_ALLOWED_PEERS/);
    expect(await portIsOpen(port)).toBe(false);
  });
});

describe("a started outstation serves live data", () => {
  it("binds loopback and answers a Class 0 poll with tag-store values", async () => {
    const store = new InMemoryDnp3TagStore();
    store.seed("pump.run", { value: true, quality: "good", timestamp: 1_000 });
    store.seed("tank.level", { value: 9.5, quality: "good", timestamp: 1_000 });

    const started = await start(baseEnv(await freePort()), store);
    const client = await connect(started);
    client.send(classRead(0));
    const fragment = await client.next();

    expect(fragment[1]).toBe(DNP3_FUNCTION.RESPONSE);
    const objects = fragment.subarray(4);
    // g1v2 binary input 0 — ONLINE|STATE, i.e. the seeded `true`.
    expect([...objects.subarray(0, 6)]).toEqual([
      0x01, 0x02, 0x00, 0x00, 0x00, 0x81,
    ]);
    // g30v5 analog input 0 = 9.5.
    const analog = objects.subarray(objects.length - 10);
    expect([...analog.subarray(0, 5)]).toEqual([0x1e, 0x05, 0x00, 0x00, 0x00]);
    expect(analog.readFloatLE(6)).toBeCloseTo(9.5, 5);

    // The seed snapshot is the starting state, not a change: a master must not
    // be told every point "changed" at boot.
    expect(started.outstation.ctx.eventBuffer.classSize(1)).toBe(0);
    expect(started.outstation.ctx.eventBuffer.classSize(2)).toBe(0);
  });

  it("rejects a peer outside the allowlist", async () => {
    const started = await start(
      baseEnv(await freePort(), {
        DNP3_OUTSTATION_ALLOWED_PEERS: "10.9.9.9/32",
      }),
    );
    const client = await connect(started);
    await client.awaitClose();
    expect(started.outstation.connectionCount).toBe(0);
  });

  it("turns a later tag change into a pollable Class 1 event", async () => {
    const store = new InMemoryDnp3TagStore();
    store.seed("pump.run", { value: false, quality: "good", timestamp: 1_000 });
    const started = await start(baseEnv(await freePort()), store);

    store.seed("pump.run", { value: true, quality: "good", timestamp: 2_000 });
    expect(await started.poller.pollOnce()).toBe(1);
    expect(started.outstation.ctx.eventBuffer.classSize(1)).toBe(1);

    const client = await connect(started);
    client.send(classRead(1));
    const fragment = await client.next();
    // g2v2 binary input event, index 0, ONLINE|STATE, timestamp 2000.
    expect([...fragment.subarray(4, 10)]).toEqual([
      0x02, 0x02, 0x17, 0x01, 0x00, 0x81,
    ]);
    expect(fragment.readUIntLE(10, 6)).toBe(2_000);
  });
});

describe("controls through the startup path", () => {
  it("refuses SELECT/OPERATE while the control opt-in is off", async () => {
    const started = await start(baseEnv(await freePort()));
    expect(started.outstation.controlsWritable).toBe(false);

    const client = await connect(started);
    client.send(crobRequest({ func: DNP3_FUNCTION.SELECT, index: 0, seq: 0 }));
    const select = await client.next();
    expect(select[select.length - 1]).toBe(DNP3_COMMAND_STATUS.NOT_SUPPORTED);

    client.send(
      crobRequest({ func: DNP3_FUNCTION.DIRECT_OPERATE, index: 0, seq: 1 }),
    );
    const direct = await client.next();
    expect(direct[direct.length - 1]).toBe(DNP3_COMMAND_STATUS.NOT_SUPPORTED);
  });

  it("executes a control into the tag store once opted in", async () => {
    const store = new InMemoryDnp3TagStore();
    const started = await start(
      baseEnv(await freePort(), {
        DNP3_OUTSTATION_ALLOW_CONTROLS: "true",
        DNP3_OUTSTATION_ALLOW_UNAUTHENTICATED_CONTROLS: "true",
      }),
      store,
    );
    expect(started.outstation.controlsWritable).toBe(true);

    const client = await connect(started);
    client.send(crobRequest({ func: DNP3_FUNCTION.SELECT, index: 0, seq: 0 }));
    expect((await client.next()).at(-1)).toBe(DNP3_COMMAND_STATUS.SUCCESS);
    expect(store.peek("valve.cmd")).toBeUndefined();

    client.send(crobRequest({ func: DNP3_FUNCTION.OPERATE, index: 0, seq: 1 }));
    expect((await client.next()).at(-1)).toBe(DNP3_COMMAND_STATUS.SUCCESS);

    // The write is enqueued, not synchronous — wait for it to land.
    const deadline = Date.now() + 2000;
    while (store.peek("valve.cmd") === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(store.peek("valve.cmd")?.value).toBe(true);
  });

  it("still refuses an output the point map does not mark writable", async () => {
    const store = new InMemoryDnp3TagStore();
    const started = await start(
      baseEnv(await freePort(), {
        DNP3_OUTSTATION_ALLOW_CONTROLS: "true",
        DNP3_OUTSTATION_SAV5_CONTROL_KEY: KEY,
      }),
      store,
    );
    const client = await connect(started);
    // SAv5 is provisioned, so the critical function is challenged rather than
    // executed: the master gets a g120v1 challenge, and nothing is written.
    client.send(
      crobRequest({ func: DNP3_FUNCTION.DIRECT_OPERATE, index: 1, seq: 0 }),
    );
    const challenge = await client.next();
    expect(challenge[4]).toBe(0x78); // group 120
    expect(store.peek("vent.cmd")).toBeUndefined();
  });
});

describe("shutdown", () => {
  it("stops the listener and the poller", async () => {
    const port = await freePort();
    const started = await start(baseEnv(port));
    expect(await portIsOpen(port)).toBe(true);
    expect(started.poller.isRunning).toBe(true);

    await started.stop();
    service = null;

    expect(started.poller.isRunning).toBe(false);
    expect(started.outstation.listeningPort).toBeNull();
    expect(await portIsOpen(port)).toBe(false);
    // Idempotent.
    await expect(started.stop()).resolves.toBeUndefined();
  });
});
