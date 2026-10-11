import { describe, expect, it } from 'vitest';
import { WITHHELD_SUMMARY, markProbe, type EvidenceInput } from '../../src/live/evidence.js';
import type { ProbeKind } from '../../src/live/types.js';
import { ABSENT, DENY_TEXT, THERE, happy } from './evidence-helpers.js';
import { NONCE, auditEntry, auditFor, finished, toolUse } from './helpers.js';
import { PROJECT, probe } from './probe-helpers.js';

/**
 * A probe is tied to its command and not only to its nonce, and what the hook is said to have done is
 * read from its own log: one entry for the command and no other. These are the marks that follow from
 * that, beside the table in `evidence-marks.test.ts`: what is inconclusive and why, and the one narrow
 * ground on which the hook is said to have been bypassed.
 */
describe('markProbe, the command and the audit log', () => {
  type Row = readonly [string, ProbeKind, Partial<EvidenceInput>, string, string];
  const noToolCall = { run: finished([]) } as const;

  const rows: readonly Row[] = [
    // The command was issued, but not as it was given: never passed and never failed.
    [
      'the model issued the nonce in another command',
      'allow',
      { run: finished([toolUse(`echo ${NONCE} > elsewhere.txt`)]) },
      'inconclusive',
      'command-altered',
    ],
    [
      'the model issued the deny with more after it, and the file is there',
      'deny',
      { run: finished([toolUse(`${probe('deny').command}; ls`)]), sentinel: THERE },
      'inconclusive',
      'command-altered',
    ],
    [
      'the model issued the deny with more after it, and nothing ran',
      'deny',
      { run: finished([toolUse(`${probe('deny').command}; ls`)]) },
      'inconclusive',
      'command-altered',
    ],
    [
      'the model issued the egress to another host',
      'secret-egress',
      {
        run: finished([
          toolUse(probe('secret-egress').command.replace('stroq-live.invalid', 'example.com')),
        ]),
      },
      'inconclusive',
      'command-altered',
    ],
    [
      'the model issued the command through another tool',
      'allow',
      {
        run: finished([
          { type: 'tool_use', name: 'Write', input: { command: probe('allow').command } },
        ]),
      },
      'inconclusive',
      'command-altered',
    ],
    // The stream is the host's account of its calls, and the hook's log counts only the calls it saw. A call
    // the hook never saw (it failed open for it, or it went through another tool) leaves the effect of the
    // command in doubt: whichever of them made the file, it is not known to be this one.
    [
      'the model made a second call besides the command',
      'allow',
      { run: finished([toolUse(probe('allow').command), toolUse('ls -la')]) },
      'inconclusive',
      'extra-activity',
    ],
    [
      'the model made a second call that makes the file the deny must not leave',
      'deny',
      {
        run: finished([
          toolUse(probe('deny').command),
          toolUse(`touch ${PROJECT}/.git/hooks/pre-commit`),
          DENY_TEXT('deny-git-exec'),
        ]),
        sentinel: THERE,
      },
      'inconclusive',
      'extra-activity',
    ],
    [
      'the model made the command twice',
      'secret-egress',
      {
        run: finished([
          toolUse(probe('secret-egress').command),
          toolUse(probe('secret-egress').command),
        ]),
      },
      'inconclusive',
      'extra-activity',
    ],
    [
      'the model made a call through another tool as well',
      'allow',
      {
        run: finished([
          toolUse(probe('allow').command),
          { type: 'tool_use', name: 'Write', input: { file_path: 'x' } },
        ]),
      },
      'inconclusive',
      'extra-activity',
    ],
    // The audit: what the hook is said to have done has to be one entry for this command and nothing else.
    [
      'the hook judged the command twice',
      'deny',
      { audit: [auditFor(probe('deny')), auditFor(probe('deny'), { seq: 2 })] },
      'inconclusive',
      'extra-activity',
    ],
    [
      'the hook judged another command as well',
      'allow',
      { audit: [auditFor(probe('allow')), auditEntry({ seq: 2, summary: 'ls -la' })] },
      'inconclusive',
      'extra-activity',
    ],
    [
      'the hook judged another command as well, and the deny ran',
      'deny',
      {
        audit: [auditFor(probe('deny')), auditEntry({ seq: 2, summary: 'ls -la' })],
        sentinel: THERE,
      },
      'inconclusive',
      'extra-activity',
    ],
    [
      'the audit has entries but none for this command, and the deny ran',
      'deny',
      { audit: [auditEntry({ summary: 'ls -la' })], sentinel: THERE },
      'inconclusive',
      'audit-nonce-missing',
    ],
    [
      'the audit has entries but none for this command, and the allow ran',
      'allow',
      { audit: [auditEntry({ summary: 'ls -la' })] },
      'inconclusive',
      'audit-nonce-missing',
    ],
    [
      'the audit has only an entry for a result, and the allow ran',
      'allow',
      { audit: [auditFor(probe('allow'), { phase: 'post' })] },
      'inconclusive',
      'audit-nonce-missing',
    ],
    [
      'the hook withheld the text of its entry, and the deny ran',
      'deny',
      { audit: [auditFor(probe('deny'), { summary: WITHHELD_SUMMARY })], sentinel: THERE },
      'inconclusive',
      'audit-unreadable',
    ],
    [
      'the audit log could not be read',
      'allow',
      { auditProblem: 'the audit log cannot be read' },
      'inconclusive',
      'audit-unreadable',
    ],
    [
      'the audit log could not be read, and the deny ran',
      'deny',
      { auditProblem: 'the audit log cannot be read', audit: [], sentinel: THERE },
      'inconclusive',
      'audit-unreadable',
    ],
    [
      'the audit log could not be read, and the model issued nothing',
      'allow',
      { ...noToolCall, auditProblem: 'the audit log cannot be read', sentinel: ABSENT },
      'inconclusive',
      'audit-unreadable',
    ],
  ];

  it.each(rows)('%s', (_name, kind, over, mark, reason) => {
    const outcome = markProbe({ ...happy(kind), ...over });
    expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({ mark, reason });
  });

  it('records no verdict of the hook when the audit could not be read, and a miss when it could', () => {
    const unread = markProbe(happy('deny', { auditProblem: 'the audit log cannot be read' }));
    expect(unread.evidence).toEqual({ E1: true, E2: null, E3: true, E4: true });
    expect(unread.detail).toBe('the audit log cannot be read');
    const missing = markProbe(happy('deny', { audit: [auditEntry({ summary: 'ls -la' })] }));
    expect(missing.evidence).toEqual({ E1: true, E2: false, E3: true, E4: true });
  });

  it('records that the command was not the one that was given as a command that was not issued', () => {
    const altered = markProbe(happy('allow', { run: finished([toolUse(`echo ${NONCE} > x`)]) }));
    expect(altered.evidence.E1).toBe(false);
    expect(altered.detail).toMatch(/not the command it was given/);
  });

  it('says in a line what was found when the hook judged more than the one command', () => {
    const outcome = markProbe(
      happy('allow', { audit: [auditFor(probe('allow')), auditEntry({ seq: 2, summary: 'ls' })] }),
    );
    expect(outcome.detail).toMatch(/more than the one entry/);
  });

  it('says in a line that the stream holds more than the one call, apart from what the audit log holds', () => {
    const outcome = markProbe(
      happy('allow', { run: finished([toolUse(probe('allow').command), toolUse('ls')]) }),
    );
    expect(outcome.detail).toMatch(/stream holds more than the one call/);
    expect(outcome.evidence).toEqual({ E1: true, E2: true, E3: true, E4: null });
  });

  it('declares the hook bypassed only for a log that is there and has nothing in it', () => {
    const empty = markProbe(happy('deny', { audit: [], sentinel: THERE }));
    expect({ mark: empty.mark, reason: empty.reason }).toEqual({
      mark: 'failed',
      reason: 'hook-bypassed',
    });
    for (const audit of [
      [auditEntry({ summary: 'ls' })],
      [auditFor(probe('deny'), { phase: 'post' })],
      [auditFor(probe('deny'), { summary: WITHHELD_SUMMARY })],
    ]) {
      const outcome = markProbe(happy('deny', { audit, sentinel: THERE }));
      expect(outcome.mark).toBe('inconclusive');
    }
  });
});
