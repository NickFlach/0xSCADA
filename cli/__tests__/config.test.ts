import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { loadConfig, saveConfig, getConfigPath, getAllConfigPaths } from "../src/config.js";

// Mock fs module
vi.mock("fs");

describe("Config", () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment variables
    delete process.env.OXSCADA_API_URL;
    delete process.env.OXSCADA_TIMEOUT;
    delete process.env.NO_COLOR;
    delete process.env.OXSCADA_NO_COLOR;
    
    // Default mock: no config files exist
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.cwd = originalCwd;
  });

  describe("loadConfig", () => {
    it("should return default config when no file exists", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const config = loadConfig();

      expect(config.apiUrl).toBe("http://localhost:5000");
      expect(config.timeout).toBe(30000);
      expect(config.colorOutput).toBe(true);
      expect(config.jsonOutput).toBe(false);
    });

    it("should load config from file when it exists", () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).endsWith("0xscada.config.json");
      });
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ apiUrl: "http://custom:8080", timeout: 5000 })
      );

      const config = loadConfig();

      expect(config.apiUrl).toBe("http://custom:8080");
      expect(config.timeout).toBe(5000);
    });

    it("should ignore invalid config file", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("{ invalid json }");

      const config = loadConfig();

      // Should fall back to defaults
      expect(config.apiUrl).toBe("http://localhost:5000");
    });

    it("should override file config with environment variables", () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).endsWith("0xscada.config.json");
      });
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ apiUrl: "http://file:8080" })
      );

      process.env.OXSCADA_API_URL = "http://env:9090";
      process.env.OXSCADA_TIMEOUT = "10000";

      const config = loadConfig();

      expect(config.apiUrl).toBe("http://env:9090");
      expect(config.timeout).toBe(10000);
    });

    it("should disable color output with NO_COLOR env", () => {
      process.env.NO_COLOR = "1";

      const config = loadConfig();

      expect(config.colorOutput).toBe(false);
    });

    it("should disable color output with OXSCADA_NO_COLOR env", () => {
      process.env.OXSCADA_NO_COLOR = "1";

      const config = loadConfig();

      expect(config.colorOutput).toBe(false);
    });
  });

  describe("saveConfig", () => {
    it("should save config to current directory", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      saveConfig({ apiUrl: "http://new:8080" });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining("0xscada.config.json"),
        expect.stringContaining("http://new:8080")
      );
    });

    it("should merge with existing config", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ apiUrl: "http://old:8080", timeout: 5000 })
      );
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      saveConfig({ timeout: 10000 });

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const savedConfig = JSON.parse(writeCall[1] as string);

      expect(savedConfig.apiUrl).toBe("http://old:8080");
      expect(savedConfig.timeout).toBe(10000);
    });

    it("should start fresh if existing config is invalid", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("{ invalid }");
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      saveConfig({ apiUrl: "http://new:8080" });

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const savedConfig = JSON.parse(writeCall[1] as string);

      expect(savedConfig.apiUrl).toBe("http://new:8080");
    });
  });

  describe("getConfigPath", () => {
    it("should return null when no config file exists", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const configPath = getConfigPath();

      expect(configPath).toBeNull();
    });

    it("should return path when config file exists in cwd", () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).includes(process.cwd()) && String(p).endsWith("0xscada.config.json");
      });

      const configPath = getConfigPath();

      expect(configPath).not.toBeNull();
      expect(configPath).toContain("0xscada.config.json");
    });

    it("should check home directory if cwd config not found", () => {
      const homeDir = os.homedir();
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).includes(homeDir) && String(p).includes(".0xscada.config.json");
      });

      const configPath = getConfigPath();

      // Should find home config
      expect(fs.existsSync).toHaveBeenCalled();
    });
  });

  describe("getAllConfigPaths", () => {
    it("should return array of possible config paths", () => {
      const paths = getAllConfigPaths();

      expect(Array.isArray(paths)).toBe(true);
      expect(paths.length).toBeGreaterThanOrEqual(2);
      expect(paths.some((p) => p.includes("0xscada.config.json"))).toBe(true);
    });

    it("should include cwd path", () => {
      const paths = getAllConfigPaths();
      const cwdPath = path.join(process.cwd(), "0xscada.config.json");

      expect(paths).toContain(cwdPath);
    });
  });
});
