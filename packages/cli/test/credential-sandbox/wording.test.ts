import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/commands/doctor.js';
import { runUninstall } from '../../src/commands/uninstall.js';
import { KEY_PATHS, RETRY_RULE } from '../../src/credential-sandbox/rules.js';
import {
  claudeSandboxStatus,
  sandboxCardLine,
  sandboxSummary,
} from '../../src/credential-sandbox/status.js';
import { asked, entry, readJson, save, useSandboxHome } from './fixture.js';

const f = useSandboxHome();
const read = () => readJson(f.settings);
const said = () => f.out.join('');

describe('saying yes to the sandbox question', () => {
  it('leaves autoAllowBashIfSandboxed unset when the user’s sandbox was already on', async () => {
    save(f.settings, { sandbox: { enabled: true } });

    await asked({ enable: true });

    expect(read().sandbox.autoAllowBashIfSandboxed).toBeUndefined();
    expect(read().permissions.ask).toEqual([RETRY_RULE]);
    expect(said()).not.toMatch(/turned on/);
    await runUninstall(['--user']);
    expect(read()).toEqual({ sandbox: { enabled: true } });
  });

  it('leaves an explicit value of the user’s as it is, on or off', async () => {
    save(f.settings, { sandbox: { enabled: false, autoAllowBashIfSandboxed: true } });

    await asked({ enable: true });

    expect(read().sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true });
  });

  it('writes the three settings when Stroq turns the sandbox on, and says so plainly', async () => {
    await asked({ enable: true });

    expect(read().sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: false });
    expect(read().permissions.ask).toEqual([RETRY_RULE]);
    expect(said()).toMatch(/sandbox turned on/);
    expect(said()).toContain('autoAllowBashIfSandboxed');
  });

  it('sets it again on a second yes when the sandbox on is Stroq’s own', async () => {
    await asked({ enable: true });
    const edited = read();
    delete edited.sandbox.autoAllowBashIfSandboxed;
    save(f.settings, edited);

    await asked({ enable: true });

    expect(read().sandbox.autoAllowBashIfSandboxed).toBe(false);
  });
});

describe('what init says about the list', () => {
  it('says the list is written and not in force while the sandbox is off', async () => {
    await asked();

    expect(said()).toMatch(/list written[^\n]*8 paths/);
    expect(said()).toMatch(/not in force until the Claude Code sandbox is on/);
    expect(said()).not.toContain('configured for sandboxed Bash');
  });

  it('does not say that when this file turns the sandbox on', async () => {
    await asked({ enable: true });

    expect(said()).not.toMatch(/not in force/);
  });
});

describe('the doctor line', () => {
  it('says a running session can differ and where the live state is shown', () => {
    save(f.settings, { sandbox: { enabled: true } });

    const line = sandboxSummary(claudeSandboxStatus(f.where));

    expect(line).toMatch(/running session can differ/);
    expect(line).toContain('/sandbox inside Claude Code');
  });

  it('says a list is not in force while the sandbox is off', () => {
    save(f.settings, { sandbox: { credentials: { files: [entry('~/.ssh')] } } });

    expect(sandboxSummary(claudeSandboxStatus(f.where))).toMatch(/1\/13[^.]*\. [^.]*not in force/);
  });
});

describe('the card line', () => {
  const line = () => sandboxCardLine(claudeSandboxStatus(f.where));

  it('says this folder’s own file decides when a repository ships a sandbox block', () => {
    save(f.settings, {});
    save(`${f.cwd}/.claude/settings.json`, {
      sandbox: { enabled: true, credentials: { files: KEY_PATHS.map(entry) } },
      permissions: { ask: [RETRY_RULE] },
    });

    expect(line()).toContain('this folder');
    expect(line()).toMatch(/set by this folder's \.claude\/settings\.json/);
    expect(line()).toMatch(/13\/13 paths \(13 only in this folder's settings\)/);
    expect(line()).not.toContain('(config)');
  });

  it('names the user file when that one decides', () => {
    save(f.settings, { sandbox: { enabled: true, credentials: { files: [entry('~/.ssh')] } } });

    expect(line()).toMatch(/on for this folder \(set by your user settings\.json\)/);
    expect(line()).toContain('1/13 paths');
    expect(line()).not.toContain('only in this folder');
  });

  it('says no file turns it on when none does', () => {
    save(f.settings, {});

    expect(line()).toMatch(/off for this folder \(no settings file turns it on\)/);
  });
});

it('doctor --all marks the Codex example as one that was not checked', async () => {
  save(f.settings, {});

  await runDoctor(['--all']);

  const text = said();
  const at = text.indexOf('Codex config.toml example');
  expect(at).toBeGreaterThan(-1);
  expect(text.slice(at)).toMatch(/not checked against a Codex release/);
});
