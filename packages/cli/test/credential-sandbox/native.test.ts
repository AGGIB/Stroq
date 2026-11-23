import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getAt } from '../../src/harden/json-doc.js';
import { linkTargets } from '../../src/credential-sandbox/links.js';
import { addRules, BASE_PATHS } from '../../src/credential-sandbox/rules.js';
import { binOnPath } from '../../src/run/which.js';

const srt = binOnPath('srt');
it.skipIf(process.platform !== 'darwin' || (!srt && process.env.STROQ_REQUIRE_SRT !== '1'))(
  'the pinned macOS sandbox runtime denies a listed fixture and the target of a listed link, and reads an unlisted neighbour',
  () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-native-key-files-')));
    const key = join(home, '.ssh', 'example');
    mkdirSync(join(home, '.ssh'));
    writeFileSync(key, 'test data only');
    writeFileSync(join(home, 'control'), 'control');
    expect(readFileSync(key, 'utf8')).toBe('test data only');
    // A listed path kept elsewhere and linked, as a dotfiles folder does it.
    mkdirSync(join(home, 'dotfiles'));
    writeFileSync(join(home, 'dotfiles', 'netrc-real'), 'test data only');
    symlinkSync(join(home, 'dotfiles', 'netrc-real'), join(home, '.netrc'));
    const { targets } = linkTargets(home, [...BASE_PATHS]);
    expect(targets).toEqual({ '~/.netrc': '~/dotfiles/netrc-real' });
    const { doc } = addRules({}, [], {}, targets);
    const settings = join(home, 'srt.json');
    writeFileSync(
      settings,
      JSON.stringify({
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
        credentials: getAt(doc, ['sandbox', 'credentials']),
      }),
    );
    // Fixed operands in a disposable home. The probe returns only the OS result codes.
    writeFileSync(
      join(home, 'check.cjs'),
      [
        "const fs = require('node:fs');",
        "if (fs.readFileSync('control','utf8') !== 'control') process.exit(2);",
        "for (const [file, code] of [['.ssh/example', 3], ['.netrc', 4], ['dotfiles/netrc-real', 5]]) {",
        '  try { fs.readFileSync(file); process.exit(code); }',
        "  catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }",
        '}',
        "console.log('control readable, key, link and target denied');",
      ].join('\n'),
    );
    expect(srt).toBeTruthy();
    const result = spawnSync(srt!, ['--settings', settings, process.execPath, 'check.cjs'], {
      cwd: home,
      env: { HOME: home, TMPDIR: tmpdir(), PATH: process.env.PATH, SHELL: '/bin/sh' },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(result.stdout).toContain('control readable, key, link and target denied');
  },
  20000,
);
