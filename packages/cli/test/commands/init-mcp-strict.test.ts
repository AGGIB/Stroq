import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorReport } from '../../src/commands/doctor.js';
import { runInit } from '../../src/commands/init.js';
import { wrapperIndex } from '../../src/commands/mcp-config.js';

/**
 * `stroq init --agent mcp --strict`, from the command line to `doctor` and back out with
 * `--unwrap`. The pieces (the argument list, the counting, the flag) have tests of their
 * own; this is the one place the round trip is run as a user runs it.
 */

let dir: string;
let file: string;
let entry: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stroq-init-strict-'));
  process.env['HOME'] = join(dir, 'fakehome');
  process.env['USERPROFILE'] = join(dir, 'fakehome');
  process.env['STROQ_HOME'] = join(dir, 'stroq-home');
  mkdirSync(process.env['HOME'], { recursive: true });
  file = join(dir, '.mcp.json');
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', 'srv'] },
        notes: { command: 'node', args: ['notes.js'] },
        remote: { url: 'https://mcp.example/sse' },
      },
    }),
  );
  // A real entry path the wrapper can record: `doctor` counts a wrapper stale when it is gone.
  entry = join(dir, 'dist', 'index.js');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(entry, '');
});

const servers = () =>
  (JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, { args?: string[] }> })
    .mcpServers;

/** Runs `init` as `stroq` would, with the entry the wrapper should record, and returns what it printed. */
async function init(...args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  const original = process.argv[1];
  const cwd = process.cwd();
  process.argv[1] = entry;
  try {
    process.chdir(dir);
    const code = await runInit(['--agent', 'mcp', '--client', 'claude-code', ...args], {
      platform: 'linux',
    });
    return { code, out: lines.join('') };
  } finally {
    process.chdir(cwd);
    if (original === undefined) process.argv.splice(1, 1);
    else process.argv[1] = original;
    spy.mockRestore();
  }
}

const proxyLine = async (): Promise<string> => {
  const report = await doctorReport(dir, { all: true });
  return report.checks.find((c) => c.name === 'mcp proxy')?.detail ?? '';
};

describe('stroq init --agent mcp --strict', () => {
  it('writes --strict into every wrapper and says what it does and does not do', async () => {
    const { code, out } = await init('--strict');
    expect(code).toBe(0);
    for (const name of ['github', 'notes']) expect(servers()[name]?.args).toContain('--strict');
    expect(servers()['remote']).toEqual({ url: 'https://mcp.example/sse' });
    expect(out).toContain('--strict is ON');
    expect(out).toContain('not a sandbox');
    expect(out).toContain('--unwrap');
  });

  it('writes nothing about strict without the flag, and prints no strict note', async () => {
    const { out } = await init();
    expect(JSON.stringify(servers())).not.toContain('--strict');
    expect(out).not.toContain('--strict');
  });

  it('shows strict wrappers apart from the others in doctor', async () => {
    await init();
    expect(await proxyLine()).toContain('wrapped 2/2 stdio servers');
    expect(await proxyLine()).not.toMatch(/\d+ strict\)/);
    await init('--strict');
    expect(await proxyLine()).toContain('wrapped 2/2 stdio servers (2 strict)');
  });

  it('keeps strict on when init is run again without it, as a rewrite keeps a pin', async () => {
    await init('--strict');
    await init();
    expect(servers()['github']?.args).toContain('--strict');
    expect(await proxyLine()).toContain('(2 strict)');
  });

  it('is recognised as Stroq’s own wrapper, and --unwrap restores the original command', async () => {
    await init('--strict');
    expect(wrapperIndex(servers()['github']?.args ?? [])).not.toBeNull();
    const { code, out } = await init('--unwrap');
    expect(code).toBe(0);
    expect(out).toContain('unwrapped github');
    expect(servers()['github']).toEqual({ command: 'npx', args: ['-y', 'srv'] });
    expect(servers()['notes']).toEqual({ command: 'node', args: ['notes.js'] });
    expect(await proxyLine()).toContain('wrapped 0/2 stdio servers');
  });

  it('previews the strict wrapper with --dry-run and writes nothing', async () => {
    const before = readFileSync(file, 'utf8');
    const { out } = await init('--strict', '--dry-run');
    expect(out).toContain('"--strict"');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
