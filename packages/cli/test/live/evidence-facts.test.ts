import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@stroq/core';
import { handleClaudeHook } from '../../src/adapters/claude-code.js';
import { createEngineAt } from '../../src/engine-factory.js';
import {
  DENY_WORDING,
  gatherEvidence,
  plainText,
  type EvidenceInput,
} from '../../src/live/evidence.js';
import { prepareProject } from '../../src/live/probes.js';
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

  it('holds when a tool call carries the nonce', () => {
    expect(e1([toolUse(`echo ${NONCE} > stroq-live-allow.txt`)])).toBe(true);
  });

  it('holds when the nonce is deeper in what the call was given', () => {
    expect(e1([{ type: 'tool_use', name: 'Bash', input: { a: { b: ['x', NONCE] } } }])).toBe(true);
  });

  it('does not hold for the nonce of another request', () => {
    expect(e1([toolUse('echo stroq-live-ffffffffffffffff > stroq-live-allow.txt')])).toBe(false);
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

  it('holds for an entry of the session with the nonce, the effect and the rule that were expected', () => {
    const facts = audit([denied()]);
    expect(facts.E2).toBe(true);
    expect(facts.audit).toEqual({ state: 'agrees' });
  });

  it.each<[string, EvidenceInput['audit']]>([
    ['no entries', []],
    ['an entry of another session', [denied({ sessionId: 'someone-else' })]],
    ['an entry that is not for a PreToolUse', [denied({ phase: 'post' })]],
    ['an entry for another command', [denied({ summary: 'ls -la' })]],
    ['an entry in which the nonce was redacted', [denied({ summary: 'echo [REDACTED]' })]],
  ])('does not hold with %s: the hook is not seen', (_name, entries) => {
    const facts = audit(entries);
    expect(facts.E2).toBe(false);
    expect(facts.audit).toEqual({ state: 'absent' });
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

  // The first time the hook saw the command is the cleanest. A second try (the model was asked not
  // to, and may) can meet a session that the first has already tainted, and a different rule.
  it('goes by the first entry for the command, when the model tried more than once', () => {
    const agrees = audit([denied({ seq: 1 }), denied({ seq: 2, ruleId: 'deny-origin-suspect' })]);
    expect(agrees.E2).toBe(true);
    const differs = audit([denied({ seq: 1, effect: 'allow', ruleId: null }), denied({ seq: 2 })]);
    expect(differs.E2).toBe(false);
  });

  it('is not moved by entries of other sessions that carry the same nonce', () => {
    const facts = audit([
      denied({ sessionId: 'other', effect: 'allow', ruleId: null }),
      denied({ seq: 2 }),
    ]);
    expect(facts.E2).toBe(true);
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
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'stroq-live-e4-'));
      for (const dir of ['project', 'h', 's']) mkdirSync(join(root, dir));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('holds for what the adapter says to a host when it denies a probe', async () => {
      const project = join(root, 'project');
      prepareProject(project, FAKE);
      const engine = createEngineAt({
        home: join(root, 's'),
        userHome: join(root, 'h'),
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
