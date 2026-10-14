// Clean a raw Cursor capture directory into sanitized fixtures.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanFixture, leaksIn } from '../packages/cli/test/live/drivers/clean-fixture.js';

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  throw new Error('usage: tsx scripts/clean-cursor-fixture.ts <raw directory> <fixture directory>');
}

const location = JSON.parse(readFileSync(join(input, 'location.json'), 'utf8')) as {
  project?: string;
  root?: string;
};
const rawProject = location.project ?? location.root ?? '';
const fixtureRoot = '/tmp/stroq-live-fixture';
const fixtureProject = '/tmp/stroq-live-fixture/project';

const cleanPaths = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cleanPaths);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, cleanPaths(each)]));
  }
  if (typeof value !== 'string') return value;
  return value
    .replaceAll(rawProject.replaceAll('\\', '/'), fixtureProject)
    .replaceAll(rawProject.replaceAll('\\', '\\\\'), fixtureProject)
    .replaceAll(rawProject, fixtureProject)
    .replace(/(?:[A-Za-z]:)?(?:\\+|\/)Users(?:\\+|\/)[^\\/\s"']+/g, '/Users/fixture-user')
    .replace(/(?:[A-Za-z]:)?(?:\\+|\/)home(?:\\+|\/)[^\\/\s"']+/g, '/Users/fixture-user');
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
  if (leaks.length > 0) {
    throw new Error(`not written: cleaned text still matches ${leaks.join(', ')}`);
  }
  return result;
};

mkdirSync(output, { recursive: true });

// Copy / clean version and create manifest
if (existsSync(join(input, 'version.json'))) {
  const versionInfo = JSON.parse(readFileSync(join(input, 'version.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const manifest = {
    host: 'cursor',
    version: versionInfo['version'] ?? '0.46.11',
    os: versionInfo['os'] ?? 'darwin',
    recordedDate: versionInfo['date'] ?? new Date().toISOString().slice(0, 10),
    provenance: `Captured in an authorized throwaway project with real Cursor ${versionInfo['version'] ?? '0.46.11'} on ${versionInfo['os'] ?? 'darwin'}, verifying the preToolUse Write/Delete and afterFileEdit hook contract.`,
    events: ['allow.write', 'allow.post-edit', 'deny.write', 'allow.delete', 'deny.delete'],
    cleanup:
      'Cleaned via scripts/clean-cursor-fixture.ts to sanitize user paths, session IDs, and secrets.',
  };
  writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

const eventPrefixes = [
  'allow.write',
  'allow.post-edit',
  'deny.write',
  'allow.delete',
  'deny.delete',
];

for (const prefix of eventPrefixes) {
  const eventFile = join(input, `${prefix}.event.json`);
  if (existsSync(eventFile)) {
    const raw = readFileSync(eventFile, 'utf8');
    const text = cleaned(raw);
    writeFileSync(
      join(output, `${prefix}.event.json`),
      `${JSON.stringify(JSON.parse(text), null, 2)}\n`,
    );
  }

  const evidenceFile = join(input, `${prefix}.evidence.json`);
  if (existsSync(evidenceFile)) {
    const raw = readFileSync(evidenceFile, 'utf8');
    const text = cleaned(raw);
    writeFileSync(
      join(output, `${prefix}.evidence.json`),
      `${JSON.stringify(JSON.parse(text), null, 2)}\n`,
    );
  }
}

// Clean audit logs if present
const auditFile = join(input, 'audit.jsonl');
if (existsSync(auditFile)) {
  const auditRaw = readFileSync(auditFile, 'utf8');
  if (auditRaw.trim() !== '') {
    const cleanedAudit = cleaned(auditRaw);
    writeFileSync(join(output, 'audit.jsonl'), cleanedAudit);
  }
}

console.log(`Cleaned Cursor fixtures written to ${output}`);
