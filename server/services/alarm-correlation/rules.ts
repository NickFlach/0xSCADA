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

const MAX_RULE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TOPOLOGY_DISTANCE = 64;
const DEFAULT_MAX_RULES = 1000;

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
  if (!rule.id || rule.id.length > 128) {
    return 'id must contain 1..128 characters';
  }
  if (!rule.name || rule.name.length > 256) {
    return 'name must contain 1..256 characters';
  }
  if (typeof rule.enabled !== 'boolean') {
    return 'enabled must be a boolean';
  }
  if (!Number.isSafeInteger(rule.priority) || rule.priority < 0 || rule.priority > 10_000) {
    return 'priority must be an integer between 0 and 10000';
  }
  if (
    !Number.isSafeInteger(cfg.windowMs)
    || (cfg.windowMs as number) < 1
    || (cfg.windowMs as number) > MAX_RULE_WINDOW_MS
  ) {
    return `config.windowMs must be an integer between 1 and ${MAX_RULE_WINDOW_MS}`;
  }
  switch (rule.type) {
    case 'causal':
      if (
        !Number.isSafeInteger(cfg.maxHops)
        || (cfg.maxHops as number) < 1
        || (cfg.maxHops as number) > MAX_TOPOLOGY_DISTANCE
      ) {
        return `causal rule requires integer config.maxHops between 1 and ${MAX_TOPOLOGY_DISTANCE}`;
      }
      return null;
    case 'hierarchy':
      if (
        !Number.isSafeInteger(cfg.maxDistance)
        || (cfg.maxDistance as number) < 1
        || (cfg.maxDistance as number) > MAX_TOPOLOGY_DISTANCE
      ) {
        return `hierarchy rule requires integer config.maxDistance between 1 and ${MAX_TOPOLOGY_DISTANCE}`;
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
  private readonly maxRules: number;

  constructor(initial: CorrelationRule[] = DEFAULT_RULES, maxRules = DEFAULT_MAX_RULES) {
    if (!Number.isSafeInteger(maxRules) || maxRules < initial.length) {
      throw new Error('maxRules must be an integer at least as large as the initial rule set');
    }
    this.maxRules = maxRules;
    for (const rule of initial) {
      const error = validateRule(rule);
      if (error) throw new Error(`Invalid rule "${rule.id}": ${error}`);
      this.rules.set(rule.id, this.cloneRule(rule));
    }
  }

  list(): CorrelationRule[] {
    return Array.from(this.rules.values(), (rule) => this.cloneRule(rule))
      .sort((a, b) => a.priority - b.priority);
  }

  get(id: string): CorrelationRule | undefined {
    const rule = this.rules.get(id);
    return rule ? this.cloneRule(rule) : undefined;
  }

  upsert(rule: CorrelationRule): CorrelationRule {
    const error = validateRule(rule);
    if (error) throw new Error(`Invalid rule "${rule.id}": ${error}`);
    if (!this.rules.has(rule.id) && this.rules.size >= this.maxRules) {
      throw new Error(`Rule limit of ${this.maxRules} reached`);
    }
    const stored = this.cloneRule(rule);
    this.rules.set(rule.id, stored);
    return this.cloneRule(stored);
  }

  remove(id: string): boolean {
    return this.rules.delete(id);
  }

  setEnabled(id: string, enabled: boolean): CorrelationRule | undefined {
    const rule = this.rules.get(id);
    if (!rule) return undefined;
    rule.enabled = enabled;
    return this.cloneRule(rule);
  }

  private enabledRules(): CorrelationRule[] {
    return this.list().filter((r) => r.enabled);
  }

  /**
   * First enabled rule (by priority) under which `alarm` belongs in `group`.
   * A group has connected-component semantics: matching any member is enough
   * to join. Every rule window is evaluated pairwise, which permits a bounded
   * causal/chatter chain without making its endpoints directly related.
   */
  evaluateJoin(
    alarm: CorrelatedAlarm,
    group: AlarmGroup,
    topology: EquipmentTopology
  ): CorrelationRule | null {
    for (const rule of this.enabledRules()) {
      if (
        group.alarms.some((member) =>
          this.matchesRulePair(rule, alarm, member, topology)
        )
      ) {
        return rule;
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
      if (this.matchesRulePair(rule, alarm, other, topology)) return rule;
    }
    return null;
  }

  private matchesRulePair(
    rule: CorrelationRule,
    alarm: CorrelatedAlarm,
    other: CorrelatedAlarm,
    topology: EquipmentTopology,
  ): boolean {
    if (!this.siteCompatible(alarm, other)) return false;
    const windowMs = (rule.config as { windowMs: number }).windowMs;
    if (Math.abs(alarm.timestamp - other.timestamp) > windowMs) return false;

    switch (rule.type) {
      case 'causal': {
        const { maxHops } = rule.config as CausalRuleConfig;
        return !!(
          alarm.equipmentId
          && other.equipmentId
          && topology.isCausallyRelated(alarm.equipmentId, other.equipmentId, maxHops)
        );
      }
      case 'hierarchy': {
        const { maxDistance } = rule.config as HierarchyRuleConfig;
        return !!(
          alarm.equipmentId
          && other.equipmentId
          && topology.isHierarchyRelated(alarm.equipmentId, other.equipmentId, maxDistance)
        );
      }
      case 'temporal':
        return this.temporalScopeMatches(
          rule.config as TemporalRuleConfig,
          alarm,
          other,
        );
    }
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

  /**
   * Never correlate across explicit site boundaries. Missing site metadata
   * is compatible only with another unscoped alarm; it must not silently
   * inherit a named site's topology or process-area namespace.
   */
  private siteCompatible(a: CorrelatedAlarm, b: CorrelatedAlarm): boolean {
    return a.siteId === b.siteId;
  }

  private cloneRule(rule: CorrelationRule): CorrelationRule {
    return {
      ...rule,
      config: { ...rule.config },
    };
  }
}
