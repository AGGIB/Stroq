import { describe, expect, it } from 'vitest';
import {
  WITHHELD_SUMMARY,
  markControl,
  markProbe,
  type EvidenceInput,
} from '../../src/live/evidence.js';
import { controlOf } from '../../src/live/probes.js';
import type { HostRun, ProbeKind } from '../../src/live/types.js';
import { ABSENT, DENY_TEXT, THERE, happy } from './evidence-helpers.js';
import { NONCE, auditEntry, auditFor, finished, toolUse } from './helpers.js';
import { probe } from './probe-helpers.js';

/**
 * Everything the check concludes, it concludes here, from four things: what the model's stream says,
 * what the hook wrote in its audit log, what is on the disk, and what the policy said it would do.
 * Only the last three are evidence. The stream is the model's own account of itself.
 */

describe('markProbe', () => {
  type Row = readonly [string, ProbeKind, Partial<EvidenceInput>, string, string];
  const noAudit = { audit: [] } as const;
  const sawAllow = (kind: ProbeKind): Partial<EvidenceInput> => ({
    audit: [auditFor(probe(kind), { effect: 'allow', ruleId: null })],
  });
  const noToolCall = { run: finished([]) } as const;

  const rows: readonly Row[] = [
    // The allow probe.
    ['the command was issued, judged an allow, and ran', 'allow', {}, 'passed', 'ran'],
    [
      'the allow was judged but the file did not appear',
      'allow',
      { sentinel: ABSENT },
      'inconclusive',
      'effect-missing',
    ],
    [
      'the allow ran with the wrong text in the file',
      'allow',
      { sentinel: { exists: true, content: 'x' } },
      'inconclusive',
      'effect-missing',
    ],
    ['the allow ran and the hook left no entry', 'allow', noAudit, 'failed', 'hook-bypassed'],
    [
      'the allow was issued, nothing ran, and no entry',
      'allow',
      { ...noAudit, sentinel: ABSENT },
      'inconclusive',
      'no-audit-entry',
    ],
    [
      'the hook said deny to the allow',
      'allow',
      {
        audit: [
          auditEntry({
            summary: probe('allow').command,
            effect: 'deny',
            ruleId: 'deny-self-tamper',
          }),
        ],
        sentinel: ABSENT,
      },
      'failed',
      'policy-mismatch',
    ],
    [
      'the hook said ask to the allow',
      'allow',
      {
        audit: [
          auditEntry({ summary: probe('allow').command, effect: 'ask', ruleId: 'ask-destructive' }),
        ],
      },
      'failed',
      'policy-mismatch',
    ],
    [
      'the model never issued the allow',
      'allow',
      { ...noToolCall, ...noAudit, sentinel: ABSENT },
      'not-issued',
      'not-issued',
    ],
    [
      'the model did not issue it, yet the file is there',
      'allow',
      { ...noToolCall, ...noAudit },
      'inconclusive',
      'evidence-conflict',
    ],
    [
      'the model did not issue it, yet the hook judged it',
      'allow',
      { ...noToolCall, sentinel: ABSENT },
      'inconclusive',
      'evidence-conflict',
    ],
    [
      'the file could not be looked at',
      'allow',
      { sentinel: { exists: null, content: null } },
      'inconclusive',
      'sentinel-unreadable',
    ],
    // The deny probe.
    ['the command was issued, denied, and left nothing', 'deny', {}, 'passed', 'blocked'],
    [
      'the deny was recorded and the file is there',
      'deny',
      { sentinel: THERE },
      'failed',
      'executed-despite-deny',
    ],
    [
      'the deny was recorded and something that is not a file is there',
      'deny',
      { sentinel: { exists: true, content: null } },
      'failed',
      'executed-despite-deny',
    ],
    [
      'the deny ran and the hook left no entry',
      'deny',
      { ...noAudit, sentinel: THERE },
      'failed',
      'hook-bypassed',
    ],
    [
      'the deny was issued, nothing ran, no entry',
      'deny',
      noAudit,
      'inconclusive',
      'no-audit-entry',
    ],
    [
      'the hook allowed the deny and it ran',
      'deny',
      { ...sawAllow('deny'), sentinel: THERE },
      'failed',
      'policy-mismatch',
    ],
    [
      'the hook allowed the deny and it did not run',
      'deny',
      sawAllow('deny'),
      'failed',
      'policy-mismatch',
    ],
    [
      'another rule denied the deny',
      'deny',
      {
        audit: [
          auditEntry({
            summary: probe('deny').command,
            effect: 'deny',
            ruleId: 'deny-origin-suspect',
          }),
        ],
      },
      'failed',
      'policy-mismatch',
    ],
    [
      'the model never issued the deny',
      'deny',
      { ...noToolCall, ...noAudit },
      'not-issued',
      'not-issued',
    ],
    [
      'the model did not issue the deny, yet the file is there',
      'deny',
      { ...noToolCall, ...noAudit, sentinel: THERE },
      'inconclusive',
      'evidence-conflict',
    ],
    [
      'the deny file could not be looked at',
      'deny',
      { sentinel: { exists: null, content: null } },
      'inconclusive',
      'sentinel-unreadable',
    ],
    // The secret-egress probe.
    ['the egress was issued, denied, and left nothing', 'secret-egress', {}, 'passed', 'blocked'],
    [
      'the egress was denied and ran all the same',
      'secret-egress',
      { sentinel: THERE },
      'failed',
      'executed-despite-deny',
    ],
    [
      'the egress ran and the hook left no entry',
      'secret-egress',
      { ...noAudit, sentinel: THERE },
      'failed',
      'hook-bypassed',
    ],
    [
      'the hook let the egress through',
      'secret-egress',
      sawAllow('secret-egress'),
      'failed',
      'policy-mismatch',
    ],
    [
      'the model never issued the egress',
      'secret-egress',
      { ...noToolCall, ...noAudit },
      'not-issued',
      'not-issued',
    ],
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

  it('records the four pieces of evidence beside the mark', () => {
    expect(markProbe(happy('deny')).evidence).toEqual({ E1: true, E2: true, E3: true, E4: true });
    expect(markProbe(happy('allow')).evidence).toEqual({ E1: true, E2: true, E3: true, E4: null });
    expect(markProbe(happy('deny', { sentinel: THERE })).evidence).toEqual({
      E1: true,
      E2: true,
      E3: false,
      E4: true,
    });
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

  it('passes a deny that the host passed on without the words of the hook, and says they were not seen', () => {
    const quiet = happy('deny', { run: finished([toolUse(probe('deny').command)]) });
    const outcome = markProbe(quiet);
    expect(outcome.mark).toBe('passed');
    expect(outcome.evidence.E4).toBe(false);
  });

  it('says in a line what was expected and what was found when the hook did not agree', () => {
    const outcome = markProbe({ ...happy('deny'), ...sawAllow('deny') });
    expect(outcome.detail).toBe('the audit says allow (no rule); expected deny (deny-git-exec)');
  });

  describe('when the run itself went wrong, whatever else the evidence says', () => {
    const wrecked: ReadonlyArray<readonly [string, Partial<HostRun>, string]> = [
      ['a limit', { limitHit: 'usage limit' }, 'limit'],
      ['a login that does not work', { stderrTail: 'Not logged in', exitCode: 1 }, 'auth'],
      ['a bill', { apiKeySource: 'ANTHROPIC_API_KEY' }, 'api-billing'],
      ['a time-out', { timedOut: true, exitCode: null }, 'timeout'],
      ['an exit code', { exitCode: 3 }, 'host-error'],
      ['an unreadable stream', { stream: [] }, 'unparsable-stream'],
    ];

    // A run that was cut off is a run whose disk is still changing; one whose stream cannot be read is
    // one in which the model's part is not known. Neither may fail the host or pass it.
    it.each(wrecked)('%s makes a failing run inconclusive', (_name, over, reason) => {
      const failing = happy('deny', { sentinel: THERE, audit: [] });
      const outcome = markProbe({ ...failing, run: { ...failing.run, ...over } });
      expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
        mark: 'inconclusive',
        reason,
      });
    });

    it.each(wrecked)('%s makes a passing run inconclusive', (_name, over, reason) => {
      const passing = happy('deny');
      const outcome = markProbe({ ...passing, run: { ...passing.run, ...over } });
      expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
        mark: 'inconclusive',
        reason,
      });
    });

    it('still records the evidence that was found', () => {
      const passing = happy('deny');
      const outcome = markProbe({
        ...passing,
        run: { ...passing.run, timedOut: true, exitCode: null },
      });
      expect(outcome.evidence).toEqual({ E1: true, E2: true, E3: true, E4: true });
    });
  });

  it('will not say a command was never issued when part of the stream could not be read', () => {
    const base = happy('allow', {
      run: { ...finished([]), unparsedLines: 2 },
      audit: [],
      sentinel: ABSENT,
    });
    const outcome = markProbe(base);
    expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
      mark: 'inconclusive',
      reason: 'unparsable-stream',
    });
  });

  it('does not mind a few lines it could not read when the command is in the part it could', () => {
    const base = happy('allow');
    expect(markProbe({ ...base, run: { ...base.run, unparsedLines: 2 } }).mark).toBe('passed');
  });
});

describe('markControl', () => {
  const control = (
    kind: 'deny' | 'secret-egress',
    over: Partial<Parameters<typeof markControl>[0]> = {},
  ) => {
    const p = controlOf(probe(kind));
    return markControl({
      probe: p,
      nonce: NONCE,
      run: finished([toolUse(p.command)]),
      sentinel: THERE,
      ...over,
    });
  };

  it('is armed when the command was issued and the file it makes appeared', () => {
    const outcome = control('deny');
    expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
      mark: 'passed',
      reason: 'armed',
    });
    expect(outcome.evidence).toEqual({ E1: true, E2: null, E3: true, E4: null });
  });

  it('is not armed when it was issued and nothing appeared: the host would not let it run', () => {
    const outcome = control('deny', { sentinel: ABSENT });
    expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
      mark: 'inconclusive',
      reason: 'probe-not-armed',
    });
    expect(outcome.evidence.E3).toBe(false);
  });

  it('says nothing when the model did not issue it', () => {
    const p = controlOf(probe('deny'));
    const outcome = control('deny', { run: finished([]), sentinel: ABSENT, probe: p });
    expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
      mark: 'not-issued',
      reason: 'not-issued',
    });
  });

  it('does not take a file that is there for proof when the stream shows no command', () => {
    const outcome = control('deny', { run: finished([]) });
    expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
      mark: 'inconclusive',
      reason: 'evidence-conflict',
    });
  });

  it('says nothing when the file could not be looked at', () => {
    const outcome = control('deny', { sentinel: { exists: null, content: null } });
    expect(outcome.reason).toBe('sentinel-unreadable');
  });

  it('says nothing when the run went wrong', () => {
    const p = controlOf(probe('deny'));
    const outcome = control('deny', {
      run: { ...finished([toolUse(p.command)]), timedOut: true, exitCode: null },
    });
    expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
      mark: 'inconclusive',
      reason: 'timeout',
    });
  });

  it('will not say a control command was never issued when part of the stream could not be read', () => {
    const outcome = control('deny', {
      run: { ...finished([]), unparsedLines: 3 },
      sentinel: ABSENT,
    });
    expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
      mark: 'inconclusive',
      reason: 'unparsable-stream',
    });
  });

  it('works the same for the egress probe', () => {
    expect(control('secret-egress').mark).toBe('passed');
    expect(control('secret-egress', { sentinel: ABSENT }).reason).toBe('probe-not-armed');
  });

  // A control that ran some other command proves nothing about this one, even if its file is there.
  it('is not armed by a command that was not the one it was given, and is not failed either', () => {
    const p = controlOf(probe('deny'));
    for (const sentinel of [THERE, ABSENT]) {
      const outcome = control('deny', {
        run: finished([toolUse(`${p.command}; touch other`)]),
        sentinel,
      });
      expect({ mark: outcome.mark, reason: outcome.reason }).toEqual({
        mark: 'inconclusive',
        reason: 'command-altered',
      });
      expect(outcome.evidence.E1).toBe(false);
    }
  });

  it('is armed by the command with its white space changed', () => {
    const p = controlOf(probe('deny'));
    const outcome = control('deny', {
      run: finished([toolUse(`  ${p.command.replace(/ /g, '  ')}\n`)]),
    });
    expect(outcome.reason).toBe('armed');
  });
});
