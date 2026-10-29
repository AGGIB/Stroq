import type { PolicyEffect } from '@/lib/policy-control';

const EFFECTS: Record<PolicyEffect, string> = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };
export function PolicyCaseScenarios({
  scenarios,
}: {
  scenarios: readonly {
    taint: 'none' | 'suspect';
    expected: PolicyEffect;
    actual?: PolicyEffect;
  }[];
}) {
  return (
    <div className="policy-case-scenarios">
      {scenarios.map((scenario) => (
        <div key={scenario.taint}>
          <strong>{scenario.taint === 'none' ? 'No session taint' : 'Suspect session'}</strong>
          <span>
            Expected <b>{EFFECTS[scenario.expected]}</b>
            {scenario.actual !== undefined && (
              <>
                {' '}
                · Current{' '}
                <b
                  className={
                    scenario.actual !== scenario.expected ? 'policy-case-mismatch' : undefined
                  }
                >
                  {EFFECTS[scenario.actual]}
                </b>
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
