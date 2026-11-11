import { describe, expect, it } from 'vitest';
import { card, moment } from '../../packages/cli/test/card/fixtures';
import { presentCard } from '../scripts/card-view-engine';
import { validateCardState } from './card';

const HOME = '/Users/dev';

// Each moment of a card carries the digest its false-alarm mark is kept under. The page takes a moment
// with exactly the fields it shows, so the engine has to leave the digest behind.
describe('a card whose moments carry false-alarm keys', () => {
  it('reaches the page, with the note of what was left out', () => {
    const moments = [1, 2].map((n) => ({ ...moment(n), key: String(n).repeat(64) }));
    const data = card({
      moments,
      counts: { ...card().counts, keysSeen: 2 },
      coverage: { ...card().coverage, falseAlarms: { leftOut: 1, unreadable: false } },
    });
    const result = presentCard(JSON.parse(JSON.stringify(data)), HOME);
    expect(result).not.toBeNull();
    expect(result?.moments.some((m) => 'key' in m)).toBe(false);
    const state = {
      schema: 'stroq-card-state/1',
      engine: { available: true, version: '0.31.1' },
      status: 'done',
      startedAt: '2026-11-10T08:59:00.000Z',
      finishedAt: '2026-11-10T09:00:00.000Z',
      error: null,
      result: JSON.parse(JSON.stringify(result)),
    };
    expect(validateCardState(state)).toBe(true);
    expect(result?.view.kind === 'card' && result.view.notes).toContain(
      '1 moment you marked as a false alarm is not listed: stroq show --false-alarms.',
    );
  });
});
