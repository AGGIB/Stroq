import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatSent } from '../../src/sent/format.js';
import { loadKeys } from '../../src/sent/keys.js';
import { buildReport, type KeysCompared } from '../../src/sent/report.js';
import { buildCounts } from '../../src/sent/counts.js';

/**
 * Values in key files that look like examples or placeholders are not traced, and the report says how many
 * there are in words: they are never dropped in silence. Real-shaped values beside them are traced. All
 * values are made up; the folders are removed after each test.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stroq-placeholders-'));
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'proj'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const REAL = 'sk_live_' + '9fK3mQ7xT2vB8nL4cH6wR1yZ';
const REAL_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ.k3J9xQ2mV8nL4cH6wR1yZ5tB7dF0gS';
const EXAMPLE_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

function load(env: Record<string, string> = {}) {
  return loadKeys({ home: join(root, 'home'), env, projectDirs: [join(root, 'proj')] });
}

describe('a key file with real and placeholder values', () => {
  beforeEach(() => {
    writeFileSync(
      join(root, 'proj', '.env'),
      [
        `STRIPE_SECRET_KEY=${REAL}`,
        `SUPABASE_SERVICE_KEY=${REAL_JWT}`,
        `JWT_SECRET=${EXAMPLE_JWT_SECRET}`,
        'WA_WORKER_TOKEN=worker-token-dev-only-secret',
        'API_TOKEN=replace-with-your-api-token',
        'HUNTER_PASSWORD=hunter2hunter2',
      ].join('\n'),
    );
  });

  it('traces the real ones and a weak password, and not the examples', () => {
    const set = load();
    expect(set.keys.map((k) => k.name).sort()).toEqual([
      'HUNTER_PASSWORD',
      'STRIPE_SECRET_KEY',
      'SUPABASE_SERVICE_KEY',
    ]);
  });

  it('counts the values that were not traced', () => {
    expect(load().placeholders).toBe(3);
  });

  it('counts a value once though many files hold it', () => {
    writeFileSync(join(root, 'proj', '.env.local'), `JWT_SECRET=${EXAMPLE_JWT_SECRET}\n`);
    writeFileSync(join(root, 'proj', '.env.test'), `OTHER_SECRET=${EXAMPLE_JWT_SECRET}\n`);
    expect(load().placeholders).toBe(3);
  });

  it('counts a placeholder in the environment too', () => {
    const set = load({ SOME_API_TOKEN: 'replace-with-your-api-key' });
    expect(set.placeholders).toBe(4);
    expect(set.keys.some((k) => k.source === 'env')).toBe(false);
  });

  it('traces a decoy, whatever it looks like', () => {
    const canary = 'stroq_canary_FAKEcanary0123456789abcdefABCDEF';
    writeFileSync(join(root, 'proj', '.env.canary'), `DECOY_TOKEN=${canary}\n`);
    expect(load().keys.some((k) => k.value === canary)).toBe(true);
  });
});

describe('what the report says', () => {
  const keys = (placeholders?: number): KeysCompared => ({
    compared: 3,
    files: ['/proj/.env'],
    env: 0,
    unreadable: 0,
    ...(placeholders === undefined ? {} : { placeholders }),
  });
  const report = (placeholders?: number) =>
    buildReport({
      scope: 'machine',
      now: new Date('2026-10-19T00:00:00Z'),
      sessions: { total: 1, agents: {}, first: null, last: null },
      keys: keys(placeholders),
      findings: [],
      notChecked: [],
      unreadable: 0,
      savedOutputsSkipped: 0,
    });

  it('lists the count under "not checked", in plain words, and the report is not complete', () => {
    const r = report(3);
    expect(r.notChecked).toContain('placeholder-values');
    expect(r.complete).toBe(false);
    const text = formatSent(r, '/home/u');
    expect(text).toContain(
      '3 values in your key files look like examples or placeholders, so they are not traced',
    );
  });

  it('says it for one value in the singular', () => {
    expect(formatSent(report(1), '/home/u')).toContain(
      '1 value in your key files looks like an example or a placeholder, so it is not traced',
    );
  });

  it('says nothing when there are none', () => {
    const r = report(undefined);
    expect(r.notChecked).not.toContain('placeholder-values');
    expect(formatSent(r, '/home/u')).not.toContain('placeholder');
  });

  it('is in the JSON as a count, and its label in the counts', () => {
    const r = report(3);
    expect(r.keys.placeholders).toBe(3);
    expect(buildCounts(r, '0.30.0').not_checked).toContain('placeholder-values');
  });

  it('does not say there was nothing to look for when every value was an example', () => {
    const r = buildReport({
      scope: 'machine',
      now: new Date('2026-10-19T00:00:00Z'),
      sessions: { total: 1, agents: {}, first: null, last: null },
      keys: { compared: 0, files: [], env: 0, unreadable: 0, placeholders: 2 },
      findings: [],
      notChecked: [],
      unreadable: 0,
      savedOutputsSkipped: 0,
    });
    const text = formatSent(r, '/home/u');
    expect(text).not.toContain('No keys found on this machine');
    expect(text).toContain('look like examples or placeholders');
  });
});
