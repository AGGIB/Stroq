import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parseDocument, stringify } from 'yaml';
import { DEFAULT_POLICY } from '../../packages/core/src/policy/default-policy.js';
import { PolicySchema, type Policy } from '../../packages/core/src/policy/policy-types.js';
import { schemaFaults } from '../../packages/cli/src/install/schema-fault.js';
import { BUILT_IN_READ, checkReport, type Loaded } from '../../packages/cli/src/policy/check.js';
import { policySha256 } from '../../packages/cli/src/policy/digest.js';
import { readYaml } from '../../packages/cli/src/policy/yaml.js';
import { unknownFieldPaths } from '../../packages/cli/src/policy/unknown-fields.js';
import { BUNDLED } from '../../packages/cli/src/policy/replay.js';
import { testPolicies } from '../../packages/cli/src/policy/test-command.js';
import type { TestReport } from '../../packages/cli/src/policy/test-report.js';
import { evaluatePolicyCases } from './policy-case-evaluation';
import { ACTION_CLASSES, type ActionClass } from '../../packages/core/src/types.js';
import { evaluatePolicy } from '../../packages/core/src/policy/evaluate.js';
import { applyActionDenials, newActionDenials, validActionClasses } from './policy-action-rules.js';
import { mcpGovernanceRestoreDiff } from './mcp-governance-policy-shape';

export interface PolicyChanges {
  defaultEffect?: 'ask' | 'deny';
  threshold?: number;
  promoteRuleIndexes?: number[];
  denyActionClasses?: ActionClass[];
}
const MAX_RULES = 512;
const STRICTNESS = { allow: 0, ask: 1, deny: 2 };
const MAX_INTERRUPTION_DETAILS = 128;
const VERDICTS = new Set(['allow', 'ask', 'deny', 'clean', 'suspect']);
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function read(text: string | null): Loaded {
  if (text === null) return BUILT_IN_READ;
  const yaml = readYaml(text);
  if (!yaml.ok) return { ok: false, problem: 'yaml', fault: yaml.fault };
  const unknownFields = unknownFieldPaths(yaml.value);
  const result = PolicySchema.safeParse(yaml.value);
  return result.success
    ? { ok: true, policy: result.data, unknownFields }
    : { ok: false, problem: 'schema', faults: schemaFaults(result.error), unknownFields };
}

function summarize(loaded: Loaded) {
  const report = checkReport({ source: 'file', file: null }, loaded);
  const groups = new Map<string, { kind: string; severity: string; count: number }>();
  for (const finding of report.findings) {
    const key = `${finding.kind}:${finding.severity}`;
    const previous = groups.get(key);
    groups.set(key, {
      kind: finding.kind,
      severity: finding.severity,
      count: (previous?.count ?? 0) + 1,
    });
  }
  return {
    ok: report.ok,
    loaded: report.loaded,
    faults: report.faults.length,
    findings: [...groups.values()],
  };
}

function documentFor(text: string | null) {
  const document = parseDocument(text ?? stringify(DEFAULT_POLICY));
  // Alias edits may change more than the named scalar. Do not offer a form for them.
  if (document.errors.length) throw new Error('policy-invalid');
  try {
    document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error('policy-invalid');
  }
  return document;
}

export function inspectPolicy(text: string | null) {
  const loaded = read(text);
  let editable = loaded.ok && loaded.policy.rules.length <= MAX_RULES;
  if (editable) {
    try {
      documentFor(text);
    } catch {
      editable = false;
    }
  }
  return {
    policyFingerprint: loaded.ok ? policySha256(loaded.policy) : null,
    defaultEffect: loaded.ok ? loaded.policy.default : null,
    threshold: loaded.ok ? loaded.policy.threshold : null,
    rules: loaded.ok
      ? loaded.policy.rules.slice(0, MAX_RULES).map((rule, index) => ({
          index,
          effect: rule.effect,
          classes: rule.when.classes,
          taint: rule.when.taint,
        }))
      : [],
    check: summarize(loaded),
    editable,
  };
}

function validateChanges(changes: PolicyChanges, policy: Policy) {
  if (
    !plain(changes) ||
    Object.keys(changes).length === 0 ||
    Reflect.ownKeys(changes).some(
      (key) =>
        typeof key !== 'string' ||
        !['defaultEffect', 'threshold', 'promoteRuleIndexes', 'denyActionClasses'].includes(key),
    )
  )
    throw new Error('invalid-request');
  if (changes.denyActionClasses !== undefined && !validActionClasses(changes.denyActionClasses))
    throw new Error('invalid-request');
  const effect = changes.defaultEffect;
  if (
    effect !== undefined &&
    ((effect !== 'ask' && effect !== 'deny') || STRICTNESS[effect] < STRICTNESS[policy.default])
  )
    throw new Error('weakening-not-allowed');
  const threshold = changes.threshold;
  if (
    threshold !== undefined &&
    (typeof threshold !== 'number' ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      threshold > policy.threshold)
  )
    throw new Error('weakening-not-allowed');
  const indexes = changes.promoteRuleIndexes;
  if (
    indexes !== undefined &&
    (!Array.isArray(indexes) ||
      indexes.length > MAX_RULES ||
      new Set(indexes).size !== indexes.length ||
      indexes.some(
        (index) => !Number.isInteger(index) || index < 0 || policy.rules[index]?.effect !== 'ask',
      ))
  )
    throw new Error('invalid-request');
}

/** Only bundled fixture labels cross this boundary, never a command, rule reason or report subject. */
export function projectPolicyInterruptions(report: Pick<TestReport, 'newInterruptions'>) {
  const fixtures = new Map(BUNDLED.ordinary.map((fixture) => [fixture.id, fixture]));
  const details = report.newInterruptions.map((item) => {
    const fixture = fixtures.get(item.id);
    if (
      !fixture ||
      !Number.isInteger(item.step) ||
      item.step < 1 ||
      item.step > fixture.steps.length ||
      !VERDICTS.has(item.baseline) ||
      !VERDICTS.has(item.candidate) ||
      fixture.title.length > 240 ||
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(fixture.title)
    )
      throw new Error('engine-failed');
    return { label: fixture.title, step: item.step, from: item.baseline, to: item.candidate };
  });
  return {
    interruptions: details.slice(0, MAX_INTERRUPTION_DETAILS),
    interruptionsTruncated: details.length > MAX_INTERRUPTION_DETAILS,
  };
}

export function evaluatePolicyCaseDefinitions(text: string | null, records: unknown) {
  const loaded = read(text);
  if (!loaded.ok || loaded.policy.rules.length > MAX_RULES || loaded.unknownFields?.length)
    throw new Error('policy-invalid');
  return evaluatePolicyCases(loaded.policy, records);
}

/** The recorded decision of the current policy on one made-up action; see try-action.ts. */
export async function tryPolicyAction(text: string | null, request: unknown) {
  const loaded = read(text);
  if (!loaded.ok || loaded.policy.rules.length > MAX_RULES || loaded.unknownFields?.length)
    throw new Error('policy-invalid');
  const { evaluateTryAction } = await import('./try-action');
  const { TRY_LIMITATIONS } = await import('../lib/try-action');
  return {
    results: await evaluateTryAction(loaded.policy, request),
    limitations: [...TRY_LIMITATIONS],
  };
}

export async function previewPolicy(
  text: string | null,
  changes: PolicyChanges,
  records: unknown = [],
  caseRevision: string | null = null,
) {
  const loaded = read(text);
  if (!loaded.ok || loaded.policy.rules.length > MAX_RULES) throw new Error('policy-invalid');
  validateChanges(changes, loaded.policy);
  const document = documentFor(text);
  const diff: {
    field: string;
    index?: number;
    actionClass?: ActionClass;
    from: string | number;
    to: string | number;
  }[] = [];
  if (changes.defaultEffect !== undefined && changes.defaultEffect !== loaded.policy.default) {
    document.set('default', changes.defaultEffect);
    diff.push({ field: 'default', from: loaded.policy.default, to: changes.defaultEffect });
  }
  if (changes.threshold !== undefined && changes.threshold !== loaded.policy.threshold) {
    document.set('threshold', changes.threshold);
    diff.push({ field: 'threshold', from: loaded.policy.threshold, to: changes.threshold });
  }
  for (const index of changes.promoteRuleIndexes ?? []) {
    document.setIn(['rules', index, 'effect'], 'deny');
    diff.push({ field: 'rule-effect', index, from: 'ask', to: 'deny' });
  }
  const actualClasses = newActionDenials(loaded.policy, changes.denyActionClasses ?? []);
  const ordinaryPolicy: Policy = {
    ...loaded.policy,
    default: changes.defaultEffect ?? loaded.policy.default,
    threshold: changes.threshold ?? loaded.policy.threshold,
    rules: loaded.policy.rules.map((rule, index) =>
      changes.promoteRuleIndexes?.includes(index) ? { ...rule, effect: 'deny' } : rule,
    ),
  };
  const { policy: expected, actionControl } = applyActionDenials(
    document,
    ordinaryPolicy,
    actualClasses,
  );
  if (expected.rules.length > MAX_RULES) throw new Error('policy-invalid');
  diff.push(
    ...actualClasses.map((actionClass) => ({
      field: 'class-deny',
      actionClass,
      from: 'current-policy',
      to: 'deny',
    })),
  );
  if (!diff.length) throw new Error('no-changes');
  const candidateText = document.toString();
  const candidate = read(candidateText);
  if (!candidate.ok) throw new Error('policy-invalid');
  if (policySha256(candidate.policy) !== policySha256(expected)) throw new Error('policy-invalid');
  const analysis = await simulatePolicyCandidate(loaded, candidate, records, caseRevision);
  return {
    candidateText,
    currentPolicyFingerprint: policySha256(loaded.policy),
    candidateFingerprint: policySha256(candidate.policy),
    changes: diff,
    actionControl,
    ...analysis,
    requiresInterruptionAcknowledgement: analysis.simulation.newInterruptions > 0,
  };
}

type ValidLoaded = Extract<Loaded, { ok: true }>;
async function simulatePolicyCandidate(
  loaded: ValidLoaded,
  candidate: ValidLoaded,
  records: unknown,
  caseRevision: string | null,
) {
  if (!(caseRevision === null || /^[a-f0-9]{64}$/.test(caseRevision)))
    throw new Error('invalid-request');
  const evaluatedCases = evaluatePolicyCases(candidate.policy, records);
  if (caseRevision === null && evaluatedCases.total > 0) throw new Error('invalid-request');
  const { policyFingerprint: caseFingerprint, ...caseCounts } = evaluatedCases;
  if (caseFingerprint !== policySha256(candidate.policy)) throw new Error('engine-failed');
  const regressions = { revision: caseRevision, ...caseCounts };
  const report = await testPolicies(
    { policy: candidate.policy, source: 'candidate' },
    { policy: loaded.policy, source: 'current' },
    { ...BUNDLED, cases: [] },
    null,
  );
  const check = summarize(candidate);
  const simulation = {
    ok: report.ok,
    replayed: report.replayed,
    attacksPassing: report.attacksPassing.length,
    newInterruptions: report.newInterruptions.length,
    relieved: report.relieved.length,
    violations: report.violations.length,
    notJudged: report.notJudged.length,
  };
  const blockers = [
    ...(!check.ok ? ['policy-findings'] : []),
    ...(simulation.attacksPassing > 0 ? ['attacks-allowed'] : []),
    ...(simulation.violations > 0 ? ['unmet-expectations'] : []),
    ...(simulation.notJudged > 0 ? ['unjudged-scenarios'] : []),
    ...(regressions.failed > 0 ? ['saved-case-failures'] : []),
  ];
  return { regressions, check, simulation, blockers, ...projectPolicyInterruptions(report) };
}

function restoreRead(text: unknown): ValidLoaded {
  if (!(
    text === null ||
    (typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= 256 * 1024)
  ))
    throw new Error('policy-invalid');
  const loaded = read(text);
  if (!loaded.ok || loaded.policy.rules.length > MAX_RULES || loaded.unknownFields?.length)
    throw new Error('policy-invalid');
  documentFor(text);
  return loaded;
}

/** Restores exact server-retained bytes; all checks are real, but weakening is explicit and allowed. */
export async function previewPolicyRestore(
  text: string | null,
  changes: unknown,
  records: unknown = [],
  caseRevision: string | null = null,
) {
  if (
    !plain(changes) ||
    Reflect.ownKeys(changes).length !== 1 ||
    !Object.hasOwn(changes, 'candidateText') ||
    !(changes.candidateText === null || typeof changes.candidateText === 'string')
  )
    throw new Error('invalid-request');
  const loaded = restoreRead(text);
  const candidateText = changes.candidateText as string | null;
  const candidate = restoreRead(candidateText);
  if (candidateText === text) throw new Error('no-changes');
  const decisions = ACTION_CLASSES.flatMap((actionClass) =>
    (['none', 'suspect'] as const).flatMap((taint) => {
      const assumed = taint === 'none' ? null : 'suspect';
      const from = evaluatePolicy(loaded.policy, [actionClass], assumed).effect;
      const to = evaluatePolicy(candidate.policy, [actionClass], assumed).effect;
      return from === to ? [] : [{ actionClass, taint, from, to }];
    }),
  );
  const settings = (policy: Policy) => ({
    defaultEffect: policy.default,
    threshold: policy.threshold,
    rules: policy.rules.length,
  });
  return {
    candidateText,
    currentPolicyFingerprint: policySha256(loaded.policy),
    candidateFingerprint: policySha256(candidate.policy),
    settings: { current: settings(loaded.policy), candidate: settings(candidate.policy) },
    mcpGovernance: mcpGovernanceRestoreDiff(loaded.policy, candidate.policy),
    ...(await simulatePolicyCandidate(loaded, candidate, records, caseRevision)),
    decisions,
  };
}

if (!isMainThread) {
  Promise.resolve()
    .then(async () => {
      if (workerData.operation === 'inspect') return inspectPolicy(workerData.text);
      if (workerData.operation === 'mcp-governance-inspect') {
        const { inspectMcpGovernancePolicy } = await import('./mcp-governance-policy');
        return inspectMcpGovernancePolicy(workerData.text);
      }
      if (workerData.operation === 'mcp-governance-preview') {
        const { previewMcpGovernancePolicy } = await import('./mcp-governance-policy');
        return previewMcpGovernancePolicy(
          workerData.text,
          workerData.changes,
          workerData.cases ?? [],
          workerData.caseRevision ?? null,
        );
      }
      if (workerData.operation === 'mcp-governance-capture') {
        const { captureMcpGovernanceSources } = await import('./mcp-governance-capture');
        return captureMcpGovernanceSources(workerData.changes.options, workerData.changes.allowed);
      }
      if (workerData.operation === 'preview')
        return previewPolicy(
          workerData.text,
          workerData.changes,
          workerData.cases ?? [],
          workerData.caseRevision ?? null,
        );
      if (workerData.operation === 'restore-preview')
        return previewPolicyRestore(
          workerData.text,
          workerData.changes,
          workerData.cases ?? [],
          workerData.caseRevision ?? null,
        );
      if (workerData.operation === 'evaluate-cases')
        return evaluatePolicyCaseDefinitions(workerData.text, workerData.changes);
      if (workerData.operation === 'try-action')
        return tryPolicyAction(workerData.text, workerData.changes);
      throw new Error('invalid-request');
    })
    .then(
      (value) => parentPort?.postMessage({ ok: true, value }),
      (error: unknown) =>
        parentPort?.postMessage({
          ok: false,
          error:
            error instanceof Error &&
            ['policy-invalid', 'invalid-request', 'weakening-not-allowed', 'no-changes'].includes(
              error.message,
            )
              ? error.message
              : 'engine-failed',
        }),
    );
}
