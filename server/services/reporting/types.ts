/**
 * Public contracts for the ADR-0013 intelligent reporting engine.
 */

export type ReportType = "shift-summary" | "compliance-audit" | "trend-analysis" | "custom";

export type OutputFormat = "html" | "json" | "text";
export type DeliveryMethod = "webhook" | "email";

export interface ReportClock {
  now(): number;
}

export const systemReportClock: ReportClock = Object.freeze({
  now: () => Date.now(),
});

export interface ReportPeriod {
  start: number;
  end: number;
}

export interface HistoricalPoint {
  timestamp: number;
  value: number;
  quality?: "good" | "uncertain" | "bad";
}

export interface HistoricalAlarm {
  id?: string;
  tag: string;
  severity: string;
  message: string;
  timestamp: number;
  acknowledged?: boolean;
}

export interface ComplianceEvent {
  control: string;
  status: "pass" | "fail" | "warning";
  detail: string;
  timestamp: number;
  evidenceId?: string;
}

export interface HistoricalDataProvider {
  querySeries(
    pattern: string,
    period: ReportPeriod,
  ): Promise<Record<string, readonly HistoricalPoint[]>>;
  queryAlarms(period: ReportPeriod): Promise<readonly HistoricalAlarm[]>;
  queryKPIs(
    names: readonly string[],
    period: ReportPeriod,
  ): Promise<Record<string, number | string | null>>;
  queryCompliance(period: ReportPeriod): Promise<readonly ComplianceEvent[]>;
  queryNotes?(kind: string, period: ReportPeriod): Promise<readonly string[]>;
}

/** Adapter shape supported for callers of the original issue prototype. */
export interface LegacyDataProvider {
  queryTags(pattern: string, start: number, end: number): Promise<Record<string, number[]>>;
  queryAlarms(
    start: number,
    end: number,
  ): Promise<
    Array<{
      tag: string;
      severity: string;
      message: string;
      timestamp: number;
    }>
  >;
  queryKPIs(names: string[]): Promise<Record<string, number>>;
}

export type ReportSectionKind =
  "summary" | "alarm-list" | "kpi" | "statistics" | "trend-data" | "compliance" | "notes" | "text";

export interface ReportSection {
  id: string;
  title: string;
  type: ReportSectionKind;
  query?: string;
  /** Compatibility alias used by the original issue prototype. */
  dataQuery?: string;
  kpis?: readonly string[];
  text?: string;
}

export interface DeliveryConfig {
  method: DeliveryMethod;
  target: string;
  headers?: Readonly<Record<string, string>>;
  subject?: string;
}

export interface ReportTemplate {
  id: string;
  name: string;
  type: ReportType;
  sections: readonly ReportSection[];
  delivery?: readonly DeliveryConfig[];
}

export type ReportContent =
  | string
  | number
  | boolean
  | null
  | Readonly<Record<string, unknown>>
  | readonly Readonly<Record<string, unknown>>[];

export interface GeneratedSection {
  id: string;
  title: string;
  type: ReportSectionKind;
  content: ReportContent;
}

export interface GeneratedReport {
  id: string;
  templateId: string;
  type: ReportType;
  title: string;
  generatedAt: number;
  periodStart: number;
  periodEnd: number;
  sections: readonly GeneratedSection[];
  format: OutputFormat;
}

export interface DeliveryPayload {
  /** Stable across every retry of this delivery operation. */
  deliveryId: string;
  report: Readonly<GeneratedReport>;
  target: string;
  subject: string;
  headers: Readonly<Record<string, string>>;
  html: string;
  text: string;
  json: string;
}

export interface DeliveryReceipt {
  providerId?: string;
  statusCode?: number;
}

export interface DeliveryChannel {
  readonly method: DeliveryMethod;
  send(payload: DeliveryPayload): Promise<DeliveryReceipt>;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface Sleeper {
  sleep(milliseconds: number): Promise<void>;
}

export type DeliveryState = "delivered" | "failed";

export interface DeliveryAttempt {
  attempt: number;
  startedAt: number;
  completedAt: number;
  state: DeliveryState;
  error?: string;
  retryable?: boolean;
  statusCode?: number;
}

export interface DeliveryStatus {
  id: string;
  reportId: string;
  method: DeliveryMethod;
  target: string;
  state: DeliveryState;
  attempts: readonly DeliveryAttempt[];
  deliveredAt?: number;
  providerId?: string;
  error?: string;
}

export interface ScheduledHandle {
  cancel(): void;
}

export interface ReportScheduler {
  every(id: string, intervalMs: number, task: () => void | Promise<void>): ScheduledHandle;
}

export interface ReportSchedule {
  id: string;
  templateId: string;
  intervalMs: number;
  lookbackMs: number;
  format?: OutputFormat;
  deliveries?: readonly DeliveryConfig[];
}

export interface ReportScheduleStatus {
  id: string;
  templateId: string;
  active: boolean;
  running: boolean;
  runCount: number;
  skippedOverlaps: number;
  consecutiveFailures: number;
  lastStartedAt?: number;
  lastCompletedAt?: number;
  lastReportId?: string;
  lastDeliveryIds: readonly string[];
  lastError?: string;
}
