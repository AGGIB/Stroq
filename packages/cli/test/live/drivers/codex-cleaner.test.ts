import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { makeRig } from '../rig.js';

it('refuses to write a cleaned capture containing unredacted AppData', () => {
  const rig = makeRig();
  try {
    writeFileSync(join(rig.project, 'location.json'), JSON.stringify({ root: rig.root }));
    writeFileSync(
      join(rig.project, 'version.json'),
      JSON.stringify({ stdout: 'codex-cli 0.162.1 AppData/Local/private' }),
    );
    const output = join(rig.home, 'cleaned');
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../../../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        fileURLToPath(new URL('../../../../../scripts/clean-codex-fixture.ts', import.meta.url)),
        rig.project,
        output,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not written');
    expect(existsSync(join(output, 'version.json'))).toBe(false);
  } finally {
    rig.cleanup();
  }
});
