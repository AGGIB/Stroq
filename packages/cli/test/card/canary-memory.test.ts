import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canaryNotes } from '../../src/card/canary-memory.js';

const SIG = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

function folder(): string {
  return mkdtempSync(join(tmpdir(), 'stroq-canary-memory-'));
}
const file = (dir: string, name: string, text = 'hello\n'): string => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

describe('what the card remembers of looking for canaries', () => {
  it('remembers a file it read through, and takes it for clean while it is the same file', () => {
    const dir = folder();
    const a = file(dir, 'a.jsonl');
    const notes = canaryNotes(null);
    const first = notes.memoryFor(SIG).look(a);
    expect(first.clean).toBe(false);
    first.learn();
    expect(notes.changed()).toBe(true);
    const next = canaryNotes(notes.result());
    expect(next.memoryFor(SIG).look(a).clean).toBe(true);
    expect(next.changed()).toBe(false);
  });

  it('reads a file again once it has grown or been touched', () => {
    const dir = folder();
    const a = file(dir, 'a.jsonl');
    const notes = canaryNotes(null);
    notes.memoryFor(SIG).look(a).learn();
    const kept = notes.result();
    appendFileSync(a, 'more\n');
    expect(canaryNotes(kept).memoryFor(SIG).look(a).clean).toBe(false);
    const b = file(dir, 'b.jsonl');
    const again = canaryNotes(null);
    again.memoryFor(SIG).look(b).learn();
    utimesSync(b, new Date(1_000), new Date(1_000));
    expect(canaryNotes(again.result()).memoryFor(SIG).look(b).clean).toBe(false);
  });

  it('remembers the file as it was when it was looked at, not as it was after the read', () => {
    const dir = folder();
    const a = file(dir, 'a.jsonl');
    const notes = canaryNotes(null);
    const looked = notes.memoryFor(SIG).look(a);
    // The session grows while the file is read.
    appendFileSync(a, 'a canary arrived\n');
    looked.learn();
    expect(canaryNotes(notes.result()).memoryFor(SIG).look(a).clean).toBe(false);
  });

  it('trusts nothing once other canaries are missing', () => {
    const dir = folder();
    const a = file(dir, 'a.jsonl');
    const notes = canaryNotes(null);
    notes.memoryFor(SIG).look(a).learn();
    expect(canaryNotes(notes.result()).memoryFor(OTHER).look(a).clean).toBe(false);
  });

  it('does not remember a link, a folder or a file that is gone', () => {
    const dir = folder();
    const a = file(dir, 'a.jsonl');
    const link = join(dir, 'link.jsonl');
    symlinkSync(a, link);
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    const notes = canaryNotes(null);
    const memory = notes.memoryFor(SIG);
    for (const path of [link, sub, join(dir, 'gone.jsonl')]) memory.look(path).learn();
    expect(notes.changed()).toBe(false);
    expect(notes.result()).toEqual({ signature: SIG, files: {} });
  });

  it('does not keep a path that spells a canary', () => {
    const dir = folder();
    const named = file(dir, 'Stroq_Canary_FAKEname.jsonl');
    const notes = canaryNotes(null);
    notes.memoryFor(SIG).look(named).learn();
    expect(JSON.stringify(notes.result())).not.toMatch(/canary_FAKE/i);
  });

  it('keeps what it had when no canary was missing this time', () => {
    const dir = folder();
    const a = file(dir, 'a.jsonl');
    const first = canaryNotes(null);
    first.memoryFor(SIG).look(a).learn();
    const kept = first.result();
    expect(canaryNotes(kept).result()).toEqual(kept);
    expect(canaryNotes(null).result()).toBeNull();
  });
});
