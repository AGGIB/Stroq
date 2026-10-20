import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { extractEnv } from '@stroq/core';
import { projectSlug } from '../../src/replay/transcript.js';
import { runSent } from '../../src/commands/sent.js';

/**
 * A whole throwaway machine for `stroq sent`: its own HOME (key files, agent sessions), its own
 * STROQ_HOME, a project folder to stand in, and the shell's credential-shaped variables taken out.
 * Every value is made up.
 */
export const AWS_KEY = 'FAKEawsSecretValue0123456789abcdefABCDEF';
export const PROJECT_KEY = 'sk_FAKEprojectStripe0123456789abcdef';
export const AT = '2026-09-14T11:02:14.000Z';

export interface Machine {
  readonly root: string;
  readonly home: string;
  readonly stroqHome: string;
  readonly cwd: string;
}

export function machine(): Machine {
  const root = mkdtempSync(join(tmpdir(), 'stroq-sent-machine-'));
  const home = join(root, 'home');
  const stroqHome = join(root, 'stroq');
  const cwd = join(root, 'work', 'app');
  mkdirSync(join(home, '.aws'), { recursive: true });
  mkdirSync(stroqHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(home, '.aws', 'credentials'),
    `[default]\naws_secret_access_key = ${AWS_KEY}\n`,
  );
  writeFileSync(join(cwd, '.env'), `STRIPE_SECRET_KEY=${PROJECT_KEY}\n`);
  for (const { name } of extractEnv(process.env)) vi.stubEnv(name, undefined);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('STROQ_HOME', stroqHome);
  vi.stubEnv('APPDATA', join(home, 'AppData', 'Roaming'));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  return { root, home, stroqHome, cwd };
}

type Block = Record<string, unknown>;

/** One call and its result, as Claude Code records them. */
export function call(
  id: string,
  name: string,
  input: Block,
  result: string,
  extra: Block = {},
): Block[][] {
  return [
    [{ type: 'tool_use', id, name, input }],
    [{ type: 'tool_result', tool_use_id: id, content: result, ...extra }],
  ];
}

/** A Claude Code session recorded in `ranIn`, filed where Claude Code files it; returns its path. */
export function claudeSession(
  m: Machine,
  ranIn: string,
  id: string,
  turns: readonly (readonly Block[] | string)[],
  options: { readonly mtime?: Date; readonly subagent?: readonly (readonly Block[])[] } = {},
): string {
  const dir = join(m.home, '.claude', 'projects', projectSlug(ranIn));
  mkdirSync(dir, { recursive: true });
  // A prompt (a string) and a tool result are the user's turn; a call is the assistant's.
  const roleOf = (content: readonly Block[] | string): string =>
    typeof content === 'string' || content.some((b) => b['type'] === 'tool_result')
      ? 'user'
      : 'assistant';
  const line = (content: readonly Block[] | string, extra: Block = {}): string =>
    JSON.stringify({
      type: roleOf(content),
      sessionId: id,
      cwd: ranIn,
      timestamp: AT,
      ...extra,
      message: { role: roleOf(content), content },
    });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, `${turns.map((t) => line(t)).join('\n')}\n`);
  if (options.subagent !== undefined) {
    mkdirSync(join(dir, id, 'subagents'), { recursive: true });
    writeFileSync(
      join(dir, id, 'subagents', 'agent-sub1.jsonl'),
      `${options.subagent.map((t) => line(t, { isSidechain: true, agentId: 'sub1' })).join('\n')}\n`,
    );
  }
  if (options.mtime !== undefined) utimesSync(file, options.mtime, options.mtime);
  return file;
}

/** A Codex rollout recorded in `ranIn` with one shell call; returns its path. */
export function codexRollout(
  m: Machine,
  ranIn: string,
  name: string,
  command: string,
  mtime?: Date,
): string {
  const dir = join(m.home, '.codex', 'sessions', '2026', '09', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${name}.jsonl`);
  const lines = [
    {
      timestamp: AT,
      type: 'session_meta',
      payload: { session_id: name, cwd: ranIn, timestamp: AT },
    },
    {
      timestamp: AT,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell',
        call_id: 'c1',
        arguments: JSON.stringify({ command: ['bash', '-lc', command] }),
      },
    },
    {
      timestamp: AT,
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    },
  ];
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  if (mtime !== undefined) utimesSync(file, mtime, mtime);
  return file;
}

/** Runs `stroq sent` with stdout and stderr captured. */
export async function sent(
  args: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const a = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  const b = vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  try {
    return { code: await runSent(args), out: out.join(''), err: err.join('') };
  } finally {
    a.mockRestore();
    b.mockRestore();
  }
}
