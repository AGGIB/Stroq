import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getAt } from '../../src/harden/json-doc.js';
import { addRules } from '../../src/credential-sandbox/rules.js';
import { binOnPath } from '../../src/run/which.js';

const srt = binOnPath('srt');
it.skipIf(process.platform !== 'darwin' || (!srt && process.env.STROQ_REQUIRE_SRT !== '1'))(
  'the pinned macOS sandbox runtime denies a listed fixture and reads its unlisted neighbour',
  () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-native-key-files-')));
    const key = join(home, '.ssh', 'example');
    mkdirSync(join(home, '.ssh'));
    writeFileSync(key, 'test data only');
    writeFileSync(join(home, 'control'), 'control');
    expect(readFileSync(key, 'utf8')).toBe('test data only');
    const { doc } = addRules({}, [], {});
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
        "try { fs.readFileSync('.ssh/example'); process.exit(3); }",
        "catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }",
        "console.log('control readable, key denied');",
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
    expect(result.stdout).toContain('control readable, key denied');
  },
  20000,
);
