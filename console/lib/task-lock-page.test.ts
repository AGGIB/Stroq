import { describe, expect, it } from 'vitest';
import { validateTaskLockPage, validateTaskLockPageRequest } from './task-lock-page';
import { TASK_LOCK_LIMITATIONS } from './task-locks';

const cursor = '11111111-1111-4111-8111-111111111111';
const sha = 'a'.repeat(64);
const state = () => ({
  schema: 'stroq-task-locks/1',
  workspaceId: `workspace-${'b'.repeat(24)}`,
  host: 'claude-code',
  checkedAt: '2026-10-24T00:00:00.000Z',
  currentPolicySha256: sha,
  available: true,
  reason: null,
  coverage: { complete: true, limited: false, unverified: 0, foreign: 0 },
  tasks: [],
  limitations: TASK_LOCK_LIMITATIONS,
});
const page = () => ({
  schema: 'stroq-task-lock-page/1',
  state: state(),
  page: { index: 1, nextCursor: null, catalogLimited: false },
});

describe('bounded task permission pages', () => {
  it('keeps a complete empty page distinct from unavailable state', () => {
    expect(validateTaskLockPage(page())).toBe(true);
    const missing = page();
    Object.assign(missing.state, {
      available: false,
      reason: 'runtime-unavailable',
      coverage: { complete: false, limited: true, unverified: 0, foreign: 0 },
    });
    expect(validateTaskLockPage(missing)).toBe(true);
    missing.page.index = 2;
    expect(validateTaskLockPage(missing)).toBe(false);
  });
  it('does not call a partial page globally complete or accept private cursor metadata', () => {
    const value = page();
    Object.assign(value.page, { index: 2, nextCursor: cursor });
    expect(validateTaskLockPage(value)).toBe(false);
    value.state.coverage = { complete: false, limited: true, unverified: 0, foreign: 0 };
    expect(validateTaskLockPage(value)).toBe(true);
    expect(validateTaskLockPage({ ...value, listing: { names: ['private-task'] } })).toBe(false);
    expect(validateTaskLockPage({ ...value, page: { ...value.page, offset: 64 } })).toBe(false);
    expect(
      validateTaskLockPage({ ...value, state: { ...value.state, rawId: 'private-task' } }),
    ).toBe(false);
  });
  it('bounds page indexes and tokens and exposes hard catalog limits without false absence', () => {
    const value = page();
    value.page.catalogLimited = true;
    expect(validateTaskLockPage(value)).toBe(false);
    value.state.coverage = { complete: false, limited: true, unverified: 0, foreign: 0 };
    value.page.index = 128;
    expect(validateTaskLockPage(value)).toBe(true);
    expect(validateTaskLockPage({ ...value, page: { ...value.page, nextCursor: cursor } })).toBe(
      false,
    );
    for (const index of [0, 129, 1.5, NaN])
      expect(validateTaskLockPage({ ...value, page: { ...value.page, index } })).toBe(false);
    for (const nextCursor of ['../private', '', 'https://foreign.invalid'])
      expect(validateTaskLockPage({ ...value, page: { ...value.page, nextCursor } })).toBe(false);
  });
  it('admits only an opaque cursor or an exact task/version read request', () => {
    expect(validateTaskLockPageRequest({ cursor })).toBe(true);
    expect(validateTaskLockPageRequest({ id: `task-${sha}`, expectedPermitSha256: sha })).toBe(
      true,
    );
    expect(validateTaskLockPageRequest({ id: `task-${sha}`, expectedPermitSha256: null })).toBe(
      true,
    );
    for (const value of [
      null,
      {},
      { id: `task-${sha}` },
      { cursor, offset: 64 },
      { cursor, id: `task-${sha}`, expectedPermitSha256: sha },
      { id: '../native-task', expectedPermitSha256: sha },
      { id: `task-${sha}`, expectedPermitSha256: 'private' },
      { cursor, path: '/private/tasks' },
    ])
      expect(validateTaskLockPageRequest(value)).toBe(false);
  });
});
