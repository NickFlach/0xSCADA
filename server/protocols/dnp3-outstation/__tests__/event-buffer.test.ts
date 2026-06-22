/**
 * Tests for DNP3 Class 0/1/2/3 event buffering + unsolicited triggers (#464).
 */
import { describe, test, expect } from 'vitest';
import { Dnp3EventBuffer, type EventBufferConfig } from '../event-buffer';

function makeBuffer(overrides?: Partial<EventBufferConfig>): Dnp3EventBuffer {
  const cfg: EventBufferConfig = {
    class1: { maxEvents: 3, unsolicitedThreshold: 2 },
    class2: { maxEvents: 3, unsolicitedThreshold: 0 },
    class3: { maxEvents: 3, unsolicitedThreshold: 5 },
    unsolicitedMaxDelayMs: 1000,
    ...overrides,
  };
  return new Dnp3EventBuffer(cfg);
}

function ev(buf: Dnp3EventBuffer, cls: 1 | 2 | 3, index: number, ts: number) {
  return buf.enqueue({ pointType: 'binaryInput', index, eventClass: cls, value: true, flags: 0x81, timestamp: ts });
}

describe('Dnp3EventBuffer enqueue/size', () => {
  test('assigns increasing sequence numbers', () => {
    const buf = makeBuffer();
    const s1 = ev(buf, 1, 0, 100);
    const s2 = ev(buf, 1, 1, 101);
    expect(s2).toBe(s1 + 1);
    expect(buf.classSize(1)).toBe(2);
    expect(buf.size()).toBe(2);
  });

  test('overflow drops oldest and raises overflow flag', () => {
    const buf = makeBuffer();
    ev(buf, 1, 0, 1);
    ev(buf, 1, 1, 2);
    ev(buf, 1, 2, 3);
    expect(buf.hasOverflow()).toBe(false);
    ev(buf, 1, 3, 4); // 4th into a maxEvents=3 queue
    expect(buf.classSize(1)).toBe(3);
    expect(buf.hasOverflow()).toBe(true);
    // oldest (index 0) dropped; remaining start at index 1
    const peeked = buf.peek([1]);
    expect(peeked[0].index).toBe(1);
  });
});

describe('peek / confirm / clear', () => {
  test('peek returns chronological (seq) order across classes', () => {
    const buf = makeBuffer();
    ev(buf, 2, 10, 5);
    ev(buf, 1, 20, 6);
    ev(buf, 3, 30, 7);
    const all = buf.peek([1, 2, 3]);
    expect(all.map((e) => e.index)).toEqual([10, 20, 30]);
  });

  test('peek respects max cap', () => {
    const buf = makeBuffer();
    ev(buf, 1, 0, 1);
    ev(buf, 1, 1, 2);
    expect(buf.peek([1], 1).length).toBe(1);
  });

  test('confirm permanently removes events and clears overflow', () => {
    const buf = makeBuffer();
    const s1 = ev(buf, 1, 0, 1);
    ev(buf, 1, 1, 2);
    ev(buf, 1, 2, 3);
    ev(buf, 1, 3, 4); // overflow
    expect(buf.hasOverflow()).toBe(true);
    const all = buf.peek([1]).map((e) => e.seq);
    buf.confirm(all);
    expect(buf.classSize(1)).toBe(0);
    expect(buf.hasOverflow()).toBe(false);
    expect(buf.peek([1]).find((e) => e.seq === s1)).toBeUndefined();
  });

  test('clear empties all classes', () => {
    const buf = makeBuffer();
    ev(buf, 1, 0, 1);
    ev(buf, 2, 0, 1);
    buf.clear();
    expect(buf.size()).toBe(0);
  });
});

describe('unsolicited trigger evaluation', () => {
  test('count threshold fires for class 1 at >= 2 events', () => {
    const buf = makeBuffer();
    ev(buf, 1, 0, 100);
    expect(buf.evaluateUnsolicited(150).shouldSend).toBe(false);
    ev(buf, 1, 1, 110);
    const d = buf.evaluateUnsolicited(150);
    expect(d.shouldSend).toBe(true);
    expect(d.reason).toBe('count');
    expect(d.classes).toContain(1);
  });

  test('threshold 0 disables count trigger for class 2', () => {
    const buf = makeBuffer();
    ev(buf, 2, 0, 1);
    ev(buf, 2, 1, 2);
    ev(buf, 2, 2, 3);
    // class2 threshold is 0 -> count never triggers; within delay window
    expect(buf.evaluateUnsolicited(50).shouldSend).toBe(false);
  });

  test('delay trigger fires when oldest event exceeds max delay', () => {
    const buf = makeBuffer();
    ev(buf, 2, 0, 100); // class2 count disabled
    const before = buf.evaluateUnsolicited(900); // 800ms < 1000ms
    expect(before.shouldSend).toBe(false);
    const after = buf.evaluateUnsolicited(1200); // 1100ms >= 1000ms
    expect(after.shouldSend).toBe(true);
    expect(after.reason).toBe('delay');
    expect(after.classes).toContain(2);
  });

  test('no events => no trigger', () => {
    const buf = makeBuffer();
    expect(buf.evaluateUnsolicited(99999)).toEqual({ shouldSend: false, classes: [], reason: 'none' });
  });

  test('classEventIinBits reflects buffered classes', () => {
    const buf = makeBuffer();
    ev(buf, 1, 0, 1);
    ev(buf, 3, 0, 1);
    expect(buf.classEventIinBits()).toEqual({ class1: true, class2: false, class3: true });
  });
});
