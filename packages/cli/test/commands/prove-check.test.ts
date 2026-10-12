import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LEDGER_ENV, openLedger } from '../../src/live/budget.js';
import { type HostDriver, type HostRun } from '../../src/live/types.js';
import {
  HONEST_LIVE,
  json,
  leftBehind,
  prove,
  putPolicyFile,
  RUNS_HERE,
  stroqHome,
  temp,
} from './prove-world.js';

/**
 * `stroq prove`, the command, while it works: a dry run, what it spends from, what it leaves behind, and
 * what becomes of it when it is interrupted.
 */

/** The names of what is below a directory, or none when it is not there: one read, with no look first. */
function namesBelow(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

describe.skipIf(!RUNS_HERE)('a dry run', () => {
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

describe.skipIf(!RUNS_HERE)('what it spends from', () => {
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
    expect(namesBelow(stroqHome).filter((name) => /ledger/i.test(name))).toEqual([]);
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

describe.skipIf(!RUNS_HERE)('what it leaves behind', () => {
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

describe.skipIf(!RUNS_HERE)('a check that is interrupted', () => {
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
