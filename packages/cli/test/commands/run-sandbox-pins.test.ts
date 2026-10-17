import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { passportsFileIn } from '../../src/paths.js';
import { sandboxRun, useWorlds, world } from '../helpers/run-world.js';

/**
 * A pinned MCP server runs from a private copy under `<stroq home>/run`, and the sandbox denies writes there, so
 * it cannot start inside `stroq run --sandbox`. That is said at launch, in its own words, when the lock holds one.
 */
useWorlds();

const digest = 'a'.repeat(64);
const pinned = (status = 'confirmed') => ({
  kind: 'mcp',
  status,
  digest,
  grant: { pin: `sha256:${digest}` },
});

describe('what stroq run --sandbox says about pinned MCP servers', () => {
  it('names them, and that they cannot start inside the sandbox, when the lock holds some', async () => {
    const w = world();
    writeFileSync(
      passportsFileIn(w.home),
      JSON.stringify({
        v: 1,
        skills: {},
        mcp: { alpha: pinned(), beta: pinned(), gone: pinned('revoked') },
      }),
    );

    const text = await sandboxRun(w, { plat: 'linux' });
    const line = text.split('\n').find((l) => /pinned MCP server/.test(l)) ?? '';

    expect(line).toContain('2 pinned MCP servers');
    expect(line).toContain('"alpha"');
    expect(line).toContain('"beta"');
    expect(line).not.toContain('gone');
    expect(line).toContain(`${w.home}/run`);
    expect(line).toMatch(/cannot start inside `stroq run --sandbox`/);
    expect(line).toMatch(/not measured with a real srt/);
    expect(line).toMatch(/without --sandbox/);
  });

  it('says it in the singular for one', async () => {
    const w = world();
    writeFileSync(
      passportsFileIn(w.home),
      JSON.stringify({ v: 1, skills: {}, mcp: { alpha: pinned() } }),
    );

    const text = await sandboxRun(w, { plat: 'linux' });

    expect(text).toContain('1 pinned MCP server (');
  });

  it('says nothing when the lock holds none, or cannot be read', async () => {
    const w = world();
    expect(await sandboxRun(w, { plat: 'linux' })).not.toMatch(/pinned MCP server/);
    writeFileSync(passportsFileIn(w.home), '{ not json');
    expect(await sandboxRun(w, { plat: 'linux' })).not.toMatch(/pinned MCP server/);
  });

  it('writes a name from the lock out, never raw', async () => {
    const w = world();
    writeFileSync(
      passportsFileIn(w.home),
      JSON.stringify({ v: 1, skills: {}, mcp: { 'a\u001b[31m‮b': pinned() } }),
    );

    const text = await sandboxRun(w, { plat: 'linux' });

    expect(text).not.toMatch(/[\u001b‮]/u);
    expect(text).toMatch(/pinned MCP server/);
  });

  it('says it in the dry run, which is where a person reads it first', async () => {
    const w = world();
    writeFileSync(
      passportsFileIn(w.home),
      JSON.stringify({ v: 1, skills: {}, mcp: { alpha: pinned() } }),
    );

    const text = await sandboxRun(w, { plat: 'linux' });

    expect(text).toMatch(/pinned MCP server/);
    expect(text).toContain('would run');
  });
});
