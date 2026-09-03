import { z } from 'zod';

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'informational']);

export const ConditionSchema = z.object({
  field: z.string().default('content'),
  operator: z.enum(['regex', 'contains', 'exact', 'starts_with']),
  value: z.string().min(1),
  description: z.string().optional(),
});

export const TestCaseSchema = z.object({ input: z.string(), expected: z.string() });

export const AtrRuleSchema = z.looseObject({
  id: z.string().regex(/^[A-Z]+-\d{4}-\d{5}$/, 'id must look like ATR-2026-00001'),
  title: z.string().min(1),
  severity: SeveritySchema,
  status: z.string().optional(),
  tags: z
    .looseObject({
      category: z.string().optional(),
      scan_target: z.string().optional(),
      confidence: z.string().optional(),
    })
    .optional(),
  detection: z.looseObject({
    condition: z.enum(['any', 'all']).default('any'),
    conditions: z.array(ConditionSchema).min(1),
  }),
  test_cases: z
    .looseObject({
      true_positives: z.array(TestCaseSchema).optional(),
      true_negatives: z.array(TestCaseSchema).optional(),
    })
    .optional(),
});

export type AtrRule = z.infer<typeof AtrRuleSchema>;
export type AtrCondition = z.infer<typeof ConditionSchema>;
