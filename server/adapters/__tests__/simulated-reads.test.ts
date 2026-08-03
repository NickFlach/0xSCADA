/**
 * Vendor adapter fabricated-read integrity tests (#52).
 *
 * The Rockwell CIP and Siemens S7 adapters have no real device transport —
 * every read is fabricated. The repo integrity rule ("no fake data, label
 * mocks") requires that fabrication to be (a) labeled so an operator or test
 * can always tell, and (b) deterministic so nothing about it depends on
 * ambient randomness.
 *
 * The label assertions are deliberately mutation-catching: they check every
 * returned tag, and they check the ABSENCE of a 'good' claim — removing the
 * 'simulated' label (or reverting it to 'good') fails these tests.
 */

import { describe, it, expect } from "vitest";
import { RockwellCipAdapter } from "../rockwell-cip";
import { SiemensS7Adapter } from "../siemens-s7";
import { AdapterRegistry } from "../index";

const ROCKWELL_ADDRESSES = ["Motor1.Run_bool", "StatusString", "Cycle_Timer", "FlowRate"];
const SIEMENS_ADDRESSES = ["M0.1", "DB1.STRING4", "T5", "C2", "DB2.DBD8"];

type Readable = { readTags(addresses: string[]): Promise<Array<Record<string, unknown>>> };

function connected<T>(adapter: T): T & Readable {
  // The adapters gate readTags on an internal connection state; tests drive
  // the fabrication path directly without a (simulated) connect handshake.
  (adapter as unknown as { state: string }).state = "connected";
  return adapter as T & Readable;
}

describe("fabricated reads are labeled (#52)", () => {
  it("every Rockwell CIP read carries quality 'simulated' and never claims 'good'", async () => {
    const adapter = connected(new RockwellCipAdapter());
    const tags = await adapter.readTags(ROCKWELL_ADDRESSES);

    expect(tags).toHaveLength(ROCKWELL_ADDRESSES.length);
    for (const tag of tags) {
      expect(tag.quality).toBe("simulated");
      expect(tag.quality).not.toBe("good");
    }
  });

  it("every Siemens S7 read carries quality 'simulated' and never claims 'good'", async () => {
    const adapter = connected(new SiemensS7Adapter());
    const tags = await adapter.readTags(SIEMENS_ADDRESSES);

    expect(tags).toHaveLength(SIEMENS_ADDRESSES.length);
    for (const tag of tags) {
      expect(tag.quality).toBe("simulated");
      expect(tag.quality).not.toBe("good");
    }
  });

  it("both adapters declare simulationMode and the registry surfaces it in getStatus()", () => {
    expect(new RockwellCipAdapter().simulationMode).toBe(true);
    expect(new SiemensS7Adapter().simulationMode).toBe(true);

    const registry = new AdapterRegistry();
    registry.register(new RockwellCipAdapter());
    registry.register(new SiemensS7Adapter());

    const status = registry.getStatus();
    expect(status.adapters).toHaveLength(2);
    for (const entry of status.adapters) {
      expect(entry.simulationMode).toBe(true);
    }
  });
});

describe("fabricated reads are deterministic (#52)", () => {
  it("two fresh Rockwell adapters produce identical value sequences", async () => {
    const a = connected(new RockwellCipAdapter());
    const b = connected(new RockwellCipAdapter());

    const first = [
      await a.readTags(ROCKWELL_ADDRESSES),
      await a.readTags(ROCKWELL_ADDRESSES),
    ];
    const second = [
      await b.readTags(ROCKWELL_ADDRESSES),
      await b.readTags(ROCKWELL_ADDRESSES),
    ];

    expect(second.map(batch => batch.map(t => t.value)))
      .toEqual(first.map(batch => batch.map(t => t.value)));
  });

  it("two fresh Siemens adapters produce identical value sequences", async () => {
    const a = connected(new SiemensS7Adapter());
    const b = connected(new SiemensS7Adapter());

    const first = await a.readTags(SIEMENS_ADDRESSES);
    const second = await b.readTags(SIEMENS_ADDRESSES);

    expect(second.map(t => t.value)).toEqual(first.map(t => t.value));
  });

  it("consecutive reads of the same tag differ (the draw counter advances)", async () => {
    const adapter = connected(new RockwellCipAdapter());

    const first = await adapter.readTags(["FlowRate"]);
    const next = await adapter.readTags(["FlowRate"]);

    // Same tag, later draw: deterministic but not frozen. (Numeric values
    // from mulberry32 differ across mixed seeds.)
    expect(next[0]?.value).not.toEqual(first[0]?.value);
  });
});
