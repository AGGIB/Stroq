// Codex uses its existing ChatGPT login, never a copied authentication file.
import { promptFor } from '../probes.js';
import type { Probe } from '../types.js';

export const CODEX_MODEL = 'gpt-5.6-luna';

/** Config arguments shared by the login preflight and inference. */
export const CODEX_AUTH_ARGS = [
  '--config',
  'forced_login_method="chatgpt"',
  '--config',
  'model_provider="openai"',
] as const;

/** Only the hook command differs between a probe and its control. */
export function codexArgv(probe: Probe, command: string): string[] {
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--dangerously-bypass-hook-trust',
    '--model',
    CODEX_MODEL,
    '--sandbox',
    'danger-full-access',
    ...CODEX_AUTH_ARGS,
    '--config',
    'approval_policy="never"',
    '--config',
    'features.hooks=true',
    '--config',
    'features.plugin_hooks=false',
    '--config',
    'web_search="disabled"',
    '--config',
    'mcp_servers={}',
    '--config',
    `hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(command)},timeout=15}]}]`,
    promptFor(probe).replace(
      'with the Bash tool',
      'with the shell command tool in its default shell',
    ),
  ];
}
