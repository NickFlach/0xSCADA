import { describe, it, expect, afterEach } from 'vitest';
import { FederationManager } from '../../federation/federation-manager';
import type { FederationSite } from '../../../shared/types/federation';

function makeSite(id: string): FederationSite {
  return {
    siteId: id, name: `Site ${id}`, endpoint: `https://${id}.example.com`,
    publicKey: 'key', status: 'online', lastHeartbeat: Date.now(),
    version: '1.0.0', capabilities: ['tags', 'alarms'], tagNamespace: id, metadata: {},
  };
}

describe('FederationManager', () => {
  let fm: FederationManager;

  afterEach(() => fm?.shutdown());

  it('should register and retrieve sites', () => {
    fm = new FederationManager();
    fm.registerSite(makeSite('alpha'));
    expect(fm.getSite('alpha')).toBeDefined();
    expect(fm.getAllSites()).toHaveLength(1);
  });

  it('should parse tag references', () => {
    fm = new FederationManager();
    const ref = fm.parseTagRef('alpha:area1/temp-sensor');
    expect(ref).toEqual({
      siteId: 'alpha', area: 'area1', tagName: 'temp-sensor',
      canonical: 'alpha:area1/temp-sensor',
    });
  });

  it('should resolve tags to sites', () => {
    fm = new FederationManager();
    fm.registerSite(makeSite('alpha'));
    const result = fm.resolveTag('alpha:area1/sensor');
    expect(result?.site.siteId).toBe('alpha');
  });

  it('should not resolve offline site tags', () => {
    fm = new FederationManager();
    const site = makeSite('beta');
    site.status = 'offline';
    fm.registerSite(site);
    expect(fm.resolveTag('beta:area/tag')).toBeNull();
  });

  it('should report metrics', () => {
    fm = new FederationManager();
    fm.registerSite(makeSite('a'));
    fm.registerSite(makeSite('b'));
    const metrics = fm.getMetrics();
    expect(metrics.connectedSites).toBe(2);
  });
});
