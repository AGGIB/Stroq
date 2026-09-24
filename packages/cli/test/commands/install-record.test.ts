import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installDrift,
  readInstallRecord,
  recordInstall,
} from '../../src/commands/install-record.js';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function recordFile(): string {
  const home = mkdtempSync(join(tmpdir(), 'stroq-install-record-'));
  homes.push(home);
  return join(home, 'install.json');
}

const CLAUDE_COMMAND = '"/usr/local/bin/node" "/opt/stroq/index.js" hook claude-code';

describe('install record', () => {
  it('reads as empty when nothing was ever installed', () => {
    expect(readInstallRecord(recordFile()).entries).toEqual({});
  });

  it('records a command per agent and scope, readable only by its owner', () => {
    const file = recordFile();
    recordInstall('claude-code', 'project', CLAUDE_COMMAND, file);
    recordInstall('codex', 'user', 'stroq hook codex', file);
    const record = readInstallRecord(file);
    expect(record.entries['claude-code:project']?.command).toBe(CLAUDE_COMMAND);
    expect(record.entries['codex:user']?.command).toBe('stroq hook codex');
    // Windows has no POSIX mode bits: `chmod 0600` is not applied there, and the file is
    // protected by the user profile's ACL instead (see SECURITY.md).
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
  });

  it('keeps earlier entries when a second agent is installed', () => {
    const file = recordFile();
    recordInstall('claude-code', 'project', CLAUDE_COMMAND, file);
    recordInstall('cursor', 'project', 'stroq hook cursor', file);
    expect(Object.keys(readInstallRecord(file).entries).sort()).toEqual([
      'claude-code:project',
      'cursor:project',
    ]);
  });
});

describe('installDrift', () => {
  const file = (): string => {
    const f = recordFile();
    recordInstall('claude-code', 'project', CLAUDE_COMMAND, f);
    return f;
  };

  it('says nothing about an agent that was never recorded', () => {
    expect(installDrift('cursor', 'project', 'anything', readInstallRecord(file()))).toBe(
      'unrecorded',
    );
  });

  // The command is quoted, and a JSON settings file escapes those quotes, so the
  // escaped spelling is what the file on disk actually holds.
  it('finds the command through JSON escaping', () => {
    const settings = JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: CLAUDE_COMMAND }] }] },
    });
    expect(installDrift('claude-code', 'project', settings, readInstallRecord(file()))).toBe(
      'intact',
    );
  });

  it('finds the command unescaped, as a TOML config holds it', () => {
    expect(
      installDrift(
        'claude-code',
        'project',
        `command = ${CLAUDE_COMMAND}\n`,
        readInstallRecord(file()),
      ),
    ).toBe('intact');
  });

  // The whole point: the ownership suffix is a test of intent, not of identity, and
  // the ChainDrop worm writes hook entries into Claude Code's own settings.
  it('reports an entry rewritten to another binary that keeps the Stroq suffix', () => {
    const settings = JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: '/tmp/evil hook claude-code' }] }] },
    });
    expect(installDrift('claude-code', 'project', settings, readInstallRecord(file()))).toBe(
      'changed',
    );
  });

  it('reports an entry that was removed outright', () => {
    expect(installDrift('claude-code', 'project', '{}', readInstallRecord(file()))).toBe('changed');
  });

  it('treats a record it cannot understand as absent rather than as drift', () => {
    const f = recordFile();
    recordInstall('claude-code', 'project', CLAUDE_COMMAND, f);
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    writeFileSync(f, JSON.stringify({ ...raw, version: 99 }));
    expect(installDrift('claude-code', 'project', '{}', readInstallRecord(f))).toBe('unrecorded');
  });
});
