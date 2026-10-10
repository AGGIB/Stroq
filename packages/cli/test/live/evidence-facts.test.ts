import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@stroq/core';
import { handleClaudeHook } from '../../src/adapters/claude-code.js';
import { createEngineAt } from '../../src/engine-factory.js';
import {
  DENY_WORDING,
  WITHHELD_SUMMARY,
  auditSummaryOf,
  gatherEvidence,
  plainText,
  type EvidenceInput,
} from '../../src/live/evidence.js';
import { prepareProject } from '../../src/live/probes.js';
import { createThrowawayRoot, removeThrowawayRoot } from '../../src/live/throwaway.js';
import type { ProbeKind, SentinelState, StreamEvent } from '../../src/live/types.js';
import { ABSENT, DENY_TEXT, KINDS, THERE, happy } from './evidence-helpers.js';
import { FAKE, NONCE, SESSION, auditEntry, finished, toolUse } from './helpers.js';
import { probe } from './probe-helpers.js';

/**
 * Everything the check concludes, it concludes here, from four things: what the model's stream says,
 * what the hook wrote in its audit log, what is on the disk, and what the policy said it would do.
 * Only the last three are evidence. The stream is the model's own account of itself.
 */

describe('E1: the model issued the command', () => {
  const e1 = (events: StreamEvent[]): boolean =>
    gatherEvidence(happy('allow', { run: finished(events) })).E1;

  it('holds when a tool call carries the command, with the nonce in it', () => {
    expect(e1([toolUse(`echo ${NONCE} > stroq-live-allow.txt`)])).toBe(true);
  });

  // The nonce somewhere in a call shows that the model can read its prompt. The command has to be the
  // command it was given (`evidence-command.test.ts` has the whole table of what that is).
  it('does not hold when the nonce is only deeper in what the call was given', () => {
    expect(e1([{ type: 'tool_use', name: 'Bash', input: { a: { b: ['x', NONCE] } } }])).toBe(false);
  });

  it('does not hold for the nonce of another request', () => {
    expect(e1([toolUse('echo stroq-live-ffffffffffffffff > stroq-live-allow.txt')])).toBe(false);
  });

  // A host may report a call's input as the command itself and not as an object around it.
  it('holds when the input of the call is the command as a bare string', () => {
    expect(
      e1([{ type: 'tool_use', name: 'Bash', input: `echo ${NONCE} > stroq-live-allow.txt` }]),
    ).toBe(true);
  });

  it('does not hold when the input of the call is a bare string that is not the command', () => {
    expect(e1([{ type: 'tool_use', name: 'Bash', input: `echo ${NONCE} > x` }])).toBe(false);
  });

  it.each([
    'echo stroq-live-ffffffffffffffff > x',
    'echo stroq-live- > x',
    `echo ${NONCE.slice(0, -1)} > x`,
  ])(
    'does not hold for a bare string with another nonce, or the start of this one, in it (%s)',
    (input) => {
      expect(e1([{ type: 'tool_use', name: 'Bash', input }])).toBe(false);
    },
  );

  it('does not hold for the start of the nonce in a structured input either', () => {
    expect(
      e1([{ type: 'tool_use', name: 'Bash', input: { command: 'echo stroq-live- > x' } }]),
    ).toBe(false);
  });

  // Anything a model says is cheap. A line of text, or the result of a call, with the nonce in it
  // shows that the model can read its prompt.
  it.each<[string, StreamEvent]>([
    ['text', { type: 'text', text: `I will run echo ${NONCE}` }],
    ['a tool result', { type: 'tool_result', text: NONCE }],
    ['the result', { type: 'result', text: NONCE }],
    ['the init message', { type: 'init', text: NONCE }],
    ['something else', { type: 'other', text: NONCE, input: { command: NONCE } }],
  ])('does not hold when the nonce is only in %s', (_name, event) => {
    expect(e1([event])).toBe(false);
  });

  it('does not hold for an empty stream, or a call with nothing in it', () => {
    expect(gatherEvidence(happy('allow', { run: { ...finished([]), stream: [] } })).E1).toBe(false);
    expect(e1([{ type: 'tool_use', name: 'Bash' }])).toBe(false);
  });

  it('does not throw on input that cannot be written as JSON', () => {
    const input: unknown = { n: BigInt(1) };
    expect(e1([{ type: 'tool_use', name: 'Bash', input }])).toBe(false);
  });
});

describe('E2: the hook judged the command, and as the policy said it would', () => {
  const audit = (entries: EvidenceInput['audit']): ReturnType<typeof gatherEvidence> =>
    gatherEvidence(happy('deny', { audit: entries }));
  const command = probe('deny').command;
  const denied = (over = {}): ReturnType<typeof auditEntry> =>
    auditEntry({ summary: command, effect: 'deny', ruleId: 'deny-git-exec', ...over });

  it('holds for the one entry of the hook, with the command, the effect and the rule that were expected', () => {
    const facts = audit([denied()]);
    expect(facts.E2).toBe(true);
    expect(facts.audit).toEqual({ state: 'agrees' });
  });

  it('does not hold, and says the hook never ran, when the log of the hook has nothing in it', () => {
    const facts = audit([]);
    expect(facts.E2).toBe(false);
    expect(facts.audit).toEqual({ state: 'empty' });
  });

  // Entries are there, so the hook ran; none of them is for this command, so nothing is known of what it
  // made of it. That is not the same as the hook never having run.
  it.each<[string, EvidenceInput['audit']]>([
    ['an entry that is not for a PreToolUse', [denied({ phase: 'post' })]],
    ['an entry for another command', [denied({ summary: 'ls -la' })]],
    ['an entry in which the nonce was redacted', [denied({ summary: 'echo [REDACTED]' })]],
    ['an entry for this command made for another tool', [denied({ tool: 'Read' })]],
    ['an entry for this command and something after it', [denied({ summary: `${command} && ls` })]],
    ['an entry that is the start of this command', [denied({ summary: command.slice(0, -5) })]],
  ])('does not hold with %s: no entry of the hook is for this command', (_name, entries) => {
    const facts = audit(entries);
    expect(facts.E2).toBe(false);
    expect(facts.audit).toEqual({ state: 'nonce-missing' });
  });

  it('holds for an entry of any session: the home is made for this check and the nonce is unique', () => {
    const facts = audit([denied({ sessionId: 'a-session-the-host-chose' })]);
    expect(facts.E2).toBe(true);
    expect(facts.audit).toEqual({ state: 'agrees' });
  });

  // The log is a file; one that was edited by hand, or written by something else, can hold an entry of
  // any shape, and reading it must not take the check down.
  it('passes over an entry that has no summary to look in', () => {
    const { summary: _dropped, ...withoutSummary } = denied();
    const odd = { ...withoutSummary, summary: 42 } as unknown as EvidenceInput['audit'][number];
    for (const entry of [withoutSummary as EvidenceInput['audit'][number], odd]) {
      const facts = audit([entry]);
      expect(facts.E2).toBe(false);
      expect(facts.audit).toEqual({ state: 'nonce-missing' });
    }
  });

  it('does not hold when the effect is not the one expected, and says what was seen', () => {
    const facts = audit([denied({ effect: 'allow', ruleId: null })]);
    expect(facts.E2).toBe(false);
    expect(facts.audit).toEqual({ state: 'differs', saw: { effect: 'allow', ruleId: null } });
  });

  it('does not hold when another rule decided', () => {
    const facts = audit([denied({ ruleId: 'deny-origin-suspect' })]);
    expect(facts.audit).toEqual({
      state: 'differs',
      saw: { effect: 'deny', ruleId: 'deny-origin-suspect' },
    });
  });

  it('does not hold when an ask was recorded', () => {
    expect(audit([denied({ effect: 'ask', ruleId: 'ask-self-touch' })]).E2).toBe(false);
  });

  it('does not hold for an entry with no decision in it', () => {
    const { decision: _dropped, ...withoutDecision } = denied();
    const facts = audit([withoutDecision]);
    expect(facts.E2).toBe(false);
    expect(facts.audit).toMatchObject({ state: 'differs' });
  });

  // Exactly one. A command judged twice (the model was asked not to try again, and may) meets a session
  // the first try has tainted and a rule of its own, and a hook that judged something else as well was
  // asked about more than the one command.
  describe('exactly one entry for the command, and no other entry of the hook', () => {
    it('does not hold when the command was judged twice, whatever each time said', () => {
      for (const second of [
        denied({ seq: 2 }),
        denied({ seq: 2, ruleId: 'deny-origin-suspect' }),
      ]) {
        const facts = audit([denied({ seq: 1 }), second]);
        expect(facts.E2).toBe(false);
        expect(facts.audit).toEqual({ state: 'extra' });
      }
      expect(
        audit([denied({ seq: 1, effect: 'allow', ruleId: null }), denied({ seq: 2 })]).audit,
      ).toEqual({ state: 'extra' });
    });

    it('does not hold when the command was judged and so was another', () => {
      const facts = audit([denied({ seq: 1 }), denied({ seq: 2, summary: 'ls -la' })]);
      expect(facts.E2).toBe(false);
      expect(facts.audit).toEqual({ state: 'extra' });
    });

    it('counts an entry of another session that carries the same nonce', () => {
      const facts = audit([
        denied({ sessionId: 'other', effect: 'allow', ruleId: null }),
        denied({ seq: 2 }),
      ]);
      expect(facts.audit).toEqual({ state: 'extra' });
    });

    it('does not count what the hook wrote after the call: its entry for the result is not a second judgement', () => {
      const facts = audit([denied({ seq: 1 }), denied({ seq: 2, phase: 'post' })]);
      expect(facts.E2).toBe(true);
    });
  });

  describe('when the text of the entry cannot be had', () => {
    it('does not hold, and does not blame the hook, when the audit log could not be read', () => {
      const facts = gatherEvidence(
        happy('deny', { audit: [denied()], auditProblem: 'the audit log cannot be read' }),
      );
      expect(facts.E2).toBeNull();
      expect(facts.audit).toEqual({ state: 'unread', why: 'the audit log cannot be read' });
    });

    it('does not hold when the hook wrote the placeholder it writes when it cannot check for secrets', () => {
      const facts = audit([denied({ summary: WITHHELD_SUMMARY })]);
      expect(facts.E2).toBeNull();
      expect(facts.audit).toMatchObject({ state: 'unread' });
    });

    it('prefers the entry that is there to the placeholder of another', () => {
      const facts = audit([denied({ seq: 1, summary: WITHHELD_SUMMARY }), denied({ seq: 2 })]);
      expect(facts.audit).toEqual({ state: 'extra' });
    });
  });

  // The egress probe carries a made-up key, and the log keeps the command without it. The expected
  // summary is made the way the log makes it, so the two are compared as the log has them.
  it('holds for the egress probe whose key the log has taken out', () => {
    const egress = probe('secret-egress');
    const facts = gatherEvidence(happy('secret-egress'));
    expect(facts.E2).toBe(true);
    expect(facts.audit).toEqual({ state: 'agrees' });
    expect(egress.command).toContain(FAKE);
    expect(auditSummaryOf(egress.command)).not.toContain(FAKE);
  });
});

describe('E3: the file on the disk is as the decision says', () => {
  const e3 = (kind: ProbeKind, sentinel: SentinelState): boolean | null =>
    gatherEvidence(happy(kind, { sentinel })).E3;

  it('holds for an allow when the file is there with the nonce, whatever whitespace follows it', () => {
    expect(e3('allow', { exists: true, content: NONCE })).toBe(true);
    expect(e3('allow', { exists: true, content: `${NONCE}\n` })).toBe(true);
    expect(e3('allow', { exists: true, content: `  ${NONCE}\r\n` })).toBe(true);
  });

  it.each<[string, SentinelState]>([
    ['another nonce', { exists: true, content: 'stroq-live-ffffffffffffffff\n' }],
    ['more than the nonce', { exists: true, content: `${NONCE} and more\n` }],
    ['the nonce twice', { exists: true, content: `${NONCE}\n${NONCE}\n` }],
    ['nothing in it', { exists: true, content: '' }],
    ['something that is not a regular file', { exists: true, content: null }],
    ['no file', ABSENT],
  ])('does not hold for an allow when the file has %s', (_name, sentinel) => {
    expect(e3('allow', sentinel)).toBe(false);
  });

  it.each<ProbeKind>(['deny', 'secret-egress'])('holds for a %s when there is no file', (kind) => {
    expect(e3(kind, ABSENT)).toBe(true);
  });

  it.each<ProbeKind>(['deny', 'secret-egress'])(
    'does not hold for a %s when anything is there, a file or not',
    (kind) => {
      expect(e3(kind, THERE)).toBe(false);
      expect(e3(kind, { exists: true, content: null })).toBe(false);
      expect(e3(kind, { exists: true, content: '' })).toBe(false);
    },
  );

  it.each<ProbeKind>(KINDS)('says nothing when the path could not be looked at (%s)', (kind) => {
    expect(e3(kind, { exists: null, content: null })).toBeNull();
  });

  // The decision is the one source: whether the file is meant to be there follows from what the policy
  // said, and from nothing the probe carries beside it.
  it('follows the decision that was expected and not anything else the probe says', () => {
    const asDeny = gatherEvidence(
      happy('allow', { expectation: { effect: 'deny', ruleId: 'deny-git-exec' }, sentinel: THERE }),
    );
    expect(asDeny.E3).toBe(false);
    const asAllow = gatherEvidence(
      happy('deny', { expectation: { effect: 'allow', ruleId: null }, sentinel: THERE }),
    );
    expect(asAllow.E3).toBe(true);
  });
});

describe('E4: the host passed on the words of the hook', () => {
  const e4 = (events: StreamEvent[], kind: ProbeKind = 'deny'): boolean | null =>
    gatherEvidence(happy(kind, { run: finished(events) })).E4;

  it('holds when the result of the call carries the deny wording with the rule that was expected', () => {
    expect(e4([toolUse('x'), DENY_TEXT('deny-git-exec')])).toBe(true);
    expect(e4([toolUse('x'), DENY_TEXT('deny-secret-egress')], 'secret-egress')).toBe(true);
  });

  it('does not hold for the wording of another rule', () => {
    expect(e4([toolUse('x'), DENY_TEXT('deny-origin-suspect')])).toBe(false);
  });

  it('does not hold when the host blocked in its own words', () => {
    expect(
      e4([
        toolUse('x'),
        { type: 'tool_result', isError: true, text: 'Permission to use Bash has been denied.' },
      ]),
    ).toBe(false);
  });

  it('does not take the model saying it, or a call that quotes it', () => {
    expect(
      e4([
        { type: 'text', text: 'Stroq blocked this action (deny-git-exec): ok' },
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'Stroq blocked this action (deny-git-exec)' },
        },
      ]),
    ).toBe(false);
  });

  it('has nothing to say for an allow', () => {
    expect(e4([toolUse('x')], 'allow')).toBeNull();
  });

  // The wording is the one every adapter writes. If an adapter changes it, E4 stops being able to
  // hold, quietly; this takes the words from the adapter itself.
  describe('against the Claude Code adapter', () => {
    let made: ReturnType<typeof createThrowawayRoot>;
    beforeEach(() => {
      made = createThrowawayRoot('stroq-live-e4-');
    });
    afterEach(() => {
      removeThrowawayRoot(made.root);
    });

    it('holds for what the adapter says to a host when it denies a probe', async () => {
      const project = made.project;
      prepareProject(project, FAKE);
      const engine = createEngineAt({
        home: made.stroqHome,
        userHome: made.home,
        policy: DEFAULT_POLICY,
        env: {},
      });
      for (const kind of ['deny', 'secret-egress'] as const) {
        const p = probe(kind);
        const out = await handleClaudeHook(engine, {
          session_id: SESSION,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: p.command },
          cwd: project,
        });
        const reason = (
          JSON.parse(out.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }
        ).hookSpecificOutput.permissionDecisionReason;
        expect(reason.startsWith(DENY_WORDING)).toBe(true);
        const host: StreamEvent = { type: 'tool_result', isError: true, text: reason };
        expect(gatherEvidence(happy(kind, { run: finished([toolUse(p.command), host]) })).E4).toBe(
          true,
        );
      }
    });
  });
});

describe('plainText', () => {
  it('makes one line of plain characters, whatever it is given, and keeps it short', () => {
    expect(plainText('a\nb\t c\u001b[2J é')).toBe('a b c?[2J ?');
    expect(plainText('x'.repeat(500))).toHaveLength(160);
    expect(plainText('x'.repeat(500), 20)).toHaveLength(20);
  });
});
