import { describe, expect, it } from 'vitest';
import { StrictLedger, type TrackedRequest } from '../../src/mcp/strict-ledger.js';
import { STRICT_CANCELLED_MEMORY, STRICT_MAX_TRACKED } from '../../src/mcp/strict-limits.js';

const request = (id: string | number, method = 'tools/call'): TrackedRequest => ({
  id,
  method,
  toolName: `mcp__srv__${method.replace('/', '_')}`,
});

describe('StrictLedger', () => {
  it('remembers failed pending ids so duplicates cannot affect new requests', () => {
    const ledger = new StrictLedger();
    ledger.track(request(1));
    ledger.track(request('1'));
    expect(ledger.failPending().map((item) => item.id)).toEqual([1, '1']);
    expect(ledger.wasAnswered(1)).toBe(true);
    expect(ledger.wasAnswered('1')).toBe(true);
    expect(ledger.failPending()).toEqual([]);
    ledger.track(request(1));
    expect(ledger.wasAnswered(1)).toBe(false);
    expect(ledger.wasAnswered('1')).toBe(true);
  });

  it('bounds the memory of completed ids', () => {
    const ledger = new StrictLedger();
    for (let id = 0; id < STRICT_CANCELLED_MEMORY + 1; id += 1) {
      ledger.track(request(id));
      ledger.take(id);
    }
    expect(ledger.wasAnswered(0)).toBe(false);
    expect(ledger.wasAnswered(STRICT_CANCELLED_MEMORY)).toBe(true);
  });

  it('answers each request once: the second take of an id finds nothing', () => {
    const ledger = new StrictLedger();
    ledger.track(request(1));
    expect(ledger.take(1)?.method).toBe('tools/call');
    expect(ledger.take(1)).toBeUndefined();
  });

  it('keeps string ids and number ids apart', () => {
    const ledger = new StrictLedger();
    ledger.track(request(3));
    expect(ledger.take('3')).toBeUndefined();
    expect(ledger.take(3)).toBeDefined();
  });

  it('finds the request a differently-typed id was meant for, without taking it', () => {
    const ledger = new StrictLedger();
    ledger.track(request(3));
    ledger.track(request('abc'));
    expect(ledger.mismatched('3')?.id).toBe(3);
    expect(ledger.size).toBe(2);
    expect(ledger.mismatched('abc')).toBeUndefined();
    expect(ledger.mismatched('03')).toBeUndefined();
    expect(ledger.mismatched('3.0')).toBeUndefined();
    ledger.track(request('7'));
    expect(ledger.mismatched(7)?.id).toBe('7');
  });

  it('does not treat a string that merely resembles a number as a mismatch for an inexact one', () => {
    const ledger = new StrictLedger();
    ledger.track(request(1e21));
    expect(ledger.mismatched('1e+21')?.id).toBe(1e21);
    expect(ledger.mismatched('1000000000000000000000')).toBeUndefined();
  });

  it('forgets a cancelled request and remembers once that its late answer is expected', () => {
    const ledger = new StrictLedger();
    ledger.track(request(5));
    ledger.cancel(5);
    expect(ledger.take(5)).toBeUndefined();
    expect(ledger.takeCancelled(5)).toBe(true);
    expect(ledger.takeCancelled(5)).toBe(false);
  });

  it('does not let a cancel for an id nobody sent excuse a later answer', () => {
    const ledger = new StrictLedger();
    ledger.cancel(9);
    expect(ledger.takeCancelled(9)).toBe(false);
  });

  it('forgets a cancellation when the client reuses the id', () => {
    const ledger = new StrictLedger();
    ledger.track(request(5));
    ledger.cancel(5);
    ledger.track(request(5));
    expect(ledger.takeCancelled(5)).toBe(false);
    expect(ledger.take(5)).toBeDefined();
  });

  it('remembers only the most recent cancellations', () => {
    const ledger = new StrictLedger();
    for (let id = 0; id < STRICT_CANCELLED_MEMORY + 5; id += 1) {
      ledger.track(request(id));
      ledger.cancel(id);
    }
    expect(ledger.takeCancelled(0)).toBe(false);
    expect(ledger.takeCancelled(STRICT_CANCELLED_MEMORY + 4)).toBe(true);
  });

  it('drops the oldest requests past its bound', () => {
    const ledger = new StrictLedger();
    for (let id = 0; id < STRICT_MAX_TRACKED + 3; id += 1) ledger.track(request(id));
    expect(ledger.size).toBe(STRICT_MAX_TRACKED);
    expect(ledger.take(0)).toBeUndefined();
    expect(ledger.take(STRICT_MAX_TRACKED + 2)).toBeDefined();
  });

  it('empties itself into a list of everything still waiting', () => {
    const ledger = new StrictLedger();
    ledger.track(request(1));
    ledger.track(request('b', 'tools/list'));
    expect(ledger.drain().map((r) => r.id)).toEqual([1, 'b']);
    expect(ledger.size).toBe(0);
  });
});
