/**
 * The parts of the Skills & MCP screen. The list of skills and servers is the screen; the rest are
 * sections under it, each with deep-link values of its own (a recorded change, a tool version) that
 * share names with the others (`record`, `workspace`, `view`). The address names the part those
 * values belong to (`?part=quarantine&record=…`), so one section reads them and the others read
 * nothing, and several sections can be open at once without taking each other's links.
 */
export const SKILLS_PARTS = ['quarantine', 'registrations', 'tools', 'check'] as const;
export type SkillsPart = (typeof SKILLS_PARTS)[number];

type Params = Pick<URLSearchParams, 'get' | 'getAll' | 'has'>;

/** The part an address names, or null for the list. */
export function skillsPart(params: Pick<URLSearchParams, 'get'>): SkillsPart | null {
  const named = params.get('part');
  return SKILLS_PARTS.find((part) => part === named) ?? null;
}

/** An address with nothing in it, as a plain object so that no browser global is needed to read it. */
const NOTHING: Params = { get: () => null, getAll: () => [], has: () => false };

/** The values of an address as one part sees them: its own when the address names it, none otherwise. */
export function partParams(params: Params, part: SkillsPart): Params {
  return skillsPart(params) === part ? params : NOTHING;
}

/** The address of a part of the screen, carrying the deep-link values the part gave. */
export function skillsPartHref(part: SkillsPart, params?: URLSearchParams): string {
  const next = new URLSearchParams({ part });
  params?.forEach((value, key) => next.set(key, value));
  return `/skills/?${next}`;
}
