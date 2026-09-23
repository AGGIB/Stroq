import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POST_MATCHER, PRE_MATCHER } from '../../src/commands/init.js';
import { agentFindings, agentSurface } from '../../src/exposure/surface.js';

const fixture = (): string => mkdtempSync(join(tmpdir(), 'stroq-exposure-'));

const stroq = [{ type: 'command', command: 'stroq hook claude-code' }];

/** The full install `stroq init` writes: both events, with its own matchers. */
const withStroqClaudeHooks = (cwd: string, events = ['PreToolUse', 'PostToolUse']): void => {
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  const matcher = (event: string): string => (event === 'PreToolUse' ? PRE_MATCHER : POST_MATCHER);
  writeFileSync(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: Object.fromEntries(events.map((e) => [e, [{ matcher: matcher(e), hooks: stroq }]])),
    }),
  );
};

describe('agentSurface', () => {
  it('reports an agent as undetected when its config directory is absent', () => {
    const surfaces = agentSurface(fixture(), fixture());
    expect(surfaces.every((s) => !s.detected)).toBe(true);
  });

  it('covers every agent stroq init can install hooks for', () => {
    expect(agentSurface(fixture(), fixture()).map((s) => s.agent)).toEqual([
      'claude-code',
      'cursor',
      'codex',
      'copilot',
      'openclaw',
      'windsurf',
      'antigravity',
    ]);
  });

  it('detects an agent from its project config directory', () => {
    const cwd = fixture();
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    const cursor = agentSurface(cwd, fixture()).find((s) => s.agent === 'cursor');
    expect(cursor?.detected).toBe(true);
    expect(cursor?.protected).toBe(false);
  });

  it('reports an agent as protected when a Stroq hook is installed', () => {
    const cwd = fixture();
    withStroqClaudeHooks(cwd);
    const claude = agentSurface(cwd, fixture()).find((s) => s.agent === 'claude-code');
    expect(claude?.detected).toBe(true);
    expect(claude?.protected).toBe(true);
  });

  // The same definition `doctor` and `stroq run` use (A-06): a post-only install
  // scans what the agent read but blocks nothing, so it is not protection.
  it('does not report a post-only install as protected', () => {
    const cwd = fixture();
    withStroqClaudeHooks(cwd, ['PostToolUse']);
    const claude = agentSurface(cwd, fixture()).find((s) => s.agent === 'claude-code');
    expect(claude?.protected).toBe(false);
  });

  it('treats an unreadable config as unprotected rather than throwing', () => {
    const cwd = fixture();
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    writeFileSync(join(cwd, '.cursor', 'hooks.json'), '{ not json');
    expect(() => agentSurface(cwd, fixture())).not.toThrow();
    expect(agentSurface(cwd, fixture()).find((s) => s.agent === 'cursor')?.protected).toBe(false);
  });
});

describe('agentFindings', () => {
  it('raises one critical finding per detected-but-unprotected agent', () => {
    const findings = agentFindings([
      { agent: 'cursor', detected: true, protected: false },
      { agent: 'codex', detected: true, protected: true },
      { agent: 'windsurf', detected: false, protected: false },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.class).toBe('agent-unprotected');
    expect(findings[0]?.severity).toBe('critical');
    expect(findings[0]?.fix).toBe('stroq init --agent cursor');
    expect(findings[0]?.detail).toContain('cursor');
  });

  it('raises nothing when every detected agent is protected', () => {
    expect(agentFindings([{ agent: 'codex', detected: true, protected: true }])).toHaveLength(0);
  });
});
