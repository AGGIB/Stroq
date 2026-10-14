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
  JSON.parse(readFileSync(join(root, 'synthetic', name), 'utf8'));

describe('Cursor fixture hygiene (synthetic and measured)', () => {
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

  it('does not claim any measured host version or OS', () => {
    const manifest = read('manifest.json');
    expect(manifest['host']).toBe('cursor');
    expect(manifest['kind']).toBe('synthetic');
    expect(manifest['version']).toBeNull();
    expect(manifest['os']).toBeNull();
    expect(manifest['recordedDate']).toBeNull();
    expect(String(manifest['provenance'])).toContain('Cursor was not started');
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
