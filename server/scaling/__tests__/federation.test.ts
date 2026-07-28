import { describe, expect, it } from "vitest";
import {
  CrossSiteTagReference,
  FederatedAlarmView,
  FederatedReporting,
  FederatedSiteDiscovery,
  MdnsSiteDiscovery,
  MutualTlsSiteIdentityPolicy,
  RegistrySiteDiscovery,
  ReplicatedConfiguration,
  type DiscoveredSite,
} from "../federation";

const NOW = new Date("2026-07-28T12:00:00Z");

function site(
  siteId: string,
  fingerprint = `${siteId}-cert`,
  issuer = "root-ca",
): DiscoveredSite {
  return {
    siteId,
    endpoint: `https://${siteId}.internal:8443`,
    identity: {
      siteId,
      certificateFingerprint: fingerprint,
      issuerFingerprint: issuer,
      subjectAltNames: [`urn:0xscada:site:${siteId}`],
      validFrom: new Date("2026-01-01T00:00:00Z"),
      validTo: new Date("2027-01-01T00:00:00Z"),
    },
  };
}

describe("multi-site federation (#223)", () => {
  it("combines registry/mDNS discovery and enforces the mTLS identity contract", async () => {
    const registry = new RegistrySiteDiscovery({
      listSites: async () => [site("north"), site("untrusted", "bad", "rogue-ca")],
    });
    const mdns = new MdnsSiteDiscovery({
      browse: async (serviceType) => {
        expect(serviceType).toBe("_0xscada._tcp.local");
        return [site("north"), site("south")];
      },
    });
    const policy = new MutualTlsSiteIdentityPolicy({
      trustedIssuerFingerprints: ["root-ca"],
      pinnedSiteFingerprints: { north: "north-cert" },
    });
    // Bind the deterministic validation time for this test.
    const discovery = new FederatedSiteDiscovery([registry, mdns], {
      verify: (candidate) => policy.verify(candidate, NOW),
    });

    const result = await discovery.discover();
    expect(result.sites.map((candidate) => candidate.siteId)).toEqual([
      "north",
      "south",
    ]);
    expect(result.rejected).toContainEqual({
      provider: "registry",
      siteId: "untrusted",
      reason: "certificate issuer is not trusted",
    });
  });

  it("fails a namespace closed when discovery sources advertise different certificates", async () => {
    const discovery = new FederatedSiteDiscovery(
      [
        { name: "registry", discover: async () => [site("north", "cert-a")] },
        { name: "mdns", discover: async () => [site("north", "cert-b")] },
      ],
      { verify: () => ({ accepted: true }) },
    );
    const result = await discovery.discover();
    expect(result.sites).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/conflicting certificates/);
  });

  it("parses and canonicalizes namespace-qualified cross-site tags", () => {
    const reference = CrossSiteTagReference.parse("plant-a:boiler-2/temp.out");
    expect(reference.site).toBe("plant-a");
    expect(reference.area).toBe("boiler-2");
    expect(reference.tag).toBe("temp.out");
    expect(reference.toString()).toBe("plant-a:boiler-2/temp.out");
    expect(() => CrossSiteTagReference.parse("boiler/temp")).toThrow(
      /invalid cross-site tag/,
    );
    expect(() => CrossSiteTagReference.parse("site:../secret")).toThrow(
      /invalid cross-site tag/,
    );
  });

  it("aggregates alarms and reports while exposing partial site failures", async () => {
    const alarms = await new FederatedAlarmView([
      {
        siteId: "north",
        activeAlarms: async () => [
          {
            id: "a-1",
            tag: "boiler/temp",
            severity: 4,
            activeAt: new Date("2026-07-28T10:00:00Z"),
            message: "high",
          },
        ],
      },
      {
        siteId: "south",
        activeAlarms: async () => {
          throw new Error("site offline");
        },
      },
    ]).query();
    expect(alarms.alarms[0]).toMatchObject({
      federatedId: "north:a-1",
      tagReference: "north:boiler/temp",
    });
    expect(alarms.failures).toEqual([
      { siteId: "south", error: "site offline" },
    ]);

    const report = await new FederatedReporting<{ events: number }>([
      {
        siteId: "north",
        generate: async () => ({ events: 12 }),
      },
      {
        siteId: "south",
        generate: async () => {
          throw new Error("report timeout");
        },
      },
    ]).generate(
      "operations",
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-08-01T00:00:00Z"),
    );
    expect(report.sections).toEqual([
      { siteId: "north", data: { events: 12 } },
    ]);
    expect(report.failures).toEqual([
      { siteId: "south", error: "report timeout" },
    ]);
  });

  it("merges replicated configuration associatively and deterministically", () => {
    const north = new ReplicatedConfiguration("north");
    const south = new ReplicatedConfiguration("south");
    north.set("alarm.high", 90);
    south.set("alarm.low", 10);
    north.set("display.units", "celsius");
    south.set("display.units", "fahrenheit");

    const northReplica = new ReplicatedConfiguration("north-copy");
    northReplica.merge(north);
    northReplica.merge(south);
    const southReplica = new ReplicatedConfiguration("south-copy");
    southReplica.merge(south);
    southReplica.merge(north);

    expect(northReplica.value()).toEqual(southReplica.value());
    expect(northReplica.value()).toEqual({
      alarm: { high: 90, low: 10 },
      display: { units: "fahrenheit" },
    });
    expect(northReplica.conflicts()).toHaveLength(1);
    expect(southReplica.conflicts()).toHaveLength(1);
  });

  it("retains tombstones so stale values cannot resurrect after merge", () => {
    const first = new ReplicatedConfiguration("a");
    const staleSet = first.set("gateway.mode", "active");
    first.delete("gateway.mode");
    const second = new ReplicatedConfiguration("b");
    second.apply(staleSet);
    second.merge(first);
    expect(second.value()).toEqual({});
    second.merge(first);
    expect(second.value()).toEqual({});
  });

  it("converges deterministically even if one actor equivocates at a clock", () => {
    const left = new ReplicatedConfiguration("left");
    const right = new ReplicatedConfiguration("right");
    const first = {
      path: "gateway.mode",
      version: { counter: 7, actor: "compromised-peer" },
      value: "active",
      deleted: false,
    };
    const second = { ...first, value: "standby" };
    left.apply(first);
    left.apply(second);
    right.apply(second);
    right.apply(first);
    expect(left.value()).toEqual(right.value());
    expect(left.conflicts()[0].reason).toBe("equivocation");
    expect(right.conflicts()[0].reason).toBe("equivocation");
  });
});
