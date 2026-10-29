import { describe, expect, it } from 'vitest';
import { validateControl, validateRun, latestContextRun } from './control';

const at = '2026-10-24T10:00:00.000Z';
const end = '2026-10-24T10:01:00.000Z';
const workspaceId = `workspace-${'a'.repeat(24)}`;
const hash = 'b'.repeat(64);
const result = {
  doctor: {
    source: 'local',
    evidence: 'configuration',
    ok: true,
    passed: 1,
    total: 1,
    checks: [{ id: 'runtime', label: 'Runtime', ok: true }],
  },
  'policy-check': {
    source: 'local',
    evidence: 'configuration',
    ok: true,
    loaded: true,
    policySource: 'default',
    rules: 10,
    defaultEffect: 'allow',
    threshold: 60,
    faults: 0,
    findings: [],
  },
  'guard-test': {
    source: 'local',
    evidence: 'simulation',
    ok: true,
    replayed: { attack: 36, ordinary: 75, cases: 0 },
    attacksPassing: 0,
    newInterruptions: 0,
    relieved: 0,
    violations: 0,
    notJudged: 0,
  },
  'saved-policy-checks': {
    source: 'local',
    evidence: 'simulation',
    workspaceId,
    generatedAt: at,
    revision: null,
    policy: { source: 'built-in', semanticSha: hash, rawSha: null },
    total: 0,
    passed: 0,
    failed: 0,
    cases: [],
    results: [],
    hostEnforcement: false,
  },
  'workspace-review': {
    source: 'local',
    evidence: 'static-capture',
    runId: '11111111-1111-4111-8111-111111111111',
    workspaceId,
    captureSha256: hash,
    capturedAt: at,
    profile: {
      id: 'stroq-workspace-surface/1',
      engineVersion: '0.28.0',
      runtimeSha256: hash,
      scopeSha256: hash,
    },
    complete: true,
    sources: 2,
    entries: 3,
    errors: 0,
    warnings: 0,
    notices: 3,
    coverage: { omittedSources: 0, omittedEntries: 0, gaps: 0 },
    hostEnforcement: false,
  },
};
const ids = [
  'doctor',
  'policy-check',
  'guard-test',
  'saved-policy-checks',
  'workspace-review',
] as const;
const steps = ids.map((id) => ({
  id,
  status: 'completed',
  startedAt: at,
  finishedAt: at,
  error: null,
  result: result[id],
}));
const parent = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'protection-check',
  status: 'completed',
  startedAt: at,
  finishedAt: end,
  provenance: { workspaceId: hash, policySha256: hash, runtimeSha256: hash },
  progress: { steps },
  result: {
    source: 'local',
    evidence: 'local-checks',
    outcome: 'finished',
    completed: 5,
    total: 5,
    hostEnforcement: false,
  },
};
const clone = <T>(v: T): T => structuredClone(v);

describe('cohesive local protection-check report boundary', () => {
  it('binds saved action groups to exact ordered scenario results without accepting arbitrary labels', () => {
    const captured: any = clone(parent);
    const id = `case-${'d'.repeat(64)}`;
    const saved = captured.progress.steps[3].result;
    Object.assign(saved, {
      revision: hash,
      total: 1,
      passed: 0,
      failed: 1,
      cases: [{ id, classes: ['fs.secrets', 'shell.network'] }],
      results: [
        {
          caseId: id,
          passed: false,
          scenarios: [
            { taint: 'none', expected: 'deny', actual: 'allow' },
            { taint: 'suspect', expected: 'deny', actual: 'deny' },
          ],
        },
      ],
    });
    expect(validateRun(captured)).toBe(true);
    for (const change of [
      (v: any) => (v.cases[0].id = `case-${'e'.repeat(64)}`),
      (v: any) => (v.cases[0].classes = ['unknown.class']),
      (v: any) => (v.cases[0].classes = ['shell.network', 'fs.secrets']),
      (v: any) => (v.cases[0].classes = ['shell.network', 'shell.network']),
      (v: any) => (v.cases[0].command = 'private'),
      (v: any) => v.cases.push(v.cases[0]),
      (v: any) => delete v.cases,
    ]) {
      const invalid: any = clone(captured);
      change(invalid.progress.steps[3].result);
      expect(validateRun(invalid)).toBe(false);
    }
    const duplicateGroup: any = clone(captured);
    const second = `case-${'f'.repeat(64)}`;
    const s = duplicateGroup.progress.steps[3].result;
    s.total = 2;
    s.failed = 2;
    s.cases.push({ ...s.cases[0], id: second });
    s.results.push({ ...s.results[0], caseId: second });
    expect(validateRun(duplicateGroup)).toBe(false);
    s.cases[1].classes = ['shell.destructive'];
    expect(validateRun(duplicateGroup)).toBe(true);
    s.cases.reverse();
    expect(validateRun(duplicateGroup)).toBe(false);
  });
  it('accepts the fixed five-stage report and a running partial report', () => {
    expect(validateRun(parent)).toBe(true);
    const running: any = clone(parent);
    running.status = 'running';
    delete running.finishedAt;
    delete running.result;
    running.progress.steps = steps.map((s, i) =>
      i === 0
        ? { ...s, status: 'running', finishedAt: null, result: null }
        : { ...s, status: 'queued', startedAt: null, finishedAt: null, result: null },
    );
    expect(validateRun(running)).toBe(true);
    const owned = {
      schema: 'stroq-control/1',
      workspaceId,
      activeRunId: running.id,
      activeProtectionCheckId: running.id,
      engine: { available: true, version: '0.28.0' },
      context: parent.provenance,
      history: { status: 'ready' },
      runs: [running],
    };
    expect(validateControl(owned)).toBe(true);
    expect(validateControl({ ...owned, activeRunId: null })).toBe(false);
    expect(validateControl({ ...owned, activeProtectionCheckId: null })).toBe(false);
    expect(validateControl({ ...owned, activeRunId: null, activeProtectionCheckId: null })).toBe(
      true,
    );
    expect(
      validateControl({
        schema: 'stroq-control/1',
        workspaceId,
        engine: { available: true, version: '0.28.0' },
        context: parent.provenance,
        history: { status: 'ready' },
        runs: [parent],
      }),
    ).toBe(true);
    expect(
      validateControl({
        schema: 'stroq-control/1',
        workspaceId,
        activeProtectionCheckId: parent.id,
        engine: { available: true, version: '0.28.0' },
        context: parent.provenance,
        history: { status: 'ready' },
        runs: [parent],
      }),
    ).toBe(false);
  });
  it('retains finished evidence on failed and cancelled parents without accepting queued terminal stages', () => {
    for (const status of ['failed', 'cancelled']) {
      const partial: any = clone(parent);
      partial.status = status;
      partial.error = status === 'cancelled' ? 'cancelled' : 'context-changed';
      partial.progress.steps = steps.map((s, i) =>
        i === 0
          ? s
          : {
              ...s,
              status: 'skipped',
              startedAt: null,
              finishedAt: end,
              error: partial.error,
              result: null,
            },
      );
      partial.result = { ...partial.result, outcome: 'incomplete', completed: 1 };
      expect(validateRun(partial), status).toBe(true);
      partial.progress.steps[4] = {
        ...partial.progress.steps[4],
        status: 'queued',
        finishedAt: null,
        error: null,
      };
      expect(validateRun(partial)).toBe(false);
    }
  });
  it('refuses mixed operation results, order changes, unsupported fields, timestamps and summary counts', () => {
    const mutations: ((v: any) => void)[] = [
      (v) => v.progress.steps.reverse(),
      (v) => v.progress.steps.pop(),
      (v) => (v.progress.steps[0].result = result['guard-test']),
      (v) => (v.progress.steps[0].result.command = 'private'),
      (v) => (v.progress.steps[1].finishedAt = '2026-10-23T10:00:00.000Z'),
      (v) => (v.progress.steps[0].finishedAt = end),
      (v) => (v.progress.steps[1].status = 'running'),
      (v) => (v.progress.steps[2].result.hostEnforcement = true),
      (v) => (v.progress.steps[3].result.policy.rawSha = hash),
      (v) => (v.progress.steps[3].result.total = 1),
      (v) => (v.progress.steps[3].result.generatedAt = end),
      (v) => (v.progress.steps[4].result.sources = -1),
      (v) => (v.progress.steps[4].result.errors = 1),
      (v) => (v.progress.steps[4].result.capturedAt = end),
      (v) => (v.progress.steps[4].result.profile.id = 'unknown'),
      (v) => (v.progress.steps[4].result.hostEnforcement = true),
      (v) => (v.result.completed = 4),
      (v) => (v.result.outcome = 'incomplete'),
      (v) => (v.result.protected = true),
    ];
    for (const mutate of mutations) {
      const invalid = clone(parent);
      mutate(invalid);
      expect(validateRun(invalid)).toBe(false);
    }
  });
  it('does not extend cancelled statuses or progress fields to individual checks', () => {
    const individual = {
      id: parent.id,
      kind: 'doctor',
      status: 'cancelled',
      startedAt: at,
      finishedAt: end,
      error: 'cancelled',
    };
    expect(validateRun(individual)).toBe(false);
    expect(
      validateRun({
        ...individual,
        status: 'completed',
        error: undefined,
        result: result.doctor,
        progress: parent.progress,
      }),
    ).toBe(false);
  });
  it('projects diagnostics from the exact matching parent without inventing a new successful run', () => {
    const doctor = latestContextRun([parent], 'doctor', parent.provenance);
    expect(doctor?.id).toBe(parent.id);
    expect(doctor?.result).toEqual(result.doctor);
    expect(
      latestContextRun([parent], 'guard-test', {
        ...parent.provenance,
        runtimeSha256: 'c'.repeat(64),
      }),
    ).toBeUndefined();
    const invalid: any = clone(parent);
    invalid.progress.steps[3].result.workspaceId = `workspace-${'c'.repeat(24)}`;
    expect(validateRun(invalid)).toBe(false);
    expect(
      validateControl({
        schema: 'stroq-control/1',
        workspaceId,
        engine: { available: true, version: '0.28.0' },
        context: parent.provenance,
        history: { status: 'ready' },
        runs: [invalid],
      }),
    ).toBe(false);
    const mismatched: any = clone(parent);
    mismatched.progress.steps[3].result.policy = {
      source: 'file',
      semanticSha: hash,
      rawSha: 'd'.repeat(64),
    };
    expect(validateRun(mismatched)).toBe(false);
    mismatched.provenance.policySha256 = null;
    expect(validateRun(mismatched)).toBe(true);
  });
});
