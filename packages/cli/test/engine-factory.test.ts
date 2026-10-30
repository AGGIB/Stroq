import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, StroqEngine } from '@stroq/core';
import { runHook } from '../src/commands/hook.js';
import {
  createEngine,
  createEngineAt,
  loadPolicy,
  loadPolicyWithSource,
  policySource,
} from '../src/engine-factory.js';
import { policyFile, stroqHome } from '../src/paths.js';
import { policySha256 } from '../src/policy/digest.js';

const unreadable: string[] = [];
beforeEach(() => {
  process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-engine-factory-'));
});
afterEach(() => {
  // Give a temporary file its mode back so the temporary directory can be cleaned.
  for (const path of unreadable.splice(0)) chmodSync(path, 0o600);
});

describe('loadPolicy', () => {
  it('returns DEFAULT_POLICY when no policy.yaml exists', () => {
    expect(loadPolicy()).toEqual(DEFAULT_POLICY);
  });

  it('returns the parsed policy when policy.yaml is present', () => {
    mkdirSync(stroqHome(), { recursive: true });
    writeFileSync(
      policyFile(),
      [
        'version: 1',
        'rules:',
        '  - id: deny-network',
        '    effect: deny',
        '    reason: test',
        '    when:',
        '      classes: [shell.network]',
        '      taint: any',
        '',
      ].join('\n'),
    );
    const policy = loadPolicy();
    expect(policy.rules[0]?.id).toBe('deny-network');
  });

  it('throws when policy.yaml is invalid', () => {
    mkdirSync(stroqHome(), { recursive: true });
    writeFileSync(policyFile(), ['version: 2', 'rules: []', ''].join('\n'));
    expect(() => loadPolicy()).toThrow();
  });
});

describe('createEngineAt / policySource', () => {
  it('builds an engine whose stores live under the given home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stroq-engine-at-'));
    const userHome = mkdtempSync(join(tmpdir(), 'stroq-user-'));
    const engine = createEngineAt({ home, userHome, policy: DEFAULT_POLICY, env: {} });
    expect(engine).toBeInstanceOf(StroqEngine);
    await engine.pre({ sessionId: 's', toolName: 'Bash', toolInput: { command: 'ls' }, cwd: home });
    expect(existsSync(join(home, 'audit.jsonl'))).toBe(true);
    expect(existsSync(join(stroqHome(), 'audit.jsonl'))).toBe(false);
  });

  it('names the policy source', () => {
    expect(policySource()).toBe('default');
    mkdirSync(stroqHome(), { recursive: true });
    writeFileSync(policyFile(), 'version: 1\nrules: []\n');
    expect(policySource()).toBe(policyFile());
  });
});

/** A Bash call the built-in policy allows; under a policy that cannot be read it must be denied. */
const benignBash = (cwd: string): string =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    session_id: 'policy-source-test',
    cwd,
  });
/** Claude Code reads an empty answer as an allow. */
const decisionOf = (stdout: string): unknown =>
  stdout.trim() === ''
    ? 'allow'
    : (JSON.parse(stdout) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput?.[
        'permissionDecision'
      ];

describe('loadPolicyWithSource: the policy and where it came from', () => {
  it('uses the built-in version 1 default when there is no policy file, and says so', () => {
    const loaded = loadPolicyWithSource();
    expect(loaded.policy).toBe(DEFAULT_POLICY);
    expect(loaded.policy.version).toBe(1);
    expect(loaded.source).toEqual({ kind: 'default', sha256: policySha256(DEFAULT_POLICY) });
    expect(loadPolicy()).toBe(DEFAULT_POLICY);
    expect(policySource()).toBe('default');
  });

  it('uses the default when the Stroq home itself does not exist yet, as the hook does', () => {
    process.env['STROQ_HOME'] = join(stroqHome(), 'not', 'created');
    expect(loadPolicyWithSource().source.kind).toBe('default');
  });

  it('names the file and the digest of what it says', () => {
    mkdirSync(stroqHome(), { recursive: true });
    writeFileSync(policyFile(), 'version: 1\nthreshold: 0.7\nrules: []\n');
    const loaded = loadPolicyWithSource();
    expect(loaded.policy.threshold).toBe(0.7);
    expect(loaded.source).toEqual({
      kind: 'file',
      path: policyFile(),
      sha256: policySha256(loaded.policy),
    });
  });

  it('reads a file at an explicit path, for a home other than the current one', () => {
    const other = mkdtempSync(join(tmpdir(), 'stroq-engine-factory-other-'));
    expect(loadPolicyWithSource(join(other, 'policy.yaml')).source.kind).toBe('default');
    writeFileSync(join(other, 'policy.yaml'), 'version: 1\nrules: []\n');
    expect(loadPolicyWithSource(join(other, 'policy.yaml')).source).toMatchObject({
      kind: 'file',
      path: join(other, 'policy.yaml'),
    });
  });

  const UNREADABLE: readonly (readonly [string, () => void])[] = [
    [
      'a link whose target is gone',
      () => {
        mkdirSync(stroqHome(), { recursive: true });
        symlinkSync(join(stroqHome(), 'gone.yaml'), policyFile());
      },
    ],
    ['a directory where the file should be', () => mkdirSync(policyFile(), { recursive: true })],
    [
      'a Stroq home that is a file',
      () => {
        const file = join(stroqHome(), 'home-file');
        mkdirSync(stroqHome(), { recursive: true });
        writeFileSync(file, '');
        process.env['STROQ_HOME'] = file;
      },
    ],
    // Root reads past the mode, and Windows has no mode that stops its owner reading.
    ...(process.getuid?.() === 0 || process.platform === 'win32'
      ? []
      : ([
          [
            'a file that cannot be opened',
            () => {
              mkdirSync(stroqHome(), { recursive: true });
              writeFileSync(policyFile(), 'version: 1\nrules: []\n');
              chmodSync(policyFile(), 0o000);
              unreadable.push(policyFile());
            },
          ],
        ] as const)),
  ];

  it.each(UNREADABLE)('refuses %s rather than falling back to the default', async (_, make) => {
    make();
    expect(() => loadPolicyWithSource()).toThrow(/cannot be read/);
    expect(() => loadPolicy()).toThrow(/cannot be read/);
    expect(() => policySource()).toThrow(/cannot be read/);
    expect(() => createEngine()).toThrow(/cannot be read/);
    // The hook builds its engine through the same factory, so it fails closed instead of allowing.
    const out = await runHook('claude-code', benignBash(tmpdir()));
    expect(decisionOf(out.stdout)).toBe('deny');
  });

  it('refuses a file that is not a policy, and the hook fails closed on it', async () => {
    mkdirSync(stroqHome(), { recursive: true });
    writeFileSync(policyFile(), 'version: 1\nrules: [\n');
    expect(() => loadPolicyWithSource()).toThrow();
    expect(() => createEngine()).toThrow();
    // The source is still the file: what is wrong is what it says, not where it is.
    expect(policySource()).toBe(policyFile());
    const out = await runHook('claude-code', benignBash(tmpdir()));
    expect(decisionOf(out.stdout)).toBe('deny');
  });

  it('allows the same benign call under the built-in default, so the denials above are the policy', async () => {
    const out = await runHook('claude-code', benignBash(tmpdir()));
    expect(decisionOf(out.stdout)).toBe('allow');
  });
});
