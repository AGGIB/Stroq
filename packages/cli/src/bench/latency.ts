import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../mcp/child-env.js';
import { onInterrupt } from '../ui/cleanup.js';
import { summarizeMetric, type MetricSummary } from './latency-math.js';

export const OUTLIER_THRESHOLD_MS = 10_000;
export const BENCH_TIMEOUT_MS = 20_000;
export const STROQ_VERSION = '0.25.0';

export type ChildRunFn = (
  execPath: string,
  args: readonly string[],
  input: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  cpuFile: string,
) => { readonly wallMs: number; readonly cpuMs: number | null };

export interface LatencyScenario {
  readonly id: string;
  readonly title: string;
  readonly isBareNode?: boolean;
  readonly makePayload?: (testCwd: string) => unknown;
}

export const HEAVY_SOURCE_SAMPLE = 'export function sample() { return 42; }\n'.repeat(1500);

export const LATENCY_SCENARIOS: readonly LatencyScenario[] = [
  {
    id: 'bare-node',
    title: 'node -e 0 (baseline)',
    isBareNode: true,
  },
  {
    id: 'pre-tool-use-bash',
    title: 'PreToolUse (bash: `git status`)',
    makePayload: (testCwd) => ({
      session_id: 'bench-latency',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      cwd: testCwd,
    }),
  },
  {
    id: 'post-tool-use-bash',
    title: 'PostToolUse (short command output)',
    makePayload: (testCwd) => ({
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
      cwd: testCwd,
    }),
  },
  {
    id: 'post-tool-use-heavy',
    title: 'PostToolUse (heavy ~60KB content)',
    makePayload: (testCwd) => ({
      session_id: 'bench-latency',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: join(testCwd, 'sample.ts') },
      tool_response: {
        type: 'text',
        file: {
          filePath: join(testCwd, 'sample.ts'),
          content: HEAVY_SOURCE_SAMPLE,
          numLines: 1500,
          startLine: 1,
          totalLines: 1500,
        },
      },
      cwd: testCwd,
    }),
  },
];

export interface LatencyOverhead {
  readonly processorP50: number | null;
  readonly wallP50: number | null;
}

export interface LatencyScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly samples: number;
  readonly outliers: number;
  readonly droppedSamples: number;
  readonly processor: MetricSummary;
  readonly wall: MetricSummary;
  readonly overhead?: LatencyOverhead;
}

export interface LatencyBenchReport {
  readonly version: 1;
  readonly stroqVersion: string;
  readonly date: string;
  readonly unit: 'ms';
  readonly outlierThresholdMs: number;
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
  readonly runner?: ChildRunFn;
}

/** Resolves the built CLI entry point file (`dist/index.js`). */
export function resolveCliEntry(custom?: string): string {
  if (custom) {
    if (!existsSync(custom)) {
      throw new Error(`Custom CLI entry does not exist: ${custom}`);
    }
    return realpathSync(resolve(custom));
  }

  const launched = process.argv[1] ? resolve(process.argv[1]) : '';
  let candidate = launched;
  try {
    candidate = realpathSync(launched);
  } catch {}
  if (
    candidate &&
    existsSync(candidate) &&
    !candidate.includes('vitest') &&
    (candidate.endsWith('.js') || candidate.endsWith('/stroq'))
  ) {
    return candidate;
  }

  const distCandidate = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
  if (existsSync(distCandidate)) {
    return realpathSync(distCandidate);
  }

  throw new Error(
    'stroq bench: CLI bundle not found. Please build the packages with "pnpm build" first.',
  );
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

/** Executes one child run and returns wall time and processor time in ms. */
function executeChildRun(
  execPath: string,
  args: readonly string[],
  input: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  cpuFile: string,
): { readonly wallMs: number; readonly cpuMs: number | null } {
  try {
    rmSync(cpuFile, { force: true });
  } catch {}

  const start = performance.now();
  const res = spawnSync(execPath, [...args], {
    input,
    env,
    cwd,
    encoding: 'utf8',
    timeout: BENCH_TIMEOUT_MS,
  });
  const wallMs = performance.now() - start;

  if (res.error) {
    throw new Error(`Benchmark process failed to execute: ${res.error.message}`);
  }
  if (res.signal) {
    throw new Error(`Benchmark process killed by signal ${res.signal}`);
  }
  if (res.status !== 0) {
    const errText = (res.stderr || res.stdout || '').trim();
    throw new Error(
      `Benchmark process exited with code ${res.status}${errText ? `: ${errText}` : ''}`,
    );
  }

  let cpuMs: number | null = null;
  try {
    if (existsSync(cpuFile)) {
      const raw = readFileSync(cpuFile, 'utf8');
      const d = JSON.parse(raw);
      if (typeof d?.ms === 'number' && Number.isFinite(d.ms)) {
        cpuMs = d.ms;
      }
    }
  } catch {}

  return { wallMs, cpuMs };
}

export async function runLatencyBench(
  options: LatencyBenchOptions = {},
): Promise<LatencyBenchReport> {
  const n = options.n ?? 100;
  const warmup = options.warmup ?? 5;
  const entry = resolveCliEntry(options.cliEntry);

  let workDir = '';
  let cancelInterrupt: (() => void) | undefined;

  try {
    workDir = await mkdtemp(join(tmpdir(), 'stroq-bench-latency-'));
    cancelInterrupt = onInterrupt(() => {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {}
    });

    const recorderScript = join(workDir, 'recorder.cjs');
    await writeFile(recorderScript, RECORDER_SCRIPT_SOURCE, 'utf8');

    const runner = options.runner ?? executeChildRun;
    const cleanBaseEnv = childEnv([]);
    const results: LatencyScenarioResult[] = [];

    for (const scenario of LATENCY_SCENARIOS) {
      // Fresh isolated environment and working directory per scenario
      const scenarioDir = join(workDir, scenario.id);
      const homeDir = join(scenarioDir, 'home');
      const stroqHomeDir = join(homeDir, '.stroq');
      const testCwd = join(scenarioDir, 'project');
      const cpuFile = join(scenarioDir, 'cpu.json');

      await mkdir(homeDir, { recursive: true });
      await mkdir(testCwd, { recursive: true });

      const sampleFile = join(testCwd, 'sample.ts');
      await writeFile(sampleFile, HEAVY_SOURCE_SAMPLE, 'utf8');

      const payload = scenario.makePayload ? scenario.makePayload(testCwd) : undefined;
      const input = payload !== undefined ? JSON.stringify(payload) : '';

      const scenarioEnv: NodeJS.ProcessEnv = {
        ...cleanBaseEnv,
        HOME: homeDir,
        USERPROFILE: homeDir,
        STROQ_HOME: stroqHomeDir,
        STROQ_BENCH_CPU_FILE: cpuFile,
      };

      const spawnArgs = scenario.isBareNode
        ? ['--require', recorderScript, '-e', '0']
        : ['--require', recorderScript, entry, 'hook', 'claude-code'];

      // Warmup runs
      for (let i = 0; i < warmup; i += 1) {
        runner(process.execPath, spawnArgs, input, scenarioEnv, testCwd, cpuFile);
      }

      // Measured runs
      const wallSamples: number[] = [];
      const cpuSamples: number[] = [];
      let outliers = 0;
      let droppedSamples = 0;

      for (let i = 0; i < n; i += 1) {
        const { wallMs, cpuMs } = runner(
          process.execPath,
          spawnArgs,
          input,
          scenarioEnv,
          testCwd,
          cpuFile,
        );

        if (wallMs > OUTLIER_THRESHOLD_MS) {
          outliers += 1;
          continue;
        }

        if (cpuMs === null) {
          droppedSamples += 1;
          continue;
        }

        wallSamples.push(wallMs);
        cpuSamples.push(cpuMs);
      }

      // Verify that non-baseline scenarios performed their expected work in audit log
      if (!scenario.isBareNode && !options.runner) {
        const auditLogPath = join(stroqHomeDir, 'audit.jsonl');
        if (!existsSync(auditLogPath)) {
          throw new Error(`Audit log was not created for scenario "${scenario.id}"`);
        }
        const auditContent = await readFile(auditLogPath, 'utf8');
        if (auditContent.length === 0) {
          throw new Error(`Audit log is unexpectedly empty for scenario "${scenario.id}"`);
        }
        if (scenario.id === 'post-tool-use-heavy') {
          if (!auditContent.includes('"phase":"post"') || !auditContent.includes('"scan"')) {
            throw new Error(`Audit log missing post scan entry for scenario "${scenario.id}"`);
          }
        }
      }

      results.push({
        id: scenario.id,
        title: scenario.title,
        samples: wallSamples.length,
        outliers,
        droppedSamples,
        processor: summarizeMetric(cpuSamples),
        wall: summarizeMetric(wallSamples),
      });
    }

    // Compute overhead vs baseline
    const baseline = results.find((r) => r.id === 'bare-node');
    const enrichedResults: LatencyScenarioResult[] = results.map((r) => {
      if (!baseline || r.id === 'bare-node' || r.samples === 0 || baseline.samples === 0) {
        return r;
      }
      return {
        ...r,
        overhead: {
          processorP50: Math.round((r.processor.p50 - baseline.processor.p50) * 10) / 10,
          wallP50: Math.round((r.wall.p50 - baseline.wall.p50) * 10) / 10,
        },
      };
    });

    return {
      version: 1,
      stroqVersion: STROQ_VERSION,
      date: new Date().toISOString(),
      unit: 'ms',
      outlierThresholdMs: OUTLIER_THRESHOLD_MS,
      n,
      warmup,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      results: enrichedResults,
    };
  } finally {
    cancelInterrupt?.();
    if (workDir) {
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

/** Formats latency report for terminal display. */
export function formatLatencyBench(report: LatencyBenchReport): string {
  const lines: string[] = [];
  lines.push(`Stroq Hook Latency Benchmark (n=${report.n}, warmup=${report.warmup})`);
  lines.push(
    `Machine: ${report.platform} ${report.arch} (Node ${report.nodeVersion}, Stroq ${report.stroqVersion})`,
  );
  if (report.platform === 'win32') {
    lines.push('Note: on Windows, process.cpuUsage() granularity is ~15.6 ms.');
  }
  lines.push('');

  const colScenario = 38;
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
    const procStr =
      r.samples > 0
        ? `${r.processor.p50} / ${r.processor.p95} / ${r.processor.p99} ms`.padEnd(colProc)
        : 'n/a'.padEnd(colProc);
    const wallStr =
      r.samples > 0
        ? `${r.wall.p50} / ${r.wall.p95} / ${r.wall.p99} ms`.padEnd(colWall)
        : 'n/a'.padEnd(colWall);
    const line = r.title.padEnd(colScenario) + procStr + wallStr + String(r.outliers).padStart(8);
    lines.push(line);
  }

  const baseline = report.results.find((r) => r.id === 'bare-node');
  const preBash = report.results.find((r) => r.id === 'pre-tool-use-bash');
  if (baseline && preBash && preBash.overhead?.wallP50 !== null) {
    lines.push('');
    lines.push(
      `Stroq overhead on PreToolUse vs bare node: ~${preBash.overhead?.processorP50} ms processor, ~${preBash.overhead?.wallP50} ms wall (p50).`,
    );
  }

  lines.push('');
  return lines.join('\n');
}
