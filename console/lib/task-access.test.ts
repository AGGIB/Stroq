import { describe, expect, it } from 'vitest';
import {
  TASK_ACCESS_ERROR_MESSAGES,
  TASK_ACCESS_LIMITATIONS,
  validateTaskAccessPreview,
  validateTaskAccessReceipt,
  validateTaskAccessState,
} from './task-access';
const sha = 'a'.repeat(64),
  ws = `workspace-${'b'.repeat(24)}`,
  at = '2026-10-24T00:00:00.000Z',
  id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const task = () => ({
  id: `task-${sha}`,
  permitSha256: sha,
  profile: 'code',
  policySha256: sha,
  issuedAt: '2026-10-23T23:00:00.000Z',
  expiresAt: '2026-10-24T01:00:00.000Z',
  declaredMode: 'hook-only',
  eligibility: 'eligible',
  standing: 'present',
  policyRelation: 'matches-current',
  scope: {
    tools: ['Read'],
    shell: 'denied',
    read: { allow: [], deny: [] },
    write: { allow: [], deny: [] },
    net: { mode: 'none' },
    mcp: [],
  },
  evidence: {
    status: 'verified',
    journalSha256: sha,
    counts: {
      calls: 1,
      allowed: 0,
      denied: 1,
      asks: 0,
      hostReported: 0,
      hostFailure: 0,
      unconfirmed: 1,
    },
    lastGate: { at, effect: 'deny', kind: 'scope' },
  },
});
const incident = () => ({
  id: `incident-${sha}`,
  evidenceSha256: sha,
  sequence: 1,
  recordedAt: at,
});
const preview = () => ({
  schema: 'stroq-task-access-preview/1',
  id,
  workspaceId: ws,
  createdAt: at,
  expiresAt: '2026-10-24T00:02:00.000Z',
  grantExpiresAt: '2026-10-24T00:05:00.000Z',
  incident: incident(),
  task: task(),
  operation: {
    tool: 'Read',
    review: JSON.stringify({
      v: 1,
      tool: 'Read',
      kind: 'read-target',
      input: { file_path: '/workspace/readme.md' },
      cwd: '/workspace',
      resources: {
        paths: [{ path: '/workspace/readme.md', op: 'read' }],
        pathsComplete: true,
        urls: [],
        shell: false,
      },
      target: { path: '/workspace/readme.md', op: 'read' },
    }),
    kind: 'read-target',
    fingerprint: sha,
    requiredCount: 1,
  },
  limitations: TASK_ACCESS_LIMITATIONS,
});
const receipt = () => ({
  schema: 'stroq-task-access-receipt/1',
  id,
  workspaceId: ws,
  previewId: id,
  incident: incident(),
  taskId: `task-${sha}`,
  permitSha256: sha,
  fingerprint: sha,
  extensionSha256: sha,
  issuedAt: at,
  expiresAt: '2026-10-24T00:05:00.000Z',
  state: 'unused',
  execution: 'unverified',
  limitations: TASK_ACCESS_LIMITATIONS,
});
describe('one-use task access boundary', () => {
  it('accepts bounded explicit preview and exact issued permission without execution claims', () => {
    expect(validateTaskAccessPreview(preview())).toBe(true);
    expect(validateTaskAccessReceipt(receipt())).toBe(true);
    expect(validateTaskAccessReceipt({ ...receipt(), state: 'consumed' })).toBe(true);
    expect(validateTaskAccessReceipt({ ...receipt(), execution: 'completed' })).toBe(false);
  });
  it('refuses private fields, malformed JSON, oversized review and ambiguous family promises', () => {
    for (const value of [
      { ...preview(), nonce: 'private' },
      { ...preview(), operation: { ...preview().operation, review: 'clipped...' } },
      {
        ...preview(),
        operation: { ...preview().operation, review: JSON.stringify({ text: 'x'.repeat(65536) }) },
      },
      { ...preview(), operation: { ...preview().operation, tool: 'Bash' } },
      { ...preview(), operation: { ...preview().operation, requiredCount: 17 } },
    ])
      expect(validateTaskAccessPreview(value)).toBe(false);
  });
  it('refuses a preview whose review holds a hidden character, raw or escaped, and names it', () => {
    const review = preview().operation.review;
    for (const changed of [
      review.replace('readme.md', `readme${String.fromCodePoint(0x202e)}dm.exe`),
      review.replace('readme.md', 'readme\\u200b.md'),
    ])
      expect(
        validateTaskAccessPreview({
          ...preview(),
          operation: { ...preview().operation, review: changed },
        }),
      ).toBe(false);
    for (const [code, name] of [
      ['hidden-character-202e', 'U+202E'],
      ['hidden-character-200b', 'U+200B'],
      ['hidden-character-e0041', 'U+E0041'],
    ] as const)
      expect(TASK_ACCESS_ERROR_MESSAGES[code as keyof typeof TASK_ACCESS_ERROR_MESSAGES]).toMatch(
        new RegExp(`contains ${name.replace('+', '\\+')},`),
      );
    // Only a character the screen refuses has a message: a code for any other is not one.
    for (const code of ['hidden-character-0041', 'hidden-character-fe0f', 'hidden-character-'])
      expect(Object.hasOwn(TASK_ACCESS_ERROR_MESSAGES, code)).toBe(false);
  });
  it('binds preview windows, grant TTL, valid permit and exact finding identity', () => {
    for (const value of [
      { ...preview(), expiresAt: '2026-10-24T00:02:00.001Z' },
      { ...preview(), grantExpiresAt: '2026-10-24T00:05:00.001Z' },
      { ...preview(), task: { ...task(), standing: 'revoked' } },
      { ...preview(), task: { ...task(), expiresAt: '2026-10-24T00:04:00.000Z' } },
      { ...preview(), incident: { ...incident(), id: `incident-${'c'.repeat(64)}` } },
    ])
      expect(validateTaskAccessPreview(value)).toBe(false);
  });
  it('reads native extension states including consumed history and invalid rows without inventing execution', () => {
    const value = {
      schema: 'stroq-task-access/1',
      workspaceId: ws,
      taskId: `task-${sha}`,
      permitSha256: sha,
      checkedAt: at,
      coverage: { complete: true, limited: false, unverified: 0 },
      permissions: [
        {
          fingerprint: sha,
          extensionSha256: sha,
          issuedAt: at,
          expiresAt: '2026-10-24T00:10:00.000Z',
          state: 'unused',
        },
      ],
      limitations: TASK_ACCESS_LIMITATIONS,
    };
    expect(validateTaskAccessState(value)).toBe(true);
    expect(
      validateTaskAccessState({
        ...value,
        permissions: [{ ...value.permissions[0], state: 'consumed' }],
      }),
    ).toBe(true);
    expect(
      validateTaskAccessState({
        ...value,
        permissions: [{ ...value.permissions[0], state: 'expired' }],
      }),
    ).toBe(false);
    expect(
      validateTaskAccessState({
        ...value,
        coverage: { complete: false, limited: false, unverified: 1 },
        permissions: [
          {
            fingerprint: sha,
            extensionSha256: null,
            issuedAt: null,
            expiresAt: null,
            state: 'invalid',
          },
        ],
      }),
    ).toBe(true);
    expect(validateTaskAccessState({ ...value, raw: 'private' })).toBe(false);
  });
});
