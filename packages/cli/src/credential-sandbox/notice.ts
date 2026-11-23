import { getAt } from '../harden/json-doc.js';
import { KEY_PATHS, RETRY_RULE, type OwnedRule } from './rules.js';
import type { EditResult, Unproven } from './settings.js';

/** Said where a run nobody answered a question for leaves the sandbox settings alone. */
export const HOW_TO_ADD_LIST =
  'The key-file list for the Claude Code sandbox was not written: nobody was asked. To choose it, run stroq init --agent claude-code --user in a terminal, without --yes or --no-input.\n';

/** Said after a project install on macOS: the list is a user-wide setting. */
export const USER_WIDE_LIST =
  'To add the key-file list for the Claude Code sandbox, run stroq init --agent claude-code --user in a terminal.\n';

const LIVE = '/sandbox inside Claude Code shows the live state.';
const keyPaths: readonly string[] = KEY_PATHS;

function turnedOn(file: string, added: readonly OwnedRule[]): string[] {
  const wrote = (id: OwnedRule['id']) => added.some((rule) => rule.id === id);
  const retry = wrote('ask-retry')
    ? ' A command retried outside the sandbox asks you before it runs.'
    : '';
  if (!wrote('enabled'))
    return retry === ''
      ? []
      : [`Added to ${file}: a rule that asks you before a command is retried outside the sandbox.`];
  const approval = wrote('auto-allow')
    ? ' Sandboxed Bash commands still ask you unless you have allowed them (autoAllowBashIfSandboxed: false).'
    : '';
  return [
    `Claude Code Bash sandbox turned on in ${file} (sandbox.enabled: true), for all projects.${approval}${retry}`,
  ];
}

/** What a user-scope install says about the sandbox settings it wrote, one line for each thing. */
export function installLines(file: string, result: EditResult): string {
  const { added, skippedLinks, doc } = result;
  const paths = added.filter((rule) => keyPaths.includes(rule.id) && rule.link === undefined);
  const on = getAt(doc, ['sandbox', 'enabled']) === true;
  const list =
    paths.length > 0
      ? `Key-file list written to ${file}: ${paths.length} ${paths.length === 1 ? 'path' : 'paths'}.`
      : `Key-file list in ${file}: nothing to add.`;
  const force = on
    ? `It applies to sandboxed Bash. ${LIVE}`
    : `It is not in force until the Claude Code sandbox is on, and this file does not turn it on. ${LIVE}`;
  const lines = [
    ...(result.replacedRecord
      ? [
          'The earlier record of what Stroq wrote here could not be verified, so the entries already in the file are treated as yours.',
        ]
      : []),
    ...turnedOn(file, added),
    `${list} ${force}`,
    ...added
      .filter((rule) => rule.link !== undefined)
      .map((rule) => `${rule.id} is a link, so its target ${rule.link} was listed too.`),
    ...skippedLinks.map(({ path, target }) =>
      target === null
        ? `${path} is a link that could not be followed, so its target was not listed.`
        : `${path} is a link to ${target}, which holds your home folder, so the target was not listed.`,
    ),
  ];
  return lines.map((line) => line + '\n').join('');
}

const REASONS: Readonly<Record<Unproven['reason'], (receipt: string) => string>> = {
  missing: () => 'its record of them is missing (it is kept under the Stroq home folder)',
  unverified: (receipt) =>
    `the record at ${receipt} could not be verified, so Stroq did not act on it and left it in place`,
  unresolved: (receipt) =>
    `an earlier Stroq edit was interrupted and the file has changed since, so the record at ${receipt} no longer says which entries are Stroq's; the record is kept`,
};

function entryLines({ entries }: Unproven): string[] {
  return [
    ...(entries.paths.length > 0
      ? [`  sandbox.credentials.files: ${entries.paths.join(', ')} (mode deny)`]
      : []),
    ...(entries.ask ? [`  permissions.ask: ${RETRY_RULE}`] : []),
    ...(entries.autoAllow ? ['  sandbox.autoAllowBashIfSandboxed: false'] : []),
    ...(entries.enabled ? ['  sandbox.enabled: true'] : []),
  ];
}

/**
 * What `stroq uninstall` says when it cannot show that the sandbox entries in a file are its own:
 * which file, which entries match what `stroq init` writes, and how to take them out by hand.
 */
export function unprovenNotice(file: string, unproven: Unproven): string {
  const why = REASONS[unproven.reason](unproven.receipt);
  const head = `Stroq has no record it can use of the sandbox settings it wrote to ${file}: ${why}. It removes only what a record names, so it changed no sandbox setting.`;
  const entries = entryLines(unproven);
  // A record that could not be used stays until a person has looked: it is theirs to delete.
  const stale = (lead: string): string =>
    unproven.reason === 'missing'
      ? ''
      : ` ${lead} delete ${unproven.receipt}, which is no longer of use.`;
  if (entries.length === 0)
    return `${head}\nNo entry that stroq init writes is in the file now.${stale('You can')}\n`;
  return [
    head,
    'These entries match what stroq init writes and are still in the file:',
    ...entries,
    `To remove them by hand, open ${file} in an editor and delete the ones you did not add yourself. Deleting "enabled": true under "sandbox" turns the Claude Code Bash sandbox off, unless another settings file turns it on.${stale('Then')}`,
    '',
  ].join('\n');
}
