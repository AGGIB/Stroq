import type {
  CodexPathGuardCapture as PublicCapture,
  CodexPathGuardBinding,
} from '../lib/codex-path-guard.ts';
import type {
  GuardCapture,
  GuardSource,
  NativeBinding,
  ControlContext,
  Snapshot,
} from './codex-network-guard-binding.ts';
import type { PathGuardTargets } from './codex-path-guard-targets.ts';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { captureNetworkGuard } from './codex-network-guard-capture.ts';
import { parseGuardToml, mergeGuardTables } from './codex-network-guard-parse.ts';
import { capturePathGuardTargets, unobservedPathGuardTargets } from './codex-path-guard-targets.ts';
import { planCodexPathGuard } from './codex-path-guard-toml.ts';
import { pathGuardPolicy, type PathGuardPolicyInput } from './codex-path-guard-policy.ts';
import { assertPathGuardRestorePolicy } from './codex-path-guard-policy.ts';
import { restoreCodexPathGuard } from './codex-path-guard-toml.ts';
import { assertNetworkSources } from './codex-network-guard-capture.ts';
import {
  CODEX_PATH_GUARD_ERRORS,
  CODEX_PATH_GUARD_PRESETS,
  type CodexPathGuardError,
} from '../lib/codex-path-guard.ts';
import {
  assertRuntime,
  controlHash,
  same,
  pathFail,
  type GuardOptions,
  type GuardHooks,
  type PathGuardRecord,
} from './codex-path-guard-binding.ts';

export type PathGuardCapture = {
  public: PublicCapture;
  context: ControlContext;
  before: Snapshot;
  sources: GuardSource[];
  native: NativeBinding;
  binding: CodexPathGuardBinding;
  profileName: string | null;
  targets: PathGuardTargets;
  base: GuardCapture;
  dependencySha256: string;
};

const gaps: PublicCapture['gaps'] = [
  'named-profile-unverified',
  'session-overrides-unverified',
  'running-clients-unverified',
  'other-surfaces-unverified',
  'managed-source-unverified',
  'path-aliases-uncovered',
  'existing-data-unrevoked',
  'file-tools-unverified',
];
export function pathGuardError(error: unknown): CodexPathGuardError {
  const message = (error as Error)?.message;
  const code =
    typeof message === 'string'
      ? message
          .replace(/^codex-network-/, 'codex-path-guard-')
          .replace(/^codex-control-/, 'codex-path-guard-')
      : '';
  return CODEX_PATH_GUARD_ERRORS.includes(code as CodexPathGuardError)
    ? (code as CodexPathGuardError)
    : 'codex-path-guard-unavailable';
}
const sourceMetadata = (s: GuardSource) => ({
  id: s.id,
  scope: s.scope,
  path: s.path,
  root: s.root,
  sha256: s.snapshot.sha256,
  file: s.snapshot.file,
  directories: s.snapshot.directories,
});
async function canonical(path: string) {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}
const dependencyHash = (
  capture: Pick<PathGuardCapture, 'sources'>,
  input: Pick<PathGuardPolicyInput, 'home' | 'project' | 'temporary'>,
) =>
  controlHash(
    JSON.stringify({
      sources: capture.sources.filter((s) => s.scope !== 'user').map(sourceMetadata),
      home: input.home,
      project: input.project,
      temporary: input.temporary,
    }),
  );
export async function pathGuardPolicyInput(
  options: GuardOptions,
  capture: Pick<PathGuardCapture, 'context' | 'sources' | 'before'>,
): Promise<PathGuardPolicyInput> {
  let persistent: Record<string, any> = {};
  for (const s of capture.sources.filter((s) => s.scope === 'system'))
    persistent = mergeGuardTables(persistent, parseGuardToml(s.snapshot.bytes));
  const user = parseGuardToml(capture.before.bytes);
  persistent = mergeGuardTables(persistent, user);
  return {
    persistent,
    user,
    projects: capture.sources
      .filter((s) => s.scope === 'project')
      .reverse()
      .map((s) => parseGuardToml(s.snapshot.bytes)),
    home: capture.context.user.path,
    project: await realpath(options.project),
    temporary: { tmpdir: await canonical(tmpdir()), slashTmp: await canonical('/tmp') },
  };
}
export async function capturePathGuard(
  options: GuardOptions,
  hooks: GuardHooks = {},
  mode: 'guard' | 'restore' = 'guard',
): Promise<PathGuardCapture> {
  try {
    await assertRuntime(options);
    const base = await captureNetworkGuard(options, hooks, 'restore');
    const targetCapture =
      (hooks as GuardHooks & { targetCapture?: typeof capturePathGuardTargets }).targetCapture ??
      capturePathGuardTargets;
    const targets =
        mode === 'guard'
          ? await targetCapture(base.context.user)
          : unobservedPathGuardTargets(base.context.user),
      input = await pathGuardPolicyInput(options, base);
    const managed = base.sources.some((s) => s.scope === 'managed' && s.snapshot.bytes !== null);
    const policies = targets.targets.map((t) => pathGuardPolicy(input, t.path));
    const presets = targets.targets.map((t, i) => {
      const p = policies[i]!,
        declaration = managed ? ('unknown' as const) : p.declaration;
      let reason: CodexPathGuardError | null = managed
        ? 'codex-path-guard-managed-unverified'
        : t.status === 'unsafe'
          ? 'codex-path-guard-target-unsafe'
          : t.status === 'unavailable'
            ? 'codex-path-guard-target-unavailable'
            : p.reason;
      if (reason === null && declaration === 'deny') reason = 'codex-path-guard-already-denied';
      if (reason === null) {
        try {
          planCodexPathGuard({
            bytes: base.before.bytes,
            operationId: randomUUID(),
            targetPath: t.path,
          });
        } catch (e) {
          reason = pathGuardError(e);
        }
      }
      return {
        id: t.id,
        target: t.status,
        declaration,
        canGuard: reason === null && (declaration === 'read' || declaration === 'write'),
        reason,
      };
    });
    const valid = policies.find((p) => p.reason === null),
      eligible = presets.some((p) => p.canGuard),
      reason = eligible
        ? null
        : (presets.find((p) => p.reason !== 'codex-path-guard-already-denied')?.reason ??
          'codex-path-guard-already-denied');
    const binding = {
      ...base.binding,
      targetMetadataSha256: targets.sha256,
      captureSha256: controlHash(
        JSON.stringify({
          schema: 'stroq-path-capture-binding/1',
          base: base.binding.captureSha256,
          targets: targets.sha256,
          home: input.home,
          project: input.project,
          temporary: input.temporary,
        }),
      ),
    };
    const dependencySha256 = dependencyHash(base, input);
    const report: PublicCapture = {
      schema: 'stroq-codex-path-capture/1',
      capturedAt: new Date().toISOString(),
      binding,
      compatibility: base.public.compatibility,
      baseline: valid?.baseline ?? base.public.baseline,
      actionKind:
        eligible || reason === 'codex-path-guard-already-denied' ? 'profile-path-deny' : null,
      reason,
      presets,
      gaps: [...gaps],
    };
    await assertRuntime(options);
    return {
      public: report,
      context: base.context,
      before: base.before,
      sources: base.sources,
      native: base.native,
      binding,
      profileName: policies[0]?.profileName ?? null,
      targets,
      base,
      dependencySha256,
    };
  } catch (e) {
    return pathFail(pathGuardError(e));
  }
}
export async function inspectPathGuard(
  options: GuardOptions,
  hooks: GuardHooks = {},
): Promise<PublicCapture> {
  try {
    return (await capturePathGuard(options, hooks)).public;
  } catch (e) {
    const reason = pathGuardError(e);
    return {
      schema: 'stroq-codex-path-capture/1',
      capturedAt: new Date().toISOString(),
      binding: null,
      compatibility: {
        status:
          reason === 'codex-path-guard-unsupported' || reason === 'codex-path-guard-native-changed'
            ? 'unsupported'
            : 'unavailable',
        version: null,
        platform: process.platform === 'darwin' ? 'darwin' : 'unsupported',
        binarySha256: null,
      },
      baseline: { kind: 'unavailable', profile: 'none', network: 'unknown' },
      actionKind: null,
      reason,
      presets: CODEX_PATH_GUARD_PRESETS.map((id) => ({
        id,
        target: 'unavailable',
        declaration: 'unknown',
        canGuard: false,
        reason,
      })),
      gaps: [...gaps, 'context-unavailable'],
    };
  }
}
export async function assertPathGuardCapture(
  options: GuardOptions,
  capture: PathGuardCapture,
  hooks: GuardHooks = {},
  mode: 'guard' | 'restore' = 'guard',
) {
  const current = await capturePathGuard(options, hooks, mode);
  if (
    !same(current.context, capture.context) ||
    current.base.binding.captureSha256 !== capture.base.binding.captureSha256 ||
    current.dependencySha256 !== capture.dependencySha256 ||
    (mode === 'guard' && current.binding.captureSha256 !== capture.binding.captureSha256)
  )
    pathFail('codex-path-guard-stale');
  return current;
}
/** Safe after our config publication: fixed non-user sources and resolution roots stay pinned. */
export async function assertPathGuardDependencies(
  options: GuardOptions,
  capture: PathGuardCapture,
) {
  try {
    await assertNetworkSources(options, capture.base);
    const input = {
      home: capture.context.user.path,
      project: await realpath(options.project),
      temporary: { tmpdir: await canonical(tmpdir()), slashTmp: await canonical('/tmp') },
    };
    if (dependencyHash(capture, input) !== capture.dependencySha256)
      pathFail('codex-path-guard-stale');
  } catch (e) {
    pathFail(pathGuardError(e));
  }
}
export async function restorePathGuardRecord(
  options: GuardOptions,
  capture: PathGuardCapture,
  record: PathGuardRecord,
): Promise<Uint8Array> {
  if (
    record.manifest.controlContextId !== capture.context.id ||
    record.manifest.target !== capture.context.target ||
    record.manifest.dependencySha256 !== capture.dependencySha256 ||
    capture.before.bytes === null
  )
    pathFail('codex-path-guard-conflict');
  try {
    await assertPathGuardDependencies(options, capture);
    const input = await pathGuardPolicyInput(options, capture);
    let original: Record<string, any> = {};
    for (const s of capture.sources.filter((s) => s.scope === 'system'))
      original = mergeGuardTables(original, parseGuardToml(s.snapshot.bytes));
    original = mergeGuardTables(original, parseGuardToml(record.before));
    let current = input.persistent;
    for (const p of input.projects) {
      original = mergeGuardTables(original, p);
      current = mergeGuardTables(current, p);
    }
    assertPathGuardRestorePolicy(
      original,
      current,
      record.manifest.profileName,
      record.manifest.credentialTarget,
      input,
    );
    return restoreCodexPathGuard({ bytes: capture.before.bytes, owned: record.owned });
  } catch (e) {
    pathFail(pathGuardError(e));
  }
}
