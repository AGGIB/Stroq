import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, type AuditEntry, type Policy } from '@stroq/core';
import { createEngineAt } from '../../src/engine-factory.js';
import { buildProbes, prepareProject } from '../../src/live/probes.js';
import { createThrowawayRoot, removeThrowawayRoot } from '../../src/live/throwaway.js';
import { FAKE, NONCE, expectationOf } from './helpers.js';
import { probe } from './probe-helpers.js';

let root: string;
let project: string;
let userHome: string;
let stroqHome: string;

beforeEach(() => {
  ({ root, project, home: userHome, stroqHome } = createThrowawayRoot('stroq-live-golden-'));
});
afterEach(() => {
  removeThrowawayRoot(root);
});

// ---------------------------------------------------------------------------------------------
// The golden test. Rules match action CLASSES and not commands, so a probe works only while the
// default policy denies the class its command falls in. This runs each probe through the real engine
// with the default policy, in a throwaway home, and compares the decision and the rule with what
// the probe says it expects; a change to the policy, the classifier or the secret index that disarms
// a probe fails here and not in front of a user.
describe('the probes against the default policy, through the real engine', () => {
  const decide = async (policy: Policy, kind: 'allow' | 'deny' | 'secret-egress') => {
    prepareProject(project, FAKE);
    const engine = createEngineAt({ home: stroqHome, userHome, policy, env: {} });
    const p = probe(kind);
    const result = await engine.pre({
      sessionId: `golden-${kind}`,
      toolName: 'Bash',
      toolInput: { command: p.command },
      cwd: project,
    });
    return { result, p };
  };

  it.each(['allow', 'deny', 'secret-egress'] as const)(
    'decides the %s probe as the probe says it will be decided',
    async (kind) => {
      const { result, p } = await decide(DEFAULT_POLICY, kind);
      expect({ effect: result.decision.effect, ruleId: result.decision.ruleId }).toEqual(
        p.expected,
      );
      expect(p.expected).toEqual(expectationOf(p));
    },
  );

  it('puts the deny probe in the class of a repository hook, and the egress probe in that of a leaked secret', async () => {
    expect((await decide(DEFAULT_POLICY, 'deny')).result.classes).toEqual(['config.git_exec']);
    const egress = (await decide(DEFAULT_POLICY, 'secret-egress')).result;
    expect(egress.classes).toEqual(expect.arrayContaining(['shell.network', 'secret.egress']));
    expect(egress.secrets.map((hit) => hit.name)).toEqual(['STROQ_LIVE_API_KEY']);
  });

  it('leaves the nonce of every command in the summary the audit log keeps', async () => {
    prepareProject(project, FAKE);
    const engine = createEngineAt({ home: stroqHome, userHome, policy: DEFAULT_POLICY, env: {} });
    for (const p of buildProbes(NONCE, FAKE)) {
      await engine.pre({
        sessionId: `audit-${p.id}`,
        toolName: 'Bash',
        toolInput: { command: p.command },
        cwd: project,
      });
    }
    const entries = await new AuditLog(join(stroqHome, 'audit.jsonl')).readAll();
    expect(entries).toHaveLength(3);
    for (const entry of entries as AuditEntry[]) {
      expect(entry.phase).toBe('pre');
      expect(entry.summary).toContain(NONCE);
      // The secret itself does not: the log keeps the command and not the credential in it.
      expect(entry.summary).not.toContain(FAKE);
    }
  });

  // The golden test is only worth having if it can fail. These are the three ways a probe goes dark.
  it('would notice the policy no longer denying a repository hook', async () => {
    const lax: Policy = {
      ...DEFAULT_POLICY,
      rules: DEFAULT_POLICY.rules.filter((rule) => rule.id !== 'deny-git-exec'),
    };
    const { result, p } = await decide(lax, 'deny');
    expect(result.decision.effect).not.toBe(p.expected.effect);
  });

  it('would notice the policy no longer denying a secret on its way out', async () => {
    const lax: Policy = {
      ...DEFAULT_POLICY,
      rules: DEFAULT_POLICY.rules.filter((rule) => rule.id !== 'deny-secret-egress'),
    };
    const { result, p } = await decide(lax, 'secret-egress');
    expect(result.decision.ruleId).not.toBe(p.expected.ruleId);
  });

  it('would notice the secret index not finding the fake in the project', async () => {
    // No .env in the project: the same command is a plain network call, and is let through.
    const engine = createEngineAt({ home: stroqHome, userHome, policy: DEFAULT_POLICY, env: {} });
    const p = probe('secret-egress');
    const result = await engine.pre({
      sessionId: 'golden-no-env',
      toolName: 'Bash',
      toolInput: { command: p.command },
      cwd: project,
    });
    expect(result.decision.effect).toBe('allow');
  });
});
