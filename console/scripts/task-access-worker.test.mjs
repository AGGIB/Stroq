import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accessFixture, buildAccessFixture, hash } from './task-access-test-helpers.mjs';

const built = await buildAccessFixture();
after(() => rm(built.output, { recursive: true, force: true }));
const previewId = '11111111-1111-1111-1111-111111111111';
const receiptId = '22222222-2222-2222-2222-222222222222';
const issue = (f, made, hooks) =>
  f.run('access-issue', { plan: made.plan, previewId, receiptId }, hooks);
const browser = (input) => ({ id: input.id, expectedEvidenceSha: input.expectedEvidenceSha });

test('real signed refusal becomes a bounded signed extension and the actual gate permits once', async (t) => {
  const f = await accessFixture(t, built),
    refused = await f.refuse();
  assert.equal(refused.result.decision.effect, 'deny');
  assert.ok(refused.row.approvalRequest);
  const made = await f.run('access-preview', refused.input);
  assert.equal(made.operation.kind, 'read-target');
  assert.equal(made.operation.requiredCount, 1);
  assert.equal(
    JSON.parse(made.operation.review).target.real ?? JSON.parse(made.operation.review).target.path,
    f.event.toolInput.file_path,
  );
  const privateBefore = await lstat(f.privatePath),
    contents = await readFile(f.privatePath);
  const receipt = await issue(f, made);
  assert.equal(built.schema.validateTaskAccessReceipt(receipt), true);
  assert.equal(receipt.state, 'unused');
  assert.equal(receipt.execution, 'unverified');
  assert.equal(Date.parse(receipt.expiresAt) - Date.parse(receipt.issuedAt), 300000);
  const file = join(f.home, 'tasks', f.body.taskId, 'extensions', `${receipt.fingerprint}.json`);
  assert.equal(hash(await readFile(file)), receipt.extensionSha256);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(f.home, 'tasks', f.body.taskId, 'extensions')), [
    `${receipt.fingerprint}.json`,
  ]);
  assert.deepEqual(await readFile(f.privatePath), contents);
  assert.equal((await lstat(f.privatePath)).mtimeMs, privateBefore.mtimeMs);
  const ledger = () =>
    f.run('access-state', { id: receipt.taskId, expectedPermitSha256: receipt.permitSha256 });
  assert.equal((await ledger()).permissions[0].state, 'unused');
  assert.equal(
    (await f.stroq.pre({ ...f.event, callId: 'explicit-retry' })).decision.effect,
    'allow',
  );
  assert.equal(
    (await f.stroq.pre({ ...f.event, callId: 'another-retry' })).decision.effect,
    'deny',
  );
  assert.equal((await ledger()).permissions[0].state, 'consumed');
  for (const value of [
    f.body.taskId,
    f.body.nonce,
    f.body.sessionId,
    contents.toString(),
    'private-access-session',
  ])
    assert.equal(JSON.stringify(receipt).includes(value), false);
});

test('preview inspects only private-key metadata; bad existing PEM is first refused after explicit issue', async (t) => {
  const f = await accessFixture(t, built),
    refused = await f.refuse();
  await writeFile(f.privatePath, 'not a private key', { mode: 0o600 });
  const made = await f.run('access-preview', refused.input);
  await assert.rejects(issue(f, made), { message: 'signing-key-unavailable' });
  await assert.rejects(lstat(join(f.home, 'tasks', f.body.taskId, 'extensions')), {
    code: 'ENOENT',
  });
  const other = built.core.generateKeyPair();
  await writeFile(f.privatePath, other.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  const next = await f.run('access-preview', refused.input);
  await assert.rejects(issue(f, next), { message: 'signing-key-mismatch' });
});

test('all supported full-call families retain exact argument/context fingerprints', async (t) => {
  for (const event of [
    { toolName: 'Bash', toolInput: { command: 'printf "inert"\n' } },
    { toolName: 'Write', toolInput: { file_path: '/outside/inert.txt', content: 'inert' } },
    { toolName: 'Grep', toolInput: { pattern: 'inert', path: '/outside' } },
    { toolName: 'mcp__notes__lookup', toolInput: { query: 'inert' } },
  ])
    await t.test(event.toolName, async (sub) => {
      const f = await accessFixture(sub, built, { event }),
        refused = await f.refuse();
      assert.equal(refused.result.decision.effect, 'deny');
      const made = await f.run('access-preview', refused.input);
      assert.equal(made.operation.kind, 'whole-call');
      assert.deepEqual(JSON.parse(made.operation.review).input, event.toolInput);
      const receipt = await issue(f, made);
      assert.equal(receipt.fingerprint, refused.row.approvalRequest.body.fingerprint);
      const changed = await f.stroq.pre({
        ...f.event,
        callId: 'changed',
        toolInput: { ...f.event.toolInput, note: 'different arguments' },
      });
      assert.equal(changed.decision.effect, 'deny');
      assert.equal(
        (
          await f.run('access-state', {
            id: receipt.taskId,
            expectedPermitSha256: receipt.permitSha256,
          })
        ).permissions[0].state,
        'unused',
      );
    });
});

test('multiple requirements stay explicit: issuing one does not falsely promise a successful retry', async (t) => {
  const policy = { ...built.core.DEFAULT_POLICY, rules: [], default: 'ask' };
  const f = await accessFixture(t, built, { policy }),
    first = await f.refuse();
  const made = await f.run('access-preview', first.input);
  assert.equal(made.operation.requiredCount, 2);
  await issue(f, made);
  const second = await f.refuse({ callId: 'second-refusal' });
  assert.equal(second.result.decision.effect, 'deny');
  const another = await f.run('access-preview', second.input);
  assert.equal(another.operation.kind, 'whole-call');
  await issue(f, another);
  assert.equal(
    (await f.stroq.pre({ ...f.event, callId: 'explicit-third-call' })).decision.effect,
    'allow',
  );
  assert.equal(
    (await f.stroq.pre({ ...f.event, callId: 'explicit-fourth-call' })).decision.effect,
    'deny',
  );
});

test('legacy, tampered review, call, signature and replacement permit never become signing authority', async (t) => {
  for (const mutate of [
    (row) => {
      row.scope.kind = ['scope'];
    },
    (row) => {
      delete row.approvalRequest;
    },
    (row) => {
      row.approvalReview += ' ';
    },
    (row) => {
      row.callId = 'another-call';
    },
    (row) => {
      row.approvalRequest.sig = 'A'.repeat(86);
    },
  ])
    await t.test(mutate.toString().slice(0, 65), async (sub) => {
      const f = await accessFixture(sub, built),
        original = await f.refuse();
      const row = structuredClone(original.row);
      mutate(row);
      const { hash: _old, ...body } = row;
      row.hash = built.core.hashEntry(body);
      const raw = JSON.stringify(row);
      await writeFile(f.journalPath, raw + '\n');
      const input = {
        id: 'incident-' + hash(raw),
        expectedEvidenceSha: hash(raw),
        sequence: row.seq,
        recordedAt: row.ts,
      };
      await assert.rejects(f.run('access-preview', input), /legacy-refusal|refusal-unavailable/);
      await assert.rejects(lstat(join(f.home, 'tasks', f.body.taskId, 'extensions')), {
        code: 'ENOENT',
      });
    });
  const f = await accessFixture(t, built),
    original = await f.refuse();
  await writeFile(
    f.sourcePath,
    JSON.stringify(
      built.core.signPermit({ ...f.body, nonce: 'changed-nonce-0123456789' }, f.pair.privateKey),
    ),
  );
  await assert.rejects(f.run('access-preview', original.input), { message: 'refusal-unavailable' });
});

test('source, key mode, task standing, runtime and journal drift are refused before publishing', async (t) => {
  for (const kind of ['permit', 'key-mode', 'revoked', 'runtime', 'journal'])
    await t.test(kind, async (sub) => {
      const f = await accessFixture(sub, built),
        original = await f.refuse(),
        made = await f.run('access-preview', original.input);
      if (kind === 'permit')
        await writeFile(f.sourcePath, (await readFile(f.sourcePath, 'utf8')) + '\n');
      if (kind === 'key-mode') await chmod(f.privatePath, 0o640);
      if (kind === 'revoked') f.store.revoke(f.body.taskId);
      if (kind === 'runtime') made.plan.runtimeSha256 = 'c'.repeat(64);
      if (kind === 'journal') {
        const raw = await readFile(f.journalPath);
        await rm(f.journalPath);
        await writeFile(f.journalPath, raw, { mode: 0o600 });
      }
      await assert.rejects(
        issue(f, made),
        /preview-stale|task-unavailable|signing-key-unavailable|stale-evidence/,
      );
      await assert.rejects(lstat(join(f.home, 'tasks', f.body.taskId, 'extensions')), {
        code: 'ENOENT',
      });
    });
});

test('existing extensions are never overwritten, including consumed, expired and malformed files', async (t) => {
  const f = await accessFixture(t, built),
    original = await f.refuse(),
    made = await f.run('access-preview', original.input);
  const receipt = await issue(f, made),
    file = join(f.home, 'tasks', f.body.taskId, 'extensions', `${receipt.fingerprint}.json`);
  const before = await readFile(file);
  f.store.consumeEscalation(f.body.taskId, receipt.fingerprint, before.toString());
  let fresh = await f.refuse({ callId: 'after-consumption' });
  await assert.rejects(f.run('access-preview', fresh.input), { message: 'permission-active' });
  f.advance(360000);
  fresh = await f.refuse({ callId: 'after-expiry' });
  await assert.rejects(f.run('access-preview', fresh.input), { message: 'permission-active' });
  assert.deepEqual(await readFile(file), before);
  await writeFile(file, '{invalid');
  await assert.rejects(f.run('access-preview', fresh.input), { message: 'permission-active' });
  assert.equal(await readFile(file, 'utf8'), '{invalid');
});

test('a retained used marker without its old extension never permits a silent replacement grant', async (t) => {
  const f = await accessFixture(t, built),
    original = await f.refuse(),
    made = await f.run('access-preview', original.input);
  const receipt = await issue(f, made),
    path = join(f.home, 'tasks', f.body.taskId, 'extensions', `${receipt.fingerprint}.json`);
  assert.equal(
    (await f.stroq.pre({ ...f.event, callId: 'spent-before-file-deletion' })).decision.effect,
    'allow',
  );
  await rm(path);
  const fresh = await f.refuse({ callId: 'new-refusal-after-file-deletion' });
  await assert.rejects(f.run('access-preview', fresh.input), { message: 'permission-unavailable' });
  await assert.rejects(lstat(path), { code: 'ENOENT' });
});

test('safe immediate native consumption is reported as consumed; an unsafe marker never is', async (t) => {
  for (const unsafe of [false, true])
    await t.test(String(unsafe), async (sub) => {
      const f = await accessFixture(sub, built),
        original = await f.refuse(),
        made = await f.run('access-preview', original.input);
      const pending = issue(f, made, {
        fault: async (stage, details) => {
          if (stage !== 'access-after-publish') return;
          if (unsafe) await symlink(f.privatePath, details.usedPath);
          else
            assert.equal(
              f.store.consumeEscalation(
                f.body.taskId,
                made.operation.fingerprint,
                details.candidate,
              ),
              true,
            );
        },
      });
      if (unsafe) await assert.rejects(pending, { message: 'write-unconfirmed' });
      else assert.equal((await pending).state, 'consumed');
    });
});

test('a real gate may consume and a launcher may safely end before issue readback', async (t) => {
  for (const unsafe of [false, true])
    await t.test(String(unsafe), async (sub) => {
      const f = await accessFixture(sub, built),
        original = await f.refuse(),
        made = await f.run('access-preview', original.input);
      const pending = issue(f, made, {
        fault: async (stage) => {
          if (stage !== 'access-after-publish') return;
          assert.equal(
            (await f.stroq.pre({ ...f.event, callId: 'native-immediate-retry' })).decision.effect,
            'allow',
          );
          f.store.end(f.body.taskId);
          if (unsafe)
            await writeFile(
              join(f.home, 'tasks', f.body.taskId, 'ended'),
              'not an empty terminal marker',
            );
        },
      });
      if (unsafe) await assert.rejects(pending, { message: 'write-unconfirmed' });
      else assert.equal((await pending).state, 'consumed');
    });
});

test('after-stage stale sources are not published; post-publish external edits are retained as unknown', async (t) => {
  for (const after of [false, true])
    await t.test(String(after), async (sub) => {
      const f = await accessFixture(sub, built),
        original = await f.refuse(),
        made = await f.run('access-preview', original.input);
      let final;
      await assert.rejects(
        issue(f, made, {
          fault: async (stage, details) => {
            if (stage !== (after ? 'access-after-publish' : 'access-after-stage')) return;
            final = details.finalPath;
            if (after) await writeFile(final, 'FOREIGN_NEWER_DATA');
            else await writeFile(f.sourcePath, (await readFile(f.sourcePath, 'utf8')) + '\n');
          },
        }),
        { message: after ? 'write-unconfirmed' : 'preview-stale' },
      );
      if (after) assert.equal(await readFile(final, 'utf8'), 'FOREIGN_NEWER_DATA');
      else await assert.rejects(lstat(final), { code: 'ENOENT' });
    });
});

test('changed staged bytes are never published or overwritten during cleanup', async (t) => {
  const f = await accessFixture(t, built),
    original = await f.refuse(),
    made = await f.run('access-preview', original.input);
  let path, stagePath;
  await assert.rejects(
    issue(f, made, {
      fault: async (stage, details) => {
        if (stage !== 'access-after-stage') return;
        path = details.finalPath;
        stagePath = details.stage;
        await writeFile(stagePath, 'FOREIGN_STAGE_EDIT');
      },
    }),
    /task-access-failed|preview-stale/,
  );
  await assert.rejects(lstat(path), { code: 'ENOENT' });
  assert.equal(await readFile(stagePath, 'utf8'), 'FOREIGN_STAGE_EDIT');
});

test('ledger reports orphan or unsafe used markers as incomplete rather than a clean empty history', async (t) => {
  const f = await accessFixture(t, built),
    original = await f.refuse(),
    made = await f.run('access-preview', original.input),
    receipt = await issue(f, made);
  const dir = join(f.home, 'tasks', f.body.taskId, 'extensions');
  await writeFile(join(dir, `${'f'.repeat(64)}.${'e'.repeat(16)}.used`), '', { mode: 0o600 });
  await writeFile(join(dir, `${'d'.repeat(64)}.json`), '{invalid', { mode: 0o600 });
  const state = await f.run('access-state', {
    id: receipt.taskId,
    expectedPermitSha256: receipt.permitSha256,
  });
  assert.equal(built.schema.validateTaskAccessState(state), true);
  assert.equal(state.coverage.complete, false);
  assert.equal(state.coverage.unverified, 2);
  assert.equal(
    state.permissions.find((row) => row.fingerprint === 'd'.repeat(64)).state,
    'invalid',
  );
});
