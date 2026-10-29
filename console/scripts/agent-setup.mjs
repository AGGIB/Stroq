import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE_PATHS, REPOSITORY, engineAvailability } from './control-engine.mjs';
import { assertUnchanged, commitSetup, digest, rootIdentity } from './agent-setup-files.mjs';
import { runtimeDigest } from './agent-setup-cli.mjs';
import { withAgentConfigurationLock } from './agent-configuration-lock.mjs';
import { runtimeLayout } from './runtime-layout.mjs';
import {
  AGENTS,
  closed,
  completePlan,
  nextSteps,
  readSetupInputs,
  targetFor,
} from './agent-setup-plan.mjs';

const TTL = 300_000,
  MAX_PLANS = 8,
  MAX_MEMORY = 8 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const BACKUPS = '~/.stroq/backups/console-setup/';
const ERRORS = new Set([
  'unsafe-config',
  'invalid-config',
  'hooks-disabled',
  'invalid-install-record',
  'config-too-large',
  'merge-not-preserving',
  'invalid-engine-preview',
  'engine-unavailable',
  'preview-stale',
  'rollback-incomplete',
  'write-failed',
  'server-stopped',
  'agent-configuration-busy',
  'agent-configuration-unavailable',
]);
const errorResponse = (error) => {
  const code = ERRORS.has(error?.message) ? error.message : 'write-failed';
  return {
    status: ['preview-stale', 'agent-configuration-busy'].includes(code)
      ? 409
      : ['engine-unavailable', 'agent-configuration-unavailable', 'server-stopped'].includes(code)
        ? 503
        : 422,
    body: { error: code },
  };
};
const fail = (status, error) => ({ status, body: { error } });
const result = (body) => ({ status: 200, body: structuredClone(body) });
const safeName = (path) =>
  basename(path)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .slice(0, 80) || 'This workspace';
const decode = (bytes) => {
  try {
    return bytes === null
      ? null
      : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('invalid-config');
  }
};

/** The console adds current exact templates; unmatched registrations are never adopted or removed. */
export async function createAgentSetup(configuration = {}) {
  const userHome = resolve(configuration.userHome ?? homedir());
  const project = resolve(configuration.project ?? REPOSITORY);
  const environment = configuration.environment ?? process.env;
  const home = resolve(configuration.home ?? environment.STROQ_HOME ?? join(userHome, '.stroq'));
  const paths = configuration.paths ?? ENGINE_PATHS;
  const now = configuration.now ?? Date.now;
  const readRuntime = configuration.runtimeDigest ?? (() => runtimeDigest(paths));
  const currentRuntime = async () => {
    try {
      const value = await readRuntime();
      if (typeof value !== 'string' || !SHA.test(value)) throw new Error();
      return value;
    } catch {
      throw new Error('engine-unavailable');
    }
  };
  let reason = null,
    roots,
    engine = { available: false, version: null };
  try {
    roots = { userRoot: await rootIdentity(userHome), projectRoot: await rootIdentity(project) };
    if (home !== join(userHome, '.stroq')) reason = 'custom-home-unsupported';
    else if (process.platform === 'win32') reason = 'platform-unsupported';
    else if ([process.execPath, paths.cli].some((path) => /["$`\\\r\n]/.test(path)))
      reason = 'runtime-path-unsupported';
    else {
      engine = await engineAvailability(paths);
      if (!engine.available) reason = 'engine-unavailable';
    }
  } catch {
    reason = 'context-unavailable';
  }
  const selectedProject = roots?.projectRoot.path ?? project;
  const workspaceId = `workspace-${createHash('sha256').update(selectedProject).digest('hex').slice(0, 24)}`;
  if (configuration.workspaceId !== undefined && configuration.workspaceId !== workspaceId)
    throw new TypeError('workspace-mismatch');
  const options = {
    ...roots,
    paths,
    project: selectedProject,
    userHome: roots?.userRoot.path ?? userHome,
    home: roots ? join(roots.userRoot.path, '.stroq') : home,
  };
  const plans = new Map(),
    operations = new Set();
  let busy = false,
    stopped = false;
  const sweep = () => {
    for (const [id, plan] of plans) if (plan.expires <= now()) plans.delete(id);
  };
  const timer = setInterval(sweep, 30_000);
  timer.unref();
  const getState = () => {
    const unavailable = stopped ? 'engine-unavailable' : reason;
    return {
      schema: 'stroq-agent-setup/2',
      workspaceId,
      available: unavailable === null,
      ...(unavailable ? { reason: unavailable } : {}),
      context: { workspace: safeName(selectedProject), userScope: 'This user' },
      engineVersion: engine.version,
      agents: AGENTS.map((id) => ({
        id,
        scopes: ['project', 'user'],
        available: unavailable === null,
        ...(unavailable ? { reason: unavailable } : {}),
      })),
    };
  };
  async function modules(runtime) {
    try {
      const path = configuration.adapterPath ?? runtimeLayout().adapter('agent-status-engine.js');
      const s = await lstat(path);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 16 * 1024 * 1024)
        throw new Error();
      const url = pathToFileURL(path);
      url.searchParams.set('setupRuntime', runtime);
      const adapter = await import(url.href);
      const schema = await (
        configuration.loadSchema ??
        (() => import(pathToFileURL(runtimeLayout().adapter('local-api-schema.js')).href))
      )();
      if (
        !['prepareAgentSetup', 'parseSetupObject', 'expectedConfiguration'].every(
          (key) => typeof adapter[key] === 'function',
        ) ||
        !['validateSetupPreview', 'validateSetupResult'].every(
          (key) => typeof schema[key] === 'function',
        )
      )
        throw new Error();
      return { adapter, schema };
    } catch {
      throw new Error('engine-unavailable');
    }
  }
  async function recheck(plan) {
    if (stopped) throw new Error('server-stopped');
    if (plan.runtime !== (await currentRuntime())) throw new Error('preview-stale');
    try {
      await assertUnchanged(plan.config.root, plan.config.file, plan.config.before);
      await assertUnchanged(plan.record.root, plan.record.file, plan.record.before);
    } catch {
      throw new Error('preview-stale');
    }
  }
  async function preview(input) {
    if (
      !closed(input, ['agent', 'scope']) ||
      !AGENTS.includes(input.agent) ||
      !['project', 'user'].includes(input.scope)
    )
      return fail(400, 'invalid-request');
    if (stopped) return fail(503, 'server-stopped');
    if (reason) return fail(503, reason);
    if (busy) return fail(409, 'setup-busy');
    input = Object.freeze({ ...input });
    busy = true;
    try {
      const runtime = await currentRuntime();
      const { adapter, schema } = await modules(runtime);
      const files = await readSetupInputs(
        input.agent,
        input.scope,
        roots,
        adapter.parseSetupObject,
      );
      const command = `"${process.execPath}" "${paths.cli}" hook ${input.agent}`;
      const prepared = adapter.prepareAgentSetup(decode(files.before.bytes), input.agent, command);
      const created = now(),
        id = randomUUID(),
        expires = created + TTL;
      const plan = completePlan(
        files,
        prepared,
        input.agent,
        input.scope,
        {
          ...options,
          expected: adapter.expectedConfiguration(input.agent, command),
          parseSetupObject: adapter.parseSetupObject,
        },
        id,
        created,
      );
      const operation =
        files.before.bytes === null
          ? 'create'
          : digest(plan.config.next) === files.before.sha256
            ? 'unchanged'
            : 'update';
      const shared =
        input.scope === 'user' ||
        (roots.userRoot.dev === roots.projectRoot.dev &&
          roots.userRoot.ino === roots.projectRoot.ino);
      const scopeImpact = shared ? 'all-workspaces' : 'workspace';
      const retained =
        operation !== 'unchanged' &&
        (files.before.bytes !== null || files.recordBefore.bytes !== null);
      const body = {
        schema: 'stroq-agent-setup-preview/2',
        id,
        createdAt: new Date(created).toISOString(),
        expiresAt: new Date(expires).toISOString(),
        workspaceId,
        agent: input.agent,
        scope: input.scope,
        scopeImpact,
        context: shared ? 'This user' : getState().context.workspace,
        target: `${shared ? '~' : 'Workspace'}/${targetFor(input.agent, input.scope)}`,
        operation,
        sourceSha256: files.before.bytes === null ? null : files.before.sha256,
        candidateSha256: digest(plan.config.next),
        hookEvents: plan.hookEvents,
        addedHooks: plan.addedHooks,
        preservedHooks: plan.preservedHooks,
        replacedHooks: plan.replacedHooks,
        remainingLookalikes: plan.remainingLookalikes,
        needs: {
          acknowledgeSharedScope: operation !== 'unchanged' && shared,
          acknowledgeRetainedCopy: retained,
        },
        backup: {
          required: retained,
          label: BACKUPS,
          configExisted: files.before.bytes !== null,
          recordExisted: files.recordBefore.bytes !== null,
        },
        evidence: 'configuration',
        verified: false,
        requiresRestart: true,
        needsApproval: input.agent === 'codex',
        nextSteps: nextSteps(input.agent, input.scope),
      };
      if (!schema.validateSetupPreview(body)) throw new Error('invalid-engine-preview');
      await recheck({ ...plan, runtime });
      const memory = [
        plan.config.before.bytes,
        plan.config.next,
        plan.record.before.bytes,
        plan.record.next,
      ].reduce((sum, bytes) => sum + (bytes?.length ?? 0), 0);
      if (memory > MAX_MEMORY) throw new Error('config-too-large');
      sweep();
      const used = () => [...plans.values()].reduce((sum, item) => sum + item.memory, 0);
      while (plans.size >= MAX_PLANS || used() + memory > MAX_MEMORY)
        plans.delete(plans.keys().next().value);
      plans.set(id, { ...plan, runtime, expires, body, memory, schema });
      return result(body);
    } catch (error) {
      return errorResponse(error);
    } finally {
      busy = false;
    }
  }
  async function apply(input) {
    const keys = ['previewId', 'confirm', 'acknowledgeRetainedCopy', 'acknowledgeSharedScope'];
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !keys.includes(key)) ||
      !UUID.test(input.previewId) ||
      input.confirm !== true ||
      keys.slice(2).some((key) => Object.hasOwn(input, key) && typeof input[key] !== 'boolean')
    )
      return fail(400, 'invalid-request');
    if (stopped) return fail(503, 'server-stopped');
    if (reason) return fail(503, reason);
    if (busy) return fail(409, 'setup-busy');
    const plan = plans.get(input.previewId);
    if (!plan) return fail(409, 'preview-missing');
    if (plan.expires <= now()) {
      plans.delete(input.previewId);
      return fail(409, 'preview-expired');
    }
    if (Object.entries(plan.body.needs).some(([key, needed]) => needed && input[key] !== true))
      return fail(400, 'invalid-request');
    plans.delete(input.previewId);
    busy = true;
    try {
      await recheck(plan);
      const unchanged = plan.body.operation === 'unchanged';
      if (!unchanged)
        await withAgentConfigurationLock(
          { home: options.home, version: engine.version, runtime: plan.runtime },
          async () => {
            await recheck(plan);
            const written = await commitSetup(plan);
            await assertUnchanged(
              plan.config.root,
              plan.config.file,
              written?.config ?? { sha256: digest(plan.config.next) },
            );
            await assertUnchanged(
              plan.record.root,
              plan.record.file,
              written?.record ?? { sha256: digest(plan.record.next) },
            );
            if (plan.runtime !== (await currentRuntime())) throw new Error('preview-stale');
          },
        );
      const body = {
        schema: 'stroq-agent-setup-result/2',
        status:
          plan.remainingLookalikes > 0 ? 'review-required' : unchanged ? 'unchanged' : 'configured',
        previewId: plan.id,
        workspaceId,
        agent: plan.agent,
        scope: plan.scope,
        scopeImpact: plan.body.scopeImpact,
        target: plan.body.target,
        context: plan.body.context,
        operation: plan.body.operation,
        configuredAt: new Date(now()).toISOString(),
        sourceSha256: plan.body.sourceSha256,
        candidateSha256: plan.body.candidateSha256,
        addedHooks: plan.addedHooks,
        preservedHooks: plan.preservedHooks,
        replacedHooks: plan.replacedHooks,
        remainingLookalikes: plan.remainingLookalikes,
        currentExactHooks: plan.hookEvents.length,
        backupId: unchanged ? null : plan.id,
        backup: {
          complete: !unchanged,
          label: unchanged ? null : `${BACKUPS}${plan.id}.manifest.json`,
          configExisted: plan.body.backup.configExisted,
          recordExisted: plan.body.backup.recordExisted,
        },
        evidence: 'configuration',
        verified: false,
        requiresRestart: true,
        needsApproval: plan.agent === 'codex',
        nextSteps: plan.body.nextSteps,
      };
      if (!plan.schema.validateSetupResult(body)) throw new Error('invalid-engine-preview');
      return result(body);
    } catch (error) {
      return errorResponse(error);
    } finally {
      busy = false;
    }
  }
  const track = (operation, input) => {
    const pending = operation(input);
    operations.add(pending);
    void pending.then(
      () => operations.delete(pending),
      () => operations.delete(pending),
    );
    return pending;
  };
  return {
    getState,
    preview: (input) => track(preview, input),
    apply: (input) => track(apply, input),
    async close() {
      stopped = true;
      clearInterval(timer);
      plans.clear();
      await Promise.allSettled([...operations]);
    },
  };
}
