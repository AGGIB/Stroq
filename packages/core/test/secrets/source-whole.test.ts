import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractKeyValues } from '../../src/secrets/extract.js';
import {
  MAX_PROJECT_ENV_FILES,
  extractSourceSecretsWhole,
  projectEnvFiles,
} from '../../src/secrets/index.js';

/**
 * `stroq sent` reads key files once and reports what it could not read. The extractor the live
 * index uses stops at 5,000 lines and 256 KiB, which a padded `.env` can push a key past. Every
 * value here is made up.
 */

const names = (list: readonly { name: string }[]): string[] => list.map((e) => e.name);

describe('extractSourceSecretsWhole', () => {
  it('finds a key after 5,000 lines, which extractKeyValues does not read', () => {
    const text = `${'# padding\n'.repeat(5_001)}API_KEY=FAKEpastTheLines0123456789\n`;
    expect(names(extractKeyValues(text))).toEqual([]);
    expect(extractSourceSecretsWhole('/w/.env', text)).toEqual({
      secrets: [{ name: 'API_KEY', value: 'FAKEpastTheLines0123456789', canary: false }],
      cut: false,
      rejected: 0,
    });
  });

  it('finds a key after 256 KiB of padding, on one line or many', () => {
    for (const pad of ['#'.repeat(300_000), '# x\n'.repeat(80_000)]) {
      const text = `${pad}\nAPI_KEY=FAKEpastTheChars0123456789\n`;
      expect(names(extractKeyValues(text))).toEqual([]);
      expect(names(extractSourceSecretsWhole('/w/.env.local', text).secrets)).toEqual(['API_KEY']);
    }
  });

  it('keeps the keys on both sides of a piece boundary', () => {
    const text = Array.from({ length: 12_000 }, (_, i) =>
      i === 4_999 || i === 5_000 ? `KEY_${i}_TOKEN=FAKEboundary${i}0123456789` : '#',
    ).join('\n');
    expect(names(extractSourceSecretsWhole('/w/.env', text).secrets)).toEqual([
      'KEY_4999_TOKEN',
      'KEY_5000_TOKEN',
    ]);
  });

  it('says when a .netrc or a Docker config is past what the extractor reads', () => {
    const netrc = `machine a.example.test login me password FAKEnetrcPassword0123\n`;
    expect(extractSourceSecretsWhole('/h/.netrc', netrc).cut).toBe(false);
    expect(extractSourceSecretsWhole('/h/.netrc', `${'x '.repeat(20_001)}${netrc}`).cut).toBe(true);
    expect(extractSourceSecretsWhole('/h/.netrc', `${' '.repeat(300_000)}${netrc}`).cut).toBe(true);
    const docker = JSON.stringify({ auths: {}, pad: 'x'.repeat(300_000) });
    expect(extractSourceSecretsWhole('/h/.docker/config.json', docker).cut).toBe(true);
    expect(extractSourceSecretsWhole('/h/.docker/config.json', '{"auths":{}}').cut).toBe(false);
  });
});

describe('projectEnvFiles with a limit of its own', () => {
  it('reads past the index cap when asked, and says how many there are', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-env-files-'));
    for (let i = 0; i < MAX_PROJECT_ENV_FILES + 8; i += 1)
      writeFileSync(join(dir, `.env.${String(i).padStart(3, '0')}`), 'A=1\n');
    writeFileSync(join(dir, '.env.example'), 'A=1\n');
    expect(projectEnvFiles(dir)).toMatchObject({
      truncated: true,
      found: MAX_PROJECT_ENV_FILES + 8,
    });
    expect(projectEnvFiles(dir).files).toHaveLength(MAX_PROJECT_ENV_FILES);
    const wide = projectEnvFiles(dir, 100);
    expect(wide).toMatchObject({ truncated: false, found: MAX_PROJECT_ENV_FILES + 8 });
    expect(wide.files).toHaveLength(MAX_PROJECT_ENV_FILES + 8);
  });
});
