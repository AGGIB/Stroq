import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { runBenchCommand } from '../../src/commands/bench.js';
import { commandHelp } from '../../src/help.js';
import { CLI_ENTRY } from '../helpers/cli-entry.js';

describe('bench command CLI', () => {
  it('documents --latency, --n, --warmup in help', () => {
    const help = commandHelp('bench');
    expect(help).toContain('--latency');
    expect(help).toContain('--n <count>');
    expect(help).toContain('--warmup <count>');
  });

  it('rejects --latency mixed with --actions or --corpus with exit code 2', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const exitActions = await runBenchCommand(['--latency', '--actions']);
      expect(exitActions).toBe(2);
      expect(stderrWrite).toHaveBeenCalled();
      const errActions = stderrWrite.mock.calls.map((c) => c[0]).join('');
      expect(errActions).toContain('--latency cannot be combined with --actions or --corpus');

      stderrWrite.mockClear();
      const exitCorpus = await runBenchCommand(['--latency', '--corpus', 'some/path']);
      expect(exitCorpus).toBe(2);
      const errCorpus = stderrWrite.mock.calls.map((c) => c[0]).join('');
      expect(errCorpus).toContain('--latency cannot be combined with --actions or --corpus');
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('rejects invalid --n values with exit code 2', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const badN of ['0', '1001', 'abc']) {
        stderrWrite.mockClear();
        const code = await runBenchCommand(['--latency', '--n', badN]);
        expect(code).toBe(2);
        const err = stderrWrite.mock.calls.map((c) => c[0]).join('');
        expect(err).toContain('--n has to be a whole number from 1 to 1000');
      }
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('rejects invalid --warmup values with exit code 2', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const badWarmup of ['101', 'xyz']) {
        stderrWrite.mockClear();
        const code = await runBenchCommand(['--latency', '--warmup', badWarmup]);
        expect(code).toBe(2);
        const err = stderrWrite.mock.calls.map((c) => c[0]).join('');
        expect(err).toContain('--warmup has to be a whole number from 0 to 100');
      }
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('rejects --n or --warmup without --latency with exit code 2', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const codeN = await runBenchCommand(['--n', '50']);
      expect(codeN).toBe(2);
      const errN = stderrWrite.mock.calls.map((c) => c[0]).join('');
      expect(errN).toContain('--n and --warmup are only valid with --latency');

      stderrWrite.mockClear();
      const codeWarmup = await runBenchCommand(['--warmup', '2']);
      expect(codeWarmup).toBe(2);
      const errWarmup = stderrWrite.mock.calls.map((c) => c[0]).join('');
      expect(errWarmup).toContain('--n and --warmup are only valid with --latency');
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('runs --latency with --n 1 and --warmup 0 via built CLI', () => {
    const res = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'bench', '--latency', '--n', '1', '--warmup', '0'],
      { encoding: 'utf8' },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Stroq Hook Latency Benchmark');
    expect(res.stdout).toContain('node -e 0 (baseline)');
    expect(res.stdout).toContain('PreToolUse (bash: `git status`)');
    expect(res.stdout).toContain('PostToolUse (heavy ~60KB content)');
  }, 30_000);

  it('emits valid json when --json is passed with --latency via built CLI', () => {
    const res = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'bench', '--latency', '--n', '1', '--warmup', '0', '--json'],
      { encoding: 'utf8' },
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.version).toBe(1);
    expect(parsed.stroqVersion).toBe('0.25.0');
    expect(parsed.n).toBe(1);
    expect(parsed.warmup).toBe(0);
    expect(parsed.results).toBeInstanceOf(Array);
    expect(parsed.results).toHaveLength(4);
  }, 30_000);
});
