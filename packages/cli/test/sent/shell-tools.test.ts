import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileSecretIndex, SHELL_TOOLS, isShellTool, type AuditEntry } from '@stroq/core';
import type { Transcript } from '../../src/replay/transcript.js';
import { scanAuditLog, scanTranscript, type SentIndexScope } from '../../src/sent/scan.js';

/**
 * Claude Code runs a shell command through three tools: `Bash`, `PowerShell` and `Monitor`. The core keeps one
 * list of them (`SHELL_TOOLS`), and holds four readers of a command to it (`core/test/actions/shell-tools.test.ts`).
 * `stroq sent` keeps a list of its own, which was `Bash` alone: a credential file named in a `PowerShell` or a
 * `Monitor` command was not in its report, although the same command is judged by every guard. This is the fifth
 * reader, held to the same list from the side of the CLI.
 */

const KEY = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY';
const AT = '2026-10-10T08:00:00.000Z';

let root = '';
let scope: SentIndexScope;
let index: FileSecretIndex;
let credentials = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'stroq-sent-tools-'));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  mkdirSync(join(home, '.aws'), { recursive: true });
  mkdirSync(cwd);
  credentials = join(home, '.aws', 'credentials');
  writeFileSync(credentials, `[default]\naws_secret_access_key = ${KEY}\n`);
  // `env: {}` so the developer's own shell cannot contribute entries to a test index.
  index = new FileSecretIndex(join(root, 'secrets.json'), home, {});
  scope = { cwd, home, sourcePaths: index.sourcePaths(cwd), indexedSecrets: 1 };
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

const transcriptOf = (tool: string, command: string): Transcript => ({
  sessionId: 's1',
  cwd: scope.cwd,
  skipped: 0,
  events: [{ kind: 'post', id: 't1', tool, input: { command }, resultText: '', at: AT }],
});

describe('stroq sent reads the command of every tool that runs one', () => {
  const probes = [...SHELL_TOOLS, 'bash', 'BashOutput', 'Shell', 'run_command', 'Task'];

  /** Whether the report holds a credential file as named in a command of this tool. */
  async function namesTheFile(tool: string, command: string): Promise<boolean> {
    const report = await scanTranscript(
      transcriptOf(tool, command),
      { agent: 'claude-code', path: '/t.jsonl' },
      index,
      scope,
    );
    return report.files.some((file) => file.evidence === 'named' && file.tool === tool);
  }

  it('reads exactly the tools in the list of the core', async () => {
    const read: string[] = [];
    for (const tool of probes)
      if (await namesTheFile(tool, 'cat ~/.aws/credentials')) read.push(tool);
    expect(read.sort()).toEqual(probes.filter(isShellTool).sort());
    // The probe list holds the thing it probes for.
    expect(read).toEqual(expect.arrayContaining(['Bash', 'PowerShell', 'Monitor']));
  });

  it.each(['PowerShell', 'Monitor'])('names a credential file in a command of %s', async (tool) => {
    expect(await namesTheFile(tool, 'Get-Content ~/.aws/credentials')).toBe(true);
    expect(await namesTheFile(tool, `type ${credentials}`)).toBe(true);
  });

  it.each(['Bash', 'PowerShell', 'Monitor'])(
    'does not take a heredoc body of %s that nothing runs for a file that is opened',
    async (tool) => {
      const command = `cat > notes.md <<'EOF'\nthe key lives in ~/.aws/credentials\nEOF`;
      expect(await namesTheFile(tool, command)).toBe(false);
    },
  );

  it('reads an entry of the audit log of any of the three the same way', () => {
    for (const tool of [...SHELL_TOOLS]) {
      const entry = {
        sessionId: 's1',
        phase: 'post',
        tool,
        summary: 'cat ~/.aws/credentials',
        seq: 1,
        ts: AT,
        prevHash: '',
        hash: '',
      } as AuditEntry;
      const report = scanAuditLog([entry], 's1', scope);
      expect(
        report.files.some((file) => file.evidence === 'named' && file.tool === tool),
        tool,
      ).toBe(true);
    }
  });
});
