import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateSnapshot, type LocalSnapshot } from './snapshot';

function fixture(): LocalSnapshot {
  return {
    schema: 'stroq-console/1',
    source: 'local',
    generatedAt: '2026-10-23T09:00:00.000Z',
    calls: [
      {
        id: 'audit-1',
        sessionId: 'session-0123456789abcdef',
        decision: 'block',
        label: 'Policy denied a tool call',
        raw: 'Command and content withheld',
        agent: 'Unknown host',
        date: '2026-10-23',
        time: '09:00:00',
        reason: 'Recorded policy denial; host enforcement was not checked.',
      },
    ],
    agents: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        version: 'Not read',
        state: 'unver',
        checks: ['na', 'yes', 'yes', 'na'],
        next: 'stroq doctor',
      },
    ],
    keys: [],
    limitations: ['Timestamps use UTC. Current protection is not assessed.'],
  };
}

const withCall = (changes: Record<string, unknown>) => ({
  ...fixture(),
  calls: [{ ...fixture().calls[0], ...changes }],
});
const withAgent = (changes: Record<string, unknown>) => ({
  ...fixture(),
  agents: [{ ...fixture().agents[0], ...changes }],
});

describe('validateSnapshot', () => {
  it('accepts the read-only bridge shape and narrows unknown data', () => {
    const value: unknown = fixture();
    expect(validateSnapshot(value)).toBe(true);
    if (validateSnapshot(value)) expect(value.source).toBe('local');
    expect(validateSnapshot({ ...fixture(), calls: [], agents: [] })).toBe(true);
  });

  it('accepts an optional exact local journal digest without requiring it from legacy bridges', () => {
    expect(validateSnapshot(withCall({ evidenceSha: 'a'.repeat(64) }))).toBe(true);
    expect(validateSnapshot(fixture())).toBe(true);
  });

  it('refuses malformed digest fields and digest claims on non-journal identities', () => {
    for (const evidenceSha of ['', 'a'.repeat(63), 'A'.repeat(64), null, undefined, 1, {}])
      expect(validateSnapshot(withCall({ evidenceSha }))).toBe(false);
    for (const id of ['demo-1', 'audit-0', 'audit-01', 'audit-9007199254740992'])
      expect(validateSnapshot(withCall({ id, evidenceSha: 'a'.repeat(64) }))).toBe(false);
  });

  it('accepts an actual bridge response from a synthetic home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stroq-snapshot-contract-'));
    try {
      await writeFile(
        join(home, 'audit.jsonl'),
        `${JSON.stringify({ seq: 1, ts: '2026-10-23T09:00:00.000Z', sessionId: 'fixture', phase: 'pre', decision: { effect: 'deny' } })}\n`,
      );
      const bridge = await import(new URL('../scripts/local-snapshot.mjs', import.meta.url).href);
      const value: unknown = await bridge.readLocalSnapshot({
        home,
        now: new Date('2026-10-23T09:00:00.000Z'),
      });
      expect(validateSnapshot(value)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    null,
    undefined,
    1,
    'snapshot',
    [],
    {},
    { ...fixture(), schema: 'stroq-console/2' },
    { ...fixture(), source: 'demo' },
  ])('rejects a wrong envelope', (value) => {
    expect(validateSnapshot(value)).toBe(false);
  });

  it.each([
    '2026-02-31',
    '2025-02-29',
    '2026-13-01',
    '2026-00-00',
    '10/23/2026',
    '2026-10-23T00:00:00Z',
  ])('rejects calendar-invalid or non-date values: %s', (date) => {
    expect(validateSnapshot(withCall({ date }))).toBe(false);
  });

  it('accepts a leap day and validates the complete clock spelling', () => {
    expect(validateSnapshot(withCall({ date: '2024-02-29', time: '23:59:59' }))).toBe(true);
    expect(validateSnapshot(withCall({ time: '09:00' }))).toBe(true);
    for (const time of ['24:00:00', '09:60', '9:00', '12:00:60', '12:00Z', '12:00:00\n'])
      expect(validateSnapshot(withCall({ time }))).toBe(false);
    for (const generatedAt of [
      '1',
      '2026-02-31T09:00:00.000Z',
      '2026-10-23',
      '2026-10-23T09:00:00Z',
      '2026-10-23T24:00:00.000Z',
    ])
      expect(validateSnapshot({ ...fixture(), generatedAt })).toBe(false);
  });

  it('requires optional renderable fields to be bounded strings when present', () => {
    for (const field of ['rule', 'reason', 'sessionId']) {
      for (const value of [{ text: 'unsafe' }, ['unsafe'], null, undefined, 42, 'x'.repeat(2000)])
        expect(validateSnapshot(withCall({ [field]: value }))).toBe(false);
    }
    expect(validateSnapshot(withCall({ rule: 'deny-secret-egress' }))).toBe(true);
    expect(validateSnapshot(withAgent({ next: { command: 'stroq doctor' } }))).toBe(false);
  });

  it('rejects unsupported or inconsistent protection claims', () => {
    for (const state of ['ok', 'failed', 'off', 'watch', '__proto__'])
      expect(validateSnapshot(withAgent({ state }))).toBe(false);
    for (const checks of [
      ['yes', 'yes', 'yes', 'yes'],
      ['na', 'yes', 'yes'],
      ['na', 'yes', 'yes', 'na', 'yes'],
      ['na', 'maybe', 'yes', 'na'],
      ['na', 'yes', {}, 'na'],
    ])
      expect(validateSnapshot(withAgent({ checks }))).toBe(false);
    expect(validateSnapshot(withAgent({ checks: ['na', 'na', 'no', 'na'] }))).toBe(true);
  });

  it('requires known host names and consistent host inventory identifiers', () => {
    expect(validateSnapshot(withCall({ agent: 'Unknown host' }))).toBe(true);
    expect(validateSnapshot(withCall({ agent: '__proto__' }))).toBe(false);
    expect(validateSnapshot(withAgent({ name: 'Cursor' }))).toBe(false);
    expect(validateSnapshot(withAgent({ id: 'attacker', name: 'Unknown host' }))).toBe(false);
    expect(validateSnapshot(withCall({ decision: 'executed' }))).toBe(false);
  });

  it('refuses unbounded arrays, duplicate identifiers and sparse rows', () => {
    const source = fixture();
    expect(
      validateSnapshot({
        ...source,
        calls: Array.from({ length: 501 }, (_, index) => ({
          ...source.calls[0],
          id: `audit-${index}`,
        })),
      }),
    ).toBe(false);
    expect(validateSnapshot({ ...source, calls: [source.calls[0], source.calls[0]] })).toBe(false);
    expect(validateSnapshot({ ...source, agents: [source.agents[0], source.agents[0]] })).toBe(
      false,
    );
    expect(validateSnapshot({ ...source, calls: new Array(2) })).toBe(false);
    expect(
      validateSnapshot({ ...source, limitations: Array.from({ length: 33 }, () => 'Too many') }),
    ).toBe(false);
    expect(validateSnapshot({ ...source, limitations: ['x'.repeat(1001)] })).toBe(false);
  });

  it('does not accept credential data, unknown fields or injected objects', () => {
    expect(validateSnapshot({ ...fixture(), keys: [{ name: 'API_KEY' }] })).toBe(false);
    expect(validateSnapshot({ ...fixture(), credentials: {} })).toBe(false);
    expect(validateSnapshot(withCall({ toolInput: {} }))).toBe(false);
    expect(validateSnapshot(withCall({ label: { text: 'Break React' } }))).toBe(false);
    expect(validateSnapshot(withAgent({ unknown: 'value' }))).toBe(false);
    expect(validateSnapshot(JSON.parse('{"__proto__":{"source":"local"}}'))).toBe(false);
    const throwing = Object.defineProperty({}, 'schema', {
      get() {
        throw new Error('Untrusted getter');
      },
    });
    expect(() => validateSnapshot(throwing)).not.toThrow();
    expect(validateSnapshot(throwing)).toBe(false);
  });
});
