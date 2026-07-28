import { describe, expect, it } from "vitest";
import {
  InMemoryMigrationJournal,
  MigrationExecutionError,
  ReversibleMigrationRunner,
  RollingCanaryOrchestrator,
  TypedFeatureFlags,
  VersionCompatibilityMatrix,
  type DatabaseMigration,
  type DeploymentAdapter,
  type DeploymentInstance,
} from "../upgrade";

describe("zero-downtime upgrades (#227)", () => {
  it("enforces a fail-closed version compatibility matrix", () => {
    const matrix = new VersionCompatibilityMatrix([
      { from: "1.0.0", to: "1.1.0", compatible: true },
      {
        from: "1.1.0",
        to: "2.0.0",
        compatible: false,
        reason: "protocol v2 cannot speak to v1 peers",
      },
    ]);
    expect(matrix.check("1.0.0", "1.1.0").compatible).toBe(true);
    expect(() => matrix.assertCompatible("1.0.0", "2.0.0")).toThrow(
      /uncertified/,
    );
    expect(() => matrix.assertCompatible("1.1.0", "2.0.0")).toThrow(
      /protocol v2/,
    );
  });

  it("provides typed, validated, stable gradual feature rollout", () => {
    type Flags = { newHistorian: boolean; queryLimit: number };
    const definitions = {
      newHistorian: {
        defaultValue: false,
        validate: (value: unknown): value is boolean => typeof value === "boolean",
      },
      queryLimit: {
        defaultValue: 100,
        validate: (value: unknown): value is number =>
          typeof value === "number" && Number.isInteger(value) && value > 0,
      },
    };
    const first = new TypedFeatureFlags<Flags>(definitions);
    const second = new TypedFeatureFlags<Flags>(definitions);
    for (const flags of [first, second]) {
      flags.configure("newHistorian", {
        enabled: true,
        value: true,
        percentage: 25,
        includeSubjects: ["canary"],
        excludeSubjects: ["blocked"],
        sites: ["north"],
      });
    }
    expect(
      first.evaluate("newHistorian", {
        subjectId: "canary",
        siteId: "north",
      }),
    ).toBe(true);
    expect(
      first.evaluate("newHistorian", {
        subjectId: "blocked",
        siteId: "north",
      }),
    ).toBe(false);
    expect(
      first.evaluate("newHistorian", {
        subjectId: "canary",
        siteId: "south",
      }),
    ).toBe(false);
    for (let index = 0; index < 100; index += 1) {
      const context = { subjectId: `operator-${index}`, siteId: "north" };
      expect(first.evaluate("newHistorian", context)).toBe(
        second.evaluate("newHistorian", context),
      );
    }
    expect(() =>
      first.configure("queryLimit", {
        enabled: true,
        value: -1,
        percentage: 100,
      }),
    ).toThrow(/invalid value/);
  });

  it("journals migrations and rolls partial work back in reverse order", async () => {
    const journal = new InMemoryMigrationJournal(
      () => new Date("2026-07-28T12:00:00Z"),
    );
    const runner = new ReversibleMigrationRunner<string[]>(journal);
    const events: string[] = [];
    const migration = (
      id: string,
      fail = false,
    ): DatabaseMigration<string[]> => ({
      id,
      up: async () => {
        events.push(`up:${id}`);
        if (fail) {
          throw new Error("DDL rejected");
        }
      },
      down: async () => {
        events.push(`down:${id}`);
      },
    });

    await expect(
      runner.run([migration("001"), migration("002", true)], events),
    ).rejects.toMatchObject<Partial<MigrationExecutionError>>({
      failedMigration: "002",
      rollbackFailures: [],
    });
    expect(events).toEqual(["up:001", "up:002", "down:002", "down:001"]);
    expect((await journal.entries()).map((entry) => `${entry.migrationId}:${entry.status}`)).toEqual([
      "001:started",
      "001:applied",
      "002:started",
      "002:failed",
      "002:rollback-started",
      "002:rolled-back",
      "001:rollback-started",
      "001:rolled-back",
    ]);
  });

  it("skips migrations already applied according to journal state", async () => {
    const journal = new InMemoryMigrationJournal();
    await journal.append({ migrationId: "001", status: "started" });
    await journal.append({ migrationId: "001", status: "applied" });
    const up = async () => {
      throw new Error("must not run");
    };
    const applied = await new ReversibleMigrationRunner(journal).run(
      [{ id: "001", up, down: async () => undefined }],
      {},
    );
    expect(applied).toEqual([]);
  });

  it("runs canaries before rolling batches and restores traffic", async () => {
    const fake = deployment([
      { id: "a", version: "1.0.0", healthy: true, zone: "1" },
      { id: "b", version: "1.0.0", healthy: true, zone: "2" },
      { id: "c", version: "1.0.0", healthy: true, zone: "1" },
    ]);
    const orchestrator = new RollingCanaryOrchestrator(
      fake.adapter,
      new VersionCompatibilityMatrix([
        { from: "1.0.0", to: "1.1.0", compatible: true },
      ]),
    );
    const result = await orchestrator.execute({
      targetVersion: "1.1.0",
      canaryCount: 1,
      batchSize: 2,
      healthTimeoutMs: 1_000,
    });
    expect(result.succeeded).toBe(true);
    expect(result.upgraded).toHaveLength(3);
    expect(result.events.filter((event) => event.stage === "canary")).toHaveLength(2);
    expect(result.events.filter((event) => event.stage === "rolling")).toHaveLength(4);
    expect(fake.calls.filter((call) => call.startsWith("restore:"))).toHaveLength(3);
    expect([...fake.versions.values()]).toEqual(["1.1.0", "1.1.0", "1.1.0"]);
  });

  it("rolls every changed node back when a health gate fails", async () => {
    const fake = deployment(
      [
        { id: "a", version: "1.0.0", healthy: true },
        { id: "b", version: "1.0.0", healthy: true },
        { id: "c", version: "1.0.0", healthy: true },
      ],
      2,
    );
    const result = await new RollingCanaryOrchestrator(
      fake.adapter,
      new VersionCompatibilityMatrix([
        { from: "1.0.0", to: "1.1.0", compatible: true },
      ]),
    ).execute({
      targetVersion: "1.1.0",
      canaryCount: 1,
      batchSize: 1,
      healthTimeoutMs: 1_000,
    });
    expect(result.succeeded).toBe(false);
    expect(result.failure).toMatch(/health gate/);
    expect(result.rollbackFailures).toEqual([]);
    expect([...fake.versions.values()]).toEqual(["1.0.0", "1.0.0", "1.0.0"]);
    expect(result.events.some((event) => event.stage === "rollback")).toBe(true);
  });

  it("performs no deployment side effects for an incompatible target", async () => {
    const fake = deployment([
      { id: "a", version: "1.0.0", healthy: true },
    ]);
    await expect(
      new RollingCanaryOrchestrator(
        fake.adapter,
        new VersionCompatibilityMatrix([]),
      ).execute({
        targetVersion: "2.0.0",
        canaryCount: 1,
        batchSize: 1,
        healthTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(/uncertified/);
    expect(fake.calls).toEqual([]);
  });
});

function deployment(
  initial: readonly DeploymentInstance[],
  failHealthCall?: number,
): {
  adapter: DeploymentAdapter;
  calls: string[];
  versions: Map<string, string>;
} {
  const calls: string[] = [];
  const versions = new Map(initial.map((instance) => [instance.id, instance.version]));
  let healthCalls = 0;
  return {
    calls,
    versions,
    adapter: {
      instances: async () => initial,
      drain: async (id) => {
        calls.push(`drain:${id}`);
      },
      deploy: async (id, version) => {
        calls.push(`deploy:${id}:${version}`);
        versions.set(id, version);
      },
      waitUntilHealthy: async (id) => {
        calls.push(`health:${id}`);
        healthCalls += 1;
        return healthCalls !== failHealthCall;
      },
      restoreTraffic: async (id) => {
        calls.push(`restore:${id}`);
      },
      rollback: async (id, version) => {
        calls.push(`rollback:${id}:${version}`);
        versions.set(id, version);
      },
    },
  };
}
