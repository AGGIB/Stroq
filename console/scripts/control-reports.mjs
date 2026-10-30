import { pathToFileURL } from 'node:url';
import { runtimeLayout } from './runtime-layout.mjs';

// Missing engine adapters must not prevent the read-only console from starting.
let doctorSchema = null;
try {
  doctorSchema = await import(pathToFileURL(runtimeLayout().adapter('control-schema.js')).href);
} catch {
  /* Typed results cannot be accepted until the fixed engine adapter is built. */
}

export const MAX_CONTENT_BYTES = 48 * 1024;
const KINDS = ['doctor', 'policy-check', 'guard-test', 'content-scan', 'protection-check'];
const FINDINGS = [
  'shadowed-rule',
  'dropped-protection',
  'loose-default',
  'high-threshold',
  'unknown-field',
];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'];
const CHECK_LABELS = new Map([
  ['stroq', 'Stroq engine'],
  ['node', 'Node runtime'],
  ['rules', 'Bundled rules'],
  ['self-test', 'Scanner self-test'],
  ['hooks', 'Claude Code hook check'],
  ['cursor hooks', 'Cursor hook check'],
  ['codex hooks', 'Codex hook check'],
  ['copilot hooks', 'Copilot hook check'],
  ['openclaw plugin', 'OpenClaw plugin check'],
  ['windsurf hooks', 'Windsurf hook check'],
  ['antigravity hooks', 'Antigravity hook check'],
  ['mcp proxy', 'MCP proxy check'],
  ['mcp pins and the sandbox', 'MCP pin and sandbox check'],
  ['home', 'Stroq data location'],
  ['secrets', 'Secret-index statistics'],
]);
const object = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const count = (value) => Number.isInteger(value) && value >= 0 && value <= 100_000;
const list = (value, max = 10_000) =>
  Array.isArray(value) && value.length <= max && value.every((item) => object(item));
const string = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const requireValid = (condition) => {
  if (!condition) throw new Error('invalid-report');
};

export function validRunInput(value) {
  if (!object(value) || !KINDS.includes(value.kind)) return false;
  const keys = Object.keys(value);
  if (value.kind !== 'content-scan') return keys.length === 1;
  return (
    keys.length === 3 &&
    keys.every((key) => ['kind', 'content', 'target'].includes(key)) &&
    ['skill', 'tool-result'].includes(value.target) &&
    typeof value.content === 'string' &&
    value.content.trim().length > 0 &&
    !value.content.includes('\u0000') &&
    Buffer.byteLength(value.content, 'utf8') <= MAX_CONTENT_BYTES
  );
}

/** Only already validated, producer-owned facts enter the parent history. */
export async function protectionEvidence(kind, value, workspaceId, validate) {
  if (!validate) {
    const schema = await import(pathToFileURL(runtimeLayout().adapter('local-api-schema.js')).href);
    validate = (id, report) =>
      schema[id === 'saved-policy-checks' ? 'validatePolicyCases' : 'validateWorkspaceReviewRun']?.(
        report,
      ) === true;
  }
  requireValid(validate(kind, value) && value.workspaceId === workspaceId);
  if (kind === 'saved-policy-checks') {
    const { policy, total, passed, failed, results } = value.report;
    return {
      source: 'local',
      evidence: 'simulation',
      workspaceId,
      generatedAt: value.generatedAt,
      revision: value.revision,
      policy: structuredClone(policy),
      total,
      passed,
      failed,
      cases: value.cases.map((record) => ({ id: record.id, classes: [...record.classes] })),
      results: results.map((row) => ({
        caseId: row.caseId,
        passed: row.passed,
        scenarios: row.scenarios.map((s) => ({
          taint: s.taint,
          expected: s.expected,
          actual: s.actual,
        })),
      })),
      hostEnforcement: false,
    };
  }
  requireValid(value.status === 'completed');
  const capture = value.result.capture;
  return {
    source: 'local',
    evidence: 'static-capture',
    runId: value.id,
    workspaceId,
    captureSha256: capture.captureSha256,
    capturedAt: capture.capturedAt,
    profile: structuredClone(capture.profile),
    complete: capture.complete,
    sources: capture.sources.length,
    entries: capture.entries.length,
    errors: capture.entries.filter((entry) => entry.severity === 'error').length,
    warnings: capture.entries.filter((entry) => entry.severity === 'warning').length,
    notices: capture.entries.filter((entry) => entry.severity === 'notice').length,
    coverage: {
      omittedSources: capture.coverage.omittedSources,
      omittedEntries: capture.coverage.omittedEntries,
      gaps: capture.coverage.gaps.length,
    },
    hostEnforcement: false,
  };
}

function doctorReport(raw) {
  requireValid(
    raw.version === 1 &&
      typeof raw.ok === 'boolean' &&
      list(raw.checks, 128) &&
      raw.checks.length > 0 &&
      raw.checks.every(
        (check) => typeof check.ok === 'boolean' && typeof check.name === 'string',
      ) &&
      raw.ok === raw.checks.every((check) => check.ok),
  );
  const typed = Object.hasOwn(raw, 'diagnosticsVersion');
  requireValid(
    typed
      ? raw.diagnosticsVersion === 1 &&
          typeof doctorSchema?.doctorDiagnosticMatchesCheck === 'function' &&
          typeof doctorSchema?.doctorDiagnosticLabel === 'function' &&
          raw.checks.every((check) =>
            doctorSchema.doctorDiagnosticMatchesCheck(check.diagnostic, check.ok),
          )
      : raw.checks.every((check) => !Object.hasOwn(check, 'diagnostic')),
  );
  const checks = raw.checks.map((check, index) => ({
    id: `check-${index + 1}`,
    label: typed
      ? doctorSchema.doctorDiagnosticLabel(check.diagnostic.kind)
      : (CHECK_LABELS.get(check.name) ?? 'Additional installation check'),
    ok: check.ok,
    ...(typed ? { diagnostic: structuredClone(check.diagnostic) } : {}),
  }));
  return {
    source: 'local',
    evidence: 'configuration',
    ...(typed ? { diagnosticsVersion: 1 } : {}),
    ok: raw.ok,
    checks,
    passed: checks.filter((check) => check.ok).length,
    total: checks.length,
  };
}

function policyReport(raw) {
  requireValid(
    raw.version === 1 &&
      typeof raw.ok === 'boolean' &&
      typeof raw.loaded === 'boolean' &&
      ['default', 'file'].includes(raw.source) &&
      list(raw.faults, 1000) &&
      list(raw.findings, 5000),
  );
  requireValid(
    raw.loaded
      ? object(raw.policy) &&
          count(raw.policy.rules) &&
          ['allow', 'ask', 'deny'].includes(raw.policy.default) &&
          Number.isFinite(raw.policy.threshold) &&
          raw.policy.threshold >= 0 &&
          raw.policy.threshold <= 1 &&
          raw.faults.length === 0
      : raw.policy === null && raw.faults.length > 0,
  );
  requireValid(
    raw.findings.every(
      (finding) =>
        FINDINGS.includes(finding.kind) && ['error', 'warning', 'info'].includes(finding.severity),
    ),
  );
  requireValid(
    raw.ok === (raw.loaded && !raw.findings.some((finding) => finding.severity !== 'info')),
  );
  const grouped = new Map();
  for (const finding of raw.findings) {
    const key = `${finding.kind}:${finding.severity}`;
    const previous = grouped.get(key);
    grouped.set(key, {
      kind: finding.kind,
      severity: finding.severity,
      count: (previous?.count ?? 0) + 1,
    });
  }
  return {
    source: 'local',
    evidence: 'configuration',
    ok: raw.ok,
    loaded: raw.loaded,
    policySource: raw.source,
    rules: raw.policy?.rules ?? null,
    defaultEffect: raw.policy?.default ?? null,
    threshold: raw.policy?.threshold ?? null,
    faults: raw.faults.length,
    findings: [...grouped.values()],
  };
}

function guardReport(raw) {
  requireValid(
    raw.version === 1 &&
      typeof raw.ok === 'boolean' &&
      object(raw.replayed) &&
      ['attack', 'ordinary', 'cases'].every((key) => count(raw.replayed[key])),
  );
  const fields = ['attacksPassing', 'newInterruptions', 'relieved', 'violations', 'notJudged'];
  requireValid(fields.every((field) => list(raw[field])));
  requireValid(
    !raw.ok ||
      (raw.attacksPassing.length === 0 &&
        raw.violations.length === 0 &&
        raw.notJudged.length === 0),
  );
  requireValid(raw.replayed.attack + raw.replayed.ordinary + raw.replayed.cases > 0);
  return {
    source: 'local',
    evidence: 'simulation',
    ok: raw.ok,
    replayed: {
      attack: raw.replayed.attack,
      ordinary: raw.replayed.ordinary,
      cases: raw.replayed.cases,
    },
    ...Object.fromEntries(fields.map((field) => [field, raw[field].length])),
  };
}

function scanReport(raw) {
  requireValid(
    ['skill', 'tool-result'].includes(raw.target) &&
      ['clean', 'suspect'].includes(raw.verdict) &&
      Number.isFinite(raw.score) &&
      raw.score >= 0 &&
      raw.score <= 1 &&
      typeof raw.timedOut === 'boolean' &&
      count(raw.characters) &&
      raw.characters > 0 &&
      typeof raw.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(raw.sha256) &&
      list(raw.matches, 512),
  );
  requireValid(raw.verdict === (raw.score >= 0.6 ? 'suspect' : 'clean'));
  requireValid(!raw.timedOut || (raw.verdict === 'suspect' && raw.score === 1));
  const matches = raw.matches.map((match) => {
    requireValid(
      string(match.ruleId, 200) &&
        /^[A-Za-z0-9_.-]+$/.test(match.ruleId) &&
        string(match.title, 300) &&
        SEVERITIES.includes(match.severity) &&
        string(match.category, 100) &&
        string(match.variant, 100),
    );
    return {
      ruleId: match.ruleId,
      title: match.title,
      severity: match.severity,
      category: match.category,
      variant: match.variant,
    };
  });
  return {
    source: 'local',
    evidence: 'content-scan',
    target: raw.target,
    verdict: raw.verdict,
    score: raw.score,
    timedOut: raw.timedOut,
    matches,
    characters: raw.characters,
    sha256: raw.sha256,
  };
}

/** Project untrusted CLI JSON into an explicit, bounded browser schema. */
export function normalizeReport(kind, raw) {
  requireValid(object(raw));
  if (kind === 'doctor') return doctorReport(raw);
  if (kind === 'policy-check') return policyReport(raw);
  if (kind === 'guard-test') return guardReport(raw);
  if (kind === 'content-scan') return scanReport(raw);
  throw new Error('invalid-report');
}

export function summaryOf(kind, result) {
  if (kind === 'doctor') return `${result.total} installation checks recorded`;
  if (kind === 'policy-check')
    return result.ok ? 'Policy check completed' : 'Policy needs attention';
  if (kind === 'guard-test')
    return result.ok ? 'Policy scenarios met expectations' : 'Policy scenarios need attention';
  if (result.timedOut) return 'Scan incomplete: time budget exceeded';
  return result.verdict === 'suspect'
    ? 'Suspicious content detected'
    : 'No matching threat detected';
}

const PROTECTION_STEPS = [
  'doctor',
  'policy-check',
  'guard-test',
  'saved-policy-checks',
  'workspace-review',
];
export const protectionStamp = (run) =>
  new Date(
    Math.max(
      Date.now(),
      Date.parse(run.startedAt),
      ...(run.progress?.steps ?? [])
        .flatMap((step) => [step.startedAt, step.finishedAt])
        .map((value) => Date.parse(value))
        .filter(Number.isFinite),
    ),
  ).toISOString();
export const initialProtectionProgress = () => ({
  steps: PROTECTION_STEPS.map((id) => ({
    id,
    status: 'queued',
    startedAt: null,
    finishedAt: null,
    error: null,
    result: null,
  })),
});
export function finishProtectionRun(run, error = null) {
  const finishedAt = protectionStamp(run);
  const steps = run.progress.steps.map((step) =>
    ['queued', 'running'].includes(step.status)
      ? {
          ...step,
          status: step.status === 'queued' ? 'skipped' : 'failed',
          finishedAt,
          error: error ?? 'engine-failed',
          result: null,
        }
      : step,
  );
  const completed = steps.filter((step) => step.status === 'completed').length;
  const reason = error ?? steps.find((step) => step.error)?.error ?? null;
  return {
    ...run,
    status: reason === 'cancelled' ? 'cancelled' : reason ? 'failed' : 'completed',
    finishedAt,
    progress: { steps },
    ...(reason ? { error: reason } : {}),
    result: {
      source: 'local',
      evidence: 'local-checks',
      outcome: reason ? 'incomplete' : 'finished',
      completed,
      total: 5,
      hostEnforcement: false,
    },
  };
}
