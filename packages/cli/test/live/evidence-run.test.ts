import { describe, expect, it } from 'vitest';
import { isWellFormedRun, markControl, markProbe, runProblem } from '../../src/live/evidence.js';
import type { HostRun } from '../../src/live/types.js';
import { ABSENT, happy } from './evidence-helpers.js';
import { finished, toolUse } from './helpers.js';
import { probe } from './probe-helpers.js';

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

  it('finds a run whose last word was an error with no words in it', () => {
    expect(problem({ stream: [{ type: 'init' }, { type: 'result', isError: true }] })).toBe(
      'host-error',
    );
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

// A driver is code that talks to a program we do not control. What it hands back is checked before it is
// used, because an answer that is not in the shape of a run must be a run that cannot be read, and must
// not be a throw after the request that produced it has been taken from the ledger.
describe('an answer that is not in the shape of a run', () => {
  const fine = finished([toolUse('x')]);
  const as = (over: Record<string, unknown>): HostRun =>
    ({ ...fine, ...over }) as unknown as HostRun;

  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['a null in the stream', as({ stream: [{ type: 'init' }, null, { type: 'result' }] })],
    ['a number in the stream', as({ stream: [{ type: 'init' }, 7, { type: 'result' }] })],
    ['an event with no type', as({ stream: [{ text: 'x' }] })],
    ['an event of a type nobody knows', as({ stream: [{ type: 'banana' }] })],
    ['an event with text that is not text', as({ stream: [{ type: 'text', text: 5 }] })],
    ['an event with a name that is not a name', as({ stream: [{ type: 'tool_use', name: {} }] })],
    [
      'an event with an error flag that is not a flag',
      as({ stream: [{ type: 'result', isError: 'yes' }] }),
    ],
    ['a stream that is not a list', as({ stream: 'result' })],
    ['no stream', as({ stream: undefined })],
    ['an exit code that is a string', as({ exitCode: '0' })],
    ['an exit code that is missing', as({ exitCode: undefined })],
    ['a time-out flag that is not a flag', as({ timedOut: 'no' })],
    ['a stderr that is not text', as({ stderrTail: null })],
    ['a limit that is a number', as({ limitHit: 5 })],
    ['a provider that is an object', as({ apiProvider: {} })],
    ['a key source that is a number', as({ apiKeySource: 5 })],
    ['a key source that is null', as({ apiKeySource: null })],
    ['a count of unread lines that is not finite', as({ unparsedLines: Number.NaN })],
    ['a count of unread lines that is text', as({ unparsedLines: '3' })],
    ['nothing', null],
    ['a string', 'result'],
    ['a list', []],
  ];

  it.each(malformed)('finds %s unreadable, without throwing', (_name, run) => {
    expect(isWellFormedRun(run)).toBe(false);
    expect(runProblem(run as HostRun)).toMatchObject({ reason: 'unparsable-stream' });
  });

  it('lets a run in the shape of a run through', () => {
    expect(isWellFormedRun(fine)).toBe(true);
    expect(isWellFormedRun({ ...fine, apiProvider: undefined })).toBe(true);
    expect(isWellFormedRun({ ...fine, exitCode: null })).toBe(true);
  });

  it.each(
    malformed.filter(([, run]) => typeof run === 'object' && run !== null && !Array.isArray(run)),
  )(
    'marks a probe run with %s inconclusive and unreadable, and not as an error of ours',
    (_name, run) => {
      const outcome = markProbe(happy('allow', { run: run as HostRun, sentinel: ABSENT }));
      expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
        mark: 'inconclusive',
        reason: 'unparsable-stream',
      });
    },
  );

  it('marks a control run with an answer like that inconclusive and unreadable too', () => {
    const outcome = markControl({
      probe: probe('deny'),
      nonce: 'stroq-live-0123456789abcdef',
      run: as({ stream: [null] }),
      sentinel: ABSENT,
    });
    expect(outcome.reason).toBe('unparsable-stream');
  });
});
