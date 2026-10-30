import { describe, expect, it } from 'vitest';
import {
  workspaceReviewHref,
  workspaceReviewSelection,
  workspaceReviewReadAllowed,
} from './workspace-review-navigation';
const ws = `workspace-${'a'.repeat(24)}`,
  run = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('workspace capture selection', () => {
  it('round trips an exact report without any execution or source parameters', () => {
    const href = workspaceReviewHref(run, ws);
    expect(href).toBe(`/protection/workspace/?workspace=${ws}&run=${run}`);
    const selected = workspaceReviewSelection(new URL(href, 'http://local.test').searchParams);
    expect(selected).toEqual({ requested: true, invalid: false, workspaceId: ws, runId: run });
    expect(workspaceReviewReadAllowed(selected, ws)).toBe(true);
    expect(workspaceReviewReadAllowed(selected, `workspace-${'b'.repeat(24)}`)).toBe(false);
  });
  it('rejects partial, duplicate, empty and malformed selection rather than choosing a newer report', () => {
    for (const query of [
      `run=${run}`,
      `workspace=${ws}`,
      `run=${run}&workspace=${ws}&run=${run}`,
      `run=${run}&workspace=${ws}&workspace=${ws}`,
      `run=&workspace=${ws}`,
      `run=private-command&workspace=${ws}`,
      `run=${run}&workspace=/private/project`,
    ]) {
      const selected = workspaceReviewSelection(new URLSearchParams(query));
      expect(selected.invalid).toBe(true);
      expect(selected.runId).toBeNull();
      expect(workspaceReviewReadAllowed(selected, ws)).toBe(false);
    }
  });
  it('permits an unselected overview and makes invalid generated links explicit overviews', () => {
    expect(workspaceReviewSelection(new URLSearchParams())).toEqual({
      requested: false,
      invalid: false,
      workspaceId: null,
      runId: null,
    });
    expect(workspaceReviewReadAllowed(workspaceReviewSelection(new URLSearchParams()), ws)).toBe(
      true,
    );
    expect(workspaceReviewReadAllowed(workspaceReviewSelection(new URLSearchParams()), null)).toBe(
      false,
    );
    expect(workspaceReviewHref(run, 'bad')).toBe('/protection/workspace/');
  });
});
