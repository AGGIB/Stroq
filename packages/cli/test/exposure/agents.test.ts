import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  antigravityHooksPath,
  installAntigravityHooks,
} from '../../src/commands/antigravity-hooks.js';
import { copilotHooksPath, installCopilotHooks } from '../../src/commands/copilot-hooks.js';
import { POST_MATCHER, PRE_MATCHER } from '../../src/commands/init.js';
import { recordInstall } from '../../src/commands/install-record.js';
import {
  devinHooksPath,
  installWindsurfHooks,
  windsurfHooksPath,
} from '../../src/commands/windsurf-hooks.js';
import { agentFindings, agentSurface, type AgentSurface } from '../../src/exposure/surface.js';

const fixture = (): string => mkdtempSync(join(tmpdir(), 'stroq-exposure-'));

const stroq = [{ type: 'command', command: 'stroq hook claude-code' }];

/** The full install `stroq init` writes: all three events, with its own matchers. */
const withStroqClaudeHooks = (
  cwd: string,
  events = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'],
): void => {
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

// `doctor` and `exposure` must not disagree about whether Windsurf is guarded: Devin
// Desktop reads `.devin/hooks.json` first and ignores `.windsurf/hooks.json` while it
// defines hooks, so an install in the second is not protection.
describe('agentSurface for windsurf', () => {
  const windsurf = (cwd: string) =>
    agentSurface(cwd, fixture()).find((s) => s.agent === 'windsurf');

  it('reports a complete project install as protected', () => {
    const cwd = fixture();
    installWindsurfHooks(windsurfHooksPath('project', cwd), 'stroq hook windsurf');
    expect(windsurf(cwd)?.protected).toBe(true);
  });

  it('does not report an install that the project .devin/hooks.json shadows as protected', () => {
    const cwd = fixture();
    installWindsurfHooks(windsurfHooksPath('project', cwd), 'stroq hook windsurf');
    mkdirSync(join(cwd, '.devin'), { recursive: true });
    writeFileSync(
      devinHooksPath(cwd),
      JSON.stringify({ hooks: { pre_run_command: [{ command: 'echo hi' }] } }),
    );
    expect(windsurf(cwd)?.detected).toBe(true);
    expect(windsurf(cwd)?.protected).toBe(false);
    // `init --agent windsurf` writes the file that is skipped, so it is not the way out.
    expect(windsurf(cwd)?.fix).toBe('stroq init --agent windsurf --user');
    expect(agentFindings([windsurf(cwd) as AgentSurface])[0]?.fix).toBe(
      'stroq init --agent windsurf --user',
    );
  });
});

// An entry rewritten to another command still ends ` hook claude-code`, so it still reads as an
// install; `doctor` fails that line on its own, and `exposure` must not call it protection.
describe('agentSurface for an entry that is no longer the command init wrote', () => {
  const claude = (cwd: string) =>
    agentSurface(cwd, fixture()).find((s) => s.agent === 'claude-code');
  const rewrite = (cwd: string, command: string): void => {
    const events = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
    const matcher = (event: string): string =>
      event === 'PreToolUse' ? PRE_MATCHER : POST_MATCHER;
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: Object.fromEntries(
          events.map((e) => [e, [{ matcher: matcher(e), hooks: [{ type: 'command', command }] }]]),
        ),
      }),
    );
  };

  it('does not report it as protected, and says why in the finding', () => {
    const saved = process.env['STROQ_HOME'];
    process.env['STROQ_HOME'] = fixture();
    try {
      const cwd = fixture();
      withStroqClaudeHooks(cwd);
      recordInstall('claude-code', 'project', 'stroq hook claude-code');
      expect(claude(cwd)?.protected).toBe(true);
      rewrite(cwd, '/tmp/evil hook claude-code');
      const surface = claude(cwd) as AgentSurface;
      expect(surface.detected).toBe(true);
      expect(surface.protected).toBe(false);
      expect(surface.changed).toBe(true);
      const [finding] = agentFindings([surface]);
      expect(finding?.detail).toContain('no longer the command');
      expect(finding?.fix).toBe('stroq init --agent claude-code');
    } finally {
      if (saved === undefined) delete process.env['STROQ_HOME'];
      else process.env['STROQ_HOME'] = saved;
    }
  });
});

// Every agent is asked about the way `doctor` asks, so a rewritten entry is called what it is for
// all of them: Copilot and Antigravity read as protected for as long as an entry ends ` hook <agent>`.
describe('agentSurface for a rewritten entry of Copilot and Antigravity', () => {
  // No quoted program and entry: doctor reads such a command's paths and calls missing ones broken.
  const command = (agent: string): string => `stroq hook ${agent}`;

  it.each<[string, (cwd: string, written: string) => void]>([
    [
      'copilot',
      (cwd, written) =>
        installCopilotHooks(copilotHooksPath('project', cwd), `${written} pre`, `${written} post`),
    ],
    [
      'antigravity',
      (cwd, written) => installAntigravityHooks(antigravityHooksPath('project', cwd), written),
    ],
  ])('reports %s as changed, not protected, once its entry is another command', (agent, write) => {
    const saved = process.env['STROQ_HOME'];
    process.env['STROQ_HOME'] = fixture();
    try {
      const cwd = fixture();
      const find = (): AgentSurface =>
        agentSurface(cwd, fixture()).find((s) => s.agent === agent) as AgentSurface;
      write(cwd, command(agent));
      recordInstall(agent, 'project', command(agent));
      expect(find().protected).toBe(true);
      expect(find().changed).toBeUndefined();
      write(cwd, `/tmp/evil hook ${agent}`);
      expect(find().protected).toBe(false);
      expect(find().changed).toBe(true);
    } finally {
      if (saved === undefined) delete process.env['STROQ_HOME'];
      else process.env['STROQ_HOME'] = saved;
    }
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
