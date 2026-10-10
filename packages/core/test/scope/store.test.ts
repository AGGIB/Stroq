import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FilePermitStore, MAX_PERMIT_FILE_BYTES } from '../../src/scope/store.js';
import { tempDir } from './helpers.js';

const posixOnly = process.platform === 'win32';
const FP = 'ab'.repeat(32);
const modeOf = (path: string): number => statSync(path).mode & 0o777;

function fresh() {
  const root = tempDir('store');
  const home = join(root, 'home');
  mkdirSync(home);
  return { root, home, store: new FilePermitStore({ home }), task: join(home, 'tasks', 't1') };
}

describe('FilePermitStore.readPermit', () => {
  it('says absent when there is no tasks directory, and when the task has no permit file', () => {
    const { store, home } = fresh();
    expect(store.readPermit('t1')).toEqual({ kind: 'absent' });
    mkdirSync(join(home, 'tasks', 't1'), { recursive: true });
    expect(store.readPermit('t1')).toEqual({ kind: 'absent' });
  });

  it('returns the text of the permit exactly as it was written', () => {
    const { store } = fresh();
    store.writePermit('t1', '{"body":"é"}');
    expect(store.readPermit('t1')).toEqual({ kind: 'present', text: '{"body":"é"}' });
  });

  it('is void as soon as a revoked marker exists, whatever the permit says', () => {
    const { store } = fresh();
    store.writePermit('t1', '{}');
    store.revoke('t1');
    expect(store.readPermit('t1')).toEqual({ kind: 'void', reason: 'revoked' });
  });

  it('is void when the task ended, and a revoke outranks the end', () => {
    const { store } = fresh();
    store.writePermit('t1', '{}');
    store.end('t1');
    expect(store.readPermit('t1')).toEqual({ kind: 'void', reason: 'ended' });
    store.revoke('t1');
    expect(store.readPermit('t1')).toEqual({ kind: 'void', reason: 'revoked' });
  });

  it('is void on a marker even when there is no permit file: deleting the permit does not undo it', () => {
    const { store, task } = fresh();
    mkdirSync(task, { recursive: true });
    writeFileSync(join(task, 'ended'), '');
    expect(store.readPermit('t1')).toEqual({ kind: 'void', reason: 'ended' });
  });

  it('counts a marker that is a directory or a link as a marker, for existence is all it says', () => {
    const { store, task } = fresh();
    store.writePermit('t1', '{}');
    mkdirSync(join(task, 'revoked'));
    expect(store.readPermit('t1')).toEqual({ kind: 'void', reason: 'revoked' });
  });

  it('accepts a permit file of exactly 64 KiB and refuses one a byte longer, without reading it', () => {
    const { store, task } = fresh();
    expect(MAX_PERMIT_FILE_BYTES).toBe(64 * 1024);
    store.writePermit('t1', 'x'.repeat(MAX_PERMIT_FILE_BYTES));
    expect(store.readPermit('t1').kind).toBe('present');
    writeFileSync(join(task, 'permit.json'), 'x'.repeat(MAX_PERMIT_FILE_BYTES + 1));
    expect(store.readPermit('t1')).toEqual({ kind: 'void', reason: 'oversize' });
  });

  it('is void for a permit that is a directory', () => {
    const { store, task } = fresh();
    mkdirSync(join(task, 'permit.json'), { recursive: true });
    expect(store.readPermit('t1')).toEqual({ kind: 'void', reason: 'not-regular' });
  });

  it.skipIf(posixOnly)('is void for a permit that is a symlink, even to a good file', () => {
    const { store, root, task } = fresh();
    writeFileSync(join(root, 'real.json'), '{}');
    mkdirSync(task, { recursive: true });
    symlinkSync(join(root, 'real.json'), join(task, 'permit.json'));
    expect(store.readPermit('t1')).toEqual({ kind: 'void', reason: 'not-regular' });
  });

  it.skipIf(posixOnly)('is void for a permit that is a dangling symlink', () => {
    const { store, root, task } = fresh();
    mkdirSync(task, { recursive: true });
    symlinkSync(join(root, 'nothing.json'), join(task, 'permit.json'));
    expect(store.readPermit('t1').kind).toBe('void');
  });

  it.skipIf(posixOnly)('is void when the task directory is a symlink to somewhere else', () => {
    const { store, root, home } = fresh();
    mkdirSync(join(root, 'elsewhere'));
    writeFileSync(join(root, 'elsewhere', 'permit.json'), '{}');
    mkdirSync(join(home, 'tasks'));
    symlinkSync(join(root, 'elsewhere'), join(home, 'tasks', 't1'));
    expect(store.readPermit('t1')).toEqual({ kind: 'void', reason: 'task-dir' });
  });

  it.skipIf(posixOnly)('is void for a permit file that cannot be read, and does not throw', () => {
    if (process.getuid?.() === 0) return;
    const { store, task } = fresh();
    store.writePermit('t1', '{}');
    chmodSync(join(task, 'permit.json'), 0o000);
    expect(store.readPermit('t1')).toEqual({ kind: 'void', reason: 'unreadable' });
    chmodSync(join(task, 'permit.json'), 0o600);
  });

  // Opening a FIFO for reading waits for a writer. The store opens without waiting and refuses
  // the handle, but a hook that blocked is a hook the host times out and lets the call through,
  // so this runs in a child with a kill timer: a regression fails the test and hangs nothing.
  it.skipIf(posixOnly)(
    'is void for a FIFO, without waiting for a writer (in a child)',
    () => {
      const { home, task } = fresh();
      mkdirSync(task, { recursive: true });
      execFileSync('mkfifo', [join(task, 'permit.json')]);
      const repo = fileURLToPath(new URL('../../../..', import.meta.url));
      const storeUrl = new URL('../../src/scope/store.ts', import.meta.url).href;
      const code = `const m = await import(${JSON.stringify(storeUrl)});
      const s = new m.FilePermitStore({ home: ${JSON.stringify(home)} });
      console.log(JSON.stringify(s.readPermit('t1')));`;
      const out = execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', code],
        { cwd: repo, encoding: 'utf8', timeout: 20_000 },
      );
      expect(JSON.parse(out.trim().split('\n').pop() as string)).toEqual({
        kind: 'void',
        reason: 'not-regular',
      });
    },
    30_000,
  );
});

describe('task ids and paths', () => {
  const BAD = [
    '',
    '.',
    '..',
    '../outside',
    '../../etc',
    'a/b',
    'a\\b',
    '/abs',
    'A',
    'a b',
    '-a',
    'a\0b',
    'a'.repeat(65),
    'é',
    'a/../b',
    'outside/..',
  ];

  it.each(BAD)('refuses the task id %j without looking at the file system', (id) => {
    const { store, root } = fresh();
    mkdirSync(join(root, 'outside'), { recursive: true });
    writeFileSync(join(root, 'outside', 'permit.json'), '{"decoy":true}');
    writeFileSync(join(root, 'permit.json'), '{"decoy":true}');
    expect(store.readPermit(id)).toEqual({ kind: 'void', reason: 'bad-task-id' });
    expect(store.readEscalation(id, FP)).toEqual({ kind: 'void', reason: 'bad-task-id' });
    expect(() => store.writePermit(id, '{}')).toThrow(/task id/);
    expect(() => store.revoke(id)).toThrow(/task id/);
    expect(existsSync(join(root, 'outside', 'ended'))).toBe(false);
  });

  it('refuses a task id that is not a string', () => {
    const { store } = fresh();
    for (const id of [undefined, null, 7, {}, ['t1']]) {
      expect(store.readPermit(id as never)).toEqual({ kind: 'void', reason: 'bad-task-id' });
    }
  });

  it('puts everything for a task under tasks/<id> in the home it was given', () => {
    const { store, home } = fresh();
    store.writePermit('t1', '{}');
    store.writeEscalation('t1', FP, '{}');
    store.end('t1');
    expect(existsSync(join(home, 'tasks', 't1', 'permit.json'))).toBe(true);
    expect(existsSync(join(home, 'tasks', 't1', 'extensions', `${FP}.json`))).toBe(true);
    expect(existsSync(join(home, 'tasks', 't1', 'ended'))).toBe(true);
  });
});

describe('FilePermitStore writers', () => {
  it.skipIf(posixOnly)('keeps task directories 0700 and files 0600', () => {
    const { store, task } = fresh();
    store.writePermit('t1', '{}');
    store.writeEscalation('t1', FP, '{}');
    expect(modeOf(task)).toBe(0o700);
    expect(modeOf(join(task, 'extensions'))).toBe(0o700);
    expect(modeOf(join(task, 'permit.json'))).toBe(0o600);
    expect(modeOf(join(task, 'extensions', `${FP}.json`))).toBe(0o600);
  });

  it('never replaces a permit that exists', () => {
    const { store } = fresh();
    store.writePermit('t1', '{"first":1}');
    expect(() => store.writePermit('t1', '{"second":2}')).toThrow(/exists/);
    expect(store.readPermit('t1')).toEqual({ kind: 'present', text: '{"first":1}' });
  });
});

describe('FilePermitStore escalations', () => {
  it('reads an escalation by its fingerprint and says absent when there is none', () => {
    const { store } = fresh();
    expect(store.readEscalation('t1', FP)).toEqual({ kind: 'absent' });
    store.writeEscalation('t1', FP, '{"e":1}');
    expect(store.readEscalation('t1', FP)).toEqual({ kind: 'present', text: '{"e":1}' });
    expect(store.readEscalation('t1', 'cd'.repeat(32))).toEqual({ kind: 'absent' });
  });

  it.each(['', 'ab', 'AB'.repeat(32), 'zz'.repeat(32), '../x', `${FP}/..`, `${'ab'.repeat(32)}0`])(
    'refuses the fingerprint %j',
    (fingerprint) => {
      const { store } = fresh();
      expect(store.readEscalation('t1', fingerprint)).toEqual({
        kind: 'void',
        reason: 'bad-fingerprint',
      });
      expect(store.consumeEscalation('t1', fingerprint, '{}')).toBe(false);
      expect(() => store.writeEscalation('t1', fingerprint, '{}')).toThrow(/fingerprint/);
    },
  );

  it('lets an escalation be used once: the second use is refused', () => {
    const { store } = fresh();
    store.writeEscalation('t1', FP, '{"e":1}');
    expect(store.consumeEscalation('t1', FP, '{"e":1}')).toBe(true);
    expect(store.consumeEscalation('t1', FP, '{"e":1}')).toBe(false);
    expect(store.readEscalation('t1', FP)).toEqual({ kind: 'void', reason: 'used' });
  });

  it('lets a new escalation for the same operation be used, as the old one is not the new one', () => {
    const { store } = fresh();
    store.writeEscalation('t1', FP, '{"e":1}');
    store.consumeEscalation('t1', FP, '{"e":1}');
    store.writeEscalation('t1', FP, '{"e":2}');
    expect(store.readEscalation('t1', FP)).toEqual({ kind: 'present', text: '{"e":2}' });
    expect(store.consumeEscalation('t1', FP, '{"e":2}')).toBe(true);
  });

  it('refuses an escalation file over its size cap and one that is a directory', () => {
    const { store, task } = fresh();
    store.writeEscalation('t1', FP, 'x'.repeat(20_000));
    expect(store.readEscalation('t1', FP)).toEqual({ kind: 'void', reason: 'oversize' });
    const other = 'cd'.repeat(32);
    mkdirSync(join(task, 'extensions', `${other}.json`));
    expect(store.readEscalation('t1', other)).toEqual({ kind: 'void', reason: 'not-regular' });
  });

  it.skipIf(posixOnly)('refuses an escalation that is a symlink', () => {
    const { store, root, task } = fresh();
    store.writeEscalation('t1', 'cd'.repeat(32), '{}');
    writeFileSync(join(root, 'real.json'), '{}');
    symlinkSync(join(root, 'real.json'), join(task, 'extensions', `${FP}.json`));
    expect(store.readEscalation('t1', FP)).toEqual({ kind: 'void', reason: 'not-regular' });
  });

  it('does not use an escalation of a task that was revoked or ended', () => {
    const { store } = fresh();
    store.writeEscalation('t1', FP, '{"e":1}');
    store.revoke('t1');
    expect(store.readEscalation('t1', FP)).toEqual({ kind: 'void', reason: 'revoked' });
  });
});
