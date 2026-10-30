import { lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { assertWriteAllowed, resolveRealPath } from './atomic.js';
import { backupPath } from './backup.js';
import { entriesFor, readManifestSnapshot, type ManifestSnapshot } from './manifest.js';
import { readTargetSnapshot, type HardenFileIdentity } from './read.js';
import { HardenError, type HardenEnv } from './types.js';

type Ancestor = {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly uid: string;
  readonly mode: number;
};
export interface HardenBoundFile {
  readonly path: string;
  readonly sha256: string | null;
  readonly identity: HardenFileIdentity | null;
  readonly ancestors: readonly Ancestor[];
}
export interface HardenPreparedBinding {
  readonly file: string;
  readonly real: string;
  readonly root: string | null;
  readonly home: string;
  readonly source: HardenBoundFile;
  readonly manifest: HardenBoundFile;
  readonly backups: readonly HardenBoundFile[];
  readonly candidateSha256: string | null;
}
export interface PreparedOperationOptions {
  /** Additional server-selected root/runtime checks; never supplied by an HTTP caller. */
  readonly assertCurrent?: () => void | Promise<void>;
}
export const stalePrepared = (): never => {
  throw new HardenError('stale-plan', 'prepared operation evidence changed; prepare it again');
};

function ancestors(file: string, root: string): Ancestor[] {
  const out: Ancestor[] = [];
  const rel = relative(root, dirname(file));
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== dirname(file))
    stalePrepared();
  let at = root;
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) at = join(at, part);
    const s = lstatSync(at, { bigint: true, throwIfNoEntry: false });
    if (!s) break; // Engine/parent may later create these, but existing ancestors remain bound.
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      s.ino === 0n ||
      (typeof process.getuid === 'function' && s.uid !== BigInt(process.getuid()))
    )
      stalePrepared();
    out.push({
      path: at,
      dev: String(s.dev),
      ino: String(s.ino),
      uid: String(s.uid),
      mode: Number(s.mode),
    });
  }
  return out;
}
function boundFile(
  path: string,
  root: string,
  privateMode = false,
  snapshot?: ManifestSnapshot,
): HardenBoundFile {
  const chain = ancestors(path, root);
  const captured = snapshot ?? readTargetSnapshot(path, undefined, privateMode);
  if (captured.identity && !privateMode && !(captured.identity.mode & 0o200))
    throw new HardenError('read-only-target', 'the prepared target is not owner-writable');
  return {
    path,
    sha256:
      captured.bytes === null ? null : createHash('sha256').update(captured.bytes).digest('hex'),
    identity: captured.identity,
    ancestors: chain,
  };
}
export function capturePreparedState(
  env: HardenEnv,
  file: string,
  root: string | null,
  candidateSha256: string | null,
) {
  const asked = resolve(file),
    real = assertWriteAllowed(asked, root === null ? {} : { root });
  // Prepared console operations intentionally exclude links, even ones supported by CLI acknowledgement.
  if (asked !== real) stalePrepared();
  const home = resolveRealPath(env.home);
  assertWriteAllowed(join(home, 'harden', 'manifest.json'), { root: home, initRule: false });
  const manifest = readManifestSnapshot(env);
  const source = boundFile(real, root === null ? dirname(real) : resolveRealPath(root));
  const manifestFile = boundFile(join(home, 'harden', 'manifest.json'), home, true, manifest);
  const ids = [
    ...new Set(
      entriesFor(manifest.manifest, real).flatMap((entry) =>
        entry.backup === null ? [] : [entry.backup],
      ),
    ),
  ];
  const backups = ids.map((id) => {
    const path = backupPath(home, id, real);
    assertWriteAllowed(path, { root: home, initRule: false });
    return boundFile(path, home, true);
  });
  const binding: HardenPreparedBinding = {
    file: asked,
    real,
    root,
    home,
    source,
    manifest: manifestFile,
    backups,
    candidateSha256,
  };
  return { binding, manifest: manifest.manifest };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function assertBoundFile(expected: HardenBoundFile, actual: HardenBoundFile): void {
  if (
    expected.path !== actual.path ||
    expected.sha256 !== actual.sha256 ||
    !same(expected.identity, actual.identity) ||
    expected.ancestors.some((before) => !actual.ancestors.some((after) => same(before, after)))
  )
    stalePrepared();
}
export function assertPreparedBinding(
  expected: HardenPreparedBinding,
  actual: HardenPreparedBinding,
): void {
  if (
    expected.file !== actual.file ||
    expected.real !== actual.real ||
    expected.root !== actual.root ||
    expected.home !== actual.home ||
    expected.candidateSha256 !== actual.candidateSha256 ||
    expected.backups.length !== actual.backups.length
  )
    stalePrepared();
  assertBoundFile(expected.source, actual.source);
  assertBoundFile(expected.manifest, actual.manifest);
  expected.backups.forEach((before, i) => {
    const after = actual.backups[i] ?? stalePrepared();
    assertBoundFile(before, after);
  });
}
/** Before a source write, own manifest additions are expected; prior backups/source remain immutable. */
export function assertPreparedInputs(expected: HardenPreparedBinding, env: HardenEnv): void {
  const actual = capturePreparedState(
    env,
    expected.file,
    expected.root,
    expected.candidateSha256,
  ).binding;
  assertBoundFile(expected.source, actual.source);
  for (const before of expected.backups) {
    const after = actual.backups.find((item) => item.path === before.path) ?? stalePrepared();
    assertBoundFile(before, after);
  }
}
