import { describe, expect, it } from 'vitest';
import { startRig } from './strict-rig.js';

/**
 * End to end: a sentence that is spread over several content blocks is the same sentence
 * to the model, in the default proxy and in `--strict`. The default reader puts the blocks
 * on consecutive lines of one text; strict mode scans that same text as one of its views.
 */

async function run(tool: string, strict: boolean) {
  const rig = startRig(strict ? { strict: true } : {});
  await rig.handshake();
  rig.call(3, tool);
  const answer = await rig.answerFor(3);
  const delivered = JSON.stringify(answer);
  const tainted = rig.tainted();
  const postVerdicts = rig
    .audit()
    .filter((entry) => entry['phase'] === 'post')
    .map((entry) => (entry['scan'] as { verdict?: string } | undefined)?.verdict);
  await rig.finish();
  return { delivered, tainted, postVerdicts };
}

describe('one sentence over four content blocks', () => {
  it('is suspect in the default proxy: the session is tainted and the result carries the warning', async () => {
    const { delivered, tainted } = await run('blocks', false);
    expect(tainted).toBe(true);
    expect(delivered).toContain('Stroq');
  });

  it('is suspect in --strict too, as the default has it', async () => {
    const { delivered, tainted, postVerdicts } = await run('blocks', true);
    expect(tainted).toBe(true);
    expect(delivered).toContain('Stroq');
    expect(postVerdicts).toContain('suspect');
  });

  it('is delivered whole, the four blocks and then the one warning', async () => {
    const { delivered } = await run('blocks', true);
    for (const word of ['Disregard', 'all', 'previous', 'instructions'])
      expect(delivered).toContain(`"text":"${word}"`);
    expect(delivered.split('contains instruction-like text')).toHaveLength(2);
  });

  it('leaves a clean result clean in every view', async () => {
    const { tainted, postVerdicts } = await run('benign', true);
    expect(tainted).toBe(false);
    expect(postVerdicts.every((verdict) => verdict === 'clean')).toBe(true);
  });
});
