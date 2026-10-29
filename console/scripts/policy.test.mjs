import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  chmod,
  stat,
  symlink,
  link,
  readdir,
  rm,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createPolicyService } from './policy-service.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const text = 'version: 1\nthreshold: 0.6\ndefault: allow\nrules: []\n';
const candidate = text.replace('default: allow', 'default: ask');
const expected = {
  policyFingerprint: 'a'.repeat(64),
  defaultEffect: 'allow',
  threshold: 0.6,
  rules: [{ index: 0, effect: 'ask', classes: ['shell.destructive'], taint: 'any' }],
  check: { ok: true, loaded: true, faults: 0, findings: [] },
  editable: true,
};
function adapter(options = {}) {
  return async (operation) =>
    operation === 'inspect'
      ? expected
      : {
          candidateText: candidate,
          currentPolicyFingerprint: 'a'.repeat(64),
          candidateFingerprint: 'b'.repeat(64),
          changes: [{ field: 'default', from: 'allow', to: 'ask' }],
          check: expected.check,
          simulation: {
            ok: true,
            replayed: { attack: 1, ordinary: 1, cases: 0 },
            attacksPassing: 0,
            newInterruptions: 0,
            relieved: 0,
            violations: 0,
            notJudged: 0,
          },
          blockers: [],
          requiresInterruptionAcknowledgement: false,
          interruptions: [],
          interruptionsTruncated: false,
          actionControl: null,
          regressions: { revision: null, total: 0, passed: 0, failed: 0, results: [] },
          ...options,
        };
}
async function fixture(t, content = text, options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-policy-test-')));
  const home = join(base, 'home');
  await mkdir(home, { mode: 0o700 });
  if (content !== null) await writeFile(join(home, 'policy.yaml'), content, { mode: 0o600 });
  t.after(() => rm(base, { recursive: true, force: true }));
  return {
    base,
    home,
    file: join(home, 'policy.yaml'),
    service: createPolicyService({ home, adapter: adapter(), ...options }),
  };
}
async function preview(service, rawSha = hash(text)) {
  const response = await service.preview({
    expectedRawSha: rawSha,
    changes: { defaultEffect: 'ask' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
const applyInput = (p) => ({
  previewId: p.previewId,
  expectedRawSha: p.expectedRawSha,
  candidateFingerprint: p.candidateFingerprint,
});

test('inspect exposes a raw revision and sanitized effective settings', async (t) => {
  const { service } = await fixture(t);
  const result = await service.inspect();
  assert.equal(result.status, 200);
  assert.equal(result.body.expectedRawSha, hash(text));
  assert.equal(result.body.source, 'file');
  assert.equal(JSON.stringify(result).includes(text), false);
});

test('preview is read-only and does not return candidate YAML', async (t) => {
  const { service, file, home } = await fixture(t);
  const p = await preview(service);
  assert.equal(p.candidateFingerprint, 'b'.repeat(64));
  assert.equal('candidateText' in p, false);
  assert.equal(await readFile(file, 'utf8'), text);
  assert.deepEqual(await readdir(home), ['policy.yaml']);
});

test('class controls require their own shared-scope acknowledgement before writing', async (t) => {
  const actionControl = {
    classes: ['shell.network'],
    removedRules: 0,
    narrowedRules: 0,
    taint: 'any',
    scope: 'stroq-home',
    hostEnforcement: false,
  };
  const { service, file } = await fixture(t, text, {
    adapter: adapter({
      actionControl,
      changes: [
        { field: 'class-deny', actionClass: 'shell.network', from: 'current-policy', to: 'deny' },
      ],
    }),
  });
  const response = await service.preview({
    expectedRawSha: hash(text),
    changes: { denyActionClasses: ['shell.network'] },
  });
  assert.equal(response.status, 200);
  const p = response.body;
  assert.equal((await service.apply(applyInput(p))).body.error, 'action-scope-ack-required');
  assert.equal(await readFile(file, 'utf8'), text);
  assert.equal(
    (await service.apply({ ...applyInput(p), acknowledgeActionScope: true })).status,
    200,
  );
});

test('class-control request boundary rejects unknown, duplicate and empty selections', async (t) => {
  const { service } = await fixture(t);
  for (const classes of [
    [],
    ['shell.network', 'shell.network'],
    ['private-command'],
    [null],
    ['constructor'],
    new Array(1),
  ]) {
    const response = await service.preview({
      expectedRawSha: hash(text),
      changes: { denyActionClasses: classes },
    });
    assert.equal(response.status, 400);
  }
});

test('apply writes exactly the preview and keeps a private byte backup', async (t) => {
  const { service, file, home } = await fixture(t);
  const p = await preview(service);
  const applied = await service.apply(applyInput(p));
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(await readFile(file, 'utf8'), candidate);
  assert.equal(applied.body.rawSha, hash(candidate));
  const backup = join(home, 'backups', 'console-policy', `${applied.body.backupId}.yaml`);
  assert.equal(await readFile(backup, 'utf8'), text);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await service.apply(applyInput(p))).status, 409);
});

test('private or contradictory action-control output is refused before becoming a preview', async (t) => {
  const control = {
    classes: ['shell.network'],
    removedRules: 0,
    narrowedRules: 0,
    taint: 'any',
    scope: 'stroq-home',
    hostEnforcement: false,
  };
  for (const patch of [
    { raw: 'PRIVATE_SOURCE' },
    { classes: ['mcp.call'] },
    { hostEnforcement: true },
    { removedRules: 512, narrowedRules: 1 },
  ]) {
    const { service, file } = await fixture(t, text, {
      adapter: adapter({
        actionControl: { ...control, ...patch },
        changes: [
          { field: 'class-deny', actionClass: 'shell.network', from: 'current-policy', to: 'deny' },
        ],
      }),
    });
    const response = await service.preview({
      expectedRawSha: hash(text),
      changes: { denyActionClasses: ['shell.network'] },
    });
    assert.equal(response.status, 502);
    assert.deepEqual(response.body, { error: 'engine-failed' });
    assert.equal(await readFile(file, 'utf8'), text);
  }
});

test('absent policy is its own revision and a new file has no fake backup', async (t) => {
  const { service, file } = await fixture(t, null);
  assert.equal((await service.inspect()).body.source, 'default');
  const p = await preview(service, null);
  const applied = await service.apply(applyInput(p));
  assert.equal(applied.status, 200);
  assert.equal(applied.body.backupId, null);
  assert.equal(await readFile(file, 'utf8'), candidate);
});

test('comment-only external edits invalidate preview and are never overwritten', async (t) => {
  const { service, file } = await fixture(t);
  const p = await preview(service);
  await writeFile(file, `${text}# concurrent owner edit\n`);
  const result = await service.apply(applyInput(p));
  assert.equal(result.body.error, 'stale-policy');
  assert.equal(await readFile(file, 'utf8'), `${text}# concurrent owner edit\n`);
});

test('newly appeared policy invalidates an absent baseline', async (t) => {
  const { service, file } = await fixture(t, null);
  const p = await preview(service, null);
  await writeFile(file, text);
  assert.equal((await service.apply(applyInput(p))).body.error, 'stale-policy');
});

test('mismatched fingerprint, stale preview request and extra fields are refused', async (t) => {
  const { service } = await fixture(t);
  assert.equal(
    (await service.preview({ expectedRawSha: 'f'.repeat(64), changes: { defaultEffect: 'ask' } }))
      .body.error,
    'stale-policy',
  );
  assert.equal(
    (await service.preview({ expectedRawSha: hash(text), changes: { command: 'noop' } })).body
      .error,
    'invalid-request',
  );
  const p = await preview(service);
  assert.equal(
    (await service.apply({ ...applyInput(p), candidateFingerprint: 'f'.repeat(64) })).body.error,
    'preview-mismatch',
  );
  assert.equal(
    (await service.apply({ ...applyInput(p), path: '/tmp/other' })).body.error,
    'invalid-request',
  );
});

test('expired preview must be generated again', async (t) => {
  let now = 1_700_000_000_000;
  const { service } = await fixture(t, text, { now: () => now });
  const p = await preview(service);
  now += 11 * 60_000;
  assert.equal((await service.apply(applyInput(p))).body.error, 'preview-expired');
});

test('failed checks cannot apply, and interruptions require explicit acknowledgement', async (t) => {
  const failed = await fixture(t, text, { adapter: adapter({ blockers: ['policy-findings'] }) });
  const p = await preview(failed.service);
  assert.equal((await failed.service.apply(applyInput(p))).body.error, 'checks-failed');
  const changed = await fixture(t, text, {
    adapter: adapter({ requiresInterruptionAcknowledgement: true }),
  });
  const next = await preview(changed.service);
  assert.equal(
    (await changed.service.apply(applyInput(next))).body.error,
    'interruption-ack-required',
  );
  assert.equal(
    (await changed.service.apply({ ...applyInput(next), acknowledgeInterruptions: true })).status,
    200,
  );
});

test('policy symlinks, hard links, non-regular files and oversized files are refused', async (t) => {
  for (const kind of ['symlink', 'hardlink', 'directory', 'large']) {
    const { service, base, file } = await fixture(t, null);
    const outside = join(base, 'outside');
    await writeFile(outside, text);
    if (kind === 'symlink') await symlink(outside, file);
    if (kind === 'hardlink') await link(outside, file);
    if (kind === 'directory') await mkdir(file);
    if (kind === 'large') await writeFile(file, 'x'.repeat(256 * 1024 + 1));
    assert.equal((await service.inspect()).body.error, 'policy-unavailable', kind);
    assert.equal(await readFile(outside, 'utf8'), text);
  }
});

test('symlinked home or backup directory cannot redirect writes', async (t) => {
  const { home, base, service } = await fixture(t);
  const alias = join(base, 'alias');
  await symlink(home, alias);
  assert.equal(
    (await createPolicyService({ home: alias, adapter: adapter() }).inspect()).body.error,
    'policy-unavailable',
  );
  const p = await preview(service);
  await symlink(base, join(home, 'backups'));
  assert.equal((await service.apply(applyInput(p))).body.error, 'backup-unavailable');
  assert.equal(await readFile(join(home, 'policy.yaml'), 'utf8'), text);
});

test('read-only target is not replaced and external errors do not leak paths', async (t) => {
  const { service, file } = await fixture(t);
  const p = await preview(service);
  await chmod(file, 0o400);
  // A mode change invalidates the exact preview before the writer is entered.
  assert.equal((await service.apply(applyInput(p))).body.error, 'stale-policy');
  const readonly = await fixture(t);
  await chmod(readonly.file, 0o400);
  const readonlyPreview = await preview(readonly.service);
  assert.equal(
    (await readonly.service.apply(applyInput(readonlyPreview))).body.error,
    'write-failed',
  );
  const broken = await fixture(t, text, {
    adapter: async () => {
      throw new Error('SECRET_SENTINEL /private/path');
    },
  });
  assert.equal(JSON.stringify(await broken.service.inspect()).includes('SECRET_SENTINEL'), false);
});

test('first run reads and previews a missing home without creating it', async (t) => {
  const { base } = await fixture(t);
  for (const suffix of ['new-home', 'nested/deep/home']) {
    const home = join(base, suffix);
    const service = createPolicyService({ home, adapter: adapter() });
    assert.equal((await service.inspect()).body.source, 'default');
    const p = await preview(service, null);
    await assert.rejects(stat(home), { code: 'ENOENT' });
    const applied = await service.apply(applyInput(p));
    assert.equal(applied.status, 200);
    assert.equal(applied.body.backupId, null);
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal(await readFile(join(home, 'policy.yaml'), 'utf8'), candidate);
  }
});

test('an interposed home directory or link invalidates a first-run preview', async (t) => {
  for (const kind of ['directory', 'link']) {
    const { base, home: original } = await fixture(t);
    const home = join(base, 'new-home');
    const service = createPolicyService({ home, adapter: adapter() });
    const p = await preview(service, null);
    if (kind === 'directory') await mkdir(home, { mode: 0o700 });
    else await symlink(original, home);
    assert.equal((await service.apply(applyInput(p))).body.error, 'stale-policy');
    assert.equal(await readFile(join(original, 'policy.yaml'), 'utf8'), text);
  }
});

test('inspection is serialized and service close cancels an active worker', async (t) => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const { service } = await fixture(t, text, {
    adapter: (_operation, _text, _changes, { signal }) =>
      new Promise((_resolve, reject) => {
        started();
        signal.addEventListener('abort', () => reject(new Error('engine-unavailable')), {
          once: true,
        });
      }),
  });
  const first = service.inspect();
  await ready;
  assert.equal((await service.inspect()).body.error, 'busy');
  await service.close();
  assert.equal((await first).body.error, 'engine-unavailable');
  assert.equal((await service.inspect()).body.error, 'engine-unavailable');
});

test('changed effective default policy invalidates a preview even without a file', async (t) => {
  const fake = adapter();
  let engineChanged = false;
  const { service } = await fixture(t, null, {
    adapter: async (...args) => {
      const value = await fake(...args);
      return args[0] === 'inspect' && engineChanged
        ? { ...value, policyFingerprint: 'c'.repeat(64) }
        : value;
    },
  });
  const p = await preview(service, null);
  engineChanged = true;
  assert.equal((await service.apply(applyInput(p))).body.error, 'stale-policy');
});
