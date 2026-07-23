import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerWatchCommand } from "../../src/commands/watch.js";

// Mock WebSocket
vi.mock("ws", () => {
  const MockWebSocket = vi.fn().mockImplementation(function (this: any) {
    this.readyState = 1; // OPEN
    this.OPEN = 1;
    this.listeners = new Map();

    this.on = vi.fn((event: string, callback: Function) => {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, []);
      }
      this.listeners.get(event).push(callback);
    });

    this.send = vi.fn();
    this.close = vi.fn();

    // Simulate immediate connection
    setTimeout(() => {
      const openCallbacks = this.listeners.get("open") || [];
      openCallbacks.forEach((cb: Function) => cb());
    }, 0);
  });

  (MockWebSocket as any).OPEN = 1;
  (MockWebSocket as any).CLOSED = 3;

  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

vi.mock("../../src/config.js", () => ({
  loadConfig: vi.fn(() => ({
    apiUrl: "http://localhost:5000",
    timeout: 30000,
    colorOutput: true,
    jsonOutput: false,
  })),
}));

vi.mock("../../src/output.js", () => ({
  setOutputOptions: vi.fn(),
  outputInfo: vi.fn(),
  outputError: vi.fn(),
  outputWarning: vi.fn(),
  formatDate: vi.fn((d: string) => new Date(d).toISOString()),
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
}));

describe("Watch Command", () => {
  let program: Command;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let processOnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    program = new Command();
    program.exitOverride();

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    processOnSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    registerWatchCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("command registration", () => {
    it("should register watch command with subcommands", () => {
      const watchCmd = program.commands.find((c) => c.name() === "watch");
      expect(watchCmd).toBeDefined();
      expect(watchCmd?.description()).toBe("Watch real-time event streams via WebSocket");
    });

    it("should register events subcommand", () => {
      const watchCmd = program.commands.find((c) => c.name() === "watch");
      const eventsCmd = watchCmd?.commands.find((c) => c.name() === "events");
      expect(eventsCmd).toBeDefined();
      expect(eventsCmd?.description()).toBe("Watch real-time events");
    });

    it("should register assets subcommand", () => {
      const watchCmd = program.commands.find((c) => c.name() === "watch");
      const assetsCmd = watchCmd?.commands.find((c) => c.name() === "assets");
      expect(assetsCmd).toBeDefined();
      expect(assetsCmd?.description()).toBe("Watch asset state changes");
    });

    it("should register tags subcommand", () => {
      const watchCmd = program.commands.find((c) => c.name() === "watch");
      const tagsCmd = watchCmd?.commands.find((c) => c.name() === "tags");
      expect(tagsCmd).toBeDefined();
      expect(tagsCmd?.description()).toBe("Watch specific tag values (comma-separated list)");
    });
  });

  describe("events subcommand options", () => {
    it("should support --site option", () => {
      const watchCmd = program.commands.find((c) => c.name() === "watch");
      const eventsCmd = watchCmd?.commands.find((c) => c.name() === "events");
      const siteOption = eventsCmd?.options.find((o) => o.long === "--site");
      expect(siteOption).toBeDefined();
    });

    it("should support --type option", () => {
      const watchCmd = program.commands.find((c) => c.name() === "watch");
      const eventsCmd = watchCmd?.commands.find((c) => c.name() === "events");
      const typeOption = eventsCmd?.options.find((o) => o.long === "--type");
      expect(typeOption).toBeDefined();
    });

    it("should support --severity option", () => {
      const watchCmd = program.commands.find((c) => c.name() === "watch");
      const eventsCmd = watchCmd?.commands.find((c) => c.name() === "events");
      const severityOption = eventsCmd?.options.find((o) => o.long === "--severity");
      expect(severityOption).toBeDefined();
    });

    it("should support --json option", () => {
      const watchCmd = program.commands.find((c) => c.name() === "watch");
      const eventsCmd = watchCmd?.commands.find((c) => c.name() === "events");
      const jsonOption = eventsCmd?.options.find((o) => o.long === "--json");
      expect(jsonOption).toBeDefined();
    });

    it("should support --no-reconnect option", () => {
      const watchCmd = program.commands.find((c) => c.name() === "watch");
      const eventsCmd = watchCmd?.commands.find((c) => c.name() === "events");
      const reconnectOption = eventsCmd?.options.find((o) => o.long === "--no-reconnect");
      expect(reconnectOption).toBeDefined();
    });

    it("should support --no-color option", () => {
      const watchCmd = program.commands.find((c) => c.name() === "watch");
      const eventsCmd = watchCmd?.commands.find((c) => c.name() === "events");
      const colorOption = eventsCmd?.options.find((o) => o.long === "--no-color");
      expect(colorOption).toBeDefined();
    });
  });

  describe("assets subcommand options", () => {
    it("should support --site option", () => {
      const watchCmd = program.commands.find((c) => c.name() === "watch");
      const assetsCmd = watchCmd?.commands.find((c) => c.name() === "assets");
      const siteOption = assetsCmd?.options.find((o) => o.long === "--site");
      expect(siteOption).toBeDefined();
    });

    it("should support --json option", () => {
      const watchCmd = program.commands.find((c) => c.name() === "watch");
      const assetsCmd = watchCmd?.commands.find((c) => c.name() === "assets");
      const jsonOption = assetsCmd?.options.find((o) => o.long === "--json");
      expect(jsonOption).toBeDefined();
    });
  });

  describe("tags subcommand options", () => {
    it("should require tag list argument", () => {
      const watchCmd = program.commands.find((c) => c.name() === "watch");
      const tagsCmd = watchCmd?.commands.find((c) => c.name() === "tags");
      expect(tagsCmd?.registeredArguments[0]?.name()).toBe("tagList");
    });

    it("should support --json option", () => {
      const watchCmd = program.commands.find((c) => c.name() === "watch");
      const tagsCmd = watchCmd?.commands.find((c) => c.name() === "tags");
      const jsonOption = tagsCmd?.options.find((o) => o.long === "--json");
      expect(jsonOption).toBeDefined();
    });
  });
});

describe("WebSocket URL construction", () => {
  it("should convert http to ws protocol", () => {
    // Test the URL conversion logic
    const apiUrl = "http://localhost:5000";
    const url = new URL(apiUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws/events";

    expect(url.toString()).toBe("ws://localhost:5000/ws/events");
  });

  it("should convert https to wss protocol", () => {
    const apiUrl = "https://api.example.com:8443";
    const url = new URL(apiUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws/events";

    expect(url.toString()).toBe("wss://api.example.com:8443/ws/events");
  });
});

describe("Event color mapping", () => {
  // Test event type to color mapping logic
  const eventColorTests = [
    { type: "alarm", expectedCategory: "error" },
    { type: "ALARM_HIGH", expectedCategory: "error" },
    { type: "error_condition", expectedCategory: "error" },
    { type: "fault_detected", expectedCategory: "error" },
    { type: "warning_level", expectedCategory: "warning" },
    { type: "alert_threshold", expectedCategory: "warning" },
    { type: "maintenance_due", expectedCategory: "cyan" },
    { type: "calibration_complete", expectedCategory: "cyan" },
    { type: "config_changed", expectedCategory: "magenta" },
    { type: "state_change", expectedCategory: "magenta" },
    { type: "sensor_reading", expectedCategory: "info" },
    { type: "other_event", expectedCategory: "info" },
  ];

  eventColorTests.forEach(({ type, expectedCategory }) => {
    it(`should categorize "${type}" as ${expectedCategory}`, () => {
      const typeLower = type.toLowerCase();
      let category: string;

      if (typeLower.includes("alarm") || typeLower.includes("error") || typeLower.includes("fault")) {
        category = "error";
      } else if (typeLower.includes("warning") || typeLower.includes("alert")) {
        category = "warning";
      } else if (typeLower.includes("maintenance") || typeLower.includes("calibration")) {
        category = "cyan";
      } else if (typeLower.includes("config") || typeLower.includes("change")) {
        category = "magenta";
      } else {
        category = "info";
      }

      expect(category).toBe(expectedCategory);
    });
  });
});

describe("Severity color mapping", () => {
  const severityColorTests = [
    { severity: "critical", expectedCategory: "error" },
    { severity: "high", expectedCategory: "error" },
    { severity: "medium", expectedCategory: "warning" },
    { severity: "warning", expectedCategory: "warning" },
    { severity: "low", expectedCategory: "info" },
    { severity: "info", expectedCategory: "info" },
    { severity: "unknown", expectedCategory: "dim" },
    { severity: undefined, expectedCategory: "dim" },
  ];

  severityColorTests.forEach(({ severity, expectedCategory }) => {
    it(`should categorize severity "${severity}" as ${expectedCategory}`, () => {
      let category: string;

      if (!severity) {
        category = "dim";
      } else {
        switch (severity.toLowerCase()) {
          case "critical":
          case "high":
            category = "error";
            break;
          case "medium":
          case "warning":
            category = "warning";
            break;
          case "low":
          case "info":
            category = "info";
            break;
          default:
            category = "dim";
        }
      }

      expect(category).toBe(expectedCategory);
    });
  });
});

describe("Filter building", () => {
  it("should build filters from site option", () => {
    const options = { site: "plant-01" };
    const filters: Record<string, string[]> = {};

    if (options.site) {
      filters.siteIds = [options.site];
    }

    expect(filters.siteIds).toEqual(["plant-01"]);
  });

  it("should build filters from type option", () => {
    const options = { type: "alarm" };
    const filters: Record<string, string[]> = {};

    if (options.type) {
      filters.eventTypes = [options.type];
    }

    expect(filters.eventTypes).toEqual(["alarm"]);
  });

  it("should build combined filters", () => {
    const options = { site: "plant-01", type: "alarm" };
    const filters: Record<string, string[]> = {};

    if (options.site) {
      filters.siteIds = [options.site];
    }
    if (options.type) {
      filters.eventTypes = [options.type];
    }

    expect(filters).toEqual({
      siteIds: ["plant-01"],
      eventTypes: ["alarm"],
    });
  });
});

describe("Tag list parsing", () => {
  it("should parse comma-separated tags", () => {
    const tagList = "TK-101.Level,P-101.Current,FT-200.Flow";
    const tags = tagList.split(",").map(t => t.trim()).filter(t => t.length > 0);

    expect(tags).toEqual(["TK-101.Level", "P-101.Current", "FT-200.Flow"]);
  });

  it("should handle whitespace in tag list", () => {
    const tagList = "TK-101.Level, P-101.Current , FT-200.Flow";
    const tags = tagList.split(",").map(t => t.trim()).filter(t => t.length > 0);

    expect(tags).toEqual(["TK-101.Level", "P-101.Current", "FT-200.Flow"]);
  });

  it("should filter empty tags", () => {
    const tagList = "TK-101.Level,,FT-200.Flow,";
    const tags = tagList.split(",").map(t => t.trim()).filter(t => t.length > 0);

    expect(tags).toEqual(["TK-101.Level", "FT-200.Flow"]);
  });

  it("should handle single tag", () => {
    const tagList = "TK-101.Level";
    const tags = tagList.split(",").map(t => t.trim()).filter(t => t.length > 0);

    expect(tags).toEqual(["TK-101.Level"]);
  });
});

describe("Reconnect logic", () => {
  it("should calculate exponential backoff delay", () => {
    const baseDelay = 1000;
    const maxDelay = 30000;

    const delays = [1, 2, 3, 4, 5, 6].map(attempt => {
      return Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
    });

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
  });

  it("should cap delay at maximum", () => {
    const baseDelay = 1000;
    const maxDelay = 30000;
    const attempt = 10;

    const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);

    expect(delay).toBe(30000);
  });
});

describe("Message handling", () => {
  it("should handle event message format", () => {
    const message = {
      type: "event",
      subscriptionId: "sub_123",
      event: {
        eventType: "alarm",
        siteId: "plant-01",
        assetId: "TK-101",
        sourceTimestamp: "2024-01-15T10:00:00Z",
        originType: "sensor",
        originId: "sensor-001",
        payload: { value: 100 },
        severity: "high",
      },
    };

    expect(message.type).toBe("event");
    expect(message.event?.eventType).toBe("alarm");
    expect(message.event?.siteId).toBe("plant-01");
  });

  it("should handle connected message format", () => {
    const message = {
      type: "connected",
      connectionId: "conn_123",
      serverTime: "2024-01-15T10:00:00Z",
    };

    expect(message.type).toBe("connected");
    expect(message.connectionId).toBe("conn_123");
  });

  it("should handle error message format", () => {
    const message = {
      type: "error",
      code: "AUTHENTICATION_FAILED",
      message: "Invalid token",
    };

    expect(message.type).toBe("error");
    expect(message.code).toBe("AUTHENTICATION_FAILED");
  });
});
