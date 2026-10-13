import { HOME_SECRET_SOURCES, classifyTool } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_READ_DENY_RULES,
  HOME_CREDENTIAL_PATHS,
  PROJECT_SECRET_FILES,
  homeReadRule,
  projectReadRule,
  ruleCovers,
} from '../../../src/harden/recipes/credential-paths.js';

/**
 * The list of what to protect is not a new opinion: Stroq already decides, in its classifier and in its
 * secret index, which paths hold credentials. These tests hold the recipe's list to those two, so that a
 * path the classifier calls a secret cannot be missing from the rules, and a rule cannot name a path
 * the classifier does not know without somebody saying so here.
 */
const HOME = '/home/someone';

/**
 * A path the rule `Read(~/<glob>)` names, with `**` standing for a file inside the folder. The file is
 * called `config` because the classifier knows `~/.kube` only as the folder itself and as `.kube/config`.
 */
const examplePath = (glob: string): string =>
  `${HOME}/${glob.endsWith('/**') ? `${glob.slice(0, -3)}/config` : glob}`;

const isSecretToTheClassifier = (path: string): boolean =>
  classifyTool('Read', { file_path: path }, '/work').classes.includes('fs.secrets');

/**
 * Paths of the list that Stroq's own classifier does not (yet) call secret. They are in the list because
 * the design names them; each is listed here so that adding one to the list without a decision fails.
 */
const NOT_KNOWN_TO_THE_CLASSIFIER: readonly string[] = ['.docker/config.json', '.gnupg/**'];

describe('the project secret files', () => {
  it('are the .env file and its variants', () => {
    expect(PROJECT_SECRET_FILES).toEqual(['.env', '.env.*']);
  });

  it.each(PROJECT_SECRET_FILES.map((name) => [name.split('*').join('local')]))(
    'the classifier calls a project file like %s a secret',
    (name) => {
      expect(isSecretToTheClassifier(`/work/project/${name}`)).toBe(true);
    },
  );
});

describe('the home credential stores', () => {
  const known = HOME_CREDENTIAL_PATHS.filter((path) => !NOT_KNOWN_TO_THE_CLASSIFIER.includes(path));

  it.each(known.map((path) => [path]))('the classifier calls %s a secret', (path) => {
    expect(isSecretToTheClassifier(examplePath(path))).toBe(true);
  });

  it('lists the ones the classifier does not know, and only those, as the exceptions', () => {
    const unknown = HOME_CREDENTIAL_PATHS.filter(
      (path) => !isSecretToTheClassifier(examplePath(path)),
    );
    expect(unknown).toEqual(NOT_KNOWN_TO_THE_CLASSIFIER);
  });

  it('covers every file the secret index reads its values from', () => {
    expect(HOME_SECRET_SOURCES.length).toBeGreaterThan(0);
    for (const source of HOME_SECRET_SOURCES) {
      const covered = HOME_CREDENTIAL_PATHS.some((path) => ruleCovers(path, source));
      expect(covered, `${source} is read into the secret index but no rule covers it`).toBe(true);
    }
  });

  it('names the well-known stores the design lists', () => {
    expect(HOME_CREDENTIAL_PATHS).toEqual(
      expect.arrayContaining([
        '.ssh/**',
        '.aws/**',
        '.config/gcloud/**',
        '.kube/**',
        '.docker/config.json',
        '.npmrc',
        '.netrc',
        '.git-credentials',
        '.gnupg/**',
      ]),
    );
  });

  it('has no path twice', () => {
    expect(new Set(HOME_CREDENTIAL_PATHS).size).toBe(HOME_CREDENTIAL_PATHS.length);
  });
});

describe('ruleCovers', () => {
  it('covers a file inside a whole folder, and the file named exactly', () => {
    expect(ruleCovers('.aws/**', '.aws/credentials')).toBe(true);
    expect(ruleCovers('.aws/**', '.aws/sso/cache/token.json')).toBe(true);
    expect(ruleCovers('.npmrc', '.npmrc')).toBe(true);
  });

  it('does not cover another folder that only starts with the same letters', () => {
    expect(ruleCovers('.aws/**', '.awsome/credentials')).toBe(false);
    expect(ruleCovers('.npmrc', '.npmrc.bak')).toBe(false);
  });
});

describe('the rules', () => {
  it('spell a project file and a home path the way Claude Code reads them', () => {
    expect(projectReadRule('.env')).toBe('Read(./.env)');
    expect(projectReadRule('.env.*')).toBe('Read(./.env.*)');
    expect(homeReadRule('.ssh/**')).toBe('Read(~/.ssh/**)');
    expect(homeReadRule('.npmrc')).toBe('Read(~/.npmrc)');
  });

  it('are the project files first and the home stores after them, each once', () => {
    expect(CLAUDE_READ_DENY_RULES).toEqual([
      ...PROJECT_SECRET_FILES.map(projectReadRule),
      ...HOME_CREDENTIAL_PATHS.map(homeReadRule),
    ]);
    expect(new Set(CLAUDE_READ_DENY_RULES).size).toBe(CLAUDE_READ_DENY_RULES.length);
  });

  it('are all Read rules with nothing in them that a shell or a JSON file would treat as special', () => {
    for (const rule of CLAUDE_READ_DENY_RULES) {
      expect(rule).toMatch(/^Read\((?:\.\/|~\/)[A-Za-z0-9._*/-]+\)$/);
    }
  });
});
