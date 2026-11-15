import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  'working-directory'?: string;
}
interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps: Step[];
}
const workflow = parse(
  readFileSync(new URL('../../../../.github/workflows/release.yml', import.meta.url), 'utf8'),
) as { permissions: Record<string, string>; jobs: Record<string, Job> };
const getJob = (name: string): Job => {
  const found = workflow.jobs[name];
  if (!found) throw new Error(`missing ${name} job`);
  return found;
};
const step = (job: string, name: string): Step => {
  const found = getJob(job).steps.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing ${job} step ${name}`);
  return found;
};

describe('release credential boundary', () => {
  it('keeps the checked build and package lifecycle scripts outside the credentialed job', () => {
    const build = getJob('build');
    expect(build).toBeDefined();
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(JSON.stringify(build)).not.toContain('secrets.');
    for (const name of [
      'Install dependencies',
      'Check formatting and types',
      'Test with coverage',
      'Build',
      'Verify rules, corpus, ATLAS and reports',
      'Run attack and fuzz gates',
      'Pack the checked release',
    ]) {
      expect(step('build', name).run).toBeTruthy();
    }
    expect(step('build', 'Pack the checked release').run).toContain('npm pack ');
    expect(build.if).toContain("github.event.inputs.test_version == ''");
    expect(build.if).toContain("github.ref == 'refs/heads/main'");
    expect(getJob('publish').needs).toBe('build');
    expect(getJob('github-release').needs).toBe('publish');
  });

  it('stages only an archive without checkout, project installs, or package scripts', () => {
    const publish = getJob('publish');
    expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    for (const entry of publish.steps) {
      expect(entry.uses ?? '').not.toContain('actions/checkout');
      expect(entry.uses ?? '').not.toContain('pnpm/action-setup');
      expect(entry['working-directory']).toBeUndefined();
      expect(entry.run ?? '').not.toMatch(/\bpnpm\b|\bnpm (?:pack|run|ci)\b/);
    }
    for (const name of ['Stage on npm (token)', 'Stage on npm (trusted publishing)']) {
      const run = step('publish', name).run ?? '';
      expect(run).toContain('npm stage publish "$RUNNER_TEMP/stroq-package/stroq-cli.tgz"');
      expect(run).toContain('--ignore-scripts');
      expect(run).toContain('--registry=https://registry.npmjs.org');
    }
    expect(step('publish', 'Install staged-publishing npm CLI').run).toContain(
      'npm install --global npm@11.15.0 --ignore-scripts',
    );
  });

  it('downloads only this run\u2019s named artifact with no credentials or run override', () => {
    const upload = getJob('build').steps.find((s) =>
      s.uses?.startsWith('actions/upload-artifact@'),
    );
    const download = getJob('publish').steps.find((s) =>
      s.uses?.startsWith('actions/download-artifact@'),
    );
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    expect(upload?.with?.path).toBe('${{ runner.temp }}/stroq-package/stroq-cli.tgz');
    expect(download?.with).toEqual({
      name: upload?.with?.name,
      path: '${{ runner.temp }}/stroq-package',
    });
    for (const job of [getJob('build'), getJob('publish')]) {
      for (const entry of job.steps.filter((s) => s.uses)) {
        expect(entry.uses).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Execute the validator from the workflow itself, with real tar files. No package
// code is loaded and no npm/registry operation occurs in these tests.
function fixture(manifest: unknown = { name: '@stroq/cli', version: '0.32.0' }) {
  const root = mkdtempSync(join(tmpdir(), 'stroq-release-staging-'));
  roots.push(root);
  const source = join(root, 'source');
  const artifact = join(root, 'stroq-package');
  const archive = join(artifact, 'stroq-cli.tgz');
  mkdirSync(join(source, 'package'), { recursive: true });
  mkdirSync(artifact);
  writeFileSync(
    join(source, 'package/package.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
  );
  const packed = spawnSync('tar', ['-czf', archive, '-C', source, 'package'], {
    encoding: 'utf8',
  });
  expect(packed.status, packed.stderr).toBe(0);
  const script = /<<'NODE'\n([\s\S]*)\nNODE/.exec(
    step('publish', 'Verify the packed release').run ?? '',
  )?.[1];
  if (!script) throw new Error('missing archive validator');
  const run = (env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        VERSION: '0.32.0',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF_NAME: 'v0.32.0',
        ...env,
      },
    });
  return { artifact, archive, run };
}

describe.skipIf(process.platform === 'win32')('packed release validation', () => {
  it('accepts matching public package metadata without executing lifecycle scripts', () => {
    const f = fixture({
      name: '@stroq/cli',
      version: '0.32.0',
      publishConfig: { access: 'public' },
      scripts: { prepack: 'exit 17', prepublishOnly: 'exit 17', postpublish: 'exit 17' },
    });
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    { name: '@someone/else', version: '0.32.0' },
    { name: '@stroq/cli', version: '0.32.1' },
    { name: '@stroq/cli', version: '0.32.0', private: true },
    'not json',
    '{"name":"@stroq/cli","version":"0.32.0"}{"name":"other"}',
  ])('refuses mismatched, private, or unreadable metadata: %j', (manifest) => {
    expect(fixture(manifest).run().status).not.toBe(0);
  });

  it.each([
    { access: 'restricted' },
    { access: 'public', '@stroq:registry': 'https://example.invalid' },
    { access: 'public', registry: 'https://example.invalid' },
    { access: 'public', proxy: 'https://example.invalid' },
    { access: 'public', 'https-proxy': 'https://example.invalid' },
    { access: 'public', 'strict-ssl': false },
    { access: 'public', 'provenance-file': '/tmp/untrusted-provenance.json' },
    { access: 'public', cert: 'untrusted certificate' },
    { access: 'public', 'ignore-scripts': false },
    { access: 'public', tag: 'unexpected-tag' },
    {},
    null,
    [],
    'public',
  ])(
    'refuses archive publishing configuration outside the public-access setting: %j',
    (publishConfig) => {
      expect(
        fixture({ name: '@stroq/cli', version: '0.32.0', publishConfig }).run().status,
      ).not.toBe(0);
    },
  );

  it.each(['', '0.32.0\nmode=trusted', '../../other', 'v0.32.0'])(
    'refuses an invalid expected version: %j',
    (VERSION) => {
      expect(fixture().run({ VERSION }).status).not.toBe(0);
    },
  );

  it('checks tag identity independently of the build output', () => {
    expect(fixture().run({ GITHUB_REF_NAME: 'v0.32.1' }).status).not.toBe(0);
  });

  it('accepts the manual main retry without treating main as a version tag', () => {
    const result = fixture().run({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF_NAME: 'main',
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('refuses extra artifact files, including npm configuration', () => {
    const f = fixture();
    writeFileSync(join(f.artifact, '.npmrc'), 'registry=https://example.invalid');
    expect(f.run().status).not.toBe(0);
  });

  it('refuses a symlink in place of the archive', () => {
    const f = fixture();
    rmSync(f.archive);
    symlinkSync('/does-not-exist', f.archive);
    expect(f.run().status).not.toBe(0);
  });
});
