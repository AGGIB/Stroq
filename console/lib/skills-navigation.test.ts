import { describe, expect, it } from 'vitest';
import { SKILLS_PARTS, partParams, skillsPart, skillsPartHref } from './skills-navigation';

const query = (text: string) => new URLSearchParams(text);

describe('the parts of Skills & MCP', () => {
  it('names a part from the address, and the list when none is named', () => {
    for (const part of SKILLS_PARTS) expect(skillsPart(query(`part=${part}`))).toBe(part);
    expect(skillsPart(query(''))).toBeNull();
    expect(skillsPart(query('part=settings'))).toBeNull();
    expect(skillsPart(query('part=__proto__'))).toBeNull();
  });

  it('gives a part its own values only when the address names that part', () => {
    const address = query(
      'part=quarantine&record=11111111-2222-4333-8444-555555555555&view=attention',
    );
    expect(partParams(address, 'quarantine').get('record')).toBe(
      '11111111-2222-4333-8444-555555555555',
    );
    expect(partParams(address, 'quarantine').has('view')).toBe(true);
    expect(partParams(address, 'registrations').get('record')).toBeNull();
    expect(partParams(address, 'registrations').has('view')).toBe(false);
    expect(partParams(address, 'tools').getAll('record')).toEqual([]);
    expect(partParams(query('record=x'), 'quarantine').get('record')).toBeNull();
  });

  it('writes the address of a part with the values it carries, the part first', () => {
    expect(skillsPartHref('tools')).toBe('/skills/?part=tools');
    expect(skillsPartHref('quarantine', query('workspace=w&record=r'))).toBe(
      '/skills/?part=quarantine&workspace=w&record=r',
    );
  });
});
