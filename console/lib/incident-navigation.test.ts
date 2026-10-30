import { describe, expect, it } from 'vitest';
import { incidentHref, incidentSelection } from './incident-navigation';
const id = `incident-${'a'.repeat(64)}`;
describe('local incident links', () => {
  it('retains a selected record and review filter through a canonical URL', () => {
    const href = incidentHref(id, 'reviewed');
    expect(href).toBe(`/incidents/?status=reviewed&id=${id}`);
    expect(incidentSelection(new URL(href, 'http://localhost').searchParams)).toEqual({
      filter: 'reviewed',
      id,
      invalid: false,
    });
  });
  it('does not reflect tokens, raw paths or arbitrary identifiers', () => {
    expect(incidentHref('/private/file?token=secret')).toBe('/incidents/');
    const params = new URLSearchParams('id=/private/file&status=unknown&token=secret');
    expect(incidentSelection(params)).toEqual({ filter: 'open', id: null, invalid: true });
    expect(incidentHref(null)).toBe('/incidents/');
  });
  it('distinguishes absent and malformed selections without turning them into other records', () => {
    expect(incidentSelection(new URLSearchParams())).toEqual({
      filter: 'open',
      id: null,
      invalid: false,
    });
    expect(incidentSelection(new URLSearchParams('id='))).toEqual({
      filter: 'open',
      id: null,
      invalid: true,
    });
    expect(incidentSelection(new URLSearchParams(`id=${id}&status=all`))).toEqual({
      filter: 'all',
      id,
      invalid: false,
    });
  });
});
