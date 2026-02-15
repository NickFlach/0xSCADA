/**
 * Agent-Driven Alarm Correlation Engine
 * ADR-0013 [13.2] — Reduce alarm fatigue through intelligent grouping and root cause analysis
 */

export interface RawAlarm {
  id: string;
  tagId: string;
  equipmentId: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  timestamp: number;
  value?: number;
}

export interface CorrelationRule {
  id: string;
  name: string;
  type: 'temporal' | 'causal' | 'hierarchy';
  config: Record<string, unknown>;
}

export interface AlarmGroup {
  id: string;
  rootCause: RawAlarm | null;
  alarms: RawAlarm[];
  rule: string; // rule ID that created this group
  suppressedCount: number;
  timestamp: number;
}

export interface EquipmentTopology {
  equipmentId: string;
  parentId: string | null;
  children: string[];
  causalDownstream: string[]; // equipment affected if this fails
}

export class AlarmCorrelator {
  private rules: Map<string, CorrelationRule> = new Map();
  private topology: Map<string, EquipmentTopology> = new Map();
  private groups: AlarmGroup[] = [];
  private pendingAlarms: RawAlarm[] = [];
  private groupCounter = 0;
  private temporalWindowMs: number;

  constructor(temporalWindowMs = 5000) {
    this.temporalWindowMs = temporalWindowMs;
  }

  // ── Topology ──────────────────────────────────────────────────

  addEquipment(equip: EquipmentTopology): void {
    this.topology.set(equip.equipmentId, equip);
  }

  getTopology(equipmentId: string): EquipmentTopology | undefined {
    return this.topology.get(equipmentId);
  }

  // ── Rules ─────────────────────────────────────────────────────

  addRule(rule: CorrelationRule): void {
    this.rules.set(rule.id, rule);
  }

  removeRule(ruleId: string): boolean {
    return this.rules.delete(ruleId);
  }

  // ── Alarm Ingestion ───────────────────────────────────────────

  ingestAlarm(alarm: RawAlarm): AlarmGroup | null {
    this.pendingAlarms.push(alarm);

    // Try to correlate with existing groups
    for (const group of this.groups) {
      if (this.shouldCorrelate(alarm, group)) {
        group.alarms.push(alarm);
        group.suppressedCount++;
        return group;
      }
    }

    // Try temporal correlation with pending alarms
    const temporalPeers = this.findTemporalPeers(alarm);
    if (temporalPeers.length > 0) {
      const allAlarms = [alarm, ...temporalPeers];
      const rootCause = this.findRootCause(allAlarms);
      const group = this.createGroup(allAlarms, rootCause, 'temporal-proximity');
      return group;
    }

    // Try causal correlation
    const causalGroup = this.tryCausalCorrelation(alarm);
    if (causalGroup) return causalGroup;

    return null;
  }

  processWindow(): AlarmGroup[] {
    const now = Date.now();
    const newGroups: AlarmGroup[] = [];

    // Group remaining pending alarms by temporal proximity
    const unprocessed = this.pendingAlarms.filter(
      (a) => !this.groups.some((g) => g.alarms.includes(a))
    );

    const clusters = this.clusterByTime(unprocessed);
    for (const cluster of clusters) {
      if (cluster.length > 1) {
        const rootCause = this.findRootCause(cluster);
        const group = this.createGroup(cluster, rootCause, 'temporal-window');
        newGroups.push(group);
      }
    }

    // Clean old pending alarms
    this.pendingAlarms = this.pendingAlarms.filter(
      (a) => now - a.timestamp < this.temporalWindowMs * 2
    );

    return newGroups;
  }

  // ── Correlation Logic ─────────────────────────────────────────

  private shouldCorrelate(alarm: RawAlarm, group: AlarmGroup): boolean {
    const latest = group.alarms[group.alarms.length - 1];
    if (!latest) return false;

    // Temporal proximity
    if (Math.abs(alarm.timestamp - latest.timestamp) > this.temporalWindowMs) return false;

    // Same equipment hierarchy
    if (this.areRelated(alarm.equipmentId, latest.equipmentId)) return true;

    // Causal downstream
    if (this.isCausallyRelated(alarm.equipmentId, group.rootCause?.equipmentId ?? '')) return true;

    return false;
  }

  private findTemporalPeers(alarm: RawAlarm): RawAlarm[] {
    return this.pendingAlarms.filter(
      (a) =>
        a.id !== alarm.id &&
        Math.abs(a.timestamp - alarm.timestamp) <= this.temporalWindowMs &&
        !this.groups.some((g) => g.alarms.includes(a))
    );
  }

  private tryCausalCorrelation(alarm: RawAlarm): AlarmGroup | null {
    const topo = this.topology.get(alarm.equipmentId);
    if (!topo) return null;

    // Check if this alarm is downstream of an existing group's root cause
    for (const group of this.groups) {
      if (!group.rootCause) continue;
      const rootTopo = this.topology.get(group.rootCause.equipmentId);
      if (rootTopo?.causalDownstream.includes(alarm.equipmentId)) {
        group.alarms.push(alarm);
        group.suppressedCount++;
        return group;
      }
    }

    return null;
  }

  private areRelated(equipA: string, equipB: string): boolean {
    if (equipA === equipB) return true;
    const topoA = this.topology.get(equipA);
    const topoB = this.topology.get(equipB);
    if (!topoA || !topoB) return false;

    // Same parent
    if (topoA.parentId && topoA.parentId === topoB.parentId) return true;
    // Parent-child
    if (topoA.parentId === equipB || topoB.parentId === equipA) return true;

    return false;
  }

  private isCausallyRelated(downstream: string, upstream: string): boolean {
    const topo = this.topology.get(upstream);
    return topo?.causalDownstream.includes(downstream) ?? false;
  }

  findRootCause(alarms: RawAlarm[]): RawAlarm | null {
    if (alarms.length === 0) return null;

    // Strategy: earliest alarm in the highest-level equipment is likely root cause
    const sorted = [...alarms].sort((a, b) => {
      // Prefer earlier timestamps
      const timeDiff = a.timestamp - b.timestamp;
      if (Math.abs(timeDiff) > 100) return timeDiff;

      // Prefer higher-level equipment (fewer ancestors)
      const depthA = this.getDepth(a.equipmentId);
      const depthB = this.getDepth(b.equipmentId);
      return depthA - depthB;
    });

    return sorted[0];
  }

  private getDepth(equipmentId: string): number {
    let depth = 0;
    let current = this.topology.get(equipmentId);
    while (current?.parentId) {
      depth++;
      current = this.topology.get(current.parentId);
    }
    return depth;
  }

  private clusterByTime(alarms: RawAlarm[]): RawAlarm[][] {
    if (alarms.length === 0) return [];
    const sorted = [...alarms].sort((a, b) => a.timestamp - b.timestamp);
    const clusters: RawAlarm[][] = [[sorted[0]]];

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const lastCluster = clusters[clusters.length - 1];
      const lastAlarm = lastCluster[lastCluster.length - 1];

      if (current.timestamp - lastAlarm.timestamp <= this.temporalWindowMs) {
        lastCluster.push(current);
      } else {
        clusters.push([current]);
      }
    }

    return clusters;
  }

  private createGroup(
    alarms: RawAlarm[],
    rootCause: RawAlarm | null,
    ruleName: string
  ): AlarmGroup {
    const group: AlarmGroup = {
      id: `AG-${++this.groupCounter}`,
      rootCause,
      alarms: [...alarms],
      rule: ruleName,
      suppressedCount: alarms.length - 1,
      timestamp: Math.min(...alarms.map((a) => a.timestamp)),
    };
    this.groups.push(group);
    return group;
  }

  // ── Accessors ─────────────────────────────────────────────────

  getGroups(): AlarmGroup[] {
    return [...this.groups];
  }

  getActiveGroups(): AlarmGroup[] {
    const cutoff = Date.now() - 60_000 * 30; // last 30 minutes
    return this.groups.filter((g) => g.timestamp > cutoff);
  }

  clearGroups(): void {
    this.groups = [];
    this.groupCounter = 0;
  }

  getSuppressionRate(): number {
    const totalAlarms = this.groups.reduce((sum, g) => sum + g.alarms.length, 0);
    const totalSuppressed = this.groups.reduce((sum, g) => sum + g.suppressedCount, 0);
    return totalAlarms === 0 ? 0 : totalSuppressed / totalAlarms;
  }
}
