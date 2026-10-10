import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFs } from '../../src/harden/atomic.js';
import { undoFile } from '../../src/harden/index.js';
import { readManifest } from '../../src/harden/manifest.js';
import type { Fs } from '../../src/harden/types.js';
import { addDeny, applied, engine, jsonText, owner, undo } from './engine-setup.js';
import { removeTempDirs } from './helpers.js';

afterEach(removeTempDirs);

/**
 * Undo reads a file, works out what to write, and writes it, and in between the owner (or an
 * editor) can save the file. These tests make that happen at each point there is: after the read,
 * while a rename is refused for a moment and waited for, and between the look at a file and its
 * removal. In each the owner's save is the file at the end, and the record is kept.
 */

describe('undoFile: the file changes after undo has read it', () => {
  it('does not replace it, leaves the owner’s edit and keeps the record', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [
      addDeny('a'),
    ]);
    owner(path, (doc) => ({ ...doc, theirs: 1 }));
    const theirs = jsonText({ model: 'later' });
    let done = false;
    const fs: Fs = {
      ...nodeFs,
      open: (file, flags, mode) => {
        if (!done && basename(file).startsWith('.settings.json.stroq-')) {
          done = true;
          writeFileSync(path, theirs);
        }
        return nodeFs.open(file, flags, mode);
      },
    };

    await expect(undoFile({ ...e.env, fs }, real, { root: e.project })).rejects.toMatchObject({
      code: 'stale-plan',
    });

    expect(readFileSync(path, 'utf8')).toBe(theirs);
    expect(readManifest(e.env).files[real]).toHaveLength(1);
    expect(readdirSync(e.project).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('undoFile: the file changes while a busy rename is waited for', () => {
  it('does not replace it after the wait, leaves the owner’s save and keeps the record', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [
      addDeny('a'),
    ]);
    owner(path, (doc) => ({ ...doc, theirs: 1 }));
    const saved = jsonText({ model: 'saved while it waited' });
    let busy = true;
    const fs: Fs = {
      ...nodeFs,
      rename: (from, to) => {
        if (!busy || !to.endsWith('settings.json')) return nodeFs.rename(from, to);
        busy = false;
        writeFileSync(path, saved);
        return Promise.reject(Object.assign(new Error('simulated busy file'), { code: 'EBUSY' }));
      },
    };

    await expect(undoFile({ ...e.env, fs }, real, { root: e.project })).rejects.toMatchObject({
      code: 'stale-plan',
    });

    expect(readFileSync(path, 'utf8')).toBe(saved);
    expect(readManifest(e.env).files[real]).toHaveLength(1);
    expect(readdirSync(e.project).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('undoFile: the file changes just before it is removed', () => {
  it('does not remove a file Stroq made once the owner has written to it', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'new.json', null, [addDeny('a')]);
    const theirs = jsonText({ model: 'the owner wrote this after Stroq made the file' });
    let done = false;
    // `removeFile` looks at the file before it removes it; the owner writes right after that look.
    const fs: Fs = {
      ...nodeFs,
      stat: async (file) => {
        const found = await nodeFs.stat(file);
        if (!done && file === real) {
          done = true;
          writeFileSync(path, theirs);
        }
        return found;
      },
    };

    await expect(undoFile({ ...e.env, fs }, real, { root: e.project })).rejects.toMatchObject({
      code: 'stale-plan',
    });

    expect(readFileSync(path, 'utf8')).toBe(theirs);
    expect(readManifest(e.env).files[real]).toHaveLength(1);
  });

  it('still removes it when nothing changed', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'new.json', null, [addDeny('a')]);

    const result = await undo(e, real);

    expect(result.status).toBe('restored');
    expect(existsSync(path)).toBe(false);
  });
});
