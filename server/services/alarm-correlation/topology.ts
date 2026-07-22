/**
 * Equipment Topology Graph
 * ADR-0013 [13.2] — Issue #213
 *
 * Two edge sets per node: an acyclic containment hierarchy (parentId) and
 * directed causal edges (causalDownstream). Hierarchy cycles are rejected
 * at registration; causal traversal is cycle-safe because recirculation
 * loops legitimately exist in real processes.
 */

import type { EquipmentNode } from '@shared/types/alarm-correlation';

const MAX_TRAVERSAL_DEPTH = 64;

export class EquipmentTopology {
  private nodes: Map<string, EquipmentNode> = new Map();

  /**
   * Insert or replace a node. Throws if the parent chain would form a
   * cycle. Parents and causal targets need not exist yet — topology can
   * be registered incrementally.
   */
  upsert(node: EquipmentNode): EquipmentNode {
    const previous = this.nodes.get(node.equipmentId);
    const stored: EquipmentNode = {
      ...node,
      causalDownstream: [...new Set(node.causalDownstream)].filter(
        (id) => id !== node.equipmentId
      ),
    };
    this.nodes.set(node.equipmentId, stored);

    if (this.hasParentCycle(node.equipmentId)) {
      if (previous) {
        this.nodes.set(node.equipmentId, previous);
      } else {
        this.nodes.delete(node.equipmentId);
      }
      throw new Error(
        `Equipment "${node.equipmentId}": parentId "${node.parentId}" would create a hierarchy cycle`
      );
    }
    return stored;
  }

  upsertMany(nodes: EquipmentNode[]): EquipmentNode[] {
    return nodes.map((n) => this.upsert(n));
  }

  get(equipmentId: string): EquipmentNode | undefined {
    return this.nodes.get(equipmentId);
  }

  list(): EquipmentNode[] {
    return Array.from(this.nodes.values());
  }

  remove(equipmentId: string): boolean {
    return this.nodes.delete(equipmentId);
  }

  size(): number {
    return this.nodes.size;
  }

  /** Depth from the hierarchy root (root = 0). Unknown nodes are depth 0. */
  depth(equipmentId: string): number {
    let depth = 0;
    let current = this.nodes.get(equipmentId);
    const visited = new Set<string>([equipmentId]);
    while (current?.parentId && depth < MAX_TRAVERSAL_DEPTH) {
      if (visited.has(current.parentId)) break;
      visited.add(current.parentId);
      depth++;
      current = this.nodes.get(current.parentId);
    }
    return depth;
  }

  /**
   * Hierarchy relatedness: steps to the nearest common ancestor, counted
   * from the deeper side (so parent↔child = 1, siblings = 1, cousins = 2).
   * Returns null when the nodes share no ancestor.
   */
  hierarchyDistance(a: string, b: string): number | null {
    if (a === b) return 0;
    const ancestorsA = this.ancestorDepths(a);
    const ancestorsB = this.ancestorDepths(b);
    let best: number | null = null;
    for (const [ancestor, da] of ancestorsA) {
      const db = ancestorsB.get(ancestor);
      if (db !== undefined) {
        const distance = Math.max(da, db);
        if (best === null || distance < best) best = distance;
      }
    }
    return best;
  }

  isHierarchyRelated(a: string, b: string, maxDistance: number): boolean {
    const distance = this.hierarchyDistance(a, b);
    return distance !== null && distance <= maxDistance;
  }

  /**
   * Transitive causal reachability over causalDownstream edges (BFS with
   * visited-set cycle guard, bounded hops).
   */
  isCausallyReachable(from: string, to: string, maxHops: number): boolean {
    if (from === to) return false;
    if (!this.nodes.has(from)) return false;

    let frontier = [from];
    const visited = new Set<string>([from]);
    for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const target of this.nodes.get(id)?.causalDownstream ?? []) {
          if (target === to) return true;
          if (!visited.has(target)) {
            visited.add(target);
            next.push(target);
          }
        }
      }
      frontier = next;
    }
    return false;
  }

  /** Causal relatedness in either direction — handles out-of-order arrival */
  isCausallyRelated(a: string, b: string, maxHops: number): boolean {
    return (
      this.isCausallyReachable(a, b, maxHops) || this.isCausallyReachable(b, a, maxHops)
    );
  }

  /** How many of `others` this node causally reaches — root-cause dominance */
  causalDominance(candidate: string, others: string[], maxHops: number): number {
    let count = 0;
    for (const other of others) {
      if (other !== candidate && this.isCausallyReachable(candidate, other, maxHops)) {
        count++;
      }
    }
    return count;
  }

  // ── Private ──────────────────────────────────────────────────────────

  /** Map of ancestor id → steps up from the given node (self = 0) */
  private ancestorDepths(equipmentId: string): Map<string, number> {
    const result = new Map<string, number>();
    let current = this.nodes.get(equipmentId);
    let steps = 0;
    result.set(equipmentId, 0);
    while (current?.parentId && steps < MAX_TRAVERSAL_DEPTH) {
      if (result.has(current.parentId)) break;
      steps++;
      result.set(current.parentId, steps);
      current = this.nodes.get(current.parentId);
    }
    return result;
  }

  private hasParentCycle(startId: string): boolean {
    const visited = new Set<string>();
    let current = this.nodes.get(startId);
    while (current?.parentId) {
      if (visited.has(current.equipmentId)) return true;
      visited.add(current.equipmentId);
      if (current.parentId === startId) return true;
      current = this.nodes.get(current.parentId);
    }
    return false;
  }
}
