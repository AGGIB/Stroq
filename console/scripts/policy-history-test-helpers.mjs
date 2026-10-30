import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'tsup';
import { createPolicyHistoryService } from './policy-history-service.mjs';
export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function buildPolicyHistoryFixture() {
  const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-policy-history-build-')));
  await writeFile(
    join(output, 'schema.ts'),
    `export * from '${repository}/console/lib/policy-history.ts';export * from '${repository}/console/lib/policy-cases.ts';export {parseStrictJson as parsePolicyHistoryJson} from '${repository}/packages/core/src/scope/strict-json.ts';export {DEFAULT_POLICY} from '${repository}/packages/core/src/index.ts';`,
  );
  await build({
    entry: {
      worker: join(repository, 'console/scripts/policy-engine-entry.ts'),
      schema: join(output, 'schema.ts'),
    },
    outDir: output,
    outExtension: () => ({ js: '.mjs' }),
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    config: false,
    dts: false,
    splitting: false,
    silent: true,
    noExternal: ['@stroq/core', 'yaml', 'zod'],
    banner: {
      js: "import {createRequire as createFixtureRequire} from 'node:module';const require=createFixtureRequire(import.meta.url);",
    },
    esbuildOptions(o) {
      o.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
    },
  });
  await copyFile(
    join(repository, 'packages/cli/src/attack/scenarios/corpus.json'),
    join(output, 'corpus.json'),
  );
  for (const name of ['atlas', 'scope', 'asi'])
    await copyFile(
      join(repository, `packages/cli/src/coverage/${name}.json`),
      join(output, `${name}.json`),
    );
  const schema = await import(pathToFileURL(join(output, 'schema.mjs')).href);
  const adapter = (operation, text, changes, { cases = [], caseRevision = null, signal } = {}) =>
    new Promise((resolve, reject) => {
      const worker = new Worker(join(output, 'worker.mjs'), {
        workerData: { operation, text, changes, cases, caseRevision },
        env: {},
        execArgv: [],
      });
      let settled = false;
      const timer = setTimeout(() => done(new Error('deadline-exceeded')), 75000);
      const abort = () => done(new Error('engine-unavailable'));
      async function done(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        await worker.terminate();
        if (error) reject(error);
        else resolve(value);
      }
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      worker.on('message', (m) => done(m.ok === true ? null : new Error(m.error), m.value));
      worker.once('error', () => done(new Error('engine-failed')));
      worker.once('exit', () => done(new Error('engine-failed')));
    });
  return { output, schema, adapter };
}
export async function policyHistoryFixture(t, built, extra = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-policy-recovery-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  await mkdir(home, { mode: 0o700 });
  let runtime = 'a'.repeat(64);
  const old = Buffer.from(
    '\uFEFF# private-policy-comment\r\n' +
      JSON.stringify(built.schema.DEFAULT_POLICY, null, 2).replaceAll('\n', '\r\n') +
      '\r\n',
  );
  const policy = { ...built.schema.DEFAULT_POLICY, default: 'ask' };
  const current = Buffer.from(JSON.stringify(policy, null, 2) + '\n');
  const id = randomUUID(),
    store = join(home, 'backups', 'console-policy');
  await mkdir(store, { recursive: true, mode: 0o700 });
  const record = {
    schema: 'stroq-policy-write/1',
    receiptId: id,
    appliedAt: '2026-10-24T00:00:00.000Z',
    beforeRawSha: hash(old),
    afterRawSha: hash(current),
    policyFingerprint: 'b'.repeat(64),
    backupId: id,
  };
  await writeFile(join(store, `${id}.yaml`), old, { mode: 0o600 });
  await writeFile(join(store, `${id}.json`), JSON.stringify(record), { mode: 0o600 });
  await writeFile(join(home, 'policy.yaml'), current, { mode: 0o640 });
  const options = {
    home,
    adapter: built.adapter,
    loadSchema: async () => built.schema,
    runtimeDigest: async () => runtime,
    ...extra,
  };
  const service = createPolicyHistoryService(options);
  t.after(() => service.close());
  return {
    base,
    home,
    store,
    id,
    old,
    current,
    record,
    service,
    options,
    setRuntime: (value) => {
      runtime = value;
    },
  };
}
export const restoreInput = (preview) => ({
  previewId: preview.previewId,
  entryId: preview.entryId,
  recordSha256: preview.recordSha256,
  expectedRawSha: preview.expectedRawSha,
  candidateFingerprint: preview.candidateFingerprint,
  acknowledgeSharedScope: true,
  acknowledgeReducedProtection: true,
  acknowledgeBackup: true,
  acknowledgeInterruptions: true,
});
export async function restorePreview(f) {
  const state = await f.service.inspect();
  if (state.status !== 200) throw new Error(JSON.stringify(state));
  const row = state.body.entries.find((e) => e.id === f.id);
  const p = await f.service.preview({
    entryId: row.id,
    recordSha256: row.recordSha256,
    expectedRawSha: state.body.currentRawSha,
  });
  if (p.status !== 200) throw new Error(JSON.stringify(p));
  return p.body;
}
