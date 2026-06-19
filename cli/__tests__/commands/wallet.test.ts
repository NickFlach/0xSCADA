import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerWalletCommand } from "../../src/commands/wallet.js";

// Mock secure-storage module
vi.mock("../../src/secure-storage.js", () => ({
  listWallets: vi.fn(() => [
    {
      name: "ops-wallet",
      address: "0x1234567890abcdef1234567890abcdef12345678",
      keyfilePath: "/path/to/keyfile.json",
      isDefault: true,
      createdAt: "2024-01-15T10:30:00Z",
    },
    {
      name: "dev-wallet",
      address: "0xabcdef1234567890abcdef1234567890abcdef12",
      encryptedPrivateKey: "[encrypted]",
      isDefault: false,
      createdAt: "2024-01-16T14:00:00Z",
    },
  ]),
  addWallet: vi.fn((name, keyfilePath, privateKey) => ({
    name,
    address: "0xnewwallet1234567890abcdef1234567890abcd",
    keyfilePath,
    encryptedPrivateKey: privateKey ? "[encrypted]" : undefined,
    isDefault: false,
    createdAt: new Date().toISOString(),
  })),
  removeWallet: vi.fn((name) => name === "ops-wallet" || name === "dev-wallet"),
  setDefaultWallet: vi.fn((name) => name === "ops-wallet" || name === "dev-wallet"),
  getWallet: vi.fn((name) => {
    if (name === "ops-wallet" || name === undefined) {
      return {
        name: "ops-wallet",
        address: "0x1234567890abcdef1234567890abcdef12345678",
        keyfilePath: "/path/to/keyfile.json",
        isDefault: true,
        createdAt: "2024-01-15T10:30:00Z",
      };
    }
    if (name === "dev-wallet") {
      return {
        name: "dev-wallet",
        address: "0xabcdef1234567890abcdef1234567890abcdef12",
        encryptedPrivateKey: "[encrypted]",
        isDefault: false,
        createdAt: "2024-01-16T14:00:00Z",
      };
    }
    return undefined;
  }),
  signMessage: vi.fn((walletName, message) => {
    if (walletName === "dev-wallet") {
      return "0xsignature123456789abcdef";
    }
    return null; // Keyfile wallets can't sign without password
  }),
}));

vi.mock("../../src/api.js", () => ({
  getApiClient: vi.fn(() => ({
    getBlockchainStatus: vi.fn().mockResolvedValue({
      success: true,
      data: { enabled: true },
    }),
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
  listWallets,
  addWallet,
  removeWallet,
  setDefaultWallet,
  getWallet,
  signMessage,
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

describe("Wallet Command", () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerWalletCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("wallet list", () => {
    it("should register wallet command with list subcommand", () => {
      const walletCmd = program.commands.find((c) => c.name() === "wallet");
      expect(walletCmd).toBeDefined();

      const listCmd = walletCmd?.commands.find((c) => c.name() === "list");
      expect(listCmd).toBeDefined();
    });

    it("should list all wallets", async () => {
      await program.parseAsync(["node", "test", "wallet", "list"]);

      expect(listWallets).toHaveBeenCalled();
      expect(outputSection).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "wallet", "list", "--json"]);

      expect(output).toHaveBeenCalled();
    });

    it("should show warning when no wallets exist", async () => {
      vi.mocked(listWallets).mockReturnValueOnce([]);

      await program.parseAsync(["node", "test", "wallet", "list"]);

      expect(outputWarning).toHaveBeenCalledWith("No wallets configured");
    });
  });

  describe("wallet add", () => {
    it("should add wallet with keyfile", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "add",
        "--name",
        "new-wallet",
        "--keyfile",
        "/path/to/key.json",
      ]);

      expect(addWallet).toHaveBeenCalledWith(
        "new-wallet",
        "/path/to/key.json",
        undefined
      );
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should add wallet with private key", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "add",
        "--name",
        "pk-wallet",
        "--private-key",
        "0xprivatekey123",
      ]);

      expect(addWallet).toHaveBeenCalledWith(
        "pk-wallet",
        undefined,
        "0xprivatekey123"
      );
      expect(outputWarning).toHaveBeenCalled(); // Warning about private key usage
    });

    it("should error when no key source provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "add",
        "--name",
        "no-key-wallet",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        "No key source provided",
        expect.any(String)
      );
      expect(addWallet).not.toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "add",
        "--name",
        "new-wallet",
        "--keyfile",
        "/path/to/key.json",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          wallet: expect.objectContaining({
            name: "new-wallet",
          }),
        })
      );
    });
  });

  describe("wallet remove", () => {
    it("should remove an existing wallet", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "remove",
        "ops-wallet",
      ]);

      expect(removeWallet).toHaveBeenCalledWith("ops-wallet");
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should error when wallet not found", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "remove",
        "nonexistent",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        "Wallet not found",
        expect.any(String)
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "remove",
        "ops-wallet",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: "Wallet removed",
        })
      );
    });
  });

  describe("wallet balance", () => {
    it("should get balance for default wallet", async () => {
      await program.parseAsync(["node", "test", "wallet", "balance"]);

      expect(getWallet).toHaveBeenCalledWith(undefined);
      expect(outputSection).toHaveBeenCalled();
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should get balance for named wallet", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "balance",
        "dev-wallet",
      ]);

      expect(getWallet).toHaveBeenCalledWith("dev-wallet");
    });

    it("should error when wallet not found", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "balance",
        "nonexistent",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        "Wallet not found",
        expect.any(String)
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "balance",
        "--json",
      ]);

      expect(output).toHaveBeenCalled();
    });
  });

  describe("wallet sign", () => {
    it("should sign message with default wallet", async () => {
      // First need to mock getWallet to return dev-wallet as default (which can sign)
      vi.mocked(getWallet).mockReturnValueOnce({
        name: "dev-wallet",
        address: "0xabcdef1234567890abcdef1234567890abcdef12",
        encryptedPrivateKey: "[encrypted]",
        isDefault: true,
        createdAt: "2024-01-16T14:00:00Z",
      });

      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "sign",
        "--message",
        "Hello World",
      ]);

      expect(signMessage).toHaveBeenCalledWith("dev-wallet", "Hello World");
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should sign message with named wallet", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "sign",
        "--message",
        "Test message",
        "--wallet",
        "dev-wallet",
      ]);

      expect(getWallet).toHaveBeenCalledWith("dev-wallet");
      expect(signMessage).toHaveBeenCalledWith("dev-wallet", "Test message");
    });

    it("should error when signing fails", async () => {
      // ops-wallet returns null for signMessage (keyfile without password)
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "sign",
        "--message",
        "Test",
        "--wallet",
        "ops-wallet",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        "Signing failed",
        expect.any(String)
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "sign",
        "--message",
        "Test",
        "--wallet",
        "dev-wallet",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          wallet: "dev-wallet",
          message: "Test",
          signature: expect.any(String),
        })
      );
    });
  });

  describe("wallet set-default", () => {
    it("should set default wallet", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "set-default",
        "dev-wallet",
      ]);

      expect(setDefaultWallet).toHaveBeenCalledWith("dev-wallet");
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should error when wallet not found", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "set-default",
        "nonexistent",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        "Wallet not found",
        expect.any(String)
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "set-default",
        "dev-wallet",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          defaultWallet: "dev-wallet",
        })
      );
    });
  });

  describe("wallet show", () => {
    it("should show default wallet details", async () => {
      await program.parseAsync(["node", "test", "wallet", "show"]);

      expect(getWallet).toHaveBeenCalledWith(undefined);
      expect(outputSection).toHaveBeenCalled();
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should show named wallet details", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "show",
        "dev-wallet",
      ]);

      expect(getWallet).toHaveBeenCalledWith("dev-wallet");
    });

    it("should error when wallet not found", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "show",
        "nonexistent",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        "Wallet not found",
        expect.any(String)
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "wallet",
        "show",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "ops-wallet",
          address: expect.any(String),
        })
      );
    });
  });
});
