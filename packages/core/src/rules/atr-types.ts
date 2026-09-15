import { z } from 'zod';

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'informational']);

/**
 * The surfaces untrusted text reaches an agent on. A rule declares the one it reads;
 * a caller declares the one it is scanning; a rule whose surface is not the caller's
 * does not fire. `any` means the pattern genuinely arrives everywhere — the default,
 * and today's behaviour for every rule that does not say otherwise.
 *
 * A closed vocabulary rather than a free string, because a typo'd surface is worse
 * than no surface at all: the rule would match nothing and go dark silently. The
 * enforcement point is `compileRules` (see `resolveScanTarget` in compile.ts), not
 * this schema — the shipped ATR corpus already carries a `tags.scan_target` in its
 * own, different vocabulary, and validating it here would make 589 vendored rules
 * fail to *parse*, which the loader turns into a silent skip. A compile-time throw
 * is loud; a skipped rule is exactly the hole this vocabulary exists to close.
 */
export const SCAN_TARGETS = [
  'tool_description',
  'tool_result',
  'instruction_file',
  'repo_content',
  'command_output',
  'any',
] as const;

export const ScanTargetSchema = z.enum(SCAN_TARGETS);
export type ScanTarget = z.infer<typeof ScanTargetSchema>;

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
