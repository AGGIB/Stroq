import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSecretScanService } from './secret-scan-service.mjs';

const engine = { available: true, version: '0.28.0' };
const options = { available: async () => engine, fingerprint: async () => 'runtime-a' };
const wait = async (service, id) => {
  for (let i = 0; i < 100; i++) {
    const job = service.getJob(id);
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('job-not-finished');
};

test('state and preview do not read credentials or start a scanner; closed explicit consent is required', async () => {
  let scans = 0;
  const service = await createSecretScanService({ ...options, run: async () => scans++ });
  try {
    assert.deepEqual((await service.getState()).jobs, []);
    for (const invalid of [{}, { scope: 'machine' }, { scope: 'project', path: '/tmp' }])
      assert.equal((await service.preview(invalid)).status, 400);
    const preview = await service.preview({ scope: 'project' });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.disclosure.externalRequests, false);
    assert.equal(preview.body.disclosure.readsHomeCredentialFiles, true);
    assert.equal(scans, 0);
    for (const invalid of [
      { previewId: preview.body.id },
      { previewId: preview.body.id, acknowledgeCredentialRead: false },
      { previewId: preview.body.id, acknowledgeCredentialRead: true, path: '/tmp' },
    ])
      assert.equal((await service.start(invalid)).status, 400);
    assert.equal(scans, 0);
  } finally {
    await service.close();
  }
});

test('previews expire and bind context and executable runtime, including one-use failure', async () => {
  let clock = Date.now();
  let digest = 'a';
  const service = await createSecretScanService({
    ...options,
    now: () => clock,
    fingerprint: async () => digest,
  });
  try {
    const expired = await service.preview({ scope: 'project' });
    clock += 120_001;
    assert.equal(
      (await service.start({ previewId: expired.body.id, acknowledgeCredentialRead: true })).body
        .error,
      'preview-expired',
    );
    const stale = await service.preview({ scope: 'last' });
    digest = 'b';
    assert.equal(
      (await service.start({ previewId: stale.body.id, acknowledgeCredentialRead: true })).body
        .error,
      'preview-stale',
    );
    assert.equal(
      (await service.start({ previewId: stale.body.id, acknowledgeCredentialRead: true })).body
        .error,
      'preview-missing',
    );
  } finally {
    await service.close();
  }
});

test('jobs are serialized, errors redact private process details, and cancellation waits for termination', async () => {
  let finish;
  const service = await createSecretScanService({
    ...options,
    run: (_input, { signal }) =>
      new Promise((_resolve, reject) => {
        finish = () => reject(new Error('CREDENTIAL_VALUE_SENTINEL /private/raw-transcript'));
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
  });
  try {
    const preview = await service.preview({ scope: 'last' });
    const job = await service.start({
      previewId: preview.body.id,
      acknowledgeCredentialRead: true,
    });
    assert.equal(job.status, 202);
    assert.equal((await service.preview({ scope: 'project' })).status, 409);
    finish();
    assert.equal((await wait(service, job.body.id)).error, 'scan-failed');
    assert.doesNotMatch(JSON.stringify(await service.getState()), /SENTINEL|raw-transcript/);
    const next = await service.preview({ scope: 'project' });
    const running = await service.start({
      previewId: next.body.id,
      acknowledgeCredentialRead: true,
    });
    assert.equal((await service.cancel({ jobId: running.body.id })).body.status, 'cancelled');
    assert.equal(service.getJob(running.body.id).result, undefined);
  } finally {
    await service.close();
  }
});

test('invalid scanner reports cannot enter job state', async () => {
  const service = await createSecretScanService({
    ...options,
    run: async () => ({ credential: 'SECRET_SENTINEL' }),
  });
  try {
    const preview = await service.preview({ scope: 'project' });
    const job = await service.start({
      previewId: preview.body.id,
      acknowledgeCredentialRead: true,
    });
    assert.equal((await wait(service, job.body.id)).error, 'invalid-report');
    assert.doesNotMatch(JSON.stringify(await service.getState()), /SECRET_SENTINEL/);
  } finally {
    await service.close();
  }
});
