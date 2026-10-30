import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_FILTER_TARGETS,
  CREDENTIAL_FILTER_LIMITATIONS,
  validateCredentialFilters,
  type CredentialFilterRow,
  type CredentialFilterTarget,
  type CredentialFiltersState,
} from './credential-filters';
import { credentialFilterRows } from './credential-filter-queue';

const workspaceId = 'workspace-' + 'a'.repeat(24);
const otherWorkspaceId = 'workspace-' + 'b'.repeat(24);
const generatedAt = '2026-10-23T12:00:00.000Z';
const ids = Object.keys(CREDENTIAL_FILTER_TARGETS) as CredentialFilterTarget[];
function row(
  id: CredentialFilterTarget,
  changes: Partial<CredentialFilterRow> = {},
): CredentialFilterRow {
  return {
    id,
    ...CREDENTIAL_FILTER_TARGETS[id],
    location: id === 'claude-user' ? 'user' : 'workspace',
    context: id === 'claude-user' ? 'all-workspaces' : 'workspace',
    status: 'absent',
    exists: false,
    sourceSha256: null,
    bytes: 0,
    present: 0,
    managed: 0,
    unmanaged: 0,
    applications: 0,
    undoAvailable: false,
    reason: null,
    ...changes,
  };
}
function state(
  rows: CredentialFilterRow[] = ids.map((id) => row(id)),
  changes: Partial<CredentialFiltersState> = {},
): CredentialFiltersState {
  return {
    schema: 'stroq-credential-filters/1',
    source: 'local',
    workspaceId,
    generatedAt,
    available: true,
    reason: null,
    targets: rows,
    limitations: CREDENTIAL_FILTER_LIMITATIONS,
    ...changes,
  };
}
function recorded(id: CredentialFilterTarget, changes: Partial<CredentialFilterRow> = {}) {
  const required = CREDENTIAL_FILTER_TARGETS[id].required;
  return row(id, {
    status: 'configured',
    exists: true,
    sourceSha256: 'c'.repeat(64),
    bytes: 512,
    present: required,
    managed: required,
    applications: 1,
    undoAvailable: true,
    ...changes,
  });
}

describe('credential file-filter attention rows', () => {
  it('keeps optional absent and partial sources quiet without recorded applications', () => {
    expect(credentialFilterRows(state(), workspaceId)).toEqual([]);
    const partial = row('claude-project', {
      status: 'partial',
      exists: true,
      sourceSha256: 'c'.repeat(64),
      bytes: 512,
      present: 2,
      unmanaged: 2,
    });
    expect(
      credentialFilterRows(
        state([partial, row('claude-user'), row('cursor-project')]),
        workspaceId,
      ),
    ).toEqual([]);
  });

  it('does not turn configured user-owned or recorded rules into a live protection finding', () => {
    const configured = ids.map((id) => recorded(id));
    expect(credentialFilterRows(state(configured), workspaceId)).toEqual([]);
    const preexisting = configured.map((value) => ({
      ...value,
      managed: 0,
      unmanaged: value.required,
      applications: 0,
      undoAvailable: false,
    }));
    expect(validateCredentialFilters(state(preexisting))).toBe(true);
    expect(credentialFilterRows(state(preexisting), workspaceId)).toEqual([]);
  });

  it('shows incomplete retained recipes with exact counts, scope and target links', () => {
    const source = state([
      recorded('claude-project', { status: 'partial', present: 12, managed: 12 }),
      row('claude-user'),
      row('cursor-project'),
    ]);
    expect(validateCredentialFilters(source)).toBe(true);
    const rows = credentialFilterRows(source, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'credential-filter-claude-project',
      tone: 'orange',
      action: 'Review filters',
      href: `/agents/?workspace=${workspaceId}&filter=claude-project#claude-code`,
    });
    expect(rows[0]?.title).toContain('Claude Code');
    expect(rows[0]?.title).toContain('Workspace');
    expect(rows[0]?.title).toContain('incomplete');
    expect(rows[0]?.detail).toContain('12/13');
    expect(rows[0]?.detail).toContain(generatedAt);
    expect(rows[0]?.detail).toContain('Configuration');
    expect(rows[0]?.title).not.toMatch(/exposed|protected|removed|blocked/i);
  });

  it('retained intent with no remaining managed rule is still incomplete, not a proven prior apply', () => {
    const source = state([
      row('claude-project'),
      row('claude-user'),
      recorded('cursor-project', {
        status: 'absent',
        exists: false,
        sourceSha256: null,
        bytes: 0,
        present: 0,
        managed: 0,
        applications: 2,
      }),
    ]);
    expect(validateCredentialFilters(source)).toBe(true);
    const [result] = credentialFilterRows(source, workspaceId);
    expect(result?.title).toContain('incomplete');
    expect(result?.title).toContain('Cursor');
    expect(result?.detail).toContain('0/2');
    expect(result?.detail).toContain('2 recorded');
    expect(result?.title).not.toMatch(/removed|changed since|after apply/i);
  });

  it('known applications with only user-owned remaining rules do not lose attention', () => {
    const source = state([
      recorded('claude-project', {
        status: 'partial',
        present: 3,
        managed: 0,
        unmanaged: 3,
        applications: 2,
      }),
      row('claude-user'),
      row('cursor-project'),
    ]);
    expect(validateCredentialFilters(source)).toBe(true);
    expect(credentialFilterRows(source, workspaceId)).toHaveLength(1);
  });

  it('unknown source or ownership is an evidence gap and never claimed as missing rules', () => {
    for (const reason of [
      'credential-filter-storage-unavailable',
      'credential-filter-mixed-history',
      'credential-filter-source-invalid',
      'credential-filter-edited-block',
    ] as const) {
      const unavailable = row('cursor-project', {
        status: 'unavailable',
        managed: null,
        unmanaged: null,
        applications: null,
        reason,
      });
      const source = state([row('claude-project'), row('claude-user'), unavailable]);
      expect(validateCredentialFilters(source)).toBe(true);
      const [result] = credentialFilterRows(source, workspaceId);
      expect(result?.title).toContain('unverified');
      expect(result?.tone).toBe('orange');
      expect(result?.detail).not.toContain('0/2');
      expect(result?.title).not.toMatch(/missing|removed|exposure/i);
    }
    const unknownOwnership = row('claude-project', {
      status: 'configured',
      exists: true,
      sourceSha256: 'c'.repeat(64),
      bytes: 512,
      present: 13,
      managed: null,
      unmanaged: null,
      applications: null,
      reason: 'credential-filter-storage-unavailable',
    });
    expect(
      credentialFilterRows(
        state([unknownOwnership, row('claude-user'), row('cursor-project')]),
        workspaceId,
      )[0]?.title,
    ).toContain('unverified');
  });

  it('keeps user-wide and repository scope explicit in a fresh current-workspace envelope', () => {
    const user = recorded('claude-user', { status: 'partial', present: 12, managed: 12 });
    const source = state([row('claude-project'), user, row('cursor-project')], {
      workspaceId: otherWorkspaceId,
    });
    const [result] = credentialFilterRows(source, otherWorkspaceId);
    expect(result?.title).toContain('User');
    expect(result?.title).toContain('all workspaces');
    expect(result?.href).toBe(
      `/agents/?workspace=${otherWorkspaceId}&filter=claude-user#claude-code`,
    );
    const main = recorded('claude-project', {
      context: 'repository',
      location: 'main-checkout',
      status: 'partial',
      present: 12,
      managed: 12,
    });
    expect(
      credentialFilterRows(state([main, row('claude-user'), row('cursor-project')]), workspaceId)[0]
        ?.title,
    ).toContain('main checkout');
  });

  it('null or foreign snapshots return one gap without reading foreign targets', () => {
    expect(credentialFilterRows(null, workspaceId)).toHaveLength(1);
    const foreign = state([], { workspaceId: otherWorkspaceId });
    Object.defineProperty(foreign, 'targets', {
      get() {
        throw new Error('Foreign targets must not be inspected');
      },
    });
    const rows = credentialFilterRows(foreign, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tone).toBe('orange');
    expect(rows[0]?.href).toBe('/agents/');
    expect(credentialFilterRows(state(), null)).toHaveLength(1);
  });

  it('global unavailable state produces one availability row, not current per-target claims', () => {
    const unavailable = state([], {
      available: false,
      reason: 'credential-filter-engine-unavailable',
    });
    Object.defineProperty(unavailable, 'targets', {
      get() {
        throw new Error('Unavailable targets must not be projected');
      },
    });
    expect(credentialFilterRows(unavailable, workspaceId)).toHaveLength(1);
    expect(credentialFilterRows(unavailable, workspaceId)[0]?.title).toContain('unavailable');
  });

  it('keys and links are stable across checks and the source remains unchanged', () => {
    const cursor = recorded('cursor-project', { status: 'partial', present: 1, managed: 1 });
    const source = state([row('claude-project'), row('claude-user'), cursor]),
      before = JSON.stringify(source);
    const [first] = credentialFilterRows(source, workspaceId);
    const [next] = credentialFilterRows(
      {
        ...source,
        generatedAt: '2026-10-23T13:00:00.000Z',
        targets: source.targets.map((value) => ({
          ...value,
          sourceSha256: value.exists ? 'd'.repeat(64) : null,
        })),
      },
      workspaceId,
    );
    expect(first?.key).toBe(next?.key);
    expect(first?.href).toBe(next?.href);
    expect(JSON.stringify(source)).toBe(before);
  });
});
