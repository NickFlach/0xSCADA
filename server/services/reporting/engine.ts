import { EventEmitter } from "events";
import { DeliveryChannelError } from "./delivery";
import { renderReportHtml, renderReportJson, renderReportText } from "./render";
import { IntervalReportScheduler, timerSleeper } from "./scheduler";
import { BUILT_IN_TEMPLATES } from "./templates";
import {
  systemReportClock,
  type ComplianceEvent,
  type DeliveryAttempt,
  type DeliveryChannel,
  type DeliveryConfig,
  type DeliveryStatus,
  type GeneratedReport,
  type GeneratedSection,
  type HistoricalAlarm,
  type HistoricalDataProvider,
  type HistoricalPoint,
  type LegacyDataProvider,
  type OutputFormat,
  type ReportClock,
  type ReportContent,
  type ReportPeriod,
  type ReportSchedule,
  type ReportScheduler,
  type ReportScheduleStatus,
  type ReportSection,
  type ReportTemplate,
  type ReportType,
  type RetryPolicy,
  type ScheduledHandle,
  type Sleeper,
} from "./types";

const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
});

export interface ReportingEngineOptions {
  dataProvider?: HistoricalDataProvider | LegacyDataProvider;
  clock?: ReportClock;
  scheduler?: ReportScheduler;
  sleeper?: Sleeper;
  deliveryChannels?: readonly DeliveryChannel[];
  retryPolicy?: RetryPolicy;
  maxReports?: number;
  maxDeliveries?: number;
}

interface InternalSchedule {
  spec: ReportSchedule;
  handle: ScheduledHandle;
  status: ReportScheduleStatus;
}

export class ReportingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportingConfigurationError";
  }
}

/**
 * Template-based, historical reporting engine with injectable scheduling and
 * delivery boundaries.
 */
export class ReportingEngine extends EventEmitter {
  private readonly clock: ReportClock;
  private readonly scheduler: ReportScheduler;
  private readonly sleeper: Sleeper;
  private readonly retryPolicy: RetryPolicy;
  private readonly maxReports: number;
  private readonly maxDeliveries: number;
  private readonly templates = new Map<string, ReportTemplate>();
  private readonly channels = new Map<DeliveryConfig["method"], DeliveryChannel>();
  private readonly reports: GeneratedReport[] = [];
  private readonly deliveries: DeliveryStatus[] = [];
  private readonly schedules = new Map<string, InternalSchedule>();
  private dataProvider?: HistoricalDataProvider;
  private reportCounter = 0;
  private deliveryCounter = 0;

  constructor(options: ReportingEngineOptions = {}) {
    super();
    this.clock = options.clock ?? systemReportClock;
    this.scheduler = options.scheduler ?? new IntervalReportScheduler();
    this.sleeper = options.sleeper ?? timerSleeper;
    this.retryPolicy = validateRetryPolicy(options.retryPolicy ?? DEFAULT_RETRY_POLICY);
    this.maxReports = positiveInteger(options.maxReports ?? 500, "maxReports");
    this.maxDeliveries = positiveInteger(options.maxDeliveries ?? 2_000, "maxDeliveries");
    for (const template of BUILT_IN_TEMPLATES) this.registerTemplate(template);
    for (const channel of options.deliveryChannels ?? []) {
      this.registerDeliveryChannel(channel);
    }
    if (options.dataProvider) this.setDataProvider(options.dataProvider);
  }

  setDataProvider(provider: HistoricalDataProvider | LegacyDataProvider): void {
    this.dataProvider = isLegacyProvider(provider) ? adaptLegacyProvider(provider) : provider;
  }

  registerTemplate(template: ReportTemplate): void {
    validateTemplate(template);
    this.templates.set(template.id, cloneTemplate(template));
  }

  getTemplate(templateId: string): ReportTemplate | undefined {
    const template = this.templates.get(templateId);
    return template ? cloneTemplate(template) : undefined;
  }

  listTemplates(): ReportTemplate[] {
    return [...this.templates.values()].map(cloneTemplate);
  }

  async generate(
    templateId: string,
    periodStart: number,
    periodEnd: number,
    format: OutputFormat = "html",
  ): Promise<GeneratedReport | null> {
    const template = this.templates.get(templateId);
    if (!template) return null;
    const period = validatePeriod({ start: periodStart, end: periodEnd });
    const provider = this.dataProvider;
    if (!provider) {
      throw new ReportingConfigurationError("Historical data provider is not configured");
    }

    const sections: GeneratedSection[] = [];
    for (const section of template.sections) {
      sections.push({
        id: section.id,
        title: section.title,
        type: section.type,
        content: await generateSection(provider, section, period),
      });
    }
    const report: GeneratedReport = {
      id: `RPT-${String(++this.reportCounter).padStart(6, "0")}`,
      templateId: template.id,
      type: template.type,
      title: template.name,
      generatedAt: this.clock.now(),
      periodStart: period.start,
      periodEnd: period.end,
      sections,
      format,
    };
    this.reports.push(report);
    if (this.reports.length > this.maxReports) {
      this.reports.splice(0, this.reports.length - this.maxReports);
    }
    this.emit("report", cloneReport(report));
    return cloneReport(report);
  }

  renderHTML(report: Readonly<GeneratedReport>): string {
    return renderReportHtml(report);
  }

  renderText(report: Readonly<GeneratedReport>): string {
    return renderReportText(report);
  }

  renderJSON(report: Readonly<GeneratedReport>): string {
    return renderReportJson(report);
  }

  registerDeliveryChannel(channel: DeliveryChannel): void {
    if (this.channels.has(channel.method)) {
      throw new Error(`Delivery channel ${channel.method} is already registered`);
    }
    this.channels.set(channel.method, channel);
  }

  /**
   * Compatibility helper for the prototype API.  New integrations should
   * implement DeliveryChannel so they also receive rendered payloads.
   */
  registerDeliveryHandler(
    method: DeliveryConfig["method"],
    handler: (report: GeneratedReport, config: DeliveryConfig) => Promise<void>,
  ): void {
    this.registerDeliveryChannel({
      method,
      send: async (payload) => {
        await handler(cloneReport(payload.report), {
          method,
          target: payload.target,
          headers: { ...payload.headers },
          subject: payload.subject,
        });
        return {};
      },
    });
  }

  async deliver(
    report: Readonly<GeneratedReport>,
    config: DeliveryConfig,
    retryPolicy: RetryPolicy = this.retryPolicy,
  ): Promise<DeliveryStatus> {
    const channel = this.channels.get(config.method);
    const policy = validateRetryPolicy(retryPolicy);
    const delivery: DeliveryStatus = {
      id: `DLV-${String(++this.deliveryCounter).padStart(6, "0")}`,
      reportId: report.id,
      method: config.method,
      target: config.target,
      state: "failed",
      attempts: [],
    };
    if (!channel) {
      delivery.error = `Delivery channel ${config.method} is not configured`;
      this.storeDelivery(delivery);
      this.emit("delivery", cloneDelivery(delivery));
      return cloneDelivery(delivery);
    }

    const payload = {
      deliveryId: delivery.id,
      report: cloneReport(report),
      target: config.target,
      subject: config.subject ?? report.title,
      headers: { ...(config.headers ?? {}) },
      html: this.renderHTML(report),
      text: this.renderText(report),
      json: this.renderJSON(report),
    };
    const attempts: DeliveryAttempt[] = [];
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      const startedAt = this.clock.now();
      try {
        const receipt = await channel.send(payload);
        const completedAt = this.clock.now();
        attempts.push({
          attempt,
          startedAt,
          completedAt,
          state: "delivered",
          ...(receipt.statusCode !== undefined ? { statusCode: receipt.statusCode } : {}),
        });
        delivery.state = "delivered";
        delivery.attempts = attempts;
        delivery.deliveredAt = completedAt;
        delivery.providerId = receipt.providerId;
        delete delivery.error;
        this.storeDelivery(delivery);
        this.emit("delivery", cloneDelivery(delivery));
        return cloneDelivery(delivery);
      } catch (error) {
        const completedAt = this.clock.now();
        const retryable = error instanceof DeliveryChannelError ? error.retryable : true;
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({
          attempt,
          startedAt,
          completedAt,
          state: "failed",
          error: message,
          retryable,
          ...(error instanceof DeliveryChannelError && error.statusCode !== undefined
            ? { statusCode: error.statusCode }
            : {}),
        });
        delivery.error = message;
        if (!retryable || attempt === policy.maxAttempts) break;
        const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
        await this.sleeper.sleep(delay);
      }
    }
    delivery.attempts = attempts;
    this.storeDelivery(delivery);
    this.emit("delivery", cloneDelivery(delivery));
    return cloneDelivery(delivery);
  }

  schedule(schedule: ReportSchedule): boolean {
    validateSchedule(schedule);
    if (!this.templates.has(schedule.templateId)) return false;
    if (this.schedules.has(schedule.id)) {
      throw new Error(`Report schedule ${schedule.id} already exists`);
    }
    const spec = cloneSchedule(schedule);
    const status: ReportScheduleStatus = {
      id: spec.id,
      templateId: spec.templateId,
      active: true,
      running: false,
      runCount: 0,
      skippedOverlaps: 0,
      consecutiveFailures: 0,
      lastDeliveryIds: [],
    };
    const scheduled: InternalSchedule = {
      spec,
      handle: { cancel: () => undefined },
      status,
    };
    this.schedules.set(spec.id, scheduled);
    try {
      scheduled.handle = this.scheduler.every(spec.id, spec.intervalMs, async () => {
        await this.runSchedule(spec.id);
      });
    } catch (error) {
      this.schedules.delete(spec.id);
      throw error;
    }
    return true;
  }

  /** Original prototype API: schedule id is the template id. */
  scheduleReport(templateId: string, intervalMs: number, format: OutputFormat = "html"): boolean {
    return this.schedule({
      id: templateId,
      templateId,
      intervalMs,
      lookbackMs: intervalMs,
      format,
    });
  }

  async runSchedule(scheduleId: string): Promise<ReportScheduleStatus> {
    const scheduled = this.schedules.get(scheduleId);
    if (!scheduled) throw new Error(`Report schedule ${scheduleId} not found`);
    if (scheduled.status.running) {
      scheduled.status.skippedOverlaps += 1;
      return cloneScheduleStatus(scheduled.status);
    }
    scheduled.status.running = true;
    scheduled.status.lastStartedAt = this.clock.now();
    scheduled.status.lastError = undefined;
    try {
      const periodEnd = this.clock.now();
      const report = await this.generate(
        scheduled.spec.templateId,
        periodEnd - scheduled.spec.lookbackMs,
        periodEnd,
        scheduled.spec.format ?? "html",
      );
      if (!report) {
        throw new Error(`Template ${scheduled.spec.templateId} no longer exists`);
      }
      const template = this.templates.get(scheduled.spec.templateId)!;
      const deliveryConfigs = scheduled.spec.deliveries ?? template.delivery ?? [];
      const deliveryIds: string[] = [];
      const failures: string[] = [];
      for (const config of deliveryConfigs) {
        const delivery = await this.deliver(report, config);
        deliveryIds.push(delivery.id);
        if (delivery.state === "failed") {
          failures.push(`${config.method}: ${delivery.error ?? "delivery failed"}`);
        }
      }
      scheduled.status.runCount += 1;
      scheduled.status.lastReportId = report.id;
      scheduled.status.lastDeliveryIds = deliveryIds;
      if (failures.length > 0) {
        scheduled.status.consecutiveFailures += 1;
        scheduled.status.lastError = failures.join("; ");
      } else {
        scheduled.status.consecutiveFailures = 0;
      }
    } catch (error) {
      scheduled.status.consecutiveFailures += 1;
      scheduled.status.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      scheduled.status.running = false;
      scheduled.status.lastCompletedAt = this.clock.now();
      this.emit("schedule", cloneScheduleStatus(scheduled.status));
    }
    return cloneScheduleStatus(scheduled.status);
  }

  unscheduleReport(scheduleId: string): boolean {
    const scheduled = this.schedules.get(scheduleId);
    if (!scheduled) return false;
    scheduled.handle.cancel();
    scheduled.status.active = false;
    this.schedules.delete(scheduleId);
    return true;
  }

  getScheduleStatus(scheduleId?: string): ReportScheduleStatus[] {
    return [...this.schedules.values()]
      .filter((scheduled) => !scheduleId || scheduled.spec.id === scheduleId)
      .map((scheduled) => cloneScheduleStatus(scheduled.status));
  }

  getReports(type?: ReportType): GeneratedReport[] {
    return this.reports.filter((report) => !type || report.type === type).map(cloneReport);
  }

  getReport(reportId: string): GeneratedReport | undefined {
    const report = this.reports.find((candidate) => candidate.id === reportId);
    return report ? cloneReport(report) : undefined;
  }

  getDeliveryStatus(deliveryId?: string): DeliveryStatus[] {
    return this.deliveries
      .filter((delivery) => !deliveryId || delivery.id === deliveryId)
      .map(cloneDelivery);
  }

  destroyAll(): void {
    for (const scheduleId of [...this.schedules.keys()]) {
      this.unscheduleReport(scheduleId);
    }
    this.reports.splice(0);
    this.deliveries.splice(0);
  }

  private storeDelivery(delivery: DeliveryStatus): void {
    this.deliveries.push(cloneDelivery(delivery));
    if (this.deliveries.length > this.maxDeliveries) {
      this.deliveries.splice(0, this.deliveries.length - this.maxDeliveries);
    }
  }
}

async function generateSection(
  provider: HistoricalDataProvider,
  section: ReportSection,
  period: ReportPeriod,
): Promise<ReportContent> {
  switch (section.type) {
    case "summary": {
      const series = normalizeSeries(
        await provider.querySeries(section.query ?? section.dataQuery ?? "*", period),
        period,
      );
      const points = Object.values(series).flat();
      return {
        periodStart: new Date(period.start).toISOString(),
        periodEnd: new Date(period.end).toISOString(),
        tagsMonitored: Object.keys(series).length,
        dataPoints: points.length,
        goodQuality: points.filter(
          (point) => point.quality === undefined || point.quality === "good",
        ).length,
        uncertainQuality: points.filter((point) => point.quality === "uncertain").length,
        badQuality: points.filter((point) => point.quality === "bad").length,
      };
    }
    case "alarm-list":
      return normalizeAlarms(await provider.queryAlarms(period), period).map((alarm) => ({
        id: alarm.id ?? "",
        tag: alarm.tag,
        severity: alarm.severity,
        message: alarm.message,
        timestamp: new Date(alarm.timestamp).toISOString(),
        acknowledged: alarm.acknowledged ?? false,
      }));
    case "kpi":
      return provider.queryKPIs(section.kpis ?? [], period);
    case "statistics": {
      const series = normalizeSeries(
        await provider.querySeries(section.query ?? section.dataQuery ?? "*", period),
        period,
      );
      return Object.keys(series)
        .sort()
        .map((tag) => statisticsFor(tag, series[tag]));
    }
    case "trend-data": {
      const series = normalizeSeries(
        await provider.querySeries(section.query ?? section.dataQuery ?? "*", period),
        period,
      );
      return Object.keys(series)
        .sort()
        .flatMap((tag) =>
          series[tag].map((point) => ({
            tag,
            timestamp: new Date(point.timestamp).toISOString(),
            value: point.value,
            quality: point.quality ?? "good",
          })),
        );
    }
    case "compliance": {
      const events = normalizeCompliance(await provider.queryCompliance(period), period);
      return {
        summary: {
          total: events.length,
          pass: events.filter((event) => event.status === "pass").length,
          warning: events.filter((event) => event.status === "warning").length,
          fail: events.filter((event) => event.status === "fail").length,
        },
        events: events.map((event) => ({
          ...event,
          timestamp: new Date(event.timestamp).toISOString(),
        })),
      };
    }
    case "notes": {
      if (!provider.queryNotes) return [];
      return (await provider.queryNotes(section.query ?? section.dataQuery ?? "shift", period)).map(
        (note, index) => ({ index: index + 1, note }),
      );
    }
    case "text":
      return section.text ?? section.dataQuery ?? "";
  }
}

function statisticsFor(
  tag: string,
  points: readonly HistoricalPoint[],
): Readonly<Record<string, unknown>> {
  if (points.length === 0) {
    return {
      tag,
      count: 0,
      min: null,
      max: null,
      mean: null,
      first: null,
      last: null,
      delta: null,
    };
  }
  const first = points[0].value;
  const last = points[points.length - 1].value;
  let min = first;
  let max = first;
  let sum = 0;
  for (const point of points) {
    min = Math.min(min, point.value);
    max = Math.max(max, point.value);
    sum += point.value;
  }
  return {
    tag,
    count: points.length,
    min,
    max,
    mean: sum / points.length,
    first,
    last,
    delta: last - first,
  };
}

function normalizeSeries(
  input: Record<string, readonly HistoricalPoint[]>,
  period: ReportPeriod,
): Record<string, HistoricalPoint[]> {
  const result: Record<string, HistoricalPoint[]> = {};
  for (const tag of Object.keys(input).sort()) {
    result[tag] = input[tag]
      .filter(
        (point) =>
          Number.isFinite(point.timestamp) &&
          Number.isFinite(point.value) &&
          point.timestamp > period.start &&
          point.timestamp <= period.end,
      )
      .map((point) => ({ ...point }))
      .sort((left, right) => left.timestamp - right.timestamp);
  }
  return result;
}

function normalizeAlarms(
  alarms: readonly HistoricalAlarm[],
  period: ReportPeriod,
): HistoricalAlarm[] {
  return alarms
    .filter(
      (alarm) =>
        Number.isFinite(alarm.timestamp) &&
        alarm.timestamp > period.start &&
        alarm.timestamp <= period.end,
    )
    .map((alarm) => ({ ...alarm }))
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp ||
        left.tag.localeCompare(right.tag) ||
        left.message.localeCompare(right.message),
    );
}

function normalizeCompliance(
  events: readonly ComplianceEvent[],
  period: ReportPeriod,
): ComplianceEvent[] {
  return events
    .filter(
      (event) =>
        Number.isFinite(event.timestamp) &&
        event.timestamp > period.start &&
        event.timestamp <= period.end,
    )
    .map((event) => ({ ...event }))
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.control.localeCompare(right.control),
    );
}

function adaptLegacyProvider(provider: LegacyDataProvider): HistoricalDataProvider {
  return {
    querySeries: async (pattern, period) => {
      const values = await provider.queryTags(pattern, period.start, period.end);
      const result: Record<string, HistoricalPoint[]> = {};
      for (const [tag, samples] of Object.entries(values)) {
        const spacing = samples.length > 1 ? (period.end - period.start) / (samples.length - 1) : 0;
        result[tag] = samples.map((value, index) => ({
          timestamp: period.start + spacing * index,
          value,
          quality: "good",
        }));
      }
      return result;
    },
    queryAlarms: (period) => provider.queryAlarms(period.start, period.end),
    queryKPIs: (names) => provider.queryKPIs([...names]),
    queryCompliance: async () => [],
    queryNotes: async () => [],
  };
}

function isLegacyProvider(
  provider: HistoricalDataProvider | LegacyDataProvider,
): provider is LegacyDataProvider {
  return "queryTags" in provider;
}

function validatePeriod(period: ReportPeriod): ReportPeriod {
  if (
    !Number.isFinite(period.start) ||
    !Number.isFinite(period.end) ||
    period.start >= period.end
  ) {
    throw new Error("Report period must have finite start < end");
  }
  return { ...period };
}

function validateTemplate(template: ReportTemplate): void {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(template.id)) {
    throw new Error("Template id must be a lowercase slug");
  }
  if (!template.name.trim() || template.sections.length === 0) {
    throw new Error("Template name and at least one section are required");
  }
  const sectionIds = new Set<string>();
  for (const section of template.sections) {
    if (!section.id || !section.title || sectionIds.has(section.id)) {
      throw new Error(`Template ${template.id} has an invalid or duplicate section id`);
    }
    sectionIds.add(section.id);
    if (section.type === "text" && section.text === undefined && section.dataQuery === undefined) {
      throw new Error(`Text section ${section.id} must declare text`);
    }
  }
}

function validateSchedule(schedule: ReportSchedule): void {
  if (!schedule.id || !schedule.templateId) {
    throw new Error("Schedule id and template id are required");
  }
  positiveInteger(schedule.intervalMs, "intervalMs");
  positiveInteger(schedule.lookbackMs, "lookbackMs");
}

function validateRetryPolicy(policy: RetryPolicy): RetryPolicy {
  positiveInteger(policy.maxAttempts, "retryPolicy.maxAttempts");
  if (
    !Number.isFinite(policy.baseDelayMs) ||
    policy.baseDelayMs < 0 ||
    !Number.isFinite(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.baseDelayMs
  ) {
    throw new Error("Retry delays must be finite and maxDelayMs >= baseDelayMs");
  }
  return { ...policy };
}

function cloneTemplate(template: ReportTemplate): ReportTemplate {
  return {
    ...template,
    sections: template.sections.map((section) => ({
      ...section,
      kpis: section.kpis ? [...section.kpis] : undefined,
    })),
    delivery: template.delivery?.map((config) => ({
      ...config,
      headers: config.headers ? { ...config.headers } : undefined,
    })),
  };
}

function cloneReport(report: Readonly<GeneratedReport>): GeneratedReport {
  return {
    ...report,
    sections: report.sections.map((section) => ({
      ...section,
      content: cloneContent(section.content),
    })),
  };
}

function cloneContent(content: ReportContent): ReportContent {
  if (Array.isArray(content)) return content.map((row) => ({ ...row }));
  if (content !== null && typeof content === "object") {
    return structuredClone(content) as Readonly<Record<string, unknown>>;
  }
  return content;
}

function cloneDelivery(delivery: DeliveryStatus): DeliveryStatus {
  return {
    ...delivery,
    attempts: delivery.attempts.map((attempt) => ({ ...attempt })),
  };
}

function cloneSchedule(schedule: ReportSchedule): ReportSchedule {
  return {
    ...schedule,
    deliveries: schedule.deliveries?.map((config) => ({
      ...config,
      headers: config.headers ? { ...config.headers } : undefined,
    })),
  };
}

function cloneScheduleStatus(status: ReportScheduleStatus): ReportScheduleStatus {
  return { ...status, lastDeliveryIds: [...status.lastDeliveryIds] };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
