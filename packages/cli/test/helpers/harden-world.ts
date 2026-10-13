import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { runHarden } from '../../src/commands/harden.js';
import type { HardenDeps } from '../../src/commands/harden-deps.js';
import { fakeEnv, steppingClock, tempDir } from '../harden/helpers.js';
import { fakeTerminal, type FakeTerminalOptions } from './fake-terminal.js';

/**
 * A world for the `stroq harden` command tests: a home directory, a project and a Stroq home, all
 * throwaway, passed to the command explicitly so that nothing of the real machine is read or written.
 * The command is run in process, with what it prints kept, and the clock moves a second at a time so
 * that every apply gets a copy of its own.
 */

export interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export interface HardenWorld {
  readonly home: string;
  readonly project: string;
  readonly stroqHome: string;
  /** A path in the home / in the project. */
  readonly inHome: (...parts: string[]) => string;
  readonly inProject: (...parts: string[]) => string;
  readonly deps: HardenDeps;
  /** Runs `stroq harden <args>`; `extra` replaces some of the world's own deps for this one run. */
  run(args: readonly string[], extra?: Partial<HardenDeps>): Promise<Run>;
  /** Runs it with a person at a terminal who types `answers`; `prompts` are the questions it was asked. */
  runAsking(
    args: readonly string[],
    answers: readonly (string | null)[],
  ): Promise<Run & { readonly prompts: readonly string[] }>;
  /** Runs it with a terminal that is not interactive: a pipe, a script. */
  runPiped(args: readonly string[]): Promise<Run>;
}

/** Runs `fn` with standard output and error kept instead of printed. */
export async function captured(fn: () => Promise<number>): Promise<Run> {
  let out = '';
  let err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

export function hardenWorld(overrides: Partial<HardenDeps> = {}): HardenWorld {
  const home = tempDir('home');
  const project = tempDir('project');
  const stroqHome = tempDir('stroq-home');
  const env = fakeEnv(stroqHome, { now: steppingClock() });
  const deps: HardenDeps = {
    cwd: project,
    home,
    stroqHome,
    now: env.now,
    version: '0.0.0-test',
    // Whatever the developer's own shell says, a test is not about it.
    claudeConfigDir: '',
    ...overrides,
  };
  const run = (args: readonly string[], extra: Partial<HardenDeps> = {}): Promise<Run> =>
    captured(() => runHarden(args, { ...deps, ...extra }));
  return {
    home,
    project,
    stroqHome,
    inHome: (...parts) => join(home, ...parts),
    inProject: (...parts) => join(project, ...parts),
    deps,
    run,
    runAsking: async (args, answers) => {
      const fake = fakeTerminal({ interactive: true, answers });
      const result = await run(args, { terminal: fake.term });
      return { ...result, prompts: fake.prompts };
    },
    runPiped: (args) => run(args, { terminal: fakeTerminal({ interactive: false }).term }),
  };
}

/** A person at a terminal whose questions are answered by `answer`, which may do something first. */
export function askingTerminal(
  answer: (prompt: string) => string | null | Promise<string | null>,
  options: FakeTerminalOptions = {},
) {
  const fake = fakeTerminal({ interactive: true, ...options });
  fake.read.mockImplementation(async (prompt: string) => {
    fake.prompts.push(prompt);
    return answer(prompt);
  });
  return fake;
}

/**
 * One hash of every file, link and directory name under `dir` and of the bytes of every file, so that
 * a test can say that a command wrote nothing: the hash before is the hash after.
 */
export function treeHash(dir: string): string {
  const hash = createHash('sha256');
  // What a directory holds is read once, with the kind of each entry, so that no name is looked at and
  // then opened as if it were still what it was; a file is opened and read through the one descriptor.
  const walk = (path: string, label: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const here = join(path, entry.name);
      const name = `${label}/${entry.name}`;
      if (entry.isSymbolicLink()) hash.update(`link ${name} -> ${readlinkSync(here)}\n`);
      else if (entry.isDirectory()) {
        hash.update(`dir ${name}\n`);
        walk(here, name);
      } else {
        const fd = openSync(here, 'r');
        try {
          hash.update(`file ${name} ${fstatSync(fd).mode & 0o777}\n`);
          hash.update(readFileSync(fd));
        } finally {
          closeSync(fd);
        }
      }
    }
  };
  hash.update('dir \n');
  walk(dir, '');
  return hash.digest('hex');
}
