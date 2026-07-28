import type { ReportTemplate } from "./types";

/**
 * Built-ins are data/query declarations, not HTML fragments.  All content
 * therefore passes through the same escaping renderer as custom templates.
 */
export const BUILT_IN_TEMPLATES: readonly ReportTemplate[] = Object.freeze([
  Object.freeze({
    id: "shift-summary",
    name: "Shift Summary Report",
    type: "shift-summary",
    sections: Object.freeze([
      Object.freeze({
        id: "overview",
        title: "Shift Overview",
        type: "summary",
        query: "*",
      }),
      Object.freeze({
        id: "alarms",
        title: "Alarm Summary",
        type: "alarm-list",
      }),
      Object.freeze({
        id: "kpis",
        title: "Key Performance Indicators",
        type: "kpi",
        kpis: Object.freeze(["oee", "throughput", "quality"]),
      }),
      Object.freeze({
        id: "notes",
        title: "Operator Notes",
        type: "notes",
        query: "shift",
      }),
    ]),
  }),
  Object.freeze({
    id: "compliance-audit",
    name: "Compliance Summary Report",
    type: "compliance-audit",
    sections: Object.freeze([
      Object.freeze({
        id: "compliance",
        title: "Control Compliance",
        type: "compliance",
      }),
      Object.freeze({
        id: "exceptions",
        title: "Alarm and Exception Evidence",
        type: "alarm-list",
      }),
      Object.freeze({
        id: "process-summary",
        title: "Process Data Coverage",
        type: "summary",
        query: "*",
      }),
    ]),
  }),
  Object.freeze({
    id: "trend-analysis",
    name: "Trend Analysis Report",
    type: "trend-analysis",
    sections: Object.freeze([
      Object.freeze({
        id: "statistics",
        title: "Statistical Summary",
        type: "statistics",
        query: "*",
      }),
      Object.freeze({
        id: "trends",
        title: "Historical Trend Data",
        type: "trend-data",
        query: "*",
      }),
      Object.freeze({
        id: "anomalies",
        title: "Alarms During Period",
        type: "alarm-list",
      }),
    ]),
  }),
] satisfies ReportTemplate[]);
