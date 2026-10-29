import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE_PATHS, REPOSITORY } from './control-engine.mjs';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import { AGENTS, parseObject, plain, targetFor } from './agent-setup-plan.mjs';
import { inspectConfiguration, validConfiguration } from './agent-status-config.mjs';
import { runtimeLayout } from './runtime-layout.mjs';

const ADAPTER = runtimeLayout().adapter('agent-status-engine.js');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const iso = (value) =>
  typeof value === 'string' &&
  ISO.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const text = (bytes) =>
  bytes === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(bytes);

async function read(root, file, max) {
  if (root === null) return { state: 'missing', bytes: null };
  try {
    const value = await snapshotFile(root, join(root.path, file), max);
    return { state: value.bytes === null ? 'missing' : 'read', bytes: value.bytes };
  } catch {
    return { state: 'unreadable', bytes: null };
  }
}

async function optionalRoot(path) {
  try {
    return await rootIdentity(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function runtimeVersion(paths) {
  try {
    const cli = await lstat(paths.cli);
    if (!cli.isFile() || cli.isSymbolicLink() || cli.nlink !== 1 || cli.size > 16 * 1024 * 1024)
      return null;
    const packageRoot = await rootIdentity(dirname(paths.package));
    const bytes = await read(packageRoot, basename(paths.package), 64 * 1024);
    const value = parseObject(bytes.bytes);
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[\w.-]{1,30})?$/.test(value.version)
      ? value.version
      : null;
  } catch {
    return null;
  }
}

function observed(value, now) {
  const base = { scope: 'machine', lastHookAt: null, state: 'missing' };
  if (value.state === 'missing') return base;
  try {
    const stamp = text(value.bytes)?.trim();
    if (!iso(stamp) || Date.parse(stamp) > now + 5 * 60_000) throw new Error();
    return { ...base, state: 'recorded', lastHookAt: stamp };
  } catch {
    return { ...base, state: 'invalid' };
  }
}

function records(value) {
  if (value.state !== 'read') return {};
  try {
    const parsed = parseObject(value.bytes);
    if (parsed.version !== 1 || !plain(parsed.entries)) return {};
    return Object.fromEntries(
      Object.entries(parsed.entries).filter(
        ([key, entry]) =>
          /^(claude-code|cursor|codex):(project|user)$/.test(key) &&
          plain(entry) &&
          typeof entry.command === 'string' &&
          entry.command.length <= 8192 &&
          iso(entry.recordedAt),
      ),
    );
  } catch {
    return {};
  }
}

function defaultScope(scope, approval) {
  return {
    scope,
    state: 'unknown',
    reason: 'config-unreadable',
    events: [],
    approval,
    recordedAt: null,
  };
}

async function inspectScope({
  agent,
  scope,
  roots,
  expected,
  approval,
  version,
  record,
  parseSetupObject,
}) {
  const root = roots[scope];
  const base = defaultScope(scope, approval);
  base.recordedAt = record?.recordedAt ?? null;
  if (root === undefined) return base;
  const file = await read(root, targetFor(agent, scope));
  if (file.state === 'unreadable') return base;
  if (version === null) return { ...base, reason: 'runtime-unavailable' };
  try {
    const value = parseSetupObject(file.bytes);
    if (!validConfiguration(value, agent))
      return { ...base, state: 'invalid', reason: 'config-invalid' };
    const status = inspectConfiguration(value, expected, agent);
    return { ...base, ...status };
  } catch {
    return { ...base, state: 'invalid', reason: 'config-invalid' };
  }
}

/** Current read-only configuration, machine observations, and historical proof remain separate. */
export async function createAgentStatus(configuration = {}) {
  const project = resolve(configuration.project ?? REPOSITORY);
  const userHome = resolve(configuration.userHome ?? homedir());
  const home = resolve(configuration.home ?? process.env.STROQ_HOME ?? join(userHome, '.stroq'));
  const paths = configuration.paths ?? ENGINE_PATHS;
  const now = configuration.now ?? Date.now;
  const adapterPath = configuration.adapterPath ?? ADAPTER;
  let closed = false;
  let pending = null;
  async function performRead() {
    if (closed) return { status: 503, body: { error: 'server-stopped' } };
    let adapter;
    try {
      const stat = await lstat(adapterPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
        throw new Error();
      adapter = await import(pathToFileURL(adapterPath).href);
      if (typeof adapter.parseSetupObject !== 'function') throw new Error();
    } catch {
      return { status: 503, body: { error: 'engine-unavailable' } };
    }
    const current = now();
    const rootValues = await Promise.allSettled([
      rootIdentity(project),
      rootIdentity(userHome),
      optionalRoot(home),
    ]);
    const roots = {
      project: rootValues[0].value,
      user: rootValues[1].value,
      home: rootValues[2].value,
    };
    const store = roots.home;
    const version = await runtimeVersion(paths);
    const install = store === undefined ? {} : records(await read(store, 'install.json'));
    let policy = null;
    if (store !== undefined) {
      const value = await read(store, 'policy.yaml', 256 * 1024);
      try {
        if (value.state !== 'unreadable') policy = adapter.policyFingerprint(text(value.bytes));
      } catch {
        /* An invalid policy cannot keep an old proof current. */
      }
    }
    let approval = 'unknown';
    if (roots.user !== undefined) {
      const value = await read(roots.user, '.codex/config.toml');
      try {
        if (value.state !== 'unreadable') approval = adapter.codexApproval(text(value.bytes));
      } catch {
        /* Unknown text cannot demonstrate an approval. */
      }
    }
    const agents = await Promise.all(
      AGENTS.map(async (agent) => {
        const command = `"${process.execPath}" "${paths.cli}" hook ${agent}`;
        const expected = adapter.expectedConfiguration(agent, command);
        const scopes = await Promise.all(
          ['project', 'user'].map((scope) =>
            inspectScope({
              agent,
              scope,
              roots,
              expected,
              approval: agent === 'codex' ? approval : 'not-required',
              version,
              record: install[`${agent}:${scope}`],
              parseSetupObject: adapter.parseSetupObject,
            }),
          ),
        );
        const stamp =
          store === undefined
            ? { state: 'unreadable' }
            : await read(store, `last-hook/${agent}`, 64);
        const observation = observed(stamp, current);
        const result =
          store === undefined
            ? { state: 'unreadable' }
            : await read(store, `live/${agent}.json`, 64 * 1024);
        let raw = null;
        try {
          if (result.state === 'read') raw = parseObject(result.bytes);
        } catch {
          raw = {};
        }
        const timestamps = scopes
          .map((scope) => scope.recordedAt)
          .filter((value) => value !== null);
        const proof = adapter.projectProof({
          agent,
          raw,
          present: scopes.some((scope) => scope.state === 'present'),
          changed: scopes.some(
            (scope) =>
              scope.state === 'changed' || scope.state === 'invalid' || scope.state === 'unknown',
          ),
          recordedAt: timestamps.sort().at(-1) ?? null,
          stampAt: observation.lastHookAt,
          version,
          policy,
          now: current,
        });
        if (result.state === 'unreadable' && proof.state !== 'unsupported')
          Object.assign(proof, {
            state: 'invalid',
            freshness: 'unknown',
            reason: 'proof-unreadable',
          });
        return { id: agent, hostVersion: null, scopes, observation, proof };
      }),
    );
    return {
      status: 200,
      body: {
        schema: 'stroq-agents/1',
        source: 'local',
        generatedAt: new Date(current).toISOString(),
        agents,
      },
    };
  }
  return {
    read() {
      if (pending) return pending;
      pending = performRead()
        .catch(() => ({ status: 503, body: { error: 'agent-status-unavailable' } }))
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    async close() {
      closed = true;
      await pending;
    },
  };
}
