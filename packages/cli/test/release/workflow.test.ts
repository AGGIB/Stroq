import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  id?: string;
  if?: string;
}

interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  'runs-on'?: string;
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
  strategy?: {
    'fail-fast'?: boolean;
    matrix?: {
      os?: string[];
      [key: string]: unknown;
    };
  };
  defaults?: {
    run?: {
      shell?: string;
    };
  };
  steps: WorkflowStep[];
}

interface WorkflowDocument {
  name: string;
  on: {
    push?: {
      tags?: string[];
    };
    workflow_dispatch?: {
      inputs?: {
        test_version?: {
          description?: string;
          required?: boolean;
          type?: string;
        };
        [key: string]: unknown;
      };
    };
  };
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

describe('release workflow post-publish smoke-test job', () => {
  const workflowPath = fileURLToPath(
    new URL('../../../../.github/workflows/release.yml', import.meta.url),
  );
  const rawContent = readFileSync(workflowPath, 'utf8');
  const workflow = parse(rawContent) as WorkflowDocument;
  const getSmokeJob = (): WorkflowJob => {
    const job = workflow.jobs['smoke-test'];
    expect(job).toBeDefined();
    if (!job) {
      throw new Error('smoke-test job missing in release.yml');
    }
    return job;
  };

  it('defines workflow_dispatch input for test_version', () => {
    const inputs = workflow.on.workflow_dispatch?.inputs;
    expect(inputs).toBeDefined();
    expect(inputs?.test_version).toBeDefined();
    expect(inputs?.test_version?.required).toBe(false);
    expect(inputs?.test_version?.type).toBe('string');
  });

  it('configures smoke-test matrix job across ubuntu, macos, and windows', () => {
    const job = getSmokeJob();
    expect(job['runs-on']).toBe('${{ matrix.os }}');
    expect(job.strategy?.['fail-fast']).toBe(false);
    expect(job.strategy?.matrix?.os).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
  });

  it('enforces least privilege and timeout constraints on smoke-test', () => {
    const job = getSmokeJob();
    expect(job.permissions).toEqual({ contents: 'read' });
    expect(job['timeout-minutes']).toBe(15);
    expect(job.defaults?.run?.shell).toBe('bash');

    // Job must not leak secrets or tokens into environment
    for (const step of job.steps) {
      if (step.env) {
        for (const [key, val] of Object.entries(step.env)) {
          expect(key.toLowerCase()).not.toContain('token');
          expect(key.toLowerCase()).not.toContain('secret');
          expect(String(val)).not.toContain('secrets.');
        }
      }
    }
  });

  it('depends on publish and github-release or accepts manual test_version', () => {
    const job = getSmokeJob();
    expect(job.needs).toEqual(['publish', 'github-release']);
    expect(job.if).toBeDefined();
    expect(job.if).toContain('always()');
    expect(job.if).toContain('inputs.test_version');
    expect(job.if).toContain("needs.github-release.result == 'success'");
  });

  it('pins action dependencies to full 40-character commit SHAs', () => {
    const job = getSmokeJob();
    const usesSteps = job.steps.filter((s) => s.uses);
    expect(usesSteps.length).toBeGreaterThan(0);

    for (const step of usesSteps) {
      const uses = step.uses ?? '';
      const [action, ref] = uses.split('@');
      expect(action).toBeTruthy();
      expect(ref).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('performs npm retry installation and verifies version matching', () => {
    const job = getSmokeJob();
    const installStep = job.steps.find((s) => s.name === 'Install published package');
    expect(installStep).toBeDefined();
    expect(installStep?.run).toContain('npm install');
    expect(installStep?.run).toContain('12');
    expect(installStep?.run).toContain('@stroq/cli@$VERSION');

    const smokeChecksStep = job.steps.find((s) => s.name === 'Run post-publish smoke checks');
    expect(smokeChecksStep).toBeDefined();
    const runScript = smokeChecksStep?.run ?? '';

    // Isolated home directories
    expect(runScript).toContain('HOME="$EMPTY_DIR"');
    expect(runScript).toContain('USERPROFILE="$EMPTY_DIR"');
    expect(runScript).toContain('STROQ_HOME="$EMPTY_DIR"');

    // --version check
    expect(runScript).toContain('--version');
    expect(runScript).toContain('[ "$INSTALLED_VERSION" != "$VERSION" ]');

    // attack check with dynamic scenario extraction (no hard-coded scenario count)
    expect(runScript).toContain('attack');
    expect(runScript).toContain('0 passed through');
    expect(runScript).toContain('scenarios');
    expect(runScript).not.toMatch(/14 scenarios/);

    // doctor check
    expect(runScript).toContain('doctor');
    expect(runScript).toContain('stroq: $VERSION');

    // hook claude-code check
    expect(runScript).toContain('hook claude-code');
    expect(runScript).toContain('"permissionDecision":"deny"');
  });
});
