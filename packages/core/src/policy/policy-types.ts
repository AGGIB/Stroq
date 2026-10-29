import { z } from 'zod';
import { ACTION_CLASSES, type ActionClass } from '../types.js';
import { MCP_IDENTITY_CHANNELS } from '../mcp/identity.js';

export const EffectSchema = z.enum(['allow', 'deny', 'ask']);

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  effect: EffectSchema,
  reason: z.string().min(1),
  when: z.object({
    classes: z.array(z.enum([...ACTION_CLASSES] as [ActionClass, ...ActionClass[]])).min(1),
    taint: z.enum(['any', 'none', 'suspect']).default('any'),
  }),
});

/** Exact reported labels, never the classifier's normalized synthetic name. */
export const McpGovernanceEntrySchema = z
  .object({
    channel: z.enum(MCP_IDENTITY_CHANNELS),
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  })
  .strict();

export const McpGovernanceSchema = z
  .object({
    allowed: z
      .array(McpGovernanceEntrySchema)
      .max(64)
      .refine(
        (rows) =>
          new Set(rows.map((row) => `${row.channel}\u0000${row.name}`)).size === rows.length,
        'Duplicate MCP governance entry',
      ),
  })
  .strict();

const common = {
  threshold: z.number().min(0).max(1).default(0.6),
  default: EffectSchema.default('allow'),
};

/** Legacy unknown-key linting stays compatible; a new security control cannot be ignored. */
export const PolicyV1Schema = z.object({
  version: z.literal(1),
  ...common,
  rules: z.array(PolicyRuleSchema),
  mcpGovernance: z.never().optional(),
});

export const PolicyV2Schema = z
  .object({
    version: z.literal(2),
    ...common,
    rules: z.array(
      PolicyRuleSchema.extend({ when: PolicyRuleSchema.shape.when.strict() }).strict(),
    ),
    mcpGovernance: McpGovernanceSchema,
  })
  .strict();

export const PolicySchema = z.discriminatedUnion('version', [PolicyV1Schema, PolicyV2Schema]);

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type McpGovernance = z.infer<typeof McpGovernanceSchema>;
export type McpGovernanceEntry = z.infer<typeof McpGovernanceEntrySchema>;
