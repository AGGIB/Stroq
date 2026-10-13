import { spawnSync } from 'node:child_process';
import { taskEnvironment } from './environment.js';

/** Local capability preflight: --version makes no model request. */
export function readClaudeVersion(agent: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const result = spawnSync(agent, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4096,
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(taskEnvironment(env)).filter(
          ([name]) => name !== 'ANTHROPIC_API_KEY' && name !== 'CLAUDE_CODE_OAUTH_TOKEN',
        ),
      ),
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

export function requireClaudeVersion(version: string | null): void {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version ?? '');
  const [major, minor, patch] = (match?.slice(1) ?? []).map(Number);
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    !(major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 248))))
  )
    throw new Error(
      'stroq task requires Claude Code 2.1.248 or later (--restricted); version unavailable or unsupported. Nothing started.',
    );
}
