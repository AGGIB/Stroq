import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeMetric, type MetricSummary } from './latency-math.js';

export const OUTLIER_THRESHOLD_MS = 10_000;

export interface LatencyScenario {
  readonly id: string;
  readonly title: string;
  readonly isBareNode?: boolean;
  readonly payload?: unknown;
}

const HEAVY_SOURCE_SAMPLE = 'export function sample() { return 42; }\n'.repeat(1500);

export const LATENCY_SCENARIOS: readonly LatencyScenario[] = [
  {
    id: 'bare-node',
    title: 'node -e 0 (baseline)',
    isBareNode: true,
  },
  {
    id: 'pre-tool-use-bash',
    title: 'PreToolUse: Bash (git status)',
    payload: {
      session_id: 'bench-latency',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      cwd: process.cwd(),
    },
  },
  {
    id: 'post-tool-use-bash',
    title: 'PostToolUse: Bash (short output)',
    payload: {
      session_id: 'bench-latency',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      tool_response: {
        stdout:
          'On branch main\nYour branch is up to date with origin/main.\nnothing to commit, working tree clean\n',
        stderr: '',
        interrupted: false,
      },
      cwd: process.cwd(),
    },
  },
  {
    id: 'post-tool-use-heavy',
    title: 'PostToolUse: View (~60KB content)',
    payload: {
      session_id: 'bench-latency',
      hook_event_name: 'PostToolUse',
      tool_name: 'View',
      tool_input: { path: 'sample.ts' },
      tool_response: {
        content: HEAVY_SOURCE_SAMPLE,
      },
      cwd: process.cwd(),
    },
  },
];

export interface LatencyScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly samples: number;
  readonly outliers: number;
  readonly processor: MetricSummary;
  readonly wall: MetricSummary;
}

export interface LatencyBenchReport {
  readonly version: 1;
  readonly n: number;
  readonly warmup: number;
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly results: readonly LatencyScenarioResult[];
}

export interface LatencyBenchOptions {
  readonly n?: number;
  readonly warmup?: number;
  readonly cliEntry?: string;
}

/** Resolves the executable CLI entry point file (built dist or source ts). */
export function resolveCliEntry(custom?: string): string {
  if (custom) return custom;
  const launched = process.argv[1] ? resolve(process.argv[1]) : '';
  if (
    launched &&
    (launched.endsWith('index.js') || launched.endsWith('index.ts') || launched.endsWith('stroq'))
  ) {
    try {
      return realpathSync(launched);
    } catch {
      return launched;
    }
  }
  // Try built bundle next to this file or in package dist
  const candidateJs = fileURLToPath(new URL('../index.js', import.meta.url));
  if (existsSync(candidateJs)) return candidateJs;
  const candidateDist = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
  if (existsSync(candidateDist)) return candidateDist;
  const candidateTs = fileURLToPath(new URL('../index.ts', import.meta.url));
  return candidateTs;
}

const RECORDER_SCRIPT_SOURCE = `
const fs = require('node:fs');
process.on('exit', () => {
  const file = process.env.STROQ_BENCH_CPU_FILE;
  if (!file) return;
  try {
    const u = process.cpuUsage();
    fs.writeFileSync(file, JSON.stringify({ ms: (u.user + u.system) / 1000 }), 'utf8');
  } catch {}
});
`;

export async function runLatencyBench(
  options: LatencyBenchOptions = {},
): Promise<LatencyBenchReport> {
  const n = options.n ?? 100;
  const warmup = options.warmup ?? 5;
  const entry = resolveCliEntry(options.cliEntry);

  const workDir = await mkdtemp(join(tmpdir(), 'stroq-bench-latency-'));
  const recorderScript = join(workDir, 'recorder.cjs');
  const cpuFile = join(workDir, 'cpu.json');
  const isolatedHome = join(workDir, 'home');
  await mkdir(isolatedHome, { recursive: true });
  await writeFile(recorderScript, RECORDER_SCRIPT_SOURCE, 'utf8');

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    STROQ_HOME: join(isolatedHome, '.stroq'),
    STROQ_BENCH_CPU_FILE: cpuFile,
  };

  const isTs = entry.endsWith('.ts');

  try {
    const results: LatencyScenarioResult[] = [];

    for (const scenario of LATENCY_SCENARIOS) {
      const input = scenario.payload !== undefined ? JSON.stringify(scenario.payload) : '';

      // Determine command line arguments
      let spawnArgs: string[];
      if (scenario.isBareNode) {
        spawnArgs = ['--require', recorderScript, '-e', '0'];
      } else if (isTs) {
        spawnArgs = ['--require', recorderScript, '--import', 'tsx', entry, 'hook', 'claude-code'];
      } else {
        spawnArgs = ['--require', recorderScript, entry, 'hook', 'claude-code'];
      }

      // Warmup runs (discarded)
      for (let i = 0; i < warmup; i += 1) {
        spawnSync(process.execPath, spawnArgs, {
          input,
          env: baseEnv,
          cwd: workDir,
          encoding: 'utf8',
        });
      }

      const wallSamples: number[] = [];
      const cpuSamples: number[] = [];
      let outliers = 0;

      // Measured runs
      for (let i = 0; i < n; i += 1) {
        await rm(cpuFile, { force: true });
        const start = performance.now();
        spawnSync(process.execPath, spawnArgs, {
          input,
          env: baseEnv,
          cwd: workDir,
          encoding: 'utf8',
        });
        const wallMs = performance.now() - start;

        if (wallMs > OUTLIER_THRESHOLD_MS) {
          outliers += 1;
          continue;
        }

        let cpuMs = 0;
        try {
          const raw = await readFile(cpuFile, 'utf8');
          const parsed = JSON.parse(raw);
          if (typeof parsed?.ms === 'number') cpuMs = parsed.ms;
        } catch {}

        wallSamples.push(wallMs);
        cpuSamples.push(cpuMs);
      }

      results.push({
        id: scenario.id,
        title: scenario.title,
        samples: wallSamples.length,
        outliers,
        processor: summarizeMetric(cpuSamples),
        wall: summarizeMetric(wallSamples),
      });
    }

    return {
      version: 1,
      n,
      warmup,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      results,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Formats latency report for terminal display. */
export function formatLatencyBench(report: LatencyBenchReport): string {
  const lines: string[] = [];
  lines.push(`Stroq Hook Latency Benchmark (n=${report.n}, warmup=${report.warmup})`);
  lines.push(`Machine: ${report.platform} ${report.arch} (Node ${report.nodeVersion})`);
  lines.push('');

  const colScenario = 35;
  const colProc = 28;
  const colWall = 28;

  const header =
    'Scenario'.padEnd(colScenario) +
    'Processor (p50 / p95 / p99)'.padEnd(colProc) +
    'Wall (p50 / p95 / p99)'.padEnd(colWall) +
    'Outliers';
  lines.push(header);
  lines.push('-'.repeat(header.length));

  for (const r of report.results) {
    const procStr = `${r.processor.p50} / ${r.processor.p95} / ${r.processor.p99} ms`.padEnd(
      colProc,
    );
    const wallStr = `${r.wall.p50} / ${r.wall.p95} / ${r.wall.p99} ms`.padEnd(colWall);
    const line = r.title.padEnd(colScenario) + procStr + wallStr + String(r.outliers).padStart(8);
    lines.push(line);
  }

  const bareNode = report.results.find((r) => r.id === 'bare-node');
  const preBash = report.results.find((r) => r.id === 'pre-tool-use-bash');
  if (bareNode && preBash) {
    const overheadWall = Math.max(0, Math.round((preBash.wall.p50 - bareNode.wall.p50) * 10) / 10);
    const overheadProc = Math.max(
      0,
      Math.round((preBash.processor.p50 - bareNode.processor.p50) * 10) / 10,
    );
    lines.push('');
    lines.push(
      `Stroq overhead on PreToolUse vs bare node: ~${overheadProc} ms processor, ~${overheadWall} ms wall (p50).`,
    );
  }

  lines.push('');
  return lines.join('\n');
}
