import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type HostDriver } from '../../src/live/types.js';
import { fakeTerminal } from '../helpers/fake-terminal.js';
import {
  HONEST_LIVE,
  json,
  leftBehind,
  prove,
  RAW_CONTROL,
  RUNS_HERE,
  stroqHome,
} from './prove-world.js';

/**
 * `stroq prove`, the command, before it spends anything: the command lines it refuses, the hosts it cannot
 * check, what it asks, and what it exits with.
 */

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

  it.skipIf(!RUNS_HERE)(
    'says the host is not there, makes no request, writes nothing and exits 3',
    async () => {
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
    },
  );
});

describe.skipIf(!RUNS_HERE)('what it asks before it spends anything', () => {
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

describe.skipIf(!RUNS_HERE)('what it exits with', () => {
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
