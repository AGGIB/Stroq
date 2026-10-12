import { z } from 'zod';
import { ClaudeHookInputSchema } from '../adapters/claude-code.js';
import type { Scenario, ScenarioStep } from '../attack/scenario.js';
import type { ActionScenario, ActionStep } from '../bench/actions.js';
import { faultOf, type SchemaFault } from '../install/schema-fault.js';
import {
  AttackCaseSchema,
  BenignCaseSchema,
  type AttackCase,
  type BenignCase,
} from './case-schema.js';
import { readBoundedText, type Unreadable } from './read-text.js';
import { readYaml, type YamlFault } from './yaml.js';

/**
 * Reading the cases a person writes for `stroq policy test --cases <file>`.
 *
 * The file is YAML or JSON (JSON is YAML), at most 256 KiB, with at most 200 cases, each either an
 * attack (steps that each expect an answer, the last being the attack) or an expectation about
 * ordinary work (`{id, steps, expect}`, the answer expected of the last step). Anything wrong is
 * reported as the path of the field and a fixed phrase: the file is somebody's text and is never
 * quoted back.
 */

export const MAX_CASES_BYTES = 256 * 1024;
export const MAX_CASES = 200;

/** A case, ready to run, with what it expects. */
export type UserCase =
  | { readonly kind: 'attack'; readonly scenario: Scenario }
  | {
      readonly kind: 'benign';
      readonly scenario: ActionScenario;
      readonly expect: BenignCase['expect'];
    };

export type CasesParse =
  | { readonly ok: true; readonly cases: readonly UserCase[] }
  | { readonly ok: false; readonly problem: 'too-many'; readonly count: number }
  | { readonly ok: false; readonly problem: 'schema'; readonly faults: readonly SchemaFault[] };

export type CasesRead =
  | CasesParse
  | { readonly ok: false; readonly problem: 'unreadable'; readonly why: Unreadable }
  | { readonly ok: false; readonly problem: 'yaml'; readonly fault: YamlFault };

const TopSchema = z.union([
  z.array(z.unknown()),
  z.strictObject({ version: z.literal(1).optional(), cases: z.array(z.unknown()) }),
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A case carries `expect` of its own exactly when it is an expectation about ordinary work. */
const isBenign = (item: unknown): boolean => isRecord(item) && Object.hasOwn(item, 'expect');

/**
 * The path of an issue as it is reported. The keys of `files` and `links` are chosen by whoever wrote
 * the file, so a fault under one is reported at the record that holds them instead.
 */
function reportedPath(path: readonly PropertyKey[]): readonly PropertyKey[] {
  const holder = path[2];
  return holder === 'files' || holder === 'links' ? path.slice(0, 3) : path;
}

function toAttack(value: AttackCase): UserCase {
  const steps = value.steps.map((step): ScenarioStep => ({
    event: ClaudeHookInputSchema.parse(step.event),
    expect: step.expect,
  })) as [ScenarioStep, ...ScenarioStep[]];
  const incident = value.incident ?? null;
  return {
    kind: 'attack',
    scenario: {
      id: value.id,
      title: value.title ?? value.id,
      incident,
      class: incident === null ? (value.class ?? 'user case') : null,
      origin: value.origin ?? 'direct-user',
      encoding: value.encoding ?? 'plain',
      effect: value.effect ?? 'exec',
      atlas: value.atlas ?? [],
      asi: value.asi ?? [],
      ...(value.files === undefined ? {} : { files: value.files }),
      ...(value.links === undefined ? {} : { links: value.links }),
      steps,
    },
  };
}

function toBenign(value: BenignCase): UserCase {
  const steps = value.steps.map((step): ActionStep => ({
    event: ClaudeHookInputSchema.parse(step.event),
  })) as [ActionStep, ...ActionStep[]];
  return {
    kind: 'benign',
    expect: value.expect,
    scenario: {
      id: value.id,
      title: value.title ?? value.id,
      ...(value.files === undefined ? {} : { files: value.files }),
      steps,
    },
  };
}

function itemsOf(value: unknown): { items: readonly unknown[] } | { faults: SchemaFault[] } {
  const top = TopSchema.safeParse(value);
  if (!top.success) return { faults: top.error.issues.map((i) => faultOf(i.path, i.code)) };
  return { items: Array.isArray(top.data) ? top.data : top.data.cases };
}

/** Checks the cases of an already-parsed document. Pure: no file is opened. */
export function parseCases(value: unknown): CasesParse {
  const top = itemsOf(value);
  if ('faults' in top) return { ok: false, problem: 'schema', faults: top.faults };
  if (top.items.length > MAX_CASES) {
    return { ok: false, problem: 'too-many', count: top.items.length };
  }
  if (top.items.length === 0) {
    return { ok: false, problem: 'schema', faults: [faultOf(['cases'], 'too_small')] };
  }
  const faults: SchemaFault[] = [];
  const cases: UserCase[] = [];
  const seen = new Set<string>();
  top.items.forEach((item, index) => {
    const parsed = isBenign(item)
      ? BenignCaseSchema.safeParse(item)
      : AttackCaseSchema.safeParse(item);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        faults.push(faultOf(reportedPath(['cases', index, ...issue.path]), issue.code));
      }
      return;
    }
    if (seen.has(parsed.data.id)) {
      faults.push({ path: `cases.${index}.id`, kind: 'an id that an earlier case already uses' });
      return;
    }
    seen.add(parsed.data.id);
    cases.push(
      isBenign(item) ? toBenign(parsed.data as BenignCase) : toAttack(parsed.data as AttackCase),
    );
  });
  return faults.length > 0 ? { ok: false, problem: 'schema', faults } : { ok: true, cases };
}

/** The cases in a file, or why there are none. */
export function readCasesFile(path: string): CasesRead {
  const file = readBoundedText(path, MAX_CASES_BYTES);
  if ('why' in file) return { ok: false, problem: 'unreadable', why: file.why };
  const yaml = readYaml(file.text);
  if (!yaml.ok) return { ok: false, problem: 'yaml', fault: yaml.fault };
  return parseCases(yaml.value);
}
