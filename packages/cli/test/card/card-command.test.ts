import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardDirIn } from '../../src/paths.js';
import { CLI_ENTRY } from '../helpers/cli-entry.js';
import { AWS_KEY, furnish, machine, populate, PROJECT_KEY, type Machine } from './machine.js';

/**
 * `stroq card` and `stroq show` as a person runs them: the built bundle, in its own process, on a
 * throwaway machine, with the worker threads the bundle starts. Nothing of the real machine is in the
 * environment it is given.
 */

let m: Machine;
beforeEach(() => {
  m = machine();
  furnish(m);
  populate(m);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function stroq(args: string[], extra: Record<string, string> = {}) {
  const run = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: m.work,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: m.home,
      USERPROFILE: m.home,
      STROQ_HOME: m.stroqHome,
      ...extra,
    },
    timeout: 120_000,
  });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

/** The card with what depends on the run (time, cache) taken out. */
const stable = (json: string) => {
  const data = JSON.parse(json) as { generated?: string; timing?: unknown; coverage: object };
  return {
    ...data,
    generated: undefined,
    timing: undefined,
    coverage: { ...data.coverage, fromCache: 0, keysFromCache: 0 },
  };
};

describe('stroq card', () => {
  it('prints the card for the sessions of the last 30 days and exits 0 though it found something', () => {
    const { code, out, err } = stroq(['card']);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toMatch(
      /^Hoo checked 30 days of your agent sessions\n4 sessions · Claude Code and Codex · this machine\n/,
    );
    expect(out).toContain('Worth a look');
    expect(out).toContain('stroq show 1');
    expect(out).toContain('Stop this next time:  npx @stroq/cli init');
    for (const line of out.split('\n')) expect([...line].length, line).toBeLessThanOrEqual(60);
  });

  it('prints the same card as JSON, from worker threads, and as one thread', () => {
    const threads = stroq(['card', '--json']);
    expect(threads.code).toBe(0);
    const data = JSON.parse(threads.out) as {
      schema: string;
      counts: Record<string, number>;
      timing: { workers: number; replayed: number };
    };
    expect(data.schema).toBe('stroq-card/1');
    expect(data.counts).toMatchObject({
      commands: 5,
      toldByText: 1,
      keysSent: 1,
      keysSeen: 1,
      autorunRepos: 1,
    });
    expect(data.timing.workers).toBeGreaterThanOrEqual(1);
    expect(data.timing.replayed).toBe(4);
    // A second run with no cache and no threads gives the same card.
    const cache = join(cardDirIn(m.stroqHome), 'sessions.json');
    expect(readFileSync(cache, 'utf8')).toContain('stroq-card-sessions/1');
    const single = stroq(['card', '--json'], {
      STROQ_CARD_THREADS: '0',
      STROQ_HOME: join(m.root, 'stroq2'),
    });
    expect(stable(single.out)).toEqual(stable(threads.out));
  });

  it('is served from the cache the second time', () => {
    stroq(['card']);
    const warm = JSON.parse(stroq(['card', '--json']).out) as {
      timing: { replayed: number };
      coverage: { fromCache: number };
    };
    expect(warm.timing.replayed).toBe(0);
    expect(warm.coverage.fromCache).toBe(4);
  });

  it('prints one line of counts for --share, with no path, name or host, ending with the command', () => {
    const { code, out } = stroq(['card', '--share']);
    expect(code).toBe(0);
    expect(out.trimEnd().split('\n')).toHaveLength(1);
    expect(out.trimEnd()).toMatch(/ npx @stroq\/cli$/);
    expect(out).not.toMatch(/invalid|STRIPE|aws_secret|\/Users|\/private|~\//);
  });

  it('keeps no key value in what it prints or keeps', () => {
    const outputs = [
      stroq(['card']).out,
      stroq(['card', '--json']).out,
      stroq(['card', '--share']).out,
    ];
    const kept = readdirSync(cardDirIn(m.stroqHome)).map((f) =>
      readFileSync(join(cardDirIn(m.stroqHome), f), 'utf8'),
    );
    for (const text of [...outputs, ...kept]) {
      expect(text).not.toContain(AWS_KEY);
      expect(text).not.toContain(PROJECT_KEY);
    }
  });

  it('takes --days from 1 to 365 and refuses the rest with exit 2', () => {
    expect(stroq(['card', '--days', '7', '--share']).code).toBe(0);
    for (const days of ['0', '366', 'x', '1.5']) {
      const { code, err } = stroq(['card', '--days', days]);
      expect(code, days).toBe(2);
      expect(err, days).toContain('--days takes a whole number of days from 1 to 365');
    }
  });

  it('refuses --json with --share, an unknown option, and a missing number of days, with exit 2', () => {
    expect(stroq(['card', '--days', '-3']).code).toBe(2);
    expect(stroq(['card', '--json', '--share']).code).toBe(2);
    expect(stroq(['card', '--bogus']).code).toBe(2);
  });

  it('says where it looked when there is no session', () => {
    const { code, out } = stroq(['card'], {
      HOME: join(m.root, 'empty-home'),
      USERPROFILE: join(m.root, 'empty-home'),
    });
    expect(code).toBe(0);
    expect(out).toContain('Hoo found no agent sessions in the last 30 days.');
    expect(out).toContain('.claude/projects');
    expect(out).toContain('.codex/sessions');
  });

  it('has its own --help', () => {
    const { code, out } = stroq(['card', '--help']);
    expect(code).toBe(0);
    expect(out).toMatch(/^stroq card\b/);
    expect(out).toContain('--days');
  });
});

describe('stroq show', () => {
  it('prints the evidence behind a moment of the last card', () => {
    stroq(['card']);
    const { code, out } = stroq(['show', '1']);
    expect(code).toBe(0);
    expect(out).toContain('Moment 1 of the last card');
    expect(out).toContain('What your agent read');
    expect(out).toContain('What it did next');
    expect(out).toContain('stroq replay --transcript');
    expect(out).not.toContain(AWS_KEY);
  });

  it('shows every moment the card listed', () => {
    stroq(['card']);
    for (const n of ['2', '3']) expect(stroq(['show', n]).code, n).toBe(0);
  });

  it('says to run the card first when there is none', () => {
    const { code, out } = stroq(['show', '1']);
    expect(code).toBe(1);
    expect(out).toContain('npx @stroq/cli');
  });

  it('refuses what is no moment number', () => {
    for (const bad of [[], ['0'], ['x'], ['1', '2']])
      expect(stroq(['show', ...bad]).code, bad.join(' ')).toBe(2);
  });
});
