import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RollingCanaryOrchestrator,
  VersionCompatibilityMatrix,
  type DeploymentAdapter,
  type UpgradeJournal,
  type UpgradeJournalEntry,
} from "../upgrade";
import {
  ZeroDowntimeUpgradeRuntime,
  type ZeroDowntimeUpgradeBindings,
} from "../upgrade-runtime";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("zero-downtime upgrade production runtime", () => {
  it("binds production services and exposes their operational health", async () => {
    const runtime = new ZeroDowntimeUpgradeRuntime();
    const configured = bindings();

    runtime.configure(configured);
    await runtime.initialize();

    expect(runtime.isEnabled()).toBe(true);
    expect(runtime.isInitialized()).toBe(true);
    expect(runtime.bindings().journal).toBe(configured.journal);
    expect(runtime.bindings().orchestrator.usesJournal(configured.journal)).toBe(
      true,
    );
    await expect(runtime.health()).resolves.toEqual({
      healthy: true,
      details: { controller: "leader" },
    });
  });

  it("fails closed when enabled without a production bindings module", async () => {
    vi.stubEnv("ZERO_DOWNTIME_UPGRADES_ENABLED", "true");
    vi.stubEnv("ZERO_DOWNTIME_UPGRADES_BINDINGS_MODULE", "");
    const runtime = new ZeroDowntimeUpgradeRuntime();

    await expect(runtime.initialize()).rejects.toThrow(
      /ZERO_DOWNTIME_UPGRADES_BINDINGS_MODULE is required/,
    );
    await expect(runtime.health()).resolves.toMatchObject({
      healthy: false,
      message: "enabled but not initialized",
    });
  });

  it("loads an enabled deployment through the bindings-module factory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "0xscada-upgrade-runtime-"));
    try {
      const modulePath = join(directory, "bindings.mjs");
      await writeFile(
        modulePath,
        `export function createZeroDowntimeUpgradeBindings(factories) {
  let sequence = 0;
  const journal = {
    durable: true,
    entries: async () => [],
    append: async (entry) => ({
      ...entry,
      sequence: ++sequence,
      timestamp: new Date(),
    }),
  };
  const compatibility = new factories.VersionCompatibilityMatrix([]);
  const orchestrator = new factories.RollingCanaryOrchestrator(
    {
      instances: async () => [],
      drain: async () => undefined,
      deploy: async () => undefined,
      waitUntilHealthy: async () => true,
      restoreTraffic: async () => undefined,
      rollback: async () => undefined,
    },
    compatibility,
    journal,
  );
  return {
    orchestrator,
    compatibility,
    journal,
    migrations: { run: async () => [] },
    featureFlags: { evaluate: () => false },
    healthCheck: async () => ({
      healthy: true,
      message: "bindings module loaded",
    }),
  };
}
`,
        "utf8",
      );
      vi.stubEnv("ZERO_DOWNTIME_UPGRADES_ENABLED", "true");
      vi.stubEnv("ZERO_DOWNTIME_UPGRADES_BINDINGS_MODULE", modulePath);
      const runtime = new ZeroDowntimeUpgradeRuntime();

      await runtime.initialize();

      expect(runtime.isInitialized()).toBe(true);
      await expect(runtime.health()).resolves.toMatchObject({
        healthy: true,
        message: "bindings module loaded",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an in-memory journal that cannot survive controller loss", () => {
    const configured = bindings();
    const volatileJournal: UpgradeJournal = {
      ...configured.journal,
      durable: false,
    };

    expect(() =>
      new ZeroDowntimeUpgradeRuntime().configure({
        ...configured,
        journal: volatileJournal,
      }),
    ).toThrow(/require a durable journal/);
  });

  it("rejects an orchestrator wired to a different journal", () => {
    const configured = bindings();
    const otherJournal = durableJournal();
    const mismatched = new RollingCanaryOrchestrator(
      deploymentAdapter,
      configured.compatibility,
      otherJournal,
    );

    expect(() =>
      new ZeroDowntimeUpgradeRuntime().configure({
        ...configured,
        orchestrator: mismatched,
      }),
    ).toThrow(/must use the configured durable journal/);
  });

  it("requires callable migration and feature-flag services", () => {
    const configured = bindings();

    expect(() =>
      new ZeroDowntimeUpgradeRuntime().configure({
        ...configured,
        migrations: {},
      }),
    ).toThrow(/migration service/);
    expect(() =>
      new ZeroDowntimeUpgradeRuntime().configure({
        ...configured,
        featureFlags: {},
      }),
    ).toThrow(/feature-flag service/);
  });

  it("converts a throwing deployment health probe into unhealthy state", async () => {
    const runtime = new ZeroDowntimeUpgradeRuntime();
    runtime.configure({
      ...bindings(),
      healthCheck: async () => {
        throw new Error("deployment controller unavailable");
      },
    });
    await runtime.initialize();

    await expect(runtime.health()).resolves.toEqual({
      healthy: false,
      message: "deployment controller unavailable",
    });
  });
});

function bindings(): ZeroDowntimeUpgradeBindings {
  const journal = durableJournal();
  const compatibility = new VersionCompatibilityMatrix([]);
  return {
    journal,
    compatibility,
    orchestrator: new RollingCanaryOrchestrator(
      deploymentAdapter,
      compatibility,
      journal,
    ),
    migrations: {
      run: async () => [],
    },
    featureFlags: {
      evaluate: () => false,
    },
    healthCheck: async () => ({
      healthy: true,
      details: { controller: "leader" },
    }),
  };
}

function durableJournal(): UpgradeJournal {
  const entries: UpgradeJournalEntry[] = [];
  return {
    durable: true,
    entries: async () => structuredClone(entries),
    append: async (entry) => {
      const recorded: UpgradeJournalEntry = {
        ...entry,
        sequence: entries.length + 1,
        timestamp: new Date(),
      };
      entries.push(recorded);
      return structuredClone(recorded);
    },
  };
}

const deploymentAdapter: DeploymentAdapter = {
  instances: async () => [],
  drain: async () => undefined,
  deploy: async () => undefined,
  waitUntilHealthy: async () => true,
  restoreTraffic: async () => undefined,
  rollback: async () => undefined,
};
