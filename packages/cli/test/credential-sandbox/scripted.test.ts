import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../src/commands/init.js';
import { asked, ledgerFile, readJson, save, useSandboxHome } from './fixture.js';

const f = useSandboxHome();
const read = () => readJson(f.settings);
const said = () => f.out.join('');
/** `init --user` the way a script or CI runs it: nobody answered a question. */
const scripted = (args: string[] = []) => runInit(['--user', ...args], { platform: 'darwin' });
const HOW = /stroq init --agent claude-code --user[^\n]*terminal/;

describe('a user-scope install nobody answered a question for', () => {
  it.each([[['--yes']], [['--no-input']], [['--yes', '--no-input']], [[]]])(
    'installs the hooks only with %j, and says in one line how to add the list',
    async (args) => {
      expect(await scripted(args)).toBe(0);

      expect(read().hooks.PreToolUse).toHaveLength(1);
      expect(read().sandbox).toBeUndefined();
      expect(read().permissions).toBeUndefined();
      expect(existsSync(join(f.stroq, 'sandbox'))).toBe(false);
      const hints = said()
        .split('\n')
        .filter((line) => HOW.test(line));
      expect(hints).toHaveLength(1);
      expect(said()).not.toContain('configured for sandboxed Bash');
    },
  );

  it('leaves a sandbox that is already on exactly as the user had it', async () => {
    const mine = { theme: 'dark', sandbox: { enabled: true } };
    save(f.settings, mine);

    await scripted(['--yes', '--no-input']);

    expect(read().sandbox).toEqual(mine.sandbox);
    expect(read().theme).toBe('dark');
  });

  it('previews the hooks only', async () => {
    await scripted(['--dry-run']);

    expect(JSON.parse(said()).sandbox).toBeUndefined();
    expect(existsSync(f.settings)).toBe(false);
    expect(existsSync(f.stroq)).toBe(false);
  });

  it('leaves an earlier list and its record alone on a re-run', async () => {
    await asked({ extra: true });
    const before = read().sandbox;
    const record = readFileSync(ledgerFile(f.stroq), 'utf8');

    await scripted(['--no-input']);

    expect(read().sandbox).toEqual(before);
    expect(readFileSync(ledgerFile(f.stroq), 'utf8')).toBe(record);
  });

  it('prints no hint when --hooks-only was asked for, or off macOS', async () => {
    await scripted(['--hooks-only']);
    await runInit(['--user'], { platform: 'linux' });

    expect(said()).not.toMatch(HOW);
  });
});
