import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE_PATHS, REPOSITORY, engineAvailability } from './control-engine.mjs';
import { runtimeDigest } from './agent-setup-cli.mjs';
import { targetFor } from './agent-setup-plan.mjs';
import { withAgentConfigurationLock } from './agent-configuration-lock.mjs';
import { runtimeLayout } from './runtime-layout.mjs';

const AGENTS = ['claude-code', 'cursor', 'codex'];
const TTL = 300_000,
  MAX_CONFIG = 1024 * 1024,
  MAX_PLANS = 8,
  MAX_MEMORY = 8 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const fail = (code) => {
  throw new Error(`agent-disconnect-${code}`);
};
const hash = (bytes) => (bytes === null ? null : createHash('sha256').update(bytes).digest('hex'));
const owned = (s) => typeof process.getuid !== 'function' || s.uid === process.getuid();
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const identity = (s) => ({ dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode });
const fileIdentity = (s) => ({
  ...identity(s),
  nlink: s.nlink,
  size: s.size,
  mtimeMs: s.mtimeMs,
  ctimeMs: s.ctimeMs,
});
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const closed = (v, keys) =>
  object(v) && Reflect.ownKeys(v).every((key) => typeof key === 'string' && keys.includes(key));
const statusCodes = new Map([
  ['invalid-request', 400],
  ['agent-disconnect-busy', 409],
  ['agent-disconnect-preview-missing', 409],
  ['agent-disconnect-preview-expired', 409],
  ['agent-disconnect-preview-stale', 409],
  ['agent-disconnect-no-changes', 422],
  ['agent-disconnect-unsafe-config', 422],
  ['agent-disconnect-invalid-config', 422],
  ['agent-disconnect-config-too-large', 422],
  ['agent-disconnect-backup-full', 422],
  ['agent-disconnect-backup-unavailable', 422],
  ['agent-disconnect-write-failed', 422],
  ['agent-disconnect-engine-unavailable', 503],
  ['agent-disconnect-server-stopped', 503],
  ['agent-configuration-busy', 409],
  ['agent-configuration-unavailable', 503],
]);
const responseError = (error) => ({
  status: statusCodes.get(error?.message) ?? 422,
  body: {
    error: statusCodes.has(error?.message) ? error.message : 'agent-disconnect-write-failed',
  },
});
const result = (body) => ({ status: 200, body: structuredClone(body) });

async function rootFor(path) {
  const canonical = await realpath(path),
    s = await lstat(canonical);
  if (!s.isDirectory() || !owned(s) || (s.mode & 0o022) !== 0) fail('unsafe-config');
  return { path: canonical, ...identity(s) };
}
async function inspect(root, file) {
  const rel = relative(root.path, file);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) fail('unsafe-config');
  const base = await lstat(root.path);
  if (
    !base.isDirectory() ||
    base.isSymbolicLink() ||
    !equal(identity(base), identity(root)) ||
    (await realpath(root.path)) !== root.path
  )
    fail('unsafe-config');
  const directories = [{ path: root.path, ...identity(base) }];
  let at = root.path;
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i += 1) {
    at = join(at, parts[i]);
    let s;
    try {
      s = await lstat(at);
    } catch (error) {
      if (error.code === 'ENOENT') return { directories, file: null };
      throw error;
    }
    if (!owned(s) || s.isSymbolicLink() || (s.mode & 0o022) !== 0) fail('unsafe-config');
    if (i === parts.length - 1) {
      if (!s.isFile() || s.nlink !== 1) fail('unsafe-config');
      return { directories, file: fileIdentity(s) };
    }
    if (!s.isDirectory()) fail('unsafe-config');
    directories.push({ path: at, ...identity(s) });
  }
  fail('unsafe-config');
}
async function capture(root, file, max = MAX_CONFIG) {
  const before = await inspect(root, file);
  if (before.file === null) {
    if (!equal(before, await inspect(root, file))) fail('preview-stale');
    return { root, path: file, ...before, bytes: null, sha256: null };
  }
  if (before.file.size > max) fail('config-too-large');
  let handle;
  try {
    handle = await open(file, flags);
    const s = await handle.stat();
    if (!equal(fileIdentity(s), before.file)) fail('preview-stale');
    const bytes = Buffer.alloc(s.size);
    let filled = 0;
    while (filled < bytes.length) {
      const read = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (!read.bytesRead) break;
      filled += read.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    if (
      filled !== bytes.length ||
      extra.bytesRead ||
      !equal(fileIdentity(await handle.stat()), before.file) ||
      !equal(before, await inspect(root, file))
    )
      fail('preview-stale');
    return { root, path: file, ...before, bytes, sha256: hash(bytes) };
  } finally {
    await handle?.close();
  }
}
async function unchanged(before) {
  const current = await capture(before.root, before.path).catch(() => fail('preview-stale'));
  if (
    current.sha256 !== before.sha256 ||
    !equal(current.file, before.file) ||
    !equal(current.directories, before.directories)
  )
    fail('preview-stale');
  return current;
}
const decode = (bytes) => {
  try {
    return bytes === null
      ? null
      : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('invalid-config');
  }
};

async function privateDirectory(root, parts, create = true) {
  let at = root.path;
  const pinned = [{ path: root.path, ...identity(await lstat(root.path)) }];
  if (!equal(identity(pinned[0]), identity(root))) fail('backup-unavailable');
  for (const part of parts) {
    const parent = pinned.at(-1);
    if (!same(parent, await lstat(parent.path))) fail('backup-unavailable');
    at = join(at, part);
    if (create) {
      try {
        await mkdir(at, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const s = await lstat(at).catch(() => fail('backup-unavailable'));
    if (!s.isDirectory() || s.isSymbolicLink() || !owned(s) || (s.mode & 0o777) !== 0o700)
      fail('backup-unavailable');
    pinned.push({ path: at, ...identity(s) });
  }
  const check = async () => {
    if ((await realpath(at)) !== at) fail('backup-unavailable');
    for (const p of pinned)
      if (!equal(identity(await lstat(p.path)), identity(p))) fail('backup-unavailable');
  };
  await check();
  return { path: at, check };
}
async function exclusiveFile(root, file, bytes, check) {
  await check();
  let handle;
  try {
    handle = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await check();
  const read = await capture(root, file);
  if (read.bytes === null || !read.bytes.equals(bytes) || (read.file.mode & 0o777) !== 0o600)
    fail('backup-unavailable');
}
async function boundedNames(path, limit, code) {
  const directory = await opendir(path),
    names = [];
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) return names;
      if (names.length >= limit) fail(code);
      names.push(entry.name);
    }
  } finally {
    await directory.close();
  }
}
async function syncDirectory(path, expected) {
  const handle = await open(path, flags);
  try {
    if (!equal(identity(await handle.stat()), identity(expected))) fail('write-failed');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    await handle.close();
  }
}
async function backup(plan, userRoot, receiptId, completedAt, fault) {
  const vault = await privateDirectory(userRoot, ['.stroq', 'backups', 'console-disconnect']);
  const entries = await boundedNames(vault.path, 32, 'backup-full');
  if (entries.length >= 32) fail('backup-full');
  for (const name of entries) {
    if (!UUID.test(name)) fail('backup-unavailable');
    await fault('before-backup-record-inspect');
    const directory = await privateDirectory(
      userRoot,
      ['.stroq', 'backups', 'console-disconnect', name],
      false,
    );
    const names = await boundedNames(directory.path, 2, 'backup-unavailable');
    if (
      names.length > 2 ||
      names.some((value) => !['before.json', 'manifest.json'].includes(value))
    )
      fail('backup-unavailable');
    for (const value of names) {
      const s = await lstat(join(directory.path, value));
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        s.nlink !== 1 ||
        !owned(s) ||
        (s.mode & 0o777) !== 0o600 ||
        s.size > MAX_CONFIG
      )
        fail('backup-unavailable');
    }
    await directory.check();
  }
  await vault.check();
  const directory = join(vault.path, receiptId);
  await mkdir(directory, { mode: 0o700 });
  const pinned = identity(await lstat(directory));
  const check = async () => {
    await vault.check();
    if (!equal(identity(await lstat(directory)), pinned)) fail('backup-unavailable');
  };
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 'stroq-agent-disconnect-backup/1',
      receiptId,
      createdAt: completedAt,
      agent: plan.body.agent,
      scope: plan.body.scope,
      workspaceId: plan.body.workspaceId,
      targetBinding: hash(
        Buffer.from(
          `${plan.source.root.path}\0${plan.source.root.dev}\0${plan.source.root.ino}\0${plan.source.path}`,
        ),
      ),
      sourceSha256: plan.body.sourceSha256,
      candidateSha256: plan.body.candidateSha256,
      mode: plan.source.file.mode & 0o777,
      bytes: plan.source.bytes.length,
    }) + '\n',
  );
  await exclusiveFile(userRoot, join(directory, 'before.json'), plan.source.bytes, check);
  await exclusiveFile(userRoot, join(directory, 'manifest.json'), manifest, check);
  await syncDirectory(directory, pinned);
  await syncDirectory(vault.path, await lstat(vault.path));
  await check();
}
async function writeCandidate(plan, fault) {
  await unchanged(plan.source);
  const parent = plan.source.directories.at(-1);
  const temporary = join(dirname(plan.source.path), `.stroq-disconnect-${randomUUID()}.tmp`);
  let handle,
    staged = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    staged = true;
    await handle.writeFile(plan.candidate);
    await handle.chmod(plan.source.file.mode & 0o777);
    await handle.sync();
    await handle.close();
    handle = null;
    await unchanged(plan.source);
    if (!equal(identity(await lstat(parent.path)), identity(parent))) fail('preview-stale');
    await rename(temporary, plan.source.path);
    staged = false;
    await fault('after-rename');
    await syncDirectory(parent.path, parent);
    const readback = await capture(plan.source.root, plan.source.path);
    if (
      !equal(readback.directories, plan.source.directories) ||
      readback.bytes === null ||
      !readback.bytes.equals(plan.candidate) ||
      (readback.file.mode & 0o777) !== (plan.source.file.mode & 0o777)
    )
      fail('write-failed');
    return readback;
  } finally {
    await handle?.close();
    if (staged) {
      try {
        if (equal(identity(await lstat(parent.path)), identity(parent))) await unlink(temporary);
      } catch {
        /* Refuse foreign cleanup. */
      }
    }
  }
}

/** Explicit scoped configuration removal. Neither installation records nor host processes are changed. */
export async function createAgentDisconnect(configuration = {}) {
  const paths = configuration.paths ?? ENGINE_PATHS;
  const workspaceId = configuration.workspaceId;
  if (typeof workspaceId !== 'string' || !/^workspace-[a-f0-9]{24}$/.test(workspaceId))
    throw new TypeError('workspace-required');
  const askedUser = resolve(configuration.userHome ?? homedir()),
    askedProject = resolve(configuration.project ?? REPOSITORY);
  const environment = configuration.environment ?? process.env;
  const askedHome = resolve(
    configuration.home ?? environment.STROQ_HOME ?? join(askedUser, '.stroq'),
  );
  const now = configuration.now ?? Date.now;
  const runtimeReader = configuration.runtimeDigest ?? (() => runtimeDigest(paths));
  const currentRuntime = async () => {
    try {
      const value = await runtimeReader();
      if (typeof value !== 'string' || !SHA.test(value)) fail('engine-unavailable');
      return value;
    } catch {
      fail('engine-unavailable');
    }
  };
  const lock = configuration.withConfigurationLock ?? withAgentConfigurationLock;
  const fault = configuration.fault ?? (async () => {});
  let roots,
    reason = null,
    engine = { available: false, version: null };
  try {
    roots = { user: await rootFor(askedUser), project: await rootFor(askedProject) };
    if (askedHome !== join(askedUser, '.stroq')) reason = 'custom-home-unsupported';
    else if (process.platform === 'win32') reason = 'platform-unsupported';
    else if ([process.execPath, paths.cli].some((path) => /["$`\\\r\n]/.test(path)))
      reason = 'runtime-path-unsupported';
    else {
      engine = await (configuration.engineAvailability ?? engineAvailability)(paths);
      if (!engine.available) reason = 'engine-unavailable';
    }
  } catch {
    reason = 'context-unavailable';
  }
  const home = roots ? join(roots.user.path, '.stroq') : askedHome;
  const plans = new Map();
  let active = null,
    stopped = false;
  const sweep = () => {
    for (const [id, plan] of plans) if (plan.expires <= now()) plans.delete(id);
  };
  const timer = setInterval(sweep, 30_000);
  timer.unref();
  const openService = () => {
    if (stopped) fail('server-stopped');
    if (reason) fail('engine-unavailable');
  };
  const timestamp = (at) => {
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) fail('engine-unavailable');
    return date.toISOString();
  };
  async function modules(runtime) {
    try {
      const path = configuration.adapterPath ?? runtimeLayout().adapter('agent-status-engine.js');
      const s = await lstat(path);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 16 * 1024 * 1024)
        fail('engine-unavailable');
      const url = pathToFileURL(path);
      url.searchParams.set('disconnectRuntime', runtime);
      const adapter = await import(url.href);
      const schema = await (
        configuration.loadSchema ??
        (() => import(pathToFileURL(runtimeLayout().adapter('local-api-schema.js')).href))
      )();
      if (
        typeof adapter.prepareAgentDisconnect !== 'function' ||
        !['validateAgentDisconnectPreview', 'validateAgentDisconnectReceipt'].every(
          (name) => typeof schema[name] === 'function',
        )
      )
        fail('engine-unavailable');
      return { adapter, schema };
    } catch {
      fail('engine-unavailable');
    }
  }
  function exclusive(action) {
    if (active) return Promise.resolve(responseError(new Error('agent-disconnect-busy')));
    active = Promise.resolve()
      .then(() => {
        openService();
        return action();
      })
      .catch((error) => {
        if (['invalid-config', 'config-too-large'].includes(error?.message))
          return responseError(new Error(`agent-disconnect-${error.message}`));
        return responseError(error);
      })
      .finally(() => {
        active = null;
      });
    return active;
  }
  const getState = () => ({
    schema: 'stroq-agent-disconnect/1',
    workspaceId,
    available: reason === null && !stopped,
    reason: stopped ? 'engine-unavailable' : reason,
    hostEnforcement: false,
  });
  return {
    getState,
    preview(input) {
      if (
        !closed(input, ['agent', 'scope']) ||
        Object.keys(input).length !== 2 ||
        !AGENTS.includes(input.agent) ||
        !['project', 'user'].includes(input.scope)
      )
        return Promise.resolve(responseError(new Error('invalid-request')));
      input = Object.freeze({ ...input });
      return exclusive(async () => {
        const runtime = await currentRuntime();
        if (!SHA.test(runtime)) fail('engine-unavailable');
        const { adapter, schema } = await modules(runtime);
        const root = roots[input.scope];
        const source = await capture(root, join(root.path, targetFor(input.agent, input.scope)));
        const command = `"${process.execPath}" "${paths.cli}" hook ${input.agent}`;
        const prepared = adapter.prepareAgentDisconnect(decode(source.bytes), input.agent, command);
        const candidate =
          prepared.candidateText === null ? null : Buffer.from(prepared.candidateText, 'utf8');
        if (candidate?.length > MAX_CONFIG) fail('config-too-large');
        const scopeImpact =
          input.scope === 'user' || same(roots.user, roots.project)
            ? 'all-workspaces'
            : 'workspace';
        const created = now(),
          changed = prepared.removedHooks > 0;
        const body = {
          schema: 'stroq-agent-disconnect-preview/1',
          previewId: randomUUID(),
          createdAt: timestamp(created),
          expiresAt: timestamp(created + TTL),
          workspaceId,
          ...input,
          scopeImpact,
          target: schema.disconnectTarget(input.agent, input.scope, scopeImpact),
          operation: changed ? 'remove-hooks' : 'unchanged',
          sourceSha256: source.sha256,
          candidateSha256: hash(candidate),
          removedHooks: prepared.removedHooks,
          preservedHooks: prepared.preservedHooks,
          remainingLookalikes: prepared.remainingLookalikes,
          events: prepared.events,
          needs: {
            acknowledgeWeakenProtection: changed,
            acknowledgeRetainedCopy: changed,
            acknowledgeSharedScope: changed && scopeImpact === 'all-workspaces',
          },
          backup: { required: changed, label: schema.DISCONNECT_BACKUP_ROOT },
          evidence: 'configuration',
          hostEnforcement: false,
          requiresNewSession: true,
          limitations: [...schema.DISCONNECT_LIMITATIONS],
        };
        if (!schema.validateAgentDisconnectPreview(body)) fail('engine-unavailable');
        await unchanged(source);
        if (runtime !== (await currentRuntime())) fail('preview-stale');
        openService();
        sweep();
        const bytes = (source.bytes?.length ?? 0) + (candidate?.length ?? 0);
        while (
          plans.size &&
          (plans.size >= MAX_PLANS ||
            [...plans.values()].reduce((sum, p) => sum + p.bytes, 0) + bytes > MAX_MEMORY)
        )
          plans.delete(plans.keys().next().value);
        if (bytes > MAX_MEMORY) fail('config-too-large');
        plans.set(body.previewId, {
          source,
          command,
          candidate,
          runtime,
          body,
          expires: created + TTL,
          bytes,
        });
        return result(body);
      });
    },
    apply(input) {
      if (
        !closed(input, [
          'previewId',
          'acknowledgeWeakenProtection',
          'acknowledgeRetainedCopy',
          'acknowledgeSharedScope',
        ]) ||
        typeof input.previewId !== 'string' ||
        !UUID.test(input.previewId) ||
        typeof input.acknowledgeWeakenProtection !== 'boolean' ||
        typeof input.acknowledgeRetainedCopy !== 'boolean' ||
        (input.acknowledgeSharedScope !== undefined &&
          typeof input.acknowledgeSharedScope !== 'boolean')
      )
        return Promise.resolve(responseError(new Error('invalid-request')));
      const plan = plans.get(input.previewId);
      if (!plan)
        return Promise.resolve(responseError(new Error('agent-disconnect-preview-missing')));
      for (const [name, needed] of Object.entries(plan.body.needs))
        if (needed && input[name] !== true)
          return Promise.resolve(responseError(new Error('invalid-request')));
      return exclusive(async () => {
        plans.delete(input.previewId);
        if (plan.expires <= now()) fail('preview-expired');
        if (plan.body.operation === 'unchanged') fail('no-changes');
        if (!plan.source.file || !(plan.source.file.mode & 0o200)) fail('unsafe-config');
        return lock({ home, version: engine.version, runtime: plan.runtime }, async () => {
          if (plan.runtime !== (await currentRuntime())) fail('preview-stale');
          const { adapter, schema } = await modules(plan.runtime);
          await unchanged(plan.source);
          openService();
          const receiptId = randomUUID(),
            completedAt = timestamp(now());
          await backup(plan, roots.user, receiptId, completedAt, fault);
          await fault('after-backup');
          await unchanged(plan.source);
          if (plan.runtime !== (await currentRuntime())) fail('preview-stale');
          const readback = await writeCandidate(plan, fault);
          const verified = adapter.prepareAgentDisconnect(
            decode(readback.bytes),
            plan.body.agent,
            plan.command,
          );
          if (verified.removedHooks !== 0) fail('write-failed');
          const body = {
            schema: 'stroq-agent-disconnect-receipt/1',
            status: 'removed',
            receiptId,
            previewId: plan.body.previewId,
            completedAt,
            workspaceId,
            agent: plan.body.agent,
            scope: plan.body.scope,
            scopeImpact: plan.body.scopeImpact,
            target: plan.body.target,
            sourceSha256: plan.body.sourceSha256,
            candidateSha256: plan.body.candidateSha256,
            removedHooks: plan.body.removedHooks,
            preservedHooks: verified.preservedHooks,
            remainingLookalikes: verified.remainingLookalikes,
            backupId: receiptId,
            currentExactHooks: 0,
            evidence: 'configuration',
            hostEnforcement: false,
            requiresNewSession: true,
          };
          if (!schema.validateAgentDisconnectReceipt(body)) fail('write-failed');
          plans.clear();
          return result(body);
        });
      });
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      plans.clear();
      await active;
    },
  };
}
