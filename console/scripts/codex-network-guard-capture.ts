import { networkCheckRecipe } from './codex-network-guard-check-recipe.ts';
import { dirname, join, relative, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { rootIdentity, snapshotFile, assertUnchanged } from './agent-setup-files.mjs';
import { captureCodexSkillSourceContext } from './codex-skill-source-context.ts';
import {
  captureGuardNative,
  controlHash,
  controlContext,
  sourceSnapshot,
  same,
  networkFail,
  type GuardOptions,
  type GuardHooks,
  type GuardSource,
  type GuardCapture,
  type ControlContext,
} from './codex-network-guard-binding.ts';
import {
  implicitGuardMode,
  parseGuardToml,
  mergeGuardTables,
  classifyGuard,
  projectGuardOverride,
  table,
} from './codex-network-guard-parse.ts';
import type {
  CodexNetworkGuardCapture,
  CodexNetworkGuardError,
  CodexNetworkGuardLayer,
} from '../lib/codex-network-guard.ts';
export const GUARD_GAPS = [
  'named-profile-unverified',
  'session-overrides-unverified',
  'running-clients-unverified',
  'other-surfaces-unverified',
] as const;
const sourceId = (path: string) =>
  `config-source-${controlHash(`stroq-network-source/1\0${path}`).slice(0, 24)}`;
async function fixedSource(path: string, scope: GuardSource['scope']): Promise<GuardSource> {
  let at = dirname(path);
  for (;;) {
    try {
      await lstat(at);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(at) === at) throw e;
      at = dirname(at);
    }
  }
  const canonical = await realpath(at),
    root = await rootIdentity(canonical),
    target = resolve(canonical, relative(at, path));
  return {
    id: sourceId(target),
    scope,
    path: target,
    root,
    snapshot: await snapshotFile(root, target, 256 * 1024),
  };
}
const sourceBinding = (s: GuardSource) => ({
  id: s.id,
  scope: s.scope,
  path: s.path,
  root: s.root,
  sha256: s.snapshot.sha256,
  file: s.snapshot.file,
  directories: s.snapshot.directories,
});
async function nonUserSources(options: GuardOptions, context: ControlContext) {
  const roots = await captureCodexSkillSourceContext(options);
  if (roots.ancestry.status === 'uncertain' || roots.ancestry.status === 'limit')
    networkFail('codex-network-unsupported');
  const sources: GuardSource[] = [];
  const system = options.systemSources ?? [
    { path: '/etc/codex/config.toml', scope: 'system' as const },
    { path: '/etc/codex/requirements.toml', scope: 'managed' as const },
    { path: '/etc/codex/managed_config.toml', scope: 'managed' as const },
    { path: '/Library/Managed Preferences/com.openai.codex.plist', scope: 'managed' as const },
    {
      path: join(context.user.path, 'Library', 'Managed Preferences', 'com.openai.codex.plist'),
      scope: 'managed' as const,
    },
  ];
  if (system.length > 16) networkFail('codex-network-unsupported');
  for (const source of system) sources.push(await fixedSource(source.path, source.scope));
  for (const root of roots.ancestry.status === 'bounded'
    ? roots.ancestry.parents
    : [roots.project]) {
    const path = join(root.path, '.codex', 'config.toml');
    if (path === context.target) continue;
    sources.push({
      id: sourceId(path),
      scope: 'project',
      path,
      root,
      snapshot: await snapshotFile(root, path, 256 * 1024),
    });
  }
  await roots.assertCurrent();
  return { roots, sources };
}
/** Re-resolve the fixed routes as well as checking the previously canonical files. */
export async function assertNetworkSources(options: GuardOptions, capture: GuardCapture) {
  const current = await nonUserSources(options, capture.context);
  if (
    !same(
      current.sources.map(sourceBinding),
      capture.sources.filter((s) => s.scope !== 'user').map(sourceBinding),
    )
  )
    networkFail('codex-network-stale');
  for (const s of current.sources) await assertUnchanged(s.root, s.path, s.snapshot);
  await current.roots.assertCurrent();
}
export async function captureNetworkGuard(
  options: GuardOptions,
  hooks: GuardHooks = {},
  mode: 'guard' | 'restore' = 'guard',
): Promise<GuardCapture> {
  const context = await controlContext(options),
    before = await sourceSnapshot(context),
    native = await (hooks.nativeCapture ?? captureGuardNative)(options),
    capturedSources = await nonUserSources(options, context),
    roots = capturedSources.roots;
  const sources: GuardSource[] = [
    {
      id: sourceId(context.target),
      scope: 'user',
      path: context.target,
      root: context.user,
      snapshot: before,
    },
    ...capturedSources.sources,
  ];
  if (
    sources.length > 64 ||
    sources.reduce((n, s) => n + (s.snapshot.bytes?.length ?? 0), 0) > 8 * 1024 * 1024
  )
    networkFail('codex-network-unsupported');
  let persistent: Record<string, any> = {},
    reason: CodexNetworkGuardError | null = null;
  const layers: CodexNetworkGuardLayer[] = [];
  for (const source of sources.filter((s) => s.scope === 'system'))
    persistent = mergeGuardTables(persistent, parseGuardToml(source.snapshot.bytes));
  const user: Record<string, any> = parseGuardToml(before.bytes);
  persistent = mergeGuardTables(persistent, user);
  for (const s of sources) {
    let effect: CodexNetworkGuardLayer['effect'] = 'none';
    if (s.scope === 'managed' && s.snapshot.bytes !== null) {
      effect = 'unknown';
      reason = 'codex-network-managed-unverified';
    } else if (s.scope === 'project' && s.snapshot.bytes !== null) {
      effect = projectGuardOverride(parseGuardToml(s.snapshot.bytes));
      if (effect === 'selector-override' || effect === 'network-override')
        reason = 'codex-network-project-override';
    }
    layers.push({
      id: s.id,
      scope: s.scope,
      status:
        s.snapshot.bytes === null ? 'absent' : s.scope === 'managed' ? 'unsupported' : 'captured',
      effect,
    });
  }
  let selected;
  try {
    selected = classifyGuard(persistent, user, implicitGuardMode(persistent, roots));
  } catch (e) {
    if (mode === 'guard') throw e;
    reason = 'codex-network-unsupported';
    selected = {
      kind: null,
      parentProfile: null,
      baseline: {
        kind: 'unavailable' as const,
        profile: 'none' as const,
        network: 'unknown' as const,
      },
      filesystemEffect: 'unavailable' as const,
    };
  }
  if (selected.kind === 'profile-child') reason = 'codex-network-managed-unverified';
  if (
    selected.kind === 'profile-network-off' &&
    (!table(user.permissions) || !table(user.permissions[selected.parentProfile!]))
  )
    reason ??= 'codex-network-parent-unavailable';
  if (selected.kind === null && !reason) reason = 'codex-network-already-off';
  const sourceGraphSha256 = controlHash(JSON.stringify(sources.map(sourceBinding)));
  const captureSha256 = controlHash(
    JSON.stringify({
      schema: 'stroq-network-capture-binding/1',
      context,
      sources: sources.map(sourceBinding),
      native,
      runtimeSha256: options.runtimeSha256,
    }),
  );
  const binding = {
    controlContextId: context.id,
    captureSha256,
    configSha256: before.bytes === null ? null : before.sha256,
    runtimeSha256: options.runtimeSha256,
    nativeBinarySha256: native.sha256,
    sourceGraphSha256,
  };
  const report: CodexNetworkGuardCapture = {
    schema: 'stroq-codex-network-capture/1',
    capturedAt: new Date().toISOString(),
    binding,
    compatibility: {
      status: 'supported',
      version: native.version,
      platform: native.platform,
      binarySha256: native.sha256,
    },
    baseline: selected.baseline,
    actionKind: selected.kind,
    filesystemEffect: selected.filesystemEffect,
    canGuard: reason === null && selected.kind !== null,
    canCheck: false,
    reason,
    layers,
    gaps: [...GUARD_GAPS, 'managed-source-unverified'],
  };
  await roots.assertCurrent();
  for (const s of sources) await assertUnchanged(s.root, s.path, s.snapshot);
  const result = {
    public: report,
    context,
    sources,
    native,
    binding,
    kind: selected.kind,
    parentProfile: selected.parentProfile,
    before,
  };
  try {
    networkCheckRecipe(result);
    report.canCheck = true;
  } catch {
    /* A passive recipe failure blocks Check, not safe in-place Guard. */
  }
  return result;
}
export async function assertNetworkCapture(
  options: GuardOptions,
  capture: GuardCapture,
  hooks: GuardHooks = {},
) {
  const current = await captureNetworkGuard(
    options,
    hooks,
    capture.public.canGuard ? 'guard' : 'restore',
  );
  if (
    current.binding.captureSha256 !== capture.binding.captureSha256 ||
    !same(current.context, capture.context)
  )
    networkFail('codex-network-stale');
  return current;
}
export async function inspectNetworkGuard(
  options: GuardOptions,
  hooks: GuardHooks = {},
): Promise<CodexNetworkGuardCapture> {
  try {
    return (await captureNetworkGuard(options, hooks)).public;
  } catch (e) {
    const message = (e as Error).message;
    const reasons = [
      'codex-network-stale',
      'codex-network-unsupported',
      'codex-network-mixed-config',
      'codex-network-parent-unavailable',
      'codex-network-native-changed',
    ];
    const reason = (
      reasons.includes(message) ? message : 'codex-network-unavailable'
    ) as CodexNetworkGuardError;
    return {
      schema: 'stroq-codex-network-capture/1',
      capturedAt: new Date().toISOString(),
      binding: null,
      compatibility: {
        status: 'unavailable',
        version: null,
        platform: process.platform === 'darwin' ? 'darwin' : 'unsupported',
        binarySha256: null,
      },
      baseline: { kind: 'unavailable', profile: 'none', network: 'unknown' },
      actionKind: null,
      filesystemEffect: 'unavailable',
      canGuard: false,
      canCheck: false,
      reason,
      layers: [],
      gaps: [
        ...GUARD_GAPS,
        reason === 'codex-network-native-changed' ? 'native-unsupported' : 'context-unavailable',
      ],
    };
  }
}
