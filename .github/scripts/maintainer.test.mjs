import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  GitHub,
  REPOSITORY,
  inspectPull,
  issueLabel,
  maintain,
  readiness,
  updateReadiness,
} from './maintainer.mjs';

const ROOT = `/repos/${REPOSITORY}`;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const CI = [
  'test (22)',
  'test (24)',
  'suite (macos-latest)',
  'suite (windows-latest)',
  'python-oracle (ubuntu-latest)',
  'python-oracle (macos-latest)',
  'mcp-probe-sandbox (ubuntu-latest)',
  'mcp-probe-sandbox (macos-latest)',
];

function fixture() {
  const pr = {
    number: 42,
    state: 'open',
    draft: false,
    title: 'Fix a classifier regression',
    labels: [],
    user: { login: 'author' },
    changed_files: 1,
    mergeable: true,
    mergeable_state: 'clean',
    merge_commit_sha: MERGE,
    head: { sha: HEAD, repo: { full_name: REPOSITORY } },
    base: { sha: BASE, ref: 'main', repo: { full_name: REPOSITORY } },
  };
  const runs = ['ci.yml', 'codeql.yml'].map((name, index) => ({
    id: index + 100,
    run_attempt: 1,
    path: `.github/workflows/${name}`,
    head_sha: HEAD,
    repository: { full_name: REPOSITORY },
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    check_suite_id: index + 10,
    pull_requests: [{ number: 42, head: { sha: HEAD }, base: { sha: BASE } }],
  }));
  const checks = [...CI, 'Analyze (javascript-typescript)', 'Analyze (actions)'].map(
    (name, index) => ({
      id: index + 1,
      name,
      head_sha: MERGE,
      status: 'completed',
      conclusion: 'success',
      app: { id: 15368, slug: 'github-actions' },
      check_suite: { id: index < CI.length ? 10 : 11 },
    }),
  );
  return {
    pr,
    repo: {
      full_name: REPOSITORY,
      default_branch: 'main',
      allow_squash_merge: true,
      permissions: { admin: false },
    },
    branch: { protected: true, commit: { sha: BASE } },
    rules: [],
    files: [{ filename: 'packages/core/src/example.ts' }],
    protection: {
      required_status_checks: { strict: true },
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        required_approving_review_count: 1,
      },
      required_conversation_resolution: { enabled: true },
    },
    dispatchReady: true,
    reviews: [
      { id: 1, state: 'APPROVED', commit_id: HEAD, user: { login: 'reviewer', type: 'User' } },
    ],
    permissions: { reviewer: 'write' },
    threads: [],
    checks,
    statuses: [],
    runs,
    mergeCommit: { sha: MERGE, parents: [{ sha: BASE }, { sha: HEAD }] },
  };
}

function strictRules() {
  return [
    {
      type: 'required_status_checks',
      ruleset_id: 17,
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: 'test (22)', integration_id: 15368 }],
      },
    },
    {
      type: 'pull_request',
      ruleset_id: 18,
      parameters: {
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: true,
        required_review_thread_resolution: true,
      },
    },
  ];
}

test('effective active strict CI and review rules replace unreadable classic protection', () => {
  const snapshot = fixture();
  snapshot.protection = null;
  snapshot.rules = strictRules();
  assert.deepEqual(readiness(snapshot), []);
});

for (const [name, weaken] of [
  [
    'strict checks disabled',
    (rules) => {
      rules[0].parameters.strict_required_status_checks_policy = false;
    },
  ],
  [
    'empty required checks',
    (rules) => {
      rules[0].parameters.required_status_checks = [];
    },
  ],
  [
    'missing required checks',
    (rules) => {
      delete rules[0].parameters.required_status_checks;
    },
  ],
  [
    'zero human approvals',
    (rules) => {
      rules[1].parameters.required_approving_review_count = 0;
    },
  ],
  [
    'old approvals remain valid',
    (rules) => {
      rules[1].parameters.dismiss_stale_reviews_on_push = false;
    },
  ],
  [
    'unresolved threads allowed',
    (rules) => {
      rules[1].parameters.required_review_thread_resolution = false;
    },
  ],
  [
    'strict CI without review rule',
    (rules) => {
      rules.pop();
    },
  ],
  [
    'review rule without strict CI',
    (rules) => {
      rules.shift();
    },
  ],
]) {
  test(`effective rules fail closed when ${name}`, () => {
    const snapshot = fixture();
    snapshot.protection = null;
    snapshot.rules = strictRules();
    weaken(snapshot.rules);
    assert.ok(readiness(snapshot).includes('strict-base-review-protection-required'));
  });
}

test('hold marker in the middle of the title still blocks merging', () => {
  const snapshot = fixture();
  snapshot.pr.title = 'Classifier fix [do not merge] awaiting review';
  assert.ok(readiness(snapshot).includes('human-hold'));
});

function fakeClient(snapshot = fixture()) {
  const calls = [];
  const routes = new Map([
    [ROOT, snapshot.repo],
    [`${ROOT}/pulls/42`, snapshot.pr],
    [`${ROOT}/branches/main`, snapshot.branch],
    [`${ROOT}/collaborators/reviewer/permission`, { permission: snapshot.permissions.reviewer }],
    [`${ROOT}/git/commits/${MERGE}`, snapshot.mergeCommit],
    [`${ROOT}/branches/main/protection`, snapshot.protection],
    ...['ci.yml', 'codeql.yml', 'scorecard.yml'].map((name) => [
      `${ROOT}/contents/.github/workflows/${name}?ref=${BASE}`,
      {
        encoding: 'base64',
        content: Buffer.from('on:\n  workflow_dispatch:\n').toString('base64'),
      },
    ]),
  ]);
  const lists = new Map([
    [`${ROOT}/rules/branches/main`, snapshot.rules],
    [`${ROOT}/pulls/42/files`, snapshot.files],
    [`${ROOT}/pulls/42/reviews`, snapshot.reviews],
    [`${ROOT}/pulls?state=open&base=main`, [{ number: 42 }]],
    [`${ROOT}/commits/${HEAD}/check-runs?filter=latest`, snapshot.checks],
    [`${ROOT}/commits/${MERGE}/check-runs?filter=latest`, snapshot.checks],
    [`${ROOT}/commits/${HEAD}/statuses`, snapshot.statuses],
    [`${ROOT}/commits/${MERGE}/statuses`, []],
    [
      `${ROOT}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${HEAD}`,
      [snapshot.runs[0]],
    ],
    [
      `${ROOT}/actions/workflows/codeql.yml/runs?event=pull_request&head_sha=${HEAD}`,
      [snapshot.runs[1]],
    ],
    [`${ROOT}/labels`, [{ name: 'bug' }]],
    [
      `${ROOT}/issues?state=open`,
      [
        {
          number: 9,
          state: 'open',
          title: '[Bug]: report',
          body: '### What happened?\nIssue data\n### Steps to reproduce\nNo execution',
          labels: [],
        },
      ],
    ],
    [`${ROOT}/issues/42/comments`, []],
  ]);
  return {
    calls,
    routes,
    lists,
    async request(path, method = 'GET', body) {
      calls.push({ path, method, body });
      if (method === 'GET') {
        assert.ok(routes.has(path), `Unexpected read: ${path}`);
        return structuredClone(routes.get(path));
      }
      if (path.endsWith('/merge')) return { merged: true, sha: 'd'.repeat(40) };
      return null;
    },
    async list(path) {
      calls.push({ path, method: 'GET' });
      assert.ok(lists.has(path), `Unexpected list: ${path}`);
      return structuredClone(lists.get(path));
    },
    async threads(number) {
      assert.equal(number, 42);
      calls.push({ path: 'reviewThreads', method: 'QUERY' });
      return structuredClone(snapshot.threads);
    },
  };
}

test('complete current-head human approval and trusted current-base CI passes', () => {
  assert.deepEqual(readiness(fixture()), []);
});

for (const [name, mutate, reason] of [
  [
    'missing human approval',
    (s) => {
      s.reviews = [];
    },
    'current-head-human-approval-required',
  ],
  [
    'Codex comment is not approval',
    (s) => {
      s.reviews[0].state = 'COMMENTED';
    },
    'current-head-human-approval-required',
  ],
  [
    'bot approval is not human approval',
    (s) => {
      s.reviews[0].user.type = 'Bot';
    },
    'current-head-human-approval-required',
  ],
  [
    'author cannot approve own PR',
    (s) => {
      s.pr.user.login = 'reviewer';
    },
    'current-head-human-approval-required',
  ],
  [
    'read-only collaborator approval',
    (s) => {
      s.permissions.reviewer = 'read';
    },
    'current-head-human-approval-required',
  ],
  [
    'approval for earlier commit',
    (s) => {
      s.reviews[0].commit_id = BASE;
    },
    'current-head-human-approval-required',
  ],
  [
    'changes requested by another reviewer',
    (s) => {
      s.reviews.push({ id: 2, state: 'CHANGES_REQUESTED', user: { login: 'other' } });
    },
    'changes-requested',
  ],
  [
    'comment does not dismiss objections',
    (s) => {
      s.reviews.push(
        { id: 2, state: 'CHANGES_REQUESTED', user: { login: 'other' } },
        { id: 3, state: 'COMMENTED', user: { login: 'other' } },
      );
    },
    'changes-requested',
  ],
  [
    'unresolved review thread',
    (s) => {
      s.threads.push({ isResolved: false });
    },
    'unresolved-review-thread',
  ],
  [
    'draft PR',
    (s) => {
      s.pr.draft = true;
    },
    'not-an-open-ready-pr',
  ],
  [
    'human hold label',
    (s) => {
      s.pr.labels.push({ name: 'do-not-merge' });
    },
    'human-hold',
  ],
  [
    'WIP title',
    (s) => {
      s.pr.title = 'WIP: classifier';
    },
    'human-hold',
  ],
  [
    'unprotected main',
    (s) => {
      s.branch.protected = false;
    },
    'main-is-not-protected',
  ],
  [
    'unknown classic protection',
    (s) => {
      s.protection = null;
    },
    'strict-base-review-protection-required',
  ],
  [
    'non-strict base protection',
    (s) => {
      s.protection.required_status_checks.strict = false;
    },
    'strict-base-review-protection-required',
  ],
  [
    'missing post-merge dispatch',
    (s) => {
      s.dispatchReady = false;
    },
    'post-merge-dispatch-not-configured',
  ],
  [
    'workflow changes',
    (s) => {
      s.files[0].filename = '.github/workflows/ci.yml';
    },
    'automation-policy-requires-manual-merge',
  ],
  [
    'renamed agent policy',
    (s) => {
      s.files[0].previous_filename = 'AGENTS.md';
    },
    'automation-policy-requires-manual-merge',
  ],
  [
    'release version change',
    (s) => {
      s.files[0] = {
        filename: 'package.json',
        patch: '-  "version": "0.25.0",\n+  "version": "0.25.1",',
      };
    },
    'release-version-requires-manual-merge',
  ],
  [
    'unknown mergeability',
    (s) => {
      s.pr.mergeable_state = 'unknown';
    },
    'github-merge-state-not-clean',
  ],
  [
    'admin token',
    (s) => {
      s.repo.permissions.admin = true;
    },
    'admin-token-not-supported',
  ],
  [
    'unsupported merge queue rule',
    (s) => {
      s.rules.push({ type: 'merge_queue' });
    },
    'unsupported-branch-rule',
  ],
  [
    'base advanced',
    (s) => {
      s.branch.commit.sha = HEAD;
    },
    'base-is-stale',
  ],
  [
    'wrong test merge parents',
    (s) => {
      s.mergeCommit.parents[0].sha = HEAD;
    },
    'test-merge-is-stale-or-unavailable',
  ],
  [
    'incomplete changed files',
    (s) => {
      s.pr.changed_files = 2;
    },
    'incomplete-file-list',
  ],
  [
    'wrong workflow path',
    (s) => {
      s.runs[0].path = '.github/workflows/attacker.yml';
    },
    'trusted-ci.yml-run-required',
  ],
  [
    'workflow for previous base',
    (s) => {
      s.runs[0].pull_requests[0].base.sha = HEAD;
    },
    'trusted-ci.yml-run-required',
  ],
  [
    'workflow from another repository',
    (s) => {
      s.runs[0].repository.full_name = 'attacker/Stroq';
    },
    'trusted-ci.yml-run-required',
  ],
  [
    'untrusted event',
    (s) => {
      s.runs[0].event = 'workflow_dispatch';
    },
    'trusted-ci.yml-run-required',
  ],
  [
    'spoofed Actions app',
    (s) => {
      s.checks[0].app.id = 999;
    },
    'required-ci.yml-matrix-incomplete',
  ],
  [
    'wrong check suite',
    (s) => {
      s.checks[0].check_suite.id = 999;
    },
    'required-ci.yml-matrix-incomplete',
  ],
  [
    'check from older commit',
    (s) => {
      s.checks[0].head_sha = BASE;
    },
    'required-ci.yml-matrix-incomplete',
  ],
  [
    'missing Windows suite',
    (s) => {
      s.checks = s.checks.filter((c) => c.name !== 'suite (windows-latest)');
    },
    'required-ci.yml-matrix-incomplete',
  ],
  [
    'skipped core job',
    (s) => {
      s.checks[0].conclusion = 'skipped';
    },
    'required-ci.yml-matrix-incomplete',
  ],
  [
    'failed CodeQL',
    (s) => {
      s.runs[1].conclusion = 'failure';
    },
    'trusted-codeql.yml-run-required',
  ],
  [
    'pending commit status',
    (s) => {
      s.statuses.push({ state: 'pending' });
    },
    'commit-status-not-successful',
  ],
  [
    'required check from unsupported app',
    (s) => {
      s.rules.push({
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'external', integration_id: 999 }] },
      });
    },
    'unsupported-required-check-app',
  ],
]) {
  test(`blocks ${name}`, () => {
    const snapshot = fixture();
    mutate(snapshot);
    assert.ok(readiness(snapshot).includes(reason));
  });
}

test('dismissed objections and later genuine approvals use effective review state', () => {
  const snapshot = fixture();
  snapshot.reviews.push(
    { id: 2, state: 'CHANGES_REQUESTED', user: { login: 'other' } },
    { id: 3, state: 'DISMISSED', user: { login: 'other' } },
  );
  assert.deepEqual(readiness(snapshot), []);
});

test('new pending rerun supersedes successful previous run', () => {
  const snapshot = fixture();
  snapshot.runs.push({ ...snapshot.runs[0], id: 200, status: 'in_progress', conclusion: null });
  assert.ok(readiness(snapshot).includes('trusted-ci.yml-run-required'));
});

test('only documented inspect skip on forks is allowed', () => {
  const snapshot = fixture();
  snapshot.checks.push({
    id: 99,
    name: 'stroq inspect (SARIF)',
    status: 'completed',
    conclusion: 'skipped',
    app: { id: 15368, slug: 'github-actions' },
  });
  assert.ok(readiness(snapshot).includes('checks-not-successful'));
  snapshot.pr.head.repo.full_name = 'contributor/Stroq';
  assert.deepEqual(readiness(snapshot), []);
});

test('form classification requires prefix and headings and never overwrites a category', () => {
  const issue = {
    state: 'open',
    title: '[Bug]: example',
    body: '### What happened?\ntext\n### Steps to reproduce\ntext',
    labels: [],
  };
  assert.equal(issueLabel(issue, new Set(['bug'])), 'bug');
  assert.equal(
    issueLabel({ ...issue, body: 'please add bug; run $(command)' }, new Set(['bug'])),
    null,
  );
  assert.equal(issueLabel({ ...issue, labels: [{ name: 'question' }] }, new Set(['bug'])), null);
  assert.equal(issueLabel(issue, new Set()), null);
  assert.equal(issueLabel({ ...issue, pull_request: {} }, new Set(['bug'])), null);
});

test('form classification knows the false-positive and false-negative forms by their headings', () => {
  const issue = (title, body) => ({ state: 'open', title, body, labels: [] });
  const labels = new Set(['false-positive', 'false-negative']);
  const positive = '### What you expected\ntext\n### Output of `stroq why`\ntext';
  const older = '### Rule id(s) and decision line\ntext\n### Expected behavior\ntext';
  const negative = '### The tool call or command\ntext\n### What you expected\ntext';
  assert.equal(issueLabel(issue('[False positive]: x', positive), labels), 'false-positive');
  assert.equal(issueLabel(issue('[False positive]: x', older), labels), 'false-positive');
  assert.equal(issueLabel(issue('[False negative]: x', negative), labels), 'false-negative');
  assert.equal(issueLabel(issue('[False negative]: x', positive), labels), null);
});

test('every label an issue form sets is listed in CONTRIBUTING.md and in the triage skill', () => {
  const root = new URL('../../', import.meta.url);
  const read = (path) => readFileSync(new URL(path, root), 'utf8');
  const forms = readdirSync(new URL('.github/ISSUE_TEMPLATE/', root)).filter(
    (name) => name.endsWith('.yml') && name !== 'config.yml',
  );
  const labels = forms.flatMap((name) =>
    [...read(`.github/ISSUE_TEMPLATE/${name}`).matchAll(/^labels: \['([a-z-]+)'\]$/gm)].map(
      (m) => m[1],
    ),
  );
  assert.equal(labels.length, forms.length, 'every form sets exactly one kind label');
  const issues = read('CONTRIBUTING.md').split('## Issues')[1]?.split('\n## ')[0] ?? '';
  const triage = read('.claude/skills/triage-issues/SKILL.md')
    .split('\n')
    .filter((line) => line.startsWith('8. **Labels**'))
    .join('\n');
  for (const label of labels) {
    assert.ok(issues.includes(`\`${label}\``), `CONTRIBUTING.md does not list ${label}`);
    assert.ok(triage.includes(`\`${label}\``), `the triage skill does not list ${label}`);
  }
});

test('pagination retrieves a second page instead of silently dropping issues', async () => {
  const urls = [];
  const client = new GitHub('test-token', async (url) => {
    urls.push(url);
    return Response.json(
      url.endsWith('page=1')
        ? Array.from({ length: 100 }, (_, number) => ({ number }))
        : [{ number: 100 }],
    );
  });
  assert.equal((await client.list(`${ROOT}/issues`)).length, 101);
  assert.equal(urls.length, 2);
});

test('preview client rejects every REST mutation before fetch and allows read-only GraphQL', async () => {
  let fetched = 0;
  const client = new GitHub(
    'test-token',
    async () => {
      fetched++;
      return Response.json({ data: {} });
    },
    { readOnly: true },
  );
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'])
    await assert.rejects(client.request(`${ROOT}/issues`, method, {}), /Preview forbids/);
  await assert.rejects(
    client.request('/graphql', 'POST', { query: 'mutation { deleteIssue }' }),
    /Preview forbids/,
  );
  assert.equal(fetched, 0);
  await client.request('/graphql', 'POST', { query: 'query($number:Int!){repository{name}}' });
  assert.equal(fetched, 1);
});

test('HTTP errors never echo server content or tokens; cross-repository requests are refused', async () => {
  const client = new GitHub('private-token', async () =>
    Response.json({ message: 'private-response' }, { status: 403 }),
  );
  await assert.rejects(client.request(ROOT), { message: 'GitHub API 403' });
  await assert.rejects(client.request('/repos/attacker/other/issues'), /scope violation/);
});

test('preview ignores dryRun=false and emits decisions without issue text or mutations', async () => {
  const client = fakeClient();
  const decisions = await maintain(client, { mode: 'preview', dryRun: false });
  assert.equal(decisions[0].label, 'bug');
  assert.deepEqual(decisions[1].reasons, []);
  assert.ok(client.calls.every((call) => ['GET', 'QUERY'].includes(call.method)));
  assert.ok(!JSON.stringify(decisions).includes('Issue data'));
});

test('dry-run merge cannot merge or dispatch even a fully ready PR', async () => {
  const client = fakeClient();
  await maintain(client, { mode: 'merge', dryRun: true });
  assert.ok(client.calls.every((call) => ['GET', 'QUERY'].includes(call.method)));
});

test('readiness comment is updated once and unchanged checks are quiet', async () => {
  const client = fakeClient();
  const result = await inspectPull(client, 42);
  await updateReadiness(client, result);
  const posted = client.calls.find((call) => call.method === 'POST');
  assert.ok(posted.body.body.includes(HEAD));
  client.lists.set(`${ROOT}/issues/42/comments`, [
    { id: 123, user: { login: 'github-actions[bot]', type: 'Bot' }, body: posted.body.body },
  ]);
  client.calls.length = 0;
  await updateReadiness(client, result);
  assert.ok(client.calls.every((call) => call.method === 'GET'));
});

test('ready merge is SHA guarded and dispatches suppressed main workflows', async () => {
  const client = fakeClient();
  const decisions = await maintain(client, { mode: 'merge' });
  const write = client.calls.find((call) => call.method === 'PUT');
  assert.deepEqual(write.body, { sha: HEAD, merge_method: 'squash' });
  assert.equal(client.calls.filter((call) => call.path.endsWith('/dispatches')).length, 3);
  assert.equal(decisions.at(-1).merged, 'd'.repeat(40));
});

test('changed head immediately before mutation prevents merge', async () => {
  const client = fakeClient();
  const original = client.request.bind(client);
  let reads = 0;
  client.request = async (...args) => {
    const result = await original(...args);
    if (args[0] === `${ROOT}/pulls/42` && ++reads === 2) result.head.sha = BASE;
    return result;
  };
  await assert.rejects(maintain(client, { mode: 'merge' }), /stopped/);
  assert.ok(!client.calls.some((call) => call.method === 'PUT'));
});

test('unavailable policy fails closed and no later candidate is merged', async () => {
  const client = fakeClient();
  const original = client.list.bind(client);
  client.list = async (path) => {
    if (path.endsWith('/rules/branches/main')) throw new Error('Forbidden');
    return original(path);
  };
  await assert.rejects(maintain(client, { mode: 'merge' }), /stopped/);
  assert.ok(!client.calls.some((call) => call.method === 'PUT'));
});

test('statuses on head and test merge remain separate without a sha response property', async () => {
  const client = fakeClient();
  client.lists.set(`${ROOT}/commits/${HEAD}/statuses`, [
    { id: 1, context: 'build', state: 'failure' },
  ]);
  client.lists.set(`${ROOT}/commits/${MERGE}/statuses`, [
    { id: 2, context: 'BUILD', state: 'success' },
  ]);
  const result = await inspectPull(client, 42);
  assert.equal(result.statuses.length, 2);
  assert.ok(result.reasons.includes('commit-status-not-successful'));
});

test('statuses with differently cased contexts on one commit use the latest state', async () => {
  const client = fakeClient();
  client.lists.set(`${ROOT}/commits/${HEAD}/statuses`, [
    { id: 2, context: 'BUILD', state: 'success' },
    { id: 1, context: 'build', state: 'failure' },
  ]);
  const result = await inspectPull(client, 42);
  assert.equal(result.statuses.length, 1);
  assert.ok(!result.reasons.includes('commit-status-not-successful'));
});

test('dispatch support is verified on immutable trusted base before merging', async () => {
  const client = fakeClient();
  client.routes.set(`${ROOT}/contents/.github/workflows/ci.yml?ref=${BASE}`, {
    encoding: 'base64',
    content: Buffer.from('on:\n  pull_request:\n').toString('base64'),
  });
  const decisions = await maintain(client, { mode: 'merge' });
  assert.ok(decisions[0].reasons.includes('post-merge-dispatch-not-configured'));
  assert.ok(!client.calls.some((call) => call.method === 'PUT'));
});

test('Actions can inspect an approved PR through effective rules when classic API returns 403', async () => {
  const snapshot = fixture();
  snapshot.protection = null;
  snapshot.rules = strictRules();
  const client = fakeClient(snapshot);
  const original = client.request.bind(client);
  client.request = async (...args) => {
    if (args[0] === `${ROOT}/branches/main/protection`) throw new Error('GitHub API 403');
    return original(...args);
  };
  const result = await inspectPull(client, 42);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.protection, null);
});

test('effective strict rules do not substitute for an exact-head human approval', () => {
  const snapshot = fixture();
  snapshot.protection = null;
  snapshot.rules = strictRules();
  snapshot.reviews = [];
  assert.ok(readiness(snapshot).includes('current-head-human-approval-required'));
});

test('read-only repository metadata uses GraphQL when the REST squash setting is omitted', async () => {
  const snapshot = fixture();
  delete snapshot.repo.allow_squash_merge;
  const client = fakeClient(snapshot);
  const original = client.request.bind(client);
  client.request = async (path, method, body) => {
    if (path === '/graphql') {
      assert.equal(method, 'POST');
      assert.match(body.query, /^query\s/);
      assert.match(body.query, /squashMergeAllowed/);
      return { data: { repository: { squashMergeAllowed: true } } };
    }
    return original(path, method, body);
  };
  assert.deepEqual((await inspectPull(client, 42)).reasons, []);
});

test('an explicit REST squash refusal never falls back to GraphQL', async () => {
  const snapshot = fixture();
  snapshot.repo.allow_squash_merge = false;
  const client = fakeClient(snapshot);
  assert.ok((await inspectPull(client, 42)).reasons.includes('squash-unavailable'));
  assert.ok(!client.calls.some((call) => call.path === '/graphql'));
});

for (const allowed of [false, null, 'true', undefined]) {
  test(`missing REST squash setting remains blocked with GraphQL ${JSON.stringify(allowed)}`, async () => {
    const snapshot = fixture();
    delete snapshot.repo.allow_squash_merge;
    const client = fakeClient(snapshot);
    const original = client.request.bind(client);
    client.request = async (path, ...args) =>
      path === '/graphql'
        ? { data: { repository: { squashMergeAllowed: allowed } } }
        : original(path, ...args);
    assert.ok((await inspectPull(client, 42)).reasons.includes('squash-unavailable'));
  });
}

test('an unavailable GraphQL squash setting stops merge without mutations', async () => {
  const snapshot = fixture();
  delete snapshot.repo.allow_squash_merge;
  const client = fakeClient(snapshot);
  const original = client.request.bind(client);
  client.request = async (path, ...args) => {
    if (path === '/graphql') throw new Error('GitHub API 403');
    return original(path, ...args);
  };
  await assert.rejects(maintain(client, { mode: 'merge' }), /stopped/);
  assert.ok(client.calls.every((call) => ['GET', 'QUERY'].includes(call.method)));
});
