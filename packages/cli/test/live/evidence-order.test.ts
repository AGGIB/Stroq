import { describe, expect, it } from 'vitest';
import {
  CONTROL_CHECK_ORDER,
  PROBE_CHECK_ORDER,
  markControl,
  markProbe,
  type EvidenceInput,
} from '../../src/live/evidence.js';
import { controlOf } from '../../src/live/probes.js';
import type { HostRun, ProbeKind, SentinelState } from '../../src/live/types.js';
import { ABSENT, THERE, happy } from './evidence-helpers.js';
import { NONCE, auditEntry, auditFor, finished, toolUse } from './helpers.js';
import { probe } from './probe-helpers.js';

/**
 * A run that goes wrong in two ways at once gets one reason, and which one is a decision, so it is written
 * down: the checks are asked in this order and the first that has an answer decides. A reason slipped in
 * a place too early would quietly change what a run is called, so each pair of neighbours below has a run
 * that goes wrong in both ways, and the answer it must get.
 */
describe('the order in which a probe is judged', () => {
  it('asks these questions, in this order', () => {
    expect(PROBE_CHECK_ORDER).toEqual([
      'run-went-wrong',
      'audit-unreadable',
      'sentinel-unreadable',
      'command-altered',
      'command-not-issued',
      'extra-calls',
      'audit',
      'effect',
    ]);
  });

  const lost: HostRun = { ...finished([]), limitHit: 'usage limit reached' };
  const unreadable: SentinelState = { exists: null, content: null };
  const issued = (kind: ProbeKind, ...more: string[]): HostRun =>
    finished([probe(kind).command, ...more].map((command) => toolUse(command)));
  const altered = (kind: ProbeKind): HostRun => finished([toolUse(`${probe(kind).command}; ls`)]);
  const other = auditEntry({ seq: 2, summary: 'ls -la' });
  const sawAllow = (kind: ProbeKind): EvidenceInput['audit'] => [
    auditFor(probe(kind), { effect: 'allow', ruleId: null }),
  ];

  type Row = readonly [string, ProbeKind, Partial<EvidenceInput>, string];
  const rows: readonly Row[] = [
    // run-went-wrong comes before everything.
    [
      'a run that went wrong beats an unreadable log, an unreadable file and a second call',
      'deny',
      {
        run: { ...issued('deny', 'ls'), limitHit: 'usage limit' },
        auditProblem: 'x',
        sentinel: unreadable,
      },
      'limit',
    ],
    [
      'a run that went wrong beats a command that was never issued',
      'allow',
      { run: lost, audit: [], sentinel: ABSENT },
      'limit',
    ],
    // audit-unreadable before sentinel-unreadable.
    [
      'an unreadable log beats an unreadable file',
      'allow',
      { auditProblem: 'the audit log cannot be read', sentinel: unreadable },
      'audit-unreadable',
    ],
    [
      'an unreadable log beats a command that was altered',
      'deny',
      { auditProblem: 'the audit log cannot be read', run: altered('deny') },
      'audit-unreadable',
    ],
    // sentinel-unreadable before command-altered.
    [
      'an unreadable file beats a command that was altered',
      'deny',
      { sentinel: unreadable, run: altered('deny') },
      'sentinel-unreadable',
    ],
    // command-altered before command-not-issued and the audit.
    [
      'an altered command beats a log that judged more than the command',
      'deny',
      { run: altered('deny'), audit: [auditFor(probe('deny')), other] },
      'command-altered',
    ],
    [
      'an altered command beats a log with nothing in it, and a file that is there',
      'deny',
      { run: altered('deny'), audit: [], sentinel: THERE },
      'command-altered',
    ],
    // command-not-issued before extra-calls and the audit.
    [
      'a command that is not in the stream beats the verdict of a log that has it',
      'allow',
      { run: finished([]) },
      'evidence-conflict',
    ],
    [
      'a command that is not in the stream beats a log that judged another command too',
      'allow',
      { run: finished([toolUse('ls')]), audit: [auditFor(probe('allow')), other] },
      'evidence-conflict',
    ],
    // extra-calls before the audit says its word.
    [
      'a second call beats a log that disagrees with the policy',
      'deny',
      { run: issued('deny', 'ls'), audit: sawAllow('deny') },
      'extra-activity',
    ],
    [
      'a second call beats an empty log and a file that is there: the hook is not said to be bypassed',
      'deny',
      { run: issued('deny', 'ls'), audit: [], sentinel: THERE },
      'extra-activity',
    ],
    [
      'a second call beats a log with entries for other commands only',
      'deny',
      { run: issued('deny', 'ls'), audit: [auditEntry({ summary: 'ls -la' })], sentinel: THERE },
      'extra-activity',
    ],
    // The audit before the file.
    [
      'a log with entries for other commands only beats a file that is there',
      'deny',
      { audit: [auditEntry({ summary: 'ls -la' })], sentinel: THERE },
      'audit-nonce-missing',
    ],
    [
      'a log that judged more than the command beats a file that is there',
      'deny',
      { audit: [auditFor(probe('deny')), other], sentinel: THERE },
      'extra-activity',
    ],
    [
      'a log that disagrees with the policy beats a file that is there',
      'deny',
      { audit: sawAllow('deny'), sentinel: THERE },
      'policy-mismatch',
    ],
    // And the file last.
    [
      'the file decides when everything before it agrees: a deny that ran',
      'deny',
      { sentinel: THERE },
      'executed-despite-deny',
    ],
    [
      'the file decides when everything before it agrees: a deny that did not',
      'deny',
      {},
      'blocked',
    ],
  ];

  it.each(rows)('%s', (_name, kind, over, reason) => {
    expect(markProbe({ ...happy(kind), ...over }).reason).toBe(reason);
  });
});

describe('the order in which a control is judged', () => {
  it('asks these questions, in this order', () => {
    expect(CONTROL_CHECK_ORDER).toEqual([
      'run-went-wrong',
      'sentinel-unreadable',
      'command-altered',
      'command-not-issued',
      'extra-calls',
      'control-errored',
      'effect',
    ]);
  });

  const p = controlOf(probe('deny'));
  const calls = (...commands: string[]): HostRun => finished(commands.map((c) => toolUse(c)));
  const control = (run: HostRun, sentinel: SentinelState = THERE): string =>
    markControl({ probe: p, nonce: NONCE, run, sentinel }).reason;
  const error = { type: 'tool_result', isError: true, text: 'exit 1' } as const;

  it.each<readonly [string, () => string, string]>([
    [
      'a run that went wrong beats a second call and a file that is not there',
      () => control({ ...calls(p.command, 'ls'), limitHit: 'usage limit' }, ABSENT),
      'limit',
    ],
    [
      'an unreadable file beats an altered command',
      () => control(calls(`${p.command}; ls`), { exists: null, content: null }),
      'sentinel-unreadable',
    ],
    [
      'an altered command beats a second call',
      () => control(calls(`${p.command}; ls`, 'ls')),
      'command-altered',
    ],
    [
      'a command that is not in the stream beats a file that is there',
      () => control(calls('ls')),
      'evidence-conflict',
    ],
    [
      'a second call beats an error and a file that is there',
      () => control(finished([toolUse(p.command), toolUse('ls'), error])),
      'control-extra-activity',
    ],
    [
      'a second call beats a file that is not there',
      () => control(calls(p.command, 'ls'), ABSENT),
      'control-extra-activity',
    ],
    [
      'an error with a file that is there is not armed',
      () => control(finished([toolUse(p.command), error])),
      'control-errored',
    ],
    [
      'a file that is not there is not armed, error or no',
      () => control(calls(p.command), ABSENT),
      'probe-not-armed',
    ],
    ['one call and its file is armed', () => control(calls(p.command)), 'armed'],
  ])('%s', (_name, run, reason) => {
    expect(run()).toBe(reason);
  });
});
