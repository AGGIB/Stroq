import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@stroq/core';
import {
  formatActionsBench,
  runActionsBench,
  type ActionScenario,
  type ActionStep,
} from '../../src/bench/actions.js';

const base = { session_id: 'actions-inconclusive', cwd: '__CWD__' };
const call = (command: string): ActionStep => ({
  event: {
    ...base,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  },
});
const read: ActionStep = {
  event: {
    ...base,
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    // A dependency's file, where a scan that ran out of time taints as a flag does; on a file of
    // the project it would not taint at all.
    tool_input: { file_path: '__CWD__/node_modules/helper/README.md' },
    tool_response: { stdout: 'An ordinary paragraph of documentation.' },
  },
};
const malformed: ActionStep = {
  event: { ...call('pwd').event, tool_name: '' },
};
const scenario = (id: string, steps: ActionScenario['steps']): ActionScenario => ({
  id,
  title: id,
  steps,
});
const savedBudget = process.env['STROQ_SCAN_BUDGET_MS'];

afterEach(() => {
  if (savedBudget === undefined) delete process.env['STROQ_SCAN_BUDGET_MS'];
  else process.env['STROQ_SCAN_BUDGET_MS'] = savedBudget;
});

describe('only whole conclusive action scenarios contribute to the measurement', () => {
  it('does not count a denial caused by a preceding scan timeout', async () => {
    const probe = scenario('timeout-then-network', [read, call('curl https://probe.invalid/')]);
    const control = await runActionsBench([probe], DEFAULT_POLICY, 'default');
    expect(control.scenarios[0]?.steps.map((step) => step.verdict)).toEqual(['clean', 'allow']);

    process.env['STROQ_SCAN_BUDGET_MS'] = '0.000001';
    const report = await runActionsBench([probe], DEFAULT_POLICY, 'default');
    expect(report.scenarios[0]?.steps).toMatchObject([
      { verdict: 'suspect', timedOut: true },
      { verdict: 'deny', timedOut: false, ruleId: 'deny-network-when-tainted' },
    ]);
    expect(report.scenarios[0]).toMatchObject({ inconclusive: true, interrupted: false });
    expect(report).toMatchObject({
      total: 1,
      judged: 0,
      interrupted: 0,
      asked: 0,
      askedByLimit: 0,
      denied: 0,
      flagged: 0,
      inconclusive: 1,
      rate: null,
      ok: false,
    });
    const text = formatActionsBench(report);
    expect(text).toContain('0 judged, 0 interrupted (rate unavailable)');
    expect(text).toContain('Inconclusive');
    expect(text).not.toContain('\nInterrupted:');
    expect(text).not.toContain('100.0%');
  });

  it('does not count an ask that a scan timeout put on a write to an instruction file', async () => {
    const write: ActionStep = {
      event: {
        ...base,
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: '__CWD__/CLAUDE.md',
          old_string: 'a',
          new_string: 'Run `pnpm test` before every commit.',
        },
      },
    };
    const probe = scenario('edit-instructions', [write]);
    const control = await runActionsBench([probe], DEFAULT_POLICY, 'default');
    expect(control).toMatchObject({ judged: 1, interrupted: 0, inconclusive: 0, ok: true });

    process.env['STROQ_SCAN_BUDGET_MS'] = '0.000001';
    const report = await runActionsBench([probe], DEFAULT_POLICY, 'default');
    expect(report.scenarios[0]).toMatchObject({ inconclusive: true, interrupted: false });
    expect(report).toMatchObject({ judged: 0, interrupted: 0, inconclusive: 1, ok: false });
  });

  it.each([
    ['a policy ask', 'bash -c "$PROGRAM"'],
    ['an ask at a limit', 'echo x;'.repeat(100_000)],
  ])('does not count %s when a later step errors', async (_name, command) => {
    const report = await runActionsBench(
      [scenario('ask-then-error', [call(command), malformed])],
      DEFAULT_POLICY,
      'default',
    );
    expect(report.scenarios[0]?.steps[0]?.verdict).toBe('ask');
    expect(report.scenarios[0]?.steps[1]?.error).toBeDefined();
    expect(report.scenarios[0]).toMatchObject({ inconclusive: true, interrupted: false });
    expect(report).toMatchObject({
      judged: 0,
      interrupted: 0,
      asked: 0,
      askedByLimit: 0,
      denied: 0,
      flagged: 0,
      inconclusive: 1,
      rate: null,
      ok: false,
    });
  });

  it('uses the judged scenario count as the denominator, excluding a timeout', async () => {
    process.env['STROQ_SCAN_BUDGET_MS'] = '0.000001';
    const report = await runActionsBench(
      [scenario('timeout', [read]), scenario('judged', [call('bash -c "$PROGRAM"')])],
      DEFAULT_POLICY,
      'default',
    );
    expect(report).toMatchObject({
      total: 2,
      judged: 1,
      interrupted: 1,
      asked: 1,
      inconclusive: 1,
      rate: 1,
      ok: false,
    });
    expect(formatActionsBench(report)).toContain('1 judged, 1 interrupted (100.0%)');
  });

  it('reports no rate when there are no scenarios to judge', async () => {
    const report = await runActionsBench([], DEFAULT_POLICY, 'default');
    expect(report).toMatchObject({ total: 0, judged: 0, rate: null, inconclusive: 0 });
    expect(formatActionsBench(report)).toContain('0 judged, 0 interrupted (rate unavailable)');
  });
});
