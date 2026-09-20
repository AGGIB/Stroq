import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRunArgv, runRun } from '../../src/commands/run.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ok = (argv: readonly string[]) => {
  const parsed = parseRunArgv(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.invocation;
};
const err = (argv: readonly string[]) => {
  const parsed = parseRunArgv(argv);
  return parsed.ok ? '' : parsed.error;
};

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const errOut = process.stderr.write.bind(process.stderr);
  const sink = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  return {
    lines,
    restore: () => {
      process.stdout.write = out;
      process.stderr.write = errOut;
    },
  };
}

describe('parseRunArgv', () => {
  it('takes the agent and its arguments from after the separator', () => {
    expect(ok(['--', 'claude', '--model', 'opus'])).toMatchObject({
      command: 'claude',
      args: ['--model', 'opus'],
    });
  });

  // Everything after `--` belongs to the agent, so an agent flag that happens to
  // share a name with one of Stroq's must never be read as Stroq's.
  it('never interprets a flag that belongs to the agent', () => {
    expect(ok(['--', 'claude', '--sandbox', '--force'])).toMatchObject({
      sandbox: false,
      force: false,
      args: ['--sandbox', '--force'],
    });
  });

  it('reads its own flags before the separator', () => {
    expect(
      ok(['--agent', 'codex', '--sandbox', '--no-inspect', '--force', '--dry-run', '--', 'codex']),
    ).toMatchObject({
      agent: 'codex',
      sandbox: true,
      inspect: false,
      force: true,
      dryRun: true,
    });
  });

  it('collects every --allow-domain rather than keeping the last', () => {
    expect(
      ok(['--sandbox', '--allow-domain', 'a.com', '--allow-domain', 'b.com', '--', 'claude']),
    ).toMatchObject({ allowedDomains: ['a.com', 'b.com'] });
  });

  it('inspects by default', () => {
    expect(ok(['--', 'claude']).inspect).toBe(true);
  });

  it('refuses a missing separator, an empty command and an unknown flag', () => {
    expect(err(['claude'])).toMatch(/--/);
    expect(err([])).toMatch(/--/);
    expect(err(['--'])).toMatch(/must follow/);
    expect(err(['--nope', '--', 'claude'])).toContain('--nope');
    expect(err(['--agent', '--', 'claude'])).toContain('--agent');
  });

  it('refuses --allow-domain without --sandbox, which would silently do nothing', () => {
    expect(err(['--allow-domain', 'a.com', '--', 'claude'])).toContain('--sandbox');
  });
});

describe('stroq run --dry-run', () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-run-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q', '.'], { cwd: dir, env: { ...process.env, HOME: dir } });
    return dir;
  }

  it('prints the git settings it would apply and starts nothing', async () => {
    const dir = repo();
    const out = capture();
    const code = await runRun(['--dry-run', '--force', '--', 'claude'], dir);
    out.restore();
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('core.fsmonitor=false');
    expect(text).toContain('safe.bareRepository=explicit');
  });

  it('refuses when the agent has no Stroq hook, and names the command that fixes it', async () => {
    const dir = repo();
    const out = capture();
    const code = await runRun(['--dry-run', '--', 'claude'], dir);
    out.restore();
    expect(code).toBe(1);
    expect(out.lines.join('')).toContain('stroq init --agent claude-code');
  });

  it('launches nothing but says what it would do once forced', async () => {
    const dir = repo();
    const out = capture();
    const code = await runRun(['--dry-run', '--force', '--', 'claude'], dir);
    out.restore();
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('claude');
  });

  it('says the sandbox is not in force when srt is not installed', async () => {
    const dir = repo();
    const out = capture();
    await runRun(['--dry-run', '--force', '--sandbox', '--', 'claude'], dir, {
      srt: () => null,
    });
    out.restore();
    expect(out.lines.join('')).toMatch(/not.*in force|no sandbox|srt/i);
  });

  // Measured against srt 0.0.77: its Seatbelt profile denies `tcsetattr`, so a
  // child cannot enter raw mode — a permissive `sandbox-exec` profile can. Every
  // full-screen agent UI needs raw mode, so this has to be said before the launch
  // rather than discovered as an unexplained crash.
  it('warns that an interactive agent cannot enter raw mode under srt on macOS', async () => {
    const dir = repo();
    const out = capture();
    await runRun(['--dry-run', '--force', '--sandbox', '--', 'claude'], dir, {
      srt: () => '/usr/local/bin/srt',
      plat: 'darwin',
      isTTY: true,
    });
    out.restore();
    expect(out.lines.join('')).toMatch(/raw mode/i);
  });

  it('does not warn about raw mode when nothing interactive is being started', async () => {
    const dir = repo();
    const out = capture();
    await runRun(['--dry-run', '--force', '--sandbox', '--', 'claude', '-p', 'hi'], dir, {
      srt: () => '/usr/local/bin/srt',
      plat: 'darwin',
      isTTY: false,
    });
    out.restore();
    expect(out.lines.join('')).not.toMatch(/raw mode/i);
  });

  it('shows the generated srt config when srt is there', async () => {
    const dir = repo();
    const out = capture();
    await runRun(['--dry-run', '--force', '--sandbox', '--', 'claude'], dir, {
      srt: () => '/usr/local/bin/srt',
    });
    out.restore();
    expect(out.lines.join('')).toContain('denyRead');
  });
});
