import { describe, it, expect, afterEach } from 'vitest';
import { ReportingEngine } from '../../intelligence/reporting-engine';

describe('ReportingEngine', () => {
  let engine: ReportingEngine;

  afterEach(() => {
    engine?.destroyAll();
  });

  it('has built-in templates', () => {
    engine = new ReportingEngine();
    const templates = engine.listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(3);
    expect(templates.map((t) => t.id)).toContain('shift-summary');
  });

  it('generates a report with data provider', async () => {
    engine = new ReportingEngine();
    engine.setDataProvider({
      queryTags: async () => ({ 'tag-1': [10, 20, 30], 'tag-2': [40, 50] }),
      queryAlarms: async () => [
        { tag: 'tag-1', severity: 'high', message: 'Over limit', timestamp: Date.now() },
      ],
      queryKPIs: async (names) => Object.fromEntries(names.map((n) => [n, 95])),
    });

    const report = await engine.generate('shift-summary', Date.now() - 3600000, Date.now());
    expect(report).not.toBeNull();
    expect(report!.sections.length).toBeGreaterThan(0);
    expect(report!.type).toBe('shift-summary');
  });

  it('renders HTML', async () => {
    engine = new ReportingEngine();
    engine.setDataProvider({
      queryTags: async () => ({}),
      queryAlarms: async () => [],
      queryKPIs: async () => ({}),
    });

    const report = await engine.generate('shift-summary', 0, Date.now());
    const html = engine.renderHTML(report!);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Shift Summary');
  });

  it('registers custom templates', async () => {
    engine = new ReportingEngine();
    engine.registerTemplate({
      id: 'custom-1',
      name: 'Custom Report',
      type: 'custom',
      sections: [{ id: 's1', title: 'Custom Section', type: 'text', dataQuery: 'hello' }],
    });

    engine.setDataProvider({
      queryTags: async () => ({}),
      queryAlarms: async () => [],
      queryKPIs: async () => ({}),
    });

    const report = await engine.generate('custom-1', 0, Date.now());
    expect(report).not.toBeNull();
    expect(report!.templateId).toBe('custom-1');
  });

  it('handles missing data provider gracefully', async () => {
    engine = new ReportingEngine();
    const report = await engine.generate('shift-summary', 0, Date.now());
    expect(report).not.toBeNull();
    // Sections should have error messages
    expect(report!.sections.some((s) => typeof s.content === 'string' && s.content.includes('No data provider'))).toBe(true);
  });
});
