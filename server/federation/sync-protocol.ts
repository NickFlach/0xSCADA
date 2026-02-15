/**
 * CRDT Sync Protocol — ADR-0014 [14.3]
 *
 * Conflict-free replicated data types for state merge across sites.
 */

import { EventEmitter } from 'events';
import type { CRDTOperation } from '../../shared/types/federation';

export interface LWWRegister<T> {
  value: T;
  timestamp: number;
  siteId: string;
}

export interface GCounter {
  counts: Record<string, number>;
}

export interface ORSet<T> {
  elements: Map<string, { value: T; timestamp: number; siteId: string }>;
  tombstones: Set<string>;
}

export class CRDTStore extends EventEmitter {
  private registers: Map<string, LWWRegister<unknown>> = new Map();
  private counters: Map<string, GCounter> = new Map();
  private sets: Map<string, ORSet<unknown>> = new Map();
  private operationLog: CRDTOperation[] = [];
  private vectorClock: Record<string, number> = {};
  private siteId: string;

  constructor(siteId: string) {
    super();
    this.siteId = siteId;
    this.vectorClock[siteId] = 0;
  }

  // LWW Register
  setRegister<T>(key: string, value: T): CRDTOperation {
    const timestamp = Date.now();
    const existing = this.registers.get(key);

    if (!existing || timestamp >= existing.timestamp) {
      this.registers.set(key, { value, timestamp, siteId: this.siteId });
    }

    return this.createOp('lww-register', key, value, timestamp);
  }

  getRegister<T>(key: string): T | undefined {
    return this.registers.get(key)?.value as T | undefined;
  }

  // G-Counter
  incrementCounter(key: string, amount = 1): CRDTOperation {
    const counter = this.counters.get(key) ?? { counts: {} };
    counter.counts[this.siteId] = (counter.counts[this.siteId] ?? 0) + amount;
    this.counters.set(key, counter);

    return this.createOp('g-counter', key, amount, Date.now());
  }

  getCounter(key: string): number {
    const counter = this.counters.get(key);
    if (!counter) return 0;
    return Object.values(counter.counts).reduce((sum, v) => sum + v, 0);
  }

  // OR-Set
  addToSet<T>(key: string, value: T): CRDTOperation {
    const set = this.sets.get(key) ?? { elements: new Map(), tombstones: new Set() };
    const elementId = `${this.siteId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    set.elements.set(elementId, { value, timestamp: Date.now(), siteId: this.siteId });
    this.sets.set(key, set);

    return this.createOp('or-set-add', key, { elementId, value }, Date.now());
  }

  removeFromSet(key: string, elementId: string): CRDTOperation {
    const set = this.sets.get(key);
    if (set) {
      set.elements.delete(elementId);
      set.tombstones.add(elementId);
    }

    return this.createOp('or-set-remove', key, elementId, Date.now());
  }

  getSet<T>(key: string): T[] {
    const set = this.sets.get(key);
    if (!set) return [];
    return Array.from(set.elements.values()).map((e) => e.value as T);
  }

  // Merge remote operation
  applyRemoteOp(op: CRDTOperation): void {
    switch (op.type) {
      case 'lww-register': {
        const existing = this.registers.get(op.key);
        if (!existing || op.timestamp > existing.timestamp) {
          this.registers.set(op.key, {
            value: op.value,
            timestamp: op.timestamp,
            siteId: op.siteId,
          });
        }
        break;
      }
      case 'g-counter': {
        const counter = this.counters.get(op.key) ?? { counts: {} };
        const remoteVal = op.value as number;
        counter.counts[op.siteId] = Math.max(counter.counts[op.siteId] ?? 0, (counter.counts[op.siteId] ?? 0) + remoteVal);
        this.counters.set(op.key, counter);
        break;
      }
      case 'or-set-add': {
        const set = this.sets.get(op.key) ?? { elements: new Map(), tombstones: new Set() };
        const { elementId, value } = op.value as { elementId: string; value: unknown };
        if (!set.tombstones.has(elementId)) {
          set.elements.set(elementId, { value, timestamp: op.timestamp, siteId: op.siteId });
        }
        this.sets.set(op.key, set);
        break;
      }
      case 'or-set-remove': {
        const set = this.sets.get(op.key);
        if (set) {
          const elementId = op.value as string;
          set.elements.delete(elementId);
          set.tombstones.add(elementId);
        }
        break;
      }
    }

    // Update vector clock
    this.vectorClock[op.siteId] = Math.max(
      this.vectorClock[op.siteId] ?? 0,
      op.vectorClock[op.siteId] ?? 0
    );

    this.operationLog.push(op);
    this.emit('remote-op-applied', op);
  }

  getOperationsSince(vectorClock: Record<string, number>): CRDTOperation[] {
    return this.operationLog.filter((op) => {
      const remoteTick = vectorClock[op.siteId] ?? 0;
      const opTick = op.vectorClock[op.siteId] ?? 0;
      return opTick > remoteTick;
    });
  }

  getVectorClock(): Record<string, number> {
    return { ...this.vectorClock };
  }

  private createOp(type: CRDTOperation['type'], key: string, value: unknown, timestamp: number): CRDTOperation {
    this.vectorClock[this.siteId] = (this.vectorClock[this.siteId] ?? 0) + 1;
    const op: CRDTOperation = {
      type,
      key,
      value,
      timestamp,
      siteId: this.siteId,
      vectorClock: { ...this.vectorClock },
    };
    this.operationLog.push(op);
    this.emit('local-op', op);
    return op;
  }
}
