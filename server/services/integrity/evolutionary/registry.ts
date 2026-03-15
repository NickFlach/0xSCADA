/**
 * Primitive Registry — manages available resolution primitives
 *
 * @see ADR-0023
 * @closes #380 (partial)
 */

import type { ResolutionPrimitive } from './primitives';
import { BUILTIN_PRIMITIVES } from './primitives';

export class PrimitiveRegistry {
  private primitives: Map<string, ResolutionPrimitive> = new Map();

  constructor(loadBuiltins = true) {
    if (loadBuiltins) {
      for (const p of BUILTIN_PRIMITIVES) {
        this.primitives.set(p.id, p);
      }
    }
  }

  add(primitive: ResolutionPrimitive): void {
    this.primitives.set(primitive.id, primitive);
  }

  remove(id: string): boolean {
    return this.primitives.delete(id);
  }

  get(id: string): ResolutionPrimitive | undefined {
    return this.primitives.get(id);
  }

  list(): ResolutionPrimitive[] {
    return Array.from(this.primitives.values());
  }

  has(id: string): boolean {
    return this.primitives.has(id);
  }

  /** Get the internal map for genome evaluation */
  getMap(): Map<string, ResolutionPrimitive> {
    return this.primitives;
  }
}
