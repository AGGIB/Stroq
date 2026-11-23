import { mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runUninstall } from '../../src/commands/uninstall.js';
import { KEY_PATHS } from '../../src/credential-sandbox/rules.js';
import { claudeSandboxStatus, sandboxSummary } from '../../src/credential-sandbox/status.js';
import { asked, entry, ledgerFile, readJson, save, useSandboxHome } from './fixture.js';

const f = useSandboxHome();
const read = () => readJson(f.settings);
const paths = (): string[] =>
  read().sandbox.credentials.files.map((file: { path: string }) => file.path);

/** A link in the throwaway home, to an inert file or folder made beside it. */
function link(from: string, to: string, kind: 'file' | 'dir' = 'file'): void {
  const target = join(f.home, to);
  if (kind === 'dir') mkdirSync(target, { recursive: true });
  else save(target, 'inert fixture, not a credential');
  mkdirSync(dirname(join(f.home, from)), { recursive: true });
  symlinkSync(target, join(f.home, from));
}

describe.skipIf(process.platform === 'win32')('a listed path that is a link', () => {
  it('lists the target too, records both and removes both', async () => {
    link('.npmrc', 'dotfiles/npmrc-real');
    link('.gnupg', 'dotfiles/gnupg', 'dir');

    await asked({ extra: true });

    expect(paths()).toEqual(
      expect.arrayContaining(['~/.npmrc', '~/dotfiles/npmrc-real', '~/.gnupg', '~/dotfiles/gnupg']),
    );
    expect(paths()).toHaveLength(15);
    const owned: { id: string; link?: string }[] = readJson(ledgerFile(f.stroq)).owned;
    expect(owned.filter((rule) => rule.id === '~/.npmrc').map((rule) => rule.link)).toEqual([
      undefined,
      '~/dotfiles/npmrc-real',
    ]);
    expect(f.out.join('')).toMatch(/~\/\.npmrc is a link[^\n]*~\/dotfiles\/npmrc-real/);

    await runUninstall(['--user']);
    expect(read()).toEqual({});
  });

  it('lists the real place when a folder above the key path is a link', async () => {
    link('.config', 'dotfiles/config', 'dir');

    await asked();

    expect(paths()).toEqual(
      expect.arrayContaining([
        '~/.config/gcloud',
        '~/dotfiles/config/gcloud',
        '~/.config/gh/hosts.yml',
        '~/dotfiles/config/gh/hosts.yml',
      ]),
    );
  });

  it('keeps a target the user listed as the user’s own', async () => {
    link('.netrc', 'dotfiles/netrc-real');
    save(f.settings, { sandbox: { credentials: { files: [entry('~/dotfiles/netrc-real')] } } });

    await asked();
    await runUninstall(['--user']);

    expect(read()).toEqual({
      sandbox: { credentials: { files: [entry('~/dotfiles/netrc-real')] } },
    });
  });

  it('does not list a target that holds the home folder, and says so', async () => {
    symlinkSync(dirname(f.home), join(f.home, '.ssh'));

    await asked();

    expect(paths()).toHaveLength(8);
    expect(f.out.join('')).toMatch(/~\/\.ssh is a link[^\n]*not listed/);
  });
});

describe.skipIf(process.platform === 'win32')('what doctor counts', () => {
  const all = () => ({
    sandbox: { enabled: true, credentials: { files: KEY_PATHS.map(entry) } },
  });

  it('leaves out a link whose target is not listed, and names the link and the target', () => {
    link('.npmrc', 'dotfiles/npmrc-real');
    save(f.settings, all());

    const status = claudeSandboxStatus(f.where);

    expect(status).toMatchObject({
      listed: 12,
      links: [{ path: '~/.npmrc', target: '~/dotfiles/npmrc-real' }],
    });
    expect(sandboxSummary(status)).toContain('12/13');
    expect(sandboxSummary(status)).toMatch(/~\/\.npmrc is a link to ~\/dotfiles\/npmrc-real/);
  });

  it('counts the link once its target is listed, by itself or by a folder above it', () => {
    link('.npmrc', 'dotfiles/npmrc-real');
    const withTarget = all();
    withTarget.sandbox.credentials.files.push(entry('~/dotfiles/npmrc-real'));
    save(f.settings, withTarget);
    expect(claudeSandboxStatus(f.where)).toMatchObject({ listed: 13, links: [] });

    const withFolder = all();
    withFolder.sandbox.credentials.files.push(entry('~/dotfiles'));
    save(f.settings, withFolder);
    expect(claudeSandboxStatus(f.where)).toMatchObject({ listed: 13, links: [] });
  });

  it('leaves out a link that leads nowhere, and says it could not be followed', () => {
    symlinkSync(join(f.home, 'gone'), join(f.home, '.netrc'));
    save(f.settings, all());

    const status = claudeSandboxStatus(f.where);

    expect(status).toMatchObject({ listed: 12, links: [{ path: '~/.netrc', target: null }] });
    expect(sandboxSummary(status)).toMatch(/~\/\.netrc is a link[^.]*could not be followed/);
  });
});
