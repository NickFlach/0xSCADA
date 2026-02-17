/**
 * Prometheus Metrics Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registry,
  httpRequestsTotal,
  httpRequestDuration,
  eventsTotal,
  blockchainAnchorsTotal,
} from '../prometheus.js';

describe('Prometheus Metrics', () => {
  beforeEach(() => {
    registry.reset();
  });

  describe('Counter', () => {
    it('should increment counter', () => {
      httpRequestsTotal.inc({ method: 'GET', path: '/api/health', status: '200' });
      httpRequestsTotal.inc({ method: 'GET', path: '/api/health', status: '200' });
      
      expect(httpRequestsTotal.get({ method: 'GET', path: '/api/health', status: '200' })).toBe(2);
    });

    it('should handle different label combinations separately', () => {
      httpRequestsTotal.inc({ method: 'GET', path: '/api/sites', status: '200' });
      httpRequestsTotal.inc({ method: 'POST', path: '/api/sites', status: '201' });
      httpRequestsTotal.inc({ method: 'GET', path: '/api/sites', status: '404' });
      
      expect(httpRequestsTotal.get({ method: 'GET', path: '/api/sites', status: '200' })).toBe(1);
      expect(httpRequestsTotal.get({ method: 'POST', path: '/api/sites', status: '201' })).toBe(1);
      expect(httpRequestsTotal.get({ method: 'GET', path: '/api/sites', status: '404' })).toBe(1);
    });

    it('should increment by specified value', () => {
      eventsTotal.inc({ type: 'alarm', severity: 'critical', site_id: '1' }, 5);
      expect(eventsTotal.get({ type: 'alarm', severity: 'critical', site_id: '1' })).toBe(5);
    });
  });

  describe('Gauge', () => {
    it('should set gauge value', () => {
      const gauge = registry.gauge('test_gauge', 'Test gauge');
      gauge.set(42);
      expect(gauge.get()).toBe(42);
    });

    it('should increment and decrement', () => {
      const gauge = registry.gauge('test_gauge_inc', 'Test gauge with inc/dec');
      gauge.set(10);
      gauge.inc();
      expect(gauge.get()).toBe(11);
      gauge.dec();
      expect(gauge.get()).toBe(10);
      gauge.inc({}, 5);
      expect(gauge.get()).toBe(15);
    });

    it('should handle labeled values', () => {
      const gauge = registry.gauge('test_gauge_labels', 'Test gauge with labels', ['site']);
      gauge.set(100, { site: 'site1' });
      gauge.set(200, { site: 'site2' });
      
      expect(gauge.get({ site: 'site1' })).toBe(100);
      expect(gauge.get({ site: 'site2' })).toBe(200);
    });
  });

  describe('Histogram', () => {
    it('should observe values', () => {
      httpRequestDuration.observe(0.05, { method: 'GET', path: '/api/health' });
      httpRequestDuration.observe(0.1, { method: 'GET', path: '/api/health' });
      httpRequestDuration.observe(0.25, { method: 'GET', path: '/api/health' });
      
      const collected = httpRequestDuration.collect();
      expect(collected.length).toBe(1);
      expect(collected[0].count).toBe(3);
      expect(collected[0].sum).toBeCloseTo(0.4, 5);
    });

    it('should populate correct buckets', () => {
      const histogram = registry.histogram(
        'test_histogram',
        'Test histogram',
        [],
        [0.1, 0.5, 1, 5]
      );
      
      histogram.observe(0.05);  // Should go in 0.1 bucket
      histogram.observe(0.3);   // Should go in 0.5 bucket
      histogram.observe(0.7);   // Should go in 1 bucket
      histogram.observe(3);     // Should go in 5 bucket
      histogram.observe(10);    // Should go in +Inf bucket
      
      const collected = histogram.collect()[0];
      expect(collected.buckets.get(0.1)).toBe(1);
      expect(collected.buckets.get(0.5)).toBe(2);
      expect(collected.buckets.get(1)).toBe(3);
      expect(collected.buckets.get(5)).toBe(4);
      expect(collected.buckets.get(Infinity)).toBe(5);
    });
  });

  describe('Registry', () => {
    it('should generate valid Prometheus exposition format', () => {
      httpRequestsTotal.inc({ method: 'GET', path: '/api/health', status: '200' });
      blockchainAnchorsTotal.inc({ status: 'success' });
      
      const output = registry.metrics();
      
      // Check format
      expect(output).toContain('# HELP scada_http_requests_total');
      expect(output).toContain('# TYPE scada_http_requests_total counter');
      expect(output).toContain('scada_http_requests_total{method="GET",path="/api/health",status="200"} 1');
      expect(output).toContain('scada_blockchain_anchors_total{status="success"} 1');
    });

    it('should escape special characters in labels', () => {
      eventsTotal.inc({ type: 'test"quote', severity: 'info\\slash', site_id: '1' });
      
      const output = registry.metrics();
      expect(output).toContain('type="test\\"quote"');
      expect(output).toContain('severity="info\\\\slash"');
    });

    it('should include histogram buckets correctly', () => {
      httpRequestDuration.observe(0.05, { method: 'GET', path: '/test' });
      
      const output = registry.metrics();
      
      expect(output).toContain('scada_http_request_duration_seconds_bucket');
      expect(output).toContain('le="0.05"');
      expect(output).toContain('le="+Inf"');
      expect(output).toContain('scada_http_request_duration_seconds_sum');
      expect(output).toContain('scada_http_request_duration_seconds_count');
    });
  });

  describe('Label Cardinality', () => {
    it('should return consistent metrics with same labels', () => {
      // Same counter reference for same name
      const counter1 = registry.counter('cardinality_test', 'Test cardinality');
      const counter2 = registry.counter('cardinality_test', 'Test cardinality');
      
      counter1.inc();
      counter2.inc();
      
      expect(counter1.get()).toBe(2);
      expect(counter2.get()).toBe(2);
      expect(counter1).toBe(counter2);
    });
  });
});

describe('Metric Types', () => {
  it('should correctly prefix metrics with scada_', () => {
    const output = registry.metrics();
    
    // All custom metrics should have scada_ prefix
    const lines = output.split('\n').filter(l => l.startsWith('scada_'));
    expect(lines.length).toBeGreaterThan(0);
    
    // No metrics without prefix (except comments)
    const metricLines = output.split('\n').filter(l => !l.startsWith('#') && l.trim());
    for (const line of metricLines) {
      expect(line).toMatch(/^scada_/);
    }
  });
});
