import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'AGGIB/Stroq';
const ROOT = `/repos/${REPOSITORY}`;
const ACTIONS_APP = 15368;
const BOT = 'github-actions[bot]';
const MARKER = '<!-- stroq-maintainer:v1 -->';
const WORKFLOWS = ['ci.yml', 'codeql.yml', 'scorecard.yml'];
const REQUIRED = {
  'ci.yml': [
    'test (22)',
    'test (24)',
    'suite (macos-latest)',
    'suite (windows-latest)',
    'python-oracle (ubuntu-latest)',
    'python-oracle (macos-latest)',
    'mcp-probe-sandbox (ubuntu-latest)',
    'mcp-probe-sandbox (macos-latest)',
  ],
  'codeql.yml': ['Analyze (javascript-typescript)', 'Analyze (actions)'],
};
const HOLD =
  /^(?:hold|on[- ]hold|blocked|wip|draft|do[- ]not[- ]merge|no[- ]automerge|manual[- ]merge|needs[- ]review)$/i;
const KNOWN_RULES = new Set([
  'deletion',
  'non_fast_forward',
  'required_linear_history',
  'required_signatures',
  'pull_request',
  'required_status_checks',
]);
const KINDS = [
  ['[Bug]:', 'bug', 'What happened?', 'Steps to reproduce'],
  ['[Docs]:', 'documentation', 'Where', 'What is wrong, unclear or missing?'],
  ['[False positive]:', 'false-positive', 'Rule id(s) and decision line', 'Expected behavior'],
  ['[Feature]:', 'enhancement', 'What problem would it solve?', 'What would you like Stroq to do?'],
  ['[Question]:', 'question', 'What happened, or what do you want to know?'],
  ['[Gap]:', 'classification-gap', 'The gap', "Why this isn't an active bypass"],
  ['[Try-it]:', 'pilot-report', 'Agent, operating system and Stroq version'],
];

export function issueLabel(issue, available) {
  if (issue.pull_request || issue.state !== 'open') return null;
  const labels = issue.labels.map((label) => label.name);
  if (KINDS.some(([, kind]) => labels.includes(kind))) return null;
  const headings = new Set(
    (issue.body ?? '')
      .split('\n')
      .filter((line) => line.startsWith('### '))
      .map((line) => line.slice(4).trim()),
  );
  const match = KINDS.find(
    ([prefix, , ...required]) =>
      issue.title.startsWith(prefix) && required.every((heading) => headings.has(heading)),
  );
  return match && available.has(match[1]) ? match[1] : null;
}

export class GitHub {
  constructor(token, fetcher = fetch, { readOnly = false } = {}) {
    if (!token) throw new Error('GITHUB_TOKEN is required');
    this.token = token;
    this.fetcher = fetcher;
    this.readOnly = readOnly;
  }

  async request(path, method = 'GET', body) {
    if (!(path.startsWith(`${ROOT}/`) || path === ROOT || path === '/graphql'))
      throw new Error('Repository scope violation');
    const graphQuery =
      path === '/graphql' &&
      method === 'POST' &&
      typeof body?.query === 'string' &&
      /^query[\s(]/.test(body.query) &&
      !/\b(?:mutation|subscription)\b/.test(body.query);
    if (this.readOnly && method !== 'GET' && !graphQuery)
      throw new Error('Preview forbids mutations');
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    if (response.status === 204) return null;
    const result = await response.json();
    if (result.errors) throw new Error('GitHub GraphQL returned errors');
    return result;
  }

  async list(path, key) {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.request(
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      );
      const values = key ? data[key] : data;
      if (!Array.isArray(values)) throw new Error('Incomplete GitHub collection');
      result.push(...values);
      if (values.length < 100) return result;
    }
    throw new Error('GitHub pagination limit reached');
  }

  async threads(number) {
    const result = [];
    let cursor = null;
    for (let page = 1; page <= 100; page++) {
      const data = await this.request('/graphql', 'POST', {
        query: `query($number:Int!,$cursor:String){repository(owner:"AGGIB",name:"Stroq"){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}`,
        variables: { number, cursor },
      });
      const connection = data.data?.repository?.pullRequest?.reviewThreads;
      if (!connection || !Array.isArray(connection.nodes))
        throw new Error('Review threads unavailable');
      result.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) return result;
      if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor)
        throw new Error('Incomplete review threads');
      cursor = connection.pageInfo.endCursor;
    }
    throw new Error('Review thread pagination limit reached');
  }
}

function currentReviews(reviews) {
  const effective = new Map();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    if (review.user?.login && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state))
      effective.set(review.user.login, review);
  }
  return [...effective.values()];
}

function isActionsCheck(check) {
  return check.app?.id === ACTIONS_APP && check.app?.slug === 'github-actions';
}

function isCurrentRun(run, pr, workflow) {
  return (
    run.path === `.github/workflows/${workflow}` &&
    run.event === 'pull_request' &&
    run.head_sha === pr.head.sha &&
    run.repository?.full_name?.toLowerCase() === REPOSITORY.toLowerCase() &&
    run.pull_requests?.some(
      (item) =>
        item.number === pr.number &&
        item.head?.sha === pr.head.sha &&
        item.base?.sha === pr.base.sha,
    )
  );
}

function hasStrictReviewProtection(protection, rules) {
  const classic =
    protection?.required_status_checks?.strict === true &&
    protection?.required_pull_request_reviews?.dismiss_stale_reviews === true &&
    protection?.required_pull_request_reviews?.required_approving_review_count >= 1 &&
    protection?.required_conversation_resolution?.enabled === true;
  // The branch-rules endpoint returns only active, applicable rules (including
  // inherited ones), unlike listing configured rulesets. It needs metadata read,
  // so Actions can verify enforcement without administration access.
  const strictChecks = rules.some(
    (rule) =>
      rule.type === 'required_status_checks' &&
      rule.parameters?.strict_required_status_checks_policy === true &&
      Array.isArray(rule.parameters.required_status_checks) &&
      rule.parameters.required_status_checks.length > 0 &&
      rule.parameters.required_status_checks.every(
        (check) => typeof check.context === 'string' && check.context.length > 0,
      ),
  );
  const humanReviews = rules.some(
    (rule) =>
      rule.type === 'pull_request' &&
      rule.parameters?.required_approving_review_count >= 1 &&
      rule.parameters.dismiss_stale_reviews_on_push === true &&
      rule.parameters.required_review_thread_resolution === true,
  );
  return classic || (strictChecks && humanReviews);
}

/** This is a merge gate, not an AI verdict. GitHub enforces protected-branch policy. */
export function readiness(snapshot) {
  const {
    pr,
    repo,
    branch,
    protection,
    rules,
    files,
    reviews,
    permissions,
    threads,
    checks,
    statuses,
    runs,
    mergeCommit,
    dispatchReady,
  } = snapshot;
  const reasons = new Set();
  if (
    repo.full_name?.toLowerCase() !== REPOSITORY.toLowerCase() ||
    repo.default_branch !== 'main' ||
    pr.base.repo.full_name?.toLowerCase() !== REPOSITORY.toLowerCase()
  )
    reasons.add('wrong-repository-or-base');
  if (repo.archived || !repo.allow_squash_merge) reasons.add('squash-unavailable');
  if (repo.permissions?.admin === true) reasons.add('admin-token-not-supported');
  if (!branch.protected) reasons.add('main-is-not-protected');
  if (!hasStrictReviewProtection(protection, rules))
    reasons.add('strict-base-review-protection-required');
  if (dispatchReady !== true) reasons.add('post-merge-dispatch-not-configured');
  if (pr.state !== 'open' || pr.draft || pr.base.ref !== 'main')
    reasons.add('not-an-open-ready-pr');
  if (pr.mergeable !== true || pr.mergeable_state !== 'clean')
    reasons.add('github-merge-state-not-clean');
  if (
    /^(?:wip|draft)\b/i.test(pr.title) ||
    /\[(?:wip|draft|do not merge)\]/i.test(pr.title) ||
    pr.labels.some((label) => HOLD.test(label.name))
  )
    reasons.add('human-hold');
  if (pr.base.sha !== branch.commit.sha) reasons.add('base-is-stale');
  if (
    !mergeCommit ||
    mergeCommit.sha !== pr.merge_commit_sha ||
    mergeCommit.parents?.length !== 2 ||
    mergeCommit.parents[0].sha !== pr.base.sha ||
    mergeCommit.parents[1].sha !== pr.head.sha
  )
    reasons.add('test-merge-is-stale-or-unavailable');
  if (
    !Number.isInteger(pr.changed_files) ||
    files.length !== pr.changed_files ||
    files.length >= 3000
  )
    reasons.add('incomplete-file-list');
  if (
    files.some((file) =>
      [file.filename, file.previous_filename].some(
        (name) =>
          typeof name === 'string' &&
          /(?:^\.github\/|^\.claude\/|(?:^|\/)(?:AGENTS|CLAUDE)\.md$)/.test(name),
      ),
    )
  )
    reasons.add('automation-policy-requires-manual-merge');
  if (
    files.some(
      (file) =>
        /(?:^|\/)(?:package\.json|marketplace\.json|plugin\.json|openclaw\.plugin\.json|stroq-hook\.sh)$/.test(
          file.filename,
        ) &&
        (typeof file.patch !== 'string' ||
          /^[+-](?![+-]).*(?:"version"\s*:|STROQ_PIN\s*=)/m.test(file.patch)),
    )
  )
    reasons.add('release-version-requires-manual-merge');
  if (rules.some((rule) => !KNOWN_RULES.has(rule.type))) reasons.add('unsupported-branch-rule');
  const effective = currentReviews(reviews);
  if (effective.some((review) => review.state === 'CHANGES_REQUESTED'))
    reasons.add('changes-requested');
  const approved = effective.some(
    (review) =>
      review.state === 'APPROVED' &&
      review.commit_id === pr.head.sha &&
      review.user.type === 'User' &&
      review.user.login !== pr.user.login &&
      ['admin', 'maintain', 'write'].includes(permissions[review.user.login]),
  );
  if (!approved) reasons.add('current-head-human-approval-required');
  if (threads.some((thread) => thread.isResolved !== true)) reasons.add('unresolved-review-thread');
  for (const workflow of Object.keys(REQUIRED)) {
    const matching = runs
      .filter((run) => isCurrentRun(run, pr, workflow))
      .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt);
    const run = matching[0];
    if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
      reasons.add(`trusted-${workflow}-run-required`);
      continue;
    }
    for (const name of REQUIRED[workflow]) {
      const check = checks.find(
        (item) =>
          item.name === name &&
          isActionsCheck(item) &&
          item.check_suite?.id === run.check_suite_id &&
          [pr.head.sha, pr.merge_commit_sha].includes(item.head_sha),
      );
      if (!check || check.status !== 'completed' || check.conclusion !== 'success')
        reasons.add(`required-${workflow}-matrix-incomplete`);
    }
  }
  // A failing optional check is still a reason to wait. Only the documented SARIF
  // skip on fork/Dependabot PRs is expected; a skipped core check never passes.
  for (const check of checks) {
    const expectedSkip =
      check.name === 'stroq inspect (SARIF)' &&
      isActionsCheck(check) &&
      check.conclusion === 'skipped' &&
      (pr.head.repo?.full_name?.toLowerCase() !== REPOSITORY.toLowerCase() ||
        pr.user.login === 'dependabot[bot]');
    if (!expectedSkip && (check.status !== 'completed' || check.conclusion !== 'success'))
      reasons.add('checks-not-successful');
  }
  if (statuses.some((status) => status.state !== 'success'))
    reasons.add('commit-status-not-successful');
  for (const rule of rules.filter((item) => item.type === 'required_status_checks')) {
    for (const required of rule.parameters?.required_status_checks ?? []) {
      if (required.integration_id && required.integration_id !== ACTIONS_APP)
        reasons.add('unsupported-required-check-app');
      const check = checks.find(
        (item) =>
          item.name === required.context &&
          isActionsCheck(item) &&
          item.status === 'completed' &&
          item.conclusion === 'success',
      );
      if (!check) reasons.add('ruleset-required-check-missing');
    }
  }
  return [...reasons].sort();
}

export async function inspectPull(client, number) {
  const pr = await client.request(`${ROOT}/pulls/${number}`);
  if (!pr.head?.sha || !pr.base?.sha || !pr.merge_commit_sha)
    return { pr, reasons: ['test-merge-unavailable'] };
  const [
    repo,
    branch,
    rules,
    files,
    reviews,
    threads,
    headChecks,
    mergeChecks,
    headStatuses,
    mergeStatuses,
    ciRuns,
    codeqlRuns,
    mergeCommit,
    protection,
    workflowSources,
  ] = await Promise.all([
    client.request(ROOT),
    client.request(`${ROOT}/branches/main`),
    client.list(`${ROOT}/rules/branches/main`),
    client.list(`${ROOT}/pulls/${number}/files`),
    client.list(`${ROOT}/pulls/${number}/reviews`),
    client.threads(number),
    client.list(`${ROOT}/commits/${pr.head.sha}/check-runs?filter=latest`, 'check_runs'),
    client.list(`${ROOT}/commits/${pr.merge_commit_sha}/check-runs?filter=latest`, 'check_runs'),
    client.list(`${ROOT}/commits/${pr.head.sha}/statuses`),
    client.list(`${ROOT}/commits/${pr.merge_commit_sha}/statuses`),
    client.list(
      `${ROOT}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head.sha}`,
      'workflow_runs',
    ),
    client.list(
      `${ROOT}/actions/workflows/codeql.yml/runs?event=pull_request&head_sha=${pr.head.sha}`,
      'workflow_runs',
    ),
    client.request(`${ROOT}/git/commits/${pr.merge_commit_sha}`),
    client.request(`${ROOT}/branches/main/protection`).catch(() => null),
    Promise.all(
      WORKFLOWS.map((workflow) =>
        client.request(`${ROOT}/contents/.github/workflows/${workflow}?ref=${pr.base.sha}`),
      ),
    ),
  ]);
  const permissions = {};
  for (const review of currentReviews(reviews)) {
    if (
      review.state === 'APPROVED' &&
      review.commit_id === pr.head.sha &&
      review.user.type === 'User' &&
      review.user.login !== pr.user.login
    ) {
      const value = await client.request(
        `${ROOT}/collaborators/${encodeURIComponent(review.user.login)}/permission`,
      );
      permissions[review.user.login] = value.permission;
    }
  }
  const checks = [
    ...new Map([...headChecks, ...mergeChecks].map((item) => [item.id, item])).values(),
  ];
  const latestStatuses = new Map();
  for (const status of [
    ...headStatuses.map((item) => ({ ...item, sha: pr.head.sha })),
    ...mergeStatuses.map((item) => ({ ...item, sha: pr.merge_commit_sha })),
  ].sort((a, b) => b.id - a.id)) {
    const key = `${status.sha}:${String(status.context).toLowerCase()}`;
    if (!latestStatuses.has(key)) latestStatuses.set(key, status);
  }
  const dispatchReady = workflowSources.every(
    (source) =>
      source.encoding === 'base64' &&
      typeof source.content === 'string' &&
      /^  workflow_dispatch:\s*(?:#.*)?$/m.test(
        Buffer.from(source.content, 'base64').toString('utf8'),
      ),
  );
  const snapshot = {
    pr,
    repo,
    branch,
    protection,
    rules,
    files,
    reviews,
    permissions,
    threads,
    checks,
    statuses: [...latestStatuses.values()],
    runs: [...ciRuns, ...codeqlRuns],
    mergeCommit,
    dispatchReady,
  };
  return { ...snapshot, reasons: readiness(snapshot) };
}

function commentBody(result) {
  return `${MARKER}\nMaintenance check for head \`${result.pr.head.sha}\` and base \`${result.pr.base.sha}\`.\n\n${result.reasons.length ? `Waiting:\n${result.reasons.map((reason) => `- ${reason}`).join('\n')}` : 'Ready for the protected-branch squash merge check.'}\n\nNative Codex review comments inform the human reviewer; they are not a machine-readable approval. This check requires an explicit approval by a different human collaborator with write access at the current head.`;
}

export async function updateReadiness(client, result) {
  const comments = await client.list(`${ROOT}/issues/${result.pr.number}/comments`);
  const existing = comments.find(
    (comment) =>
      comment.user?.login === BOT &&
      comment.user.type === 'Bot' &&
      comment.body?.startsWith(MARKER),
  );
  const body = commentBody(result);
  if (existing?.body === body) return;
  await client.request(
    existing
      ? `${ROOT}/issues/comments/${existing.id}`
      : `${ROOT}/issues/${result.pr.number}/comments`,
    existing ? 'PATCH' : 'POST',
    { body },
  );
}

export async function maintain(client, { mode = 'preview', dryRun = false } = {}) {
  if (!['preview', 'scan', 'merge'].includes(mode))
    throw new Error('Mode must be preview, scan or merge');
  if (mode === 'preview') dryRun = true;
  const decisions = [];
  if (mode !== 'merge') {
    const available = new Set((await client.list(`${ROOT}/labels`)).map((label) => label.name));
    const issues = await client.list(`${ROOT}/issues?state=open`);
    for (const issue of issues) {
      const label = issueLabel(issue, available);
      if (!label) continue;
      if (!dryRun)
        await client.request(`${ROOT}/issues/${issue.number}/labels`, 'POST', { labels: [label] });
      decisions.push({ issue: issue.number, label, dryRun });
    }
  }
  const pulls = await client.list(`${ROOT}/pulls?state=open&base=main`);
  for (const candidate of pulls.sort((a, b) => a.number - b.number)) {
    let result;
    try {
      result = await inspectPull(client, candidate.number);
      if (mode === 'scan' && !dryRun && result.pr.head?.sha && result.pr.base?.sha)
        await updateReadiness(client, result);
      decisions.push({ pr: candidate.number, reasons: result.reasons, dryRun });
      if (mode !== 'merge' || result.reasons.length || dryRun) continue;
      // Recompute every gate immediately before the one allowed merge. Never use
      // scan artifacts or the readiness comment as authorization.
      const fresh = await inspectPull(client, candidate.number);
      if (
        fresh.reasons.length ||
        fresh.pr.head.sha !== result.pr.head.sha ||
        fresh.pr.base.sha !== result.pr.base.sha ||
        fresh.pr.merge_commit_sha !== result.pr.merge_commit_sha
      ) {
        decisions.push({ pr: candidate.number, reasons: ['state-changed-before-merge'] });
        continue;
      }
      const merged = await client.request(`${ROOT}/pulls/${candidate.number}/merge`, 'PUT', {
        sha: fresh.pr.head.sha,
        merge_method: 'squash',
      });
      if (merged.merged !== true || !merged.sha)
        throw new Error('GitHub did not confirm the merge');
      // GITHUB_TOKEN merges suppress push workflows. The three trusted workflows
      // opt into workflow_dispatch so the resulting main is still checked.
      const failures = [];
      for (const workflow of WORKFLOWS) {
        try {
          await client.request(`${ROOT}/actions/workflows/${workflow}/dispatches`, 'POST', {
            ref: 'main',
          });
        } catch {
          failures.push(workflow);
        }
      }
      decisions.push({
        pr: candidate.number,
        merged: merged.sha,
        postMergeDispatchFailures: failures,
      });
      if (failures.length) throw new Error('Post-merge workflow dispatch failed');
      break;
    } catch (error) {
      decisions.push({ pr: candidate.number, reasons: ['github-data-or-mutation-unavailable'] });
      // Never try another merge after an uncertain write or missing policy data.
      if (mode === 'merge') {
        const failure = new Error('Merge reconciliation stopped; inspect the Actions run');
        failure.decisions = decisions;
        throw failure;
      }
    }
  }
  return decisions;
}

async function main() {
  if (
    process.env.GITHUB_REPOSITORY?.toLowerCase() !== REPOSITORY.toLowerCase() ||
    process.env.GITHUB_REF !== 'refs/heads/main'
  )
    throw new Error('Run only on AGGIB/Stroq main');
  const mode = process.argv[2] ?? 'preview';
  const dryRun = mode === 'preview' || process.env.MAINTAINER_DRY_RUN === 'true';
  try {
    console.log(
      JSON.stringify(
        await maintain(new GitHub(process.env.GITHUB_TOKEN, fetch, { readOnly: dryRun }), {
          mode,
          dryRun,
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    if (error.decisions) console.log(JSON.stringify(error.decisions, null, 2));
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(
      'Maintenance stopped safely. Check repository access, workflow configuration and current GitHub state.',
    );
    process.exitCode = 1;
  });
}
