import { describe, expect, it } from 'vitest';
import type { ThreatFeed, ThreatMatch } from './threat-feed';
import {
  comparedSentence,
  patchLabel,
  setThreatFeed,
  threatFeedOn,
  unavailableSentence,
  whySentence,
} from './threat-words';

const match = (
  why: ThreatMatch['why'],
  live = true,
  over: Partial<ThreatMatch> = {},
): ThreatMatch => ({
  slug: 'a',
  title: 'A',
  category: 'supply-chain',
  severity: 'critical',
  live,
  patch: 'partial',
  startedAt: '2026-10-20',
  why,
  ...over,
});

const NOW = new Date(2026, 9, 28, 16, 0);
const feed = (over: Partial<ThreatFeed> = {}): ThreatFeed => ({
  schema: 'stroq-threat-feed/1',
  source: 'pwn.watch',
  generatedAt: '2026-10-28T10:00:00.000Z',
  state: 'ready',
  problem: null,
  fetchedAt: new Date(2026, 9, 28, 15, 5).toISOString(),
  compared: {
    incidents: 790,
    packages: 34,
    ecosystems: ['npm', 'github-actions'],
    agents: ['claude-code'],
    unread: [],
    skipped: 0,
  },
  matches: [],
  more: 0,
  ...over,
});

describe('the threat feed in words', () => {
  it('says what pwn.watch names that you have and what to check, never that you are affected', () => {
    const sentences = [
      whySentence(match({ kind: 'package', name: 'keyv', ecosystem: 'npm' })),
      whySentence(match({ kind: 'package', name: 'litellm', ecosystem: 'pypi' })),
      whySentence(match({ kind: 'agent', agent: 'cursor' })),
      whySentence(match({ kind: 'ecosystem', ecosystem: 'github-actions' })),
      whySentence(match({ kind: 'ecosystem', ecosystem: 'npm' }, false)),
    ];
    expect(sentences).toEqual([
      'Names keyv, which this project lists in package.json. Check the version you have against pwn.watch.',
      'Names litellm, which this project lists in its Python requirements. Check the version you have against pwn.watch.',
      'About Cursor, which is set up on this machine. Check the version you have against pwn.watch.',
      'A supply-chain attack pwn.watch still follows, filed under GitHub Actions, which this project uses. Check whether a package it names is one of yours.',
      'A supply-chain attack updated in the last two weeks, filed under npm, which this project uses. Check whether a package it names is one of yours.',
    ]);
    for (const sentence of sentences) expect(sentence).not.toMatch(/affected|protect|safe|secure/i);
  });

  it('says what pwn.watch says about a fix', () => {
    const why = { kind: 'agent', agent: 'cursor' } as const;
    expect(patchLabel(match(why, true, { patch: 'patched' }))).toBe('Fixed version out');
    expect(patchLabel(match(why, true, { patch: 'unpatched' }))).toBe('No fix yet');
    expect(patchLabel(match(why, true, { patch: 'unknown' }))).toBeNull();
  });

  it('says what was compared, that nothing was sent, and how old the list is', () => {
    expect(comparedSentence(feed(), NOW)).toBe(
      'Compared 790 incidents here with what this project uses (34 packages, npm, GitHub Actions) and the agents set up on this machine (Claude Code). Nothing about the project was sent. The list as of 15:05.',
    );
    expect(
      comparedSentence(
        feed({
          compared: {
            incidents: 5,
            packages: 0,
            ecosystems: [],
            agents: [],
            unread: [],
            skipped: 0,
          },
        }),
        NOW,
      ),
    ).toBe('Compared 5 incidents here. Nothing about the project was sent. The list as of 15:05.');
    expect(
      comparedSentence(
        feed({ problem: 'timeout', fetchedAt: new Date(2026, 9, 27, 15, 5).toISOString() }),
        NOW,
      ),
    ).toContain(
      'The latest download failed (pwn.watch took too long to answer); this is the list as of 27 Oct, 15:05.',
    );
    expect(
      comparedSentence(
        feed({ compared: { ...feed().compared, unread: ['package.json', 'pyproject.toml'] } }),
        NOW,
      ),
    ).toContain('Not compared: package.json and pyproject.toml, which could not be read.');
    expect(comparedSentence(feed({ compared: { ...feed().compared, skipped: 3 } }), NOW)).toContain(
      '3 of the list’s incidents could not be read, so they were not compared.',
    );
  });

  it('says why there is no list', () => {
    expect(unavailableSentence('network')).toBe(
      'Could not get pwn.watch’s list: pwn.watch could not be reached.',
    );
    expect(unavailableSentence(null)).toContain('could not be reached');
  });

  it('is off where nothing can be kept', () => {
    // No browser storage here: the feed reads as off and turning it on reports that it did not keep.
    expect(threatFeedOn()).toBe(false);
    expect(setThreatFeed(true)).toBe(false);
  });
});
