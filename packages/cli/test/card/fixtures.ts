import { CARD_SCHEMA, type CardData } from '../../src/card/data.js';
import type { Moment } from '../../src/card/schema.js';

/** A card as the build makes it, with the parts a test cares about replaced. */
export function card(over: Partial<CardData> = {}): CardData {
  return {
    schema: CARD_SCHEMA,
    version: '0.29.0',
    generated: '2026-11-02T10:00:00.000Z',
    days: 30,
    counts: {
      commands: 31_785,
      toldByText: 0,
      keysSent: 0,
      keysStopped: 0,
      keysSeen: 0,
      autorunRepos: 0,
    },
    moments: [],
    coverage: {
      found: 1_756,
      agents: { claudeCode: 1_700, codex: 56 },
      checked: 1_756,
      fromCache: 0,
      notChecked: 0,
      tooSlow: 0,
      placeholders: 0,
      tooLarge: 0,
      unreadable: 0,
      older: 12,
      keys: 'checked',
      keysChecked: 1_756,
      keysFromCache: 0,
      keysNotChecked: 0,
      keysIncomplete: 0,
      folders: { found: 40, checked: 40, capped: false },
      looked: ['/Users/dev/.claude/projects', '/Users/dev/.codex/sessions'],
      cacheSaved: true,
    },
    timing: { totalMs: 21_000, replayed: 1_756, workers: 6, replayMs: 20_000, keysMs: 12_000 },
    ...over,
  };
}

export const moment = (n: number, over: Partial<Moment> = {}): Moment => ({
  n,
  kind: 'key-seen',
  line: 'Your agent read .env in ~/shop; the AI saw AWS_SECRET_ACCESS_KEY.',
  groups: [{ title: 'What happened', rows: [['Key', 'AWS_SECRET_ACCESS_KEY']] }],
  next: [],
  ...over,
});
