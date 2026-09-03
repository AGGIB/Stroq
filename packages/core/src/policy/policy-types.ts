import { z } from 'zod';
import { ACTION_CLASSES, type ActionClass } from '../types.js';

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

export const PolicySchema = z.object({
  version: z.literal(1),
  threshold: z.number().min(0).max(1).default(0.6),
  default: EffectSchema.default('allow'),
  rules: z.array(PolicyRuleSchema),
});

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type Policy = z.infer<typeof PolicySchema>;
