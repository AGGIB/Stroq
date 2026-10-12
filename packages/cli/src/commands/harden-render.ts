import type { RecipeTarget } from '../harden/recipes/index.js';
import type { Needs, PlanItem, PlanView } from './harden-view.js';

/**
 * A plan in plain English, as lines of text. Every string here is either the command's own (ASCII) or
 * one `PlanView` already made safe: nothing of a file reaches this module in any other way.
 */

const MARKS: Readonly<Record<PlanItem['status'], string>> = {
  add: '+',
  present: '=',
  unknown: '-',
};

const ALREADY_THERE = '   (already there, and left as it is)';

/** `stroq harden <subcommand> --agent .. --scope ..` with the flags the change needs. */
export function commandFor(
  view: Pick<PlanView, 'agent' | 'scope'>,
  subcommand: 'plan' | 'apply' | 'undo',
  extra: readonly string[] = [],
): string {
  return [
    'stroq harden',
    subcommand,
    `--agent ${view.agent}`,
    `--scope ${view.scope}`,
    ...extra,
  ].join(' ');
}

/** The flags `apply` needs for what the plan says needs saying yes to. */
export function flagsFor(needs: Needs): readonly string[] {
  return [
    ...(needs.acknowledgeLink ? ['--acknowledge-link'] : []),
    ...(needs.acknowledgeCredentialLoss ? ['--acknowledge-credential-loss'] : []),
    ...(needs.acknowledgeReformat ? ['--acknowledge-reformat'] : []),
  ];
}

const bullets = (lines: readonly string[]): string[] => lines.map((line) => `  - ${line}`);

function itemLines(view: PlanView, target: RecipeTarget): string[] {
  // When there is nothing to add, every item is the owner's already and the list says so once.
  if (!view.changed) {
    return [
      target.words.there,
      ...view.items.map((item) => `  ${MARKS[item.status]} ${item.text}`),
    ];
  }
  return [
    target.words.adds,
    ...view.items.map((item) =>
      item.status === 'present'
        ? `  ${MARKS[item.status]} ${item.text}${ALREADY_THERE}`
        : `  ${MARKS[item.status]} ${item.text}`,
    ),
  ];
}

function refusalLines(view: PlanView): string[] {
  const { refused } = view;
  if (refused === null) return [];
  const byHand =
    refused.snippet === null
      ? []
      : [
          '',
          'To make the change by hand, add this inside the top-level braces of the file',
          '(if it already has a "permissions" block with a "deny" list, add the rules to that list):',
          ...refused.snippet.split('\n').map((line) => `    ${line}`),
        ];
  return [`Refused: ${refused.detail}`, ...byHand];
}

/** What the owner is shown of the change itself: the diff, or why there is none. */
function changeLines(view: PlanView): string[] {
  if (view.diffWithheld) {
    return [
      'The change: not shown, because the path is a link.',
      `  To see it: ${commandFor(view, 'plan', ['--acknowledge-link'])}`,
    ];
  }
  if (view.diff === '') return [];
  return ['The change:', view.diff.replace(/\n$/, '')];
}

function noteLines(view: PlanView): string[] {
  const notes = view.notices.length === 0 ? [] : ['Notes:', ...bullets(view.notices)];
  const unverified = view.unverified === null ? [] : [`Not verified: ${view.unverified}`];
  return [...notes, ...(notes.length > 0 && unverified.length > 0 ? [''] : []), ...unverified];
}

const section = (lines: readonly string[]): string[] => (lines.length === 0 ? [] : ['', ...lines]);

/**
 * The plan as text: what is asked, of which file, the rules, the diff, what Stroq could not check, and
 * what the change does and does not do. A refused plan has the reason and what to do by hand in place of
 * the rules and the diff.
 */
export function renderPlan(view: PlanView, target: RecipeTarget): string {
  const header = [
    `stroq harden: ${view.recipe} (${view.agent}, ${view.scope} scope)`,
    view.summary,
    '',
    `File: ${view.file}`,
    ...(view.exists ? [] : ['  The file does not exist yet; applying would create it.']),
  ];
  const body =
    view.refused === null
      ? [...section(itemLines(view, target)), ...section(view.changed ? changeLines(view) : [])]
      : section(refusalLines(view));
  const notes = view.refused === null ? section(noteLines(view)) : [];
  // What a change does and does not do is said about a change; there is none to say it about otherwise.
  const limits =
    view.refused === null && view.changed
      ? section(['What this does, and what it does not:', ...bullets(view.limits)])
      : [];
  return `${[...header, ...body, ...notes, ...limits].join('\n')}\n`;
}
