import { closed, count, member, stamp } from './local-guards';

export const SECRET_PROVIDERS = [
  'AWS',
  'GitHub',
  'GitLab',
  'Bitbucket',
  'Azure',
  'OpenAI',
  'Anthropic',
  'Stripe',
  'Google',
  'npm',
  'Docker',
  'Slack',
  'Discord',
  'Notion',
  'Linear',
  'Twilio',
  'Supabase',
  'Hosting',
  'Monitoring',
  'Database',
  'SSH or a private key',
  'Other',
  'Stroq canary',
] as const;
export const SECRET_TIERS = ['third_party', 'maybe', 'seen', 'own_service', 'blocked'] as const;
export const SECRET_ROUTES = [
  'command',
  'command-near',
  'command-ran',
  'command-unread',
  'post',
  'secret-store',
  'ssh',
  'git-push',
  'publish',
  'web-fetch',
  'web-search',
  'mcp',
  'write',
  'write-script',
  'write-sent',
  'write-push',
  'arguments',
  'result',
  'prompt',
  'reply',
  'record',
  'cut',
] as const;
export const SECRET_GAPS = [
  'cursor',
  'cursor-recent',
  'saved-outputs',
  'key-files',
  'search-cut',
  'rejected-lines',
  'subfolder-env-files',
  'no-sessions',
  'unreadable-files',
  'key-files-unreadable',
  'sessions-no-folder',
  'sessions-not-placed',
  'canaries-not-found',
  'work-cut',
  'custom-codex-home',
] as const;
export const SECRET_LIMITATIONS = [
  'Each credential appears once under its most external recorded tier; counts are not all events or all model-visible credentials.',
  'Recorded calls and text are historical evidence, not proof that a destination received a value or a host enforced a block.',
  'A reported stop can be written by a command or transcript; it is not verified live protection.',
  'Only currently readable credential values are compared. Rotated, deleted, unknown, split or encoded credentials may be missed.',
  'Scripts, variables and later network calls can send values without recording them. No findings does not establish that credentials stayed local.',
  'SSH, kube, gcloud, keychains and credentials stored in JSON, YAML or TOML are outside this comparison.',
  'Only retained Claude Code, Codex and Cursor sessions are supported. Deleted sessions and other agents are outside this comparison.',
  'Archived Codex sessions and non-default CODEX_HOME layouts are not read.',
  'Session discovery enumerates metadata, and Cursor discovery reads its local session store before project selection. Credential matching is scoped to the selected project sessions.',
  'Project scope selects related session history; it is not a filesystem sandbox. Credential matching reads home credential files, the process environment, workspace and related ancestor .env files, and registered canary files. Symlinks and canary paths may resolve elsewhere.',
  'The existing engine also reads local MCP and git configuration and recorded references to saved tool outputs for classification. These reads can extend beyond the selected workspace.',
  'Source, credential and destination names are withheld. Provider labels are inferred from the engine table, not verified account identities.',
  'Values remain in the isolated process memory for the scan and are never intentionally persisted or returned. Runtime memory cannot be guaranteed physically erased.',
] as const;
export const SECRET_SOURCES = [
  'home-credential-file',
  'project-env-file',
  'environment',
  'canary',
  'other',
] as const;
export const SECRET_AGENTS = ['claude-code', 'codex', 'cursor', 'unknown'] as const;
export const SECRET_ERRORS = [
  'engine-unavailable',
  'input-limit',
  'deadline-exceeded',
  'output-limit',
  'cancelled',
  'invalid-report',
  'server-stopped',
  'scan-failed',
] as const;

export type SecretScope = 'project' | 'last';
export type SecretTier = (typeof SECRET_TIERS)[number];
export interface SecretFinding {
  id: string;
  provider: (typeof SECRET_PROVIDERS)[number];
  source: (typeof SECRET_SOURCES)[number];
  tier: SecretTier;
  route: (typeof SECRET_ROUTES)[number];
  agent: (typeof SECRET_AGENTS)[number];
  at: string | null;
  occurrences: number;
  sessions: number;
  seen: number;
  reportedStopped: boolean;
  wouldBe: SecretTier | null;
  canary: boolean;
  laterNetworkCommands: number;
}
export interface SecretReport {
  schema: 'stroq-secret-scan-report/1';
  source: 'local';
  scope: SecretScope;
  checkedAt: string;
  evidence: 'recorded-transcripts';
  complete: boolean;
  sessions: { total: number; claudeCode: number; codex: number; cursor: number; skipped: number };
  keys: {
    compared: number;
    sourceFiles: number;
    environment: number;
    unreadableFiles: number;
    partialFiles: number;
    skippedFiles: number;
    rejectedLines: number;
    truncated: boolean;
  };
  totals: {
    findings: number;
    external: number;
    uncertain: number;
    modelVisible: number;
    ownService: number;
    reportedStopped: number;
  };
  findings: SecretFinding[];
  omittedFindings: number;
  notChecked: (typeof SECRET_GAPS)[number][];
  limitations: (typeof SECRET_LIMITATIONS)[number][];
}
export interface SecretJob {
  schema: 'stroq-secrets-job/1';
  id: string;
  scope: SecretScope;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  result?: SecretReport;
  error?: (typeof SECRET_ERRORS)[number];
}
export interface SecretState {
  schema: 'stroq-secrets/1';
  engine: { available: boolean; version: string | null };
  jobs: SecretJob[];
}
export interface SecretPreview {
  schema: 'stroq-secrets-preview/1';
  id: string;
  scope: SecretScope;
  createdAt: string;
  expiresAt: string;
  engineVersion: string | null;
  canStart: boolean;
  reason: null | 'engine-unavailable';
  disclosure: {
    credentialValuesInMemoryOnly: true;
    readsHomeCredentialFiles: true;
    readsEnvironmentCredentials: true;
    readsProjectEnvFiles: true;
    readsProjectAncestorEnvFiles: true;
    readsRelatedSessionEnvFiles: true;
    followsCredentialFileSymlinks: true;
    readsRegisteredCanaryFiles: true;
    readsAgentAndGitMetadata: true;
    readsReferencedSavedOutputs: true;
    readsSelectedProjectTranscripts: true;
    enumeratesSessionMetadata: true;
    readsCursorStoreForDiscovery: true;
    externalRequests: false;
    writesCredentials: false;
    deadlineMs: 120_000;
    heapLimitMiB: 256;
  };
}

const scopes = ['project', 'last'];
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const version = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-zA-Z0-9.-]{1,30})?$/.test(v);
const boundedCount = (v: unknown): v is number => count(v, 1_000_000_000);
const exactObject = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  closed(v, keys) && keys.every((key) => Object.hasOwn(v, key));
const counts = <K extends string>(v: unknown, keys: readonly K[]): v is Record<K, number> =>
  exactObject(v, keys) && keys.every((key) => boundedCount(v[key]));

function validateFinding(v: unknown, index: number): v is SecretFinding {
  return (
    exactObject(v, [
      'id',
      'provider',
      'source',
      'tier',
      'route',
      'agent',
      'at',
      'occurrences',
      'sessions',
      'seen',
      'reportedStopped',
      'wouldBe',
      'canary',
      'laterNetworkCommands',
    ]) &&
    v.id === `credential-${index + 1}` &&
    member(v.provider, SECRET_PROVIDERS) &&
    member(v.source, SECRET_SOURCES) &&
    member(v.tier, SECRET_TIERS) &&
    member(v.route, SECRET_ROUTES) &&
    member(v.agent, SECRET_AGENTS) &&
    (v.at === null || stamp(v.at)) &&
    ['occurrences', 'sessions', 'seen', 'laterNetworkCommands'].every((key) =>
      boundedCount(v[key]),
    ) &&
    typeof v.reportedStopped === 'boolean' &&
    (v.wouldBe === null || member(v.wouldBe, SECRET_TIERS)) &&
    typeof v.canary === 'boolean'
  );
}

/** Only the closed, derived scanner projection may enter browser state. */
export function validateSecretReport(v: unknown): v is SecretReport {
  if (
    !exactObject(v, [
      'schema',
      'source',
      'scope',
      'checkedAt',
      'evidence',
      'complete',
      'sessions',
      'keys',
      'totals',
      'findings',
      'omittedFindings',
      'notChecked',
      'limitations',
    ]) ||
    v.schema !== 'stroq-secret-scan-report/1' ||
    v.source !== 'local' ||
    !member(v.scope, scopes) ||
    !stamp(v.checkedAt) ||
    v.evidence !== 'recorded-transcripts' ||
    typeof v.complete !== 'boolean'
  )
    return false;
  if (
    !counts(v.sessions, ['total', 'claudeCode', 'codex', 'cursor', 'skipped']) ||
    v.sessions.total !== v.sessions.claudeCode + v.sessions.codex + v.sessions.cursor ||
    (v.scope === 'last' && v.sessions.total > 1) ||
    !exactObject(v.keys, [
      'compared',
      'sourceFiles',
      'environment',
      'unreadableFiles',
      'partialFiles',
      'skippedFiles',
      'rejectedLines',
      'truncated',
    ]) ||
    Object.entries(v.keys).some(([key, value]) =>
      key === 'truncated' ? typeof value !== 'boolean' : !boundedCount(value),
    )
  )
    return false;
  if (
    !counts(v.totals, [
      'findings',
      'external',
      'uncertain',
      'modelVisible',
      'ownService',
      'reportedStopped',
    ]) ||
    !boundedCount(v.keys.compared) ||
    v.totals.findings > v.keys.compared ||
    v.totals.findings !==
      v.totals.external +
        v.totals.uncertain +
        v.totals.modelVisible +
        v.totals.ownService +
        v.totals.reportedStopped ||
    !Array.isArray(v.findings) ||
    v.findings.length > 200 ||
    !boundedCount(v.omittedFindings) ||
    v.findings.length + v.omittedFindings !== v.totals.findings
  )
    return false;
  if (
    !Array.isArray(v.notChecked) ||
    v.notChecked.length > SECRET_GAPS.length ||
    new Set(v.notChecked).size !== v.notChecked.length ||
    !v.notChecked.every((gap) => member(gap, SECRET_GAPS)) ||
    (v.complete && (v.notChecked.length > 0 || v.omittedFindings > 0)) ||
    !Array.isArray(v.limitations) ||
    v.limitations.length !== SECRET_LIMITATIONS.length ||
    !v.limitations.every((item, i) => item === SECRET_LIMITATIONS[i])
  )
    return false;
  if (
    v.complete &&
    (v.sessions.total === 0 ||
      v.sessions.skipped > 0 ||
      v.keys.truncated ||
      ['unreadableFiles', 'partialFiles', 'skippedFiles', 'rejectedLines'].some(
        (key) => (v.keys as Record<string, number>)[key]! > 0,
      ))
  )
    return false;
  return v.findings.every(validateFinding);
}

export function validateSecretJob(v: unknown): v is SecretJob {
  if (
    !closed(v, ['schema', 'id', 'scope', 'status', 'startedAt', 'finishedAt', 'result', 'error']) ||
    v.schema !== 'stroq-secrets-job/1' ||
    !uuid(v.id) ||
    !member(v.scope, scopes) ||
    !member(v.status, ['running', 'completed', 'failed', 'cancelled']) ||
    !stamp(v.startedAt)
  )
    return false;
  if (v.status === 'running')
    return !['finishedAt', 'result', 'error'].some((key) => Object.hasOwn(v, key));
  if (!stamp(v.finishedAt) || v.finishedAt < v.startedAt) return false;
  if (v.status === 'completed')
    return (
      validateSecretReport(v.result) && v.result.scope === v.scope && !Object.hasOwn(v, 'error')
    );
  if (Object.hasOwn(v, 'result')) return false;
  return v.status === 'cancelled' ? !Object.hasOwn(v, 'error') : member(v.error, SECRET_ERRORS);
}

export function validateSecretState(v: unknown): v is SecretState {
  return (
    exactObject(v, ['schema', 'engine', 'jobs']) &&
    v.schema === 'stroq-secrets/1' &&
    exactObject(v.engine, ['available', 'version']) &&
    typeof v.engine.available === 'boolean' &&
    (v.engine.available ? version(v.engine.version) : v.engine.version === null) &&
    Array.isArray(v.jobs) &&
    v.jobs.length <= 8 &&
    v.jobs.every(validateSecretJob) &&
    new Set(v.jobs.map((job: SecretJob) => job.id)).size === v.jobs.length &&
    v.jobs.filter((job: SecretJob) => job.status === 'running').length <= 1
  );
}

export function validateSecretPreview(v: unknown): v is SecretPreview {
  if (
    !exactObject(v, [
      'schema',
      'id',
      'scope',
      'createdAt',
      'expiresAt',
      'engineVersion',
      'canStart',
      'reason',
      'disclosure',
    ]) ||
    v.schema !== 'stroq-secrets-preview/1' ||
    !uuid(v.id) ||
    !member(v.scope, scopes) ||
    !stamp(v.createdAt) ||
    !stamp(v.expiresAt) ||
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) !== 120_000 ||
    typeof v.canStart !== 'boolean' ||
    (v.canStart
      ? !version(v.engineVersion) || v.reason !== null
      : v.engineVersion !== null || v.reason !== 'engine-unavailable')
  )
    return false;
  return (
    exactObject(v.disclosure, [
      'credentialValuesInMemoryOnly',
      'readsHomeCredentialFiles',
      'readsEnvironmentCredentials',
      'readsProjectEnvFiles',
      'readsSelectedProjectTranscripts',
      'enumeratesSessionMetadata',
      'readsProjectAncestorEnvFiles',
      'readsRelatedSessionEnvFiles',
      'followsCredentialFileSymlinks',
      'readsRegisteredCanaryFiles',
      'readsAgentAndGitMetadata',
      'readsReferencedSavedOutputs',
      'readsCursorStoreForDiscovery',
      'externalRequests',
      'writesCredentials',
      'deadlineMs',
      'heapLimitMiB',
    ]) &&
    [
      'credentialValuesInMemoryOnly',
      'readsHomeCredentialFiles',
      'readsEnvironmentCredentials',
      'readsProjectEnvFiles',
      'readsSelectedProjectTranscripts',
      'enumeratesSessionMetadata',
      'readsProjectAncestorEnvFiles',
      'readsRelatedSessionEnvFiles',
      'followsCredentialFileSymlinks',
      'readsRegisteredCanaryFiles',
      'readsAgentAndGitMetadata',
      'readsReferencedSavedOutputs',
      'readsCursorStoreForDiscovery',
    ].every((key) => (v.disclosure as Record<string, unknown>)[key] === true) &&
    v.disclosure.externalRequests === false &&
    v.disclosure.writesCredentials === false &&
    v.disclosure.deadlineMs === 120_000 &&
    v.disclosure.heapLimitMiB === 256
  );
}

export type SecretScanState = SecretState;
export type SecretScanPreview = SecretPreview;
export type SecretScanJob = SecretJob;
export type SecretScanReport = SecretReport;
export const validateSecretScanState = validateSecretState;
export const validateSecretScanPreview = validateSecretPreview;
export const validateSecretScanJob = validateSecretJob;
export const validateSecretScanReport = validateSecretReport;
