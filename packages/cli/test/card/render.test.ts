import { describe, expect, it } from 'vitest';
import { renderCard, shareLine, WIDTH } from '../../src/card/render.js';
import { card, moment } from './fixtures.js';

const HOME = '/Users/dev';
const text = (lines: readonly string[]): string => lines.join('\n');

/** What the card must never say: rule ids, scores, and the guard's own words. */
const FORBIDDEN = [
  /\bSTROQ-\d/,
  /\bATR-\d/,
  /\b0\.\d\d\b/,
  /\btaint/i,
  /\bprovenance\b/i,
  /\bsuspect\b/i,
  /encoded exec/i,
  /\bdefault\b/i,
  /carried over/i,
  /\borigin\b/i,
];

describe('the card: something was found', () => {
  const found = card({
    counts: {
      commands: 31_785,
      toldByText: 3,
      keysSent: 1,
      keysStopped: 2,
      keysSeen: 1,
      autorunRepos: 2,
    },
    moments: [
      moment(1, {
        kind: 'told-by-text',
        line: 'A web page told your agent to download and run a script. It did. Whoever wrote that text can steer your agent.',
      }),
      moment(2, {
        kind: 'key-sent',
        line: 'Your agent sent STRIPE_SECRET_KEY to hooks.example.invalid. Treat that key as leaked.',
      }),
      moment(3),
      moment(4, { line: 'A fourth moment that the card does not show.' }),
    ],
  });

  it('prints the golden text', () => {
    expect(text(renderCard(found, HOME))).toBe(
      [
        'Hoo checked 30 days of your agent sessions',
        '1,756 sessions · Claude Code and Codex · this machine',
        '',
        '  31,785  commands your agent ran',
        '       3  came from text it read: a README, page, issue',
        '          or tool result',
        '       1  key sent to another company (2 more were',
        '          stopped before they left)',
        '       2  repos run code as soon as an agent opens them',
        '',
        'Worth a look',
        '1  A web page told your agent to download and run a',
        '   script. It did. Whoever wrote that text can steer',
        '   your agent.',
        '   stroq show 1',
        '2  Your agent sent STRIPE_SECRET_KEY to',
        '   hooks.example.invalid. Treat that key as leaked.',
        '   stroq show 2',
        '3  Your agent read .env in ~/shop; the AI saw',
        '   AWS_SECRET_ACCESS_KEY.',
        '   stroq show 3',
        '',
        'Stop this next time:  npx @stroq/cli init',
      ].join('\n'),
    );
  });

  it('shows the top three moments and no more', () => {
    expect(text(renderCard(found, HOME))).not.toContain('fourth moment');
  });

  it('keeps every line within the width the owl leaves', () => {
    for (const line of renderCard(found, HOME))
      expect([...line].length, line).toBeLessThanOrEqual(WIDTH);
  });

  it("names no rule, no score and none of the guard's own words", () => {
    for (const pattern of FORBIDDEN)
      expect(text(renderCard(found, HOME)), String(pattern)).not.toMatch(pattern);
  });

  it('says one key and one repo in the singular', () => {
    const one = card({
      counts: {
        commands: 1,
        toldByText: 0,
        keysSent: 1,
        keysStopped: 0,
        keysSeen: 0,
        autorunRepos: 1,
      },
      moments: [moment(1)],
    });
    const out = text(renderCard(one, HOME));
    expect(out).toContain('1  command your agent ran');
    expect(out).toContain('1  key sent to another company');
    expect(out).toContain('1  repo runs code as soon as an agent opens it');
  });
});

describe('the card: nothing was found', () => {
  it('says so plainly and points to the attack demo', () => {
    expect(text(renderCard(card(), HOME))).toBe(
      [
        'Hoo checked 30 days of your agent sessions',
        '1,756 sessions · Claude Code and Codex · this machine',
        '',
        '  31,785  commands your agent ran',
        '       0  came from text it read: a README, page, issue',
        '          or tool result',
        '       0  keys sent to another company',
        '       0  repos run code as soon as an agent opens them',
        '',
        'Nothing worth a look in these sessions.',
        'See what Stroq stops:  npx @stroq/cli attack',
      ].join('\n'),
    );
  });
});

describe('the card: no sessions at all', () => {
  it('says which agents and folders it looked in, in two lines', () => {
    const none = card({
      counts: {
        commands: 0,
        toldByText: 0,
        keysSent: 0,
        keysStopped: 0,
        keysSeen: 0,
        autorunRepos: 0,
      },
      coverage: { ...card().coverage, found: 0, checked: 0, agents: { claudeCode: 0, codex: 0 } },
    });
    expect(text(renderCard(none, HOME))).toBe(
      [
        'Hoo found no agent sessions in the last 30 days.',
        'Looked for Claude Code in ~/.claude/projects and Codex',
        'in ~/.codex/sessions.',
        '',
        'See what Stroq stops:  npx @stroq/cli attack',
      ].join('\n'),
    );
  });
});

describe('the card: the time ran out', () => {
  it('says how many sessions were checked and that a second run checks the rest', () => {
    const cut = card({
      coverage: { ...card().coverage, checked: 812, notChecked: 944 },
    });
    const out = text(renderCard(cut, HOME));
    expect(out.replace(/\s+/g, ' ')).toContain(
      'Checked 812 of 1,756 sessions, newest first; run again to check the rest.',
    );
    expect(out).toContain('Nothing worth a look in the sessions checked so far.');
    for (const line of renderCard(cut, HOME))
      expect([...line].length, line).toBeLessThanOrEqual(WIDTH);
  });

  it('says how many sessions the key check covered, in plain words, and that a second run does the rest', () => {
    const cut = card({
      coverage: {
        ...card().coverage,
        keys: 'not-finished',
        found: 1_999,
        keysChecked: 812,
        keysNotChecked: 1_179,
      },
    });
    const lines = renderCard(cut, HOME);
    expect(text(lines).replace(/\s+/g, ' ')).toContain(
      'Keys checked in 812 of 1,999 sessions; run again to check the rest.',
    );
    for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(WIDTH);
  });

  it('says how many sessions the key check could not finish', () => {
    const odd = card({ coverage: { ...card().coverage, keysIncomplete: 3 } });
    expect(text(renderCard(odd, HOME)).replace(/\s+/g, ' ')).toContain(
      '3 sessions could not be checked for keys in full.',
    );
  });

  it('says what could not be read, what was too large, and a key check that did not finish', () => {
    const odd = card({
      coverage: {
        ...card().coverage,
        tooLarge: 2,
        unreadable: 1,
        keys: 'not-finished',
        keysChecked: 1_000,
        keysNotChecked: 756,
        folders: { found: 200, checked: 150, capped: true },
      },
    });
    const out = text(renderCard(odd, HOME));
    expect(out).toContain('2 sessions were too large to check.');
    expect(out).toContain('1 session could not be read.');
    expect(out.replace(/\s+/g, ' ')).toContain(
      'Keys checked in 1,000 of 1,756 sessions; run again to check the rest.',
    );
    expect(out.replace(/\s+/g, ' ')).toContain(
      'Looked at 150 of 200 folders for code that runs on open.',
    );
  });

  it('says a single agent by its name', () => {
    const only = card({
      coverage: { ...card().coverage, agents: { claudeCode: 0, codex: 5 }, found: 5 },
    });
    expect(renderCard(only, HOME)[1]).toBe('5 sessions · Codex · this machine');
  });
});

describe('the share line', () => {
  it('is one line of counts that ends with the command and has no path, name or host', () => {
    const line = shareLine(
      card({
        counts: {
          commands: 31_785,
          toldByText: 3,
          keysSent: 1,
          keysStopped: 0,
          keysSeen: 4,
          autorunRepos: 2,
        },
        moments: [
          moment(1, { line: 'Your agent sent STRIPE_SECRET_KEY to hooks.example.invalid.' }),
        ],
      }),
    );
    expect(line).toBe(
      'Hoo checked 30 days of my agent sessions: 31,785 commands, 3 came from text the agent read, ' +
        '1 key sent to another company, 2 repos run code as soon as an agent opens them. npx @stroq/cli',
    );
    expect(line).not.toContain('\n');
    expect(line).not.toMatch(/STRIPE|invalid|\/Users|~/);
  });
});
