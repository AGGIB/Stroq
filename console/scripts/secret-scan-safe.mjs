// Public reports contain only counts, fixed labels and timestamps. Never reflect a source name,
// path, hostname, variable name, transcript identifier or value from the scanner's private report.
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
];
export const SECRET_TIERS = ['third_party', 'maybe', 'seen', 'own_service', 'blocked'];
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
];
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
];
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
];
const SOURCES = ['home-credential-file', 'project-env-file', 'environment', 'canary', 'other'];
const AGENTS = ['claude-code', 'codex', 'cursor', 'unknown'];
const TIERS_TO_TOTAL = {
  third_party: 'external',
  maybe: 'uncertain',
  seen: 'modelVisible',
  own_service: 'ownService',
  blocked: 'reportedStopped',
};
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const closedSecretObject = (x, keys) =>
  object(x) && Object.keys(x).length === keys.length && keys.every((k) => Object.hasOwn(x, k));
const number = (x) => Number.isSafeInteger(x) && x >= 0 && x <= 1_000_000_000;
const counts = (x, keys) => closedSecretObject(x, keys) && keys.every((key) => number(x[key]));
const time = (x) =>
  typeof x === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
  Number.isFinite(Date.parse(x)) &&
  new Date(x).toISOString() === x;
const iso = (x) =>
  typeof x === 'string' && Number.isFinite(Date.parse(x)) ? new Date(x).toISOString() : null;
const count = (x) => (number(x) ? x : 0);
const exact = (x, known, fallback) => (known.includes(x) ? x : fallback);
const fail = () => {
  throw new Error('invalid-report');
};

function sourceOf(finding) {
  if (finding.canary === true) return 'canary';
  if (finding.source === 'env') return 'environment';
  if (typeof finding.source !== 'string') return 'other';
  const source = finding.source.replace(/\\/g, '/');
  if (
    ['.aws/credentials', '.npmrc', '.netrc', '.docker/config.json'].some((name) =>
      source.endsWith(`/${name}`),
    )
  )
    return 'home-credential-file';
  if (/(?:^|\/)(?:\.env(?:\.[\w-]+)*|[\w-][\w.-]*\.env|\.envrc)$/.test(source))
    return 'project-env-file';
  return 'other';
}

export function projectSecretReport(raw, scope) {
  if (
    !object(raw) ||
    raw.schema !== 'stroq-sent/2' ||
    raw.synthetic !== undefined ||
    raw.scope !== scope ||
    !object(raw.keys) ||
    !object(raw.sessions) ||
    !Array.isArray(raw.findings) ||
    raw.findings.length > 10_000 ||
    !Array.isArray(raw.notChecked) ||
    !time(raw.checked) ||
    typeof raw.complete !== 'boolean'
  )
    fail();
  if (
    !number(raw.sessions.total) ||
    !object(raw.sessions.agents) ||
    !number(raw.keys.compared) ||
    !number(raw.keys.env) ||
    !number(raw.keys.unreadable) ||
    !Array.isArray(raw.keys.files)
  )
    fail();
  for (const name of ['partial', 'skippedFiles', 'rejectedLines']) {
    if (
      raw.keys[name] !== undefined &&
      (name === 'partial' ? !Array.isArray(raw.keys[name]) : !number(raw.keys[name]))
    )
      fail();
  }
  const totals = {
    findings: raw.findings.length,
    external: 0,
    uncertain: 0,
    modelVisible: 0,
    ownService: 0,
    reportedStopped: 0,
  };
  for (const f of raw.findings) {
    if (
      !object(f) ||
      !SECRET_TIERS.includes(f.tier) ||
      !object(f.place) ||
      f.place.tier !== f.tier ||
      ['times', 'sessions', 'seen'].some((key) => !number(f[key]) || f[key] < 1)
    )
      fail();
    totals[TIERS_TO_TOTAL[f.tier]]++;
  }
  const findings = raw.findings.slice(0, 200).map((f, index) => ({
    id: `credential-${index + 1}`,
    provider: exact(f.provider, SECRET_PROVIDERS, 'Other'),
    source: sourceOf(f),
    tier: f.tier,
    route: exact(f.place.route, SECRET_ROUTES, 'record'),
    agent: exact(f.session?.agent, AGENTS, 'unknown'),
    at: iso(f.at),
    occurrences: count(f.times),
    sessions: count(f.sessions),
    seen: count(f.seen),
    reportedStopped: f.tier === 'blocked' || f.place.saidStopped === true,
    wouldBe: exact(f.place.wouldBe, SECRET_TIERS, null),
    canary: f.canary === true,
    laterNetworkCommands: count(f.laterNetworkCommands),
  }));
  const notChecked = [...new Set(raw.notChecked.map((gap) => exact(gap, SECRET_GAPS, 'work-cut')))];
  const report = {
    schema: 'stroq-secret-scan-report/1',
    source: 'local',
    scope,
    checkedAt: raw.checked,
    evidence: 'recorded-transcripts',
    complete: raw.complete === true && notChecked.length === 0 && raw.findings.length <= 200,
    sessions: {
      total: count(raw.sessions.total),
      claudeCode: count(raw.sessions.agents?.['claude-code']?.sessions),
      codex: count(raw.sessions.agents?.codex?.sessions),
      cursor: count(raw.sessions.agents?.cursor?.sessions),
      skipped: count(raw.sessions.skipped),
    },
    keys: {
      compared: count(raw.keys.compared),
      sourceFiles: Array.isArray(raw.keys.files) ? raw.keys.files.length : 0,
      environment: count(raw.keys.env),
      unreadableFiles: count(raw.keys.unreadable),
      partialFiles: Array.isArray(raw.keys.partial) ? raw.keys.partial.length : 0,
      skippedFiles: count(raw.keys.skippedFiles),
      rejectedLines: count(raw.keys.rejectedLines),
      truncated: raw.keys.truncated === true,
    },
    totals,
    findings,
    omittedFindings: raw.findings.length - findings.length,
    notChecked,
    limitations: [...SECRET_LIMITATIONS],
  };
  if (!validSecretReport(report)) fail();
  return report;
}

export function validSecretReport(x) {
  if (
    !closedSecretObject(x, [
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
    x.schema !== 'stroq-secret-scan-report/1' ||
    x.source !== 'local' ||
    !['project', 'last'].includes(x.scope) ||
    !time(x.checkedAt) ||
    x.evidence !== 'recorded-transcripts' ||
    typeof x.complete !== 'boolean'
  )
    return false;
  if (
    !counts(x.sessions, ['total', 'claudeCode', 'codex', 'cursor', 'skipped']) ||
    x.sessions.total !== x.sessions.claudeCode + x.sessions.codex + x.sessions.cursor ||
    (x.scope === 'last' && x.sessions.total > 1)
  )
    return false;
  if (
    !closedSecretObject(x.keys, [
      'compared',
      'sourceFiles',
      'environment',
      'unreadableFiles',
      'partialFiles',
      'skippedFiles',
      'rejectedLines',
      'truncated',
    ]) ||
    Object.entries(x.keys).some(([key, value]) =>
      key === 'truncated' ? typeof value !== 'boolean' : !number(value),
    )
  )
    return false;
  if (
    !counts(x.totals, [
      'findings',
      'external',
      'uncertain',
      'modelVisible',
      'ownService',
      'reportedStopped',
    ]) ||
    x.totals.findings > x.keys.compared ||
    x.totals.findings !==
      x.totals.external +
        x.totals.uncertain +
        x.totals.modelVisible +
        x.totals.ownService +
        x.totals.reportedStopped
  )
    return false;
  if (
    !Array.isArray(x.findings) ||
    x.findings.length > 200 ||
    !number(x.omittedFindings) ||
    x.findings.length + x.omittedFindings !== x.totals.findings
  )
    return false;
  if (
    !Array.isArray(x.notChecked) ||
    x.notChecked.length > SECRET_GAPS.length ||
    new Set(x.notChecked).size !== x.notChecked.length ||
    x.notChecked.some((g) => !SECRET_GAPS.includes(g)) ||
    (x.complete && (x.notChecked.length || x.omittedFindings))
  )
    return false;
  if (
    x.complete &&
    (x.sessions.total === 0 ||
      x.sessions.skipped > 0 ||
      x.keys.truncated ||
      x.keys.unreadableFiles ||
      x.keys.partialFiles ||
      x.keys.skippedFiles ||
      x.keys.rejectedLines)
  )
    return false;
  if (
    !Array.isArray(x.limitations) ||
    x.limitations.length !== SECRET_LIMITATIONS.length ||
    x.limitations.some((item, i) => item !== SECRET_LIMITATIONS[i])
  )
    return false;
  return x.findings.every(
    (f, i) =>
      closedSecretObject(f, [
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
      f.id === `credential-${i + 1}` &&
      SECRET_PROVIDERS.includes(f.provider) &&
      SOURCES.includes(f.source) &&
      SECRET_TIERS.includes(f.tier) &&
      SECRET_ROUTES.includes(f.route) &&
      AGENTS.includes(f.agent) &&
      (f.at === null || time(f.at)) &&
      ['occurrences', 'sessions', 'seen', 'laterNetworkCommands'].every((key) => number(f[key])) &&
      typeof f.reportedStopped === 'boolean' &&
      (f.wouldBe === null || SECRET_TIERS.includes(f.wouldBe)) &&
      typeof f.canary === 'boolean',
  );
}
