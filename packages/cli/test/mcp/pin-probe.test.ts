import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { probeServers } from '../../src/exposure/probe.js';
import { CLI_ENTRY } from '../helpers/cli-entry.js';

it('never unwraps a pinned wrapper when exposure probes a server', async () => {
  const home = await mkdtemp(join(tmpdir(), 'stroq-pin-probe-'));
  try {
    const marker = join(home, 'executed');
    const server = join(home, 'server.mjs');
    const file = join(home, '.mcp.json');
    await writeFile(
      server,
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes');`,
    );
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          demo: {
            command: process.execPath,
            args: [
              CLI_ENTRY,
              'mcp',
              '--server',
              'demo',
              '--client',
              'claude-code',
              '--pin',
              `sha256:${'a'.repeat(64)}`,
              '--',
              process.execPath,
              server,
            ],
            env: { STROQ_HOME: home },
          },
        },
      }),
    );
    const result = await probeServers(
      [{ client: 'claude-code', scope: 'project', file, stdio: 1, wrapped: 1, strict: 0, http: 0 }],
      { timeoutMs: 2000 },
    );
    expect(result[0]?.error).not.toBeNull();
    await expect(readFile(marker)).rejects.toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
