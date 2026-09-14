// Derives packages/cli/src/coverage/atlas.json from the vendored MITRE ATLAS
// distribution. Mirrors scripts/build-rules.ts: the default mode writes, and
// `--check` (CI) re-derives in memory and byte-compares against the committed
// file without writing anything.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const sourceFile = join(root, 'vendor/atlas/ATLAS-2026.08.yaml');
const outFile = join(root, 'packages/cli/src/coverage/atlas.json');
const SOURCE_URL =
  'https://raw.githubusercontent.com/mitre-atlas/atlas-data/main/dist/v6/ATLAS-2026.08.yaml';

const OUT_OF_DATE =
  'atlas.json is out of date: run "pnpm build:atlas" locally and commit packages/cli/src/coverage/atlas.json';

interface RawTechnique {
  readonly id?: unknown;
  readonly name?: unknown;
}

/** The id of a sub-technique's parent, or null for a top-level technique. */
function parentOf(id: string): string | null {
  const dot = id.indexOf('.', 'AML.T'.length);
  return dot === -1 ? null : id.slice(0, dot);
}

function derive(): string {
  const raw = readFileSync(sourceFile);
  const doc = parse(raw.toString('utf8')) as {
    'format-version'?: unknown;
    collection?: { version?: unknown };
    techniques?: Record<string, RawTechnique>;
  };
  const formatVersion = String(doc['format-version'] ?? '');
  const release = String(doc.collection?.version ?? '');
  const techniques = Object.entries(doc.techniques ?? {})
    .map(([id, t]) => ({ id, name: String(t.name ?? ''), parent: parentOf(id) }))
    // Ordinal, not localeCompare: this script's entire job is byte-identical
    // reproduction verified by --check in CI, and localeCompare is host-locale-sensitive.
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (formatVersion === '' || release === '' || techniques.length === 0) {
    throw new Error(`${sourceFile}: not an ATLAS distribution (no version or no techniques)`);
  }
  const payload = {
    release,
    formatVersion,
    source: SOURCE_URL,
    sha256: createHash('sha256').update(raw).digest('hex'),
    techniques,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

const checkMode = process.argv.includes('--check');
const derived = derive();
if (!checkMode) {
  writeFileSync(outFile, derived);
  const count = (JSON.parse(derived) as { techniques: unknown[] }).techniques.length;
  process.stdout.write(`atlas.json: ${count} techniques\n`);
} else if (readFileSync(outFile, 'utf8') !== derived) {
  process.stderr.write(`${OUT_OF_DATE}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('atlas.json is current\n');
}
