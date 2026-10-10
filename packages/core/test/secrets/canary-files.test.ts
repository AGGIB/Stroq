import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileCanaryFiles,
  addCanaryFile,
  canaryFileTouched,
  canaryKey,
} from '../../src/secrets/canary-files.js';

const home = '/home/u';
const decoy = '/home/u/.aws/credentials.bak';
const paths = new Set([canaryKey(decoy, '/', home)]);
const touched = (toolName: string, toolInput: Record<string, unknown>, cwd = '/work') =>
  canaryFileTouched(paths, toolName, toolInput, cwd, home);

describe('canaryFileTouched', () => {
  it.each([
    ['Read', { file_path: decoy }, '/work'],
    ['Read', { file_path: '~/.aws/credentials.bak' }, '/work'],
    ['Read', { file_path: 'credentials.bak' }, '/home/u/.aws'],
    ['Read', { file_path: '/home/u/.aws/./credentials.bak' }, '/work'],
    ['Grep', { pattern: 'key', path: decoy }, '/work'],
    ['Bash', { command: 'cat ~/.aws/credentials.bak' }, '/work'],
    ['Bash', { command: 'cat "$HOME/.aws/credentials.bak" | head' }, '/work'],
    ['Bash', { command: 'grep -r key ${HOME}/.aws/credentials.bak' }, '/work'],
    ['Bash', { command: 'cat credentials.bak' }, '/home/u/.aws'],
  ])('sees %s touch the decoy: %j', (toolName, toolInput, cwd) => {
    // Compared as keys: on Windows the resolved path gains the current drive.
    const hit = touched(toolName, toolInput, cwd);
    expect(hit === null ? null : canaryKey(hit, '/', home)).toBe(canaryKey(decoy, '/', home));
  });

  it.each([
    ['Read', { file_path: '/home/u/.aws/credentials' }],
    ['Bash', { command: 'ls ~/.aws' }],
    ['Bash', { command: 'cat credentials.bak' }],
    ['Read', { file_path: '/home/u/.aws/credentials.bak.old' }],
    ['WebFetch', { url: 'https://example.com/home/u/.aws/credentials.bak' }],
  ])('leaves %s alone when it is not the decoy: %j', (toolName, toolInput) => {
    expect(touched(toolName, toolInput)).toBeNull();
  });

  it('never fires with no decoys registered', () => {
    expect(canaryFileTouched(new Set(), 'Read', { file_path: decoy }, '/w', home)).toBeNull();
  });

  // Claude Code runs a command through `PowerShell` and `Monitor` as well as `Bash`, and the
  // check read the command of `Bash` only: the same decoy, named in the same words, was
  // denied from one tool and opened from the other two.
  describe.each(['PowerShell', 'Monitor'])('a command run by %s', (tool) => {
    it.each([
      'cat ~/.aws/credentials.bak',
      'Get-Content ~/.aws/credentials.bak',
      'Get-Content "$HOME/.aws/credentials.bak" | Select-Object -First 3',
      'type /home/u/.aws/credentials.bak',
      'tail -f ${HOME}/.aws/credentials.bak',
    ])('sees the decoy named in it: %s', (command) => {
      const hit = touched(tool, { command });
      expect(hit === null ? null : canaryKey(hit, '/', home)).toBe(canaryKey(decoy, '/', home));
    });

    it('resolves a relative name against the directory it runs in', () => {
      const hit = touched(tool, { command: 'Get-Content credentials.bak' }, '/home/u/.aws');
      expect(hit === null ? null : canaryKey(hit, '/', home)).toBe(canaryKey(decoy, '/', home));
    });

    it.each([
      'Get-ChildItem ~/.aws',
      'Get-Content ~/.aws/credentials',
      'Get-Content ~/.aws/credentials.bak.old',
      'Write-Output "nothing to see"',
    ])('leaves a command that does not name the decoy alone: %s', (command) => {
      expect(touched(tool, { command })).toBeNull();
    });

    it('reads nothing from a call without a command string', () => {
      for (const input of [{}, { command: 7 }, { command: [decoy] }, { script: decoy }])
        expect(touched(tool, input), JSON.stringify(input)).toBeNull();
    });
  });
});

// A decoy is named in the words of the shell that is asked to open it, and for `PowerShell` and `cmd` the home is
// not `~` or `$HOME`: it is `$env:USERPROFILE`, `$env:HOME`, `${env:HOME}` or `%USERPROFILE%`, written with either
// separator and in any case, and a parameter can carry its value after a colon (`-Path:~/x`), which is one word.
describe('the decoy named the way a Windows shell names it', () => {
  const key = canaryKey(decoy, '/', home);
  const keyOf = (path: string, cwd = '/work') => canaryKey(path, cwd, home);

  it.each([
    '$env:USERPROFILE\\.aws\\credentials.bak',
    '$env:USERPROFILE/.aws/credentials.bak',
    '$ENV:userprofile\\.aws\\credentials.bak',
    '$env:HOME/.aws/credentials.bak',
    '${env:HOME}/.aws/credentials.bak',
    '${env:USERPROFILE}\\.aws\\credentials.bak',
    '%USERPROFILE%\\.aws\\credentials.bak',
    '%userprofile%/.aws/credentials.bak',
    '$HOME\\.aws\\credentials.bak',
    '$home/.aws/credentials.bak',
  ])('has the key of the decoy: %s', (spelling) => {
    expect(keyOf(spelling)).toBe(key);
  });

  it.each([
    '$env:USERPROFILEX/.aws/credentials.bak',
    '$env:OTHER/.aws/credentials.bak',
    '%USERPROFILE%x/.aws/credentials.bak',
    '%USERPROFILE/.aws/credentials.bak',
    'x$env:USERPROFILE/.aws/credentials.bak',
    '$env:USERPROFILE/.aws/credentials',
  ])('is not the decoy: %s', (spelling) => {
    expect(keyOf(spelling)).not.toBe(key);
  });

  describe.each(['PowerShell', 'Monitor', 'Bash'])('a command run by %s', (tool) => {
    it.each([
      'Get-Content $env:USERPROFILE\\.aws\\credentials.bak',
      'Get-Content "$env:USERPROFILE\\.aws\\credentials.bak"',
      'Get-Content ${env:HOME}/.aws/credentials.bak',
      'Get-Content $env:HOME\\.aws\\credentials.bak | Select-Object -First 3',
      'type %USERPROFILE%\\.aws\\credentials.bak',
      'Get-Content -Path:~/.aws/credentials.bak',
      'Get-Content -Path:"$env:USERPROFILE\\.aws\\credentials.bak"',
      'Get-Content -LiteralPath:$env:USERPROFILE/.aws/credentials.bak -Raw',
      "Get-Content -Path:'~/.aws/credentials.bak'",
    ])('sees the decoy named in it: %s', (command) => {
      const hit = touched(tool, { command });
      expect(hit === null ? null : canaryKey(hit, '/', home)).toBe(key);
    });

    it.each([
      'Get-Content -Path:',
      'Get-Content -Path:~/.aws/credentials',
      'Get-ChildItem -Path:$env:USERPROFILE/.aws',
      'Get-Content -Force -Raw ~/.aws/credentials',
      'Write-Output -InputObject:nothing',
      'Get-Content $env:USERPROFILEX/.aws/credentials.bak',
    ])('leaves a command that does not name the decoy alone: %s', (command) => {
      expect(touched(tool, { command })).toBeNull();
    });
  });

  it.each(['Read', 'Grep'])('sees the decoy in the path a call of %s names', (tool) => {
    for (const path of [
      '$env:USERPROFILE\\.aws\\credentials.bak',
      '%USERPROFILE%/.aws/credentials.bak',
    ]) {
      const hit = touched(tool, { file_path: path, path });
      expect(hit === null ? null : canaryKey(hit, '/', home), path).toBe(key);
    }
  });
});

describe('the registry of decoy files', () => {
  it('adds a path once, readable only by the user, and reads it back as keys', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'stroq-canary-files-')), 'canary-files.json');
    addCanaryFile(file, decoy);
    addCanaryFile(file, decoy);
    expect(JSON.parse(readFileSync(file, 'utf8')).files).toEqual([decoy]);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new FileCanaryFiles(file, home).paths().has(canaryKey(decoy, '/', home))).toBe(true);
  });

  it('is empty when there is no registry, or it cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-canary-files-'));
    expect(new FileCanaryFiles(join(dir, 'missing.json'), home).paths().size).toBe(0);
  });
});
