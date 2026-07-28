import type {
  GeneratedReport,
  GeneratedSection,
  ReportContent,
} from "./types";

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderReportHtml(report: Readonly<GeneratedReport>): string {
  const sections = report.sections.map(renderSection).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(report.title)}</title>
<style>
body{font-family:system-ui,sans-serif;line-height:1.45;margin:2rem;color:#1f2937}
table{border-collapse:collapse;width:100%;margin:.75rem 0}
th,td{border:1px solid #d1d5db;padding:.45rem;text-align:left;vertical-align:top}
th{background:#f3f4f6}h1{margin-bottom:.25rem}h2{border-bottom:1px solid #e5e7eb;padding-bottom:.25rem}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f9fafb;padding:.75rem}
.meta{color:#4b5563}
</style>
</head>
<body>
<h1>${escapeHtml(report.title)}</h1>
<p class="meta">Generated: ${escapeHtml(toIso(report.generatedAt))}</p>
<p class="meta">Period: ${escapeHtml(toIso(report.periodStart))} — ${escapeHtml(toIso(report.periodEnd))}</p>
${sections}
</body>
</html>`;
}

export function renderReportText(report: Readonly<GeneratedReport>): string {
  const sections = report.sections
    .map(
      (section) =>
        `${section.title}\n${"-".repeat(section.title.length)}\n${contentToText(section.content)}`,
    )
    .join("\n\n");
  return `${report.title}
Generated: ${toIso(report.generatedAt)}
Period: ${toIso(report.periodStart)} — ${toIso(report.periodEnd)}

${sections}
`;
}

export function renderReportJson(report: Readonly<GeneratedReport>): string {
  return JSON.stringify(report, null, 2);
}

function renderSection(section: Readonly<GeneratedSection>): string {
  return `<section>
<h2>${escapeHtml(section.title)}</h2>
${renderContent(section.content)}
</section>`;
}

function renderContent(content: ReportContent): string {
  if (Array.isArray(content)) return renderTable(content);
  if (content !== null && typeof content === "object") {
    return `<pre>${escapeHtml(JSON.stringify(content, null, 2))}</pre>`;
  }
  return `<pre>${escapeHtml(content ?? "")}</pre>`;
}

function renderTable(
  rows: readonly Readonly<Record<string, unknown>>[],
): string {
  if (rows.length === 0) return "<p>No data</p>";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  return `<table>
<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
<tbody>${rows
    .map(
      (row) =>
        `<tr>${headers
          .map((header) => `<td>${escapeHtml(formatCell(row[header]))}</td>`)
          .join("")}</tr>`,
    )
    .join("")}</tbody>
</table>`;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function contentToText(content: ReportContent): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
