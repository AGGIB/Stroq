import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractKeyValues, extractKeyValuesCounted } from '../../src/secrets/extract.js';
import {
  extractSourceSecretsWhole,
  FileSecretIndex,
  projectEnvFiles,
  projectFolders,
} from '../../src/secrets/index.js';

/**
 * Keys a user really keeps, read where they keep them: a quoted value with a comment after it, an
 * AWS secret that starts with a slash, the password in a database URL, `.env.production.local`,
 * `prod.env`, `.envrc`, and the `.env` of the repository a session ran in a folder of. Every value
 * is made up.
 */

const v = (n: number): string => `FAKEvalue${n}Zq0123456789abcdefQQ`;
const values = (text: string): string[] => extractKeyValues(text).map((s) => s.value);

describe('a quoted value', () => {
  it('is read to its closing quote, with a comment after it left out', () => {
    expect(values(`DQ_API_KEY="${v(1)}" # prod\n`)).toEqual([v(1)]);
    expect(values(`SQ_API_KEY='${v(2)}' # prod\n`)).toEqual([v(2)]);
    expect(values(`DQ_API_KEY="${v(3)}"\n`)).toEqual([v(3)]);
  });

  // Loaders read escapes differently (dotenv keeps `\\$`, a shell takes the backslash out): both
  // the value as written between the quotes and the value with its escapes taken out are keys.
  it('a double-quoted value with escapes: as written and unescaped, both', () => {
    expect(values(`ESC_API_KEY="${v(4)}\\$tail"\n`)).toEqual([`${v(4)}\\$tail`, `${v(4)}$tail`]);
    expect(values(`QUOTE_API_KEY="${v(12)}\\"x"\n`)).toEqual([`${v(12)}\\"x`, `${v(12)}"x`]);
  });

  it('a double-quoted value with no escape: one key', () => {
    expect(values(`PLAIN_API_KEY="${v(13)}"\n`)).toEqual([v(13)]);
  });

  it('a single-quoted value is as written: a backslash stays', () => {
    expect(values(`SQ_API_KEY='${v(14)}\\$x'\n`)).toEqual([`${v(14)}\\$x`]);
  });

  it('a value whose quote is not closed on its line: what follows the quote', () => {
    expect(values(`MULTI_API_KEY="line1${v(5)}\nline2"\n`)).toEqual([`line1${v(5)}`]);
  });

  it('an unquoted value still drops a comment', () => {
    expect(values(`COMMENT_API_KEY=${v(6)} # prod\n`)).toEqual([v(6)]);
  });
});

describe('an AWS secret access key', () => {
  it('is a key even when it starts with a slash', () => {
    const secret = '/FAKEawsSecretStartsWithSlash0123456789abc';
    expect(values(`[default]\naws_secret_access_key = ${secret}\n`)).toEqual([secret]);
  });

  it('any other value that starts like a path is still not one', () => {
    expect(values('DB_PASSWORD=/etc/ssl/private/key.pem\n')).toEqual([]);
  });
});

// A URL password is a key for `stroq sent`, which asks for it; the live guard does not, so a
// command that uses the project's own database URL is not denied.
describe('a password in a URL value', () => {
  const urls = `DATABASE_URL=postgres://app:${v(7)}@db.internal:5432/app\nREDIS_URL=redis://:${v(8)}@cache:6379\n`;

  it('is no key unless the reader asks for it', () => {
    expect(extractKeyValues(urls)).toEqual([]);
    expect(extractSourceSecretsWhole('/w/.env', urls).secrets).toEqual([]);
  });

  it('asked for, is a key of its own, whatever the variable is named', () => {
    expect(
      extractSourceSecretsWhole('/w/.env', urls, { urlPasswords: true }).secrets.map((s) => [
        s.name,
        s.value,
      ]),
    ).toEqual([
      ['DATABASE_URL:password', v(7)],
      ['REDIS_URL:password', v(8)],
    ]);
  });

  it('the live guard does not index it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stroq-env-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'stroq-env-url-'));
    writeFileSync(join(cwd, '.env'), urls);
    const index = new FileSecretIndex(join(home, 'secrets.json'), home, {});
    expect(await index.lookup([{ token: v(7), raw: v(7) }], cwd)).toEqual([]);
  });

  it('asked for, and not there', () => {
    const found = extractKeyValues(
      `DATABASE_URL=postgres://app:${v(7)}@db.internal:5432/app\nREDIS_URL=redis://:${v(8)}@cache:6379\n`,
      { urlPasswords: true },
    );
    expect(found.map((s) => [s.name, s.value])).toEqual([
      ['DATABASE_URL:password', v(7)],
      ['REDIS_URL:password', v(8)],
    ]);
  });

  it('a URL with no password, or a short one, gives none', () => {
    expect(
      extractKeyValues(
        'DATABASE_URL=postgres://db.internal:5432/app\nAPI_URL=https://u:pw@x.example\n',
        { urlPasswords: true },
      ),
    ).toEqual([]);
  });
});

describe('a line named like a key whose value is not compared', () => {
  it('is counted', () => {
    const read = extractKeyValuesCounted(
      'API_KEY=changeme\nDB_PASSWORD=short\nPORT=3000\nNEXTAUTH_URL=http://localhost:3000\n',
    );
    expect(read.secrets).toEqual([]);
    expect(read.rejected).toBe(2);
  });
});

describe('the project files read', () => {
  const folder = (files: readonly string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-env-names-'));
    for (const f of files) writeFileSync(join(dir, f), `API_KEY=${v(9)}\n`);
    return dir;
  };

  it('take every .env name with more dots, *.env and .envrc, never an example', () => {
    const dir = folder([
      '.env',
      '.env.local',
      '.env.production.local',
      '.env.development.local',
      'prod.env',
      '.envrc',
      '.env.example',
      'example.env',
      '.env.sample.local',
      'env.txt',
    ]);
    expect(projectEnvFiles(dir).files.map((f) => f.slice(dir.length + 1))).toEqual([
      '.env',
      '.env.development.local',
      '.env.local',
      '.env.production.local',
      '.envrc',
      'prod.env',
    ]);
  });

  it('a folder in a repository: the folders above it up to the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'stroq-env-repo-'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'packages', 'api'), { recursive: true });
    expect(projectFolders(join(root, 'packages', 'api'))).toEqual([
      join(root, 'packages', 'api'),
      join(root, 'packages'),
      root,
    ]);
  });

  it('a folder in no repository: that folder alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-env-none-'));
    expect(projectFolders(dir)).toEqual([dir]);
  });

  it('the live guard finds an escaped value in both of its forms', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stroq-env-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'stroq-env-esc-'));
    writeFileSync(join(cwd, '.env'), `ESC_API_KEY="${v(15)}\\$tail"\n`);
    const index = new FileSecretIndex(join(home, 'secrets.json'), home, {});
    for (const token of [`${v(15)}\\$tail`, `${v(15)}$tail`]) {
      const hits = await index.lookup([{ token, raw: token }], cwd);
      expect(
        hits.map((h) => h.name),
        token,
      ).toEqual(['ESC_API_KEY']);
    }
  });

  it('the live guard finds a key in .env.development.local and in the repository root', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stroq-env-home-'));
    const root = mkdtempSync(join(tmpdir(), 'stroq-env-guard-'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'app', '.env.development.local'), `API_KEY=${v(10)}\n`);
    writeFileSync(join(root, '.env'), `ROOT_API_KEY=${v(11)}\n`);
    const index = new FileSecretIndex(join(home, 'secrets.json'), home, {});
    const hits = await index.lookup(
      [v(10), v(11)].map((token) => ({ token, raw: token })),
      join(root, 'app'),
    );
    expect(hits.map((h) => h.name).sort()).toEqual(['API_KEY', 'ROOT_API_KEY']);
  });
});
