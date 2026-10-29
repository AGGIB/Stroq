import { describe, expect, it } from 'vitest';
import {
  protectionRunHref,
  protectionRunSelection,
  protectionRunReadAllowed,
  protectionStageTarget,
} from './protection-check-navigation';
const id = '11111111-1111-4111-8111-111111111111';
const workspace = `workspace-${'a'.repeat(24)}`;
describe('exact local check navigation', () => {
  it('keeps run, workspace and fixed stage together across reload', () => {
    const href = protectionRunHref(id, workspace, 'saved-policy-checks');
    expect(href).toContain('#protection-check-saved-policy-checks');
    const selection = protectionRunSelection(new URL(href, 'https://local.invalid').searchParams);
    expect(selection).toEqual({
      requested: true,
      invalid: false,
      runId: id,
      workspaceId: workspace,
    });
    expect(protectionRunReadAllowed(selection, workspace)).toBe(true);
    expect(protectionRunReadAllowed(selection, `workspace-${'b'.repeat(24)}`)).toBe(false);
  });
  it('refuses incomplete, duplicated and malformed selectors instead of choosing another report', () => {
    for (const query of [
      `run=${id}`,
      `workspace=${workspace}`,
      `run=${id}&run=${id}&workspace=${workspace}`,
      `run=private&workspace=${workspace}`,
      `run=${id}&workspace=../private`,
    ]) {
      const selected = protectionRunSelection(new URLSearchParams(query));
      expect(selected.invalid).toBe(true);
      expect(protectionRunReadAllowed(selected, workspace)).toBe(false);
    }
    expect(protectionRunReadAllowed(protectionRunSelection(new URLSearchParams()), workspace)).toBe(
      true,
    );
    expect(protectionRunHref('../private', workspace)).toBe('/protection/');
  });
  it('only expands and focuses fixed evidence stage targets', () => {
    expect(protectionStageTarget('#protection-check-workspace-review')).toBe(
      'protection-check-workspace-review',
    );
    for (const hash of [
      '#private',
      '#protection-check-unknown',
      '#protection-check-workspace-review?path=private',
    ])
      expect(protectionStageTarget(hash)).toBeNull();
  });
});
