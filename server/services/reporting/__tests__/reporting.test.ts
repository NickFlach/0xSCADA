import { describe, expect, it, vi } from "vitest";
import {
  DeliveryChannelError,
  EmailDeliveryChannel,
  ReportingEngine,
  WebhookDeliveryChannel,
  type HistoricalDataProvider,
  type ReportClock,
  type ReportScheduler,
  type ScheduledHandle,
  type Sleeper,
} from "..";

class MutableClock implements ReportClock {
  constructor(public value: number) {}
  now(): number {
    return this.value;
  }
}

class ManualScheduler implements ReportScheduler {
  readonly tasks = new Map<string, () => void | Promise<void>>();
  readonly cancelled: string[] = [];

  every(
    id: string,
    _intervalMs: number,
    task: () => void | Promise<void>,
  ): ScheduledHandle {
    this.tasks.set(id, task);
    return {
      cancel: () => {
        this.cancelled.push(id);
        this.tasks.delete(id);
      },
    };
  }

  async trigger(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`No task ${id}`);
    await task();
  }
}

function provider(overrides: Partial<HistoricalDataProvider> = {}): HistoricalDataProvider {
  return {
    querySeries: async () => ({
      pressure: [
        { timestamp: 1_000, value: 10, quality: "good" },
        { timestamp: 2_000, value: 20, quality: "good" },
        { timestamp: 3_000, value: 30, quality: "uncertain" },
        // The engine must discard provider over-fetch.
        { timestamp: 99_000, value: 999, quality: "bad" },
      ],
    }),
    queryAlarms: async () => [
      {
        id: "alarm-1",
        tag: "pressure",
        severity: "high",
        message: "Pressure exceeded",
        timestamp: 2_500,
      },
    ],
    queryKPIs: async (names) =>
      Object.fromEntries(names.map((name) => [name, 95])),
    queryCompliance: async () => [
      {
        control: "IEC-62443-SR-3.1",
        status: "pass",
        detail: "Integrity check succeeded",
        timestamp: 2_700,
        evidenceId: "anchor-7",
      },
      {
        control: "NIST-DE.CM-1",
        status: "warning",
        detail: "Review pending",
        timestamp: 2_800,
      },
    ],
    queryNotes: async () => ["Routine handoff complete"],
    ...overrides,
  };
}

describe("ReportingEngine generation and rendering", () => {
  it("ships shift, compliance, and trend templates backed by historical inputs", async () => {
    const clock = new MutableClock(4_000);
    const engine = new ReportingEngine({ clock, dataProvider: provider() });

    expect(engine.listTemplates().map((template) => template.id)).toEqual([
      "shift-summary",
      "compliance-audit",
      "trend-analysis",
    ]);

    const shift = await engine.generate("shift-summary", 500, 3_500);
    const compliance = await engine.generate("compliance-audit", 500, 3_500);
    const trend = await engine.generate("trend-analysis", 500, 3_500);

    expect(shift).toMatchObject({
      id: "RPT-000001",
      generatedAt: 4_000,
      type: "shift-summary",
    });
    expect(shift?.sections[0].content).toMatchObject({
      tagsMonitored: 1,
      dataPoints: 3,
      goodQuality: 2,
      uncertainQuality: 1,
      badQuality: 0,
    });
    expect(compliance?.sections[0].content).toMatchObject({
      summary: { total: 2, pass: 1, warning: 1, fail: 0 },
    });
    expect(trend?.sections[0].content).toEqual([
      {
        tag: "pressure",
        count: 3,
        min: 10,
        max: 30,
        mean: 20,
        first: 10,
        last: 30,
        delta: 20,
      },
    ]);
  });

  it("escapes template and historical content in every HTML context", async () => {
    const engine = new ReportingEngine({
      clock: new MutableClock(4_000),
      dataProvider: provider({
        queryAlarms: async () => [
          {
            tag: "<img src=x onerror=alert(1)>",
            severity: "high",
            message: "</td><script>alert('x')</script>",
            timestamp: 2_000,
          },
        ],
      }),
    });
    engine.registerTemplate({
      id: "hostile-template",
      name: "<script>title()</script>",
      type: "custom",
      sections: [
        {
          id: "hostile",
          title: "<img src=x onerror=alert(2)>",
          type: "alarm-list",
        },
      ],
    });
    const report = await engine.generate("hostile-template", 1_000, 3_000);
    const html = engine.renderHTML(report!);

    expect(html).toContain("&lt;script&gt;title()&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).toContain("&lt;/td&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Content-Security-Policy");
  });

  it("fails explicitly when no historian is configured", async () => {
    const engine = new ReportingEngine({ clock: new MutableClock(4_000) });
    await expect(engine.generate("shift-summary", 1_000, 2_000)).rejects.toThrow(
      "Historical data provider is not configured",
    );
    expect(engine.getReports()).toEqual([]);
  });
});

describe("delivery adapters and retry status", () => {
  it("retries transient webhook failures with deterministic backoff", async () => {
    const clock = new MutableClock(5_000);
    const sleeps: number[] = [];
    const sleeper: Sleeper = {
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock.value += milliseconds;
      },
    };
    const post = vi
      .fn()
      .mockResolvedValueOnce({ status: 500, requestId: "req-1" })
      .mockResolvedValueOnce({ status: 429, requestId: "req-2" })
      .mockResolvedValueOnce({ status: 204, requestId: "req-3" });
    const engine = new ReportingEngine({
      clock,
      sleeper,
      dataProvider: provider(),
      retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
      deliveryChannels: [
        new WebhookDeliveryChannel({ post }),
      ],
    });
    const report = await engine.generate("shift-summary", 1_000, 3_000);
    const delivery = await engine.deliver(report!, {
      method: "webhook",
      target: "https://reports.example.test/hooks/shift",
      headers: { authorization: "Bearer injected-by-config" },
    });

    expect(delivery).toMatchObject({
      id: "DLV-000001",
      state: "delivered",
      providerId: "req-3",
      deliveredAt: 5_030,
    });
    expect(delivery.attempts.map((attempt) => attempt.statusCode)).toEqual([
      500, 429, 204,
    ]);
    expect(sleeps).toEqual([10, 20]);
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[0][0]).toMatchObject({
      headers: {
        "content-type": "application/json",
        "x-0xscada-report-id": "RPT-000001",
        authorization: "Bearer injected-by-config",
      },
    });
  });

  it("does not retry permanent failures and retains their error status", async () => {
    const send = vi.fn(async () => {
      throw new DeliveryChannelError("Recipient rejected", false, 400);
    });
    const engine = new ReportingEngine({
      clock: new MutableClock(5_000),
      dataProvider: provider(),
      deliveryChannels: [{ method: "email", send }],
    });
    const report = await engine.generate("shift-summary", 1_000, 3_000);
    const delivery = await engine.deliver(report!, {
      method: "email",
      target: "operator@example.test",
    });

    expect(delivery).toMatchObject({
      state: "failed",
      error: "Recipient rejected",
      attempts: [
        {
          attempt: 1,
          state: "failed",
          retryable: false,
          statusCode: 400,
        },
      ],
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(engine.getDeliveryStatus(delivery.id)).toHaveLength(1);
  });

  it("uses an injected email transport and supplies safe HTML plus plain text", async () => {
    const send = vi.fn(async () => ({ messageId: "mail-9" }));
    const engine = new ReportingEngine({
      clock: new MutableClock(5_000),
      dataProvider: provider(),
      deliveryChannels: [new EmailDeliveryChannel({ send })],
    });
    const report = await engine.generate("shift-summary", 1_000, 3_000);
    const delivery = await engine.deliver(report!, {
      method: "email",
      target: "operator@example.test",
      subject: "Shift handoff",
    });

    expect(delivery).toMatchObject({
      state: "delivered",
      providerId: "mail-9",
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "operator@example.test",
        subject: "Shift handoff",
        html: expect.stringContaining("<!DOCTYPE html>"),
        text: expect.stringContaining("Shift Summary Report"),
      }),
    );
  });
});

describe("injectable scheduling", () => {
  it("generates the configured historical window and records delivery status", async () => {
    const clock = new MutableClock(20_000);
    const scheduler = new ManualScheduler();
    const periods: Array<{ start: number; end: number }> = [];
    const data = provider({
      querySeries: async (_pattern, period) => {
        periods.push(period);
        return {};
      },
    });
    const send = vi.fn(async () => ({}));
    const engine = new ReportingEngine({
      clock,
      scheduler,
      dataProvider: data,
      deliveryChannels: [{ method: "webhook", send }],
    });

    expect(
      engine.schedule({
        id: "shift-every-hour",
        templateId: "shift-summary",
        intervalMs: 3_600_000,
        lookbackMs: 8_000,
        deliveries: [
          { method: "webhook", target: "https://example.test/report" },
        ],
      }),
    ).toBe(true);
    await scheduler.trigger("shift-every-hour");

    expect(periods[0]).toEqual({ start: 12_000, end: 20_000 });
    expect(engine.getScheduleStatus("shift-every-hour")[0]).toMatchObject({
      active: true,
      running: false,
      runCount: 1,
      consecutiveFailures: 0,
      lastReportId: "RPT-000001",
      lastDeliveryIds: ["DLV-000001"],
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(engine.unscheduleReport("shift-every-hour")).toBe(true);
    expect(scheduler.cancelled).toEqual(["shift-every-hour"]);
  });

  it("skips overlapping runs instead of generating duplicate reports", async () => {
    const clock = new MutableClock(20_000);
    const scheduler = new ManualScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = new ReportingEngine({
      clock,
      scheduler,
      dataProvider: provider({
        querySeries: async () => {
          await gate;
          return {};
        },
      }),
    });
    engine.schedule({
      id: "non-overlap",
      templateId: "shift-summary",
      intervalMs: 1_000,
      lookbackMs: 1_000,
    });

    const first = engine.runSchedule("non-overlap");
    const second = await engine.runSchedule("non-overlap");
    expect(second).toMatchObject({ running: true, skippedOverlaps: 1 });
    release();
    await first;

    expect(engine.getReports()).toHaveLength(1);
    expect(engine.getScheduleStatus("non-overlap")[0]).toMatchObject({
      running: false,
      runCount: 1,
      skippedOverlaps: 1,
    });
  });
});
