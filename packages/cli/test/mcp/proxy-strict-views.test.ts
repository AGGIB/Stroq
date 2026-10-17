import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startRig, type Rig } from './strict-rig.js';

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

/** The provenance records the run wrote for results of `tool`: what a later command is checked against. */
function recordsOf(rig: Rig, tool: string): { hash: string; suspect: boolean }[] {
  const dir = join(rig.home, 'sessions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.prov.json'))
    .flatMap(
      (name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>[],
    )
    .filter((record) => String(record['tool']).endsWith(`__${tool}`))
    .map((record) => ({ hash: String(record['hash']), suspect: record['suspect'] === true }));
}

/** The audit lines of the scan of results of `tool`. */
const postLinesOf = (rig: Rig, tool: string) =>
  rig
    .audit()
    .filter((entry) => entry['phase'] === 'post' && String(entry['tool']).endsWith(`__${tool}`));

async function runTool(tool: string, strict: boolean) {
  const rig = startRig(strict ? { strict: true } : {});
  await rig.handshake();
  rig.call(3, tool);
  await rig.answerFor(3);
  const records = recordsOf(rig, tool);
  const lines = postLinesOf(rig, tool);
  await rig.finish();
  return { records, lines };
}

describe('what is remembered of a result and what is audited', () => {
  it('is remembered once, as in the default proxy: the same records for the same result', async () => {
    const plain = await runTool('urls', false);
    const strict = await runTool('urls', true);
    expect(plain.records.length).toBeGreaterThan(100);
    expect(strict.records).toHaveLength(plain.records.length);
    expect(new Set(strict.records.map((r) => r.hash))).toEqual(
      new Set(plain.records.map((r) => r.hash)),
    );
  });

  it('is audited with one line when every view is clean', async () => {
    const { lines } = await runTool('benign', true);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['summary']).toBe('{"method":"tools/call"}');
  });

  it('has a line for each view that matched, besides the one every result has', async () => {
    const { lines } = await runTool('urlspoison', true);
    const verdicts = lines.map((line) => (line['scan'] as { verdict: string }).verdict);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(verdicts.filter((verdict) => verdict === 'suspect').length).toBeGreaterThanOrEqual(1);
    // A line for a view that was clean is not written: every extra line is a match.
    const tagged = lines.filter((line) => String(line['summary']).includes('"view"'));
    for (const line of tagged)
      expect((line['scan'] as { verdict: string }).verdict).toBe('suspect');
  });

  it('is remembered as suspect when a view matched, whatever view that was', async () => {
    const { records } = await runTool('urlspoison', true);
    expect(records.length).toBeGreaterThan(100);
    expect(records.every((record) => record.suspect)).toBe(true);
  });
});
