import {
  ACTION_CLASSES,
  type ActionClass,
  type PolicyCheck,
  type PolicyEffect,
  type PolicyPreview,
} from './policy-control';
import { validatePolicyCaseRegressions, type PolicyCaseRegressions } from './policy-cases';
import { closed, count, hash, member, stamp } from './local-guards';
import { validateMcpGovernanceRestoreDiff, type McpGovernanceRestoreDiff } from './mcp-governance';
export const MAX_POLICY_HISTORY_ENTRIES = 32;
export const POLICY_RESTORE_BLOCKERS = [
  'policy-findings',
  'attacks-allowed',
  'unmet-expectations',
  'unjudged-scenarios',
  'saved-case-failures',
] as const;
export interface PolicyHistoryEntry {
  id: string;
  recordedAt: string;
  beforeRawSha: string | null;
  afterRawSha: string | null;
  afterPolicyFingerprint: string;
  recordSha256: string;
  recovery: 'backup' | 'current-default' | 'unavailable';
}
export interface PolicyHistoryState {
  schema: 'stroq-policy-history/1';
  scope: 'stroq-home';
  runtimeSha256: string;
  currentRawSha: string | null;
  currentPolicyFingerprint: string | null;
  currentValid: boolean;
  history: { status: 'ready' | 'partial' | 'unavailable'; limited: boolean };
  entries: PolicyHistoryEntry[];
  restoreAvailable: boolean;
}
export interface PolicyRestoreDecision {
  actionClass: ActionClass;
  taint: 'none' | 'suspect';
  from: PolicyEffect;
  to: PolicyEffect;
}
export interface PolicyRestoreSettings {
  defaultEffect: PolicyEffect;
  threshold: number;
  rules: number;
}
export interface PolicyRestorePreview {
  schema: 'stroq-policy-restore-preview/2';
  mcpGovernance: McpGovernanceRestoreDiff;
  previewId: string;
  expiresAt: string;
  entryId: string;
  recordSha256: string;
  runtimeSha256: string;
  expectedRawSha: string | null;
  currentPolicyFingerprint: string;
  candidateRawSha: string | null;
  candidateFingerprint: string;
  target: 'backup' | 'current-default';
  scope: 'stroq-home';
  hostEnforcement: false;
  settings: { current: PolicyRestoreSettings; candidate: PolicyRestoreSettings };
  check: PolicyCheck;
  simulation: PolicyPreview['simulation'];
  regressions: PolicyCaseRegressions;
  interruptions: PolicyPreview['interruptions'];
  interruptionsTruncated: boolean;
  decisions: PolicyRestoreDecision[];
  blockers: string[];
}
export interface PolicyRestoreReceipt {
  schema: 'stroq-policy-restore-receipt/1';
  restored: true;
  entryId: string;
  receiptId: string;
  restoredAt: string;
  target: 'backup' | 'current-default';
  scope: 'stroq-home';
  hostEnforcement: false;
  policyFingerprint: string;
  rawSha: string | null;
  backupId: string | null;
  runtimeSha256: string;
}
const nullableHash = (v: unknown) => v === null || hash(v);
const uuid = (v: unknown) =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const effect = (v: unknown): v is PolicyEffect => member(v, ['allow', 'ask', 'deny']);
function target(value: Record<string, unknown>, raw: unknown): boolean {
  return value.target === 'backup' ? hash(raw) : value.target === 'current-default' && raw === null;
}
export function validatePolicyHistoryEntry(v: unknown): v is PolicyHistoryEntry {
  return (
    closed(v, [
      'id',
      'recordedAt',
      'beforeRawSha',
      'afterRawSha',
      'afterPolicyFingerprint',
      'recordSha256',
      'recovery',
    ]) &&
    uuid(v.id) &&
    stamp(v.recordedAt) &&
    nullableHash(v.beforeRawSha) &&
    nullableHash(v.afterRawSha) &&
    (v.beforeRawSha !== null || v.afterRawSha !== null) &&
    hash(v.afterPolicyFingerprint) &&
    hash(v.recordSha256) &&
    (v.recovery === 'unavailable' ||
      (v.recovery === 'backup' && hash(v.beforeRawSha)) ||
      (v.recovery === 'current-default' && v.beforeRawSha === null))
  );
}
export function validatePolicyHistoryState(v: unknown): v is PolicyHistoryState {
  if (
    !closed(v, [
      'schema',
      'scope',
      'runtimeSha256',
      'currentRawSha',
      'currentPolicyFingerprint',
      'currentValid',
      'history',
      'entries',
      'restoreAvailable',
    ]) ||
    v.schema !== 'stroq-policy-history/1' ||
    v.scope !== 'stroq-home' ||
    !hash(v.runtimeSha256) ||
    !nullableHash(v.currentRawSha) ||
    !nullableHash(v.currentPolicyFingerprint) ||
    typeof v.currentValid !== 'boolean' ||
    (v.currentValid && !hash(v.currentPolicyFingerprint)) ||
    !closed(v.history, ['status', 'limited']) ||
    !member(v.history.status, ['ready', 'partial', 'unavailable']) ||
    typeof v.history.limited !== 'boolean' ||
    (v.history.status === 'ready' && v.history.limited) ||
    !Array.isArray(v.entries) ||
    v.entries.length > MAX_POLICY_HISTORY_ENTRIES ||
    !v.entries.every(validatePolicyHistoryEntry) ||
    new Set(v.entries.map((row) => row.id)).size !== v.entries.length ||
    typeof v.restoreAvailable !== 'boolean'
  )
    return false;
  const entries = v.entries as PolicyHistoryEntry[];
  if (
    entries.some(
      (row, index) =>
        index > 0 &&
        !(
          entries[index - 1]!.recordedAt > row.recordedAt ||
          (entries[index - 1]!.recordedAt === row.recordedAt && entries[index - 1]!.id > row.id)
        ),
    )
  )
    return false;
  if (v.history.status === 'unavailable' && (entries.length > 0 || v.restoreAvailable))
    return false;
  return (
    !v.restoreAvailable || (v.currentValid && entries.some((row) => row.recovery !== 'unavailable'))
  );
}
const FINDING_SEVERITIES: Record<string, readonly string[]> = {
  'dropped-protection': ['error', 'warning'],
  'shadowed-rule': ['warning'],
  'high-threshold': ['warning'],
  'loose-default': ['info'],
  'unknown-field': ['warning'],
};
function validCheck(v: unknown): v is PolicyCheck {
  if (
    !closed(v, ['ok', 'loaded', 'faults', 'findings']) ||
    typeof v.ok !== 'boolean' ||
    v.loaded !== true ||
    v.faults !== 0 ||
    !Array.isArray(v.findings) ||
    v.findings.length > 64 ||
    !v.findings.every(
      (row) =>
        closed(row, ['kind', 'severity', 'count']) &&
        typeof row.kind === 'string' &&
        Object.hasOwn(FINDING_SEVERITIES, row.kind) &&
        member(row.severity, FINDING_SEVERITIES[row.kind]!) &&
        count(row.count) &&
        row.count > 0,
    ) ||
    new Set(v.findings.map((row) => `${row.kind}:${row.severity}`)).size !== v.findings.length
  )
    return false;
  return v.ok === v.findings.every((row) => row.severity === 'info');
}
function validSimulation(v: unknown): v is PolicyPreview['simulation'] {
  return (
    closed(v, [
      'ok',
      'replayed',
      'attacksPassing',
      'newInterruptions',
      'relieved',
      'violations',
      'notJudged',
    ]) &&
    typeof v.ok === 'boolean' &&
    closed(v.replayed, ['attack', 'ordinary', 'cases']) &&
    count(v.replayed.attack) &&
    count(v.replayed.ordinary) &&
    v.replayed.cases === 0 &&
    ['attacksPassing', 'newInterruptions', 'relieved', 'violations', 'notJudged'].every((key) =>
      count(v[key]),
    ) &&
    v.ok === (v.attacksPassing === 0 && v.violations === 0 && v.notJudged === 0)
  );
}
function decision(v: unknown): v is PolicyRestoreDecision {
  return (
    closed(v, ['actionClass', 'taint', 'from', 'to']) &&
    member(v.actionClass, ACTION_CLASSES) &&
    member(v.taint, ['none', 'suspect']) &&
    effect(v.from) &&
    effect(v.to) &&
    v.from !== v.to
  );
}
function settings(v: unknown): v is PolicyRestoreSettings {
  return (
    closed(v, ['defaultEffect', 'threshold', 'rules']) &&
    effect(v.defaultEffect) &&
    typeof v.threshold === 'number' &&
    Number.isFinite(v.threshold) &&
    v.threshold >= 0 &&
    v.threshold <= 1 &&
    count(v.rules, 512)
  );
}
export function validatePolicyRestorePreview(v: unknown): v is PolicyRestorePreview {
  if (
    !closed(v, [
      'schema',
      'previewId',
      'mcpGovernance',
      'expiresAt',
      'entryId',
      'recordSha256',
      'runtimeSha256',
      'expectedRawSha',
      'currentPolicyFingerprint',
      'candidateRawSha',
      'candidateFingerprint',
      'target',
      'scope',
      'hostEnforcement',
      'settings',
      'check',
      'simulation',
      'regressions',
      'interruptions',
      'interruptionsTruncated',
      'decisions',
      'blockers',
    ]) ||
    v.schema !== 'stroq-policy-restore-preview/2' ||
    !validateMcpGovernanceRestoreDiff(v.mcpGovernance) ||
    !uuid(v.previewId) ||
    !uuid(v.entryId) ||
    !stamp(v.expiresAt) ||
    !hash(v.recordSha256) ||
    !hash(v.runtimeSha256) ||
    !nullableHash(v.expectedRawSha) ||
    !hash(v.currentPolicyFingerprint) ||
    !hash(v.candidateFingerprint) ||
    !target(v, v.candidateRawSha) ||
    v.scope !== 'stroq-home' ||
    v.hostEnforcement !== false ||
    !closed(v.settings, ['current', 'candidate']) ||
    !settings(v.settings.current) ||
    !settings(v.settings.candidate) ||
    !validCheck(v.check) ||
    !validSimulation(v.simulation) ||
    !validatePolicyCaseRegressions(v.regressions) ||
    !Array.isArray(v.decisions) ||
    v.decisions.length > ACTION_CLASSES.length * 2 ||
    !v.decisions.every(decision) ||
    typeof v.interruptionsTruncated !== 'boolean' ||
    !Array.isArray(v.interruptions) ||
    v.interruptions.length !== Math.min(v.simulation.newInterruptions, 128) ||
    v.interruptionsTruncated !== v.simulation.newInterruptions > 128
  )
    return false;
  const order = (row: PolicyRestoreDecision) =>
    ACTION_CLASSES.indexOf(row.actionClass) * 2 + (row.taint === 'suspect' ? 1 : 0);
  if (
    (v.decisions as PolicyRestoreDecision[]).some(
      (row, index, all) => index > 0 && order(all[index - 1]!) >= order(row),
    )
  )
    return false;
  if (
    !v.interruptions.every(
      (row) =>
        closed(row, ['label', 'step', 'from', 'to']) &&
        typeof row.label === 'string' &&
        Object.hasOwn(POLICY_RESTORE_ORDINARY_STEPS, row.label) &&
        count(row.step, POLICY_RESTORE_ORDINARY_STEPS[row.label]!) &&
        row.step >= 1 &&
        member(row.from, ['allow', 'ask', 'deny', 'clean', 'suspect']) &&
        member(row.to, ['allow', 'ask', 'deny', 'clean', 'suspect']) &&
        row.from !== row.to,
    )
  )
    return false;
  const expected = [
    ...(!v.check.ok ? ['policy-findings'] : []),
    ...(v.simulation.attacksPassing > 0 ? ['attacks-allowed'] : []),
    ...(v.simulation.violations > 0 ? ['unmet-expectations'] : []),
    ...(v.simulation.notJudged > 0 ? ['unjudged-scenarios'] : []),
    ...(v.regressions.failed > 0 ? ['saved-case-failures'] : []),
  ];
  return (
    Array.isArray(v.blockers) &&
    v.blockers.length === expected.length &&
    v.blockers.every((row, index) => row === expected[index])
  );
}
export function validatePolicyRestoreReceipt(v: unknown): v is PolicyRestoreReceipt {
  return (
    closed(v, [
      'schema',
      'restored',
      'entryId',
      'receiptId',
      'restoredAt',
      'target',
      'scope',
      'hostEnforcement',
      'policyFingerprint',
      'rawSha',
      'backupId',
      'runtimeSha256',
    ]) &&
    v.schema === 'stroq-policy-restore-receipt/1' &&
    v.restored === true &&
    uuid(v.entryId) &&
    uuid(v.receiptId) &&
    stamp(v.restoredAt) &&
    target(v, v.rawSha) &&
    v.scope === 'stroq-home' &&
    v.hostEnforcement === false &&
    hash(v.policyFingerprint) &&
    (v.backupId === null || uuid(v.backupId)) &&
    hash(v.runtimeSha256)
  );
}

/** Only fixed public fixture labels and step bounds, without commands or scenario contents. */
export const POLICY_RESTORE_ORDINARY_STEPS: Readonly<Record<string, number>> = {
  'Look at what changed': 1,
  'Commit with a message that talks about the installer': 1,
  'Start a branch and push it': 1,
  'Read recent history': 1,
  'Open a pull request with a checklist in the body': 1,
  'Update the branch under local changes': 1,
  'Redo the last commit message': 1,
  'Unstage a draft': 1,
  'List open bugs': 1,
  'Bump the patch version': 1,
  'Install, build and test': 1,
  'Run the tests and read the end of the output': 1,
  'Run one test file by name': 1,
  'Set up a virtual environment': 1,
  'Check a Rust workspace and a Go module': 1,
  'Run one Flutter test': 1,
  'Start the database and read its log': 1,
  'List the TypeScript sources': 1,
  'Find the open TODOs': 1,
  'Search for a hook call': 1,
  'Rename a function across two files': 1,
  'Write a small config module with a here-document': 1,
  'Read a field of package.json with an inline Python script': 1,
  'List the dependencies': 1,
  'Run the release script without releasing': 1,
  'Clean the build output and build again': 1,
  'Go into a package and test it': 1,
  'Count the lines of each source file': 1,
  'Find files that mention a deprecated API': 1,
  'Stop the dev server that holds port 3000': 1,
  'Look for a stuck Node process': 1,
  'Start an ssh agent in the shell': 1,
  'Fetch JSON and pretty-print it': 1,
  'Read a version from the registry': 1,
  'Call an API with a token from the environment, over several lines': 1,
  'Download a data file': 1,
  'Check that the local server answers': 1,
  'Look at a staging host': 1,
  'Read a source file': 1,
  'Read the example environment file': 1,
  'Read a README whose install section pipes a script into sh': 1,
  'Change one line of a source file': 1,
  'Write a new test file': 1,
  'Add a convention to the project instructions': 1,
  'Search the sources with the Grep tool': 1,
  'Read the Node.js documentation': 2,
  'List pull requests through the GitHub server': 2,
  'Read a project file through the filesystem server': 1,
  'Read a git log whose messages say ignore and previous': 1,
  'Read the output of a failing test run': 1,
  'Read one field of an API answer with an inline Python program': 1,
  'List the items of an API answer with a longer inline Python program': 1,
  'Read an API answer with a Python program that also reads an environment variable': 1,
  'Fetch an API answer and save it with an inline Python program': 1,
  'Read the latest version of a package from the registry with an inline Node program': 1,
  'Read one field of an API answer with node -p': 1,
  'Read the names in an API answer with jq': 1,
  'Pretty-print an API answer into a file': 1,
  'Download an installer to a file and read it before running anything': 1,
  'Write a runbook that lists the commands to avoid': 1,
  'Commit with a message read from standard input': 1,
  'Open a pull request with a body read from standard input': 1,
  'Append a note to a progress file in a variable directory': 1,
  'Start an ssh agent and list its keys': 1,
  "Load Homebrew's environment": 1,
  'Load pyenv and check the Python version': 1,
  'Load direnv in this shell': 1,
  'Read the version from package.json with Python': 1,
  'Read the version from package.json with Node': 1,
  'Start the services and read the last log lines': 1,
  'Install, build and lint': 1,
  'Rename an identifier with sed and look at the diff': 1,
  'Count the lines of the test files': 1,
  'Post a small JSON body to a webhook': 1,
  'Pull and restart a service on the staging server': 1,
};
