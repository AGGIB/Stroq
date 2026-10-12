import { DEFAULT_POLICY, type ActionClass, type Effect, type Policy } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import { lintPolicy, needsAttention } from '../../src/policy/lint.js';
import type {
  DroppedProtection,
  Finding,
  HighThreshold,
  ShadowedRule,
} from '../../src/policy/findings.js';

type Rule = Policy['rules'][number];

const rule = (
  id: string,
  effect: Effect,
  classes: readonly ActionClass[],
  taint: Rule['when']['taint'] = 'any',
): Rule => ({ id, effect, reason: `reason of ${id}`, when: { classes: [...classes], taint } });

const policyOf = (rules: readonly Rule[], extra: Partial<Policy> = {}): Policy => ({
  ...DEFAULT_POLICY,
  rules: [...rules],
  ...extra,
});

/** The default policy with the rules of the given ids left out. */
const withoutRules = (...ids: string[]): Policy =>
  policyOf(DEFAULT_POLICY.rules.filter((r) => !ids.includes(r.id)));

const dropped = (findings: readonly Finding[]): DroppedProtection[] =>
  findings.filter((f): f is DroppedProtection => f.kind === 'dropped-protection');
const shadowed = (findings: readonly Finding[]): ShadowedRule[] =>
  findings.filter((f): f is ShadowedRule => f.kind === 'shadowed-rule');

describe('lint: the default policy', () => {
  it('has no shadowed rule, no dropped protection and no high threshold', () => {
    const findings = lintPolicy(DEFAULT_POLICY);
    expect(shadowed(findings)).toEqual([]);
    expect(dropped(findings)).toEqual([]);
    expect(findings.some((f) => f.kind === 'high-threshold')).toBe(false);
  });

  it('needs no attention: its only finding is the note that it allows what no rule names', () => {
    const findings = lintPolicy(DEFAULT_POLICY);
    expect(findings.map((f) => f.kind)).toEqual(['loose-default']);
    expect(needsAttention(findings)).toBe(false);
  });
});

describe('lint: dropped protection', () => {
  it('reports a policy that quietly stops denying secret.egress, with both effects and who decided', () => {
    const findings = dropped(lintPolicy(withoutRules('deny-secret-egress')));
    const egress = findings.filter((f) => f.class === 'secret.egress');
    expect(egress).toHaveLength(1);
    const [finding] = egress;
    expect(finding).toMatchObject({
      kind: 'dropped-protection',
      severity: 'error',
      class: 'secret.egress',
      taint: 'any',
      protection: { effect: 'deny', ruleId: 'deny-secret-egress' },
      policy: { effect: 'allow', ruleId: null },
    });
    expect(finding?.message).toContain('secret.egress');
    expect(finding?.message).toContain('deny-secret-egress');
    expect(finding?.message).toMatch(/allow/);
    expect(finding?.fix).not.toContain('\n');
    expect(finding?.fix).not.toBe('');
  });

  it('reports config.self when its deny is gone', () => {
    const findings = dropped(lintPolicy(withoutRules('deny-self-tamper')));
    expect(findings.map((f) => f.class)).toContain('config.self');
  });

  it('does not report a protection kept under another rule id', () => {
    const renamed = policyOf(
      DEFAULT_POLICY.rules.map((r) =>
        r.id === 'deny-secret-egress' ? { ...r, id: 'my-own-name-for-it' } : r,
      ),
    );
    expect(dropped(lintPolicy(renamed))).toEqual([]);
  });

  it('does not report a protection kept by a rule that covers several classes', () => {
    const merged = policyOf([
      rule('deny-the-lot', 'deny', [
        'secret.egress',
        'secret.unscannable',
        'fs.canary',
        'config.self',
        'config.git_exec',
        'shell.exec_encoded',
        'origin.suspect',
      ]),
      ...withoutRules(
        'deny-secret-egress',
        'deny-secret-unscannable',
        'deny-canary-file',
        'deny-self-tamper',
        'deny-git-exec',
        'deny-encoded-exec',
        'deny-origin-suspect',
      ).rules,
    ]);
    expect(dropped(lintPolicy(merged))).toEqual([]);
  });

  it('reports a deny that was softened to ask, as a warning with the ask named', () => {
    const softened = policyOf(
      DEFAULT_POLICY.rules.map((r) =>
        r.id === 'deny-secret-egress' ? { ...r, effect: 'ask' as const } : r,
      ),
    );
    const found = dropped(lintPolicy(softened)).filter((f) => f.class === 'secret.egress');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: 'warning',
      protection: { effect: 'deny', ruleId: 'deny-secret-egress' },
      policy: { effect: 'ask', ruleId: 'deny-secret-egress' },
    });
  });

  it('reports an ask that was dropped, as a warning', () => {
    const found = dropped(lintPolicy(withoutRules('ask-destructive')));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      class: 'shell.destructive',
      severity: 'warning',
      protection: { effect: 'ask', ruleId: 'ask-destructive' },
      policy: { effect: 'allow', ruleId: null },
    });
  });

  it('reports a protection that holds only for a tainted session, and says which taint', () => {
    const found = dropped(lintPolicy(withoutRules('deny-network-when-tainted')));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      class: 'shell.network',
      taint: 'suspect',
      protection: { effect: 'deny', ruleId: 'deny-network-when-tainted' },
    });
    expect(found[0]?.message).toMatch(/tainted/);
  });

  it('reports a class once, at any taint, when both taint states lost the same protection', () => {
    const found = dropped(lintPolicy(withoutRules('deny-secret-egress'))).filter(
      (f) => f.class === 'secret.egress',
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.taint).toBe('any');
  });

  it('reports a clean-session loss and a tainted-session loss apart when they differ', () => {
    // `ask-persistence` (any taint) goes; the tainted deny stays, so only the clean state is looser.
    const found = dropped(lintPolicy(withoutRules('ask-persistence'))).filter(
      (f) => f.class === 'config.persistence',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ taint: 'none', policy: { effect: 'allow', ruleId: null } });
  });

  it('reports every protection when a leading allow-all rule hides the rest, naming that rule', () => {
    const allowAll = policyOf([
      rule(
        'allow-everything',
        'allow',
        DEFAULT_POLICY.rules.flatMap((r) => r.when.classes),
      ),
      ...DEFAULT_POLICY.rules,
    ]);
    const found = dropped(lintPolicy(allowAll));
    const egress = found.find((f) => f.class === 'secret.egress');
    expect(egress?.policy).toEqual({ effect: 'allow', ruleId: 'allow-everything' });
    expect(egress?.message).toContain('allow-everything');
    expect(found.length).toBeGreaterThan(10);
  });

  it('does not report a stricter policy', () => {
    expect(dropped(lintPolicy(policyOf(DEFAULT_POLICY.rules, { default: 'deny' })))).toEqual([]);
    const stricter = policyOf([
      rule('deny-network-always', 'deny', ['shell.network']),
      ...DEFAULT_POLICY.rules,
    ]);
    expect(dropped(lintPolicy(stricter))).toEqual([]);
  });

  it('does not report a policy whose default is ask for a class the default only asks about', () => {
    // No rule for destructive commands, but everything unnamed is asked: ask is not looser than ask.
    const found = dropped(
      lintPolicy({ ...withoutRules('ask-destructive'), default: 'ask' as const }),
    );
    expect(found.map((f) => f.class)).not.toContain('shell.destructive');
  });

  it('names a rule id with a control character only in neutralized form', () => {
    const hostile = policyOf([
      rule('allow\u001b[2Jeverything‮', 'allow', ['secret.egress']),
      ...DEFAULT_POLICY.rules,
    ]);
    const egress = dropped(lintPolicy(hostile)).find((f) => f.class === 'secret.egress');
    expect(egress).toBeDefined();
    // eslint-disable-next-line no-control-regex
    expect(egress?.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f‮]/);
    expect(egress?.message).toContain('\\u001b');
  });
});

describe('lint: shadowed rule', () => {
  const base = (rules: readonly Rule[]): Policy => policyOf(rules, { default: 'ask' });

  it('reports a rule whose classes an earlier rule at any taint already covers', () => {
    const found = shadowed(
      lintPolicy(
        base([
          rule('allow-net', 'allow', ['shell.network', 'network.fetch']),
          rule('deny-net', 'deny', ['shell.network']),
        ]),
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: 'shadowed-rule',
      severity: 'warning',
      rule: { position: 2, id: 'deny-net' },
      shadowedBy: [{ position: 1, id: 'allow-net' }],
    });
    // The rule that never fires says deny and the one that hides it says allow: the line says so.
    expect(found[0]?.message).toMatch(/deny/);
    expect(found[0]?.message).toMatch(/allow/);
    expect(found[0]?.fix).not.toContain('\n');
  });

  it('reports a rule for a tainted session that an earlier any-taint rule covers', () => {
    const found = shadowed(
      lintPolicy(
        base([
          rule('ask-net', 'ask', ['shell.network'], 'any'),
          rule('deny-net-tainted', 'deny', ['shell.network'], 'suspect'),
        ]),
      ),
    );
    expect(found.map((f) => f.rule.id)).toEqual(['deny-net-tainted']);
  });

  it('reports a clean-session rule that an earlier clean-session rule covers', () => {
    const found = shadowed(
      lintPolicy(
        base([rule('a', 'ask', ['fs.secrets'], 'none'), rule('b', 'deny', ['fs.secrets'], 'none')]),
      ),
    );
    expect(found.map((f) => f.rule.id)).toEqual(['b']);
  });

  it('reports a rule two earlier rules cover between them, naming both', () => {
    const found = shadowed(
      lintPolicy(
        base([
          rule('a', 'allow', ['mcp.call']),
          rule('b', 'allow', ['network.fetch']),
          rule('c', 'deny', ['mcp.call', 'network.fetch']),
        ]),
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.rule.id).toBe('c');
    expect(found[0]?.shadowedBy.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('does not report a rule that fires for a class the earlier rule does not name', () => {
    const found = shadowed(
      lintPolicy(
        base([
          rule('a', 'allow', ['shell.network']),
          rule('b', 'deny', ['shell.network', 'network.fetch']),
        ]),
      ),
    );
    expect(found).toEqual([]);
  });

  it('does not report an any-taint rule after a tainted-only rule: it still decides a clean session', () => {
    const found = shadowed(
      lintPolicy(
        base([
          rule('tainted-only', 'deny', ['shell.network'], 'suspect'),
          rule('any-taint', 'ask', ['shell.network'], 'any'),
        ]),
      ),
    );
    expect(found).toEqual([]);
  });

  it('does not report a tainted rule after a clean-only rule: the earlier rule never sees a tainted session', () => {
    const found = shadowed(
      lintPolicy(
        base([
          rule('clean-only', 'allow', ['shell.network'], 'none'),
          rule('tainted', 'deny', ['shell.network'], 'suspect'),
        ]),
      ),
    );
    expect(found).toEqual([]);
  });

  it('does not report partly overlapping rules', () => {
    const found = shadowed(
      lintPolicy(
        base([
          rule('a', 'allow', ['shell.network', 'network.fetch']),
          rule('b', 'deny', ['network.fetch', 'mcp.call']),
        ]),
      ),
    );
    expect(found).toEqual([]);
  });

  it('does not report the first rule, or a rule on a class nothing earlier names', () => {
    const found = shadowed(
      lintPolicy(base([rule('a', 'allow', ['shell.network']), rule('b', 'deny', ['fs.secrets'])])),
    );
    expect(found).toEqual([]);
  });

  it('counts repeated classes in one list once', () => {
    const found = shadowed(
      lintPolicy(
        base([
          rule('a', 'allow', ['shell.network', 'shell.network']),
          rule('b', 'deny', ['shell.network', 'shell.network', 'shell.network']),
        ]),
      ),
    );
    expect(found.map((f) => f.rule.id)).toEqual(['b']);
  });

  it('numbers rules from one, by position, so that two rules with one id are told apart', () => {
    const found = shadowed(
      lintPolicy(base([rule('same', 'allow', ['mcp.call']), rule('same', 'deny', ['mcp.call'])])),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.rule).toEqual({ position: 2, id: 'same' });
    expect(found[0]?.shadowedBy).toEqual([{ position: 1, id: 'same' }]);
  });

  it('stays fast on a policy of thousands of rules', () => {
    const many: Rule[] = Array.from({ length: 5000 }, (_, i) =>
      rule(`r${i}`, 'ask', ['shell.network', 'fs.secrets', 'mcp.call'], 'any'),
    );
    const started = process.hrtime.bigint();
    const found = shadowed(lintPolicy(base(many)));
    const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(found).toHaveLength(4999);
    expect(tookMs).toBeLessThan(20_000);
  });
});

describe('lint: loose default', () => {
  it('notes a default of allow, as information that does not need attention', () => {
    const found = lintPolicy(policyOf(DEFAULT_POLICY.rules, { default: 'allow' })).filter(
      (f) => f.kind === 'loose-default',
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('info');
    expect(found[0]?.fix).toContain('ask');
  });

  it.each(['ask', 'deny'] as const)('says nothing of a default of %s', (effect) => {
    const found = lintPolicy(policyOf(DEFAULT_POLICY.rules, { default: effect }));
    expect(found.some((f) => f.kind === 'loose-default')).toBe(false);
  });
});

describe('lint: high threshold', () => {
  const thresholdFindings = (threshold: number): HighThreshold[] =>
    lintPolicy(policyOf(DEFAULT_POLICY.rules, { threshold })).filter(
      (f): f is HighThreshold => f.kind === 'high-threshold',
    );

  it('reports a threshold well above the default one, as a warning with both numbers', () => {
    const [found] = thresholdFindings(0.9);
    expect(found).toMatchObject({ severity: 'warning', threshold: 0.9, baseline: 0.6 });
    expect(found?.message).toContain('0.9');
    expect(found?.message).toContain('0.6');
  });

  it('reports a threshold of exactly the margin above the default one', () => {
    expect(thresholdFindings(0.8)).toHaveLength(1);
  });

  it.each([0, 0.3, 0.6, 0.7, 0.79])('says nothing of a threshold of %s', (threshold) => {
    expect(thresholdFindings(threshold)).toEqual([]);
  });
});

describe('needsAttention', () => {
  it('is true for an error or a warning and false for information alone', () => {
    expect(needsAttention(lintPolicy(withoutRules('deny-secret-egress')))).toBe(true);
    expect(needsAttention(lintPolicy(policyOf(DEFAULT_POLICY.rules, { threshold: 0.95 })))).toBe(
      true,
    );
    expect(needsAttention(lintPolicy(DEFAULT_POLICY))).toBe(false);
    expect(needsAttention([])).toBe(false);
  });
});
