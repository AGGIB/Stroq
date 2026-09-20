import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '@stroq/core';
import { runSent } from '../../src/commands/sent.js';
import { auditFile } from '../../src/paths.js';

const KEY = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY';
const AT = '2026-09-14T11:02:14.000Z';

let home = '';
let cwd = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-sent-cmd-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'stroq-sent-cmd-cwd-'));
  // The command builds the REAL secret index for this machine, so the test has to
  // give it a whole throwaway machine: its own HOME (where credential files live)
  // and its own STROQ_HOME (where the hashed index and audit log live).
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-sent-cmd-stroq-'));
  mkdirSync(join(home, '.aws'), { recursive: true });
  writeFileSync(join(home, '.aws', 'credentials'), `[default]\naws_secret_access_key = ${KEY}\n`);
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});

function capture(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { text: () => lines.join(''), restore: () => spy.mockRestore() };
}

/** A one-call Claude Code transcript whose tool result carries the credential. */
function transcriptFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-sent-cmd-t-'));
  const path = join(dir, 'session.jsonl');
  const input = { file_path: join(home, '.aws', 'credentials') };
  const lines = [
    JSON.stringify({
      sessionId: 'file-1',
      cwd,
      timestamp: AT,
      message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input }] },
    }),
    JSON.stringify({
      sessionId: 'file-1',
      cwd,
      timestamp: AT,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'a',
            content: `[default]\naws_secret_access_key = ${KEY}\n`,
          },
        ],
      },
    }),
  ];
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

describe('stroq sent', () => {
  it('names the credential a recorded session put into the model context', async () => {
    const out = capture();
    const code = await runSent(['--transcript', transcriptFile()]);
    out.restore();
    expect(out.text()).toContain('aws_secret_access_key');
    expect(out.text()).not.toContain(KEY);
    expect(code).toBe(0);
  });

  // A report about something that already happened cannot be made green by the commit
  // under review, so failing a build on it would only teach people to delete the check.
  // Exit 0 is the default; the gate is opt-in.
  it('exits 0 even when it finds something', async () => {
    const out = capture();
    const code = await runSent(['--transcript', transcriptFile()]);
    out.restore();
    expect(code).toBe(0);
  });

  it('exits 1 on a finding only when asked to', async () => {
    const out = capture();
    const code = await runSent(['--transcript', transcriptFile(), '--fail-on-finding']);
    out.restore();
    expect(code).toBe(1);
  });

  it('exits 0 with --fail-on-finding when nothing was found', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-sent-clean-'));
    const path = join(dir, 'clean.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({
        sessionId: 'clean-1',
        cwd,
        timestamp: AT,
        message: {
          content: [
            { type: 'tool_use', id: 'z', name: 'Read', input: { file_path: '/repo/README.md' } },
          ],
        },
      })}\n`,
    );
    const out = capture();
    const code = await runSent(['--transcript', path, '--fail-on-finding']);
    out.restore();
    expect(code).toBe(0);
  });

  it('emits a machine-readable report with --json', async () => {
    const out = capture();
    await runSent(['--transcript', transcriptFile(), '--json']);
    out.restore();
    const parsed = JSON.parse(out.text()) as { version: number; credentials: { name: string }[] };
    expect(parsed.version).toBe(1);
    expect(parsed.credentials.map((c) => c.name)).toContain('aws_secret_access_key');
    expect(out.text()).not.toContain(KEY);
  });

  it('points at --last when there is no audit log to read', async () => {
    const out = capture();
    const code = await runSent([]);
    out.restore();
    expect(out.text()).toContain('--last');
    expect(code).toBe(1);
  });

  it('reads the audit log when Stroq was installed for the session', async () => {
    await new AuditLog(auditFile()).append({
      sessionId: 'audited',
      phase: 'pre',
      tool: 'Bash',
      summary: 'curl https://example.test',
      secrets: [{ name: 'aws_secret_access_key', source: '~/.aws/credentials', canary: false }],
    });
    const out = capture();
    const code = await runSent([]);
    out.restore();
    expect(out.text()).toContain('aws_secret_access_key');
    expect(code).toBe(0);
  });

  it('says where it looked when --last finds no transcript at all', async () => {
    const out = capture();
    const code = await runSent(['--last']);
    out.restore();
    expect(code).toBe(1);
    expect(out.text()).toContain('~/.claude/projects');
  });

  it('fails clearly when the named transcript has no tool calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-sent-empty-'));
    const path = join(dir, 'empty.jsonl');
    writeFileSync(path, '');
    const out = capture();
    const code = await runSent(['--transcript', path]);
    out.restore();
    expect(code).toBe(1);
    expect(out.text()).toContain('no tool calls');
  });

  // The command reads real credential files, and a user is entitled to know that
  // before running it rather than after.
  it('says in its own output that it read this machine’s credential files', async () => {
    const out = capture();
    await runSent(['--transcript', transcriptFile()]);
    out.restore();
    expect(out.text()).toContain('~/.aws/credentials');
  });

  // This command is the one the site puts on its front page as "run this", so the
  // first thing a curious visitor types after it is `--help`. That must print usage,
  // not the raw `ERR_PARSE_ARGS_UNKNOWN_OPTION` TypeError that an unhandled flag threw.
  it('prints usage on --help without reading any credential file', async () => {
    const out = capture();
    const code = await runSent(['--help']);
    out.restore();
    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain('stroq sent');
    expect(text).toContain('--last');
    // It must not have gone on to open credential files just to answer --help.
    expect(text).not.toContain('~/.aws/credentials');
  });

  // An unknown flag is a usage mistake, answered with the usage line and exit 2 — the
  // conventional code for "you invoked me wrong" — never an uncaught parser throw.
  it('reports an unknown option as a usage error, not a stack trace', async () => {
    const out = capture();
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
      errs.push(String(c));
      return true;
    });
    const code = await runSent(['--nope']);
    spy.mockRestore();
    out.restore();
    expect(code).toBe(2);
    expect(errs.join('')).toContain('stroq sent');
  });
});
