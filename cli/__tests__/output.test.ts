import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";

// Must mock config before importing output
vi.mock("../src/config.js", () => ({
  loadConfig: () => ({ colorOutput: true, jsonOutput: false }),
}));

describe("Output", () => {
  let output: typeof import("../src/output.js");
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    // Import after mocking
    output = await import("../src/output.js");
  });

  beforeEach(() => {
    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    output.setOutputOptions({ json: false, color: true });
    process.exitCode = 0;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.exitCode = 0;
  });

  describe("setOutputOptions", () => {
    it("should set output options", () => {
      output.setOutputOptions({ json: true, color: false });
      output.output({ test: true });
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('"test"'));
    });
  });

  describe("colors", () => {
    it("should apply success color", () => {
      output.setOutputOptions({ color: true });
      const result = output.colors.success("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should apply error color", () => {
      output.setOutputOptions({ color: true });
      const result = output.colors.error("test");
      expect(result).toBeDefined();
    });

    it("should apply warning color", () => {
      output.setOutputOptions({ color: true });
      const result = output.colors.warning("test");
      expect(result).toBeDefined();
    });

    it("should apply info color", () => {
      output.setOutputOptions({ color: true });
      const result = output.colors.info("test");
      expect(result).toBeDefined();
    });

    it("should apply dim color", () => {
      output.setOutputOptions({ color: true });
      const result = output.colors.dim("test");
      expect(result).toBeDefined();
    });

    it("should apply bold style", () => {
      output.setOutputOptions({ color: true });
      const result = output.colors.bold("test");
      expect(result).toBeDefined();
    });

    it("should apply cyan color", () => {
      output.setOutputOptions({ color: true });
      const result = output.colors.cyan("test");
      expect(result).toBeDefined();
    });

    it("should apply magenta color", () => {
      output.setOutputOptions({ color: true });
      const result = output.colors.magenta("test");
      expect(result).toBeDefined();
    });

    it("should return plain text when color is disabled", () => {
      output.setOutputOptions({ color: false });
      const result = output.colors.success("test");
      expect(result).toBe("test");
    });
  });

  describe("statusIcon", () => {
    it("should return success icon for healthy status", () => {
      output.setOutputOptions({ color: true });
      expect(output.statusIcon("up")).toContain("●");
      expect(output.statusIcon("healthy")).toContain("●");
      expect(output.statusIcon("enabled")).toContain("●");
      expect(output.statusIcon("connected")).toContain("●");
    });

    it("should return error icon for unhealthy status", () => {
      output.setOutputOptions({ color: true });
      expect(output.statusIcon("down")).toContain("●");
      expect(output.statusIcon("unhealthy")).toContain("●");
      expect(output.statusIcon("disabled")).toContain("●");
      expect(output.statusIcon("disconnected")).toContain("●");
    });

    it("should return warning icon for degraded status", () => {
      output.setOutputOptions({ color: true });
      expect(output.statusIcon("warning")).toContain("●");
      expect(output.statusIcon("degraded")).toContain("●");
    });

    it("should return neutral icon for unknown status", () => {
      output.setOutputOptions({ color: true });
      expect(output.statusIcon("unknown")).toContain("○");
    });

    it("should return text-based icons when color is disabled", () => {
      output.setOutputOptions({ color: false });
      expect(output.statusIcon("up")).toBe("[OK]");
      expect(output.statusIcon("down")).toBe("[FAIL]");
    });
  });

  describe("output", () => {
    it("should output JSON when json option is set", () => {
      output.setOutputOptions({ json: true });
      const data = { key: "value" };
      output.output(data);
      expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
    });

    it("should output string directly", () => {
      output.setOutputOptions({ json: false });
      output.output("test string");
      expect(consoleLogSpy).toHaveBeenCalledWith("test string");
    });

    it("should stringify objects", () => {
      output.setOutputOptions({ json: false });
      output.output({ test: true });
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("test"));
    });
  });

  describe("outputTable", () => {
    it("should output table in normal mode", () => {
      output.setOutputOptions({ json: false });
      output.outputTable(["Col1", "Col2"], [["A", "B"], ["C", "D"]]);
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it("should output JSON array in json mode", () => {
      output.setOutputOptions({ json: true });
      output.outputTable(["Col1", "Col2"], [["A", "B"], ["C", "D"]]);
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].Col1).toBe("A");
      expect(parsed[0].Col2).toBe("B");
    });
  });

  describe("outputSuccess", () => {
    it("should output success message", () => {
      output.setOutputOptions({ json: false });
      output.outputSuccess("Operation completed");
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Operation completed"));
    });

    it("should output JSON in json mode", () => {
      output.setOutputOptions({ json: true });
      output.outputSuccess("Operation completed");
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toBe("Operation completed");
    });
  });

  describe("outputError", () => {
    it("should output error message", () => {
      output.setOutputOptions({ json: false });
      output.outputError("Something went wrong");
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Something went wrong"));
    });

    it("should output error with details", () => {
      output.setOutputOptions({ json: false });
      output.outputError("Something went wrong", "Additional details");
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    });

    it("should set exit code to 1", () => {
      output.outputError("Error");
      expect(process.exitCode).toBe(1);
    });

    it("should output JSON in json mode", () => {
      output.setOutputOptions({ json: true });
      output.outputError("Error message", "Details");
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe("Error message");
      expect(parsed.details).toBe("Details");
    });
  });

  describe("outputWarning", () => {
    it("should output warning message", () => {
      output.setOutputOptions({ json: false });
      output.outputWarning("Warning message");
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Warning message"));
    });

    it("should output JSON in json mode", () => {
      output.setOutputOptions({ json: true });
      output.outputWarning("Warning message");
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);
      expect(parsed.warning).toBe("Warning message");
    });
  });

  describe("outputInfo", () => {
    it("should output info message", () => {
      output.setOutputOptions({ json: false });
      output.outputInfo("Info message");
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Info message"));
    });

    it("should not output in json mode", () => {
      output.setOutputOptions({ json: true });
      output.outputInfo("Info message");
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe("outputSection", () => {
    it("should output section header", () => {
      output.setOutputOptions({ json: false });
      output.outputSection("Section Title");
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it("should not output in json mode", () => {
      output.setOutputOptions({ json: true });
      output.outputSection("Section Title");
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe("outputKeyValue", () => {
    it("should output key-value pairs", () => {
      output.setOutputOptions({ json: false });
      output.outputKeyValue([
        { key: "Name", value: "Test" },
        { key: "Status", value: "Active" },
      ]);
      expect(consoleLogSpy).toHaveBeenCalledTimes(2);
    });

    it("should output JSON object in json mode", () => {
      output.setOutputOptions({ json: true });
      output.outputKeyValue([
        { key: "Name", value: "Test" },
        { key: "Status", value: "Active" },
      ]);
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);
      expect(parsed.Name).toBe("Test");
      expect(parsed.Status).toBe("Active");
    });
  });

  describe("formatDate", () => {
    it("should format ISO date string", () => {
      const result = output.formatDate("2024-01-15T10:30:00Z");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should handle various date formats", () => {
      expect(output.formatDate("2024-01-01")).toBeDefined();
      expect(output.formatDate("2024-12-31T23:59:59.999Z")).toBeDefined();
    });
  });

  describe("formatUptime", () => {
    it("should format seconds only", () => {
      expect(output.formatUptime(45)).toBe("45s");
    });

    it("should format minutes and seconds", () => {
      expect(output.formatUptime(125)).toBe("2m 5s");
    });

    it("should format hours, minutes, and seconds", () => {
      expect(output.formatUptime(3665)).toBe("1h 1m 5s");
    });

    it("should format days, hours, minutes, and seconds", () => {
      expect(output.formatUptime(90061)).toBe("1d 1h 1m 1s");
    });

    it("should handle zero", () => {
      expect(output.formatUptime(0)).toBe("0s");
    });
  });

  describe("formatBoolean", () => {
    it("should format true value", () => {
      output.setOutputOptions({ color: true });
      const result = output.formatBoolean(true);
      expect(result).toContain("Yes");
    });

    it("should format false value", () => {
      output.setOutputOptions({ color: true });
      const result = output.formatBoolean(false);
      expect(result).toContain("No");
    });

    it("should return plain text when color disabled", () => {
      output.setOutputOptions({ color: false });
      expect(output.formatBoolean(true)).toBe("Yes");
      expect(output.formatBoolean(false)).toBe("No");
    });
  });

  describe("truncate", () => {
    it("should not truncate short strings", () => {
      expect(output.truncate("hello", 10)).toBe("hello");
    });

    it("should truncate long strings", () => {
      expect(output.truncate("hello world", 8)).toBe("hello...");
    });

    it("should handle exact length", () => {
      expect(output.truncate("hello", 5)).toBe("hello");
    });

    it("should handle very short max length", () => {
      expect(output.truncate("hello world", 4)).toBe("h...");
    });
  });
});
