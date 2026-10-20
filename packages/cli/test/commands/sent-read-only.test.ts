import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractEnv } from '@stroq/core';
import { runSent } from '../../src/commands/sent.js';
import { projectSlug } from '../../src/replay/transcript.js';
import { treeOf } from '../helpers/tree.js';

/**
 * `stroq sent` reads files and writes none. It used to rebuild `~/.stroq/secrets.json` (the live
 * guard's index) and, for a session from another folder, a private copy of it in the temporary
 * folder. Every value below is made up; HOME, STROQ_HOME and the project are temporary folders.
 */

const AWS = 'FAKEawsSecretValue0123456789abcdefABCDEF';
const PROJECT = 'FAKEprojectApiKey0123456789abcdef';
const AT = '2026-10-01T10:00:00.000Z';

let root = '';
let home = '';
let stroqHome = '';
let cwd = '';

/** Credential-shaped variables of the shell running the tests, taken out for the test. */
function withoutShellKeys(): void {
  for (const { name } of extractEnv(process.env)) vi.stubEnv(name, undefined);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stroq-ro-'));
  home = join(root, 'home');
  stroqHome = join(root, 'stroq');
  cwd = join(root, 'work', 'app');
  mkdirSync(join(home, '.aws'), { recursive: true });
  mkdirSync(stroqHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(home, '.aws', 'credentials'), `[default]\naws_secret_access_key = ${AWS}\n`);
  writeFileSync(join(cwd, '.env'), `API_KEY=${PROJECT}\n`);
  withoutShellKeys();
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('STROQ_HOME', stroqHome);
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A Claude Code session of this project: a read of `.env`, a subagent, and a saved output. */
function session(): string {
  const dir = join(home, '.claude', 'projects', projectSlug(cwd));
  const id = 'ro-session';
  mkdirSync(join(dir, id, 'subagents'), { recursive: true });
  mkdirSync(join(dir, id, 'tool-results'), { recursive: true });
  writeFileSync(join(dir, id, 'tool-results', 'out1.txt'), `log line\n${AWS}\n`);
  const base = { sessionId: id, cwd, timestamp: AT };
  const lines = [
    {
      ...base,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: join(cwd, '.env') } },
        ],
      },
    },
    {
      ...base,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a', content: `API_KEY=${PROJECT}` }],
      },
    },
    {
      ...base,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'cat big.log' } }],
      },
    },
    {
      ...base,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'b',
            content: `Full output saved to: ${join(dir, id, 'tool-results', 'out1.txt')}`,
          },
        ],
      },
    },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const sub = { ...base, isSidechain: true, agentId: 'sub1' };
  writeFileSync(
    join(dir, id, 'subagents', 'agent-sub1.jsonl'),
    `${JSON.stringify({ ...sub, message: { role: 'assistant', content: [{ type: 'tool_use', id: 's', name: 'Bash', input: { command: 'ls' } }] } })}\n`,
  );
  return join(dir, `${id}.jsonl`);
}

/** Temporary folders `sent` itself used to make. */
const scratch = (): string[] =>
  readdirSync(tmpdir()).filter(
    (name) => /^stroq-sent-(index|try)-/.test(name) && !name.includes('-test-'),
  );

async function quietly(args: readonly string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    chunks.push(String(c));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
    chunks.push(String(c));
    return true;
  });
  try {
    return { code: await runSent(args), out: chunks.join('') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe('stroq sent writes nothing', () => {
  it.each([[['--last']], [['--last', '--json']], [['--last', '--card']], [['--try']]])(
    '%j: no file under HOME, STROQ_HOME, the project or the temporary folder',
    async (args) => {
      session();
      const before = { root: treeOf(root), scratch: scratch() };
      const { code, out } = await quietly(args);
      expect(code).toBe(0);
      expect(treeOf(root)).toEqual(before.root);
      expect(scratch()).toEqual(before.scratch);
      expect(existsSync(join(stroqHome, 'secrets.json'))).toBe(false);
      expect(out).not.toContain(AWS);
      expect(out).not.toContain(PROJECT);
    },
  );

  it('--transcript <path>: the same', async () => {
    const path = session();
    const before = treeOf(root);
    const { code, out } = await quietly(['--transcript', path]);
    expect(code).toBe(0);
    expect(treeOf(root)).toEqual(before);
    expect(out).not.toContain(AWS);
  });

  it('with canaries planted: reads their records and changes none', async () => {
    session();
    const decoy = join(home, '.aws', 'credentials.bak');
    writeFileSync(decoy, 'STROQ_CANARY_KEY=stroq_canary_FAKEcanary0123456789abcdefABCDEF\n');
    writeFileSync(join(stroqHome, 'canary-files.json'), JSON.stringify({ files: [decoy] }));
    writeFileSync(
      join(stroqHome, 'secrets.json'),
      JSON.stringify({ salt: 'fake', canaries: [{ hash: 'fakehash' }] }),
    );
    const before = treeOf(root);
    const { code } = await quietly(['--last']);
    expect(code).toBe(0);
    expect(treeOf(root)).toEqual(before);
  });

  it('still finds the keys it compares with, from memory', async () => {
    session();
    const { out } = await quietly(['--last', '--json']);
    expect(out).toContain('API_KEY');
    expect(out).toContain('aws_secret_access_key');
  });
});

describe('the progress line', () => {
  it('is drawn in place on a terminal, cleared once at the end, and not drawn elsewhere', async () => {
    const { progressLine } = await import('../../src/sent/run.js');
    expect(progressLine(false, () => undefined)).toBeNull();
    const written: string[] = [];
    const line = progressLine(true, (text) => written.push(text));
    line?.update(0, 2);
    line?.update(2, 2);
    line?.end();
    line?.end();
    expect(written[0]).toBe('\rReading sessions: 0 of 2');
    expect(written.at(-2)).toBe('\rReading sessions: 2 of 2');
    expect(written.filter((t) => t.includes('\u001b[2K'))).toHaveLength(1);
  });
});
