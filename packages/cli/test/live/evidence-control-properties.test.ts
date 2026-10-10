import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { markControl, normalizeCommand, runProblem } from '../../src/live/evidence.js';
import { controlOf } from '../../src/live/probes.js';
import { ABSENT, THERE } from './evidence-helpers.js';
import { is, withRun, withStream, type Mutation } from './evidence-mutations.js';
import { NONCE, finished, toolUse } from './helpers.js';
import { PROJECT, probe } from './probe-helpers.js';

/**
 * A verified host rests on the control: the one run in which no hook counts the calls, so nothing but the
 * stream and the disk can say what happened. A control that is called armed when it was not is a false
 * `verified`, which is the one result this check must never give. So, like a pass of a real probe, the
 * control is tested as a claim about many runs, against an oracle written out from the raw data: armed
 * exactly when the run ended as a run ends, the stream holds the command and no other call, the file
 * holds what the command writes, and the host reported no error for the call.
 */
type Input = Parameters<typeof markControl>[0];

const KINDS = ['deny', 'secret-egress'] as const;

const happyControl = (kind: (typeof KINDS)[number]): Input => {
  const p = controlOf(probe(kind));
  return { probe: p, nonce: NONCE, run: finished([toolUse(p.command)]), sentinel: THERE };
};

const MUTATIONS: readonly Mutation<Input>[] = [
  {
    name: 'drop the call',
    apply: (i) => withStream(i, (s) => s.filter((e) => !is(e, 'tool_use'))),
  },
  {
    name: 'alter the command',
    apply: (i) =>
      withStream(i, (s) =>
        s.map((e) => (is(e, 'tool_use') ? toolUse(`${i.probe.command}; ls`) : e)),
      ),
  },
  {
    name: 'space the command differently',
    apply: (i) =>
      withStream(i, (s) =>
        s.map((e) =>
          is(e, 'tool_use') ? toolUse(`  ${i.probe.command.replace(/ /g, '   ')}\n`) : e,
        ),
      ),
  },
  {
    name: 'call the shell by another name',
    apply: (i) =>
      withStream(i, (s) => s.map((e) => (is(e, 'tool_use') ? { ...e, name: 'bash' } : e))),
  },
  {
    name: 'add a call of another command',
    apply: (i) => withStream(i, (s) => [...s, toolUse('ls -la')]),
  },
  {
    name: 'add a call through another tool',
    apply: (i) =>
      withStream(i, (s) => [...s, { type: 'tool_use', name: 'Write', input: { file_path: 'x' } }]),
  },
  {
    name: 'add the call that makes the file by itself',
    apply: (i) =>
      withStream(i, (s) => [...s, toolUse(`echo ${NONCE} > ${PROJECT}/${i.probe.sentinel.file}`)]),
  },
  {
    name: 'make the command twice',
    apply: (i) => withStream(i, (s) => [...s, toolUse(i.probe.command)]),
  },
  {
    name: 'add an error for a call',
    apply: (i) =>
      withStream(i, (s) => [...s, { type: 'tool_result', isError: true, text: 'exit 1' }]),
  },
  {
    name: 'add an answer that is not an error',
    apply: (i) =>
      withStream(i, (s) => [...s, { type: 'tool_result', isError: false, text: 'fine' }]),
  },
  {
    name: 'add talk with the nonce in it',
    apply: (i) => withStream(i, (s) => [...s, { type: 'text', text: `I ran echo ${NONCE}` }]),
  },
  { name: 'hit a limit', apply: (i) => withRun(i, { limitHit: 'usage limit reached' }) },
  { name: 'time out', apply: (i) => withRun(i, { timedOut: true, exitCode: null }) },
  { name: 'exit with an error', apply: (i) => withRun(i, { exitCode: 1 }) },
  {
    name: 'drop the final result',
    apply: (i) => withStream(i, (s) => s.filter((e) => !is(e, 'result'))),
  },
  { name: 'bill an API key', apply: (i) => withRun(i, { apiKeySource: 'ANTHROPIC_API_KEY' }) },
  { name: 'lose some lines of the stream', apply: (i) => withRun(i, { unparsedLines: 2 }) },
  {
    name: 'put a null in the stream',
    apply: (i) => withStream(i, (s) => [null as never, ...s]),
  },
  { name: 'lose the file', apply: (i) => ({ ...i, sentinel: ABSENT }) },
  {
    name: 'write something else in the file',
    apply: (i) => ({ ...i, sentinel: { exists: true, content: 'something else' } }),
  },
  {
    name: 'put something that is not a file there',
    apply: (i) => ({ ...i, sentinel: { exists: true, content: null } }),
  },
  {
    name: 'not look at the file',
    apply: (i) => ({ ...i, sentinel: { exists: null, content: null } }),
  },
];

const mutations: fc.Arbitrary<readonly Mutation<Input>[]> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<readonly Mutation<Input>[]>([]) },
  { weight: 5, arbitrary: fc.array(fc.constantFrom(...MUTATIONS), { minLength: 1, maxLength: 3 }) },
);

const inputs: fc.Arbitrary<Input> = fc
  .record({ kind: fc.constantFrom(...KINDS), applied: mutations })
  .map(({ kind, applied }) =>
    applied.reduce<Input>((input, mutation) => mutation.apply(input), happyControl(kind)),
  );

// ---------------------------------------------------------------------------------------------
// The oracle, read off the raw data.

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const commandOf = (event: Record<string, unknown>): string | null => {
  if (event['name'] !== 'Bash') return null;
  const input = event['input'];
  if (typeof input === 'string') return input;
  return isObject(input) && typeof input['command'] === 'string' ? input['command'] : null;
};

function armedByTheBook(input: Input): boolean {
  const stream = input.run.stream as readonly unknown[];
  const calls = stream.filter(isObject).filter((e) => e['type'] === 'tool_use');
  const only = calls.length === 1 ? calls[0] : undefined;
  const command = only === undefined ? null : commandOf(only);
  const issuedAlone =
    command !== null && normalizeCommand(command) === normalizeCommand(input.probe.command);
  const fileHolds =
    input.sentinel.exists === true &&
    input.sentinel.content !== null &&
    input.sentinel.content.trim() === input.probe.sentinel.holds;
  const errored = stream
    .filter(isObject)
    .some((e) => e['type'] === 'tool_result' && e['isError'] === true);
  return runProblem(input.run) === null && issuedAlone && fileHolds && !errored;
}

describe('what no combination of evidence can make of a control', () => {
  it('is armed exactly when the oracle says it is, over runs that start right and have things go wrong', () => {
    const tally = new Map<string, number>();
    fc.assert(
      fc.property(inputs, (input) => {
        const outcome = markControl(input);
        const key = `${outcome.mark}:${outcome.reason}`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
        expect(outcome.mark === 'passed').toBe(armedByTheBook(input));
        expect(outcome.reason).toMatch(/^[a-z0-9][a-z0-9:._-]{0,63}$/);
        return true;
      }),
      { numRuns: 3000 },
    );
    // The claim is about arming and about every way of not being armed, so each has to have been seen.
    const seen = (key: string): number => tally.get(key) ?? 0;
    expect(seen('passed:armed')).toBeGreaterThanOrEqual(150);
    expect(seen('inconclusive:control-extra-activity')).toBeGreaterThanOrEqual(100);
    expect(seen('inconclusive:control-errored')).toBeGreaterThanOrEqual(25);
    expect(seen('inconclusive:command-altered')).toBeGreaterThanOrEqual(50);
    expect(seen('inconclusive:probe-not-armed')).toBeGreaterThanOrEqual(25);
    expect(seen('inconclusive:evidence-conflict')).toBeGreaterThanOrEqual(25);
    expect(seen('not-issued:not-issued')).toBeGreaterThanOrEqual(10);
  }, 120_000);

  it('is armed by every kind of control when nothing goes wrong, and by the things that do not matter', () => {
    const benign = MUTATIONS.filter((m) =>
      [
        'space the command differently',
        'add an answer that is not an error',
        'add talk with the nonce in it',
        'lose some lines of the stream',
      ].includes(m.name),
    );
    expect(benign).toHaveLength(4);
    for (const kind of KINDS) {
      expect(markControl(happyControl(kind)).mark).toBe('passed');
      for (const m of benign)
        expect(markControl(m.apply(happyControl(kind))), `${kind} / ${m.name}`).toMatchObject({
          mark: 'passed',
          reason: 'armed',
        });
    }
  });
});
