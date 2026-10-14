import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { formatLatencyBench, runLatencyBench, type ChildRunFn } from '../../src/bench/latency.js';
import { CLI_ENTRY } from '../helpers/cli-entry.js';
import { stroqVersion } from '../../src/version.js';

describe('latency benchmark engine', () => {
  it('runs real latency benchmark with n=1 and warmup=0, verifying execution and audit scan', async () => {
    const report = await runLatencyBench({
      n: 1,
      warmup: 0,
      cliEntry: CLI_ENTRY,
    });

    expect(report.version).toBe(1);
    expect(report.stroqVersion).toBe(stroqVersion());
    expect(report.unit).toBe('ms');
    expect(report.outlierThresholdMs).toBe(10_000);
    expect(report.n).toBe(1);
    expect(report.warmup).toBe(0);
    expect(report.results.length).toBe(4);

    // Baseline result
    const bareNode = report.results[0];
    expect(bareNode).toBeDefined();
    expect(bareNode!.id).toBe('bare-node');
    expect(bareNode!.samples).toBe(1);
    expect(bareNode!.outliers).toBe(0);
    expect(bareNode!.wall.p50).toBeGreaterThan(0);
    // On Windows, process.cpuUsage() granularity is ~15.6ms and may register as 0 for very quick runs
    if (process.platform !== 'win32') {
      expect(bareNode!.processor.p50).toBeGreaterThanOrEqual(0);
    }

    // Heavy Read scenario
    const heavyPost = report.results.find((r) => r.id === 'post-tool-use-heavy');
    expect(heavyPost).toBeDefined();
    expect(heavyPost!.samples).toBe(1);
    expect(heavyPost!.wall.p50).toBeGreaterThan(0);

    // PreToolUse scenario
    const preHook = report.results.find((r) => r.id === 'pre-tool-use-bash');
    expect(preHook).toBeDefined();
    expect(preHook!.samples).toBe(1);
    expect(preHook!.overhead).toBeDefined();

    // Verify formatLatencyBench
    const formatted = formatLatencyBench(report);
    expect(formatted).toContain('Stroq Hook Latency Benchmark');
    expect(formatted).toContain('node -e 0 (baseline)');
    expect(formatted).toContain('PreToolUse (bash: `git status`)');
    expect(formatted).toContain('PostToolUse (heavy ~60KB content)');
    expect(formatted).toContain('Stroq overhead on PreToolUse');

    // Verify JSON serialization
    const jsonStr = JSON.stringify(report);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.version).toBe(1);
    expect(parsed.stroqVersion).toBe(stroqVersion());
    expect(parsed.results).toHaveLength(4);
  }, 30_000);

  it('handles discarded outliers and missing CPU samples via runner seam', async () => {
    let callCount = 0;
    const mockRunner: ChildRunFn = () => {
      callCount += 1;
      // First sample: normal
      if (callCount % 3 === 1) return { wallMs: 25.0, cpuMs: 15.0 };
      // Second sample: missing CPU file
      if (callCount % 3 === 2) return { wallMs: 26.0, cpuMs: null };
      // Third sample: >10s outlier
      return { wallMs: 12_000.0, cpuMs: 100.0 };
    };

    const report = await runLatencyBench({
      n: 3,
      warmup: 0,
      cliEntry: CLI_ENTRY,
      runner: mockRunner,
    });

    for (const res of report.results) {
      expect(res.samples).toBe(1);
      expect(res.droppedSamples).toBe(1);
      expect(res.outliers).toBe(1);
      expect(res.wall.p50).toBe(25.0);
      expect(res.processor.p50).toBe(15.0);
    }

    const baseline = report.results[0];
    const preBash = report.results.find((r) => r.id === 'pre-tool-use-bash');
    expect(baseline?.overhead).toBeUndefined();
    expect(preBash?.overhead?.wallP50).toBe(0);
    expect(preBash?.overhead?.processorP50).toBe(0);

    const formatted = formatLatencyBench(report);
    expect(formatted).toContain('Retained / Req');
    expect(formatted).toContain('Missing CPU');
    expect(formatted).toContain('Outliers');
    expect(formatted).toMatch(/1 \/ 3\s+15 \/ 15 \/ 15 ms\s+25 \/ 25 \/ 25 ms\s+1\s+1/);
  });

  it('fails fast when child process execution fails', async () => {
    const failingRunner: ChildRunFn = () => {
      throw new Error('Benchmark process exited with code 1: command not found');
    };

    await expect(
      runLatencyBench({
        n: 1,
        warmup: 0,
        cliEntry: CLI_ENTRY,
        runner: failingRunner,
      }),
    ).rejects.toThrow('Benchmark process exited with code 1: command not found');
  });

  it('formats n/a when all samples are discarded', async () => {
    const outlierRunner: ChildRunFn = () => ({ wallMs: 15_000, cpuMs: null });

    const report = await runLatencyBench({
      n: 2,
      warmup: 0,
      cliEntry: CLI_ENTRY,
      runner: outlierRunner,
    });

    for (const res of report.results) {
      expect(res.samples).toBe(0);
      expect(res.outliers).toBe(2);
    }

    const formatted = formatLatencyBench(report);
    expect(formatted).toContain('n/a');
    expect(formatted).toContain('0 / 2');
    expect(formatted).toContain('percentiles are n/a because all samples were excluded');
    expect(formatted).toContain('2 outliers (>10s)');
  });

  it('formats n/a and explains missing-CPU exclusions when samples lack CPU time', async () => {
    const missingCpuRunner: ChildRunFn = () => ({ wallMs: 25.0, cpuMs: null });

    const report = await runLatencyBench({
      n: 2,
      warmup: 0,
      cliEntry: CLI_ENTRY,
      runner: missingCpuRunner,
    });

    for (const res of report.results) {
      expect(res.samples).toBe(0);
      expect(res.droppedSamples).toBe(2);
      expect(res.outliers).toBe(0);
    }

    const formatted = formatLatencyBench(report);
    expect(formatted).toContain('n/a');
    expect(formatted).toContain('0 / 2');
    expect(formatted).toContain('percentiles are n/a because all samples were excluded');
    expect(formatted).toContain('2 samples with missing CPU time');
  });

  it('fails with child stderr when real child process exits with non-zero code', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'stroq-bench-test-'));
    try {
      const exitScript = join(tmp, 'exit3.js');
      await writeFile(exitScript, 'console.error("boom from entry"); process.exit(3);', 'utf8');
      await expect(
        runLatencyBench({
          n: 1,
          warmup: 0,
          cliEntry: exitScript,
        }),
      ).rejects.toThrow(/exited with code 3: boom from entry/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('isolates child environment from NODE_OPTIONS and STROQ_* and sets cwd to temp folder', async () => {
    vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=4096');
    vi.stubEnv('STROQ_CUSTOM_VAR', 'leaked_value');

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedCwd: string | undefined;
    let capturedInput: string | undefined;

    const mockRunner: ChildRunFn = (_execPath, _args, input, env, cwd) => {
      if (input.length > 0) {
        capturedEnv = env;
        capturedCwd = cwd;
        capturedInput = input;
      }
      return { wallMs: 10, cpuMs: 5 };
    };

    try {
      await runLatencyBench({
        n: 1,
        warmup: 0,
        cliEntry: CLI_ENTRY,
        runner: mockRunner,
      });

      expect(capturedEnv).toBeDefined();
      expect(capturedEnv?.NODE_OPTIONS).toBeUndefined();
      expect(capturedEnv?.STROQ_CUSTOM_VAR).toBeUndefined();

      expect(capturedCwd).toBeDefined();
      expect(capturedCwd).toContain('project');

      expect(capturedInput).toBeDefined();
      const parsedEvent = JSON.parse(capturedInput!);
      expect(parsedEvent.cwd).toBe(capturedCwd);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
