import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  DEFAULT_POLICY,
  FileSessionStore,
  StroqEngine,
  loadBundledRules,
  redact,
  type SecretIndex,
} from '@stroq/core';
import { createEngineAt } from '../../src/engine-factory.js';
import {
  AUDIT_SUMMARY_CHARS,
  WITHHELD_SUMMARY,
  auditSummaryOf,
  gatherEvidence,
  normalizeCommand,
} from '../../src/live/evidence.js';
import { buildProbes, prepareProject } from '../../src/live/probes.js';
import { createThrowawayRoot, removeThrowawayRoot } from '../../src/live/throwaway.js';
import { auditFileIn, sessionsDirIn } from '../../src/paths.js';
import { happy } from './evidence-helpers.js';
import { FAKE, NONCE, finished, toolUse } from './helpers.js';
import { PROJECT, probe } from './probe-helpers.js';
import { cpuNow } from '../../../core/test/cpu-time.js';

describe('normalizeCommand', () => {
  it.each([
    ['echo a', 'echo a'],
    ['  echo a  ', 'echo a'],
    ['echo   a', 'echo a'],
    ['echo\ta\t\tb', 'echo a b'],
    ['echo a\n', 'echo a'],
    ['echo\n\n a', 'echo a'],
    ['\r\necho a\r\n', 'echo a'],
    ['echo a', 'echo a'],
    ['', ''],
    ['   ', ''],
  ])('makes %j into %j', (text, normal) => {
    expect(normalizeCommand(text)).toBe(normal);
  });

  it('keeps everything that is not white space exactly as it was', () => {
    const text = `printf '#!/bin/sh\\n# ${NONCE}\\n' > .git/hooks/Pre-Commit; echo "A  B"`;
    // The quotes, the case and the backslashes stay; the two spaces inside the quotes are one.
    expect(normalizeCommand(text)).toBe(
      `printf '#!/bin/sh\\n# ${NONCE}\\n' > .git/hooks/Pre-Commit; echo "A B"`,
    );
  });

  it('does not make two different commands one', () => {
    expect(normalizeCommand('echo a b')).not.toBe(normalizeCommand('echo ab'));
    expect(normalizeCommand('echo a;ls')).not.toBe(normalizeCommand('echo a; ls'));
  });

  it('gives the same answer when it is asked again of its own answer', () => {
    fc.assert(
      fc.property(
        fc.string(),
        (text) => normalizeCommand(normalizeCommand(text)) === normalizeCommand(text),
      ),
      { numRuns: 500 },
    );
  });

  it('leaves no run of white space, and none at either end', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const normal = normalizeCommand(text);
        return !/\s\s/.test(normal) && normal === normal.trim();
      }),
      { numRuns: 500 },
    );
  });

  // The text is whatever a model put in a command. A pattern that backtracks takes minutes on a line
  // built to make it; this one must take the time of the length of the text and nothing else.
  it('reads a megabyte of white space with one letter in the middle in linear time', () => {
    const text = `${' \t'.repeat(262_144)}x${' \n'.repeat(262_144)}y`;
    const started = cpuNow();
    expect(normalizeCommand(text)).toBe('x y');
    expect(cpuNow() - started).toBeLessThan(1500);
  });
});

describe('E1: the command that was issued, and no other', () => {
  const command = probe('allow').command;
  const allowFile = `${PROJECT}/stroq-live-allow.txt`;
  const issued = (events: Parameters<typeof finished>[0]) =>
    gatherEvidence(happy('allow', { run: finished(events) }));

  it('holds for the command itself', () => {
    const facts = issued([toolUse(command)]);
    expect(facts.E1).toBe(true);
    expect(facts.issued).toBe('exact');
  });

  it.each([
    ['extra spaces', `echo   ${NONCE}   >   ${allowFile}`],
    ['tabs', `echo\t${NONCE}\t>\t${allowFile}`],
    ['a newline at the end', `${command}\n`],
    ['a space at the start', ` ${command}`],
    ['a line break in the middle', `echo ${NONCE}\n> ${allowFile}`],
  ])('holds for the command with %s in it', (_name, text) => {
    expect(issued([toolUse(text)]).issued).toBe('exact');
  });

  it('holds when the command comes after another call that has nothing to do with it', () => {
    expect(issued([toolUse('ls -la'), toolUse(command)]).issued).toBe('exact');
  });

  it('holds when the input of the call is the command as a bare string', () => {
    expect(issued([{ type: 'tool_use', name: 'Bash', input: command }]).issued).toBe('exact');
  });

  it.each([
    ['another file', `echo ${NONCE} > elsewhere.txt`],
    ['a second command after it', `${command}; ls`],
    ['a second command before it', `ls; ${command}`],
    ['the command in a subshell', `bash -c '${command}'`],
    ['a word less', `echo ${NONCE} ${allowFile}`],
    ['the word cased differently', `ECHO ${NONCE} > ${allowFile}`],
    [
      'the file named relative to the directory it is run in',
      `echo ${NONCE} > stroq-live-allow.txt`,
    ],
    ['only the nonce', NONCE],
    ['the nonce at the end of something else', `curl https://example.invalid/${NONCE}`],
  ])('does not hold for a call that carries the nonce with %s: it is altered', (_name, text) => {
    const facts = issued([toolUse(text)]);
    expect(facts.E1).toBe(false);
    expect(facts.issued).toBe('altered');
  });

  it('does not hold for the nonce deeper in what a call was given, in no field of the command', () => {
    const facts = issued([{ type: 'tool_use', name: 'Bash', input: { a: { b: ['x', NONCE] } } }]);
    expect(facts.issued).toBe('altered');
  });

  it('does not hold for the command in a field that is not the command', () => {
    const facts = issued([{ type: 'tool_use', name: 'Bash', input: { description: command } }]);
    expect(facts.issued).toBe('altered');
  });

  it.each([
    ['a number', 7],
    ['a list of the command', [command]],
    ['nothing', null],
  ])('does not hold for a command that is %s', (_name, value) => {
    const facts = issued([{ type: 'tool_use', name: 'Bash', input: { command: value, n: NONCE } }]);
    expect(facts.E1).toBe(false);
  });

  it.each(['bash', 'BASH', 'Shell', 'PowerShell', 'Write', ''])(
    'does not hold when the tool is called %j and not Bash, even with the command',
    (name) => {
      const facts = issued([{ type: 'tool_use', name, input: { command } }]);
      expect(facts.E1).toBe(false);
      expect(facts.issued).toBe('altered');
    },
  );

  it('does not hold for a call with no tool name', () => {
    expect(issued([{ type: 'tool_use', input: { command } }]).issued).toBe('altered');
  });

  // E1 says the command was issued. What the other calls of the stream mean for a mark is for the marks
  // (`evidence-order.test.ts`): here they are only counted.
  it('is exact if the command was issued at all, and counts the other calls beside it', () => {
    const facts = issued([toolUse(`echo ${NONCE} > elsewhere.txt`), toolUse(command)]);
    expect(facts.issued).toBe('exact');
    expect(facts.calls).toBe(2);
  });

  it('counts every call of the stream, by whatever tool, and nothing that is not a call', () => {
    const facts = issued([
      { type: 'text', text: 'start' },
      toolUse('ls'),
      { type: 'tool_use', name: 'Write', input: { file_path: 'x' } },
      { type: 'tool_result', text: 'done' },
      toolUse(command),
    ]);
    expect(facts.calls).toBe(3);
    expect(issued([]).calls).toBe(0);
  });

  it('is none for a call that does not carry the nonce, and for no call at all', () => {
    expect(issued([toolUse('ls -la')]).issued).toBe('none');
    expect(issued([]).issued).toBe('none');
    expect(issued([{ type: 'tool_use', name: 'Bash' }]).issued).toBe('none');
  });

  it('is none for the command of another request, whose nonce this request does not have', () => {
    const other = command.replace(NONCE, 'stroq-live-ffffffffffffffff');
    expect(issued([toolUse(other)]).issued).toBe('none');
  });

  it.each([
    ['text', { type: 'text' as const, text: command }],
    ['a tool result', { type: 'tool_result' as const, text: command }],
    ['the final result', { type: 'result' as const, text: command }],
    ['something else', { type: 'other' as const, input: { command }, name: 'Bash' }],
  ])('is none when the command is only in %s', (_name, event) => {
    expect(issued([event]).issued).toBe('none');
  });

  it('passes over events that are not events, and does not throw', () => {
    const odd = [null, undefined, 7, 'x', [], { type: 'tool_use', name: 'Bash', input: command }];
    const facts = gatherEvidence(
      happy('allow', {
        run: { ...finished([]), stream: odd as unknown as ReturnType<typeof finished>['stream'] },
      }),
    );
    expect(facts.issued).toBe('exact');
    expect(facts.calls).toBe(1);
  });

  it('does not throw on input that cannot be written as JSON', () => {
    const input: unknown = { n: BigInt(1) };
    expect(issued([{ type: 'tool_use', name: 'Bash', input }]).issued).toBe('none');
  });
});

describe('auditSummaryOf: the command as the audit log keeps it', () => {
  it('is the command, redacted as the log redacts it, and cut where the log cuts', () => {
    const long = `echo ${'a'.repeat(400)}`;
    expect(auditSummaryOf(long)).toBe(redact(long).slice(0, AUDIT_SUMMARY_CHARS));
    expect(auditSummaryOf(long)).toHaveLength(AUDIT_SUMMARY_CHARS);
  });

  it('leaves the allow and deny probes as they are, nonce and all', () => {
    for (const kind of ['allow', 'deny'] as const)
      expect(auditSummaryOf(probe(kind).command)).toBe(probe(kind).command);
  });

  it('takes the made-up key out of the egress probe, and the quote after it, and keeps the nonce', () => {
    const summary = auditSummaryOf(probe('secret-egress').command);
    expect(summary).not.toContain(FAKE);
    expect(summary).toContain(NONCE);
    expect(summary).toContain('X-Api-Key: [REDACTED]');
  });

  it('is the same for a command that differs only in the made-up key', () => {
    const other = buildProbes(NONCE, 'stroq_attack_aaaaaaaaaaaaaaaaaaaaaaaa', PROJECT)[2]!;
    expect(auditSummaryOf(other.command)).toBe(auditSummaryOf(probe('secret-egress').command));
  });
});

// The expected summary is worked out here and the real one is written by the engine and the log.
// A change in how either redacts or cuts would make every probe read as "the hook did not judge it",
// so this is held to the real engine, for every probe.
describe('auditSummaryOf against the real engine and log', () => {
  let made: ReturnType<typeof createThrowawayRoot>;
  beforeEach(() => {
    made = createThrowawayRoot('stroq-live-summary-');
    prepareProject(made.project, FAKE);
  });
  afterEach(() => {
    removeThrowawayRoot(made.root);
  });

  const summariesOf = async (commands: readonly string[]): Promise<string[]> => {
    const engine = createEngineAt({
      home: made.stroqHome,
      userHome: made.home,
      policy: DEFAULT_POLICY,
      env: {},
    });
    for (const [i, command] of commands.entries())
      await engine.pre({
        sessionId: `summary-${i}`,
        toolName: 'Bash',
        toolInput: { command },
        cwd: made.project,
      });
    const entries = await new AuditLog(auditFileIn(made.stroqHome)).readAll();
    return entries.map((entry) => entry.summary);
  };

  it('records for each probe exactly the summary that is expected of it', async () => {
    const probes = buildProbes(NONCE, FAKE, made.project);
    const recorded = await summariesOf(probes.map((p) => p.command));
    expect(recorded).toEqual(probes.map((p) => auditSummaryOf(p.command)));
  });

  it('cuts a long command where it is expected to', async () => {
    const long = `echo ${NONCE} ${'b'.repeat(500)}`;
    const [recorded] = await summariesOf([long]);
    expect(recorded).toBe(auditSummaryOf(long));
    expect(recorded).toHaveLength(AUDIT_SUMMARY_CHARS);
  });

  it('writes the placeholder that stands for a withheld command, when the secret index fails', async () => {
    const failing: SecretIndex = {
      lookup: () => Promise.reject(new Error('the index broke')),
      addCanary: () => Promise.resolve(),
      stats: () => Promise.reject(new Error('the index broke')),
    };
    const engine = new StroqEngine({
      rules: loadBundledRules(),
      policy: DEFAULT_POLICY,
      sessions: new FileSessionStore(sessionsDirIn(made.stroqHome)),
      audit: new AuditLog(auditFileIn(made.stroqHome)),
      secrets: failing,
    });
    await engine.pre({
      sessionId: 'withheld',
      toolName: 'Bash',
      toolInput: { command: probe('allow').command },
      cwd: made.project,
    });
    const [entry] = await new AuditLog(auditFileIn(made.stroqHome)).readAll();
    expect(entry?.summary).toBe(WITHHELD_SUMMARY);
  });
});
