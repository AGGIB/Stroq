import { describe, expect, it } from 'vitest';
import { failureOf } from '../../src/commands/harden-errors.js';
import { HardenError } from '../../src/harden/types.js';

/**
 * A failure as an answer: the exit code it earns, and one line to say, with no stack and nothing a
 * terminal would obey. An acknowledgement that is missing is exit 3, like a plan that says so first.
 */
describe('failureOf', () => {
  it.each([
    'link-not-acknowledged',
    'credential-loss-not-acknowledged',
    'reformat-not-acknowledged',
  ] as const)('answers %s with exit 3, as an acknowledgement that is missing', (code) => {
    const failure = failureOf(new HardenError(code, 'needs a flag'));

    expect(failure.code).toBe(3);
    expect(failure.outcome).toMatchObject({
      status: 'needs-acknowledgement',
      message: 'needs a flag',
      details: { code },
    });
  });

  it.each(['stale-plan', 'read-only-target', 'plan-refused', 'manifest-invalid'] as const)(
    'answers %s with exit 1, as a failure',
    (code) => {
      const failure = failureOf(new HardenError(code, 'it did not work'));

      expect(failure.code).toBe(1);
      expect(failure.outcome).toMatchObject({ status: 'failed', details: { code } });
    },
  );

  it('puts the code of a system error in front of its message', () => {
    const failure = failureOf(
      Object.assign(new Error('permission denied, open x'), { code: 'EACCES' }),
    );

    expect(failure.code).toBe(1);
    expect(failure.outcome.message).toBe('EACCES: permission denied, open x');
  });

  it('says a plain error as it is, and anything else as text', () => {
    expect(failureOf(new Error('plain')).outcome.message).toBe('plain');
    expect(failureOf('a string').outcome.message).toBe('a string');
    expect(failureOf(undefined).outcome.message).toBe('undefined');
  });

  it('keeps the message to one line with nothing in it that a terminal would obey', () => {
    const failure = failureOf(new Error('bad path a\u001b[2Jb\nforged line'));

    expect(failure.outcome.message).toBe('bad path a\\u001b[2Jb\\nforged line');
  });
});
