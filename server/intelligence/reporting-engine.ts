/**
 * Intelligent Reporting Engine
 * ADR-0013 [13.8] — Auto-generate shift reports, compliance summaries, trend analyses
 */

export type ReportType = 'shift-summary' | 'compliance-audit' | 'trend-analysis' | 'custom';
export type OutputFormat = 'html' | 'json' | 'text';
export type DeliveryMethod = 'webhook' | 'email' | 'file';

export interface ReportTemplate {
  id: string;
  name: string;
  type: ReportType;
  sections: ReportSection[];
  schedule?: ScheduleConfig;
  delivery?: DeliveryConfig;
}

export interface ReportSection {
  id: string;
  title: string;
  type: 'summary' | 'table' | 'chart-data' | 'text' | 'alarm-list' | 'kpi';
  dataQuery: string; // tag pattern or query
  format?: Record<string, unknown>;
}

export interface ScheduleConfig {
  cron: string; // e.g. "0 6 * * *" for daily at 6am
  timezone: string;
  enabled: boolean;
}

export interface DeliveryConfig {
  method: DeliveryMethod;
  target: string; // URL for webhook, address for email, path for file
  headers?: Record<string, string>;
}

export interface GeneratedReport {
  id: string;
  templateId: string;
  type: ReportType;
  title: string;
  generatedAt: number;
  periodStart: number;
  periodEnd: number;
  sections: GeneratedSection[];
  format: OutputFormat;
}

export interface GeneratedSection {
  id: string;
  title: string;
  content: string | Record<string, unknown> | Array<Record<string, unknown>>;
  type: ReportSection['type'];
}

export interface DataProvider {
  queryTags(pattern: string, start: number, end: number): Promise<Record<string, number[]>>;
  queryAlarms(start: number, end: number): Promise<Array<{ tag: string; severity: string; message: string; timestamp: number }>>;
  queryKPIs(names: string[]): Promise<Record<string, number>>;
}

// ── Report Templates (Built-in) ───────────────────────────────────

export const BUILT_IN_TEMPLATES: ReportTemplate[] = [
  {
    id: 'shift-summary',
    name: 'Shift Summary Report',
    type: 'shift-summary',
    sections: [
      { id: 'overview', title: 'Shift Overview', type: 'summary', dataQuery: '*' },
      { id: 'alarms', title: 'Alarm Summary', type: 'alarm-list', dataQuery: 'alarms:*' },
      { id: 'kpis', title: 'Key Performance Indicators', type: 'kpi', dataQuery: 'kpi:oee,throughput,quality' },
      { id: 'notes', title: 'Operator Notes', type: 'text', dataQuery: 'notes:shift' },
    ],
  },
  {
    id: 'compliance-audit',
    name: 'Compliance Audit Report',
    type: 'compliance-audit',
    sections: [
      { id: 'limits', title: 'Regulatory Limit Compliance', type: 'table', dataQuery: 'compliance:limits' },
      { id: 'exceedances', title: 'Limit Exceedances', type: 'alarm-list', dataQuery: 'compliance:exceedances' },
      { id: 'summary', title: 'Compliance Summary', type: 'summary', dataQuery: 'compliance:summary' },
    ],
  },
  {
    id: 'trend-analysis',
    name: 'Trend Analysis Report',
    type: 'trend-analysis',
    sections: [
      { id: 'trends', title: 'Tag Trends', type: 'chart-data', dataQuery: 'trends:*' },
      { id: 'stats', title: 'Statistical Summary', type: 'table', dataQuery: 'stats:*' },
      { id: 'anomalies', title: 'Detected Anomalies', type: 'alarm-list', dataQuery: 'anomalies:*' },
    ],
  },
];

// ── Reporting Engine ──────────────────────────────────────────────

export class ReportingEngine {
  private templates: Map<string, ReportTemplate> = new Map();
  private reports: GeneratedReport[] = [];
  private dataProvider: DataProvider | null = null;
  private schedules: Map<string, NodeJS.Timeout> = new Map();
  private reportCounter = 0;
  private deliveryHandlers: Map<DeliveryMethod, (report: GeneratedReport, config: DeliveryConfig) => Promise<void>> = new Map();

  constructor() {
    // Register built-in templates
    for (const t of BUILT_IN_TEMPLATES) {
      this.templates.set(t.id, t);
    }
  }

  setDataProvider(provider: DataProvider): void {
    this.dataProvider = provider;
  }

  // ── Templates ─────────────────────────────────────────────────

  registerTemplate(template: ReportTemplate): void {
    this.templates.set(template.id, template);
  }

  getTemplate(templateId: string): ReportTemplate | undefined {
    return this.templates.get(templateId);
  }

  listTemplates(): ReportTemplate[] {
    return [...this.templates.values()];
  }

  // ── Generation ────────────────────────────────────────────────

  async generate(
    templateId: string,
    periodStart: number,
    periodEnd: number,
    format: OutputFormat = 'html'
  ): Promise<GeneratedReport | null> {
    const template = this.templates.get(templateId);
    if (!template) return null;

    const sections: GeneratedSection[] = [];

    for (const section of template.sections) {
      const content = await this.generateSection(section, periodStart, periodEnd);
      sections.push({
        id: section.id,
        title: section.title,
        content,
        type: section.type,
      });
    }

    const report: GeneratedReport = {
      id: `RPT-${++this.reportCounter}`,
      templateId,
      type: template.type,
      title: template.name,
      generatedAt: Date.now(),
      periodStart,
      periodEnd,
      sections,
      format,
    };

    this.reports.push(report);
    return report;
  }

  private async generateSection(
    section: ReportSection,
    start: number,
    end: number
  ): Promise<string | Record<string, unknown> | Array<Record<string, unknown>>> {
    if (!this.dataProvider) {
      return `No data provider configured for section: ${section.title}`;
    }

    try {
      switch (section.type) {
        case 'summary': {
          const data = await this.dataProvider.queryTags(section.dataQuery, start, end);
          const tagCount = Object.keys(data).length;
          const totalPoints = Object.values(data).reduce((s, arr) => s + arr.length, 0);
          return `Period: ${new Date(start).toISOString()} to ${new Date(end).toISOString()}\nTags monitored: ${tagCount}\nData points: ${totalPoints}`;
        }
        case 'alarm-list': {
          const alarms = await this.dataProvider.queryAlarms(start, end);
          return alarms.map((a) => ({
            tag: a.tag,
            severity: a.severity,
            message: a.message,
            time: new Date(a.timestamp).toISOString(),
          }));
        }
        case 'kpi': {
          const names = section.dataQuery.replace('kpi:', '').split(',');
          return await this.dataProvider.queryKPIs(names);
        }
        case 'table':
        case 'chart-data': {
          const data = await this.dataProvider.queryTags(section.dataQuery, start, end);
          return Object.entries(data).map(([tag, values]) => ({
            tag,
            min: values.length ? Math.min(...values) : null,
            max: values.length ? Math.max(...values) : null,
            avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
            count: values.length,
          }));
        }
        case 'text':
          return section.dataQuery;
        default:
          return 'Unknown section type';
      }
    } catch (err) {
      return `Error generating section: ${err instanceof Error ? err.message : 'unknown'}`;
    }
  }

  // ── Rendering ─────────────────────────────────────────────────

  renderHTML(report: GeneratedReport): string {
    const sections = report.sections.map((s) => {
      let body: string;
      if (typeof s.content === 'string') {
        body = `<pre>${s.content}</pre>`;
      } else if (Array.isArray(s.content)) {
        if (s.content.length === 0) {
          body = '<p>No data</p>';
        } else {
          const headers = Object.keys(s.content[0]);
          const rows = s.content.map(
            (row) => `<tr>${headers.map((h) => `<td>${(row as Record<string, unknown>)[h] ?? ''}</td>`).join('')}</tr>`
          );
          body = `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
        }
      } else {
        body = `<pre>${JSON.stringify(s.content, null, 2)}</pre>`;
      }
      return `<section><h2>${s.title}</h2>${body}</section>`;
    });

    return `<!DOCTYPE html>
<html><head><title>${report.title}</title>
<style>body{font-family:sans-serif;margin:2em}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}th{background:#f5f5f5}h1{color:#333}h2{color:#555;border-bottom:1px solid #eee}</style>
</head><body>
<h1>${report.title}</h1>
<p>Generated: ${new Date(report.generatedAt).toISOString()}</p>
<p>Period: ${new Date(report.periodStart).toISOString()} — ${new Date(report.periodEnd).toISOString()}</p>
${sections.join('\n')}
</body></html>`;
  }

  // ── Delivery ──────────────────────────────────────────────────

  registerDeliveryHandler(
    method: DeliveryMethod,
    handler: (report: GeneratedReport, config: DeliveryConfig) => Promise<void>
  ): void {
    this.deliveryHandlers.set(method, handler);
  }

  async deliver(report: GeneratedReport, config: DeliveryConfig): Promise<boolean> {
    const handler = this.deliveryHandlers.get(config.method);
    if (!handler) return false;

    try {
      await handler(report, config);
      return true;
    } catch {
      return false;
    }
  }

  // ── Scheduling ────────────────────────────────────────────────

  scheduleReport(templateId: string, intervalMs: number, format: OutputFormat = 'html'): boolean {
    const template = this.templates.get(templateId);
    if (!template) return false;

    // Simple interval-based scheduling (production would use cron parser)
    const timer = setInterval(async () => {
      const end = Date.now();
      const start = end - intervalMs;
      const report = await this.generate(templateId, start, end, format);
      if (report && template.delivery) {
        await this.deliver(report, template.delivery);
      }
    }, intervalMs);

    this.schedules.set(templateId, timer);
    return true;
  }

  unscheduleReport(templateId: string): boolean {
    const timer = this.schedules.get(templateId);
    if (!timer) return false;
    clearInterval(timer);
    this.schedules.delete(templateId);
    return true;
  }

  // ── Accessors ─────────────────────────────────────────────────

  getReports(type?: ReportType): GeneratedReport[] {
    if (!type) return [...this.reports];
    return this.reports.filter((r) => r.type === type);
  }

  getReport(reportId: string): GeneratedReport | undefined {
    return this.reports.find((r) => r.id === reportId);
  }

  destroyAll(): void {
    for (const [id] of this.schedules) {
      this.unscheduleReport(id);
    }
    this.reports = [];
  }
}
