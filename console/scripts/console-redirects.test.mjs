import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MOVED_ADDRESSES, SCREENS, redirectFor } from './console-redirects.mjs';

const SHA = 'b'.repeat(64);
const SESSION = 'session-0123456789abcdef';
const pathOf = (location) => location.split(/[?#]/)[0];

test('every older address leads to one of the five screens', () => {
  for (const address of MOVED_ADDRESSES) {
    const to = redirectFor(address);
    assert.notEqual(to, null, address);
    assert.ok(SCREENS.includes(pathOf(to)), `${address} -> ${to}`);
  }
});

test('the five screens do not move, and an unknown address is left alone', () => {
  for (const screen of SCREENS) assert.equal(redirectFor(screen), null, screen);
  assert.equal(redirectFor('/policies/checks/'), null);
  assert.equal(redirectFor('/_next/static/chunk.js'), null);
  assert.equal(redirectFor('/activity/other/'), null);
  assert.equal(redirectFor(undefined), null);
});

test('an address with no closing slash is treated as the one with it', () => {
  assert.equal(redirectFor('/keys'), '/#keys');
  assert.equal(redirectFor('/skills/mcp'), '/skills/');
});

test('Activity and Sessions keep a session, a decision filter and words', () => {
  assert.equal(
    redirectFor('/activity/', `decision=block&session=${SESSION}&q=curl&agent=Cursor&days=7`),
    `/live/?show=denied&session=${SESSION}&q=curl`,
  );
  assert.equal(redirectFor('/activity/', 'decision=ask'), '/live/?show=asked');
  assert.equal(redirectFor('/activity/', 'decision=flag'), '/live/?show=flagged');
  assert.equal(redirectFor('/activity/', 'decision=allow'), '/live/');
  assert.equal(redirectFor('/sessions/', `session=${SESSION}`), `/live/?session=${SESSION}`);
});

test('nothing a person typed is carried unless it is a value the page reads', () => {
  assert.equal(
    redirectFor('/activity/', 'session=../../etc/passwd&q=' + 'x'.repeat(201)),
    '/live/',
  );
  assert.equal(redirectFor('/activity/', 'decision=__proto__'), '/live/');
  assert.equal(redirectFor('/activity/event/', 'id=audit-1;evil'), '/live/');
});

test('an event, or an investigation of one, opens that event on Live', () => {
  assert.equal(
    redirectFor('/activity/event/', `id=audit-9&evidence=${SHA}`),
    `/live/?event=${SHA}`,
  );
  assert.equal(redirectFor('/activity/event/', 'id=audit-9'), '/live/?event=9');
  assert.equal(redirectFor('/incidents/', `id=incident-${SHA}&status=all`), `/live/?event=${SHA}`);
  assert.equal(redirectFor('/incidents/', 'status=reviewed'), '/live/');
});

test('the rules reference and the history keep the one thing they were asked about', () => {
  const entry = '11111111-2222-4333-8444-555555555555';
  assert.equal(
    redirectFor('/policies/history/', `entry=${entry}`),
    `/policies/?entry=${entry}#history`,
  );
  assert.equal(redirectFor('/policies/history/', 'entry=../../x'), '/policies/#history');
  assert.equal(redirectFor('/policies/history/'), '/policies/#history');
  assert.equal(redirectFor('/policies/reference/', 'find=x'), '/policies/#reference');
  assert.equal(redirectFor('/try/'), '/policies/#try');
});

test('the console menu lists the screens the redirects lead to', async () => {
  const map = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), '../lib/platform-map.ts'),
    'utf8',
  );
  const listed = [...map.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(listed, [...SCREENS]);
});
