import type { CompiledRule } from './compile.js';

/**
 * The fields of a rule's conditions that Stroq fills in. A condition on any other field is false,
 * because nobody gives it a value, so a rule that needs one of those can never match:
 *
 * - `content`: the text that is scanned.
 * - `tool_response`: what a tool of a third party returned: an MCP server's result, a fetched web
 *   page, a search. The text is the response itself. Not for a local result (a file read, a command's
 *   output, a grep): the rules that read it were written for what another party answers, and on one's
 *   own work they fire about as often as the rules on `content` do.
 * - `tool_description`: what an MCP server says its tools are, in the answer to `tools/list`.
 *
 * Not supplied, on purpose: `user_input` (what the person typed: Stroq is not given it, and it is
 * not Stroq's to read), `tool_args` (the arguments of a call are commands and paths: three of the
 * five rules that read it fired on 22%, 1% and 0.2% of the real commands one developer's agents ran,
 * and nothing in the policy stands for a suspect argument), and what a trace of a session holds.
 * The rules that need those wait for a source of data that does not exist here, and the number of
 * rules that can fire says so.
 */
export const SUPPLIED_FIELDS: ReadonlySet<string> = new Set([
  'content',
  'tool_response',
  'tool_description',
]);

/**
 * Whether a rule can match anything at all: a rule that needs any one of its conditions needs one on
 * a supplied field, and one that needs all of them needs every one on a supplied field.
 */
export function canFire(rule: CompiledRule): boolean {
  const supplied = (test: CompiledRule['tests'][number]): boolean =>
    SUPPLIED_FIELDS.has(test.field);
  return rule.condition === 'all' ? rule.tests.every(supplied) : rule.tests.some(supplied);
}

/** Whether a rule can match on `content` alone, which is what every rule did before the fields were supplied. */
export function readsContent(rule: CompiledRule): boolean {
  const onContent = (test: CompiledRule['tests'][number]): boolean => test.field === 'content';
  return rule.condition === 'all' ? rule.tests.every(onContent) : rule.tests.some(onContent);
}

/** The supplied fields other than `content` that a rule reads, in the order of its conditions. */
export function suppliedFieldsOf(rule: CompiledRule): readonly string[] {
  return [
    ...new Set(
      rule.tests.map((test) => test.field).filter((f) => f !== 'content' && SUPPLIED_FIELDS.has(f)),
    ),
  ];
}
