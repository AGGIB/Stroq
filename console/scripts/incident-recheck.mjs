import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readPolicyState, samePolicyRevision } from './policy-files.mjs';
import { runIncidentRecheck } from './incident-recheck-worker.mjs';

const SHA = /^[a-f0-9]{64}$/;
const EFFECTS = new Set(['allow', 'ask', 'deny']);
const TAINT = new Set(['any', 'none', 'suspect']);
// The worker independently validates against core ACTION_CLASSES. Keep this output boundary
// closed even if a future adapter accidentally starts returning user-provided class strings.
const CLASSES = new Set([
  'shell.exec_encoded',
  'shell.network',
  'shell.destructive',
  'shell.unparsed',
  'fs.secrets',
  'fs.canary',
  'git.push_external',
  'config.self',
  'config.self_touch',
  'config.git_exec',
  'config.persistence',
  'config.instructions',
  'config.instructions_payload',
  'network.fetch',
  'mcp.call',
  'mcp.side_effect',
  'origin.untrusted',
  'origin.suspect',
  'secret.egress',
  'secret.unscannable',
]);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const fail = (code) => {
  throw new Error(code);
};

export const INCIDENT_COMPARISON_LIMITATIONS = [
  'The original taint state was not recorded. These are two current-policy scenarios, not a replay of the original decision.',
  'Only the recorded action classes and current server policy are evaluated. Task scope, trust exemptions, host adapters and runtime guards are not evaluated.',
  'The current server policy is not proof that an installed host loaded this policy. The original policy version was not recorded.',
  'Agreement or a changed decision does not establish host execution, blocking, credential rotation or remediation.',
  'Commands, content, session identifiers, paths, custom rule identifiers and reasons are withheld. The journal hash chain is not verified by this comparison.',
  'Policy scan threshold is not used when evaluating recorded action classes.',
];

export function validateIncidentComparisonRequest(request) {
  if (
    !closed(request, ['id', 'expectedEvidenceSha']) ||
    typeof request.expectedEvidenceSha !== 'string' ||
    !SHA.test(request.expectedEvidenceSha) ||
    request.id !== `incident-${request.expectedEvidenceSha}`
  )
    fail('invalid-request');
}

function selectInput(row) {
  if (
    !object(row) ||
    row.phase !== 'pre' ||
    Object.hasOwn(row, 'outcome') ||
    !object(row.decision) ||
    !['deny', 'ask'].includes(row.decision.effect) ||
    !Array.isArray(row.classes) ||
    row.classes.length > 128 ||
    row.classes.some((value) => !CLASSES.has(value))
  )
    fail('unsupported-evidence');
  return Object.freeze({
    classes: Object.freeze([...row.classes]),
    previousEffect: row.decision.effect,
    scopeRecorded: Object.hasOwn(row, 'scope') || Object.hasOwn(row, 'taskId'),
  });
}

function validateResult(result, input) {
  const classes = (value, max) =>
    Array.isArray(value) &&
    value.length <= max &&
    new Set(value).size === value.length &&
    value.every((item) => CLASSES.has(item));
  if (
    !closed(result, ['semanticSha', 'rules', 'classes', 'scenarios']) ||
    typeof result.semanticSha !== 'string' ||
    !SHA.test(result.semanticSha) ||
    !Number.isSafeInteger(result.rules) ||
    result.rules < 0 ||
    result.rules > 512 ||
    !classes(result.classes, 20) ||
    JSON.stringify(result.classes) !== JSON.stringify([...new Set(input.classes)]) ||
    !Array.isArray(result.scenarios) ||
    result.scenarios.length !== 2
  )
    fail('engine-failed');
  for (const [index, scenario] of result.scenarios.entries()) {
    if (
      !closed(scenario, ['taint', 'effect', 'matchedRule']) ||
      scenario.taint !== ['none', 'suspect'][index] ||
      !EFFECTS.has(scenario.effect)
    )
      fail('engine-failed');
    const rule = scenario.matchedRule;
    if (
      rule !== null &&
      (!closed(rule, ['index', 'classes', 'taint']) ||
        !Number.isSafeInteger(rule.index) ||
        rule.index < 0 ||
        rule.index >= result.rules ||
        !classes(rule.classes, CLASSES.size) ||
        !rule.classes.length ||
        !TAINT.has(rule.taint) ||
        (rule.taint !== 'any' && rule.taint !== scenario.taint) ||
        !rule.classes.some((value) => result.classes.includes(value)))
    )
      fail('engine-failed');
  }
}

/** Selection stays inside the incident service so comparisons share its bounded queue visibility. */
export function createIncidentRecheckService({
  home = process.env.STROQ_HOME || join(homedir(), '.stroq'),
  selectEvidence,
  now = () => new Date(),
  adapter = runIncidentRecheck,
} = {}) {
  if (typeof selectEvidence !== 'function') throw new TypeError('selector-required');
  const root = resolve(home);
  let stopped = false;
  let active = null;
  let controller = null;
  async function compare(request) {
    validateIncidentComparisonRequest(request);
    if (stopped) fail('server-stopped');
    if (active) fail('busy');
    request = Object.freeze({ ...request });
    controller = new AbortController();
    const operation = async () => {
      const input = selectInput(await selectEvidence(request));
      const policy = await readPolicyState(root);
      const result = await adapter(policy.text, input.classes, { signal: controller.signal });
      validateResult(result, input);
      if (stopped) fail('server-stopped');
      const currentInput = selectInput(await selectEvidence(request));
      if (JSON.stringify(currentInput) !== JSON.stringify(input)) fail('stale-evidence');
      const currentPolicy = await readPolicyState(root).catch(() => fail('stale-policy'));
      if (!samePolicyRevision(policy, currentPolicy)) fail('stale-policy');
      if (stopped) fail('server-stopped');
      const at = now();
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) fail('engine-failed');
      const matches = result.scenarios.filter((row) => row.effect === input.previousEffect).length;
      return {
        schema: 'stroq-incident-comparison/1',
        source: 'local',
        incidentId: request.id,
        evidenceSha: request.expectedEvidenceSha,
        comparedAt: at.toISOString(),
        currentPolicy: {
          source: policy.text === null ? 'built-in' : 'file',
          semanticSha: result.semanticSha,
          rawSha: policy.rawSha,
          rules: result.rules,
        },
        previousEffect: input.previousEffect,
        classes: result.classes,
        scopeRecorded: input.scopeRecorded,
        scenarios: result.scenarios,
        relation: matches === 2 ? 'matchesRecorded' : matches === 0 ? 'changed' : 'mixed',
        limitations: [...INCIDENT_COMPARISON_LIMITATIONS],
      };
    };
    active = Promise.resolve().then(operation);
    try {
      return await active;
    } finally {
      active = null;
      controller = null;
    }
  }
  return {
    compare,
    async close() {
      stopped = true;
      controller?.abort();
      await active?.catch(() => undefined);
    },
  };
}
