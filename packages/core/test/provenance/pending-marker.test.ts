import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOOK_DEADLINE_CEILING_MS,
  MARKER_LIFETIME_MS,
  MARKER_MARGIN_MS,
  markerIsStale,
  pendingMarkerBody,
  processIsAlive,
} from '../../src/provenance/pending-marker.js';

// A marker names the process that put it down and the time by which that process had to be done.
// It is stale when the process is gone or the time is up: a hook that is running answers within its
// deadline, so past either one the result it was reading has not been, and will not be, scanned.

afterEach(() => vi.restoreAllMocks());

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const alive = (): boolean => true;
const dead = (): boolean => false;

const marker = (fields: Record<string, unknown>): string =>
  JSON.stringify({ pending: true, since: new Date(NOW).toISOString(), ...fields });

describe('what a marker says', () => {
  it('names the process that wrote it and the deadline it was given', () => {
    const body = JSON.parse(pendingMarkerBody(new Date(NOW), 4321)) as Record<string, unknown>;
    expect(body).toEqual({
      pending: true,
      since: new Date(NOW).toISOString(),
      pid: 4321,
      deadlineAt: NOW + MARKER_LIFETIME_MS,
    });
  });

  it('gives a result a lifetime of the longest hook deadline and a small margin', () => {
    expect(MARKER_LIFETIME_MS).toBe(HOOK_DEADLINE_CEILING_MS + MARKER_MARGIN_MS);
    expect(MARKER_MARGIN_MS).toBeGreaterThan(0);
    expect(MARKER_MARGIN_MS).toBeLessThanOrEqual(5_000);
  });
});

describe('when a marker is stale', () => {
  it('is not, while its owner is alive and its deadline has not passed', () => {
    const text = marker({ pid: 4321, deadlineAt: NOW + 5_000 });
    expect(markerIsStale(text, NOW, alive)).toBe(false);
    expect(markerIsStale(text, NOW + 5_000, alive)).toBe(false);
  });

  it('is at once, when its owner is gone, however much time is left', () => {
    const text = marker({ pid: 4321, deadlineAt: NOW + MARKER_LIFETIME_MS });
    expect(markerIsStale(text, NOW, dead)).toBe(true);
  });

  it('is once the deadline has passed, though a process with that number is alive', () => {
    const text = marker({ pid: 4321, deadlineAt: NOW + 5_000 });
    expect(markerIsStale(text, NOW + 5_001, alive)).toBe(true);
  });

  it('asks about the owner it names', () => {
    const asked: number[] = [];
    markerIsStale(marker({ pid: 777, deadlineAt: NOW + 1 }), NOW, (pid) => {
      asked.push(pid);
      return true;
    });
    expect(asked).toEqual([777]);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['an empty file', ''],
    ['a JSON value that is not an object', '[1,2]'],
    ['no owner (a marker an older version wrote)', marker({})],
    ['an owner that is not a number', marker({ pid: '4321', deadlineAt: NOW + 5_000 })],
    [
      'an owner of zero, which would address a whole group',
      marker({ pid: 0, deadlineAt: NOW + 5_000 }),
    ],
    [
      'a negative owner, which would address a whole group',
      marker({ pid: -1, deadlineAt: NOW + 5_000 }),
    ],
    ['a fractional owner', marker({ pid: 4321.5, deadlineAt: NOW + 5_000 })],
    ['no deadline', marker({ pid: 4321 })],
    ['a deadline that is not a number', marker({ pid: 4321, deadlineAt: 'soon' })],
  ])('is at once for %s', (_what, text) => {
    expect(markerIsStale(text, NOW, alive)).toBe(true);
  });

  it('never asks whether a process is alive when the marker already says it is stale', () => {
    const asked = vi.fn(alive);
    markerIsStale(marker({ pid: 0, deadlineAt: NOW + 5_000 }), NOW, asked);
    markerIsStale(marker({ pid: 4321, deadlineAt: NOW - 1 }), NOW, asked);
    expect(asked).not.toHaveBeenCalled();
  });
});

describe('whether a process is alive', () => {
  it('is true for this one', () => {
    expect(processIsAlive(process.pid)).toBe(true);
  });

  it('is false for one that has exited', () => {
    const child = spawnSync(process.execPath, ['-e', '0']);
    expect(child.pid).toBeGreaterThan(0);
    expect(processIsAlive(child.pid)).toBe(false);
  });

  it('is true for one this user may not signal, which exists', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    expect(processIsAlive(1)).toBe(true);
  });

  it('is false for any other failure', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('invalid'), { code: 'EINVAL' });
    });
    expect(processIsAlive(1)).toBe(false);
  });

  it('only probes, never signals', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    processIsAlive(4321);
    expect(kill).toHaveBeenCalledWith(4321, 0);
  });
});
