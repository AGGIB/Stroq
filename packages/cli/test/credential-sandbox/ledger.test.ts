import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runUninstall } from '../../src/commands/uninstall.js';
import { KEY_PATHS, RETRY_RULE } from '../../src/credential-sandbox/rules.js';
import { asked, entry, ledgerFile, readJson, save, useSandboxHome } from './fixture.js';

const f = useSandboxHome();
const read = () => readJson(f.settings);
const said = () => f.out.join('');

describe('uninstall with no ownership record', () => {
  it('takes the hooks out, leaves every sandbox entry and names the ones still in the file', async () => {
    await asked({ enable: true, extra: true });
    rmSync(f.stroq, { recursive: true, force: true });
    f.out.length = 0;

    expect(await runUninstall(['--user'])).toBe(0);

    const left = read();
    expect(left.hooks).toBeUndefined();
    expect(left.sandbox.enabled).toBe(true);
    expect(left.sandbox.autoAllowBashIfSandboxed).toBe(false);
    expect(left.sandbox.credentials.files).toHaveLength(13);
    expect(left.permissions.ask).toEqual([RETRY_RULE]);
    expect(said()).toContain('Removed Stroq hook entries');
    expect(said()).toContain('no record');
    expect(said()).toContain(f.settings);
    for (const path of KEY_PATHS) expect(said()).toContain(path);
    expect(said()).toContain(RETRY_RULE);
    expect(said()).toContain('sandbox.enabled');
    expect(said()).toContain('sandbox.autoAllowBashIfSandboxed');
    expect(said()).toMatch(/by hand/);
  });

  it('says so again on a second run, when there are no hooks left to remove', async () => {
    await asked();
    rmSync(f.stroq, { recursive: true, force: true });
    await runUninstall(['--user']);
    f.out.length = 0;

    await runUninstall(['--user']);

    expect(said()).toContain('nothing to remove');
    expect(said()).toContain('no record');
    expect(read().sandbox.credentials.files).toHaveLength(8);
  });

  it('does not list a sandbox the user turned on alone', async () => {
    save(f.settings, { sandbox: { enabled: true, autoAllowBashIfSandboxed: false } });
    await asked({}, ['--hooks-only']);
    f.out.length = 0;

    await runUninstall(['--user']);

    expect(said()).not.toContain('no record');
    expect(read()).toEqual({ sandbox: { enabled: true, autoAllowBashIfSandboxed: false } });
  });

  it('keeps a preview parseable and puts the notice on stderr', async () => {
    await asked();
    rmSync(f.stroq, { recursive: true, force: true });
    f.out.length = 0;

    await runUninstall(['--user', '--dry-run']);

    expect(JSON.parse(said()).sandbox.credentials.files).toHaveLength(8);
    expect(f.err.join('')).toContain('no record');
  });
});

describe('an interrupted write followed by an outside edit', () => {
  /** An install that stops after the settings were replaced and before the record was finished. */
  async function interrupted(): Promise<string> {
    const atomic = await import('../../src/harden/atomic.js');
    const write = atomic.writeFileAtomic;
    const spy = vi
      .spyOn(atomic, 'writeFileAtomic')
      .mockImplementation(async (file, data, options) => {
        if (file.includes(join('.stroq', 'sandbox')) && !String(data).includes('"pending"'))
          throw new Error('interrupted');
        return write(file, data, options);
      });
    await expect(asked()).rejects.toThrow('interrupted');
    spy.mockRestore();
    const edited = read();
    save(f.settings, { ...edited, theme: 'edited outside' });
    return ledgerFile(f.stroq);
  }

  it('keeps the record on uninstall and says what is unresolved', async () => {
    const receipt = await interrupted();
    const before = readFileSync(receipt, 'utf8');
    f.out.length = 0;

    await runUninstall(['--user']);

    expect(readFileSync(receipt, 'utf8')).toBe(before);
    expect(read().sandbox.credentials.files).toHaveLength(8);
    expect(read().hooks).toBeUndefined();
    expect(said()).toContain('interrupted');
    expect(said()).toContain(receipt);
    expect(said()).toContain('~/.ssh');
  });

  it('refuses to add sandbox settings until it is resolved, and names --hooks-only', async () => {
    const receipt = await interrupted();
    const before = read();

    await expect(asked({ extra: true })).rejects.toThrow(/interrupted[\s\S]*--hooks-only/);

    expect(read()).toEqual(before);
    expect(existsSync(receipt)).toBe(true);
  });
});

describe('a record that fails its check', () => {
  const mine = {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: false,
      credentials: { files: [entry('~/.ssh'), entry('~/.aws/credentials')] },
    },
    permissions: { ask: [RETRY_RULE] },
  };
  const receiptFor = (settings: string) =>
    join(
      f.stroq,
      'sandbox',
      createHash('sha256').update(realpathSync(settings)).digest('hex') + '.json',
    );

  it('cannot make uninstall turn off a sandbox the user set up', async () => {
    save(f.settings, mine);
    await asked({}, ['--hooks-only']);
    const planted = receiptFor(f.settings);
    save(planted, {
      version: 1,
      owned: [
        { id: '~/.ssh', created: 3, previous: null },
        { id: '~/.aws/credentials', created: 3, previous: null },
        { id: 'ask-retry', created: 2, previous: null },
        { id: 'auto-allow', created: 2, previous: null },
        { id: 'enabled', created: 2, previous: false },
      ],
    });
    f.out.length = 0;

    await runUninstall(['--user']);

    expect(read()).toEqual(mine);
    expect(existsSync(planted)).toBe(true);
    expect(said()).toContain('could not be verified');
    expect(said()).toContain(planted);
  });

  it('is not acted on once it was edited after Stroq signed it', async () => {
    await asked({ enable: true });
    const receipt = ledgerFile(f.stroq);
    const record = readJson(receipt);
    expect(record.mac).toMatch(/^[a-f0-9]{64}$/);
    record.owned.find((rule: { id: string }) => rule.id === 'enabled').previous = false;
    writeFileSync(receipt, JSON.stringify(record) + '\n');

    await runUninstall(['--user']);

    expect(read().sandbox.enabled).toBe(true);
    expect(read().sandbox.credentials.files).toHaveLength(8);
  });

  it('is not accepted for another settings file', async () => {
    const profile = join(f.home, 'work-claude');
    vi.stubEnv('CLAUDE_CONFIG_DIR', profile);
    await asked({ enable: true });
    const signedForWork = readFileSync(ledgerFile(f.stroq), 'utf8');
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    save(f.settings, mine);
    writeFileSync(receiptFor(f.settings), signedForWork);

    await runUninstall(['--user']);

    expect(read()).toEqual(mine);
  });

  it('is replaced by a signed one on the next interactive install, which claims only what it adds', async () => {
    save(f.settings, { sandbox: { credentials: { files: [entry('~/.ssh')] } } });
    await asked({}, ['--hooks-only']);
    save(receiptFor(f.settings), {
      version: 1,
      owned: [{ id: '~/.ssh', created: 0, previous: null }],
    });

    await asked();
    await runUninstall(['--user']);

    expect(read()).toEqual({ sandbox: { credentials: { files: [entry('~/.ssh')] } } });
  });
});

describe('removal', () => {
  it('keeps a hand-set enabled:false through a second install and an uninstall', async () => {
    await asked({ enable: true });
    save(f.settings, { ...read(), sandbox: { ...read().sandbox, enabled: false } });

    await asked({ enable: true });
    expect(read().sandbox.enabled).toBe(true);
    await runUninstall(['--user']);

    expect(read()).toEqual({ sandbox: { enabled: false } });
  });

  it('leaves no empty containers when the first recorded entry was removed by hand', async () => {
    await asked();
    const edited = read();
    edited.sandbox.credentials.files.shift();
    save(f.settings, edited);

    await runUninstall(['--user']);

    expect(read()).toEqual({});
  });

  it('keeps a container the user had before, even when it ends up empty', async () => {
    save(f.settings, { sandbox: { credentials: { files: [] } }, permissions: {} });
    await asked({ enable: true });

    await runUninstall(['--user']);

    expect(read()).toEqual({ sandbox: { credentials: { files: [] } }, permissions: {} });
  });
});

it('names --hooks-only when an unrecognised files entry stops the install', async () => {
  const mine = { sandbox: { credentials: { files: ['~/.ssh'] } } };
  save(f.settings, mine);

  await expect(asked()).rejects.toThrow(/sandbox\.credentials\.files[\s\S]*--hooks-only/);

  expect(read()).toEqual(mine);
});
