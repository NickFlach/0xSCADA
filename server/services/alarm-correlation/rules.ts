/**
 * Correlation Rules Engine
 * ADR-0013 [13.2] — Issue #213
 *
 * Rules are evaluated in priority order (lower first) to decide whether an
 * alarm joins an existing group or pairs with another alarm to form one.
 * Every stored rule is actually evaluated — a rule that matches nothing is
 * an authoring problem, not dead machinery.
 *
 * Bare temporal proximity across unrelated equipment never correlates:
 * temporal rules require an explicit scope (same tag, same equipment, or
 * shared process area); cross-equipment grouping requires causal or
 * hierarchy evidence from the topology.
 */

import type {
  AlarmGroup,
  CausalRuleConfig,
  CorrelatedAlarm,
  CorrelationRule,
  HierarchyRuleConfig,
  TemporalRuleConfig,
} from '@shared/types/alarm-correlation';
import type { EquipmentTopology } from './topology';

export const DEFAULT_RULES: CorrelationRule[] = [
  {
    id: 'default-causal',
    name: 'Causal chain (topology causalDownstream, transitive)',
    type: 'causal',
    enabled: true,
    priority: 10,
    config: { windowMs: 30_000, maxHops: 5 } satisfies CausalRuleConfig,
  },
  {
    id: 'default-hierarchy',
    name: 'Equipment hierarchy (common ancestor)',
    type: 'hierarchy',
    enabled: true,
    priority: 20,
    config: { windowMs: 10_000, maxDistance: 2 } satisfies HierarchyRuleConfig,
  },
  {
    id: 'default-tag-chatter',
    name: 'Same-tag chatter',
    type: 'temporal',
    enabled: true,
    priority: 30,
    config: { windowMs: 5_000, scope: 'same-tag' } satisfies TemporalRuleConfig,
  },
  {
    id: 'default-equipment-burst',
    name: 'Same-equipment burst',
    type: 'temporal',
    enabled: true,
    priority: 40,
    config: { windowMs: 5_000, scope: 'same-equipment' } satisfies TemporalRuleConfig,
  },
];

export function validateRule(rule: CorrelationRule): string | null {
  const cfg = rule.config as unknown as Record<string, unknown>;
  if (typeof cfg.windowMs !== 'number' || cfg.windowMs <= 0) {
    return 'config.windowMs must be a positive number';
  }
  switch (rule.type) {
    case 'causal':
      if (typeof cfg.maxHops !== 'number' || cfg.maxHops < 1) {
        return 'causal rule requires config.maxHops >= 1';
      }
      return null;
    case 'hierarchy':
      if (typeof cfg.maxDistance !== 'number' || cfg.maxDistance < 1) {
        return 'hierarchy rule requires config.maxDistance >= 1';
      }
      return null;
    case 'temporal':
      if (!['same-tag', 'same-equipment', 'process-area'].includes(cfg.scope as string)) {
        return "temporal rule requires config.scope of 'same-tag' | 'same-equipment' | 'process-area'";
      }
      return null;
    default:
      return `unknown rule type "${(rule as CorrelationRule).type}"`;
  }
}

export class CorrelationRulesEngine {
  private rules: Map<string, CorrelationRule> = new Map();

  constructor(initial: CorrelationRule[] = DEFAULT_RULES) {
    for (const rule of initial) this.rules.set(rule.id, { ...rule });
  }

  list(): CorrelationRule[] {
    return Array.from(this.rules.values()).sort((a, b) => a.priority - b.priority);
  }

  get(id: string): CorrelationRule | undefined {
    return this.rules.get(id);
  }

  upsert(rule: CorrelationRule): CorrelationRule {
    const error = validateRule(rule);
    if (error) throw new Error(`Invalid rule "${rule.id}": ${error}`);
    this.rules.set(rule.id, { ...rule });
    return rule;
  }

  remove(id: string): boolean {
    return this.rules.delete(id);
  }

  setEnabled(id: string, enabled: boolean): CorrelationRule | undefined {
    const rule = this.rules.get(id);
    if (!rule) return undefined;
    rule.enabled = enabled;
    return rule;
  }

  private enabledRules(): CorrelationRule[] {
    return this.list().filter((r) => r.enabled);
  }

  /**
   * First enabled rule (by priority) under which `alarm` belongs in `group`.
   * The temporal window anchors to the group's latest alarm; relatedness
   * anchors to the root cause (hierarchy/temporal scopes) or any member
   * (causal — chains propagate through intermediate members, and checking
   * both directions admits an upstream cause that arrives late).
   */
  evaluateJoin(
    alarm: CorrelatedAlarm,
    group: AlarmGroup,
    topology: EquipmentTopology
  ): CorrelationRule | null {
    const root = group.alarms.find((a) => a.id === group.rootCauseAlarmId);
    for (const rule of this.enabledRules()) {
      const windowMs = (rule.config as { windowMs: number }).windowMs;
      if (Math.abs(alarm.timestamp - group.lastAlarmAt) > windowMs) continue;

      switch (rule.type) {
        case 'causal': {
          const { maxHops } = rule.config as CausalRuleConfig;
          if (!alarm.equipmentId) break;
          const related = group.alarms.some(
            (member) =>
              member.equipmentId &&
              topology.isCausallyRelated(alarm.equipmentId!, member.equipmentId, maxHops)
          );
          if (related) return rule;
          break;
        }
        case 'hierarchy': {
          const { maxDistance } = rule.config as HierarchyRuleConfig;
          if (!alarm.equipmentId || !root?.equipmentId) break;
          if (topology.isHierarchyRelated(alarm.equipmentId, root.equipmentId, maxDistance)) {
            return rule;
          }
          break;
        }
        case 'temporal': {
          if (root && this.temporalScopeMatches(rule.config as TemporalRuleConfig, alarm, root)) {
            return rule;
          }
          break;
        }
      }
    }
    return null;
  }

  /**
   * First enabled rule under which two ungrouped alarms belong together —
   * used to form a new group.
   */
  evaluatePair(
    alarm: CorrelatedAlarm,
    other: CorrelatedAlarm,
    topology: EquipmentTopology
  ): CorrelationRule | null {
    for (const rule of this.enabledRules()) {
      const windowMs = (rule.config as { windowMs: number }).windowMs;
      if (Math.abs(alarm.timestamp - other.timestamp) > windowMs) continue;

      switch (rule.type) {
        case 'causal': {
          const { maxHops } = rule.config as CausalRuleConfig;
          if (
            alarm.equipmentId &&
            other.equipmentId &&
            topology.isCausallyRelated(alarm.equipmentId, other.equipmentId, maxHops)
          ) {
            return rule;
          }
          break;
        }
        case 'hierarchy': {
          const { maxDistance } = rule.config as HierarchyRuleConfig;
          if (
            alarm.equipmentId &&
            other.equipmentId &&
            topology.isHierarchyRelated(alarm.equipmentId, other.equipmentId, maxDistance)
          ) {
            return rule;
          }
          break;
        }
        case 'temporal': {
          if (this.temporalScopeMatches(rule.config as TemporalRuleConfig, alarm, other)) {
            return rule;
          }
          break;
        }
      }
    }
    return null;
  }

  private temporalScopeMatches(
    config: TemporalRuleConfig,
    a: CorrelatedAlarm,
    b: CorrelatedAlarm
  ): boolean {
    switch (config.scope) {
      case 'same-tag':
        return a.tagId !== '' && a.tagId === b.tagId;
      case 'same-equipment':
        return !!a.equipmentId && a.equipmentId === b.equipmentId;
      case 'process-area':
        return !!a.processArea && a.processArea === b.processArea;
    }
  }
}
