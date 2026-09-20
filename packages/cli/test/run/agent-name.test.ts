import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentHookStatus } from '../../src/commands/doctor.js';
import { LAUNCH_COMMANDS, agentIdFor } from '../../src/run/agent-name.js';

describe('agentIdFor', () => {
  // The table is only useful if every id in it is one `stroq doctor` can answer
  // about; an id that is right in spirit and wrong in spelling reads as "Stroq does
  // not support this agent", which is the one answer that must never be wrong.
  it('maps every launch command it knows to an agent stroq doctor also knows', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'stroq-agent-name-'));
    for (const [command, id] of Object.entries(LAUNCH_COMMANDS)) {
      expect(agentIdFor(command, 'linux')).toBe(id);
      expect(agentHookStatus(id, cwd), `doctor does not know "${id}"`).not.toBeNull();
    }
  });

  it('reads the program out of a path', () => {
    expect(agentIdFor('/opt/homebrew/bin/claude', 'darwin')).toBe('claude-code');
    expect(agentIdFor('./node_modules/.bin/codex', 'linux')).toBe('codex');
  });

  it('knows cursor-agent is the cursor CLI', () => {
    expect(agentIdFor('cursor-agent', 'linux')).toBe('cursor');
  });

  // A shim suffix and a capitalised name are the same program on Windows and a
  // different one on POSIX, where both are ordinary characters in a filename.
  it('folds the Windows shim suffixes and case, and only there', () => {
    expect(agentIdFor('C:\\Program Files\\claude.cmd', 'win32')).toBe('claude-code');
    expect(agentIdFor('CLAUDE.EXE', 'win32')).toBe('claude-code');
    expect(agentIdFor('claude.cmd', 'linux')).toBeNull();
    expect(agentIdFor('CLAUDE', 'linux')).toBeNull();
  });

  it('answers null for a program it cannot place, rather than guessing one', () => {
    expect(agentIdFor('npx', 'linux')).toBeNull();
    expect(agentIdFor('bash', 'linux')).toBeNull();
    expect(agentIdFor('', 'linux')).toBeNull();
  });
});
