import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { killChildTree } from '../../src/mcp/kill-child.js';

describe.skipIf(process.platform === 'win32')('detached process group escalation', () => {
  it('closes inherited pipes when a descendant ignores SIGTERM after its leader exits', async () => {
    const descendant =
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)";
    const launcher = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000)`;
    const child = spawn(process.execPath, ['-e', launcher], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = once(child.stdout!, 'data');
      const closed = once(child, 'close');
      await ready;
      const exited = once(child, 'exit');
      killChildTree(child, 'SIGTERM');
      await exited;
      expect(child.signalCode).toBe('SIGTERM');
      killChildTree(child, 'SIGKILL');
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('descendant kept stdout open')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      killChildTree(child, 'SIGKILL');
    }
  });
});
