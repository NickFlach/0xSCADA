import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerAuthCommand } from "../../src/commands/auth.js";

// Mock secure-storage module
vi.mock("../../src/secure-storage.js", () => ({
  login: vi.fn(),
  logout: vi.fn(),
  getAuthStatus: vi.fn(() => ({
    isLoggedIn: true,
    hasEnvKey: false,
    loginTime: "2024-01-15T10:30:00Z",
    apiKeyCount: 2,
  })),
  getCurrentApiKey: vi.fn(() => "0xscada_test_api_key_1234567890"),
  listApiKeys: vi.fn(() => [
    {
      id: "key1",
      name: "test-key",
      key: "0xscada_...7890",
      scopes: ["read", "write"],
      createdAt: "2024-01-15T10:30:00Z",
    },
  ]),
  createApiKey: vi.fn((name, scopes) => ({
    id: "newkey1",
    name,
    key: "0xscada_new_api_key_abcdef123456",
    scopes,
    createdAt: new Date().toISOString(),
  })),
  revokeApiKey: vi.fn((keyId) => keyId === "key1"),
  rotateApiKey: vi.fn((keyId) =>
    keyId === "key1"
      ? {
          id: keyId,
          name: "test-key",
          key: "0xscada_rotated_key_xyz789",
          scopes: ["read", "write"],
          createdAt: new Date().toISOString(),
        }
      : null
  ),
  getStoragePaths: vi.fn(() => ({
    credentialsPath: "/home/.0xscada/credentials.enc",
    walletsPath: "/home/.0xscada/wallets.enc",
  })),
}));

vi.mock("../../src/output.js", () => ({
  setOutputOptions: vi.fn(),
  output: vi.fn(),
  outputSection: vi.fn(),
  outputKeyValue: vi.fn(),
  outputError: vi.fn(),
  outputSuccess: vi.fn(),
  outputWarning: vi.fn(),
  outputTable: vi.fn(),
  colors: {
    success: (t: string) => t,
    error: (t: string) => t,
    warning: (t: string) => t,
    info: (t: string) => t,
    dim: (t: string) => t,
    bold: (t: string) => t,
    cyan: (t: string) => t,
    magenta: (t: string) => t,
  },
  formatDate: (d: string) => d,
}));

import {
  login,
  logout,
  getAuthStatus,
  getCurrentApiKey,
  listApiKeys,
  createApiKey,
  revokeApiKey,
  rotateApiKey,
} from "../../src/secure-storage.js";
import {
  output,
  outputError,
  outputSuccess,
  outputSection,
  outputKeyValue,
  outputTable,
  outputWarning,
} from "../../src/output.js";

describe("Auth Command", () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerAuthCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("auth login", () => {
    it("should register auth command with login subcommand", () => {
      const authCmd = program.commands.find((c) => c.name() === "auth");
      expect(authCmd).toBeDefined();

      const loginCmd = authCmd?.commands.find((c) => c.name() === "login");
      expect(loginCmd).toBeDefined();
    });

    it("should login with provided API key", async () => {
      await program.parseAsync([
        "node",
        "test",
        "auth",
        "login",
        "--key",
        "test-api-key",
      ]);

      expect(login).toHaveBeenCalledWith("test-api-key");
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "auth",
        "login",
        "--key",
        "test-api-key",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: "Logged in successfully",
        })
      );
    });

    it("should error when no API key provided", async () => {
      await program.parseAsync(["node", "test", "auth", "login"]);

      expect(outputError).toHaveBeenCalledWith(
        "No API key provided",
        expect.any(String)
      );
      expect(login).not.toHaveBeenCalled();
    });
  });

  describe("auth logout", () => {
    it("should logout successfully", async () => {
      await program.parseAsync(["node", "test", "auth", "logout"]);

      expect(logout).toHaveBeenCalled();
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "auth", "logout", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: "Logged out successfully",
        })
      );
    });
  });

  describe("auth status", () => {
    it("should show authentication status", async () => {
      await program.parseAsync(["node", "test", "auth", "status"]);

      expect(getAuthStatus).toHaveBeenCalled();
      expect(getCurrentApiKey).toHaveBeenCalled();
      expect(outputSection).toHaveBeenCalled();
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "auth", "status", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          isLoggedIn: true,
          hasEnvKey: false,
          apiKeyCount: 2,
        })
      );
    });
  });

  describe("auth keys list", () => {
    it("should list API keys", async () => {
      await program.parseAsync(["node", "test", "auth", "keys", "list"]);

      expect(listApiKeys).toHaveBeenCalled();
      expect(outputSection).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "auth",
        "keys",
        "list",
        "--json",
      ]);

      expect(output).toHaveBeenCalled();
    });

    it("should show warning when no keys exist", async () => {
      vi.mocked(listApiKeys).mockReturnValueOnce([]);

      await program.parseAsync(["node", "test", "auth", "keys", "list"]);

      expect(outputWarning).toHaveBeenCalledWith("No API keys stored");
    });
  });

  describe("auth keys create", () => {
    it("should create a new API key", async () => {
      await program.parseAsync([
        "node",
        "test",
        "auth",
        "keys",
        "create",
        "--name",
        "new-key",
      ]);

      expect(createApiKey).toHaveBeenCalledWith("new-key", ["read", "write"]);
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should create a key with custom scopes", async () => {
      await program.parseAsync([
        "node",
        "test",
        "auth",
        "keys",
        "create",
        "--name",
        "readonly-key",
        "--scopes",
        "read",
      ]);

      expect(createApiKey).toHaveBeenCalledWith("readonly-key", ["read"]);
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "auth",
        "keys",
        "create",
        "--name",
        "new-key",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          key: expect.objectContaining({
            name: "new-key",
          }),
        })
      );
    });
  });

  describe("auth keys revoke", () => {
    it("should revoke an existing key", async () => {
      await program.parseAsync([
        "node",
        "test",
        "auth",
        "keys",
        "revoke",
        "key1",
      ]);

      expect(revokeApiKey).toHaveBeenCalledWith("key1");
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should error when key not found", async () => {
      await program.parseAsync([
        "node",
        "test",
        "auth",
        "keys",
        "revoke",
        "nonexistent",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        "Key not found",
        expect.any(String)
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "auth",
        "keys",
        "revoke",
        "key1",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: "API key revoked",
        })
      );
    });
  });

  describe("auth keys rotate", () => {
    it("should rotate an existing key", async () => {
      await program.parseAsync([
        "node",
        "test",
        "auth",
        "keys",
        "rotate",
        "key1",
      ]);

      expect(rotateApiKey).toHaveBeenCalledWith("key1");
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should error when key not found", async () => {
      await program.parseAsync([
        "node",
        "test",
        "auth",
        "keys",
        "rotate",
        "nonexistent",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        "Key not found",
        expect.any(String)
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "auth",
        "keys",
        "rotate",
        "key1",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          key: expect.objectContaining({
            id: "key1",
          }),
        })
      );
    });
  });
});
