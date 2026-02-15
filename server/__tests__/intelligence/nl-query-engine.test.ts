import { describe, it, expect } from 'vitest';
import { parseIntent, SimpleTagResolver, NLQueryEngine } from '../../intelligence/nl-query-engine';

describe('NL Query Engine', () => {
  describe('parseIntent', () => {
    it('parses read_tag intents', () => {
      const intent = parseIntent("What's the pressure in tank 3?");
      expect(intent.type).toBe('read_tag');
      expect(intent.tags.length).toBeGreaterThan(0);
    });

    it('parses compare intents', () => {
      const intent = parseIntent('Compare temperature and pressure');
      expect(intent.type).toBe('compare');
      expect(intent.tags.length).toBe(2);
    });

    it('parses trend intents', () => {
      const intent = parseIntent('Trend of flow rate last 2 hours');
      expect(intent.type).toBe('trend');
      expect(intent.timeRange).toBeDefined();
    });

    it('parses alarm queries', () => {
      const intent = parseIntent('Any active alarms on pump 1?');
      expect(intent.type).toBe('alarm');
    });

    it('returns unknown for unrecognized queries', () => {
      const intent = parseIntent('Hello world');
      expect(intent.type).toBe('unknown');
    });
  });

  describe('SimpleTagResolver', () => {
    it('resolves aliases', () => {
      const resolver = new SimpleTagResolver();
      resolver.registerTag('TANK3.PRESSURE', 'pressure in tank 3', 'tank 3 pressure');
      expect(resolver.resolve('tank 3 pressure')).toBe('TANK3.PRESSURE');
    });

    it('searches tags', () => {
      const resolver = new SimpleTagResolver();
      resolver.registerTag('TANK3.PRESSURE', 'tank 3 pressure');
      resolver.registerTag('TANK3.LEVEL', 'tank 3 level');
      const results = resolver.search('tank');
      expect(results.length).toBe(2);
    });
  });

  describe('NLQueryEngine', () => {
    it('queries with data source', async () => {
      const resolver = new SimpleTagResolver();
      resolver.registerTag('T3.PRESS', 'tank_3.pressure');

      const engine = new NLQueryEngine(resolver);
      engine.setDataSource({
        readTag: async (tagId) => ({ value: 42, timestamp: Date.now(), unit: 'PSI' }),
        readHistory: async () => [],
      });

      const result = await engine.query("What's the pressure in tank 3?");
      expect(result.success).toBe(true);
      expect(result.naturalResponse).toContain('42');
    });

    it('handles missing data source', async () => {
      const resolver = new SimpleTagResolver();
      const engine = new NLQueryEngine(resolver);

      const result = await engine.query('What is the temperature?');
      expect(result.success).toBe(false);
      expect(result.naturalResponse).toContain('No data source');
    });
  });
});
