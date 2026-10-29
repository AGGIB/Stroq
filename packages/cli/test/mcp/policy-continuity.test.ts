import {
  appendFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY, parsePolicy } from '@stroq/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureMcpPolicy } from '../../src/mcp/policy-continuity.js';
import { MAX_POLICY_BYTES } from '../../src/policy/load.js';

const race = vi.hoisted(() => ({
  path: '',
  fd: -1,
  done: false,
  denied: false,
  afterRead: undefined as (() => void) | undefined,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    openSync: ((...args: unknown[]) => {
      if (String(args[0]) === race.path && race.denied)
        throw Object.assign(new Error('private untrusted filesystem detail'), { code: 'EACCES' });
      const fd = (fs.openSync as (...items: unknown[]) => number)(...args);
      if (String(args[0]) === race.path) race.fd = fd;
      return fd;
    }) as typeof fs.openSync,
    readSync: ((...args: unknown[]) => {
      const count = (fs.readSync as (...items: unknown[]) => number)(...args);
      if (args[0] === race.fd && !race.done) {
        race.done = true;
        race.afterRead?.();
      }
      return count;
    }) as typeof fs.readSync,
  };
});
const directories: string[] = [];
afterEach(() => {
  race.path = '';
  race.fd = -1;
  race.done = false;
  race.denied = false;
  race.afterRead = undefined;
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(text?: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-mcp-policy-')));
  directories.push(home);
  const path = join(home, 'policy.yaml');
  if (text !== undefined) writeFileSync(path, text);
  return { home, path, write: (next: string) => writeFileSync(path, next) };
}
const simple = 'version: 1\nrules: []\n';
const rule = (id: string, effect = 'deny') => ({
  id,
  effect,
  reason: 'operator reason',
  when: { classes: ['mcp.side_effect'], taint: 'any' },
});
const assertUnavailable = (capture: () => unknown) => {
  try {
    capture();
    throw new Error('expected refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('MCP policy is unavailable');
    expect((error as Error).cause).toBeUndefined();
  }
};

describe('MCP policy continuity', () => {
  it('uses the built-in policy for true absence without creating anything', () => {
    const f = fixture(),
      captured = captureMcpPolicy(f.home);
    expect(captured.policy).toEqual(DEFAULT_POLICY);
    expect(captured.continuity.check()).toBe('current');
    expect(readdirSync(f.home)).toEqual([]);
    f.write(JSON.stringify(DEFAULT_POLICY));
    expect(captured.continuity.check()).toBe('current');
    rmSync(f.path);
    expect(captured.continuity.check()).toBe('current');
  });

  it('supports a missing home and binds to the explicitly captured home', () => {
    const f = fixture(),
      other = fixture(simple),
      absent = join(f.home, 'missing');
    expect(captureMcpPolicy(absent).policy).toEqual(DEFAULT_POLICY);
    expect(readdirSync(f.home)).toEqual([]);
    const captured = captureMcpPolicy(other.home);
    vi.stubEnv('STROQ_HOME', f.home);
    other.write('version: 1\ndefault: deny\nrules: []\n');
    expect(captured.continuity.check()).toBe('changed');
  });

  it('captures the same parsed semantics as the engine and ignores comments, key order and unknown fields', () => {
    const text =
      'version: 1\nextra: ignored\nrules:\n  - id: one\n    effect: deny\n    reason: operator reason\n    when:\n      classes: [mcp.side_effect]\n';
    const f = fixture(text),
      captured = captureMcpPolicy(f.home);
    expect(captured.policy).toEqual(parsePolicy(text));
    f.write(
      '# formatting only\nrules:\n  - when: {taint: any, classes: [mcp.side_effect], extra: ignored}\n    reason: operator reason\n    effect: deny\n    id: one\ndefault: allow\nthreshold: 0.6\nversion: 1\n',
    );
    expect(captured.continuity.check()).toBe('current');
  });

  it.each([
    'default',
    'threshold',
    'rule effect',
    'rule order',
    'rule reason',
    'rule taint',
    'rule classes',
  ])('latches a semantic %s change even after the original bytes return', (change) => {
    const original = {
      version: 1,
      threshold: 0.6,
      default: 'allow',
      rules: [rule('one'), rule('two', 'ask')],
    };
    const f = fixture(JSON.stringify(original)),
      captured = captureMcpPolicy(f.home);
    const changed = structuredClone(original);
    if (change === 'default') changed.default = 'deny';
    if (change === 'threshold') changed.threshold = 0.8;
    if (change === 'rule effect') changed.rules[0]!.effect = 'allow';
    if (change === 'rule order') changed.rules.reverse();
    if (change === 'rule reason') changed.rules[0]!.reason = 'new operator reason';
    if (change === 'rule taint') changed.rules[0]!.when.taint = 'suspect';
    if (change === 'rule classes') changed.rules[0]!.when.classes = ['secret.egress'];
    f.write(JSON.stringify(changed));
    expect(captured.continuity.check()).toBe('changed');
    f.write(JSON.stringify(original));
    expect(captured.continuity.check()).toBe('changed');
    expect(captureMcpPolicy(f.home).continuity.check()).toBe('current');
  });

  it('detects custom-policy deletion as a semantic change', () => {
    const f = fixture(simple),
      captured = captureMcpPolicy(f.home);
    rmSync(f.path);
    expect(captured.continuity.check()).toBe('changed');
  });

  it.each([
    '',
    'version: [PRIVATE-POLICY-SECRET',
    'version: 9\nrules: []',
    'version: 1\nversion: 1\nrules: []',
    'version: 1\nrules: []\n---\nversion: 1\nrules: []',
  ])('refuses invalid startup input with only a fixed error', (text) => {
    const f = fixture(text);
    assertUnavailable(() => captureMcpPolicy(f.home));
  });

  it('latches unavailable when the policy becomes malformed and a repaired file needs a fresh capture', () => {
    const f = fixture(simple),
      captured = captureMcpPolicy(f.home);
    f.write('version: [PRIVATE-POLICY-SECRET');
    expect(captured.continuity.check()).toBe('unavailable');
    f.write(simple);
    expect(captured.continuity.check()).toBe('unavailable');
    expect(captureMcpPolicy(f.home).continuity.check()).toBe('current');
  });

  it('accepts exactly the bounded size and refuses an oversized policy', () => {
    const f = fixture(`${simple}#${'x'.repeat(MAX_POLICY_BYTES - Buffer.byteLength(simple) - 1)}`);
    const captured = captureMcpPolicy(f.home);
    expect(captured.continuity.check()).toBe('current');
    appendFileSync(f.path, 'x');
    expect(captured.continuity.check()).toBe('unavailable');
    assertUnavailable(() => captureMcpPolicy(f.home));
  });

  it('never treats a file in a parent position or a directory policy as a missing override', () => {
    const f = fixture(simple);
    assertUnavailable(() => captureMcpPolicy(f.path));
    rmSync(f.path);
    mkdirSync(f.path);
    assertUnavailable(() => captureMcpPolicy(f.home));
  });

  it('returns only a fixed refusal when opening a readable-looking path is denied', () => {
    const f = fixture(simple),
      captured = captureMcpPolicy(f.home);
    race.path = f.path;
    race.denied = true;
    expect(captured.continuity.check()).toBe('unavailable');
    assertUnavailable(() => captureMcpPolicy(f.home));
  });

  it('refuses invalid UTF-8 even when the invalid bytes occur only in a YAML comment', () => {
    const f = fixture(simple),
      captured = captureMcpPolicy(f.home);
    writeFileSync(f.path, Buffer.concat([Buffer.from(`${simple}#`), Buffer.from([0xff])]));
    expect(captured.continuity.check()).toBe('unavailable');
    assertUnavailable(() => captureMcpPolicy(f.home));
  });
});

describe.skipIf(process.platform === 'win32')('bounded POSIX source checks', () => {
  it('keeps stable regular-file symlinks compatible and refuses dangling links', () => {
    const f = fixture(simple),
      target = join(f.home, 'operator-policy.yaml');
    renameSync(f.path, target);
    symlinkSync(target, f.path);
    const captured = captureMcpPolicy(f.home);
    expect(captured.policy).toEqual(parsePolicy(simple));
    expect(captured.continuity.check()).toBe('current');
    writeFileSync(target, 'version: 1\ndefault: deny\nrules: []');
    expect(captured.continuity.check()).toBe('changed');
    rmSync(target);
    assertUnavailable(() => captureMcpPolicy(f.home));
  });

  it('does not treat a dangling home symlink as a default-policy home', () => {
    const f = fixture(),
      linked = join(f.home, 'linked');
    symlinkSync(join(f.home, 'missing-target'), linked);
    assertUnavailable(() => captureMcpPolicy(linked));
  });

  it('refuses a FIFO without waiting for a writer', () => {
    const f = fixture();
    execFileSync('mkfifo', [f.path]);
    assertUnavailable(() => captureMcpPolicy(f.home));
  });

  it('refuses a multiply linked policy instead of loading an ambiguous writable alias', () => {
    const f = fixture(simple),
      captured = captureMcpPolicy(f.home);
    linkSync(f.path, join(f.home, 'second-policy.yaml'));
    expect(captured.continuity.check()).toBe('unavailable');
    assertUnavailable(() => captureMcpPolicy(f.home));
  });

  it('refuses a linked source that is redirected during its descriptor read', () => {
    const f = fixture(simple),
      target = join(f.home, 'operator-policy.yaml');
    renameSync(f.path, target);
    symlinkSync(target, f.path);
    race.path = target;
    race.afterRead = () => {
      writeFileSync(join(f.home, 'other-policy.yaml'), simple);
      rmSync(f.path);
      symlinkSync(join(f.home, 'other-policy.yaml'), f.path);
    };
    assertUnavailable(() => captureMcpPolicy(f.home));
  });

  it.each(['grows', 'shrinks', 'replacement'] as const)(
    'refuses a policy that %s during its only descriptor read',
    (change) => {
      const f = fixture(simple);
      race.path = f.path;
      race.afterRead = () => {
        if (change === 'grows') appendFileSync(f.path, '# extra');
        if (change === 'shrinks') truncateSync(f.path, 1);
        if (change === 'replacement') {
          writeFileSync(`${f.path}.next`, simple);
          renameSync(`${f.path}.next`, f.path);
        }
      };
      assertUnavailable(() => captureMcpPolicy(f.home));
    },
  );
});
