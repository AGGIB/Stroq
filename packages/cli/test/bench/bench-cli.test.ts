import { describe, expect, it, vi } from 'vitest';
import { runBenchCommand } from '../../src/commands/bench.js';
import { commandHelp } from '../../src/help.js';

describe('bench command CLI', () => {
  it('documents --latency, --n, --warmup in help', () => {
    const help = commandHelp('bench');
    expect(help).toContain('--latency');
    expect(help).toContain('--n <count>');
    expect(help).toContain('--warmup <count>');
  });

  it('runs --latency with --n 1 and --warmup 0 via runBenchCommand', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const exitCode = await runBenchCommand(['--latency', '--n', '1', '--warmup', '0']);
      expect(exitCode).toBe(0);
      expect(stdoutWrite).toHaveBeenCalled();
      const output = stdoutWrite.mock.calls.map((c) => c[0]).join('');
      expect(output).toContain('Stroq Hook Latency Benchmark');
      expect(output).toContain('node -e 0');
    } finally {
      stdoutWrite.mockRestore();
    }
  }, 30_000);

  it('emits valid json when --json is passed with --latency', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const exitCode = await runBenchCommand(['--latency', '--n', '1', '--warmup', '0', '--json']);
      expect(exitCode).toBe(0);
      expect(stdoutWrite).toHaveBeenCalled();
      const output = stdoutWrite.mock.calls.map((c) => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.version).toBe(1);
      expect(parsed.n).toBe(1);
      expect(parsed.results).toBeInstanceOf(Array);
    } finally {
      stdoutWrite.mockRestore();
    }
  }, 30_000);
});
