import { describe, expect, it } from 'vitest';
import {
  CLAUDE_ALLOWED_TOOLS,
  NOOP_HOOK_LINE,
  claudeArgv,
  claudeSettings,
  hookCommandFor,
} from '../../../src/live/drivers/claude-argv.js';
import { promptFor } from '../../../src/live/probes.js';
import type { ProbeContext } from '../../../src/live/types.js';
import { NONCE, SESSION } from '../helpers.js';
import { probe } from '../probe-helpers.js';

/**
 * The words the host is started with. These are golden: a change to one of them changes what a live check
 * shows, so it is a change that has to be seen in a diff (the permission mode, above all: `dontAsk` makes
 * the host's own rules block `echo x > file`, and nothing is proven).
 */
const HOOK_LINE = '"/usr/local/bin/node" "/opt/stroq/dist/index.js" hook claude-code';

const ctx = (over: Partial<ProbeContext> = {}): ProbeContext => ({
  project: '/fixed/project',
  stroqHome: '/tmp/root/stroq-home',
  home: '/tmp/root/home',
  sessionId: SESSION,
  nonce: NONCE,
  hookMode: 'real',
  deadlineMs: 60_000,
  env: {},
  ...over,
});

describe('hookCommandFor', () => {
  it('puts the throwaway home in front of the line of the user, and nothing else', () => {
    expect(hookCommandFor(ctx(), HOOK_LINE)).toBe(
      `env HOME=/tmp/root/home USERPROFILE=/tmp/root/home STROQ_HOME=/tmp/root/stroq-home ${HOOK_LINE}`,
    );
  });

  it('quotes a directory that a shell would split or read', () => {
    const command = hookCommandFor(
      ctx({ home: "/tmp/it's here/home", stroqHome: '/tmp/a b/stroq-home' }),
      HOOK_LINE,
    );
    expect(command).toBe(
      `env HOME='/tmp/it'\\''s here/home' USERPROFILE='/tmp/it'\\''s here/home' STROQ_HOME='/tmp/a b/stroq-home' ${HOOK_LINE}`,
    );
  });

  it('is the command that does nothing for a control, whatever the line of the user is', () => {
    expect(hookCommandFor(ctx({ hookMode: 'noop' }), HOOK_LINE)).toBe(NOOP_HOOK_LINE);
    expect(NOOP_HOOK_LINE).toBe('node -e 0');
  });
});

describe('claudeSettings', () => {
  it('is one PreToolUse hook for every tool, with the command given', () => {
    expect(JSON.parse(claudeSettings('some command')) as unknown).toEqual({
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'some command' }] }],
      },
    });
  });

  it('is one line of compact JSON, so that it is one argument', () => {
    const text = claudeSettings('a "quoted" command');
    expect(text).not.toContain('\n');
    expect(text).toBe(
      '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"a \\"quoted\\" command"}]}]}}',
    );
  });
});

describe('claudeArgv', () => {
  it('is the argv that was measured on a real host, in that order', () => {
    const p = probe('allow');
    const argv = claudeArgv(p, ctx(), HOOK_LINE);
    expect(argv).toEqual([
      '-p',
      promptFor(p),
      '--model',
      'haiku',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--session-id',
      SESSION,
      '--setting-sources',
      'project',
      '--settings',
      claudeSettings(hookCommandFor(ctx(), HOOK_LINE)),
      '--strict-mcp-config',
      '--tools',
      'Bash',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Bash(echo:*)',
      'Bash(printf:*)',
      'Bash(mkdir:*)',
      'Bash(curl:*)',
    ]);
  });

  it('keeps --allowedTools last, because it takes every word after it', () => {
    const argv = claudeArgv(probe('allow'), ctx(), HOOK_LINE);
    const at = argv.indexOf('--allowedTools');
    expect(argv.slice(at + 1)).toEqual([...CLAUDE_ALLOWED_TOOLS]);
  });

  it('never asks for what would skip or loosen the permission step of the host', () => {
    const argv = claudeArgv(probe('deny'), ctx(), HOOK_LINE);
    for (const flag of [
      '--bare',
      '--safe-mode',
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
      '--permission-prompt-tool',
    ])
      expect(argv).not.toContain(flag);
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(argv).not.toContain('dontAsk');
    expect(argv).not.toContain('bypassPermissions');
  });

  it('reads no settings file of the user: only the project, whose settings are the throwaway one', () => {
    const argv = claudeArgv(probe('allow'), ctx(), HOOK_LINE);
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('project');
    expect(argv).toContain('--strict-mcp-config');
  });

  it('differs between a real run and a control in the hook command, and in nothing else', () => {
    const real = claudeArgv(probe('deny'), ctx(), HOOK_LINE);
    const control = claudeArgv(probe('deny'), ctx({ hookMode: 'noop' }), HOOK_LINE);
    const at = real.indexOf('--settings') + 1;
    expect(real.filter((_, i) => i !== at)).toEqual(control.filter((_, i) => i !== at));
    expect(real[at]).not.toBe(control[at]);
    expect(JSON.parse(control[at] ?? '') as unknown).toEqual({
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: NOOP_HOOK_LINE }] }],
      },
    });
  });

  it('gives each request its own session and prompt, and nothing else changes', () => {
    const one = claudeArgv(probe('allow'), ctx(), HOOK_LINE);
    const other = claudeArgv(
      probe('allow', 'stroq-live-fedcba9876543210'),
      ctx({
        sessionId: '99999999-2222-4333-8444-555555555555',
        nonce: 'stroq-live-fedcba9876543210',
      }),
      HOOK_LINE,
    );
    const differing = one.flatMap((word, i) => (word === other[i] ? [] : [one[i - 1] ?? word]));
    expect(differing).toEqual(['-p', '--session-id']);
  });
});
