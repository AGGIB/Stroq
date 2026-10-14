import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { leaksIn, FIXTURE_PROJECT } from './clean-fixture.js';

const root = fileURLToPath(new URL('../../fixtures/hosts/cursor/', import.meta.url));
const files = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.jsonl?$/.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name));

const read = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, '0.46.11', name), 'utf8'));

describe('recorded Cursor conformance fixtures', () => {
  it('has checked-in fixture files', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files.map((file) => [relative(root, file), file]))(
    '%s contains no machine or private data',
    (_name, file) => {
      expect(leaksIn(readFileSync(file!, 'utf8'))).toEqual([]);
    },
  );

  it.each(files.map((file) => [relative(root, file), file]))(
    '%s is valid JSON or JSONL',
    (_name, file) => {
      const content = readFileSync(file!, 'utf8');
      if (file!.endsWith('.json')) {
        expect(() => JSON.parse(content)).not.toThrow();
      } else {
        const lines = content.split('\n').filter((l) => l.trim() !== '');
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(() => JSON.parse(line)).not.toThrow();
        }
      }
    },
  );

  it('records the measured version, OS, date, and provenance in manifest.json', () => {
    const manifest = read('manifest.json');
    expect(manifest['host']).toBe('cursor');
    expect(manifest['version']).toBe('0.46.11');
    expect(manifest['os']).toBe('darwin');
    expect(manifest['recordedDate']).toBe('2026-10-14');
    expect(String(manifest['provenance'])).toContain('Cursor 0.46.11');
    expect(manifest['events']).toEqual([
      'allow.write',
      'allow.post-edit',
      'deny.write',
      'allow.delete',
      'deny.delete',
    ]);
  });

  it('rejects raw credentials and private-path data', () => {
    const leakedExamples = [
      '/Users/alice/projects/app',
      'C:\\Users\\bob\\Desktop',
      '/var/folders/zz/12345/T',
      'stroq-capture-secret123',
      'AppData/Local/Temp',
      '"slash_commands":["test"]',
    ];

    for (const example of leakedExamples) {
      expect(leaksIn(example), example).not.toEqual([]);
    }
  });

  it('accepts sanitized fixture root and fixture user', () => {
    expect(leaksIn(`${FIXTURE_PROJECT} /Users/fixture-user`)).toEqual([]);
  });
});
