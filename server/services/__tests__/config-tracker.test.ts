import { ConfigTracker, ConfigScope } from '../config-tracker';
import { AuditLogger } from '../audit-logger';

describe('ConfigTracker', () => {
  let tracker: ConfigTracker;

  beforeEach(() => {
    const auditLogger = new AuditLogger('test-key');
    tracker = new ConfigTracker(auditLogger);
  });

  it('should track a config change', () => {
    const snapshot = tracker.trackChange({
      scope: ConfigScope.GATEWAY,
      key: 'opcua.endpoint',
      newValue: 'opc.tcp://localhost:4840',
      changedBy: 'u1',
      username: 'eng1',
      changeReason: 'Updated endpoint',
    });

    expect(snapshot.previousValue).toBeNull();
    expect(snapshot.newValue).toBe('opc.tcp://localhost:4840');
  });

  it('should capture before/after snapshots', () => {
    tracker.trackChange({ scope: ConfigScope.SYSTEM, key: 'scan.rate', newValue: 100, changedBy: 'u1', username: 'eng1', changeReason: 'Initial' });
    const s2 = tracker.trackChange({ scope: ConfigScope.SYSTEM, key: 'scan.rate', newValue: 200, changedBy: 'u1', username: 'eng1', changeReason: 'Faster' });

    expect(s2.previousValue).toBe(100);
    expect(s2.newValue).toBe(200);
  });

  it('should get history by scope', () => {
    tracker.trackChange({ scope: ConfigScope.GATEWAY, key: 'a', newValue: 1, changedBy: 'u1', username: 'u1', changeReason: 'r' });
    tracker.trackChange({ scope: ConfigScope.SYSTEM, key: 'b', newValue: 2, changedBy: 'u1', username: 'u1', changeReason: 'r' });

    expect(tracker.getChangesByScope(ConfigScope.GATEWAY)).toHaveLength(1);
  });

  it('should get current value', () => {
    tracker.trackChange({ scope: ConfigScope.TAG, key: 'scaling', newValue: 1.5, changedBy: 'u1', username: 'u1', changeReason: 'r' });
    expect(tracker.getCurrentValue(ConfigScope.TAG, 'scaling')).toBe(1.5);
  });
});
