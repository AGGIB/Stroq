import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isFailing,
  tagChanges,
  type FailOn,
  type TaggedHit,
} from '../../src/exposure/agent-change.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { agentSurface } from '../../src/exposure/agent-tree.js';
import { commitFiles, scratchRepo } from '../helpers/scratch-repo.js';

/**
 * Every decision reads a value as the repository holds it, and only the outputs read it scrubbed.
 * So one config, written once with values the scrubbing leaves alone and once with values it
 * changes, gives the same findings with the same severities, and passes or fails the same. The
 * marker is built while the test runs, so no secret-shaped text sits in the source.
 */

const SECRET = ['FAKE', 'SECRET', 'zz', String(9999 * 7)].join('_');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const json = (value: object): string => JSON.stringify(value, null, 2);

/** A server name and an env value: plain, or in shapes the scrubbing rewrites. */
interface Words {
  readonly server: string;
  readonly token: string;
}
const PLAIN: Words = { server: 'local', token: 'plain-value' };
const SCRUBBED: Words = { server: `Bearer ${SECRET}`, token: `https://u:${SECRET}@h.invalid/?k=1` };

/** An approval list naming a server of `.mcp.json`, and an env value that looks like a secret. */
const config = (w: Words): Record<string, string> => ({
  '.mcp.json': json({ mcpServers: { [w.server]: { command: 'node', args: ['s.js'] } } }),
  '.claude/settings.json': json({
    enabledMcpjsonServers: [w.server],
    env: { DEBUG: w.token },
  }),
});

/** What decides the outcome, without the names and values the two configs differ in. */
const outcome = (hits: readonly TaggedHit[], failOn: FailOn): string[] =>
  hits.map((h) => `${h.status} ${h.kind} ${h.file} ${h.severity} ${isFailing(h, failOn)}`).sort();

function onDisk(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-raw-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe('a value the outputs scrub', () => {
  it('starts an approved server as an error whatever its name looks like', () => {
    for (const w of [PLAIN, SCRUBBED]) {
      const server = agentSurface(onDisk(config(w))).hits.find((h) => h.kind === 'mcp-server');
      expect(server?.severity).toBe('error');
    }
  });

  it('decides a folder as it decides the same folder with plain values', () => {
    const decide = (w: Words): string[] =>
      outcome(tagChanges(agentSurface(onDisk(config(w))).hits, null), 'any');
    expect(decide(SCRUBBED)).toEqual(decide(PLAIN));
  });

  it('decides a change as it decides the same change with plain values', () => {
    const decide = (w: Words, before: Words): string[] => {
      const dir = scratchRepo(dirs);
      const base = commitFiles(dir, { ...config(before), 'README.md': 'x\n' });
      commitFiles(dir, config(w));
      return outcome(agentChanges(dir, base).hits, 'new');
    };
    // Unchanged: the same raw values on both sides, nothing new.
    expect(decide(SCRUBBED, SCRUBBED)).toEqual(decide(PLAIN, PLAIN));
    // Changed: only the env value moves, in both shapes.
    const other = (w: Words): Words => ({ ...w, token: `${w.token}2` });
    expect(decide(other(SCRUBBED), SCRUBBED)).toEqual(decide(other(PLAIN), PLAIN));
  });

  it('never shows the raw value of the scrubbed one', () => {
    const hits = agentSurface(onDisk(config(SCRUBBED))).hits;
    expect(hits.some((h) => h.value.includes(SECRET))).toBe(true);
    for (const h of hits) expect(h.shown).not.toContain(SECRET);
  });
});
