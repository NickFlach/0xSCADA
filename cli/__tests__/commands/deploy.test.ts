import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerDeployCommand } from "../../src/commands/deploy.js";
import fs from "fs";

vi.mock("child_process", () => ({ execSync: vi.fn().mockReturnValue(""), spawn: vi.fn(() => ({ on: vi.fn((event: string, handler: Function) => { if (event === "close") setTimeout(() => handler(0), 10); return { on: vi.fn() }; }), kill: vi.fn() })) }));
vi.mock("fs", async () => { const actual = await vi.importActual<typeof import("fs")>("fs"); const writeFileSync = vi.fn(); const mkdirSync = vi.fn(); const existsSync = vi.fn().mockReturnValue(true); const mocked = { ...actual, default: { ...actual, writeFileSync, mkdirSync, existsSync }, writeFileSync, mkdirSync, existsSync }; return mocked; });
vi.mock("ora", () => ({ default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), stop: vi.fn(), fail: vi.fn(), succeed: vi.fn(), text: "" })) }));
vi.mock("../../src/output.js", () => ({ setOutputOptions: vi.fn(), output: vi.fn(), outputSection: vi.fn(), outputKeyValue: vi.fn(), outputError: vi.fn(), outputSuccess: vi.fn(), outputWarning: vi.fn(), outputInfo: vi.fn(), outputTable: vi.fn(), colors: { success: (t: string) => t, error: (t: string) => t, warning: (t: string) => t, info: (t: string) => t, dim: (t: string) => t, bold: (t: string) => t, cyan: (t: string) => t, magenta: (t: string) => t } }));

global.fetch = vi.fn();

import { output, outputError, outputSuccess, outputInfo } from "../../src/output.js";

describe("Deploy Command", () => {
  let program: Command;

  beforeEach(() => { vi.clearAllMocks(); program = new Command(); program.exitOverride(); registerDeployCommand(program); });
  afterEach(() => { vi.restoreAllMocks(); });

  describe("command registration", () => {
    it("should register deploy command", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); expect(deployCmd).toBeDefined(); });
    it("should have global options", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); expect(deployCmd?.options.find((o) => o.long === "--env")).toBeDefined(); expect(deployCmd?.options.find((o) => o.long === "--replicas")).toBeDefined(); expect(deployCmd?.options.find((o) => o.long === "--namespace")).toBeDefined(); expect(deployCmd?.options.find((o) => o.long === "--registry")).toBeDefined(); expect(deployCmd?.options.find((o) => o.long === "--dry-run")).toBeDefined(); });
    it("should have compose subcommand", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); expect(deployCmd?.commands.find((c) => c.name() === "compose")).toBeDefined(); });
    it("should have k8s subcommand", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); expect(deployCmd?.commands.find((c) => c.name() === "k8s")).toBeDefined(); });
    it("should have healthcheck subcommand", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); expect(deployCmd?.commands.find((c) => c.name() === "healthcheck")).toBeDefined(); });
    it("should have metrics subcommand", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); expect(deployCmd?.commands.find((c) => c.name() === "metrics")).toBeDefined(); });
    it("should have helm subcommand", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); expect(deployCmd?.commands.find((c) => c.name() === "helm")).toBeDefined(); });
  });

  describe("deploy compose subcommands", () => {
    it("should have generate subcommand", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); const composeCmd = deployCmd?.commands.find((c) => c.name() === "compose"); expect(composeCmd?.commands.find((c) => c.name() === "generate")).toBeDefined(); });
    it("should have up subcommand", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); const composeCmd = deployCmd?.commands.find((c) => c.name() === "compose"); expect(composeCmd?.commands.find((c) => c.name() === "up")).toBeDefined(); });
    it("should have down subcommand", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); const composeCmd = deployCmd?.commands.find((c) => c.name() === "compose"); expect(composeCmd?.commands.find((c) => c.name() === "down")).toBeDefined(); });
    it("should have logs subcommand", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); const composeCmd = deployCmd?.commands.find((c) => c.name() === "compose"); expect(composeCmd?.commands.find((c) => c.name() === "logs")).toBeDefined(); });
    it("should generate docker-compose file", async () => { await program.parseAsync(["node", "test", "deploy", "compose", "generate"]); expect(fs.writeFileSync).toHaveBeenCalled(); expect(outputSuccess).toHaveBeenCalled(); });
    it("should support dry-run", async () => { await program.parseAsync(["node", "test", "deploy", "--dry-run", "compose", "generate"]); expect(fs.writeFileSync).not.toHaveBeenCalled(); expect(outputInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY-RUN]")); });
    it("should output JSON when flag is set", async () => { await program.parseAsync(["node", "test", "deploy", "--json", "compose", "generate"]); expect(output).toHaveBeenCalledWith(expect.objectContaining({ success: true })); });
  });

  describe("deploy k8s subcommands", () => {
    it("should have generate subcommand", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); const k8sCmd = deployCmd?.commands.find((c) => c.name() === "k8s"); expect(k8sCmd?.commands.find((c) => c.name() === "generate")).toBeDefined(); });
    it("should have apply subcommand", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); const k8sCmd = deployCmd?.commands.find((c) => c.name() === "k8s"); expect(k8sCmd?.commands.find((c) => c.name() === "apply")).toBeDefined(); });
    it("should have status subcommand", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); const k8sCmd = deployCmd?.commands.find((c) => c.name() === "k8s"); expect(k8sCmd?.commands.find((c) => c.name() === "status")).toBeDefined(); });
    it("should have helm subcommand", () => { const deployCmd = program.commands.find((c) => c.name() === "deploy"); const k8sCmd = deployCmd?.commands.find((c) => c.name() === "k8s"); expect(k8sCmd?.commands.find((c) => c.name() === "helm")).toBeDefined(); });
    it("should generate K8s manifests", async () => { await program.parseAsync(["node", "test", "deploy", "k8s", "generate"]); expect(fs.writeFileSync).toHaveBeenCalled(); expect(outputSuccess).toHaveBeenCalled(); });
  });

  describe("deploy helm command", () => {
    it("should generate Helm chart files", async () => { await program.parseAsync(["node", "test", "deploy", "helm"]); expect(fs.mkdirSync).toHaveBeenCalled(); expect(fs.writeFileSync).toHaveBeenCalled(); expect(outputSuccess).toHaveBeenCalled(); });
    it("should support dry-run", async () => { await program.parseAsync(["node", "test", "deploy", "--dry-run", "helm"]); expect(fs.writeFileSync).not.toHaveBeenCalled(); expect(outputInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY-RUN]")); });
  });

  describe("deploy healthcheck command", () => {
    it("should check service health", async () => { vi.mocked(global.fetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ status: "healthy" }) } as Response); await program.parseAsync(["node", "test", "deploy", "healthcheck"]); expect(global.fetch).toHaveBeenCalledWith("http://localhost:5000/api/health"); expect(outputSuccess).toHaveBeenCalled(); });
    it("should handle health check failure", async () => { vi.mocked(global.fetch).mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({ status: "unhealthy" }) } as Response); await program.parseAsync(["node", "test", "deploy", "healthcheck"]); expect(outputError).toHaveBeenCalled(); });
    it("should handle network errors", async () => { vi.mocked(global.fetch).mockRejectedValue(new Error("Connection refused")); await program.parseAsync(["node", "test", "deploy", "healthcheck"]); expect(outputError).toHaveBeenCalledWith("Failed to connect to service", "Connection refused"); });
    it("should support dry-run", async () => { await program.parseAsync(["node", "test", "deploy", "--dry-run", "healthcheck"]); expect(global.fetch).not.toHaveBeenCalled(); expect(outputInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY-RUN]")); });
  });

  describe("deploy metrics command", () => {
    it("should export metrics in JSON format by default", async () => { await program.parseAsync(["node", "test", "deploy", "metrics"]); expect(output).toHaveBeenCalledWith(expect.objectContaining({ timestamp: expect.any(String), environment: expect.any(String) })); });
    it("should support dry-run", async () => { await program.parseAsync(["node", "test", "deploy", "--dry-run", "metrics"]); expect(outputInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY-RUN]")); });
  });

  describe("environment configurations", () => {
    it("should generate dev configuration by default", async () => { await program.parseAsync(["node", "test", "deploy", "compose", "generate"]); const callArgs = vi.mocked(fs.writeFileSync).mock.calls[0]; expect(callArgs[1]).toContain("development"); });
    it("should generate production configuration", async () => { await program.parseAsync(["node", "test", "deploy", "--env", "production", "compose", "generate"]); const callArgs = vi.mocked(fs.writeFileSync).mock.calls[0]; expect(callArgs[1]).toContain("production"); });
    it("should generate staging configuration", async () => { await program.parseAsync(["node", "test", "deploy", "--env", "staging", "compose", "generate"]); const callArgs = vi.mocked(fs.writeFileSync).mock.calls[0]; expect(callArgs[1]).toContain("staging"); });
  });
});
