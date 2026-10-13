import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexHookCommand } from '../../../src/live/drivers/codex-hook.js';
import { makeRig, type Rig } from '../rig.js';

const rigs: Rig[] = [];
afterEach(() => rigs.splice(0).forEach((rig) => rig.cleanup()));
const wrapper = () => {
  const rig = makeRig();
  rigs.push(rig);
  codexHookCommand(rig.ctx(), 'hook-line');
  const file = join(
    rig.home,
    readdirSync(rig.home).find((name) => name.endsWith('.cjs'))!,
  );
  return { rig, file, source: readFileSync(file, 'utf8') };
};
describe('Codex private hook wrapper', () => {
  it('never replaces a wrapper when another request starts', () => {
    const { rig, file, source } = wrapper();
    codexHookCommand(rig.ctx(), 'another-hook');
    expect(readdirSync(rig.home).filter((name) => name.endsWith('.cjs'))).toHaveLength(2);
    expect(readFileSync(file, 'utf8')).toBe(source);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it.each([false, true])('forwards denies and fails closed on stdin errors (%s)', (broken) => {
    const { rig, source } = wrapper();
    const exit = vi.fn();
    const spawnSync = vi.fn(() => ({ status: 2 }));
    runInNewContext(source, {
      require: (name: string) =>
        name === 'node:child_process'
          ? { spawnSync }
          : {
              readFileSync: () => {
                if (broken) throw new Error('closed');
                return 'event';
              },
            },
      process: { env: { PATH: '/bin', KEEP: 'yes' }, exit },
    });
    expect(exit).toHaveBeenCalledWith(2);
    if (!broken)
      expect(spawnSync.mock.calls[0]).toMatchObject([
        'hook-line',
        {
          env: { HOME: rig.home, USERPROFILE: rig.home, STROQ_HOME: rig.stroqHome, KEEP: 'yes' },
          input: 'event',
        },
      ]);
  });
});
