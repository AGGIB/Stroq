import { describe, it, expect } from 'vitest';
import { validateInventory, validateInventoryItem } from './inventory';
const item = {
  id: `item-${'a'.repeat(24)}`,
  kind: 'skill',
  name: 'Workspace helper',
  agent: 'claude-code',
  scope: 'project',
  fileType: 'skill-tree',
  sha256: 'a'.repeat(64),
  reviewedSha256: null,
  state: 'unreviewed',
  scan: { status: 'clean', findings: 0 },
  capabilities: [],
};
const state = {
  schema: 'stroq-inventory/1',
  source: 'local',
  generatedAt: '2026-10-23T01:02:03.000Z',
  workspace: { id: `workspace-${'b'.repeat(24)}`, label: 'surface' },
  baseline: { status: 'missing', reviewedAt: null },
  items: [item],
  gaps: [],
  limitations: ['Static analysis only.'],
};
describe('installed inventory evidence', () => {
  it('accepts explicit shared and Codex skill origins and rejects counterfeit source bindings', () => {
    const shared = {
      ...item,
      agent: 'shared',
      skillSource: 'agents-skills',
      quarantineSupported: false,
    };
    expect(
      validateInventory({
        ...state,
        items: [shared],
        skillSources: [
          { id: 'agents-skills', scope: 'project', status: 'complete', candidates: 1 },
        ],
      }),
    ).toBe(true);
    expect(
      validateInventory({
        ...state,
        items: [{ ...shared, agent: 'codex', skillSource: 'codex-skills' }],
      }),
    ).toBe(true);
    for (const invalid of [
      { ...shared, agent: 'claude-code' },
      { ...shared, skillSource: undefined },
      { ...shared, quarantineSupported: true },
    ])
      expect(validateInventory({ ...state, items: [invalid] })).toBe(false);
    expect(
      validateInventory({
        ...state,
        skillSources: [
          { id: 'agents-skills', scope: 'project', status: 'complete', candidates: 1 },
          { id: 'agents-skills', scope: 'project', status: 'complete', candidates: 1 },
        ],
      }),
    ).toBe(false);
  });
  it('accepts bounded observations with explicit missing baseline', () => {
    expect(validateInventory(state)).toBe(true);
  });
  it('does not accept unknown trust claims or raw configuration', () => {
    expect(validateInventory({ ...state, items: [{ ...item, trusted: true }] })).toBe(false);
    expect(
      validateInventory({
        ...state,
        items: [
          {
            ...item,
            mcp: {
              transport: 'stdio',
              wrapper: 'configured',
              strict: true,
              env: { TOKEN: 'secret' },
            },
          },
        ],
      }),
    ).toBe(false);
  });
  it('rejects duplicate ids and an unchanged state without matching reviewed digest', () => {
    expect(validateInventory({ ...state, items: [item, item] })).toBe(false);
    expect(validateInventory({ ...state, items: [{ ...item, state: 'unchanged' }] })).toBe(false);
    expect(
      validateInventory({
        ...state,
        items: [{ ...item, state: 'unchanged', reviewedSha256: item.sha256 }],
      }),
    ).toBe(true);
  });
  it('distinguishes disappeared items and incomplete reads from unchanged', () => {
    expect(
      validateInventory({
        ...state,
        items: [
          {
            ...item,
            state: 'missing',
            sha256: null,
            reviewedSha256: item.sha256,
            scan: { status: 'not-scanned', findings: 0 },
          },
        ],
      }),
    ).toBe(true);
    expect(
      validateInventory({
        ...state,
        items: [{ ...item, state: 'unchanged', sha256: null, reviewedSha256: null }],
      }),
    ).toBe(false);
  });
});

it('validates explicit source-qualified recovery capability and safe display location', () => {
  const base = {
    id: `item-${'a'.repeat(24)}`,
    kind: 'skill',
    name: 'notes',
    agent: 'cursor',
    skillSource: 'cursor-skills',
    scope: 'project',
    fileType: 'skill-tree',
    sha256: 'b'.repeat(64),
    reviewedSha256: null,
    state: 'unreviewed',
    scan: { status: 'clean', findings: 0 },
    capabilities: [],
    location: { label: 'release/notes', redacted: false },
    quarantineSupported: true,
    quarantineReason: 'supported',
  };
  expect(validateInventoryItem(base)).toBe(true);
  for (const patch of [
    { quarantineSupported: false },
    { quarantineReason: 'overlapping-skill' },
    { location: { label: '.', redacted: false } },
    { location: { label: '../private', redacted: false } },
    { location: { label: 'release/PRIVATE_TOKEN', redacted: false } },
    { quarantineReason: 'native-blocking' },
  ])
    expect(validateInventoryItem({ ...base, ...patch })).toBe(false);
  for (const reason of [
    'source-root',
    'overlapping-skill',
    'managed-source',
    'unsafe-location',
    'incomplete',
  ])
    expect(
      validateInventoryItem({ ...base, quarantineSupported: false, quarantineReason: reason }),
    ).toBe(true);
  expect(
    validateInventoryItem({ ...base, location: { label: 'Folder name withheld', redacted: true } }),
  ).toBe(true);
});
