import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileSecretIndex } from '@stroq/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRun } from '../../src/commands/run.js';
import { commandHelp } from '../../src/help.js';
import { capture, SRT, useWorlds, world } from '../helpers/run-world.js';

useWorlds();
afterEach(() => vi.restoreAllMocks());

describe('explicit sandbox dependency admission', () => {
  it('explains the required dependency and the bounded meaning of force in help', () => {
    const help = commandHelp('run');
    expect(help).toContain('refuse before launch when it is missing');
    expect(help).toContain('--sandbox still requires srt');
  });
  it.each(
    [
      [],
      ['--force'],
      ['--dry-run'],
      ['--dry-run', '--force'],
      ['--force', '--no-inspect'],
      ['--dry-run', '--force', '--no-inspect'],
    ].map((flags) => ({ flags })),
  )('refuses missing SRT before preflight, state writes or launch: $flags', async ({ flags }) => {
    const w = world(),
      marker = join(w.cwd, 'executed');
    const refresh = vi
      .spyOn(FileSecretIndex.prototype, 'refresh')
      .mockRejectedValue(Error('unexpected-index-read'));
    const launch = vi.fn(async () => {
      writeFileSync(marker, 'executed');
      return 0;
    });
    const before = readdirSync(w.home),
      out = capture();
    let code;
    try {
      code = await runRun([...flags, '--sandbox', '--', 'claude'], w.cwd, {
        srt: () => null,
        launch,
        userHome: w.userHome,
        isTTY: false,
      });
    } finally {
      out.restore();
    }
    expect(code).toBe(1);
    expect(launch).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(w.home)).toEqual(before);
    expect(out.text()).toContain('--sandbox requires');
    expect(out.text()).toContain('npm install -g @anthropic-ai/sandbox-runtime');
    expect(out.text()).not.toMatch(/would run:|git hardening:|starting anyway|stroq init/);
  });

  it('keeps an ordinary launch independent of the optional SRT dependency', async () => {
    const w = world(),
      marker = join(w.cwd, 'ordinary-executed');
    const srt = vi.fn(() => null);
    const launch = vi.fn(async () => {
      writeFileSync(marker, 'executed');
      return 7;
    });
    const out = capture();
    let code;
    try {
      code = await runRun(['--force', '--no-inspect', '--', 'fixture-command'], w.cwd, {
        srt,
        launch,
        userHome: w.userHome,
      });
    } finally {
      out.restore();
    }
    expect(code).toBe(7);
    expect(srt).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledOnce();
    expect(existsSync(marker)).toBe(true);
    expect(out.text()).not.toContain('--sandbox requires');
  });

  it('keeps a present-SRT dry run and its generated settings without launching or refreshing secrets', async () => {
    const w = world(),
      refresh = vi.spyOn(FileSecretIndex.prototype, 'refresh');
    const launch = vi.fn(async () => 0),
      out = capture();
    let code;
    try {
      code = await runRun(
        ['--force', '--no-inspect', '--dry-run', '--sandbox', '--', 'fixture-command'],
        w.cwd,
        {
          srt: () => SRT,
          launch,
          userHome: w.userHome,
          plat: 'linux',
          isTTY: false,
        },
      );
    } finally {
      out.restore();
    }
    expect(code).toBe(0);
    expect(launch).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(readdirSync(w.home)).toEqual([]);
    expect(out.text()).toContain(`would run: ${SRT}`);
    expect(out.text()).toContain('denyRead');
  });
});
