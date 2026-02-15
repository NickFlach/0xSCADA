import { PrometheusRegistry, createSCADAMetrics } from '../prometheus-exporter';

describe('PrometheusRegistry', () => {
  let registry: PrometheusRegistry;

  beforeEach(() => {
    registry = new PrometheusRegistry();
  });

  it('should increment counters', () => {
    registry.incCounter('test_total', { method: 'GET' });
    registry.incCounter('test_total', { method: 'GET' });
    const output = registry.serialize();
    expect(output).toContain('test_total{method="GET"} 2');
  });

  it('should set gauges', () => {
    registry.setGauge('connections', 42);
    const output = registry.serialize();
    expect(output).toContain('connections 42');
  });

  it('should observe histograms', () => {
    registry.observeHistogram('duration', 0.05);
    registry.observeHistogram('duration', 0.5);
    const output = registry.serialize();
    expect(output).toContain('duration_count 2');
    expect(output).toContain('duration_bucket');
  });

  it('should output valid prometheus format', () => {
    registry.incCounter('http_requests_total', { method: 'GET', status: '200' });
    const output = registry.serialize();
    expect(output).toContain('# HELP');
    expect(output).toContain('# TYPE');
    expect(output).toContain('counter');
  });
});

describe('SCADAMetrics', () => {
  it('should track SCADA-specific metrics', () => {
    const { registry, metrics } = createSCADAMetrics();

    metrics.setActiveConnections(5);
    metrics.incTagReads('gw1', 10);
    metrics.incTagWrites('gw1', 3);
    metrics.incAlarmCount('critical');
    metrics.setGatewayConnectionStatus('gw1', true);
    metrics.recordRequestLatency('GET', '/api/tags', 200, 0.05);

    const output = registry.serialize();
    expect(output).toContain('scada_active_connections 5');
    expect(output).toContain('scada_tag_reads_total{gateway="gw1"} 10');
    expect(output).toContain('scada_tag_writes_total{gateway="gw1"} 3');
    expect(output).toContain('scada_alarms_total{severity="critical"} 1');
    expect(output).toContain('scada_gateway_connected{gateway="gw1"} 1');
    expect(output).toContain('scada_http_request_duration_seconds');
  });
});
