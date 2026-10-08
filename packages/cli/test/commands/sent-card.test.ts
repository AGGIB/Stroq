import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runSent } from '../../src/commands/sent.js';

/**
 * `stroq sent --card` end to end: a session that carried a real credential, in a project with a
 * private name, through a command that names a private host, is read, and the card that comes out
 * holds none of those. The report names them (it is for the person who ran it); the card is for
 * pasting into a post.
 */

const KEY = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY';
const AT = '2026-09-14T11:02:14.000Z';
const PRIVATE_HOST = 'internal-billing.corp.example';
const SESSION = 'session-9f31c0de-private';

let home = '';
let cwd = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-sent-card-home-'));
  cwd = join(mkdtempSync(join(tmpdir(), 'stroq-sent-card-')), 'acme-payroll-project');
  mkdirSync(cwd, { recursive: true });
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-sent-card-stroq-'));
  mkdirSync(join(home, '.aws'), { recursive: true });
  writeFileSync(join(home, '.aws', 'credentials'), `[default]\naws_secret_access_key = ${KEY}\n`);
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});

function capture(): { text: () => string; err: () => string; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const a = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const b = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return {
    text: () => out.join(''),
    err: () => err.join(''),
    restore: () => {
      a.mockRestore();
      b.mockRestore();
    },
  };
}

/** A transcript in which the credential is in a tool result and in the arguments of a call to a private host. */
function transcriptFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-sent-card-t-'));
  const path = join(dir, 'session.jsonl');
  const read = { file_path: join(home, '.aws', 'credentials') };
  const send = {
    command: `curl -H "X-Key: ${KEY}" https://${PRIVATE_HOST}/v1/invoices`,
  };
  const lines = [
    {
      sessionId: SESSION,
      cwd,
      timestamp: AT,
      message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: read }] },
    },
    {
      sessionId: SESSION,
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
    },
    {
      sessionId: SESSION,
      cwd,
      timestamp: AT,
      message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: send }] },
    },
  ].map((line) => JSON.stringify(line));
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

const SEEDED = [
  KEY,
  'aws_secret_access_key',
  PRIVATE_HOST,
  SESSION,
  'acme-payroll-project',
  '.aws',
  'credentials',
  '/v1/invoices',
  'curl',
];

async function card(...flags: string[]): Promise<{ text: string; err: string; code: number }> {
  const out = capture();
  const code = await runSent(['--transcript', transcriptFile(), '--card', ...flags]);
  out.restore();
  return { text: out.text(), err: out.err(), code };
}

describe('stroq sent --card', () => {
  it('prints a Markdown card with counts and the provider, and none of what the report names', async () => {
    const { text, code } = await card();
    expect(code).toBe(0);
    expect(text).toContain('# Stroq session check');
    expect(text).toContain('The record of the session holds 1 credential from this machine');
    expect(text).toContain('AWS 1');
    expect(text).toContain('Tool calls read');
    expect(text).toContain('npx @stroq/cli sent --last');
    for (const seeded of SEEDED) expect(text, `holds "${seeded}"`).not.toContain(seeded);
    expect(text).not.toContain(home);
    expect(text).not.toContain(cwd);
  });

  it('prints one HTML file with no script and nothing seeded', async () => {
    const { text, code } = await card('--html');
    expect(code).toBe(0);
    expect(text).toMatch(/^<!doctype html>/);
    expect(text).not.toMatch(/<script/i);
    expect(text).toContain("default-src 'none'");
    for (const seeded of SEEDED) expect(text, `holds "${seeded}"`).not.toContain(seeded);
  });

  it('prints the card as JSON with --json, and the report is not what is printed', async () => {
    const { text } = await card('--json');
    const parsed = JSON.parse(text) as {
      version: number;
      credentials: number;
      providers: unknown[];
    };
    expect(parsed).toMatchObject({ version: 1, credentials: 1 });
    expect(parsed.providers).toEqual([{ label: 'AWS', count: 1 }]);
    // `credentials` is a key of the card (a count); the seeded text is the file called that.
    for (const seeded of SEEDED.filter((word) => word !== 'credentials'))
      expect(text, `holds "${seeded}"`).not.toContain(seeded);
  });

  it('is not the report: the report names the credential and the card does not', async () => {
    const report = capture();
    await runSent(['--transcript', transcriptFile()]);
    report.restore();
    expect(report.text()).toContain('aws_secret_access_key');
    expect((await card()).text).not.toContain('aws_secret_access_key');
  });

  it('writes a file with --out, as HTML for a .html name, and does not write over one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-sent-card-out-'));
    const target = join(dir, 'card.html');
    const first = await card('--out', target);
    expect(first.code).toBe(0);
    expect(first.text).toContain(`wrote ${target}`);
    const written = readFileSync(target, 'utf8');
    expect(written).toMatch(/^<!doctype html>/);
    for (const seeded of SEEDED) expect(written, `holds "${seeded}"`).not.toContain(seeded);

    const second = await card('--out', target);
    expect(second.code).toBe(2);
    expect(second.err).toContain('not written');
    expect(readFileSync(target, 'utf8')).toBe(written);
  });

  it('writes Markdown to a name that is not .html', async () => {
    const target = join(mkdtempSync(join(tmpdir(), 'stroq-sent-card-out-')), 'card.md');
    await card('--out', target);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('# Stroq session check');
  });

  it('refuses --html and --out without --card', async () => {
    const out = capture();
    const html = await runSent(['--transcript', transcriptFile(), '--html']);
    const dest = await runSent(['--transcript', transcriptFile(), '--out', 'x.md']);
    out.restore();
    expect([html, dest]).toEqual([2, 2]);
    expect(out.err()).toContain('--html and --out go with --card');
  });

  it('still gates on a finding with --fail-on-finding', async () => {
    expect((await card('--fail-on-finding')).code).toBe(1);
  });
});
