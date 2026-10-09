import { describe, expect, it } from 'vitest';
import { runProblem } from '../../src/live/evidence.js';
import type { HostRun } from '../../src/live/types.js';
import { finished, toolUse } from './helpers.js';

describe('runProblem', () => {
  const fine = finished([toolUse('x')]);
  const problem = (over: Partial<HostRun>): string | undefined =>
    runProblem({ ...fine, ...over })?.reason;

  it('finds nothing wrong with a run that ended as a run ends', () => {
    expect(runProblem(fine)).toBeNull();
  });

  it('is told of a limit by the driver, in its own words', () => {
    expect(problem({ limitHit: '5-hour limit reached' })).toBe('limit');
  });

  it.each([
    ['stderr', { stderrTail: 'Claude AI usage limit reached|1760000000', exitCode: 1 }],
    [
      'an error result',
      {
        stream: [
          { type: 'init' },
          { type: 'result', isError: true, text: 'Credit balance is too low' },
        ],
        exitCode: 1,
      },
    ],
    [
      'an error result that says the account is overloaded',
      { stream: [{ type: 'result', isError: true, text: 'API Error: Overloaded' }], exitCode: 0 },
    ],
  ] as const)('finds a limit in the words of %s', (_name, over) => {
    expect(problem(over as Partial<HostRun>)).toBe('limit');
  });

  it('does not read a limit into the words of a tool result or of the model', () => {
    expect(
      problem({
        stream: [
          { type: 'init' },
          { type: 'tool_result', isError: true, text: 'curl: rate limit exceeded' },
          { type: 'text', text: 'the usage limit is a topic' },
          { type: 'result', isError: false, text: 'DONE' },
        ],
      }),
    ).toBeUndefined();
  });

  it.each([
    ['stderr', { stderrTail: 'Invalid API key · Please run /login', exitCode: 1 }],
    [
      'an error result',
      {
        stream: [{ type: 'result', isError: true, text: 'OAuth token has expired' }],
        exitCode: 1,
      },
    ],
  ] as const)('finds a login that does not work in the words of %s', (_name, over) => {
    expect(problem(over as Partial<HostRun>)).toBe('auth');
  });

  it.each([
    ['another provider', { apiProvider: 'bedrock' }],
    ['another provider (vertex)', { apiProvider: 'vertex' }],
    ['an API key in the environment', { apiKeySource: 'ANTHROPIC_API_KEY' }],
    ['a key helper', { apiKeySource: 'apiKeyHelper' }],
    ['a managed key', { apiKeySource: '/login managed key' }],
    ['a key source nobody has heard of', { apiKeySource: 'a-new-kind-of-key' }],
  ])('refuses a run that was billed to %s', (_name, over) => {
    expect(problem(over)).toBe('api-billing');
  });

  it.each([
    ['no key', { apiKeySource: 'none' }],
    ['a login', { apiKeySource: 'oauth' }],
    ['a login, in capitals', { apiKeySource: ' OAuth ' }],
    ['first party', { apiProvider: 'firstParty' }],
  ])('lets through a run that was billed to %s', (_name, over) => {
    expect(problem(over)).toBeUndefined();
  });

  it('does not ask a host that says nothing about its billing', () => {
    const { apiProvider: _p, apiKeySource: _k, ...silent } = fine;
    expect(runProblem(silent)).toBeNull();
  });

  it('finds a run that did not answer in time', () => {
    expect(problem({ timedOut: true, exitCode: null })).toBe('timeout');
  });

  it.each([1, 2, 137, null])('finds a run that ended with the exit code %s', (exitCode) => {
    expect(problem({ exitCode })).toBe('host-error');
  });

  it('finds a run whose last word was an error', () => {
    expect(
      problem({ stream: [{ type: 'init' }, { type: 'result', isError: true, text: 'boom' }] }),
    ).toBe('host-error');
  });

  const unreadable: ReadonlyArray<readonly [string, Partial<HostRun>]> = [
    ['no stream at all', { stream: [] }],
    ['no final result', { stream: [{ type: 'init' }, toolUse('x')] }],
    ['lines it could not read and nothing more', { stream: [], unparsedLines: 12 }],
  ];

  it.each(unreadable)('finds an unreadable stream in %s', (_name, over) => {
    expect(problem(over)).toBe('unparsable-stream');
  });

  it('names the problem in a line of plain words', () => {
    const found = runProblem({ ...fine, limitHit: 'x\u001b[2J'.repeat(200) });
    expect(found?.detail).toMatch(/^[\x20-\x7e]{1,160}$/);
  });
});
