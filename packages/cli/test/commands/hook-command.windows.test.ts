import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  chooseHookCommand,
  hookCommand,
  isBare,
  windowsTools,
} from '../../src/commands/hook-command.js';
import { startsAsHost } from '../../src/commands/init.js';
import { runHookAsCmd } from '../../src/commands/init-selfcheck.js';
import { CLI_ENTRY } from '../helpers/cli-entry.js';

/**
 * What only a Windows machine can say. Everything about the hook line is otherwise checked against a model of
 * how Windows starts it (`../helpers/cmd-model.ts`) and against fakes of the machine; these run the real
 * `cmd.exe`, the real Node `spawn` and the real built CLI, and so say whether the model was right. They are
 * skipped on every other system, and CI's `windows-latest` job is where they run. If one fails there, it is the
 * model or the line that is wrong, and the unit tests that agree with the model are not to be trusted.
 */
describe.skipIf(process.platform !== 'win32')('the hook line on Windows', () => {
  it('cannot start the line Stroq used to write for Antigravity, with each quote escaped as its host does', async () => {
    const line = `${hookCommand(process.execPath, CLI_ENTRY, 'antigravity')} pre`;

    const run = await runHookAsCmd(line, '{}', process.env, tmpdir());

    // The report: `'\"C:\Program Files\nodejs\node.exe\"' is not recognized as an internal or external command`.
    // The words are the system's language; the escaped quote in the name is not.
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('\\"');
  });

  it('starts the same Node and entry written without a quote, as the hook of Antigravity', async () => {
    const chosen = await chooseHookCommand(process.execPath, CLI_ENTRY, 'antigravity', {
      probe: (line) => startsAsHost('antigravity', line),
    });

    expect(chosen.refused).toBeNull();
    expect(chosen.command).not.toContain('"');
    expect(chosen.command.endsWith(' hook antigravity')).toBe(true);
  });

  it('gives the short name of Program Files, and it is the same folder', () => {
    const tools = windowsTools();
    const long = process.env['ProgramFiles'] ?? 'C:\\Program Files';

    const short = tools.shortPath(long);

    // Windows setup makes this one with its 8.3 name, whatever is done to the drive afterwards.
    expect(short).toMatch(/^[A-Z]:\\PROGRA~\d$/i);
    expect(isBare(short ?? '')).toBe(true);
    expect(tools.sameFile(short ?? '', long)).toBe(true);
  });

  it('does not take two folders for one, nor a folder that does not exist for a folder', () => {
    const tools = windowsTools();

    expect(tools.sameFile('C:\\Windows', 'C:\\Program Files')).toBe(false);
    expect(tools.sameFile('C:\\Windows', 'C:\\no such folder')).toBe(false);
    expect(tools.sameFile('C:\\no such folder', 'C:\\no such folder')).toBe(false);
  });
});
