import { describe, it, expect } from 'vitest';
import { AlarmCorrelator, type RawAlarm } from '../../intelligence/alarm-correlator';

function makeAlarm(id: string, equipId: string, ts: number): RawAlarm {
  return { id, tagId: `tag-${id}`, equipmentId: equipId, severity: 'high', message: `Alarm ${id}`, timestamp: ts };
}

describe('AlarmCorrelator', () => {
  it('groups temporally close alarms', () => {
    const correlator = new AlarmCorrelator(5000);
    correlator.addEquipment({ equipmentId: 'pump-1', parentId: 'area-1', children: [], causalDownstream: ['valve-1'] });
    correlator.addEquipment({ equipmentId: 'valve-1', parentId: 'area-1', children: [], causalDownstream: [] });

    const a1 = makeAlarm('1', 'pump-1', 1000);
    const a2 = makeAlarm('2', 'valve-1', 2000);

    correlator.ingestAlarm(a1);
    const group = correlator.ingestAlarm(a2);

    expect(group).not.toBeNull();
    expect(group!.alarms.length).toBe(2);
  });

  it('identifies root cause as earliest/highest alarm', () => {
    const correlator = new AlarmCorrelator();
    correlator.addEquipment({ equipmentId: 'area-1', parentId: null, children: ['pump-1'], causalDownstream: ['pump-1'] });
    correlator.addEquipment({ equipmentId: 'pump-1', parentId: 'area-1', children: [], causalDownstream: [] });

    const alarms = [makeAlarm('1', 'area-1', 1000), makeAlarm('2', 'pump-1', 1100)];
    const root = correlator.findRootCause(alarms);
    expect(root?.equipmentId).toBe('area-1');
  });

  it('tracks suppression rate', () => {
    const correlator = new AlarmCorrelator(5000);
    correlator.addEquipment({ equipmentId: 'e1', parentId: 'p', children: [], causalDownstream: [] });
    correlator.addEquipment({ equipmentId: 'e2', parentId: 'p', children: [], causalDownstream: [] });

    correlator.ingestAlarm(makeAlarm('1', 'e1', 1000));
    correlator.ingestAlarm(makeAlarm('2', 'e2', 1500));

    const rate = correlator.getSuppressionRate();
    expect(rate).toBeGreaterThanOrEqual(0);
  });

  it('does not group distant alarms', () => {
    const correlator = new AlarmCorrelator(1000);
    const group = correlator.ingestAlarm(makeAlarm('1', 'x', 1000));
    expect(group).toBeNull();

    const group2 = correlator.ingestAlarm(makeAlarm('2', 'y', 100000));
    expect(group2).toBeNull();
  });
});
