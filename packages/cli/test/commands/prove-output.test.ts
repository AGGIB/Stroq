import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readHostResult } from '../../src/live/store.js';
import { type HostDriver, type HostRun } from '../../src/live/types.js';
import { HONEST_LIVE, json, prove, RAW_CONTROL, stroqHome } from './prove-world.js';

/**
 * `stroq prove`, the command, after it has worked: what it keeps for `stroq doctor`, and what it prints.
 */

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
