// Sanitizes candidate observations; it never upgrades them to verified host evidence.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanFixture, leaksIn } from '../packages/cli/test/live/drivers/clean-fixture.js';

const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error(
    'usage: tsx scripts/clean-cursor-fixture.ts <raw directory> <new candidate directory>',
  );
if (existsSync(output)) throw new Error('use a new candidate directory');
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid capture JSON; inspect the raw file locally');
  }
}
const location = safeJson(readFileSync(join(input, 'location.json'), 'utf8')) as {
  project?: string;
  home?: string;
  stroqHome?: string;
  root?: string;
};
const version = safeJson(readFileSync(join(input, 'version.json'), 'utf8')) as Record<
  string,
  unknown
>;
if (
  !location.project ||
  !location.root ||
  typeof version['version'] !== 'string' ||
  !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version['version']) ||
  !['darwin', 'linux', 'win32'].includes(String(version['os']))
)
  throw new Error('missing capture metadata; no version or OS is invented');
const hooks = readFileSync(join(input, 'hooks.jsonl'), 'utf8');
if (!hooks.trim()) throw new Error('no host hook invocations were recorded');
const files = [
  'hooks.jsonl',
  ...readdirSync(input).filter((name) => name.endsWith('.snapshot.json')),
];
if (files.length < 3) throw new Error('record before and after disk snapshots');
const renames = [
  [location.project, '/tmp/stroq-live-fixture/project'],
  [location.stroqHome ?? '', '/tmp/stroq-live-fixture/stroq-home'],
  [location.home ?? '', '/tmp/stroq-live-fixture/home'],
  [location.root, '/tmp/stroq-live-fixture'],
].filter(([from]) => from !== '') as [string, string][];
renames.push(
  ...renames.map(([from, to]): [string, string] => [JSON.stringify(from).slice(1, -1), to]),
);
const candidates = files.map((name) => {
  const raw = readFileSync(join(input, name), 'utf8');
  if (
    /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"(?:password|api_key|authorization|access_token)"\s*:/i.test(
      raw,
    )
  )
    throw new Error('raw capture contains possible credentials; remove them before cleaning');
  const lines = name.endsWith('.jsonl') ? raw : JSON.stringify(safeJson(raw));
  let relocated = lines;
  // Relocate the exact project before the generic home anonymizer changes its prefix.
  for (const [from, to] of renames) relocated = relocated.split(from).join(to);
  let cleaned: string;
  try {
    cleaned = cleanFixture(relocated);
  } catch {
    throw new Error('invalid hook JSONL; inspect the raw file locally');
  }
  if (leaksIn(cleaned).length)
    throw new Error('candidate still contains private paths or identities');
  return [name, cleaned] as const;
});
mkdirSync(output, { recursive: true });
for (const [name, text] of candidates) writeFileSync(join(output, name), text);
writeFileSync(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      host: 'cursor',
      version: version['version'],
      os: version['os'],
      kind: 'unverified-host-capture',
      provenance:
        'Raw hook invocations and disk snapshots; human correlation and deny/control verification remain required.',
      files: files,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'Sanitized candidate written. It is not a verified contract or a completed #209 measurement.',
);
