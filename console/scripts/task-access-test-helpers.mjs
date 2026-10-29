import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { createTaskAccessService } from './task-access-service.mjs';
import { createIncidentService } from './incidents.mjs';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export async function buildAccessFixture() {
  const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-access-build-')));
  await writeFile(
    join(output, 'core.ts'),
    `export * from '${repository}/packages/core/src/index.ts';export {policySha256} from '${repository}/packages/cli/src/policy/digest.ts';export {withManifestLock} from '${repository}/packages/cli/src/harden/manifest.ts';`,
  );
  await writeFile(
    join(output, 'schema.ts'),
    `export * from '${repository}/console/lib/task-locks.ts';export * from '${repository}/console/lib/task-access.ts';`,
  );
  await build({
    entry: {
      worker: join(repository, 'console/scripts/task-lock-worker.ts'),
      core: join(output, 'core.ts'),
      schema: join(output, 'schema.ts'),
    },
    outDir: output,
    outExtension: () => ({ js: '.mjs' }),
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    splitting: false,
    config: false,
    dts: false,
    silent: true,
    noExternal: ['@stroq/core', 'yaml', 'zod'],
    banner: {
      js: "import {createRequire as createAccessFixtureRequire} from 'node:module';const require=createAccessFixtureRequire(import.meta.url);",
    },
    esbuildOptions(options) {
      options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
    },
  });
  return {
    output,
    core: await import(pathToFileURL(join(output, 'core.mjs')).href),
    schema: await import(pathToFileURL(join(output, 'schema.mjs')).href),
    engine: await import(pathToFileURL(join(output, 'worker.mjs')).href),
  };
}

export async function accessFixture(t, built, extra = {}) {
  const { core } = built;
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-access-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project, { mode: 0o700 });
  await mkdir(join(home, 'keys'), { recursive: true, mode: 0o700 });
  const pair = core.generateKeyPair();
  const privatePath = join(home, 'keys/permit.key'),
    publicPath = join(home, 'keys/permit.pub');
  await writeFile(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  await writeFile(publicPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), {
    mode: 0o644,
  });
  let clock = Date.parse('2026-10-24T12:00:00.000Z'),
    runtime = 'a'.repeat(64);
  const policy = extra.policy ?? core.DEFAULT_POLICY;
  if (extra.policy)
    await writeFile(join(home, 'policy.yaml'), JSON.stringify(policy), { mode: 0o600 });
  const body = {
    v: 1,
    taskId: 'private-task-access',
    nonce: 'private-nonce-for-access-0123456789',
    host: 'claude-code',
    profile: 'repo-edit-and-test',
    mode: 'srt',
    projectRoot: project,
    sessionId: 'private-access-session',
    issuedAt: '2026-10-24T11:50:00.000Z',
    expiresAt: '2026-10-24T12:30:00.000Z',
    policyDigest: core.policySha256(policy),
    stateDigests: {},
    screenDigest: 'b'.repeat(64),
    scope: {
      tools: ['Read', 'Write', 'Bash', 'Grep', 'mcp__notes__lookup'],
      read: { allow: [project + '/**'], deny: [] },
      write: { allow: [project + '/**'], deny: [] },
      net: { mode: 'none' },
      shell: 'denied',
      mcp: [],
    },
    ...extra.body,
  };
  const store = new core.FilePermitStore({ home });
  store.writePermit(body.taskId, JSON.stringify(core.signPermit(body, pair.privateKey)));
  const sourcePath = join(home, 'tasks', body.taskId, 'permit.json'),
    journalPath = join(home, 'audit.jsonl');
  const gate = core.createScopeGate({
    taskId: body.taskId,
    store,
    keys: new core.FileKeyStore({ home }),
    context: () => ({
      nonce: body.nonce,
      projectRoot: project,
      policyDigest: body.policyDigest,
      stateDigests: body.stateDigests,
    }),
    now: () => new Date(clock),
    paths: { flavor: 'posix', foldCase: false },
  });
  const audit = new core.AuditLog(journalPath, () => new Date(clock));
  const stroq = new core.StroqEngine({
    rules: [],
    policy,
    audit,
    scope: gate,
    sessions: new core.FileSessionStore(join(home, 'sessions'), () => new Date(clock)),
    now: () => new Date(clock),
    taskAccessSigner: (request) => core.signTaskAccessRequest(request, pair.privateKey),
  });
  const event = {
    sessionId: body.sessionId,
    callId: 'initial-refusal',
    toolName: 'Read',
    toolInput: { file_path: join(base, 'outside.txt') },
    cwd: project,
    ...extra.event,
  };
  await writeFile(join(base, 'outside.txt'), 'inert fixture\n');
  const identity = async (path) => {
    const info = await lstat(path);
    return { path, dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode };
  };
  const workspaceId = `workspace-${hash(project).slice(0, 24)}`;
  const options = {
    project,
    userHome,
    home,
    workspaceId,
    runtimeSha256: runtime,
    engineVersion: '0.28.0',
    platform: process.platform,
    now: new Date(clock).toISOString(),
    deadline: Date.now() + 25000,
    rootBindings: { project: await identity(project), user: await identity(userHome) },
  };
  async function refuse(eventOverride = {}) {
    const result = await stroq.pre({ ...event, ...eventOverride });
    const raw = (await readFile(journalPath, 'utf8')).trimEnd().split('\n').at(-1),
      row = JSON.parse(raw);
    const sha = hash(raw);
    return {
      result,
      row,
      raw,
      input: {
        id: 'incident-' + sha,
        expectedEvidenceSha: sha,
        sequence: row.seq,
        recordedAt: row.ts,
      },
    };
  }
  const incidents = createIncidentService({ home, now: () => new Date(clock) });
  t.after(() => incidents.close());
  async function service(overrides = {}) {
    const value = await createTaskAccessService({
      project,
      userHome,
      home,
      workerPath: join(built.output, 'worker.mjs'),
      available: async () => ({ available: true, version: '0.28.0' }),
      runtimeDigest: async () => runtime,
      loadValidator: async () => built.schema,
      now: () => clock,
      selectEvidence: (request) => incidents.selectForComparison(request),
      withLock: (bound, action, lockOptions) =>
        core.withManifestLock(
          { home: bound.home, version: bound.version, now: () => new Date(clock) },
          action,
          lockOptions,
        ),
      ...overrides,
    });
    t.after(() => value.close());
    return value;
  }
  const run = (operation, input, hooks = {}) =>
    built.engine.runTaskLockWorker(
      {
        operation,
        input,
        options: {
          ...options,
          now: new Date(clock).toISOString(),
          configurationLockHeld: operation === 'access-issue',
        },
      },
      hooks,
    );
  return {
    base,
    project,
    userHome,
    home,
    body,
    pair,
    event,
    stroq,
    gate,
    store,
    audit,
    journalPath,
    sourcePath,
    privatePath,
    publicPath,
    options,
    workspaceId,
    refuse,
    run,
    service,
    incidents,
    setRuntime(value) {
      runtime = value;
    },
    advance(ms) {
      clock += ms;
    },
    time() {
      return clock;
    },
  };
}
