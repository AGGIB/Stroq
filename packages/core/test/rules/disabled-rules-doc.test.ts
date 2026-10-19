import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The guide says how many vendored rules are disabled and why. The reasons are in
// rules/atr-disabled.json, so the sentence is held to them: a rule that moves from one reason to
// another, or a rule added or removed, fails this until the guide says so.

const root = join(__dirname, '../../../..');
const disabled = JSON.parse(readFileSync(join(root, 'rules/atr-disabled.json'), 'utf8')) as Record<
  string,
  string
>;
const guide = readFileSync(join(root, 'docs/GUIDE.md'), 'utf8');

/** Why a rule is disabled, from the reason it was given. */
function kindOf(reason: string): 'speed' | 'gate' | 'benign' {
  if (/^slow on /.test(reason)) return 'speed';
  if (/^reads \w+ and /.test(reason)) return 'gate';
  return 'benign';
}

describe('the sentence in the guide about the disabled vendored rules', () => {
  const sentence =
    /currently lists (\d+): (\d+) for firing on benign text, (\d+) for speed, and (\d+) for the gate/.exec(
      guide,
    );

  it('is there', () => {
    expect(sentence).not.toBeNull();
  });

  it('counts the rules in rules/atr-disabled.json by the reason they were given', () => {
    const counts = { benign: 0, speed: 0, gate: 0 };
    for (const reason of Object.values(disabled)) counts[kindOf(reason)] += 1;
    expect(sentence?.slice(1).map(Number)).toEqual([
      Object.keys(disabled).length,
      counts.benign,
      counts.speed,
      counts.gate,
    ]);
  });

  it('reads every reason as one of the three', () => {
    for (const [id, reason] of Object.entries(disabled)) {
      if (kindOf(reason) === 'benign')
        expect(reason, `${id}: a benign-corpus reason names the fixture it fired on`).toMatch(
          /\.(?:md|txt|log|json|yaml|yml)$/,
        );
    }
  });
});
