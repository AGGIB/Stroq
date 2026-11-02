import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_COMMANDS, devHelp } from '../src/dev-help.js';
import { commandNames } from '../src/help.js';
import { CLI_ENTRY } from './helpers/cli-entry.js';

/**
 * What a newcomer types first. Before this, `stroq <command> --help` threw a raw
 * `TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]` on 12 of 18 commands, `doctor` and
 * `exposure` ignored it and ran in full, and a typo printed 60 lines of usage.
 */

const home = mkdtempSync(join(tmpdir(), 'stroq-help-'));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, HOME: home, USERPROFILE: home, STROQ_HOME: join(home, '.stroq') },
  });

/** Every command a person runs, with the source file that parses its arguments. */
const COMMANDS: Readonly<Record<string, string>> = {
  console: 'console',
  init: 'init',
  uninstall: 'uninstall',
  mcp: 'mcp',
  doctor: 'doctor',
  log: 'log',
  verify: 'verify',
  untaint: 'untaint',
  why: 'why',
  replay: 'replay',
  sent: 'sent',
  canary: 'canary',
  attack: 'attack',
  policy: 'policy',
  exposure: 'exposure',
  inspect: 'inspect',
  trust: 'trust',
  vet: 'vet',
};

/** The developer tools that used to be commands, with the source file that parses their arguments. */
const DEV_TOOLS: Readonly<Record<string, string>> = {
  prove: 'prove',
  bench: 'bench',
  coverage: 'coverage',
};

/** The flags a command's source accepts: `parseArgs` options, flag sets, `argv.includes`. */
function flagsInSource(name: string): string[] {
  const file = join(import.meta.dirname, '../src/commands', `${name}.ts`);
  const src = readFileSync(file, 'utf8');
  const found = [
    ...[...src.matchAll(/'?([a-z][a-z-]*)'?:\s*\{\s*type:\s*'(?:string|boolean)'/g)].map(
      (m) => `--${m[1]}`,
    ),
    ...[...src.matchAll(/new Set\(\[([^\]]*)\]\)/g)].flatMap((m) =>
      [...(m[1] ?? '').matchAll(/'(--[a-z][a-z-]*)'/g)].map((x) => x[1] ?? ''),
    ),
    ...[...src.matchAll(/includes\('(--[a-z][a-z-]*)'\)/g)].map((m) => m[1] ?? ''),
  ];
  return [...new Set(found)].filter((flag) => flag !== '--help' && flag !== '');
}

describe('stroq <command> --help', () => {
  it.each(Object.keys(COMMANDS))('%s --help prints its usage and exits 0', (name) => {
    const out = run(name, '--help');
    expect(out.stderr).not.toMatch(/TypeError|ERR_PARSE_ARGS/);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`^stroq ${name}\\b`));
  });

  it.each(Object.entries(COMMANDS))('%s --help names every flag it accepts', (name, file) => {
    const help = run(name, '--help').stdout;
    for (const flag of flagsInSource(file)) expect(help, `${name} ${flag}`).toContain(flag);
  });

  it('exposure --help only prints help', () => {
    const out = run('exposure', '--help');
    expect(out.stdout).not.toMatch(/Agents detected|wrapped by Stroq/);
  });

  it('answers -h too', () => {
    expect(run('log', '-h').stdout).toMatch(/^stroq log\b/);
  });

  it('stroq help is stroq --help, and stroq help <command> is <command> --help', () => {
    const list = run('help');
    expect(list.status).toBe(0);
    expect(list.stdout).toBe(run('--help').stdout);
    expect(run('help', 'untaint').stdout).toBe(run('untaint', '--help').stdout);
  });

  it('hook --help prints its usage and exits 0', () => {
    const out = run('hook', '--help');
    expect(out.stderr).not.toMatch(/TypeError|ERR_PARSE_ARGS/);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/^stroq hook\b/);
  });
});

describe('the developer tools that used to be commands', () => {
  it('are exactly the three that dev-help.ts writes the usage of', () => {
    expect(DEV_COMMANDS.map((c) => c.name).sort()).toEqual(Object.keys(DEV_TOOLS).sort());
  });

  it.each(Object.keys(DEV_TOOLS))('%s has a usage that opens with its pnpm script', (name) => {
    expect(devHelp(name)).toMatch(new RegExp(`^pnpm dev:${name}\\b`));
  });

  it.each(Object.entries(DEV_TOOLS))(
    '%s usage names every flag its source accepts',
    (name, file) => {
      const help = devHelp(name) ?? '';
      for (const flag of flagsInSource(file)) expect(help, `${name} ${flag}`).toContain(flag);
    },
  );
});

describe('stroq --help and stroq help --all', () => {
  /** The first screen, in the order it lists them, after the bare `stroq`. */
  const CORE = ['init', 'why', 'attack', 'uninstall'];
  /** What Stroq writes into an agent's config (no person types these), and the card, which `stroq` runs. */
  const HIDDEN = ['hook', 'mcp', 'card', 'show'];
  /** The commands a screen lists: one per line that starts with `stroq <name>`, indented or not. */
  const listed = (text: string): string[] =>
    [...text.matchAll(/^ {0,2}stroq ([a-z][a-z-]*)/gm)].map((match) => match[1] ?? '');

  it('prints the same short screen for stroq --help, stroq -h and stroq help', () => {
    const screen = run('--help');
    expect(screen.status).toBe(0);
    expect(screen.stderr).toBe('');
    for (const args of [['-h'], ['help']])
      expect(run(...args).stdout, args.join(' ')).toBe(screen.stdout);
  });

  it('runs the card for a bare `stroq`, and passes the card its own flags', () => {
    // The home of this test holds no session: the card says so, as plain text (no terminal, no owl).
    const bare = run();
    expect(bare.status).toBe(0);
    expect(bare.stdout).toMatch(/^Hoo found no agent sessions in the last 30 days\./);
    expect(bare.stdout).not.toContain('\u001b[');
    expect(run('card').stdout).toBe(bare.stdout);
    expect(run('--days', '7').stdout).toMatch(/^Hoo found no agent sessions in the last 7 days\./);
    expect(JSON.parse(run('--json').stdout)).toMatchObject({ schema: 'stroq-card/1' });
    expect(run('--share').stdout).toMatch(/npx @stroq\/cli\n$/);
  });

  it('lists the bare `stroq` and the four core commands on that screen, in under 20 lines', () => {
    const text = run('--help').stdout;
    expect(listed(text)).toEqual(CORE);
    expect(text).toMatch(/^stroq {2,}who is really in charge of your agent\?/m);
    expect(text.trimEnd().split('\n').length).toBeLessThan(20);
    expect(text).toContain('stroq help --all');
  });

  it('lists every command but the hidden ones under help --all, and --help --all is the same', () => {
    const all = run('help', '--all');
    expect(all.status).toBe(0);
    const names = listed(all.stdout);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(
      commandNames()
        .filter((n) => !HIDDEN.includes(n))
        .sort(),
    );
    expect(run('--help', '--all').stdout).toBe(all.stdout);
  });

  it('shows the hidden commands on neither screen', () => {
    for (const text of [run('--help').stdout, run('help', '--all').stdout])
      for (const name of HIDDEN) expect(listed(text)).not.toContain(name);
  });

  it.each(commandNames())('%s still has a --help of its own', (name) => {
    const out = run(name, '--help');
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`^stroq ${name}\\b`));
  });
});

describe('a command line stroq cannot use', () => {
  it('suggests the command a typo meant, in a line or two', () => {
    const out = run('snet');
    expect(out.status).toBe(1);
    const text = out.stdout + out.stderr;
    expect(text).toContain('unknown command "snet"');
    expect(text).toContain('Did you mean "sent"?');
    expect(text.trim().split('\n').length).toBeLessThanOrEqual(3);
  });

  it('points an unknown command at the full list, not the short screen', () => {
    const out = run('foo');
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('Run "stroq help --all" for the list of commands.');
    expect(out.stderr).not.toContain('"stroq --help"');
  });

  it('names an unknown option and where to look, without a stack', () => {
    const out = run('log', '--bogus');
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('stroq log: unknown option --bogus');
    expect(out.stderr).toContain('stroq log --help');
    expect(out.stderr).not.toMatch(/TypeError|ERR_PARSE_ARGS|at /);
  });

  it('says which option is missing its value', () => {
    const out = run('init', '--agent');
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('--agent');
    expect(out.stderr).not.toMatch(/TypeError|ERR_PARSE_ARGS/);
  });

  it.each(['doctor', 'exposure', 'verify'])('%s refuses an option it does not have', (name) => {
    const out = run(name, '--json-typo');
    expect(out.status).toBe(2);
    expect(out.stderr).toContain(`stroq ${name}: unknown option --json-typo`);
  });

  it('does not wait on stdin when hook is run with no agent', async () => {
    const child = spawn(process.execPath, [CLI_ENTRY, 'hook'], {
      env: { ...process.env, STROQ_HOME: join(home, '.stroq') },
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, 5000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(2);
    expect(stdout).toMatch(/^stroq hook\b/);
  }, 10_000);
});
