// Fetches the vendored benign corpus from the manifest and records each file's
// resolved commit and sha256. Default mode writes files and updates the manifest;
// `--check` (CI) re-hashes the committed files and fails on any mismatch, writing
// nothing and touching the network not at all.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifestFile = join(root, 'vendor/bench-corpus/sources.json');
const filesDir = join(root, 'vendor/bench-corpus/files');

interface Source {
  repo: string;
  ref: string;
  path: string;
  license: string;
  commit: string;
  sha256: string;
}
interface Manifest {
  note: string;
  sources: Source[];
}

const localPath = (s: Source): string =>
  join(filesDir, s.repo.replace('/', '-'), s.path.split('/').pop() ?? s.path);

const hash = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** Resolves a ref to the commit it points at, so the manifest pins bytes, not a branch. */
async function resolveCommit(repo: string, ref: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
    headers: { accept: 'application/vnd.github.sha' },
  });
  if (!res.ok) throw new Error(`cannot resolve ${repo}@${ref}: ${res.status}`);
  return (await res.text()).trim();
}

async function fetchFile(s: Source, commit: string): Promise<Buffer> {
  const url = `https://raw.githubusercontent.com/${s.repo}/${commit}/${s.path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot fetch ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest;
const checkMode = process.argv.includes('--check');

if (checkMode) {
  let bad = 0;
  for (const s of manifest.sources) {
    const actual = hash(readFileSync(localPath(s)));
    if (actual === s.sha256) continue;
    process.stderr.write(`${s.repo}/${s.path}: sha256 mismatch\n`);
    bad += 1;
  }
  if (bad > 0) {
    process.stderr.write(
      `bench corpus is not what the manifest records: run "pnpm fetch:bench-corpus" and commit the result\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`bench corpus is current (${manifest.sources.length} files)\n`);
  }
} else {
  for (const s of manifest.sources) {
    const commit = s.commit !== '' ? s.commit : await resolveCommit(s.repo, s.ref);
    const body = await fetchFile(s, commit);
    const file = localPath(s);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
    s.commit = commit;
    s.sha256 = hash(body);
    process.stdout.write(`${s.repo}/${s.path} @ ${commit.slice(0, 7)}\n`);
  }
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`bench corpus: ${manifest.sources.length} files\n`);
}
