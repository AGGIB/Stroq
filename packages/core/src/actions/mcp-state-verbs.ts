/**
 * Which MCP tool names say that the call changes something. The substring list in
 * `classify-tool.ts` names the verbs of messaging and publishing (`send`, `update`, `create`);
 * this is the rest of what a record system does to a record, read from the words of the name.
 * It only decides how a session that has read something suspect is treated
 * (`ask-mcp-side-effect-when-tainted`), so a verb here costs a question in that session and
 * nothing in a clean one.
 *
 * In the NVIDIA indirect-prompt-injection data (CC BY 4.0) 398 of the 1,272 targets the attacker
 * wanted called were `adjust_*`, `add_*`, `cancel_*`, `submit_*`, `flag_*`, `process_*` and
 * `schedule_*` calls, none of which the substring list knew.
 */

/**
 * Verbs that change state, matched against the first word of a tool's name (`adjust_financial_aid`,
 * `submitGrade`) and not anywhere in it: `schedule`, `order`, `claim`, `process` and `flag` are nouns
 * too, and `get_schedule` is a read.
 */
const STATE_CHANGING_VERBS: ReadonlySet<string> = new Set([
  'add',
  'adjust',
  'apply',
  'approve',
  'archive',
  'assign',
  'attach',
  'authorize',
  'block',
  'book',
  'cancel',
  'change',
  'charge',
  'close',
  'confirm',
  'deactivate',
  'activate',
  'disable',
  'enable',
  'edit',
  'enroll',
  'escalate',
  'flag',
  'grant',
  'import',
  'insert',
  'invite',
  'issue',
  'lock',
  'unlock',
  'mark',
  'modify',
  'move',
  'order',
  'patch',
  'prescribe',
  'process',
  'put',
  'reassign',
  'refund',
  'register',
  'reject',
  'rename',
  'reopen',
  'replace',
  'reply',
  'reset',
  'restore',
  'revert',
  'revoke',
  'save',
  'schedule',
  'set',
  'share',
  'sign',
  'submit',
  'suspend',
  'sync',
  'tag',
  'terminate',
  'trigger',
  'void',
  'waive',
  'withdraw',
  'accept',
  'append',
  'ban',
  'buy',
  'clear',
  'click',
  'commit',
  'complete',
  'decline',
  'demote',
  'destroy',
  'dismiss',
  'dispatch',
  'erase',
  'fill',
  'finalize',
  'install',
  'kill',
  'mint',
  'mute',
  'promote',
  'provision',
  'purge',
  'reserve',
  'resolve',
  'restart',
  'rotate',
  'sell',
  'settle',
  'ship',
  'start',
  'stop',
  'store',
  'subscribe',
  'swap',
  'toggle',
  'unban',
  'undo',
  'uninstall',
  'unsubscribe',
  'upgrade',
  'whitelist',
  'wipe',
]);
/** A name that ends in one of these reads, whatever it starts with: `issue_read`, `schedule_list`. */
const READING_VERBS: ReadonlySet<string> = new Set([
  'read',
  'get',
  'list',
  'search',
  'find',
  'show',
  'view',
  'fetch',
  'describe',
  'lookup',
  'query',
  'check',
  'count',
]);
/**
 * Verbs that change state and are not nouns, so that a name that ENDS in one (`ticket_assign`,
 * `appointment_cancel`, `invoice_void`) is read as a change: noun-first names put the verb last.
 */
const CLOSING_VERBS: ReadonlySet<string> = new Set([
  'adjust',
  'approve',
  'archive',
  'assign',
  'reassign',
  'authorize',
  'ban',
  'unban',
  'cancel',
  'close',
  'reopen',
  'decline',
  'demote',
  'promote',
  'deactivate',
  'disable',
  'dismiss',
  'enroll',
  'escalate',
  'finalize',
  'grant',
  'revoke',
  'purge',
  'destroy',
  'wipe',
  'refund',
  'reject',
  'rename',
  'resolve',
  'restart',
  'submit',
  'suspend',
  'terminate',
  'void',
  'waive',
  'withdraw',
]);
/**
 * Whether the name is a change of state: it starts with a verb that changes state and does not
 * end with one that reads (`schedule_list` and `issue_read` are reads; `set_status` is not), or it
 * ends with a verb that changes state and does not start with one that reads. `words` are the
 * lower-case words of the tool's name, split at snake-, kebab- and camelCase.
 */
export function changesState(words: readonly string[]): boolean {
  const first = words[0] ?? '';
  const last = words.at(-1) ?? '';
  if (STATE_CHANGING_VERBS.has(first) && !READING_VERBS.has(last)) return true;
  return CLOSING_VERBS.has(last) && !READING_VERBS.has(first);
}
