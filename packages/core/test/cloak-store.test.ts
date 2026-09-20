import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOAK_TTL_MS, FileCloakStore, MAX_CLOAK_ENTRIES } from '../src/cloak/store.js';

function fixture(now: () => Date = () => new Date('2026-09-21T10:00:00.000Z')) {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-cloak-'));
  const file = join(dir, 'cloak', 'abc.json');
  return { dir, file, store: new FileCloakStore(file, now) };
}

describe('FileCloakStore', () => {
  it('mints one stable placeholder per distinct value and persists it at mode 0600', async () => {
    const { file, store } = fixture();
    const first = await store.assign(
      [
        { kind: 'email', value: 'a@b.example' },
        { kind: 'email', value: 'c@d.example' },
        { kind: 'email', value: 'a@b.example' },
      ],
      'a@b.example c@d.example',
    );
    expect(first.get('a@b.example')!.placeholder).toBe('[STROQ_EMAIL_1]');
    expect(first.get('c@d.example')!.placeholder).toBe('[STROQ_EMAIL_2]');
    expect(first.size).toBe(2);

    const again = await store.assign([{ kind: 'email', value: 'a@b.example' }], 'a@b.example');
    expect(again.get('a@b.example')!.placeholder).toBe('[STROQ_EMAIL_1]');

    // The dictionary holds the value in the clear — that is the point of it — so the
    // file permissions are part of the contract, not an incidental detail.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('a@b.example');
  });

  it('never mints a placeholder that already occurs in the text being cloaked', async () => {
    const { store } = fixture();
    const map = await store.assign(
      [{ kind: 'email', value: 'a@b.example' }],
      'the server said [STROQ_EMAIL_1] and also a@b.example',
    );
    expect(map.get('a@b.example')!.placeholder).not.toBe('[STROQ_EMAIL_1]');
  });

  it('restores a placeholder to its value and reports an unknown one as missing', async () => {
    const { store } = fixture();
    await store.assign([{ kind: 'email', value: 'a@b.example' }], 'a@b.example');
    const found = await store.lookup(['[STROQ_EMAIL_1]', '[STROQ_EMAIL_9]']);
    expect(found.get('[STROQ_EMAIL_1]')!.value).toBe('a@b.example');
    expect(found.has('[STROQ_EMAIL_9]')).toBe(false);
  });

  it('carries a secret entry with its label and marks it non-restorable', async () => {
    const { store } = fixture();
    const map = await store.assign(
      [
        {
          kind: 'secret',
          value: 'wJalrXUtnFEMI',
          label: 'AWS_SECRET_ACCESS_KEY (~/.aws/credentials)',
        },
      ],
      'wJalrXUtnFEMI',
    );
    const entry = map.get('wJalrXUtnFEMI')!;
    expect(entry.placeholder).toBe('[STROQ_SECRET_1]');
    expect(entry.label).toBe('AWS_SECRET_ACCESS_KEY (~/.aws/credentials)');
    const back = await store.lookup(['[STROQ_SECRET_1]']);
    expect(back.get('[STROQ_SECRET_1]')!.kind).toBe('secret');
  });

  it('forgets an entry that has been idle longer than the TTL', async () => {
    let clock = new Date('2026-09-21T10:00:00.000Z');
    const { file } = fixture();
    const store = new FileCloakStore(file, () => clock);
    await store.assign([{ kind: 'email', value: 'a@b.example' }], 'a@b.example');
    clock = new Date(clock.getTime() + CLOAK_TTL_MS + 1000);
    expect((await store.lookup(['[STROQ_EMAIL_1]'])).size).toBe(0);
  });

  it('keeps an entry alive while it is still being used', async () => {
    let clock = new Date('2026-09-21T10:00:00.000Z');
    const { file } = fixture();
    const store = new FileCloakStore(file, () => clock);
    await store.assign([{ kind: 'email', value: 'a@b.example' }], 'a@b.example');
    for (let i = 0; i < 3; i += 1) {
      clock = new Date(clock.getTime() + CLOAK_TTL_MS - 1000);
      expect((await store.lookup(['[STROQ_EMAIL_1]'])).size).toBe(1);
    }
  });

  it('never reuses a sequence number, even after the entry it belonged to expired', async () => {
    let clock = new Date('2026-09-21T10:00:00.000Z');
    const { file } = fixture();
    const store = new FileCloakStore(file, () => clock);
    await store.assign([{ kind: 'email', value: 'a@b.example' }], 'a@b.example');
    clock = new Date(clock.getTime() + CLOAK_TTL_MS + 1000);
    const map = await store.assign([{ kind: 'email', value: 'c@d.example' }], 'c@d.example');
    expect(map.get('c@d.example')!.placeholder).toBe('[STROQ_EMAIL_2]');
  });

  it('treats an unreadable dictionary as empty rather than throwing', async () => {
    const { file, store } = fixture();
    await store.assign([{ kind: 'email', value: 'a@b.example' }], 'a@b.example');
    writeFileSync(file, '{not json');
    // Self-healing in the direction that cannot leak: a lost dictionary means a
    // placeholder is forwarded literally, never that a value is restored wrongly.
    expect((await store.lookup(['[STROQ_EMAIL_1]'])).size).toBe(0);
    const map = await store.assign([{ kind: 'email', value: 'e@f.example' }], 'e@f.example');
    expect(map.get('e@f.example')!.placeholder).toBe('[STROQ_EMAIL_1]');
  });

  it('drops the least recently used entries once the cap is reached', async () => {
    const { store } = fixture();
    // One `assign`, not one per value: the cap is what is under test, and 2005
    // lock-and-write round trips would make this a benchmark of the file lock.
    const overflow = MAX_CLOAK_ENTRIES + 5;
    const requests = Array.from({ length: overflow }, (_, i) => ({
      kind: 'email' as const,
      value: `user${i}@b.example`,
    }));
    await store.assign(requests, '');

    // Same timestamp on all of them, so "least recently used" falls back to the
    // order they were added — the first five are the ones that go.
    expect((await store.lookup(['[STROQ_EMAIL_1]', '[STROQ_EMAIL_5]'])).size).toBe(0);
    expect((await store.lookup([`[STROQ_EMAIL_${overflow}]`])).size).toBe(1);
  });

  it('is inert with no requests and no placeholders, writing nothing', async () => {
    const { file, store } = fixture();
    expect((await store.assign([], 'text')).size).toBe(0);
    expect((await store.lookup([])).size).toBe(0);
    expect(() => statSync(file)).toThrow();
  });
});
