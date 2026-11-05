import { describe, expect, it } from 'vitest';
import { referenceQuery, rulesReferenceHref } from './rules-navigation';

describe('the Rules reference address', () => {
  it('searches the reference for a rule id, and for nothing else', () => {
    expect(rulesReferenceHref('deny-encoded-exec')).toBe(
      '/policies/?find=deny-encoded-exec#reference',
    );
    expect(rulesReferenceHref('STROQ-0042')).toBe('/policies/?find=STROQ-0042#reference');
    expect(rulesReferenceHref(null)).toBe('/policies/#reference');
    expect(rulesReferenceHref()).toBe('/policies/#reference');
    expect(rulesReferenceHref('a b; rm -rf')).toBe('/policies/#reference');
    expect(rulesReferenceHref('../x')).toBe('/policies/#reference');
  });

  it('reads back a short plain search and drops anything else', () => {
    expect(referenceQuery('deny-secret-egress')).toBe('deny-secret-egress');
    expect(referenceQuery('two words')).toBe('two words');
    expect(referenceQuery(null)).toBe('');
    expect(referenceQuery('x'.repeat(121))).toBe('');
    expect(referenceQuery('bad\u001bescape')).toBe('');
  });
});
