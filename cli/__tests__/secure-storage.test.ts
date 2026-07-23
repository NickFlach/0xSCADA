import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Mock fs module
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock os module
vi.mock("os", () => ({
  default: {
    homedir: vi.fn(() => "/home/testuser"),
    hostname: vi.fn(() => "testhost"),
    userInfo: vi.fn(() => ({ username: "testuser" })),
  },
  homedir: vi.fn(() => "/home/testuser"),
  hostname: vi.fn(() => "testhost"),
  userInfo: vi.fn(() => ({ username: "testuser" })),
}));

describe("Secure Storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    // Default: no files exist
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clear any env vars we set
    delete process.env.OXSCADA_API_KEY;
    delete process.env["0XSCADA_API_KEY"];
  });

  describe("getStoragePaths", () => {
    it("should return correct storage paths", async () => {
      const { getStoragePaths } = await import("../src/secure-storage.js");

      const paths = getStoragePaths();

      expect(paths.credentialsPath).toContain(".0xscada");
      expect(paths.credentialsPath).toContain("credentials.enc");
      expect(paths.walletsPath).toContain(".0xscada");
      expect(paths.walletsPath).toContain("wallets.enc");
    });
  });

  describe("API Key Authentication", () => {
    describe("login", () => {
      it("should store API key securely", async () => {
        const { login } = await import("../src/secure-storage.js");

        login("test-api-key-123");

        expect(fs.mkdirSync).toHaveBeenCalled();
        expect(fs.writeFileSync).toHaveBeenCalled();
      });
    });

    describe("logout", () => {
      it("should clear stored credentials", async () => {
        const { logout } = await import("../src/secure-storage.js");

        logout();

        expect(fs.writeFileSync).toHaveBeenCalled();
      });
    });

    describe("getAuthStatus", () => {
      it("should return not logged in when no credentials exist", async () => {
        const { getAuthStatus } = await import("../src/secure-storage.js");

        const status = getAuthStatus();

        expect(status.isLoggedIn).toBe(false);
        expect(status.hasEnvKey).toBe(false);
      });

      it("should detect environment variable API key", async () => {
        process.env.OXSCADA_API_KEY = "env-api-key";

        // Re-import to get fresh module
        vi.resetModules();
        const { getAuthStatus } = await import("../src/secure-storage.js");

        const status = getAuthStatus();

        expect(status.isLoggedIn).toBe(true);
        expect(status.hasEnvKey).toBe(true);
      });
    });

    describe("getCurrentApiKey", () => {
      it("should return undefined when not logged in", async () => {
        const { getCurrentApiKey } = await import("../src/secure-storage.js");

        const key = getCurrentApiKey();

        expect(key).toBeUndefined();
      });

      it("should return environment variable when set", async () => {
        process.env.OXSCADA_API_KEY = "env-api-key";

        vi.resetModules();
        const { getCurrentApiKey } = await import("../src/secure-storage.js");

        const key = getCurrentApiKey();

        expect(key).toBe("env-api-key");
      });
    });
  });

  describe("API Key Management", () => {
    describe("listApiKeys", () => {
      it("should return empty array when no keys exist", async () => {
        const { listApiKeys } = await import("../src/secure-storage.js");

        const keys = listApiKeys();

        expect(keys).toEqual([]);
      });
    });

    describe("createApiKey", () => {
      it("should create a new API key", async () => {
        const { createApiKey } = await import("../src/secure-storage.js");

        const newKey = createApiKey("test-key", ["read", "write"]);

        expect(newKey.id).toBeDefined();
        expect(newKey.name).toBe("test-key");
        expect(newKey.key).toMatch(/^0xscada_/);
        expect(newKey.scopes).toEqual(["read", "write"]);
        expect(newKey.createdAt).toBeDefined();
      });

      it("should store the key securely", async () => {
        const { createApiKey } = await import("../src/secure-storage.js");

        createApiKey("test-key", ["read"]);

        expect(fs.writeFileSync).toHaveBeenCalled();
      });
    });

    describe("revokeApiKey", () => {
      it("should return false when key does not exist", async () => {
        const { revokeApiKey } = await import("../src/secure-storage.js");

        const result = revokeApiKey("nonexistent");

        expect(result).toBe(false);
      });
    });

    describe("rotateApiKey", () => {
      it("should return null when key does not exist", async () => {
        const { rotateApiKey } = await import("../src/secure-storage.js");

        const result = rotateApiKey("nonexistent");

        expect(result).toBeNull();
      });
    });
  });

  describe("Wallet Management", () => {
    describe("listWallets", () => {
      it("should return empty array when no wallets exist", async () => {
        const { listWallets } = await import("../src/secure-storage.js");

        const wallets = listWallets();

        expect(wallets).toEqual([]);
      });
    });

    describe("addWallet", () => {
      it("should throw when neither keyfile nor private key provided", async () => {
        const { addWallet } = await import("../src/secure-storage.js");

        expect(() => addWallet("test-wallet")).toThrow(
          "Either keyfilePath or privateKey must be provided"
        );
      });

      it("should throw when keyfile does not exist", async () => {
        const { addWallet } = await import("../src/secure-storage.js");

        expect(() =>
          addWallet("test-wallet", "/nonexistent/keyfile.json")
        ).toThrow("Keyfile not found");
      });

      it("should add wallet with private key", async () => {
        const { addWallet } = await import("../src/secure-storage.js");

        const wallet = addWallet("test-wallet", undefined, "0xprivatekey");

        expect(wallet.name).toBe("test-wallet");
        expect(wallet.address).toBeDefined();
        expect(wallet.address).toMatch(/^0x/);
        expect(fs.writeFileSync).toHaveBeenCalled();
      });

      it("should add wallet with valid keyfile", async () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => {
          if (typeof p === "string" && p.includes("keyfile.json")) return true;
          return false;
        });
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
          if (typeof p === "string" && p.includes("keyfile.json")) {
            return JSON.stringify({
              address: "1234567890abcdef1234567890abcdef12345678",
            });
          }
          return "";
        });

        const { addWallet } = await import("../src/secure-storage.js");

        const wallet = addWallet("test-wallet", "/path/to/keyfile.json");

        expect(wallet.name).toBe("test-wallet");
        expect(wallet.address).toBe("0x1234567890abcdef1234567890abcdef12345678");
        expect(wallet.keyfilePath).toBe(path.resolve("/path/to/keyfile.json"));
      });
    });

    describe("removeWallet", () => {
      it("should return false when wallet does not exist", async () => {
        const { removeWallet } = await import("../src/secure-storage.js");

        const result = removeWallet("nonexistent");

        expect(result).toBe(false);
      });
    });

    describe("setDefaultWallet", () => {
      it("should return false when wallet does not exist", async () => {
        const { setDefaultWallet } = await import("../src/secure-storage.js");

        const result = setDefaultWallet("nonexistent");

        expect(result).toBe(false);
      });
    });

    describe("getWallet", () => {
      it("should return undefined when no wallets exist", async () => {
        const { getWallet } = await import("../src/secure-storage.js");

        const wallet = getWallet();

        expect(wallet).toBeUndefined();
      });

      it("should return undefined for nonexistent wallet name", async () => {
        const { getWallet } = await import("../src/secure-storage.js");

        const wallet = getWallet("nonexistent");

        expect(wallet).toBeUndefined();
      });
    });

    describe("signMessage", () => {
      it("should return null when wallet does not exist", async () => {
        const { signMessage } = await import("../src/secure-storage.js");

        const signature = signMessage("nonexistent", "test message");

        expect(signature).toBeNull();
      });
    });
  });

  describe("clearAllData", () => {
    it("should delete storage files if they exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const { clearAllData } = await import("../src/secure-storage.js");

      clearAllData();

      expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
    });

    it("should not throw when files do not exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const { clearAllData } = await import("../src/secure-storage.js");

      expect(() => clearAllData()).not.toThrow();
    });
  });
});
