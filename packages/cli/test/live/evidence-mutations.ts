import { WITHHELD_SUMMARY, type EvidenceInput } from '../../src/live/evidence.js';
import type { HostRun, StreamEvent } from '../../src/live/types.js';
import { ABSENT, THERE } from './evidence-helpers.js';
import { NONCE, auditEntry, toolUse } from './helpers.js';

/**
 * The ways a run, a hook or a disk can go wrong (or change in a way that should not matter), as functions
 * on the input of a mark. The property tests start from the run in which everything went right and apply a
 * few of these.
 */

export type Mutation<T = EvidenceInput> = {
  readonly name: string;
  readonly apply: (input: T) => T;
};

/** Whether an event of the stream is of this type; a mutation that came before may have put a null there. */
export const is = (event: unknown, type: StreamEvent['type']): boolean =>
  typeof event === 'object' && event !== null && (event as StreamEvent).type === type;

export const withRun = <T extends { readonly run: HostRun }>(
  input: T,
  over: Partial<HostRun>,
): T => ({
  ...input,
  run: { ...input.run, ...over },
});
export const withStream = <T extends { readonly run: HostRun }>(
  input: T,
  change: (stream: readonly StreamEvent[]) => readonly StreamEvent[],
): T => withRun(input, { stream: change(input.run.stream) });
const withAudit = (
  input: EvidenceInput,
  change: (audit: EvidenceInput['audit']) => EvidenceInput['audit'],
): EvidenceInput => ({ ...input, audit: change(input.audit) });
const onEntries = (
  input: EvidenceInput,
  over: Partial<EvidenceInput['audit'][number]>,
): EvidenceInput => withAudit(input, (audit) => audit.map((entry) => ({ ...entry, ...over })));

export const MUTATIONS: readonly Mutation[] = [
  // What the model's stream says.
  {
    name: 'drop the call',
    apply: (i) => withStream(i, (s) => s.filter((e) => !is(e, 'tool_use'))),
  },
  {
    name: 'alter the command',
    apply: (i) =>
      withStream(i, (s) =>
        s.map((e) =>
          is(e, 'tool_use') ? { ...e, input: { command: `${i.probe.command}; ls` } } : e,
        ),
      ),
  },
  {
    name: 'call the shell by another name',
    apply: (i) =>
      withStream(i, (s) => s.map((e) => (is(e, 'tool_use') ? { ...e, name: 'bash' } : e))),
  },
  {
    name: 'space the command differently',
    apply: (i) =>
      withStream(i, (s) =>
        s.map((e) =>
          is(e, 'tool_use')
            ? { ...e, input: { command: `  ${i.probe.command.replace(/ /g, '   ')}\n` } }
            : e,
        ),
      ),
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
    name: 'add a call with the nonce in another command',
    apply: (i) => withStream(i, (s) => [...s, toolUse(`echo ${NONCE} > elsewhere.txt`)]),
  },
  {
    name: 'drop the answers of the host',
    apply: (i) => withStream(i, (s) => s.filter((e) => !is(e, 'tool_result'))),
  },
  {
    name: 'add talk with the nonce in it',
    apply: (i) => withStream(i, (s) => [...s, { type: 'text', text: `I ran echo ${NONCE}` }]),
  },
  { name: 'hit a limit', apply: (i) => withRun(i, { limitHit: 'usage limit reached' }) },
  { name: 'time out', apply: (i) => withRun(i, { timedOut: true, exitCode: null }) },
  { name: 'exit with an error', apply: (i) => withRun(i, { exitCode: 1 }) },
  {
    name: 'end with an error result',
    apply: (i) =>
      withStream(i, (s) =>
        s.map((e) => (is(e, 'result') ? { ...e, isError: true, text: 'boom' } : e)),
      ),
  },
  {
    name: 'drop the final result',
    apply: (i) => withStream(i, (s) => s.filter((e) => !is(e, 'result'))),
  },
  { name: 'bill an API key', apply: (i) => withRun(i, { apiKeySource: 'ANTHROPIC_API_KEY' }) },
  { name: 'bill another provider', apply: (i) => withRun(i, { apiProvider: 'bedrock' }) },
  { name: 'lose some lines of the stream', apply: (i) => withRun(i, { unparsedLines: 2 }) },
  {
    name: 'put a null in the stream',
    apply: (i) => withStream(i, (s) => [null as unknown as StreamEvent, ...s]),
  },
  // What the hook's audit log says.
  { name: 'empty the audit log', apply: (i) => withAudit(i, () => []) },
  {
    name: 'make the hook say allow',
    apply: (i) => onEntries(i, { decision: { effect: 'allow', ruleId: null, reason: 'mutation' } }),
  },
  {
    name: 'make another rule decide',
    apply: (i) =>
      onEntries(i, {
        decision: { effect: 'deny', ruleId: 'deny-origin-suspect', reason: 'mutation' },
      }),
  },
  {
    name: 'judge the command twice',
    apply: (i) =>
      withAudit(i, (a) => [...a, ...a.map((entry) => ({ ...entry, seq: entry.seq + 1 }))]),
  },
  {
    name: 'judge another command as well',
    apply: (i) => withAudit(i, (a) => [...a, auditEntry({ seq: 9, summary: 'ls -la' })]),
  },
  {
    name: 'add an entry for the result',
    apply: (i) =>
      withAudit(i, (a) => [
        ...a,
        ...a.slice(0, 1).map((e) => ({ ...e, phase: 'post' as const, seq: 9 })),
      ]),
  },
  {
    name: 'give the entries another session',
    apply: (i) => onEntries(i, { sessionId: 'another' }),
  },
  {
    name: 'withhold the text of the entry',
    apply: (i) => onEntries(i, { summary: WITHHELD_SUMMARY }),
  },
  {
    name: 'redact the nonce out of the entry',
    apply: (i) => onEntries(i, { summary: 'echo [REDACTED]' }),
  },
  {
    name: 'fail to read the audit log',
    apply: (i) => ({ ...i, auditProblem: 'the audit log cannot be read' }),
  },
  // What is on the disk.
  {
    name: 'flip the file',
    apply: (i) => ({ ...i, sentinel: i.expectation.effect === 'allow' ? ABSENT : THERE }),
  },
  {
    name: 'not look at the file',
    apply: (i) => ({ ...i, sentinel: { exists: null, content: null } }),
  },
  {
    name: 'write something else in the file',
    apply: (i) => ({ ...i, sentinel: { exists: true, content: 'something else' } }),
  },
  {
    name: 'put something that is not a file there',
    apply: (i) => ({ ...i, sentinel: { exists: true, content: null } }),
  },
  // Things that go together when a host or a model misbehaves in one way.
  {
    name: 'make the model refuse: no call, no entry, no file',
    apply: (i) => ({
      ...withStream(i, (s) => s.filter((e) => !is(e, 'tool_use'))),
      audit: [],
      sentinel: ABSENT,
    }),
  },
  {
    name: 'make the hook never run: no entry, and the action ran',
    apply: (i) => ({
      ...i,
      audit: [],
      sentinel: i.expectation.effect === 'allow' ? i.sentinel : THERE,
    }),
  },
  // What the policy was seen to say.
  {
    name: 'expect another rule',
    apply: (i) => ({ ...i, expectation: { ...i.expectation, ruleId: 'deny-expected-elsewhere' } }),
  },
];
