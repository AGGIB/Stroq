// Clean a real capture directory. Authentication files are neither read nor copied.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanFixture, leaksIn } from '../packages/cli/test/live/drivers/clean-fixture.js';

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined)
  throw new Error('usage: tsx scripts/clean-codex-fixture.ts <raw directory> <fixture directory>');
const location = JSON.parse(readFileSync(join(input, 'location.json'), 'utf8')) as { root: string };
const fixtureRoot = '/tmp/stroq-live-fixture';
const cleanPaths = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cleanPaths);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, cleanPaths(each)]));
  if (typeof value !== 'string') return value;
  return value
    .replaceAll(location.root.replaceAll('\\', '/'), fixtureRoot)
    .replaceAll(location.root.replaceAll('\\', '\\\\'), fixtureRoot)
    .replaceAll(location.root, fixtureRoot)
    .replace(/(?:[A-Za-z]:)?(?:\\+|\/)Users(?:\\+|\/)[^\\/\s"']+/g, 'C:/Users/fixture-user');
};
const cleaned = (text: string): string => {
  const result = cleanFixture(
    text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.stringify(cleanPaths(JSON.parse(line))))
      .join('\n'),
  );
  const leaks = leaksIn(result);
  if (leaks.length > 0)
    throw new Error(`not written: cleaned text still matches ${leaks.join(', ')}`);
  return result;
};
mkdirSync(output, { recursive: true });
for (const name of ['version', 'login']) {
  const text = cleaned(readFileSync(join(input, `${name}.json`), 'utf8'));
  writeFileSync(join(output, `${name}.json`), `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
}
for (const name of ['allow.real', 'deny.real', 'deny.control']) {
  const invocationText = readFileSync(join(input, `${name}.invocation.json`), 'utf8');
  const nonce = /stroq-live-[0-9a-f]{16}/.exec(invocationText)?.[0];
  if (nonce === undefined) throw new Error(`no nonce in ${name}`);
  for (const suffix of ['jsonl', 'evidence.json', 'invocation.json']) {
    const text = cleaned(readFileSync(join(input, `${name}.${suffix}`), 'utf8'));
    writeFileSync(
      join(output, `${name}.${suffix}`),
      suffix.endsWith('.json') ? `${JSON.stringify(JSON.parse(text), null, 2)}\n` : text,
    );
  }
  const audit = readFileSync(join(input, `${name}.audit.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.includes(nonce))
    .join('\n');
  writeFileSync(join(output, `${name}.audit.jsonl`), audit === '' ? '' : cleaned(audit));
  // Unrelated plugin-cache/network logs are omitted. Preserve the host's own hook denial verbatim
  // except for paths, UUIDs and the test nonce, using JSON as a lossless container for the text.
  const stderr = readFileSync(join(input, `${name}.stderr.txt`), 'utf8')
    .split('\n')
    .filter((line) =>
      line.includes('ERROR codex_core::tools::router: error=Command blocked by PreToolUse hook:'),
    )
    .map((text) => JSON.stringify({ text }))
    .join('\n');
  writeFileSync(join(output, `${name}.stderr.jsonl`), stderr === '' ? '' : cleaned(stderr));
}
