import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProve, type ProveDeps } from '../../src/commands/prove.js';
import { LEDGER_ENV, openLedger } from '../../src/live/budget.js';
import { readHostResult } from '../../src/live/store.js';
import type { HostDriver, HostRun } from '../../src/live/types.js';
import { FakeHostDriver, type FakeOptions, type Fault } from '../live/fake-driver.js';
import { sequentialIds } from '../live/verify-harness.js';
import { fakeTerminal } from '../helpers/fake-terminal.js';

/**
 * `stroq prove`, the command: what it asks before it spends anything, what it spends, what it leaves, what it
 * prints, and what it exits with. The host is the stand-in of `test/live/fake-driver.ts` (told it is live
 * where a test needs a live answer, which only a test may say); the real `claude` is never started.
 */
let temp: string;
let stroqHome: string;
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

const leftBehind = (): string[] =>
  readdirSync(temp).filter((name) => name.startsWith('stroq-prove-'));

/** What a command printed, and how it ended. */
interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly driver: FakeHostDriver | null;
}

interface World extends Partial<ProveDeps> {
  /** The stand-in host, told how to misbehave: shorthand for `fake: { fault }`. */
  readonly fault?: Fault;
  readonly fake?: FakeOptions;
  /** Tell the command the host is a real one: only a test may say so. */
  readonly live?: boolean;
}

async function prove(args: string[], world: World = {}): Promise<Ran> {
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
function putPolicyFile(): void {
  mkdirSync(stroqHome, { recursive: true });
  copyFileSync(DEFAULT_POLICY_FILE, join(stroqHome, 'policy.yaml'));
}

const HONEST_LIVE: World = { fault: 'honest', live: true };

const json = (ran: Ran): Record<string, unknown> => JSON.parse(ran.out) as Record<string, unknown>;

const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

describe('a command line it cannot use', () => {
  it.each([['0'], ['7'], ['abc'], ['2.5'], [''], ['-1'], ['3x']])(
    'refuses --max-requests %j, with exit 2 and the way to see the options',
    async (value) => {
      const ran = await prove(['--max-requests', value], HONEST_LIVE);
      expect(ran.code).toBe(2);
      expect(ran.err).toContain('--max-requests');
      expect(ran.err).toContain('stroq prove --help');
      expect(ran.driver?.calls).toEqual([]);
    },
  );

  it.each([['1'], ['3'], ['6']])('takes --max-requests %s', async (value) => {
    const ran = await prove(['--max-requests', value, '--yes'], HONEST_LIVE);
    expect(ran.driver?.calls.length).toBeLessThanOrEqual(Number(value));
    expect(ran.code).not.toBe(2);
  });

  it('refuses a word that is not an option', async () => {
    const ran = await prove(['claude-code'], HONEST_LIVE);
    expect(ran.code).toBe(2);
    expect(ran.err).toContain('stroq prove');
    expect(ran.err).not.toMatch(/TypeError|ERR_PARSE_ARGS/);
  });

  it('refuses an option without its value', async () => {
    const ran = await prove(['--agent'], HONEST_LIVE);
    expect(ran.code).toBe(2);
    expect(ran.err).toContain('--agent');
  });

  it('does not offer a way to leave the control out', async () => {
    const ran = await prove(['--no-control', '--yes'], HONEST_LIVE);
    expect(ran.code).toBe(2);
    expect(ran.driver?.calls).toEqual([]);
  });
});

describe('a host it cannot check', () => {
  it.each([
    'codex',
    'cursor',
    'windsurf',
    'antigravity',
    'copilot',
    'openclaw',
    'mcp',
    'nothing-like-it',
  ])(
    'says %s is not supported yet, names the ones that are, and exits 3 without asking a host',
    async (agent) => {
      const ran = await prove(['--agent', agent, '--yes'], HONEST_LIVE);
      expect(ran.code).toBe(3);
      expect(ran.out).toMatch(/NOT SUPPORTED/);
      expect(ran.out).toContain('claude-code');
      expect(ran.out).not.toMatch(/VERIFIED/);
      expect(ran.driver?.calls).toEqual([]);
      expect(leftBehind()).toEqual([]);
    },
  );

  it('says why, for a host the table knows cannot be driven', async () => {
    const ran = await prove(['--agent', 'cursor', '--yes'], HONEST_LIVE);
    expect(ran.out.replace(/\s+/g, ' ')).toContain('no verified headless hook mode');
  });

  it('does not print an agent name raw', async () => {
    const ran = await prove(['--agent', '\u001b]52;c;AAAA\u0007evil', '--yes'], HONEST_LIVE);
    expect(ran.code).toBe(3);
    expect(ran.out + ran.err).not.toMatch(RAW_CONTROL);
  });

  it('says so, in JSON, as a state of its own', async () => {
    const ran = await prove(['--agent', 'codex', '--yes', '--json'], HONEST_LIVE);
    expect(json(ran)).toMatchObject({
      version: 1,
      agent: 'codex',
      state: 'unsupported',
      mode: null,
      probes: [],
      requestsMade: 0,
    });
  });

  it('says the check does not run on Windows yet, and exits 3', async () => {
    const ran = await prove(['--yes'], { ...HONEST_LIVE, platform: 'win32' });
    expect(ran.code).toBe(3);
    expect(ran.out).toMatch(/Windows/);
    expect(ran.driver?.calls).toEqual([]);
  });

  it('says the host is not there, makes no request, writes nothing and exits 3', async () => {
    const ran = await prove(['--yes'], {
      ...HONEST_LIVE,
      fake: { fault: 'honest', available: false, note: 'claude was not found' },
    });
    expect(ran.code).toBe(3);
    expect(ran.out).toMatch(/NOT RUN/);
    expect(ran.out).toContain('claude was not found');
    expect(ran.driver?.calls).toEqual([]);
    expect(existsSync(join(stroqHome, 'live'))).toBe(false);
    expect(leftBehind()).toEqual([]);
  });
});

describe('what it asks before it spends anything', () => {
  it('refuses, with exit 2 and the word to say, where nobody can answer and --yes was not said', async () => {
    const ran = await prove([], HONEST_LIVE);
    expect(ran.code).toBe(2);
    expect(ran.err).toContain('--yes');
    expect(ran.driver?.calls).toEqual([]);
    expect(existsSync(join(stroqHome, 'live'))).toBe(false);
    expect(leftBehind()).toEqual([]);
  });

  it('says what a run costs in the same breath, even where it refuses', async () => {
    const ran = await prove([], HONEST_LIVE);
    expect((ran.out + ran.err).replace(/\s+/g, ' ')).toMatch(/up to 3 short requests/);
  });

  it('shows the cost and asks y/N on a terminal, and takes no for an answer', async () => {
    const term = fakeTerminal({ interactive: true, answers: ['n'] });
    const ran = await prove([], { ...HONEST_LIVE, terminal: term.term });
    expect(ran.code).toBe(3);
    expect(term.prompts).toHaveLength(1);
    expect(term.prompts[0]).toMatch(/y\/N/);
    expect(ran.out + term.out()).toMatch(/up to 3 short requests/);
    expect(ran.driver?.calls).toEqual([]);
    expect(leftBehind()).toEqual([]);
  });

  it.each([[''], [null], ['maybe'], ['no']])(
    'does not go on when the answer is %j (the end of the input is a no)',
    async (answer) => {
      const term = fakeTerminal({ interactive: true, answers: [answer, answer, answer] });
      const ran = await prove([], { ...HONEST_LIVE, terminal: term.term });
      expect(ran.code).toBe(3);
      expect(ran.driver?.calls).toEqual([]);
    },
  );

  it.each([['y'], ['yes'], ['Y']])('goes on when the answer is %j', async (answer) => {
    const term = fakeTerminal({ interactive: true, answers: [answer] });
    const ran = await prove([], { ...HONEST_LIVE, terminal: term.term });
    expect(ran.code).toBe(0);
    expect(ran.driver?.calls.length).toBe(3);
  });

  it('does not ask when --yes was said, and still says the cost', async () => {
    const term = fakeTerminal({ interactive: true, answers: [] });
    const ran = await prove(['--yes'], { ...HONEST_LIVE, terminal: term.term });
    expect(ran.code).toBe(0);
    expect(term.prompts).toEqual([]);
    expect(ran.out.replace(/\s+/g, ' ')).toMatch(/up to 3 short requests/);
  });

  it('counts the requests it says it may make from --max-requests', async () => {
    const ran = await prove(['--yes', '--max-requests', '5'], HONEST_LIVE);
    expect(ran.out.replace(/\s+/g, ' ')).toMatch(/up to 5 short requests/);
  });
});

describe('what it exits with', () => {
  it('is 0 for a live check that verified the host', async () => {
    const ran = await prove(['--yes'], HONEST_LIVE);
    expect(ran.code, ran.err).toBe(0);
    expect(ran.out).toMatch(/VERIFIED/);
  });

  it('is 1 for a live check that failed', async () => {
    const ran = await prove(['--yes'], { fault: 'ignore-deny', live: true });
    expect(ran.code).toBe(1);
    expect(ran.out).toMatch(/FAILED/);
    expect(ran.out).not.toMatch(/VERIFIED/);
  });

  it.each(['limit', 'timeout', 'host-error', 'garbage', 'refusal', 'api-billing'] as const)(
    'is 3 for a live check that could not tell (%s), which is never verified',
    async (fault) => {
      const ran = await prove(['--yes'], { fault, live: true });
      expect(ran.code).toBe(3);
      expect(ran.out).not.toMatch(/VERIFIED/);
    },
  );

  it('is 3 for a stand-in, even when its probes all passed, and does not print it as verified', async () => {
    const ran = await prove(['--yes'], { fault: 'honest' });
    expect(ran.code).toBe(3);
    expect(ran.out).toMatch(/STAND-IN/);
    expect(ran.out).not.toMatch(/VERIFIED/);
  });

  it('is 3 for a driver that throws, and says what happened, and leaves nothing behind', async () => {
    const broken: HostDriver = {
      detect: () => Promise.resolve({ available: true, version: '1.0.0' }),
      run: () => Promise.reject(new Error('the driver fell over')),
      mode: 'live',
    };
    const ran = await prove(['--yes'], { makeDriver: () => broken });
    expect(ran.code).toBe(3);
    expect(ran.out).not.toMatch(/VERIFIED/);
    expect(leftBehind()).toEqual([]);
  });
});

describe('a dry run', () => {
  it('makes no request, writes nothing and exits 0', async () => {
    const ledger = join(temp, 'ledger.json');
    process.env[LEDGER_ENV] = ledger;
    const ran = await prove(['--dry-run'], HONEST_LIVE);
    expect(ran.code).toBe(0);
    expect(ran.driver?.calls).toEqual([]);
    expect(existsSync(ledger)).toBe(false);
    expect(existsSync(join(stroqHome, 'live'))).toBe(false);
    expect(leftBehind()).toEqual([]);
    expect(ran.out).toMatch(/Dry run/);
    expect(ran.out).toMatch(/no request was made/);
  });

  it('needs no --yes, because it spends nothing', async () => {
    const ran = await prove(['--dry-run'], HONEST_LIVE);
    expect(ran.code).toBe(0);
  });

  it('names the hook line it would run and the policy it would use', async () => {
    const ran = await prove(['--dry-run'], HONEST_LIVE);
    expect(ran.out).toContain('hook claude-code');
    expect(ran.out).toContain(process.execPath);
    expect(ran.out).toMatch(/policy: default/);
  });

  it('names the policy file when there is one', async () => {
    putPolicyFile();
    const ran = await prove(['--dry-run'], HONEST_LIVE);
    expect(ran.out).toContain('policy.yaml');
  });

  it('says so in JSON, as a check that was not run', async () => {
    const ran = await prove(['--dry-run', '--json'], HONEST_LIVE);
    expect(ran.code).toBe(0);
    expect(json(ran)).toMatchObject({
      version: 1,
      state: 'not-attempted',
      mode: null,
      probes: [],
      requestsMade: 0,
    });
  });

  it('still looks for the host, and says when it is not there', async () => {
    const ran = await prove(['--dry-run'], {
      ...HONEST_LIVE,
      fake: { fault: 'honest', available: false, note: 'claude was not found' },
    });
    expect(ran.code).toBe(3);
    expect(ran.out).toContain('claude was not found');
  });
});

describe('what it spends from', () => {
  it('counts the requests in the file STROQ_LIVE_LEDGER names, when it is set', async () => {
    const ledger = join(temp, 'owner', 'ledger.json');
    process.env[LEDGER_ENV] = ledger;
    const ran = await prove(['--yes'], HONEST_LIVE);
    expect(ran.code).toBe(0);
    const file = JSON.parse(readFileSync(ledger, 'utf8')) as { used: number; limit: number };
    expect(file).toMatchObject({ used: 3, limit: 30 });
  });

  it('stops where the owner’s file has no requests left, whatever --max-requests says', async () => {
    const ledger = join(temp, 'ledger.json');
    process.env[LEDGER_ENV] = ledger;
    await openLedger({ path: ledger, limit: 30 }).take(29, 'earlier');
    const ran = await prove(['--yes', '--max-requests', '6', '--json'], HONEST_LIVE);
    expect(ran.driver?.calls).toHaveLength(1);
    const marks = (json(ran)['probes'] as { id: string; mark: string; reason: string }[]).map(
      (p) => `${p.id}:${p.mark}:${p.reason}`,
    );
    expect(marks).toContain('secret-egress:not-attempted:budget');
    expect(ran.code).toBe(3);
  });

  it('keeps the count in memory, to the cap of the run, and writes no ledger, when it is not set', async () => {
    const ran = await prove(['--yes', '--max-requests', '2'], HONEST_LIVE);
    expect(ran.driver?.calls).toHaveLength(2);
    const files = existsSync(stroqHome) ? readdirSync(stroqHome, { recursive: true }) : [];
    expect(files.map(String).filter((name) => /ledger/i.test(name))).toEqual([]);
  });

  it('refuses a ledger it cannot use, before it asks or spends', async () => {
    process.env[LEDGER_ENV] = 'relative/ledger.json';
    const ran = await prove(['--yes'], HONEST_LIVE);
    expect(ran.code).toBe(3);
    expect(ran.err + ran.out).toContain(LEDGER_ENV);
    expect(ran.driver?.calls).toEqual([]);
    expect(leftBehind()).toEqual([]);
  });
});

describe('what it leaves behind', () => {
  it('removes its temporary folder when the check ends well', async () => {
    const ran = await prove(['--yes'], HONEST_LIVE);
    expect(ran.code).toBe(0);
    expect(leftBehind()).toEqual([]);
  });

  it('removes it when the check fails', async () => {
    await prove(['--yes'], { fault: 'ignore-deny', live: true });
    expect(leftBehind()).toEqual([]);
  });

  it('removes it when something in the check throws, and says so', async () => {
    const ran = await prove(['--yes'], {
      ...HONEST_LIVE,
      ids: {
        nonce: () => {
          throw new Error('no randomness today');
        },
      },
    });
    expect(ran.code).toBe(3);
    expect(ran.out + ran.err).toContain('no randomness today');
    expect(leftBehind()).toEqual([]);
    expect(existsSync(join(stroqHome, 'live'))).toBe(false);
  });

  it('changes no file of the user’s: only the folder of the result is written in the Stroq home', async () => {
    putPolicyFile();
    const before = readFileSync(join(stroqHome, 'policy.yaml'), 'utf8');
    const ran = await prove(['--yes'], HONEST_LIVE);
    expect(ran.code).toBe(0);
    expect(readFileSync(join(stroqHome, 'policy.yaml'), 'utf8')).toBe(before);
    expect(readdirSync(stroqHome).sort()).toEqual(['live', 'policy.yaml']);
  });
});

describe('a check that is interrupted', () => {
  function interruptible() {
    const handlers = new Map<string, () => void>();
    const signals = {
      on: (signal: NodeJS.Signals, listener: () => void) => handlers.set(signal, listener),
      off: (signal: NodeJS.Signals) => handlers.delete(signal),
    };
    return { handlers, signals, reraise: vi.fn<(signal: NodeJS.Signals) => void>() };
  }

  it('ends the host, removes its folder, and ends as the signal would have', async () => {
    const { handlers, signals, reraise } = interruptible();
    let seen: AbortSignal | undefined;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waiting: HostDriver = {
      detect: () => Promise.resolve({ available: true, version: '1.2.3' }),
      run: async (): Promise<HostRun> => {
        started();
        await gate;
        return { stream: [], exitCode: null, timedOut: false, stderrTail: 'interrupted' };
      },
      mode: 'live',
    };
    const pending = prove(['--yes'], {
      makeDriver: (_line: string, signal: AbortSignal) => {
        seen = signal;
        return waiting;
      },
      signals,
      reraise,
    });
    const first = await Promise.race([running.then(() => 'started'), pending.then(() => 'ended')]);
    expect(first).toBe('started');
    expect(leftBehind()).toHaveLength(1);
    expect([...handlers.keys()].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);

    handlers.get('SIGINT')?.();

    // At once, before the host has answered: the host is told to end, and the folder is gone.
    expect(seen?.aborted).toBe(true);
    expect(leftBehind()).toEqual([]);
    expect(reraise).toHaveBeenCalledWith('SIGINT');
    release();
    await pending;
    expect(leftBehind()).toEqual([]);
  });

  it('stops listening for signals when the check is over', async () => {
    const { handlers, signals, reraise } = interruptible();
    await prove(['--yes'], { ...HONEST_LIVE, signals, reraise });
    expect([...handlers.keys()]).toEqual([]);
    expect(reraise).not.toHaveBeenCalled();
  });

  it('stops listening when the check throws', async () => {
    const { handlers, signals, reraise } = interruptible();
    await prove(['--yes'], {
      ...HONEST_LIVE,
      signals,
      reraise,
      ids: {
        nonce: () => {
          throw new Error('boom');
        },
      },
    });
    expect([...handlers.keys()]).toEqual([]);
  });
});

describe('what it keeps', () => {
  it('keeps a live verification where the doctor reads it', async () => {
    await prove(['--yes'], HONEST_LIVE);
    const stored = readHostResult(stroqHome, 'claude-code');
    expect(stored.problem).toBeNull();
    expect(stored.result).toMatchObject({
      agent: 'claude-code',
      state: 'verified',
      mode: 'live',
      at: '2026-10-12T12:00:00.000Z',
    });
  });

  it('keeps a live failure there too, because a failure stays one until a later check says otherwise', async () => {
    await prove(['--yes'], { fault: 'ignore-deny', live: true });
    expect(readHostResult(stroqHome, 'claude-code').result?.state).toBe('failed');
  });

  it('keeps a check that could not tell where it cannot replace a result that could', async () => {
    await prove(['--yes'], HONEST_LIVE);
    await prove(['--yes'], { fault: 'limit', live: true });
    expect(readHostResult(stroqHome, 'claude-code').result?.state).toBe('verified');
    expect(existsSync(join(stroqHome, 'live', 'claude-code.last.json'))).toBe(true);
  });

  it('keeps what a stand-in said apart, and never as the result of the host', async () => {
    await prove(['--yes'], { fault: 'honest' });
    expect(readHostResult(stroqHome, 'claude-code').result).toBeNull();
    expect(existsSync(join(stroqHome, 'live', 'claude-code.stand-in.json'))).toBe(true);
  });

  it('says where it kept it', async () => {
    const ran = await prove(['--yes'], HONEST_LIVE);
    expect(ran.out).toContain(join(stroqHome, 'live', 'claude-code.json'));
  });
});

describe('what it prints', () => {
  it('prints the table, the verdict and the advice for a person', async () => {
    const ran = await prove(['--yes'], HONEST_LIVE);
    expect(ran.out).toMatch(/Probe\s+Mark\s+Why/);
    expect(ran.out).toMatch(/VERIFIED/);
    expect(ran.out).toMatch(/Advice/);
    expect(ran.out).toMatch(/does not show that your own settings file is loaded/);
  });

  it('prints one JSON document of version 1 with --json, and the notice on the other stream', async () => {
    const ran = await prove(['--yes', '--json'], HONEST_LIVE);
    const doc = json(ran);
    expect(Object.keys(doc).sort()).toEqual(
      [
        'advice',
        'agent',
        'caveats',
        'hostVersion',
        'mode',
        'probes',
        'requestsMade',
        'state',
        'version',
      ].sort(),
    );
    expect(doc).toMatchObject({
      version: 1,
      agent: 'claude-code',
      hostVersion: '9.9.9-fake',
      state: 'verified',
      mode: 'live',
      requestsMade: 3,
    });
    expect(ran.out.trim().split('\n').length).toBeGreaterThan(1);
    expect(ran.out.endsWith('\n')).toBe(true);
    expect(ran.err.replace(/\s+/g, ' ')).toMatch(/up to 3 short requests/);
  });

  it('gives each probe of the JSON its id, kind, mark, reason, detail where there is one, and evidence', async () => {
    const ran = await prove(['--yes', '--json', '--max-requests', '2'], HONEST_LIVE);
    const probes = json(ran)['probes'] as Record<string, unknown>[];
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      expect(
        Object.keys(probe)
          .filter((k) => k !== 'detail')
          .sort(),
      ).toEqual(['evidence', 'id', 'kind', 'mark', 'reason'].sort());
      expect(Object.keys(probe['evidence'] as object).sort()).toEqual(['E1', 'E2', 'E3', 'E4']);
    }
    expect(probes.find((p) => p['id'] === 'allow')).toMatchObject({
      mark: 'passed',
      reason: 'ran',
    });
  });

  it('says in JSON that a stand-in is not verified', async () => {
    const ran = await prove(['--yes', '--json'], { fault: 'honest' });
    expect(json(ran)).toMatchObject({ mode: 'stand-in', state: 'not-attempted' });
    expect(ran.out).not.toMatch(/"verified"/);
  });

  it('prints no control character it was given by the host', async () => {
    const hostile = '\u001b]52;c;AAAA\u0007\u001b[31mred\u001b[0m\u009b2J‮';
    const driver: HostDriver = {
      detect: () => Promise.resolve({ available: true, version: `1.0.0${hostile}`, note: hostile }),
      run: (): Promise<HostRun> =>
        Promise.resolve({
          stream: [{ type: 'result', isError: true, text: `usage limit ${hostile}` }],
          exitCode: 1,
          timedOut: false,
          stderrTail: hostile,
          limitHit: `usage limit ${hostile}`,
          apiKeySource: `none${hostile}`,
          cwd: hostile,
        }),
      mode: 'live',
    };
    for (const args of [['--yes'], ['--yes', '--json'], ['--dry-run']]) {
      const ran = await prove(args, { makeDriver: () => driver });
      expect(ran.out + ran.err, args.join(' ')).not.toMatch(RAW_CONTROL);
    }
  });
});
