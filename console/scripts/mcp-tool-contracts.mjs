import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeLayout } from './runtime-layout.mjs';
import { ENGINE_PATHS } from './control-engine.mjs';
import { runtimeDigest as hashRuntime } from './agent-setup-cli.mjs';
import { prepareApplyLock } from './mcp-containment-files.mjs';

const layout = runtimeLayout();
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v, prefix) => typeof v === 'string' && new RegExp(`^${prefix}-[a-f0-9]{64}$`).test(v);
const exact = (v, keys) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const targetKeys = [
  'action',
  'bindingId',
  'expectedRevision',
  'expectedCaptureSha256',
  'toolId',
  'expectedContractSha256',
];
const target = (v) =>
  exact(v, targetKeys) &&
  ['approve', 'revoke'].includes(v.action) &&
  id(v.bindingId, 'binding') &&
  id(v.toolId, 'tool') &&
  hash(v.expectedRevision) &&
  hash(v.expectedCaptureSha256) &&
  hash(v.expectedContractSha256);
const fail = (error) => ({
  status:
    error === 'tool-contract-invalid'
      ? 400
      : ['tool-contract-stale', 'tool-contract-lock-timeout'].includes(error)
        ? 409
        : error === 'tool-contract-write-unconfirmed'
          ? 422
          : 503,
  body: { error },
});
const known = new Set([
  'tool-contract-invalid',
  'tool-contract-limit',
  'tool-contract-unsupported',
  'tool-contract-unavailable',
  'tool-contract-stale',
  'tool-contract-write-unconfirmed',
  'tool-contract-lock-timeout',
]);

/** Browser arguments contain only exact opaque selectors; all filesystem/runtime roots are server-owned. */
export function createMcpToolContractService({
  project = layout.repository,
  userHome = homedir(),
  home = join(userHome, '.stroq'),
  paths = ENGINE_PATHS,
  platform = process.platform,
  mcpEnvironment = {},
  now = Date.now,
  runtimeDigest = () => hashRuntime(paths),
  loadEngine = async () => {
    const file = layout.adapter('mcp-containment-worker.js'),
      stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
      throw new Error('tool-contract-unavailable');
    return import(pathToFileURL(file).href);
  },
  loadSchema = () => import(pathToFileURL(layout.adapter('mcp-containment-schema.js')).href),
} = {}) {
  const options = {
    project: resolve(project),
    userHome: resolve(userHome),
    home: resolve(home),
    cli: paths.cli,
    platform,
    mcpEnvironment,
  };
  const workspaceId = `workspace-${createHash('sha256').update(options.project).digest('hex').slice(0, 24)}`;
  let stopped = false,
    pending = null,
    pendingState = null;
  const plans = new Map();
  const assertRunning = () => {
    if (stopped) throw new Error('tool-contract-unavailable');
  };
  async function fingerprint() {
    const value = await runtimeDigest();
    if (!hash(value)) throw new Error('tool-contract-unavailable');
    return value;
  }
  async function exclusive(operation) {
    if (stopped || pending) return fail('tool-contract-unavailable');
    pending = operation().catch((error) =>
      fail(known.has(error?.message) ? error.message : 'tool-contract-unavailable'),
    );
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }
  async function modules() {
    const [engine, schema] = await Promise.all([loadEngine(), loadSchema()]);
    assertRunning();
    return { engine, schema };
  }
  function valid(schema, name, body) {
    if (JSON.stringify(body).length > 512 * 1024 || !schema[name]?.(body))
      throw new Error('tool-contract-unavailable');
    return { status: 200, body };
  }
  return {
    state() {
      // Multiple views can request this same read while an earlier client aborts.
      // Share only the in-flight read; never cache a completed authority snapshot.
      if (pendingState) return pendingState;
      pendingState = exclusive(async () => {
        const { engine, schema } = await modules();
        let reason = 'runtime-unavailable';
        try {
          await fingerprint();
          reason = 'storage-unavailable';
          const body = await engine.readMcpToolContractState(options);
          assertRunning();
          return valid(schema, 'validateMcpToolContractState', body);
        } catch (error) {
          assertRunning();
          return valid(schema, 'validateMcpToolContractState', {
            schema: 'stroq-mcp-tool-contracts/1',
            workspaceId,
            generatedAt: new Date(now()).toISOString(),
            available: false,
            reason,
            registrations: [],
            gaps: [],
            limitations: [...schema.MCP_TOOL_CONTRACT_LIMITATIONS],
          });
        }
      }).finally(() => {
        pendingState = null;
      });
      return pendingState;
    },
    preview(input) {
      if (!target(input)) return Promise.resolve(fail('tool-contract-invalid'));
      return exclusive(async () => {
        const { engine, schema } = await modules(),
          runtime = await fingerprint();
        assertRunning();
        const selected = await engine.prepareMcpToolContractDecision(options, input);
        if (runtime !== (await fingerprint())) return fail('tool-contract-stale');
        assertRunning();
        const at = now(),
          previewId = randomUUID();
        const body = {
          schema: 'stroq-mcp-tool-contract-preview/1',
          id: previewId,
          workspaceId,
          createdAt: new Date(at).toISOString(),
          expiresAt: new Date(at + 120000).toISOString(),
          ...input,
          ...selected,
          hostEnforcement: false,
        };
        const result = valid(schema, 'validateMcpToolContractPreview', body);
        for (const [key, plan] of plans) if (plan.expires <= at) plans.delete(key);
        while (plans.size >= 8) plans.delete(plans.keys().next().value);
        plans.set(previewId, {
          input: { ...input },
          selected,
          runtime,
          expires: at + 120000,
          createdAt: body.createdAt,
        });
        return result;
      });
    },
    apply(input) {
      if (
        !exact(input, ['previewId', 'confirm', 'acknowledgeContract', 'acknowledgeCallLimits']) ||
        typeof input.previewId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          input.previewId,
        ) ||
        input.confirm !== true ||
        input.acknowledgeContract !== true ||
        input.acknowledgeCallLimits !== true
      )
        return Promise.resolve(fail('tool-contract-invalid'));
      return exclusive(async () => {
        const plan = plans.get(input.previewId);
        if (!plan) return fail('tool-contract-stale');
        plans.delete(input.previewId);
        if (plan.expires <= now() || plan.runtime !== (await fingerprint()))
          return fail('tool-contract-stale');
        const { engine, schema } = await modules();
        assertRunning();
        const { withLock } = await import(pathToFileURL(layout.core).href),
          lock = await prepareApplyLock(options.userHome);
        const guard = async () => {
          assertRunning();
          if (plan.expires <= now() || plan.runtime !== (await fingerprint()))
            throw new Error('tool-contract-stale');
          assertRunning();
          if (plan.expires <= now()) throw new Error('tool-contract-stale');
        };
        const revision = await withLock(
          lock.path,
          async () => {
            await guard();
            return engine.applyMcpToolContractDecision(
              options,
              plan.input,
              plan.selected.registrationId,
              plan.selected.registrationSha256,
              guard,
            );
          },
          { timeoutMs: 3000, fs: lock.fs },
        );
        try {
          if (stopped || plan.runtime !== (await fingerprint()))
            return fail('tool-contract-write-unconfirmed');
          return valid(schema, 'validateMcpToolContractReceipt', {
            schema: 'stroq-mcp-tool-contract-receipt/1',
            previewId: input.previewId,
            workspaceId,
            ...plan.input,
            registrationId: plan.selected.registrationId,
            registrationSha256: plan.selected.registrationSha256,
            completedAt: new Date(now()).toISOString(),
            revision,
            hostEnforcement: false,
          });
        } catch {
          return fail('tool-contract-write-unconfirmed');
        }
      });
    },
    async close() {
      stopped = true;
      plans.clear();
      await pending;
    },
  };
}

/** Call control shares the verified MCP adapter; no new shipped script or arbitrary runner. */
export async function createMcpCallControlService({
  project = layout.repository,
  userHome = homedir(),
  home = join(userHome, '.stroq'),
  paths = ENGINE_PATHS,
  platform = process.platform,
  mcpEnvironment = {},
  now = Date.now,
  runtimeDigest = () => hashRuntime(paths),
  loadEngine = async () => {
    const file = layout.adapter('mcp-containment-worker.js'),
      stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
      throw new Error('mcp-call-control-unavailable');
    return import(pathToFileURL(file).href);
  },
} = {}) {
  let engine;
  try {
    engine = await loadEngine();
  } catch {
    const unavailable = async () => ({
      status: 503,
      body: { error: 'mcp-call-control-unavailable' },
    });
    return {
      state: unavailable,
      inspect: unavailable,
      preview: unavailable,
      apply: unavailable,
      recheck: unavailable,
      close: async () => {},
    };
  }
  if (typeof engine.createMcpCallControlBackend !== 'function') {
    const unavailable = async () => ({
      status: 503,
      body: { error: 'mcp-call-control-unavailable' },
    });
    return {
      state: unavailable,
      inspect: unavailable,
      preview: unavailable,
      apply: unavailable,
      recheck: unavailable,
      close: async () => {},
    };
  }
  return engine.createMcpCallControlBackend({
    project: resolve(project),
    userHome: resolve(userHome),
    home: resolve(home),
    cli: paths.cli,
    platform,
    mcpEnvironment,
    now,
    runtimeDigest,
  });
}
