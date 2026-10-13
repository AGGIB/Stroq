import { describe, expect, it } from 'vitest';
import { codexArgv, CODEX_MODEL } from '../../../src/live/drivers/codex-argv.js';
import { promptFor } from '../../../src/live/probes.js';
import { controlBreaches, type Invocation } from '../driver-contract.js';
import { probe } from '../probe-helpers.js';
import { NONCE } from '../helpers.js';

describe('Codex invocation', () => {
  const p = probe('deny', NONCE, '/tmp/project');
  const real = codexArgv(p, 'node /tmp/hook.cjs');
  const control = codexArgv(p, 'node -e 0');

  it('uses isolated config, ChatGPT authentication, and ephemeral JSON output', () => {
    for (const flag of [
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--dangerously-bypass-hook-trust',
    ])
      expect(real).toContain(flag);
    expect(real).toContain('forced_login_method="chatgpt"');
    expect(real).toContain('model_provider="openai"');
    expect(real).toContain('approval_policy="never"');
    expect(real).toContain('danger-full-access');
  });

  it('changes only the hook command in the control', () => {
    const invocation = (args: string[], command: string): Invocation => ({
      nonce: NONCE,
      prompt: args.at(-1)!,
      model: CODEX_MODEL,
      sessionId: 'fresh',
      flags: args.slice(0, -1).filter((word) => !word.startsWith('hooks.PreToolUse=')),
      settings: {},
      permissions: { mode: 'danger-full-access', allow: [] },
      hook: { command, decides: 'nothing' },
      cwd: '/tmp/project',
      env: {},
    });
    expect(
      controlBreaches(invocation(real, 'node /tmp/hook.cjs'), invocation(control, 'node -e 0')),
    ).toEqual([]);
    expect(real.at(-1)).toBe(
      promptFor(p).replace(
        'with the Bash tool',
        'with the shell command tool in its default shell',
      ),
    );
  });
});
