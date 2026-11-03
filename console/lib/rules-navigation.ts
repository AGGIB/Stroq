/** The Rules screen, and its reference opened on a rule: a rule id is a bundled rule's name, read back through a guard. */
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

/** The address of the rules reference, searched for `ruleId` when there is one. */
export function rulesReferenceHref(ruleId?: string | null): string {
  const found = ruleId !== undefined && ruleId !== null && RULE_ID.test(ruleId);
  return `/policies/${found ? `?find=${encodeURIComponent(ruleId)}` : ''}#reference`;
}

/** What `?find=` holds, or an empty string when it is not a rule id or a few plain words. */
export function referenceQuery(value: string | null): string {
  return value !== null && value.length <= 120 && !/[\u0000-\u001f\u007f]/.test(value) ? value : '';
}
