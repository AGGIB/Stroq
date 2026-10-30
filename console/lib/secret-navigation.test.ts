import { describe, expect, it } from 'vitest';
import {
  resolveSecretSelection,
  secretContextMatches,
  secretHref,
  secretSelection,
} from './secret-navigation';

const workspace = `workspace-${'a'.repeat(24)}`;
const otherWorkspace = `workspace-${'b'.repeat(24)}`;
const first = { id: '11111111-1111-4111-8111-111111111111', startedAt: '2026-10-23T10:00:00.000Z' };
const latest = {
  id: '22222222-2222-4222-8222-222222222222',
  startedAt: '2026-10-23T11:00:00.000Z',
};
const missing = '33333333-3333-4333-8333-333333333333';
const parse = (query = '') => secretSelection(new URLSearchParams(query));

describe('exact credential report navigation', () => {
  it('round trips one report bound to its workspace', () => {
    const href = secretHref(first.id, workspace);
    expect(href).toBe(`/keys/?workspace=${workspace}&job=${first.id}`);
    expect(secretSelection(new URL(href, 'http://localhost').searchParams)).toEqual({
      jobId: first.id,
      workspaceId: workspace,
      requested: true,
      invalid: false,
    });
  });

  it('rejects incomplete, duplicate and unsafe selections instead of falling back', () => {
    for (const query of [
      `job=${first.id}`,
      `workspace=${workspace}`,
      'job=',
      `job=/private/key&workspace=${workspace}`,
      `job=${first.id}&workspace=private-token`,
      `job=${first.id}&job=${latest.id}&workspace=${workspace}`,
      `job=${first.id}&workspace=${workspace}&workspace=${otherWorkspace}`,
    ]) {
      const selection = parse(query);
      expect(selection.invalid).toBe(true);
      expect(secretContextMatches(selection, workspace)).toBe(false);
      expect(resolveSecretSelection(selection, workspace, [latest]).status).toBe('invalid');
      expect(resolveSecretSelection(selection, workspace, [latest]).job).toBeNull();
    }
  });

  it('never substitutes another report when the exact report is missing or evicted', () => {
    const selection = parse(`job=${missing}&workspace=${workspace}`);
    expect(resolveSecretSelection(selection, workspace, [latest])).toEqual({
      status: 'missing',
      job: null,
    });
    expect(resolveSecretSelection(selection, workspace, [])).toEqual({
      status: 'missing',
      job: null,
    });
    expect(resolveSecretSelection(selection, workspace, null)).toEqual({
      status: 'loading',
      job: null,
    });
  });

  it('blocks reads and selection before context is known or for another workspace', () => {
    const selection = parse(`job=${first.id}&workspace=${otherWorkspace}`);
    expect(secretContextMatches(selection, workspace)).toBe(false);
    expect(secretContextMatches(selection, null)).toBe(false);
    expect(resolveSecretSelection(selection, workspace, [first, latest])).toEqual({
      status: 'workspace-mismatch',
      job: null,
    });
    expect(resolveSecretSelection(selection, null, [first, latest])).toEqual({
      status: 'context-pending',
      job: null,
    });
  });

  it('keeps an exact older report selected and defaults to newest only without a request', () => {
    const selection = parse(`job=${first.id}&workspace=${workspace}`);
    expect(resolveSecretSelection(selection, workspace, [first, latest])).toEqual({
      status: 'selected',
      job: first,
    });
    expect(resolveSecretSelection(parse(), workspace, [first, latest])).toEqual({
      status: 'selected',
      job: latest,
    });
    expect(resolveSecretSelection(parse(), workspace, [])).toEqual({ status: 'empty', job: null });
    expect(secretContextMatches(parse(), workspace)).toBe(true);
  });

  it('canonical links exclude auth, fragments, arbitrary queries and source names', () => {
    const selection = parse(
      `workspace=${workspace}&job=${first.id}&token=private&q=credential-name`,
    );
    expect(secretHref(selection.jobId, selection.workspaceId)).toBe(
      `/keys/?workspace=${workspace}&job=${first.id}`,
    );
    expect(secretHref('/private?token=secret', workspace)).toBe('/keys/');
    expect(secretHref(first.id, null)).toBe('/keys/');
    expect(parse('token=private&q=credential-name')).toEqual({
      jobId: null,
      workspaceId: null,
      requested: false,
      invalid: false,
    });
  });
});
