// A program that stands in for `claude`, for the tests of the driver. It is a real executable in a temporary
// directory: the driver starts it as it starts the real host (a process, an argv, an environment, a working
// directory, pipes), so what is tested is the driver's handling of a process and not of a mock of one. It
// prints what the test tells it to print (the cleaned real streams, mostly), records how it was started, and
// can misbehave: hang with a child of its own, ignore SIGTERM, print more after its first line, flood.
//
// The real `claude` is never run by a test.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMULATOR_SOURCE } from './fake-claude-emulator.js';

/** What the fake does on one run (the n-th call of the test; the last behaviour repeats). */
export interface Behaviour {
  /** Printed one a line. */
  readonly lines?: readonly string[];
  /** Printed as it is: no newline is added. */
  readonly raw?: readonly string[];
  readonly stderr?: string;
  readonly exit?: number;
  /** After the first line: wait this long, write the `printed-more` marker, and print the rest. */
  readonly pauseAfterFirstLineMs?: number;
  /** After the lines: start a child of its own and wait for ever. */
  readonly hang?: boolean;
  /** With `hang`: ignore SIGTERM, and make the child ignore it too. */
  readonly ignoreTerm?: boolean;
  /** Print this many bytes of junk lines, for ever, until killed. */
  readonly flood?: boolean;
  /**
   * Behave as a host with a hook: run the hook command of the settings it was given, and obey it.
   * `apiKeySource` is what its first message says; `ignoreDeny` runs a command the hook denied;
   * `permissionStep` has its own permission step stop a command that no rule of `--allowedTools` covers
   * ("This command requires approval", as the real host does), and `alwaysAsk` names words it stops even
   * when a rule allows them: a host that does not honour a rule.
   */
  readonly emulate?: {
    readonly apiKeySource?: string;
    readonly ignoreDeny?: boolean;
    readonly permissionStep?: boolean;
    readonly alwaysAsk?: readonly string[];
    readonly pauseAfterInitMs?: number;
  };
  /**
   * Play back a stream a real host printed (the lines of a cleaned fixture), with the values the cleaner fixed
   * swapped for those of this request, and ask the real hook about the call in it, as `emulate` does.
   */
  readonly replay?: {
    readonly lines: readonly string[];
    readonly fixed: {
      readonly project: string;
      readonly session: string;
      readonly nonce: string;
      readonly fake: string;
    };
  };
}

export interface RecordedCall {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly pid: number;
}

export interface Scenario {
  readonly behaviours: readonly Behaviour[];
  /** What `--version` prints, and the code it exits with. */
  readonly version?: string;
  readonly versionExit?: number;
  readonly versionHangs?: boolean;
}

const SCRIPT = (execPath: string): string => `#!${execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const dir = new URL('.', import.meta.url).pathname;
const args = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(dir + 'scenario.json', 'utf8'));

if (args[0] === '--version') {
  appendFileSync(dir + 'versions.jsonl', JSON.stringify({ pid: process.pid }) + '\\n');
  if (scenario.versionHangs) await sleep(600000);
  process.stdout.write((scenario.version ?? '2.1.271 (Claude Code)') + '\\n');
  process.exit(scenario.versionExit ?? 0);
}

appendFileSync(
  dir + 'calls.jsonl',
  JSON.stringify({ argv: args, env: process.env, cwd: process.cwd(), pid: process.pid }) + '\\n',
);
const index = readFileSync(dir + 'calls.jsonl', 'utf8').split('\\n').filter(Boolean).length - 1;
const b = scenario.behaviours[Math.min(index, scenario.behaviours.length - 1)] ?? {};
if (b.ignoreTerm) process.on('SIGTERM', () => undefined);
if (b.emulate) {
  const { emulate } = await import('./emulator.mjs');
  emulate(args, b.emulate);
  process.exit(0);
}
if (b.replay) {
  const { replay } = await import('./emulator.mjs');
  replay(args, b.replay);
  process.exit(0);
}

const lines = b.lines ?? [];
for (let i = 0; i < lines.length; i += 1) {
  process.stdout.write(lines[i] + '\\n');
  if (i === 0 && b.pauseAfterFirstLineMs !== undefined) {
    await sleep(b.pauseAfterFirstLineMs);
    writeFileSync(dir + 'printed-more', 'the host went on after its first line');
  }
}
for (const piece of b.raw ?? []) process.stdout.write(piece);
if (b.stderr) process.stderr.write(b.stderr);

if (b.flood) {
  const junk = '{"type":"x","pad":"' + 'z'.repeat(60000) + '"}\\n';
  for (;;) {
    if (!process.stdout.write(junk)) await new Promise((r) => process.stdout.once('drain', r));
  }
}
if (b.hang) {
  const child = spawn(
    process.execPath,
    ['-e', (b.ignoreTerm ? "process.on('SIGTERM',()=>{});" : '') + 'setTimeout(()=>{},600000)'],
    { stdio: 'ignore' },
  );
  writeFileSync(dir + 'grandchild.pid', String(child.pid));
  await sleep(600000);
}
process.exitCode = b.exit ?? 0;
`;

export interface FakeClaude {
  readonly dir: string;
  /** The program: what `STROQ_CLAUDE_BIN` or the driver's `bin` names. */
  readonly bin: string;
  script(scenario: Scenario | readonly Behaviour[]): void;
  calls(): readonly RecordedCall[];
  versionCalls(): number;
  /** The pid of the child a hanging run started, if it started one. */
  grandchildPid(): number | null;
  /** Whether the run went on to print after its first line (it should not have, when it was stopped there). */
  printedMore(): boolean;
  cleanup(): void;
}

/** Whether a shebang can name this node: no blank in the path, and not too long for the kernel. */
export const canMakeFakeClaude = (execPath: string = process.execPath): boolean =>
  process.platform !== 'win32' && !/\s/.test(execPath) && execPath.length < 100;

const readLines = (file: string): string[] => {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    return [];
  }
};

export function makeFakeClaude(): FakeClaude {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-fake-claude-'));
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'claude');
  writeFileSync(bin, SCRIPT(process.execPath), { mode: 0o755 });
  chmodSync(bin, 0o755);
  // An .mjs next to it cannot be: the file is `claude`, and Node reads a file with no extension as
  // CommonJS unless told otherwise, so the package type is told.
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(dir, 'emulator.mjs'), EMULATOR_SOURCE);
  const fake: FakeClaude = {
    dir,
    bin,
    script: (scenario) =>
      writeFileSync(
        join(dir, 'scenario.json'),
        JSON.stringify(Array.isArray(scenario) ? { behaviours: scenario } : scenario),
      ),
    calls: () => readLines(join(dir, 'calls.jsonl')).map((l) => JSON.parse(l) as RecordedCall),
    versionCalls: () => readLines(join(dir, 'versions.jsonl')).length,
    grandchildPid: () => {
      const text = readLines(join(dir, 'grandchild.pid'))[0];
      return text === undefined ? null : Number(text);
    },
    printedMore: () => readLines(join(dir, 'printed-more')).length > 0,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  fake.script({ behaviours: [{}] });
  return fake;
}

export interface FakeTools {
  /** A directory to put in front of the `PATH` of the host. */
  readonly dir: string;
  cleanup(): void;
}

/**
 * Stand-ins for the two programs the probes run that a test machine should not run for real: a `curl` that fails
 * the way an unresolvable host does, so the egress probe makes no request, and a `git` that leaves in the file what
 * `git config --file <file> core.hooksPath <value>` leaves in it, byte for byte (`probes-deny.test.ts` holds those
 * bytes to the real git where there is one), so that a machine with no git can still be the host's.
 */
export function makeFakeTools(): FakeTools {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-fake-tools-'));
  const programs: Readonly<Record<string, string>> = {
    curl: '#!/bin/sh\nexit 6\n',
    git:
      '#!/bin/sh\n[ "$1" = config ] && [ "$2" = --file ] && [ "$4" = core.hooksPath ] || exit 1\n' +
      'printf \'[core]\\n\\thooksPath = %s\\n\' "$5" > "$3"\n',
  };
  for (const [name, text] of Object.entries(programs)) {
    writeFileSync(join(dir, name), text, { mode: 0o755 });
    chmodSync(join(dir, name), 0o755);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Whether a process with this pid is alive (a zombie that has not been reaped counts as alive). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
