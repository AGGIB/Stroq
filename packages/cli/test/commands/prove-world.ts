import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach } from 'vitest';
import { type ProveDeps, runProve } from '../../src/commands/prove.js';
import { LEDGER_ENV } from '../../src/live/budget.js';
import { type HostDriver } from '../../src/live/types.js';
import { FakeHostDriver, type FakeOptions, type Fault } from '../live/fake-driver.js';
import { sequentialIds } from '../live/verify-harness.js';
import { fakeTerminal } from '../helpers/fake-terminal.js';

/**
 * The world `stroq prove` is tried in: a short temporary directory that is the TMPDIR (the commands of the
 * probes hold the path of the folder a check runs in, and the audit log keeps 300 characters of a command), a
 * Stroq home and a HOME of its own, and a stand-in for the host. The real `claude` is never started.
 */
export let temp: string;
export let stroqHome: string;
let saved: Record<string, string | undefined>;

const ENV_NAMES = ['STROQ_HOME', 'HOME', 'USERPROFILE', 'TMPDIR', LEDGER_ENV] as const;

beforeEach(() => {
  // A short name: the audit log keeps 300 characters of a command, and the commands of the probes hold the
  // path of the folder they run in, so a long temporary directory is a check that refuses to run.
  temp = mkdtempSync(join(tmpdir(), 'p-'));
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  stroqHome = join(temp, 'stroq-home');
  mkdirSync(join(temp, 'home'));
  process.env['STROQ_HOME'] = stroqHome;
  process.env['HOME'] = join(temp, 'home');
  process.env['USERPROFILE'] = join(temp, 'home');
  // Every throwaway root the command makes is made here, and one that is left behind is seen.
  process.env['TMPDIR'] = temp;
  delete process.env[LEDGER_ENV];
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const was = saved[name];
    if (was === undefined) delete process.env[name];
    else process.env[name] = was;
  }
  rmSync(temp, { recursive: true, force: true });
});

export const leftBehind = (): string[] =>
  readdirSync(temp).filter((name) => name.startsWith('stroq-prove-'));

/** What a command printed, and how it ended. */
export interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly driver: FakeHostDriver | null;
}

export interface World extends Partial<ProveDeps> {
  /** The stand-in host, told how to misbehave: shorthand for `fake: { fault }`. */
  readonly fault?: Fault;
  readonly fake?: FakeOptions;
  /** Tell the command the host is a real one: only a test may say so. */
  readonly live?: boolean;
}

export async function prove(args: string[], world: World = {}): Promise<Ran> {
  const { fault, fake: fakeOptions, live, ...deps } = world;
  const out: string[] = [];
  const err: string[] = [];
  const options = fakeOptions ?? (fault === undefined ? null : { fault });
  const fake = options === null ? null : new FakeHostDriver(options);
  const shown: HostDriver | null =
    fake === null
      ? null
      : {
          detect: () => fake.detect(),
          run: (probe, ctx) => fake.run(probe, ctx),
          ...(live === true ? { mode: 'live' as const } : {}),
        };
  const code = await runProve(args, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    terminal: fakeTerminal().term,
    ids: sequentialIds(),
    now: () => new Date('2026-10-12T12:00:00.000Z'),
    // The environment of a user who has set the owner's ledger, if the test has.
    env: {
      PATH: '/usr/bin:/bin',
      ...(process.env[LEDGER_ENV] === undefined ? {} : { [LEDGER_ENV]: process.env[LEDGER_ENV] }),
    },
    ...(shown === null ? {} : { makeDriver: () => shown }),
    ...deps,
  });
  return { code, out: out.join(''), err: err.join(''), driver: fake };
}

/** The shipped policy as the user's own file: a policy that is valid, and says what the default says. */
const DEFAULT_POLICY_FILE = fileURLToPath(
  new URL('../../../../policies/default.yaml', import.meta.url),
);
export function putPolicyFile(): void {
  mkdirSync(stroqHome, { recursive: true });
  copyFileSync(DEFAULT_POLICY_FILE, join(stroqHome, 'policy.yaml'));
}

export const HONEST_LIVE: World = { fault: 'honest', live: true };

export const json = (ran: Ran): Record<string, unknown> =>
  JSON.parse(ran.out) as Record<string, unknown>;

export const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
