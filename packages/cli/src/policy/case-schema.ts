import { z } from 'zod';
import { ClaudeHookInputSchema } from '../adapters/claude-code.js';
import {
  ENCODINGS,
  EFFECTS,
  ORIGINS,
  StepExpectationSchema,
  type StepExpectation,
} from '../attack/scenario.js';

/**
 * The shape of the cases a person writes for `stroq policy test --cases`: an attack-style scenario
 * (the entries of `attack/scenarios/corpus.json`, with the fields that only describe it left optional)
 * or a benign expectation (`{id, steps, expect}`).
 *
 * Every object is strict: a misspelled field is a fault, not something quietly dropped, because a case
 * with a dropped `expect` would pass whatever the policy did. Nothing here reads a file; the paths and
 * link targets are checked as text so that a case file cannot make the runner write or point outside
 * the throwaway folders it works in.
 */

/** The most steps one case may have; the corpus's longest has three. */
export const MAX_STEPS = 50;
/** The longest id, file path or link target taken. */
const MAX_NAME = 200;
const MAX_ID = 120;

/** C0 and C1 controls: a name that holds one is never a file a person meant. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const segmentsOf = (path: string): string[] => path.split(/[\\/]/);

/**
 * A fixture path is relative to the project folder and stays under it: no empty name, no `..`, no
 * leading slash or drive letter, no control character. `runScenario` also refuses a path that escapes,
 * but by throwing, which would end the whole run; here it is one case's fault.
 */
export function isFixturePath(path: string): boolean {
  if (path === '' || path.length > MAX_NAME || CONTROL.test(path)) return false;
  if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path)) return false;
  return segmentsOf(path).every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * A link may point only into the two throwaway folders, by the placeholders the corpus uses
 * (`__HOME__`, `__CWD__`), and never up out of them. A case file somebody else wrote cannot name a
 * file of yours.
 */
export function isLinkTarget(target: string): boolean {
  if (target.length > MAX_NAME || CONTROL.test(target)) return false;
  if (!/^__(?:HOME|CWD)__(?:[\\/]|$)/.test(target)) return false;
  return segmentsOf(target).every((s) => s !== '..');
}

/** True when some link sits inside another link: written through the first, it lands outside the folder. */
export function hasNestedLink(paths: readonly string[]): boolean {
  const links = new Set(paths.map((p) => segmentsOf(p).join('/')));
  return [...links].some((link) => {
    const parts = link.split('/');
    return parts.slice(1).some((_, i) => links.has(parts.slice(0, i + 1).join('/')));
  });
}

const IdSchema = z.string().min(1).max(MAX_ID);

const FilesSchema = z.record(z.string().refine(isFixturePath), z.string());

const LinksSchema = z
  .record(z.string().refine(isFixturePath), z.string().refine(isLinkTarget))
  .refine((links) => !hasNestedLink(Object.keys(links)));

/** What a recorded hook event has to be: the very schema the runner parses it with. */
const EventSchema = z
  .record(z.string(), z.unknown())
  .refine((event) => ClaudeHookInputSchema.safeParse(event).success);

/**
 * What an event is when it is a hook event at all: a call about to run, or a result. An event that is
 * neither has its own fault, and the checks that depend on what it is stay quiet about it.
 */
type Phase = 'call' | 'result';
function phaseOf(event: Record<string, unknown>): Phase | null {
  if (!ClaudeHookInputSchema.safeParse(event).success) return null;
  return event['hook_event_name'] === 'PreToolUse' ? 'call' : 'result';
}

const EXPECTATIONS: Readonly<Record<Phase, readonly StepExpectation[]>> = {
  call: ['allow', 'ask', 'deny'],
  result: ['clean', 'suspect'],
};

const AttackStepSchema = z.strictObject({ event: EventSchema, expect: StepExpectationSchema });

const BenignStepSchema = z.strictObject({ event: EventSchema });

export const BenignExpectSchema = z.enum(['allow', 'ask', 'deny']);

const Described = {
  title: z.string().max(MAX_NAME).optional(),
  files: FilesSchema.optional(),
};

/**
 * An attack: steps that each expect what the engine says, the last being the attack itself, a tool
 * call that must not be allowed. The fields a corpus entry also carries are accepted so that one can be
 * pasted in as it is; they only describe it.
 */
export const AttackCaseSchema = z
  .strictObject({
    id: IdSchema,
    ...Described,
    links: LinksSchema.optional(),
    incident: z
      .strictObject({ name: z.string(), url: z.string(), date: z.string() })
      .nullable()
      .optional(),
    class: z.string().min(1).max(MAX_NAME).nullable().optional(),
    origin: z.enum(ORIGINS).optional(),
    encoding: z.enum(ENCODINGS).optional(),
    effect: z.enum(EFFECTS).optional(),
    atlas: z.array(z.string().max(MAX_NAME)).optional(),
    asi: z.array(z.string().max(MAX_NAME)).optional(),
    steps: z.array(AttackStepSchema).min(1).max(MAX_STEPS),
  })
  .superRefine((value, ctx) => {
    value.steps.forEach((step, index) => {
      const phase = phaseOf(step.event);
      if (phase !== null && !EXPECTATIONS[phase].includes(step.expect)) {
        ctx.addIssue({ code: 'custom', path: ['steps', index, 'expect'], message: 'unreachable' });
      }
    });
    const lastIndex = value.steps.length - 1;
    const last = value.steps[lastIndex];
    const phase = last === undefined ? null : phaseOf(last.event);
    if (last === undefined || phase === null) return;
    if (phase === 'result') {
      ctx.addIssue({ code: 'custom', path: ['steps'], message: 'last step is not a call' });
    } else if (last.expect === 'allow') {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', lastIndex, 'expect'],
        message: 'attack allowed',
      });
    }
  });

/** An ordinary action: steps that are replayed, and the answer expected of the last one. */
export const BenignCaseSchema = z
  .strictObject({
    id: IdSchema,
    ...Described,
    steps: z.array(BenignStepSchema).min(1).max(MAX_STEPS),
    expect: BenignExpectSchema,
  })
  .superRefine((value, ctx) => {
    const last = value.steps[value.steps.length - 1];
    if (last !== undefined && phaseOf(last.event) === 'result') {
      ctx.addIssue({ code: 'custom', path: ['steps'], message: 'last step is not a call' });
    }
  });

export type AttackCase = z.infer<typeof AttackCaseSchema>;
export type BenignCase = z.infer<typeof BenignCaseSchema>;
