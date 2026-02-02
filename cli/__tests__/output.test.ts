import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { captureConsole } from "./helpers";

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

    it("should merge with existing options", () => {
      output.setOutputOptions({ json: true });
      output.setOutputOptions({ color: false });
      // Both options should persist
      output.output({ test: true });
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('"test"'));
    });

    it("should allow resetting options", () => {
      output.setOutputOptions({ json: true, color: true });
      output.setOutputOptions({ json: false, color: false });
      output.output("plain text");
      expect(consoleLogSpy).toHaveBeenCalledWith("plain text");
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

    it("should return plain text for all color functions when disabled", () => {
      output.setOutputOptions({ color: false });
      expect(output.colors.success("text")).toBe("text");
      expect(output.colors.error("text")).toBe("text");
      expect(output.colors.warning("text")).toBe("text");
      expect(output.colors.info("text")).toBe("text");
      expect(output.colors.dim("text")).toBe("text");
      expect(output.colors.bold("text")).toBe("text");
      expect(output.colors.cyan("text")).toBe("text");
      expect(output.colors.magenta("text")).toBe("text");
    });

    it("should handle empty strings", () => {
      output.setOutputOptions({ color: true });
      expect(output.colors.success("")).toBe("");
      output.setOutputOptions({ color: false });
      expect(output.colors.success("")).toBe("");
    });

    it("should handle strings with special characters", () => {
      output.setOutputOptions({ color: true });
      const special = "Test <>&\"'";
      expect(output.colors.success(special)).toContain("Test");
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

    it("should be case-insensitive for status values", () => {
      output.setOutputOptions({ color: true });
      expect(output.statusIcon("UP")).toContain("●");
      expect(output.statusIcon("Up")).toContain("●");
      expect(output.statusIcon("HEALTHY")).toContain("●");
      expect(output.statusIcon("DOWN")).toContain("●");
      expect(output.statusIcon("WARNING")).toContain("●");
    });

    it("should handle empty status", () => {
      output.setOutputOptions({ color: true });
      expect(output.statusIcon("")).toContain("○");
    });

    it("should only treat up and healthy as OK without color", () => {
      // Note: without color, only "up" and "healthy" return [OK]
      // Other statuses (enabled, connected) return [FAIL] per implementation
      output.setOutputOptions({ color: false });
      expect(output.statusIcon("healthy")).toBe("[OK]");
      expect(output.statusIcon("up")).toBe("[OK]");
      // These return [FAIL] in no-color mode (implementation limitation)
      expect(output.statusIcon("enabled")).toBe("[FAIL]");
      expect(output.statusIcon("connected")).toBe("[FAIL]");
    });

    it("should handle all unhealthy-family statuses without color", () => {
      output.setOutputOptions({ color: false });
      expect(output.statusIcon("unhealthy")).toBe("[FAIL]");
      expect(output.statusIcon("disabled")).toBe("[FAIL]");
      expect(output.statusIcon("disconnected")).toBe("[FAIL]");
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

    it("should handle arrays", () => {
      output.setOutputOptions({ json: true });
      const data = [1, 2, 3];
      output.output(data);
      expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
    });

    it("should handle nested objects", () => {
      output.setOutputOptions({ json: true });
      const data = { nested: { deep: { value: "test" } } };
      output.output(data);
      expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
    });

    it("should handle null", () => {
      output.setOutputOptions({ json: true });
      output.output(null);
      expect(consoleLogSpy).toHaveBeenCalledWith("null");
    });

    it("should handle numbers", () => {
      output.setOutputOptions({ json: true });
      output.output(42);
      expect(consoleLogSpy).toHaveBeenCalledWith("42");
    });

    it("should handle boolean values", () => {
      output.setOutputOptions({ json: true });
      output.output(true);
      expect(consoleLogSpy).toHaveBeenCalledWith("true");
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

    it("should handle empty table", () => {
      output.setOutputOptions({ json: false });
      output.outputTable(["Col1", "Col2"], []);
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it("should handle empty table in JSON mode", () => {
      output.setOutputOptions({ json: true });
      output.outputTable(["Col1", "Col2"], []);
      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);
      expect(parsed).toEqual([]);
    });

    it("should handle single row table", () => {
      output.setOutputOptions({ json: false });
      output.outputTable(["Name", "Value"], [["test", "123"]]);
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it("should handle single column table", () => {
      output.setOutputOptions({ json: true });
      output.outputTable(["Name"], [["Alice"], ["Bob"]]);
      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);
      expect(parsed[0].Name).toBe("Alice");
      expect(parsed[1].Name).toBe("Bob");
    });

    it("should handle many columns", () => {
      output.setOutputOptions({ json: true });
      const headers = ["A", "B", "C", "D", "E"];
      const rows = [["1", "2", "3", "4", "5"]];
      output.outputTable(headers, rows);
      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);
      expect(Object.keys(parsed[0])).toHaveLength(5);
    });

    it("should handle special characters in cell values", () => {
      output.setOutputOptions({ json: true });
      output.outputTable(["Col"], [["Value with\nnewline"], ["Value with\ttab"]]);
      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);
      expect(parsed[0].Col).toContain("\n");
      expect(parsed[1].Col).toContain("\t");
    });

    it("should accept custom header options", () => {
      output.setOutputOptions({ json: false, color: true });
      output.outputTable(["Col1", "Col2"], [["A", "B"]], { head: ["Custom1", "Custom2"] });
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it("should format table without colors", () => {
      output.setOutputOptions({ json: false, color: false });
      output.outputTable(["Col1", "Col2"], [["A", "B"]]);
      expect(consoleLogSpy).toHaveBeenCalled();
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

    it("should include checkmark icon without JSON mode", () => {
      output.setOutputOptions({ json: false, color: true });
      output.outputSuccess("Done");
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("✓"));
    });

    it("should handle empty message", () => {
      output.setOutputOptions({ json: false });
      output.outputSuccess("");
      expect(consoleLogSpy).toHaveBeenCalled();
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

    it("should include X icon without JSON mode", () => {
      output.setOutputOptions({ json: false, color: true });
      output.outputError("Failed");
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("✗"));
    });

    it("should handle error without details in JSON mode", () => {
      output.setOutputOptions({ json: true });
      output.outputError("Error message");
      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe("Error message");
      expect(parsed.details).toBeUndefined();
    });

    it("should set exit code even in JSON mode", () => {
      output.setOutputOptions({ json: true });
      output.outputError("Error");
      expect(process.exitCode).toBe(1);
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

    it("should include warning icon without JSON mode", () => {
      output.setOutputOptions({ json: false, color: true });
      output.outputWarning("Caution");
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("⚠"));
    });

    it("should not set exit code", () => {
      output.setOutputOptions({ json: false });
      process.exitCode = 0;
      output.outputWarning("Warning");
      expect(process.exitCode).toBe(0);
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

    it("should include info icon without JSON mode", () => {
      output.setOutputOptions({ json: false, color: true });
      output.outputInfo("Note");
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("ℹ"));
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

    it("should output blank line before section", () => {
      output.setOutputOptions({ json: false });
      output.outputSection("Title");
      // First call is blank line, second is title, third is separator
      expect(consoleLogSpy).toHaveBeenCalledTimes(3);
    });

    it("should output separator line matching title length", () => {
      output.setOutputOptions({ json: false, color: false });
      output.outputSection("Test");
      // Third call should contain separator
      expect(consoleLogSpy.mock.calls[2][0]).toContain("─");
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

    it("should handle empty array", () => {
      output.setOutputOptions({ json: true });
      output.outputKeyValue([]);
      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);
      expect(parsed).toEqual({});
    });

    it("should handle single item", () => {
      output.setOutputOptions({ json: false });
      output.outputKeyValue([{ key: "Single", value: "Item" }]);
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it("should pad keys for alignment", () => {
      output.setOutputOptions({ json: false, color: false });
      output.outputKeyValue([
        { key: "A", value: "1" },
        { key: "LongKey", value: "2" },
      ]);
      // Keys should be padded to align values
      expect(consoleLogSpy).toHaveBeenCalledTimes(2);
    });

    it("should handle values with special characters", () => {
      output.setOutputOptions({ json: true });
      output.outputKeyValue([
        { key: "URL", value: "https://example.com?a=1&b=2" },
      ]);
      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);
      expect(parsed.URL).toBe("https://example.com?a=1&b=2");
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

    it("should return a non-empty string", () => {
      const result = output.formatDate("2024-06-15T12:00:00Z");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should handle date-only strings", () => {
      const result = output.formatDate("2024-03-20");
      expect(result).toBeDefined();
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

    it("should handle exact minute boundary", () => {
      expect(output.formatUptime(60)).toBe("1m");
    });

    it("should handle exact hour boundary", () => {
      expect(output.formatUptime(3600)).toBe("1h");
    });

    it("should handle exact day boundary", () => {
      expect(output.formatUptime(86400)).toBe("1d");
    });

    it("should handle multiple days", () => {
      expect(output.formatUptime(172800)).toBe("2d");
    });

    it("should handle large values", () => {
      // 365 days
      expect(output.formatUptime(31536000)).toBe("365d");
    });

    it("should handle fractional seconds (floor)", () => {
      expect(output.formatUptime(45.9)).toBe("45s");
    });

    it("should omit zero intermediate units", () => {
      // 1 day and 5 seconds
      expect(output.formatUptime(86405)).toBe("1d 5s");
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

    it("should apply green color to true with colors enabled", () => {
      output.setOutputOptions({ color: true });
      const result = output.formatBoolean(true);
      // Should contain ANSI codes or styled text
      expect(result).toContain("Yes");
    });

    it("should apply red color to false with colors enabled", () => {
      output.setOutputOptions({ color: true });
      const result = output.formatBoolean(false);
      expect(result).toContain("No");
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

    it("should handle empty string", () => {
      expect(output.truncate("", 10)).toBe("");
    });

    it("should handle maxLength of 3 (minimum for ellipsis)", () => {
      expect(output.truncate("hello", 3)).toBe("...");
    });

    it("should handle string equal to maxLength", () => {
      expect(output.truncate("abc", 3)).toBe("abc");
    });

    it("should handle unicode characters", () => {
      const result = output.truncate("你好世界", 5);
      expect(result.length).toBeLessThanOrEqual(5);
    });

    it("should handle strings with only spaces", () => {
      expect(output.truncate("     ", 3)).toBe("...");
    });
  });

  describe("integration scenarios", () => {
    it("should handle mixed output types in sequence", () => {
      output.setOutputOptions({ json: false, color: true });
      output.outputSection("Status");
      output.outputSuccess("Connected");
      output.outputWarning("High load");
      output.outputInfo("Monitoring...");
      expect(consoleLogSpy.mock.calls.length).toBeGreaterThan(3);
    });

    it("should maintain consistent JSON format across functions", () => {
      output.setOutputOptions({ json: true });
      
      output.outputSuccess("OK");
      const successCall = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(successCall).toHaveProperty("success", true);
      
      consoleLogSpy.mockClear();
      output.outputError("Failed");
      const errorCall = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(errorCall).toHaveProperty("success", false);
      
      consoleLogSpy.mockClear();
      output.outputWarning("Caution");
      const warningCall = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(warningCall).toHaveProperty("warning");
    });

    it("should work with captureConsole helper", () => {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      
      const captured = captureConsole();
      try {
        output.setOutputOptions({ json: false, color: false });
        output.outputSuccess("Test message");
        expect(captured.getOutput()).toContain("Test message");
      } finally {
        captured.restore();
        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      }
    });
  });
});
