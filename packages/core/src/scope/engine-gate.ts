import { isTaskId, type ScopeGate, type ScopeGateInput, type ScopeVerdict } from './types.js';

/** A broken gate is a refusal even when supplied by a caller other than createScopeGate. */
export async function evaluateScope(
  gate: ScopeGate | undefined,
  input: ScopeGateInput,
): Promise<ScopeVerdict | null> {
  if (gate === undefined) return null;
  try {
    return await gate.evaluate(input);
  } catch {
    let taskId = 'invalid';
    try {
      const active = gate.activeTask();
      if (isTaskId(active)) taskId = active;
    } catch {
      // Even the task identity is unavailable. Do not let that suppress the denial.
    }
    return {
      taskId,
      decision: {
        effect: 'deny',
        ruleId: 'task-void:exception',
        reason: 'The task gate could not validate this call, so it is refused.',
      },
      evidence: { ruleId: 'task-void:exception', kind: 'void' },
    };
  }
}
