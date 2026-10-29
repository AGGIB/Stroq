import { describe, expect, it } from 'vitest';
import {
  MCP_TOOL_CONTRACT_LIMITATIONS,
  validateMcpToolContractState,
  validateMcpToolContractPreview,
  validateMcpToolContractReceipt,
  type McpToolContractState,
  type McpToolContractRegistration,
  type McpToolContractPreview,
  type McpToolContractReceipt,
} from './mcp-tool-contracts';
import {
  mcpToolContractDecisionInput,
  mcpToolContractPreviewMatches,
  mcpToolContractReceiptMatches,
  mcpToolContractApplyInput,
} from './mcp-tool-contract-binding';
import { formatMcpToolContract } from './mcp-tool-contract-presentation';
import { compareMcpToolContract } from './mcp-tool-contract-comparison';
const sha = (n: string) => n.repeat(64),
  ws = `workspace-${'a'.repeat(24)}`;
const registration: McpToolContractRegistration = {
  id: `item-${'b'.repeat(24)}`,
  name: 'Notes server',
  agent: 'cursor',
  scope: 'user',
  registrationSha256: sha('c'),
  bindingId: `binding-${sha('d')}`,
  revision: sha('e'),
  status: 'complete',
  reason: null,
  captureSha256: sha('f'),
  observedAt: '2026-10-24T01:00:00.000Z',
  tools: [
    {
      id: `tool-${sha('1')}`,
      name: 'notes:read',
      sha256: sha('2'),
      contract: JSON.stringify({
        name: 'notes:read',
        description: '<script>alert(1)</script>',
        inputSchema: { type: 'object' },
      }),
      decision: 'pending',
      previousApprovedContract: null,
      comparison: compareMcpToolContract('{}', null, null),
    },
  ],
  history: [],
};
const state: McpToolContractState = {
  schema: 'stroq-mcp-tool-contracts/1',
  workspaceId: ws,
  generatedAt: '2026-10-24T01:00:00.000Z',
  available: true,
  reason: null,
  registrations: [registration],
  gaps: [],
  limitations: [...MCP_TOOL_CONTRACT_LIMITATIONS],
};
const preview: McpToolContractPreview = {
  schema: 'stroq-mcp-tool-contract-preview/1',
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: ws,
  createdAt: '2026-10-24T01:00:00.000Z',
  expiresAt: '2026-10-24T01:02:00.000Z',
  registrationId: registration.id,
  registrationSha256: registration.registrationSha256,
  ...mcpToolContractDecisionInput(registration, registration.tools[0]!, 'approve')!,
  tool: {
    name: registration.tools[0]!.name,
    contract: registration.tools[0]!.contract,
    previousApprovedContract: null,
    comparison: registration.tools[0]!.comparison,
  },
  hostEnforcement: false,
};
const receipt: McpToolContractReceipt = {
  schema: 'stroq-mcp-tool-contract-receipt/1',
  previewId: preview.id,
  workspaceId: ws,
  completedAt: '2026-10-24T01:00:01.000Z',
  revision: sha('3'),
  registrationId: registration.id,
  registrationSha256: registration.registrationSha256,
  ...mcpToolContractDecisionInput(registration, registration.tools[0]!, 'approve')!,
  hostEnforcement: false,
};
describe('MCP tool contract public boundary and decision bindings', () => {
  it('accepts complete exact records including colon identities and inert hostile text', () => {
    expect(validateMcpToolContractState(state)).toBe(true);
    expect(validateMcpToolContractPreview(preview)).toBe(true);
    expect(validateMcpToolContractReceipt(receipt)).toBe(true);
  });
  it('distinguishes no listing, complete empty, invalidated and unavailable records', () => {
    expect(
      validateMcpToolContractState({
        ...state,
        registrations: [
          {
            ...registration,
            status: 'none',
            revision: null,
            captureSha256: null,
            observedAt: null,
            tools: [],
          },
        ],
      }),
    ).toBe(true);
    expect(
      validateMcpToolContractState({ ...state, registrations: [{ ...registration, tools: [] }] }),
    ).toBe(true);
    expect(
      validateMcpToolContractState({
        ...state,
        registrations: [{ ...registration, status: 'incomplete', reason: 'listing-invalidated' }],
      }),
    ).toBe(true);
    expect(
      validateMcpToolContractState({
        ...state,
        available: false,
        reason: 'storage-unavailable',
        registrations: [],
      }),
    ).toBe(true);
    expect(
      validateMcpToolContractState({ ...state, available: false, reason: 'storage-unavailable' }),
    ).toBe(false);
  });
  it('rejects partial/private/duplicate identities and mismatched or lossy contract metadata', () => {
    for (const changed of [
      { privatePath: '/PRIVATE' },
      { registrations: [registration, registration] },
      { registrations: [{ ...registration, bindingId: sha('d') }] },
      {
        registrations: [
          { ...registration, tools: [registration.tools[0]!, registration.tools[0]!] },
        ],
      },
      {
        registrations: [
          {
            ...registration,
            tools: [{ ...registration.tools[0]!, contract: '{"name":"different"}' }],
          },
        ],
      },
      {
        registrations: [
          {
            ...registration,
            tools: [
              { ...registration.tools[0]!, contract: '{"name":"wrong","name":"notes:read"}' },
            ],
          },
        ],
      },
      {
        registrations: [
          {
            ...registration,
            tools: [{ ...registration.tools[0]!, contract: ' ' + registration.tools[0]!.contract }],
          },
        ],
      },
    ])
      expect(validateMcpToolContractState({ ...state, ...changed })).toBe(false);
  });
  it('cannot approve partial/no-listing captures or already approved versions', () => {
    const tool = registration.tools[0]!;
    expect(
      mcpToolContractDecisionInput({ ...registration, status: 'incomplete' }, tool, 'approve'),
    ).toBeNull();
    expect(
      mcpToolContractDecisionInput({ ...registration, status: 'none' }, tool, 'approve'),
    ).toBeNull();
    const approved = { ...tool, decision: 'approved' as const },
      r = { ...registration, tools: [approved] };
    expect(mcpToolContractDecisionInput(r, approved, 'approve')).toBeNull();
    expect(mcpToolContractDecisionInput(r, approved, 'revoke')).not.toBeNull();
  });
  it('refuses unsupported or incomplete contract fields and forged approval without matching history', () => {
    for (const body of [
      { name: 'notes:read' },
      { name: 'notes:read', inputSchema: [] },
      { name: 'notes:read', inputSchema: { type: 'object' }, newUnknownField: true },
    ])
      expect(
        validateMcpToolContractState({
          ...state,
          registrations: [
            {
              ...registration,
              tools: [{ ...registration.tools[0]!, contract: JSON.stringify(body) }],
            },
          ],
        }),
      ).toBe(false);
    expect(
      validateMcpToolContractState({
        ...state,
        registrations: [
          { ...registration, tools: [{ ...registration.tools[0]!, decision: 'approved' }] },
        ],
      }),
    ).toBe(false);
  });
  it('makes directional controls visible while retaining complete pretty printed metadata', () => {
    const formatted = formatMcpToolContract(
      JSON.stringify({
        name: 'notes:read',
        description: '\u202ereview',
        inputSchema: { type: 'object' },
      }),
    );
    expect(formatted).toContain('\\u202ereview');
    expect(formatted).not.toContain('\u202e');
    expect(formatted).toContain('\n');
    expect(formatted).toContain('"inputSchema"');
  });
  it('binds previews to the exact registration, capture, tool body and action', () => {
    expect(
      mcpToolContractPreviewMatches(preview, registration, registration.tools[0]!, 'approve', ws),
    ).toBe(true);
    for (const patch of [
      { bindingId: `binding-${sha('4')}` },
      { expectedRevision: sha('4') },
      { expectedCaptureSha256: sha('4') },
      { expectedContractSha256: sha('4') },
      { action: 'revoke' as const },
      { registrationSha256: sha('4') },
      { tool: { ...preview.tool, contract: '{"name":"notes:read"}' } },
    ])
      expect(
        mcpToolContractPreviewMatches(
          { ...preview, ...patch },
          registration,
          registration.tools[0]!,
          'approve',
          ws,
        ),
      ).toBe(false);
  });
  it('validates exact comparison evidence and rejects fabricated counts, paths or approval provenance', () => {
    const current = registration.tools[0]!;
    const previous = JSON.stringify({
      name: current.name,
      description: 'approved earlier',
      inputSchema: { type: 'object' },
    });
    const baseline = { sha256: sha('5'), approvedAt: '2026-10-24T00:00:00.000Z' };
    const compared = {
      ...current,
      previousApprovedContract: previous,
      comparison: compareMcpToolContract(current.contract, previous, baseline),
    };
    const r = {
      ...registration,
      tools: [compared],
      history: [
        {
          action: 'approve' as const,
          toolId: current.id,
          contractSha256: baseline.sha256,
          at: baseline.approvedAt,
        },
      ],
    };
    expect(validateMcpToolContractState({ ...state, registrations: [r] })).toBe(true);
    for (const patch of [
      { status: 'unchanged' },
      { counts: { added: 0, changed: 0, removed: 0 } },
      { changes: [{ path: '/inputSchema', kind: 'changed' }] },
      { baselineSha256: sha('6') },
      { baselineApprovedAt: '2026-10-23T00:00:00.000Z' },
      { privatePath: '/private' },
    ])
      expect(
        validateMcpToolContractState({
          ...state,
          registrations: [
            { ...r, tools: [{ ...compared, comparison: { ...compared.comparison, ...patch } }] },
          ],
        }),
      ).toBe(false);
    const legacy = {
      ...compared,
      previousApprovedContract: null,
      comparison: compareMcpToolContract(current.contract, null, baseline),
    };
    expect(
      validateMcpToolContractState({ ...state, registrations: [{ ...r, tools: [legacy] }] }),
    ).toBe(true);
    expect(
      validateMcpToolContractState({
        ...state,
        registrations: [
          {
            ...r,
            tools: [
              { ...legacy, comparison: compareMcpToolContract(current.contract, null, null) },
            ],
          },
        ],
      }),
    ).toBe(false);
  });
  it('binds comparison identity independently of harmless JSON object key ordering', () => {
    const comparison = preview.tool.comparison;
    const reordered = {
      status: comparison.status,
      counts: comparison.counts,
      changes: comparison.changes,
      baselineApprovedAt: comparison.baselineApprovedAt,
      baselineSha256: comparison.baselineSha256,
    };
    expect(
      mcpToolContractPreviewMatches(
        { ...preview, tool: { ...preview.tool, comparison: reordered } },
        registration,
        registration.tools[0]!,
        'approve',
        ws,
      ),
    ).toBe(true);
    expect(
      mcpToolContractPreviewMatches(
        {
          ...preview,
          tool: { ...preview.tool, comparison: { ...comparison, baselineSha256: sha('7') } },
        },
        registration,
        registration.tools[0]!,
        'approve',
        ws,
      ),
    ).toBe(false);
  });
  it('requires dual fresh consent and exact receipt identity, not a matching tool name alone', () => {
    expect(
      mcpToolContractApplyInput(preview, true, false, Date.parse(preview.createdAt)),
    ).toBeNull();
    expect(
      mcpToolContractApplyInput(preview, true, true, Date.parse(preview.expiresAt)),
    ).toBeNull();
    expect(mcpToolContractApplyInput(preview, true, true, Date.parse(preview.createdAt))).toEqual({
      previewId: preview.id,
      confirm: true,
      acknowledgeContract: true,
      acknowledgeCallLimits: true,
    });
    expect(mcpToolContractReceiptMatches(receipt, preview)).toBe(true);
    for (const patch of [
      { previewId: '22222222-2222-4222-8222-222222222222' },
      { workspaceId: `workspace-${'f'.repeat(24)}` },
      { bindingId: `binding-${sha('4')}` },
      { expectedContractSha256: sha('4') },
      { revision: preview.expectedRevision },
    ])
      expect(mcpToolContractReceiptMatches({ ...receipt, ...patch }, preview)).toBe(false);
  });
});
