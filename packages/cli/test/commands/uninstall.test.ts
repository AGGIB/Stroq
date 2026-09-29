import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  antigravityHooksPath,
  installAntigravityHooks,
} from '../../src/commands/antigravity-hooks.js';
import { codexHooksPath, installCodexHooks } from '../../src/commands/codex-hooks.js';
import { copilotHooksPath, installCopilotHooks } from '../../src/commands/copilot-hooks.js';
import { cursorHooksPath, installCursorHooks } from '../../src/commands/cursor-hooks.js';
import { installHooks, settingsPath } from '../../src/commands/init.js';
import { runUninstall, uninstallAgent } from '../../src/commands/uninstall.js';
import { installWindsurfHooks, windsurfHooksPath } from '../../src/commands/windsurf-hooks.js';

const STROQ = '"/n" "/e.js"';
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stroq-uninstall-'));
  process.env['STROQ_HOME'] = join(cwd, 'home');
});

const json = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

/** Writes `value` to `file` first, so the install merges into a file with the user's own content. */
function seed(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

describe('stroq uninstall', () => {
  it("removes Claude Code's Stroq hooks and keeps the user's own", () => {
    const file = settingsPath('project', cwd);
    seed(file, {
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter' }] }],
      },
    });
    installHooks(file, `${STROQ} hook claude-code`);
    const result = uninstallAgent('claude-code', 'project', cwd, false);
    expect(result.removed).toBe(true);
    expect(json(file)).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter' }] }],
      },
    });
  });

  it('drops the hooks key when Stroq was all it held', () => {
    const file = settingsPath('project', cwd);
    installHooks(file, `${STROQ} hook claude-code`);
    uninstallAgent('claude-code', 'project', cwd, false);
    expect(json(file)).toEqual({});
  });

  it.each([
    ['cursor', cursorHooksPath, installCursorHooks, 'hook cursor'],
    ['windsurf', windsurfHooksPath, installWindsurfHooks, 'hook windsurf'],
    ['codex', codexHooksPath, installCodexHooks, 'hook codex'],
  ] as const)('removes %s entries and nothing else', (agent, pathFor, install, suffix) => {
    const file = pathFor('project', cwd);
    install(file, `${STROQ} ${suffix}`);
    const before = readFileSync(file, 'utf8');
    expect(before).toContain(suffix);
    expect(uninstallAgent(agent, 'project', cwd, false).removed).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain(suffix);
  });

  it("removes Antigravity's stroq entry and keeps the others", () => {
    const file = antigravityHooksPath('project', cwd);
    seed(file, { mine: { PreToolUse: [] } });
    installAntigravityHooks(file, `${STROQ} hook antigravity`);
    uninstallAgent('antigravity', 'project', cwd, false);
    expect(json(file)).toEqual({ mine: { PreToolUse: [] } });
  });

  it('deletes the Copilot file, which is Stroq’s own', () => {
    const file = copilotHooksPath('project', cwd);
    installCopilotHooks(file, `${STROQ} hook copilot pre`, `${STROQ} hook copilot post`);
    uninstallAgent('copilot', 'project', cwd, false);
    expect(existsSync(file)).toBe(false);
  });

  it('leaves a Copilot file Stroq did not write', () => {
    const file = copilotHooksPath('project', cwd);
    seed(file, { version: 1, hooks: { preToolUse: [{ bash: 'their-tool' }] } });
    expect(uninstallAgent('copilot', 'project', cwd, false).removed).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it('says there is nothing to remove, and writes nothing, when Stroq is not there', () => {
    const file = settingsPath('project', cwd);
    const result = uninstallAgent('claude-code', 'project', cwd, false);
    expect(result.removed).toBe(false);
    expect(result.message).toMatch(/nothing to remove/);
    expect(existsSync(file)).toBe(false);
  });

  it('changes nothing on --dry-run and prints what would be written', () => {
    const file = settingsPath('project', cwd);
    installHooks(file, `${STROQ} hook claude-code`);
    const before = readFileSync(file, 'utf8');
    const result = uninstallAgent('claude-code', 'project', cwd, true);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(result.message).toBe('{}\n');
  });

  it('names the OpenClaw command instead of running it', () => {
    const result = uninstallAgent('openclaw', 'user', cwd, false);
    expect(result.message).toContain('openclaw plugins disable stroq');
  });
});

describe('runUninstall', () => {
  function capture(): { text: () => string; restore: () => void } {
    let text = '';
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      text += String(chunk);
      return true;
    });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      text += String(chunk);
      return true;
    });
    return {
      text: () => text,
      restore: () => {
        out.mockRestore();
        err.mockRestore();
      },
    };
  }

  it('removes the project install from the working directory', async () => {
    const file = settingsPath('project', cwd);
    installHooks(file, `${STROQ} hook claude-code`);
    const where = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const out = capture();
    try {
      expect(await runUninstall([])).toBe(0);
    } finally {
      out.restore();
      where.mockRestore();
    }
    expect(out.text()).toContain("Removed Stroq's hooks");
    expect(json(file)).toEqual({});
  });

  it('refuses an agent it does not know, with exit 2', async () => {
    const out = capture();
    try {
      expect(await runUninstall(['--agent', 'emacs'])).toBe(2);
    } finally {
      out.restore();
    }
    expect(out.text()).toContain('unknown agent "emacs"');
  });

  it('unwraps MCP servers through init --agent mcp --unwrap', async () => {
    const config = join(cwd, 'mcp.json');
    writeFileSync(config, JSON.stringify({ mcpServers: {} }));
    const out = capture();
    try {
      expect(await runUninstall(['--agent', 'mcp', '--config', config, '--dry-run'])).toBe(0);
    } finally {
      out.restore();
    }
  });
});

describe('stroq uninstall --agent codex, on the shapes Codex reads', () => {
  // Codex also reads an event kept at the file's root as a single group object; `init`
  // lifts that shape, and `uninstall` left Stroq's handler in it while reporting it
  // removed.
  it('removes Stroq from a root-level group object and keeps the rest of it', () => {
    const file = codexHooksPath('project', cwd);
    seed(file, {
      PreToolUse: {
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: `${STROQ} hook codex` },
          { type: 'command', command: 'my-own' },
        ],
      },
      hooks: {},
    });
    expect(uninstallAgent('codex', 'project', cwd, false).removed).toBe(true);
    expect(json(file)).toEqual({
      PreToolUse: { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own' }] },
      hooks: {},
    });
  });

  it('drops a root-level group that held only Stroq', () => {
    const file = codexHooksPath('project', cwd);
    seed(file, {
      PostToolUse: {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `${STROQ} hook codex` }],
      },
    });
    uninstallAgent('codex', 'project', cwd, false);
    expect(json(file)).toEqual({});
  });
});
