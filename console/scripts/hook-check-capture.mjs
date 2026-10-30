import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import { targetFor } from './agent-setup-plan.mjs';
import { inspectConfiguration, validConfiguration } from './agent-status-config.mjs';
import { runtimeDigest } from './agent-setup-cli.mjs';
import { readPolicyState } from './policy-files.mjs';
import { runtimeLayout } from './runtime-layout.mjs';

const SHA = /^[a-f0-9]{64}$/;
const pin = (v) => (v === null ? null : { dev: v.dev, ino: v.ino, uid: v.uid, mode: v.mode });

/** Only server-selected configuration is read. Recorded commands are never executable input. */
export async function captureHookConfiguration(input, options, roots, workspaceId) {
  const runtime = await (options.runtimeDigest ?? (() => runtimeDigest(options.paths)))();
  if (!SHA.test(runtime)) throw new Error('engine-unavailable');
  const statusPath = options.statusAdapterPath ?? runtimeLayout().adapter('agent-status-engine.js');
  try {
    const captured = await snapshotFile(
      await rootIdentity(dirname(statusPath)),
      statusPath,
      16 * 1024 * 1024,
    );
    if (captured.bytes === null) throw new Error();
  } catch {
    throw new Error('engine-unavailable');
  }
  const url = pathToFileURL(statusPath);
  url.searchParams.set('hookCheckRuntime', runtime);
  const adapter = await import(url.href).catch(() => {
    throw new Error('engine-unavailable');
  });
  let source;
  const root = roots[input.scope];
  try {
    source = await snapshotFile(root, join(root.path, targetFor(input.agent, input.scope)));
    if (source.bytes === null) throw new Error('hooks-not-configured');
    const config = adapter.parseSetupObject(source.bytes);
    const expected = adapter.expectedConfiguration(
      input.agent,
      `"${process.execPath}" "${options.paths.cli}" hook ${input.agent}`,
    );
    if (!validConfiguration(config, input.agent)) throw new Error();
    if (inspectConfiguration(config, expected, input.agent).state !== 'present')
      throw new Error('hooks-not-configured');
  } catch (error) {
    throw new Error(
      error.message === 'hooks-not-configured' ? error.message : 'configuration-unreadable',
    );
  }
  let policy,
    policyFile = null,
    semantic;
  try {
    policy = await readPolicyState(options.home);
    if (policy.rootStat !== null) {
      const policyRoot = await rootIdentity(policy.root);
      policyFile = await snapshotFile(policyRoot, policy.path, 256 * 1024);
      if (
        policyFile.sha256 !== (policy.rawSha ?? 'absent') ||
        !isDeepStrictEqual(policyFile.bytes, policy.bytes)
      )
        throw new Error();
    }
    semantic = adapter.policyFingerprint(policy.text);
    if (!SHA.test(semantic)) throw new Error();
  } catch {
    throw new Error('policy-unavailable');
  }
  if (runtime !== (await (options.runtimeDigest ?? (() => runtimeDigest(options.paths)))()))
    throw new Error('preview-stale');
  return {
    binding: {
      workspaceId,
      ...input,
      sourceSha256: source.sha256,
      policySha256: policy.rawSha,
      policySemanticSha256: semantic,
      runtimeSha256: runtime,
    },
    policyText: policy.text,
    private: {
      roots,
      source,
      policy: {
        root: pin(policy.rootStat ?? null),
        anchor: policy.anchor ?? null,
        anchorPin: pin(policy.anchorStat ?? null),
        file: policyFile,
      },
    },
    policyState: {
      rootStat: pin(policy.rootStat ?? null),
      anchor: policy.anchor,
      anchorStat: pin(policy.anchorStat ?? null),
      missing: policy.missing,
      bytes: policy.bytes === null ? null : 'present',
    },
    memoryBytes:
      (source.bytes?.length ?? 0) +
      (policyFile?.bytes?.length ?? 0) +
      (policy.text?.length ?? 0) * 2 +
      16 * 1024,
  };
}

/** The first accepted history write may create this previously absent private home. */
export async function sameHookCapture(before, after, adoptCreatedHome = false) {
  if (!isDeepStrictEqual(before.binding, after.binding) || before.policyText !== after.policyText)
    return false;
  if (isDeepStrictEqual(before.private, after.private)) return true;
  const old = before.policyState;
  if (
    !adoptCreatedHome ||
    !old ||
    old.rootStat !== null ||
    after.policyState?.rootStat === null ||
    old.bytes !== null ||
    after.policyState?.bytes !== null
  )
    return false;
  if (!isDeepStrictEqual({ ...before.private, policy: null }, { ...after.private, policy: null }))
    return false;
  try {
    if (!isDeepStrictEqual(pin(await lstat(old.anchor)), pin(old.anchorStat))) return false;
    for (const path of old.missing) {
      const stat = await lstat(path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o777) !== 0o700 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
