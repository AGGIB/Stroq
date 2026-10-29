import { describe, expect, it } from 'vitest';
import {
  policyEventHref,
  policyEventReturnHref,
  policyReadAllowed,
  policySelection,
} from './policy-navigation';

const workspace = 'workspace-' + 'a'.repeat(24);
const other = 'workspace-' + 'b'.repeat(24);
const incident = 'incident-' + 'c'.repeat(64);
const read = (query: string) => policySelection(new URLSearchParams(query));

describe('recorded-event policy navigation', () => {
  it('round-trips the exact event and canonical workspace without carrying policy actions', () => {
    const href = policyEventHref(incident, workspace);
    expect(href).toBe(`/policies/?workspace=${workspace}&incident=${incident}`);
    expect(read(href.split('?')[1]!)).toEqual({
      requested: true,
      invalid: false,
      incidentId: incident,
      workspaceId: workspace,
    });
  });

  it('keeps ordinary Policies independent from a previously selected event', () => {
    expect(read('')).toEqual({
      requested: false,
      invalid: false,
      incidentId: null,
      workspaceId: null,
    });
    expect(policyReadAllowed(read(''), workspace)).toBe(true);
    expect(policyEventReturnHref(read(''))).toBe('/incidents/?status=all');
  });

  it('rejects incomplete, duplicated and malformed event selections', () => {
    for (const query of [
      'incident=',
      `incident=${incident}`,
      `workspace=${workspace}`,
      `workspace=${workspace}&incident=incident-${'c'.repeat(63)}`,
      `workspace=/Users/private&incident=${incident}`,
      `workspace=${workspace}&incident=${incident}&incident=${incident}`,
      `workspace=${workspace}&workspace=${other}&incident=${incident}`,
    ]) {
      const location = read(query);
      expect(location.invalid, query).toBe(true);
      expect(location.incidentId, query).toBeNull();
      expect(policyReadAllowed(location, workspace), query).toBe(false);
    }
  });

  it('blocks the event draft and reads while context is pending or points elsewhere', () => {
    const location = read(`workspace=${workspace}&incident=${incident}`);
    expect(policyReadAllowed(location, null)).toBe(false);
    expect(policyReadAllowed(location, other)).toBe(false);
    expect(policyReadAllowed(location, workspace)).toBe(true);
    expect(policyReadAllowed(read(''), null)).toBe(false);
    expect(policyReadAllowed(read(''), '/Users/private')).toBe(false);
  });

  it('returns to the exact event in All findings, including after manual review', () => {
    const location = read(`workspace=${workspace}&incident=${incident}`);
    expect(policyEventReturnHref(location)).toBe(`/incidents/?status=all&id=${incident}`);
  });

  it('does not accept policy classes, source text, paths or automatic actions from a URL', () => {
    const location = read(
      `workspace=${workspace}&incident=${incident}&classes=secret.egress&raw=private&apply=true`,
    );
    expect(policyEventHref(location.incidentId, location.workspaceId)).toBe(
      `/policies/?workspace=${workspace}&incident=${incident}`,
    );
    expect(Object.keys(location).sort()).toEqual([
      'incidentId',
      'invalid',
      'requested',
      'workspaceId',
    ]);
    expect(policyEventHref(incident, '/Users/private')).toBe('/policies/');
    expect(policyEventHref('../private', workspace)).toBe('/policies/');
    expect(policyEventHref(null, workspace)).toBe('/policies/');
  });
});
