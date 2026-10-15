import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(
  readFileSync(new URL('../../../../.github/workflows/release.yml', import.meta.url), 'utf8'),
) as { jobs: Record<string, { steps: { name?: string; run?: string }[] }> };
const step = (name: string): string => {
  const script = workflow.jobs['smoke-test']?.steps.find((entry) => entry.name === name)?.run;
  if (!script) throw new Error(`missing smoke step ${name}`);
  return script;
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { passed?: number; doctorStatus?: number; spaces?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stroq-release-smoke-'));
  roots.push(root);
  const runner = join(root, options.spaces ? 'runner temp' : 'runner');
  const bin = join(runner, 'stroq-smoke-install/node_modules/.bin');
  const trace = join(root, 'calls.jsonl');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'stroq'),
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME, user: process.env.USERPROFILE, stroq: process.env.STROQ_HOME, token: process.env.NODE_AUTH_TOKEN }) + '\\n');
switch (process.argv[2]) {
  case '--version': console.log('0.25.1'); break;
  case 'attack': console.log('36 scenarios, ${options.passed ?? 0} passed through'); break;
  case 'doctor': console.log('✔ stroq: 0.25.1'); process.exitCode = ${options.doctorStatus ?? 1}; break;
  case 'hook': fs.readFileSync(0); console.log('{"permissionDecision":"deny"}'); break;
  default: process.exitCode = 2;
}
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    RUNNER_TEMP: runner,
    RUNNER_OS: 'Linux',
    VERSION: '0.25.1',
    NODE_AUTH_TOKEN: 'TEST_ONLY_NOT_A_CREDENTIAL',
  };
  const run = (script: string) =>
    spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
  const calls = () =>
    readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { root, runner, trace, env, run, calls };
}

// The release job uses Bash on every runner. Windows' native test process can resolve
// WSL's bash ahead of Git Bash, so exercise these process tests on macOS/Linux.
describe.skipIf(process.platform === 'win32')('published package smoke step behavior', () => {
  const smoke = () =>
    step('Run post-publish smoke checks').replaceAll(
      '${{ steps.target.outputs.version }}',
      '0.25.1',
    );

  it('isolates every package invocation, including the first version check', () => {
    const f = fixture();
    const result = f.run(smoke());
    expect(result.status, result.stderr).toBe(0);
    expect(f.calls()).toHaveLength(4);
    for (const call of f.calls()) {
      expect(call.home).toBe(join(f.runner, 'stroq-smoke-empty'));
      expect(call.user).toBe(call.home);
      expect(call.stroq).toBe(call.home);
      expect(call.token).toBeUndefined();
    }
  });

  it('runs the installed bin when its path contains spaces', () => {
    const f = fixture({ spaces: true });
    const result = f.run(smoke());
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects ten passed-through attacks even when attack incorrectly exits zero', () => {
    const f = fixture({ passed: 10 });
    expect(f.run(smoke()).status).not.toBe(0);
  });

  it('rejects an unexpected doctor exit even if it printed the version first', () => {
    const f = fixture({ doctorStatus: 2 });
    expect(f.run(smoke()).status).not.toBe(0);
  });

  it('passes manual versions as data and rejects shell substitutions', () => {
    const f = fixture();
    const input = '$(printf 0.25.1)';
    const script = step('Determine version to test')
      .replaceAll('${{ github.event.inputs.test_version }}', input)
      .replaceAll('${{ github.ref_name }}', 'main')
      .replaceAll('${{ github.ref_type }}', 'branch');
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      cwd: f.root,
      env: {
        ...f.env,
        TEST_VERSION: input,
        RELEASE_REF_NAME: 'main',
        RELEASE_REF_TYPE: 'branch',
        GITHUB_OUTPUT: join(f.root, 'output'),
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).not.toBe(0);
  });

  it('installs from npm without inheriting the runner home or token', () => {
    const f = fixture();
    const tools = join(f.root, 'tools');
    mkdirSync(tools);
    writeFileSync(
      join(tools, 'npm'),
      `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(f.trace)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME, user: process.env.USERPROFILE, stroq: process.env.STROQ_HOME, token: process.env.NODE_AUTH_TOKEN }) + '\\n');
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      'bash',
      [
        '-e',
        '-o',
        'pipefail',
        '-c',
        step('Install published package').replaceAll(
          '${{ steps.target.outputs.version }}',
          '0.25.1',
        ),
      ],
      {
        cwd: f.root,
        env: { ...f.env, PATH: `${tools}:${process.env['PATH'] ?? ''}` },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(f.calls()).toMatchObject([
      {
        home: join(f.runner, 'stroq-smoke-empty'),
        user: join(f.runner, 'stroq-smoke-empty'),
        stroq: join(f.runner, 'stroq-smoke-empty'),
        args: expect.arrayContaining([
          '@stroq/cli@0.25.1',
          '--registry=https://registry.npmjs.org',
        ]),
      },
    ]);
    expect(f.calls()[0]?.token).toBeUndefined();
  });
});
