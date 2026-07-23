import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { loadConfig, saveConfig, getConfigPath, getAllConfigPaths } from "../src/config.js";
import { mockEnv } from "./helpers";

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
    describe("default values", () => {
      it("should return default config when no file exists", () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const config = loadConfig();

        expect(config.apiUrl).toBe("http://localhost:5000");
        expect(config.timeout).toBe(30000);
        expect(config.colorOutput).toBe(true);
        expect(config.jsonOutput).toBe(false);
      });

      it("should return all default config properties", () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const config = loadConfig();

        expect(config).toEqual({
          apiUrl: "http://localhost:5000",
          timeout: 30000,
          colorOutput: true,
          jsonOutput: false,
        });
      });
    });

    describe("config file loading (JSON)", () => {
      it("should load config from file when it exists in cwd", () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => {
          return String(p).endsWith("0xscada.config.json") && String(p).includes(process.cwd());
        });
        vi.mocked(fs.readFileSync).mockReturnValue(
          JSON.stringify({ apiUrl: "http://custom:8080", timeout: 5000 })
        );

        const config = loadConfig();

        expect(config.apiUrl).toBe("http://custom:8080");
        expect(config.timeout).toBe(5000);
      });

      it("should load config from home directory when cwd config not found", () => {
        const homeDir = process.env.HOME || process.env.USERPROFILE || "";
        vi.mocked(fs.existsSync).mockImplementation((p) => {
          return String(p).includes(homeDir) && String(p).includes(".0xscada.config.json");
        });
        vi.mocked(fs.readFileSync).mockReturnValue(
          JSON.stringify({ apiUrl: "http://home:8080" })
        );

        const config = loadConfig();

        expect(config.apiUrl).toBe("http://home:8080");
      });

      it("should merge partial config with defaults", () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => {
          return String(p).endsWith("0xscada.config.json");
        });
        vi.mocked(fs.readFileSync).mockReturnValue(
          JSON.stringify({ apiUrl: "http://partial:8080" })
        );

        const config = loadConfig();

        expect(config.apiUrl).toBe("http://partial:8080");
        expect(config.timeout).toBe(30000); // Default
        expect(config.colorOutput).toBe(true); // Default
        expect(config.jsonOutput).toBe(false); // Default
      });

      it("should handle config with all properties", () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => {
          return String(p).endsWith("0xscada.config.json");
        });
        vi.mocked(fs.readFileSync).mockReturnValue(
          JSON.stringify({
            apiUrl: "http://full:9000",
            timeout: 60000,
            colorOutput: false,
            jsonOutput: true,
          })
        );

        const config = loadConfig();

        expect(config.apiUrl).toBe("http://full:9000");
        expect(config.timeout).toBe(60000);
        expect(config.colorOutput).toBe(false);
        expect(config.jsonOutput).toBe(true);
      });

      it("should ignore extra unknown fields in config file", () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => {
          return String(p).endsWith("0xscada.config.json");
        });
        vi.mocked(fs.readFileSync).mockReturnValue(
          JSON.stringify({
            apiUrl: "http://extra:8080",
            unknownField: "should be ignored",
            anotherUnknown: 12345,
          })
        );

        const config = loadConfig();

        expect(config.apiUrl).toBe("http://extra:8080");
        expect((config as any).unknownField).toBe("should be ignored");
        expect(config.timeout).toBe(30000); // Default
      });

      it("should handle empty config file (empty object)", () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => {
          return String(p).endsWith("0xscada.config.json");
        });
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));

        const config = loadConfig();

        expect(config).toEqual({
          apiUrl: "http://localhost:5000",
          timeout: 30000,
          colorOutput: true,
          jsonOutput: false,
        });
      });
    });

    describe("invalid config handling", () => {
      it("should ignore invalid JSON config file", () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue("{ invalid json }");

        const config = loadConfig();

        // Should fall back to defaults
        expect(config.apiUrl).toBe("http://localhost:5000");
      });

      it("should ignore config file with syntax error", () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('{"apiUrl": "incomplete');

        const config = loadConfig();

        expect(config.apiUrl).toBe("http://localhost:5000");
      });

      it("should handle config file with null value", () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue("null");

        const config = loadConfig();

        // Object.assign with null should be handled
        expect(config.apiUrl).toBe("http://localhost:5000");
      });

      it("should handle config file with array instead of object", () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue("[]");

        const config = loadConfig();

        expect(config.apiUrl).toBe("http://localhost:5000");
      });
    });

    describe("environment variable handling", () => {
      it("should override file config with OXSCADA_API_URL", () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => {
          return String(p).endsWith("0xscada.config.json");
        });
        vi.mocked(fs.readFileSync).mockReturnValue(
          JSON.stringify({ apiUrl: "http://file:8080" })
        );

        process.env.OXSCADA_API_URL = "http://env:9090";

        const config = loadConfig();

        expect(config.apiUrl).toBe("http://env:9090");
      });

      it("should override default config with OXSCADA_API_URL", () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        process.env.OXSCADA_API_URL = "http://envonly:7070";

        const config = loadConfig();

        expect(config.apiUrl).toBe("http://envonly:7070");
      });

      it("should override file config with OXSCADA_TIMEOUT", () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => {
          return String(p).endsWith("0xscada.config.json");
        });
        vi.mocked(fs.readFileSync).mockReturnValue(
          JSON.stringify({ timeout: 5000 })
        );

        process.env.OXSCADA_TIMEOUT = "10000";

        const config = loadConfig();

        expect(config.timeout).toBe(10000);
      });

      it("should handle OXSCADA_TIMEOUT as NaN (invalid number)", () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        process.env.OXSCADA_TIMEOUT = "not-a-number";

        const config = loadConfig();

        expect(config.timeout).toBeNaN();
      });

      it("should ignore empty string OXSCADA_TIMEOUT (falsy)", () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        process.env.OXSCADA_TIMEOUT = "";

        const config = loadConfig();

        // Empty string is falsy, so env override doesn't apply - default used
        expect(config.timeout).toBe(30000);
      });

      it("should disable color output with NO_COLOR env", () => {
        process.env.NO_COLOR = "1";

        const config = loadConfig();

        expect(config.colorOutput).toBe(false);
      });

      it("should disable color output with NO_COLOR set to any value", () => {
        process.env.NO_COLOR = "true";

        const config = loadConfig();

        expect(config.colorOutput).toBe(false);
      });

      it("should disable color output with OXSCADA_NO_COLOR env", () => {
        process.env.OXSCADA_NO_COLOR = "1";

        const config = loadConfig();

        expect(config.colorOutput).toBe(false);
      });

      it("should use mockEnv helper correctly", () => {
        const restore = mockEnv({ OXSCADA_API_URL: "http://helper-env:5555" });

        try {
          const config = loadConfig();
          expect(config.apiUrl).toBe("http://helper-env:5555");
        } finally {
          restore();
        }
      });

      it("should override all values with environment variables", () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => {
          return String(p).endsWith("0xscada.config.json");
        });
        vi.mocked(fs.readFileSync).mockReturnValue(
          JSON.stringify({
            apiUrl: "http://file:8080",
            timeout: 5000,
            colorOutput: true,
          })
        );

        process.env.OXSCADA_API_URL = "http://env:9090";
        process.env.OXSCADA_TIMEOUT = "15000";
        process.env.NO_COLOR = "1";

        const config = loadConfig();

        expect(config.apiUrl).toBe("http://env:9090");
        expect(config.timeout).toBe(15000);
        expect(config.colorOutput).toBe(false);
      });
    });

    describe("config file search priority", () => {
      it("should prioritize cwd config over home config", () => {
        const homeDir = process.env.HOME || process.env.USERPROFILE || "";
        
        vi.mocked(fs.existsSync).mockImplementation((p) => {
          const pathStr = String(p);
          if (pathStr.includes(process.cwd()) && pathStr.endsWith("0xscada.config.json")) {
            return true;
          }
          if (pathStr.includes(homeDir) && pathStr.includes(".0xscada.config.json")) {
            return true;
          }
          return false;
        });
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
          const pathStr = String(p);
          if (pathStr.includes(process.cwd())) {
            return JSON.stringify({ apiUrl: "http://cwd:8080" });
          }
          return JSON.stringify({ apiUrl: "http://home:8080" });
        });

        const config = loadConfig();

        expect(config.apiUrl).toBe("http://cwd:8080");
      });
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

    it("should start fresh if existing config is invalid JSON", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("{ invalid }");
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      saveConfig({ apiUrl: "http://new:8080" });

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const savedConfig = JSON.parse(writeCall[1] as string);

      expect(savedConfig.apiUrl).toBe("http://new:8080");
    });

    it("should save config with proper JSON formatting (2 space indent)", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      saveConfig({ apiUrl: "http://formatted:8080" });

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const content = writeCall[1] as string;

      // Should have 2-space indentation
      expect(content).toBe(JSON.stringify({ apiUrl: "http://formatted:8080" }, null, 2));
    });

    it("should save multiple properties at once", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      saveConfig({
        apiUrl: "http://multi:8080",
        timeout: 20000,
        colorOutput: false,
        jsonOutput: true,
      });

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const savedConfig = JSON.parse(writeCall[1] as string);

      expect(savedConfig).toEqual({
        apiUrl: "http://multi:8080",
        timeout: 20000,
        colorOutput: false,
        jsonOutput: true,
      });
    });

    it("should overwrite existing property values", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          apiUrl: "http://original:8080",
          timeout: 30000,
        })
      );
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      saveConfig({ apiUrl: "http://updated:9090" });

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const savedConfig = JSON.parse(writeCall[1] as string);

      expect(savedConfig.apiUrl).toBe("http://updated:9090");
      expect(savedConfig.timeout).toBe(30000);
    });

    it("should handle empty updates object", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ apiUrl: "http://existing:8080" })
      );
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      saveConfig({});

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const savedConfig = JSON.parse(writeCall[1] as string);

      expect(savedConfig.apiUrl).toBe("http://existing:8080");
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

    it("should return home config path when cwd config not found", () => {
      const homeDir = process.env.HOME || process.env.USERPROFILE || "";
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).includes(homeDir) && String(p).includes(".0xscada.config.json");
      });

      const configPath = getConfigPath();

      expect(configPath).toContain(".0xscada.config.json");
    });

    it("should check cwd before home directory", () => {
      const callOrder: string[] = [];
      
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        callOrder.push(String(p));
        return false;
      });

      getConfigPath();

      // First call should be cwd
      expect(callOrder[0]).toContain(process.cwd());
    });
  });

  describe("getAllConfigPaths", () => {
    it("should return array of possible config paths", () => {
      const paths = getAllConfigPaths();

      expect(Array.isArray(paths)).toBe(true);
      expect(paths.length).toBeGreaterThanOrEqual(2);
      expect(paths.some((p) => p.includes("0xscada.config.json"))).toBe(true);
    });

    it("should include cwd path as first element", () => {
      const paths = getAllConfigPaths();
      const cwdPath = path.join(process.cwd(), "0xscada.config.json");

      expect(paths[0]).toBe(cwdPath);
    });

    it("should include home directory path with dot prefix", () => {
      const paths = getAllConfigPaths();
      const homeDir = process.env.HOME || process.env.USERPROFILE || "";
      const homePath = path.join(homeDir, ".0xscada.config.json");

      expect(paths[1]).toBe(homePath);
    });

    it("should return consistent paths on multiple calls", () => {
      const paths1 = getAllConfigPaths();
      const paths2 = getAllConfigPaths();

      expect(paths1).toEqual(paths2);
    });

    it("should handle missing HOME and USERPROFILE env vars", () => {
      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      
      delete process.env.HOME;
      delete process.env.USERPROFILE;

      try {
        const paths = getAllConfigPaths();
        
        expect(Array.isArray(paths)).toBe(true);
        expect(paths.length).toBeGreaterThanOrEqual(2);
        // Second path should still exist (with empty home)
        expect(paths[1]).toContain(".0xscada.config.json");
      } finally {
        process.env.HOME = originalHome;
        process.env.USERPROFILE = originalUserProfile;
      }
    });
  });
});
