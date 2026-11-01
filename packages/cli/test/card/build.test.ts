import { mkdirSync, readFileSync, readdirSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCard, defaultWorkers, sessionFolders, type BuildEnv } from '../../src/card/build.js';
import type { CardData } from '../../src/card/data.js';
import { handleJob, type CardJob, type CardResult } from '../../src/card/jobs.js';
import type { Channel } from '../../src/card/pool.js';
import { renderCard } from '../../src/card/render.js';
import { inProcessChannel } from '../../src/card/worker.js';
import { cardDirIn } from '../../src/paths.js';
import {
  ago,
  AWS_KEY,
  bash,
  claudeSession,
  DAY,
  furnish,
  machine,
  populate,
  PROJECT_KEY,
  type Machine,
} from './machine.js';

/**
 * The whole card on a throwaway machine: real sessions on disk, the real key check, the real folder
 * check and the real replay. The AWS key is sent to a `.invalid` host by one session; a project key is
 * only read by another; a README of a dependency tells a third to run a download. Every value is made up.
 */

let m: Machine;
beforeEach(() => {
  m = machine();
  furnish(m);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const env = (over: Partial<BuildEnv> = {}): BuildEnv => ({
  home: m.home,
  env: process.env,
  stroqHome: m.stroqHome,
  cwd: m.work,
  now: new Date(),
  version: '0.29.0',
  workers: 2,
  open: inProcessChannel,
  ...over,
});

/** The parts of a card that do not depend on how long the run took. */
const stable = (data: CardData) => ({
  ...data,
  generated: undefined,
  timing: undefined,
  coverage: { ...data.coverage, fromCache: 0 },
});

describe('the card on a machine with sessions', () => {
  it('counts the commands, what a text told the agent to run, the keys and the folders', async () => {
    populate(m);
    const data = await buildCard(30, env());
    expect(data.schema).toBe('stroq-card/1');
    expect(data.counts).toEqual({
      commands: 5,
      toldByText: 1,
      keysSent: 1,
      keysStopped: 0,
      keysSeen: 1,
      autorunRepos: 1,
    });
    expect(data.coverage).toMatchObject({
      found: 4,
      agents: { claudeCode: 3, codex: 1 },
      checked: 4,
      notChecked: 0,
      tooLarge: 0,
      unreadable: 0,
      older: 1,
      keys: 'checked',
    });
    expect(data.moments.map((x) => x.kind)).toEqual([
      'told-by-text',
      'key-sent',
      'key-seen',
      'autorun-repo',
    ]);
  });

  it('prints the card and keeps no key value anywhere: not in the JSON, not on disk', async () => {
    populate(m);
    const data = await buildCard(30, env());
    const printed = renderCard(data, m.home).join('\n');
    expect(printed).toMatch(/aws_secret_access_key/i);
    expect(printed).toContain('Worth a look');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true }))
        e.isDirectory() ? walk(join(dir, e.name)) : files.push(join(dir, e.name));
    };
    walk(cardDirIn(m.stroqHome));
    const everything = [
      JSON.stringify(data),
      printed,
      ...files.map((f) => readFileSync(f, 'utf8')),
    ].join('\n');
    expect(everything).not.toContain(AWS_KEY);
    expect(everything).not.toContain(PROJECT_KEY);
    expect(files.length).toBeGreaterThan(0);
  });

  it('is near-instant the second time: every summary comes from the cache', async () => {
    populate(m);
    const first = await buildCard(30, env());
    expect(first.timing.replayed).toBe(4);
    const second = await buildCard(30, env());
    expect(second.timing.replayed).toBe(0);
    expect(second.coverage.fromCache).toBe(4);
    expect(stable(second)).toEqual(stable(first));
  });

  it('checks a session again when its file changed', async () => {
    populate(m);
    await buildCard(30, env());
    claudeSession(m, { id: 'seen', at: ago(3 * DAY), calls: [bash('ls'), bash('pwd')] });
    const again = await buildCard(30, env());
    expect(again.timing.replayed).toBe(1);
  });

  it('gives the same card with one worker and with many', async () => {
    populate(m);
    const one = await buildCard(30, env({ workers: 1 }));
    // A new cache for the second run, so that both replay everything.
    writeFileSync(join(cardDirIn(m.stroqHome), 'sessions.json'), '{}');
    const many = await buildCard(30, env({ workers: 5 }));
    expect(stable(many)).toEqual(stable(one));
  });

  it('looks only at the days asked for', async () => {
    populate(m);
    const week = await buildCard(7, env());
    expect(week.coverage.found).toBe(4);
    const wide = await buildCard(365, env());
    expect(wide.coverage.found).toBe(5);
    expect(wide.counts.commands).toBe(week.counts.commands + 1);
  });

  it('counts a session past the size limit and does not read it', async () => {
    populate(m);
    const big = claudeSession(m, { id: 'huge', at: ago(DAY), calls: [bash('echo big')] });
    truncateSync(big, 65 * 1024 * 1024);
    const data = await buildCard(30, env());
    expect(data.coverage.tooLarge).toBe(1);
    expect(data.counts.commands).toBe(5);
  });
});

describe('the card when the time runs out', () => {
  /** A worker that takes the first `n` transcripts and never finishes the rest. */
  function stalling(n: number): () => Channel<CardJob, CardResult> {
    let taken = 0;
    return () => {
      const real = inProcessChannel();
      return {
        ...real,
        send: (id, job) => {
          if (job.kind === 'session' && (taken += 1) > n) return;
          real.send(id, job);
        },
      };
    };
  }

  it('says how many sessions were checked and counts only those', async () => {
    populate(m);
    const data = await buildCard(
      30,
      env({ budgetMs: 100, graceMs: 100, workers: 1, open: stalling(2) }),
    );
    expect(data.coverage.found).toBe(4);
    expect(data.coverage.checked).toBe(2);
    expect(data.coverage.notChecked).toBe(2);
    expect(renderCard(data, m.home).join(' ')).toContain('Checked 2 of 4 sessions, newest first');
  });

  it('continues from the cache on the next run', async () => {
    populate(m);
    await buildCard(30, env({ budgetMs: 100, graceMs: 100, workers: 1, open: stalling(2) }));
    const next = await buildCard(30, env());
    expect(next.coverage.notChecked).toBe(0);
    expect(next.coverage.fromCache).toBe(2);
    expect(next.timing.replayed).toBe(2);
  });
});

describe('the card when there is nothing to read', () => {
  it('finds no sessions and says where it looked', async () => {
    const data = await buildCard(30, env());
    expect(data.coverage.found).toBe(0);
    expect(data.coverage.keys).toBe('no-sessions');
    expect(data.moments).toEqual([]);
    expect(data.coverage.looked).toEqual([
      join(m.home, '.claude', 'projects'),
      join(m.home, '.codex', 'sessions'),
    ]);
  });

  it('honours CLAUDE_CONFIG_DIR when it says where it looked', async () => {
    const data = await buildCard(30, env({ env: { CLAUDE_CONFIG_DIR: join(m.root, 'cfg') } }));
    expect(data.coverage.looked[0]).toBe(join(m.root, 'cfg', 'projects'));
  });
});

describe('helpers', () => {
  it('uses min(6, cpus - 1) workers and at least one', () => {
    expect(defaultWorkers(1)).toBe(1);
    expect(defaultWorkers(2)).toBe(1);
    expect(defaultWorkers(4)).toBe(3);
    expect(defaultWorkers(8)).toBe(6);
    expect(defaultWorkers(64)).toBe(6);
  });

  it('looks at each existing session folder once, newest first, and never at home', () => {
    mkdirSync(join(m.root, 'a'));
    mkdirSync(join(m.root, 'b'));
    const session = (cwd: string | null) =>
      ({ cwd, mtimeMs: 0, agent: 'claude-code', path: '', bytes: 0, ref: {} }) as never;
    const { dirs, total } = sessionFolders(
      [
        session(join(m.root, 'a')),
        session(join(m.root, 'a')),
        session(m.home),
        session(join(m.root, 'gone')),
        session(null),
        session(join(m.root, 'b')),
      ],
      m.home,
    );
    expect(dirs).toEqual([join(m.root, 'a'), join(m.root, 'b')]);
    expect(total).toBe(2);
  });

  it('runs a job the same in this process as handleJob does', async () => {
    const repos: CardJob = { kind: 'repos', dirs: [m.work], stopAt: Date.now() + 10_000 };
    const result = await handleJob(repos);
    expect(result.kind).toBe('repos');
  });
});
