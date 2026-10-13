import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatLatencyBench, runLatencyBench } from '../../src/bench/latency.js';
import { CLI_ENTRY } from '../helpers/cli-entry.js';

describe('latency benchmark engine', () => {
  it('runs latency benchmark with small n and warmup, returning valid report', async () => {
    // Run with n=2 and warmup=0 for fast execution in CI/test suite
    const report = await runLatencyBench({
      n: 2,
      warmup: 0,
      cliEntry: CLI_ENTRY,
    });

    expect(report.version).toBe(1);
    expect(report.n).toBe(2);
    expect(report.warmup).toBe(0);
    expect(report.results.length).toBeGreaterThanOrEqual(4);

    // Verify bare node baseline is the first result
    const bareNode = report.results[0];
    expect(bareNode).toBeDefined();
    expect(bareNode!.id).toBe('bare-node');
    expect(bareNode!.samples).toBe(2);
    expect(bareNode!.outliers).toBe(0);
    expect(bareNode!.wall.p50).toBeGreaterThan(0);
    expect(bareNode!.processor.p50).toBeGreaterThan(0);

    // Verify Claude hook events
    const preHook = report.results.find((r) => r.id === 'pre-tool-use-bash');
    expect(preHook).toBeDefined();
    expect(preHook!.samples).toBe(2);
    expect(preHook!.wall.p50).toBeGreaterThan(0);

    // Verify formatting output
    const formatted = formatLatencyBench(report);
    expect(formatted).toContain('Stroq Hook Latency Benchmark');
    expect(formatted).toContain('node -e 0');
    expect(formatted).toContain('PreToolUse: Bash');
    expect(formatted).toContain('p50 / p95 / p99');
    expect(formatted).toContain('Stroq overhead on PreToolUse');

    // Verify JSON serialization
    const jsonStr = JSON.stringify(report);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.version).toBe(1);
    expect(parsed.results).toHaveLength(report.results.length);
  }, 30_000);
});
