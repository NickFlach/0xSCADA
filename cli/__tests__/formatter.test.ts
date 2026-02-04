import { describe, it, expect } from "vitest";
import {
  Formatter,
  createFormatter,
  formatJson,
  formatYaml,
  formatCsv,
  formatTsv,
  formatTable,
  parseOutputFormat,
  isValidOutputFormat,
  isValidTableTheme,
  isStructuredFormat,
  objectsToTable,
  VALID_OUTPUT_FORMATS,
} from "../src/lib/formatter.js";

describe("Formatter", () => {
  describe("parseOutputFormat", () => {
    it("should parse simple formats", () => {
      expect(parseOutputFormat("json")).toEqual({ format: "json" });
      expect(parseOutputFormat("yaml")).toEqual({ format: "yaml" });
      expect(parseOutputFormat("csv")).toEqual({ format: "csv" });
      expect(parseOutputFormat("tsv")).toEqual({ format: "tsv" });
      expect(parseOutputFormat("table")).toEqual({ format: "table" });
    });

    it("should parse table themes", () => {
      expect(parseOutputFormat("table:minimal")).toEqual({ format: "table", theme: "minimal" });
      expect(parseOutputFormat("table:ascii")).toEqual({ format: "table", theme: "ascii" });
      expect(parseOutputFormat("table:rounded")).toEqual({ format: "table", theme: "rounded" });
      expect(parseOutputFormat("table:heavy")).toEqual({ format: "table", theme: "heavy" });
      expect(parseOutputFormat("table:double")).toEqual({ format: "table", theme: "double" });
    });

    it("should handle invalid table theme", () => {
      expect(parseOutputFormat("table:invalid")).toEqual({ format: "table", theme: "default" });
    });
  });

  describe("isValidOutputFormat", () => {
    it("should validate correct formats", () => {
      expect(isValidOutputFormat("json")).toBe(true);
      expect(isValidOutputFormat("yaml")).toBe(true);
      expect(isValidOutputFormat("csv")).toBe(true);
      expect(isValidOutputFormat("tsv")).toBe(true);
      expect(isValidOutputFormat("table")).toBe(true);
      expect(isValidOutputFormat("table:minimal")).toBe(true);
      expect(isValidOutputFormat("table:ascii")).toBe(true);
      expect(isValidOutputFormat("table:rounded")).toBe(true);
      expect(isValidOutputFormat("table:heavy")).toBe(true);
      expect(isValidOutputFormat("table:double")).toBe(true);
    });

    it("should reject invalid formats", () => {
      expect(isValidOutputFormat("invalid")).toBe(false);
      expect(isValidOutputFormat("xml")).toBe(false);
      expect(isValidOutputFormat("table:invalid")).toBe(false);
      expect(isValidOutputFormat("")).toBe(false);
    });
  });

  describe("isValidTableTheme", () => {
    it("should validate correct themes", () => {
      expect(isValidTableTheme("default")).toBe(true);
      expect(isValidTableTheme("minimal")).toBe(true);
      expect(isValidTableTheme("ascii")).toBe(true);
      expect(isValidTableTheme("rounded")).toBe(true);
      expect(isValidTableTheme("heavy")).toBe(true);
      expect(isValidTableTheme("double")).toBe(true);
    });

    it("should reject invalid themes", () => {
      expect(isValidTableTheme("invalid")).toBe(false);
      expect(isValidTableTheme("")).toBe(false);
    });
  });

  describe("isStructuredFormat", () => {
    it("should identify structured formats", () => {
      expect(isStructuredFormat("json")).toBe(true);
      expect(isStructuredFormat("yaml")).toBe(true);
      expect(isStructuredFormat("csv")).toBe(true);
      expect(isStructuredFormat("tsv")).toBe(true);
    });

    it("should identify non-structured formats", () => {
      expect(isStructuredFormat("table")).toBe(false);
      expect(isStructuredFormat("table:minimal")).toBe(false);
      expect(isStructuredFormat("table:rounded")).toBe(false);
    });
  });

  describe("formatJson", () => {
    it("should format objects as JSON", () => {
      const data = { name: "test", value: 123 };
      const result = formatJson(data);
      expect(result).toBe(JSON.stringify(data, null, 2));
    });

    it("should format arrays as JSON", () => {
      const data = [1, 2, 3];
      const result = formatJson(data);
      expect(result).toBe(JSON.stringify(data, null, 2));
    });

    it("should handle null", () => {
      expect(formatJson(null)).toBe("null");
    });

    it("should handle nested objects", () => {
      const data = { outer: { inner: { value: "deep" } } };
      const result = formatJson(data);
      expect(JSON.parse(result)).toEqual(data);
    });
  });

  describe("formatYaml", () => {
    it("should format simple objects", () => {
      const result = formatYaml({ name: "test", value: 123 });
      expect(result).toContain("name: test");
      expect(result).toContain("value: 123");
    });

    it("should format arrays", () => {
      const result = formatYaml(["a", "b", "c"]);
      expect(result).toContain("- a");
      expect(result).toContain("- b");
      expect(result).toContain("- c");
    });

    it("should handle booleans", () => {
      expect(formatYaml(true)).toBe("true");
      expect(formatYaml(false)).toBe("false");
    });

    it("should handle null", () => {
      expect(formatYaml(null)).toBe("null");
    });

    it("should handle numbers", () => {
      expect(formatYaml(42)).toBe("42");
      expect(formatYaml(3.14)).toBe("3.14");
    });

    it("should quote strings that need it", () => {
      expect(formatYaml("value: with colon")).toContain('"');
      expect(formatYaml("true")).toContain('"');
      expect(formatYaml("123")).toContain('"');
    });

    it("should handle empty objects", () => {
      expect(formatYaml({})).toBe("{}");
    });

    it("should handle empty arrays", () => {
      expect(formatYaml([])).toBe("[]");
    });

    it("should format nested objects", () => {
      const result = formatYaml({ outer: { inner: "value" } });
      expect(result).toContain("outer:");
      expect(result).toContain("inner: value");
    });

    it("should format array of objects", () => {
      const result = formatYaml([{ name: "first" }, { name: "second" }]);
      expect(result).toContain("- name: first");
      expect(result).toContain("- name: second");
    });
  });

  describe("formatCsv", () => {
    it("should format simple data", () => {
      const result = formatCsv(["Name", "Value"], [["Alice", "100"], ["Bob", "200"]]);
      const lines = result.split("\n");
      expect(lines[0]).toBe("Name,Value");
      expect(lines[1]).toBe("Alice,100");
      expect(lines[2]).toBe("Bob,200");
    });

    it("should escape values with commas", () => {
      const result = formatCsv(["Name"], [["Smith, John"]]);
      expect(result).toContain('"Smith, John"');
    });

    it("should escape values with quotes", () => {
      const result = formatCsv(["Quote"], [['He said "hello"']]);
      expect(result).toContain('"He said ""hello"""');
    });

    it("should escape values with newlines", () => {
      const result = formatCsv(["Text"], [["Line1\nLine2"]]);
      expect(result).toContain('"Line1\nLine2"');
    });

    it("should handle empty data", () => {
      const result = formatCsv(["A", "B"], []);
      expect(result).toBe("A,B");
    });
  });

  describe("formatTsv", () => {
    it("should format simple data", () => {
      const result = formatTsv(["Name", "Value"], [["Alice", "100"], ["Bob", "200"]]);
      const lines = result.split("\n");
      expect(lines[0]).toBe("Name\tValue");
      expect(lines[1]).toBe("Alice\t100");
      expect(lines[2]).toBe("Bob\t200");
    });

    it("should escape values with tabs", () => {
      const result = formatTsv(["Name"], [["Tab\there"]]);
      expect(result).toContain('"Tab\there"');
    });

    it("should handle empty data", () => {
      const result = formatTsv(["A", "B"], []);
      expect(result).toBe("A\tB");
    });
  });

  describe("formatTable", () => {
    it("should format with default theme", () => {
      const result = formatTable(["Name", "Value"], [["Alice", "100"]]);
      expect(result).toBeDefined();
      expect(result).toContain("Alice");
      expect(result).toContain("100");
    });

    it("should format with minimal theme", () => {
      const result = formatTable(["Name", "Value"], [["Test", "123"]], { theme: "minimal" });
      expect(result).toBeDefined();
      expect(result).toContain("Test");
    });

    it("should format with ascii theme", () => {
      const result = formatTable(["Name"], [["Test"]], { theme: "ascii" });
      expect(result).toBeDefined();
      expect(result).toContain("+");
      expect(result).toContain("-");
      expect(result).toContain("|");
    });

    it("should format with rounded theme", () => {
      const result = formatTable(["Name"], [["Test"]], { theme: "rounded" });
      expect(result).toBeDefined();
    });

    it("should format with heavy theme", () => {
      const result = formatTable(["Name"], [["Test"]], { theme: "heavy" });
      expect(result).toBeDefined();
    });

    it("should format with double theme", () => {
      const result = formatTable(["Name"], [["Test"]], { theme: "double" });
      expect(result).toBeDefined();
    });

    it("should handle color option", () => {
      const withColor = formatTable(["Name"], [["Test"]], { color: true });
      const withoutColor = formatTable(["Name"], [["Test"]], { color: false });
      expect(withColor).toBeDefined();
      expect(withoutColor).toBeDefined();
    });

    it("should handle empty rows", () => {
      const result = formatTable(["Name", "Value"], []);
      expect(result).toBeDefined();
    });
  });

  describe("objectsToTable", () => {
    it("should convert objects to table format", () => {
      const data = [
        { name: "Alice", age: 30 },
        { name: "Bob", age: 25 },
      ];
      const { headers, rows } = objectsToTable(data);
      expect(headers).toContain("name");
      expect(headers).toContain("age");
      expect(rows[0]).toContain("Alice");
      expect(rows[0]).toContain("30");
      expect(rows[1]).toContain("Bob");
      expect(rows[1]).toContain("25");
    });

    it("should handle objects with different keys", () => {
      const data = [
        { a: 1, b: 2 },
        { b: 3, c: 4 },
      ];
      const { headers, rows } = objectsToTable(data);
      expect(headers).toContain("a");
      expect(headers).toContain("b");
      expect(headers).toContain("c");
      expect(rows[0]).toContain("1");
      expect(rows[0]).toContain("2");
      expect(rows[1]).toContain("3");
      expect(rows[1]).toContain("4");
    });

    it("should handle null and undefined values", () => {
      const data = [{ a: null, b: undefined }];
      const { headers, rows } = objectsToTable(data);
      expect(rows[0]).toContain("");
    });

    it("should stringify nested objects", () => {
      const data = [{ nested: { value: "test" } }];
      const { headers, rows } = objectsToTable(data);
      expect(rows[0][0]).toContain("value");
      expect(rows[0][0]).toContain("test");
    });

    it("should handle empty array", () => {
      const { headers, rows } = objectsToTable([]);
      expect(headers).toEqual([]);
      expect(rows).toEqual([]);
    });
  });

  describe("Formatter class", () => {
    it("should create with default options", () => {
      const formatter = createFormatter();
      expect(formatter.getFormat()).toBe("table");
      expect(formatter.getTheme()).toBe("default");
      expect(formatter.isColorEnabled()).toBe(true);
    });

    it("should create with JSON format", () => {
      const formatter = createFormatter({ format: "json" });
      expect(formatter.getFormat()).toBe("json");
      expect(formatter.isStructured()).toBe(true);
    });

    it("should create with table theme", () => {
      const formatter = createFormatter({ format: "table:rounded" });
      expect(formatter.getFormat()).toBe("table");
      expect(formatter.getTheme()).toBe("rounded");
      expect(formatter.isStructured()).toBe(false);
    });

    it("should format table data as JSON", () => {
      const formatter = createFormatter({ format: "json" });
      const result = formatter.formatTableData(["Name", "Value"], [["Test", "123"]]);
      const parsed = JSON.parse(result);
      expect(parsed).toEqual([{ Name: "Test", Value: "123" }]);
    });

    it("should format table data as YAML", () => {
      const formatter = createFormatter({ format: "yaml" });
      const result = formatter.formatTableData(["Name", "Value"], [["Test", "123"]]);
      expect(result).toContain("Name: Test");
      expect(result).toContain("Value:");
    });

    it("should format table data as CSV", () => {
      const formatter = createFormatter({ format: "csv" });
      const result = formatter.formatTableData(["Name", "Value"], [["Test", "123"]]);
      expect(result).toContain("Name,Value");
      expect(result).toContain("Test,123");
    });

    it("should format table data as TSV", () => {
      const formatter = createFormatter({ format: "tsv" });
      const result = formatter.formatTableData(["Name", "Value"], [["Test", "123"]]);
      expect(result).toContain("Name\tValue");
      expect(result).toContain("Test\t123");
    });

    it("should format table data as table", () => {
      const formatter = createFormatter({ format: "table" });
      const result = formatter.formatTableData(["Name"], [["Test"]]);
      expect(result).toContain("Test");
    });

    it("should format arbitrary data as JSON", () => {
      const formatter = createFormatter({ format: "json" });
      const result = formatter.formatData({ key: "value" });
      expect(JSON.parse(result)).toEqual({ key: "value" });
    });

    it("should format array of objects for table", () => {
      const formatter = createFormatter({ format: "table" });
      const result = formatter.formatData([{ name: "Test" }]);
      expect(result).toContain("Test");
    });

    it("should handle color disabled", () => {
      const formatter = createFormatter({ color: false });
      expect(formatter.isColorEnabled()).toBe(false);
    });
  });

  describe("VALID_OUTPUT_FORMATS", () => {
    it("should contain all expected formats", () => {
      expect(VALID_OUTPUT_FORMATS).toContain("json");
      expect(VALID_OUTPUT_FORMATS).toContain("yaml");
      expect(VALID_OUTPUT_FORMATS).toContain("csv");
      expect(VALID_OUTPUT_FORMATS).toContain("tsv");
      expect(VALID_OUTPUT_FORMATS).toContain("table");
      expect(VALID_OUTPUT_FORMATS).toContain("table:minimal");
      expect(VALID_OUTPUT_FORMATS).toContain("table:ascii");
      expect(VALID_OUTPUT_FORMATS).toContain("table:rounded");
      expect(VALID_OUTPUT_FORMATS).toContain("table:heavy");
      expect(VALID_OUTPUT_FORMATS).toContain("table:double");
    });
  });
});
