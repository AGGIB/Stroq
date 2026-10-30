import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ACTION_CLASSES, AuditLog } from '../../packages/core/dist/index.js';
import { createIncidentService } from './incidents.mjs';
import { createIncidentRecheckService } from './incident-recheck.mjs';

const NOW = new Date('2026-10-23T11:00:00.000Z');
const SHA = 'a'.repeat(64);
const request = { id: `incident-${SHA}`, expectedEvidenceSha: SHA };
const recorded = (extra = {}) => ({
  phase: 'pre',
  classes: ['shell.network'],
  decision: { effect: 'deny', ruleId: 'private-rule', reason: 'private reason' },
  summary: 'PRIVATE_COMMAND_AND_VALUE',
  sessionId: 'PRIVATE_SESSION',
  ...extra,
});
const policy = `version: 1\ndefault: allow\nrules:\n  - id: private-rule\n    effect: deny\n    reason: PRIVATE_POLICY_REASON\n    when:\n      classes: [shell.network]\n      taint: suspect\n`;
async function fixture(t, extra = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-recheck-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'state');
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(home, 'policy.yaml'), policy, { mode: 0o600 });
  const service = createIncidentRecheckService({
    home,
    now: () => NOW,
    selectEvidence: async () => recorded(),
    ...extra,
  });
  t.after(() => service.close());
  return { home, service };
}

test('compares current policy under both taint assumptions, withholding private text', async (t) => {
  const { service } = await fixture(t);
  const result = await service.compare(request);
  assert.equal(result.schema, 'stroq-incident-comparison/1');
  assert.equal(result.incidentId, request.id);
  assert.equal(result.evidenceSha, SHA);
  assert.equal(result.previousEffect, 'deny');
  assert.equal(result.relation, 'mixed');
  assert.deepEqual(
    result.scenarios.map((item) => [item.taint, item.effect]),
    [
      ['none', 'allow'],
      ['suspect', 'deny'],
    ],
  );
  assert.equal(result.scenarios[0].matchedRule, null);
  assert.deepEqual(result.scenarios[1].matchedRule, {
    index: 0,
    classes: ['shell.network'],
    taint: 'suspect',
  });
  assert.match(result.currentPolicy.semanticSha, /^[a-f0-9]{64}$/);
  assert.match(result.currentPolicy.rawSha, /^[a-f0-9]{64}$/);
  const json = JSON.stringify(result);
  for (const value of [
    'PRIVATE_COMMAND_AND_VALUE',
    'PRIVATE_SESSION',
    'private-rule',
    'private reason',
    'PRIVATE_POLICY_REASON',
  ])
    assert.equal(json.includes(value), false);
  assert.equal(result.scopeRecorded, false);
  assert.ok(result.limitations.some((text) => /taint.*not recorded/i.test(text)));
});

test('default rules and explicit empty classes are compared without calling the record remediated', async (t) => {
  const { home, service } = await fixture(t, {
    selectEvidence: async () => recorded({ classes: [] }),
  });
  await writeFile(join(home, 'policy.yaml'), 'version: 1\ndefault: ask\nrules: []\n');
  const result = await service.compare(request);
  assert.equal(result.relation, 'changed');
  assert.deepEqual(result.classes, []);
  assert.deepEqual(
    result.scenarios.map((item) => item.effect),
    ['ask', 'ask'],
  );
  assert.ok(result.scenarios.every((item) => item.matchedRule === null));
  assert.ok(result.limitations.some((text) => /runtime guards are not evaluated/.test(text)));
  assert.ok(result.limitations.some((text) => /does not establish.*remediation/.test(text)));
});

test('normalizes repeated known classes and marks even null scope/task properties as present', async (t) => {
  const { service } = await fixture(t, {
    selectEvidence: async () =>
      recorded({ classes: ['shell.network', 'shell.network'], taskId: null }),
  });
  const result = await service.compare(request);
  assert.deepEqual(result.classes, ['shell.network']);
  assert.equal(result.scopeRecorded, true);
});

test('refuses unknown or missing classes, post scans, failed attempts and malformed decisions', async (t) => {
  let row = recorded();
  const { service } = await fixture(t, { selectEvidence: async () => row });
  for (const extra of [
    { classes: ['shell.network', 'unknown.class'] },
    { classes: undefined },
    { classes: null },
    { classes: [42] },
    { phase: 'post', scan: { verdict: 'suspect', score: 0.9 } },
    { outcome: 'failed' },
    { outcome: undefined },
    { decision: { effect: 'allow' } },
    { decision: { effect: 'blocked' } },
  ]) {
    row = recorded(extra);
    await assert.rejects(service.compare(request), /unsupported-evidence/);
  }
});

test('closed request cannot carry arbitrary paths, commands or malformed evidence bindings', async (t) => {
  let selected = 0;
  const { service } = await fixture(t, {
    selectEvidence: async () => {
      selected++;
      return recorded();
    },
  });
  for (const value of [
    null,
    [],
    {},
    { ...request, path: '/private/value' },
    { ...request, command: 'do not execute' },
    { ...request, id: `incident-${'b'.repeat(64)}` },
    { ...request, expectedEvidenceSha: 'not-sha' },
  ])
    await assert.rejects(service.compare(value), /invalid-request/);
  assert.equal(selected, 0);
});

test('uses built-in policy only when the safe fixed policy file is absent', async (t) => {
  const { home, service } = await fixture(t);
  await rm(join(home, 'policy.yaml'));
  const result = await service.compare(request);
  assert.equal(result.currentPolicy.source, 'built-in');
  assert.equal(result.currentPolicy.rawSha, null);
  assert.match(result.currentPolicy.semanticSha, /^[a-f0-9]{64}$/);
});

test('refuses symlink and invalid/unknown-field policies rather than falling back to defaults', async (t) => {
  const { home, service } = await fixture(t);
  const path = join(home, 'policy.yaml');
  for (const text of [
    'version: 2\nrules: []\n',
    'version: 1\ndefault: allow\nrules: [\n',
    'version: 1\nrules: []\nunrecognised: PRIVATE_VALUE\n',
    'version: 1\nrules:\n  - id: x\n    effect: deny\n    reason: x\n    when:\n      classes: [unknown.class]\n',
  ]) {
    await writeFile(path, text);
    await assert.rejects(service.compare(request), /policy-invalid/);
  }
  await rm(path);
  await writeFile(join(home, 'private-target'), policy, { mode: 0o600 });
  await symlink(join(home, 'private-target'), path);
  await assert.rejects(service.compare(request), /policy-unavailable/);
});

test('duplicate custom rule IDs cannot attribute a later match to an earlier nonmatching rule', async (t) => {
  const { home, service } = await fixture(t);
  await writeFile(
    join(home, 'policy.yaml'),
    `version: 1\ndefault: allow\nrules:\n  - id: duplicate\n    effect: ask\n    reason: private\n    when:\n      classes: [shell.destructive]\n  - id: duplicate\n    effect: deny\n    reason: private\n    when:\n      classes: [shell.network]\n`,
  );
  const result = await service.compare(request);
  assert.equal(result.relation, 'matchesRecorded');
  assert.deepEqual(
    result.scenarios.map((item) => item.matchedRule.index),
    [1, 1],
  );
  assert.equal(JSON.stringify(result).includes('duplicate'), false);
});

test('rechecks selected evidence after the immutable worker capture', async (t) => {
  let calls = 0;
  const { service } = await fixture(t, {
    selectEvidence: async () => {
      if (++calls === 2) throw new Error('stale-evidence');
      return recorded();
    },
  });
  await assert.rejects(service.compare(request), /stale-evidence/);
  assert.equal(calls, 2);
});

test('rechecks exact policy bytes, including comment-only changes, after evaluation', async (t) => {
  const { runIncidentRecheck } = await import('./incident-recheck-worker.mjs');
  let home;
  const values = await fixture(t, {
    adapter: async (text, classes, options) => {
      const result = await runIncidentRecheck(text, classes, options);
      await writeFile(join(home, 'policy.yaml'), `${text}\n# changed during comparison\n`);
      return result;
    },
  });
  home = values.home;
  await assert.rejects(values.service.compare(request), /stale-policy/);
});

test('does not accept result fields that could smuggle raw strings into HTTP responses', async (t) => {
  const { runIncidentRecheck } = await import('./incident-recheck-worker.mjs');
  const { service } = await fixture(t, {
    adapter: async (...args) => ({
      ...(await runIncidentRecheck(...args)),
      reason: 'PRIVATE_REASON',
    }),
  });
  await assert.rejects(service.compare(request), /engine-failed/);
});

test('serializes comparisons, cancels on service close and refuses work after shutdown', async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const { service } = await fixture(t, {
    adapter: async (_text, _classes, { signal }) =>
      new Promise((_resolve, reject) => {
        entered();
        signal.addEventListener('abort', () => reject(new Error('server-stopped')), { once: true });
      }),
  });
  const first = service.compare(request);
  await started;
  await assert.rejects(service.compare(request), /busy/);
  const check = assert.rejects(first, /server-stopped/);
  await service.close();
  await check;
  await assert.rejects(service.compare(request), /server-stopped/);
});

test('the closed service class allowlist includes every current core action class', async (t) => {
  const { service } = await fixture(t, {
    selectEvidence: async () => recorded({ classes: [...ACTION_CLASSES] }),
  });
  assert.deepEqual((await service.compare(request)).classes, [...ACTION_CLASSES]);
});

test('rejects malformed adapter rule predicates and unknown class strings before returning a report', async (t) => {
  const { runIncidentRecheck } = await import('./incident-recheck-worker.mjs');
  let corrupt;
  const { service } = await fixture(t, {
    adapter: async (...args) => {
      const result = await runIncidentRecheck(...args);
      return {
        ...result,
        scenarios: result.scenarios.map((scenario) => ({
          ...scenario,
          matchedRule: scenario.matchedRule ? corrupt(scenario.matchedRule) : null,
        })),
      };
    },
  });
  for (const change of [
    (rule) => ({ ...rule, classes: ['private.reason'] }),
    (rule) => ({ ...rule, classes: ['shell.network', 'shell.network'] }),
    (rule) => ({ ...rule, classes: ['shell.destructive'] }),
    (rule) => ({ ...rule, taint: 'none' }),
    (rule) => ({ ...rule, index: 999 }),
  ]) {
    corrupt = change;
    await assert.rejects(service.compare(request), /engine-failed/);
  }
});

test('real bounded incident selector permits unrelated appends but refuses changed exact evidence', async (t) => {
  const { home } = await fixture(t);
  const file = join(home, 'audit.jsonl');
  const journal = new AuditLog(file, () => NOW);
  await journal.append({ ...recorded(), tool: 'Bash' });
  const incidents = createIncidentService({ home, now: () => NOW });
  const { runIncidentRecheck } = await import('./incident-recheck-worker.mjs');
  let append = true;
  const service = createIncidentRecheckService({
    home,
    now: () => NOW,
    selectEvidence: incidents.selectForComparison,
    adapter: async (...args) => {
      const result = await runIncidentRecheck(...args);
      if (append) await journal.append({ ...recorded(), tool: 'Bash', classes: ['fs.secrets'] });
      else await writeFile(file, '');
      return result;
    },
  });
  t.after(async () => {
    await service.close();
    await incidents.close();
  });
  const original = (await incidents.read()).incidents[0];
  const bound = { id: original.id, expectedEvidenceSha: original.evidenceSha };
  assert.equal((await service.compare(bound)).evidenceSha, original.evidenceSha);
  append = false;
  await assert.rejects(service.compare(bound), /stale-evidence/);
});

test('captures request identity before yielding to asynchronous selection', async (t) => {
  const bound = { ...request };
  const seen = [];
  const { service } = await fixture(t, {
    selectEvidence: async (value) => {
      seen.push(value.id);
      return recorded();
    },
  });
  const operation = service.compare(bound);
  bound.id = `incident-${'b'.repeat(64)}`;
  bound.expectedEvidenceSha = 'b'.repeat(64);
  assert.equal((await operation).incidentId, request.id);
  assert.deepEqual(seen, [request.id, request.id]);
});

test('shutdown during final evidence revalidation cannot return an accepted comparison', async (t) => {
  let entered;
  let release;
  let calls = 0;
  const atFinalSelection = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { service } = await fixture(t, {
    selectEvidence: async () => {
      if (++calls === 2) {
        entered();
        await gate;
      }
      return recorded();
    },
  });
  const comparison = service.compare(request);
  await atFinalSelection;
  const rejection = assert.rejects(comparison, /server-stopped/);
  const closing = service.close();
  release();
  await rejection;
  await closing;
});
