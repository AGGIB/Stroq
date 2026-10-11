import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEFAULT_POLICY } from '@stroq/core';
import { runFuzz } from '../../src/attack/fuzz.js';
import { MUTATIONS } from '../../src/attack/mutate.js';
import { SCENARIOS } from '../../src/attack/scenarios/index.js';

/**
 * The fuzz gate is an inline script in two workflows, and nothing else reads it: a renamed field in
 * the report, or a step edited so that the check no longer runs, would turn the gate into a no-op
 * with every test green. So these tests take the script out of the workflow files as they are, and
 * run it on reports, as the runner would.
 */

interface Step {
  readonly name?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly run?: string;
}

function stepsOf(workflow: string): readonly Step[] {
  const file = new URL(`../../../../.github/workflows/${workflow}`, import.meta.url);
  const parsed = parse(readFileSync(file, 'utf8')) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  return Object.values(parsed.jobs).flatMap((job) => job.steps);
}

function fuzzStep(workflow: string, name: string): Step {
  const found = stepsOf(workflow).find((step) => step.name === name);
  if (!found?.run) throw new Error(`${workflow} has no step "${name}" with a script`);
  return found;
}

/** The body of the `node -e '...'` that reads fuzz-report.json: the script holds no single quote. */
function gateScript(step: Step): string {
  const match = /node -e '([^']*)'/.exec(step.run ?? '');
  if (!match?.[1]) throw new Error(`step "${step.name}" has no node -e script`);
  return match[1];
}

const WORKFLOWS: ReadonlyArray<readonly [string, string]> = [
  ['ci.yml', 'Attack suite — mutation fuzz'],
  ['release.yml', 'Run attack and fuzz gates'],
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Runs the gate on `report` (or on a file that does not parse) the way the runner does. */
function runGate(script: string, report: unknown) {
  const cwd = mkdtempSync(join(tmpdir(), 'stroq-ci-gate-'));
  roots.push(cwd);
  writeFileSync(
    join(cwd, 'fuzz-report.json'),
    typeof report === 'string' ? report : JSON.stringify(report),
  );
  const run = spawnSync(process.execPath, ['-e', script], {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

const clean = { version: 2, variants: 350, escaped: [], inconclusive: [] };
const variant = {
  scenarioId: '02-sentry-agentjacking',
  mutationId: 'synonym-rephrase',
  preserving: true,
  outcome: 'passed',
  ruleId: null,
  error: null,
};

describe.each(WORKFLOWS)('the fuzz gate in %s', (workflow, name) => {
  const step = fuzzStep(workflow, name);
  const script = gateScript(step);

  it('gives the fuzz run a scan budget long enough for a timeout to mean something', () => {
    expect(step.env?.['STROQ_SCAN_BUDGET_MS']).toBe('60000');
  });

  it('passes a report with no escape and nothing inconclusive', () => {
    const out = runGate(script, clean);
    expect(out.status).toBe(0);
  });

  it('fails a report with an escape, and names it', () => {
    const out = runGate(script, { ...clean, escaped: [variant] });
    expect(out.status).toBe(1);
    expect(out.out).toContain('02-sentry-agentjacking synonym-rephrase');
  });

  it('fails a report with an inconclusive variant, and names it', () => {
    const out = runGate(script, {
      ...clean,
      inconclusive: [
        {
          ...variant,
          outcome: 'timeout',
          error: 'step 1 (post Read): the scan ran out of its time budget',
        },
      ],
    });
    expect(out.status).toBe(1);
    expect(out.out).toContain('02-sentry-agentjacking synonym-rephrase');
    expect(out.out).toContain('time budget');
  });

  it('fails a report that has no inconclusive list: it is not the report this gate reads', () => {
    const { inconclusive: _gone, ...old } = clean;
    expect(runGate(script, old).status).not.toBe(0);
  });

  it('fails a report that does not parse, rather than passing on nothing', () => {
    expect(runGate(script, 'not json').status).not.toBe(0);
  });
});

describe('the fuzz gate in ci.yml', () => {
  const script = gateScript(fuzzStep('ci.yml', 'Attack suite — mutation fuzz'));

  // The CI-facing fields are the contract: `escaped` and `variants` mean what they meant.
  it('reads the numbers the line it prints is made of', () => {
    const out = runGate(script, { ...clean, variants: 123 });
    expect(out.out).toContain('escaped 0 of 123 variants (baseline 0)');
  });

  it('accepts the report the fuzzer really writes', async () => {
    const report = await runFuzz(
      SCENARIOS.filter((s) => s.id.startsWith('01-')),
      MUTATIONS.slice(0, 3),
      DEFAULT_POLICY,
      'default',
    );
    const out = runGate(script, JSON.parse(JSON.stringify(report)) as unknown);
    expect(out.status).toBe(0);
    expect(out.out).toContain(`of ${report.variants} variants`);
  }, 60_000);
});

describe('the fuzz steps keep their exit-code handling', () => {
  it('ci.yml still tells a crash (any code but 0 or 1) from a failed gate', () => {
    const run = fuzzStep('ci.yml', 'Attack suite — mutation fuzz').run ?? '';
    expect(run).toContain(
      'node packages/cli/dist/index.js attack --fuzz --json > fuzz-report.json',
    );
    expect(run).toContain('[ "$status" -ne 0 ] && [ "$status" -ne 1 ]');
  });

  it('release.yml runs the same fuzz command and does not let a failed run pass', () => {
    const run = fuzzStep('release.yml', 'Run attack and fuzz gates').run ?? '';
    expect(run).toContain('node packages/cli/dist/index.js attack\n');
    expect(run).toContain(
      'node packages/cli/dist/index.js attack --fuzz --json > fuzz-report.json',
    );
    expect(run).toContain('[ "$status" -ne 0 ] && [ "$status" -ne 1 ]');
    // Whatever the script found, an exit code of the run itself is the last word.
    expect(run.trimEnd().split('\n').at(-1)).toBe('exit "$status"');
  });
});
