import { closed } from './local-guards';

/** A display label only. Never use it to resolve a filesystem path. */
export interface SkillLocation {
  label: string;
  redacted: boolean;
}
const WITHHELD = 'Folder name withheld';
const sensitive = (value: string) =>
  /(?:^|[ .-])[A-Z][A-Z0-9]*_[A-Z0-9_]+(?:$|[ .-])/.test(value) ||
  /(?:^|[ _.-])(?:env|secrets?|passwords?|credentials?|tokens?|id_rsa|id_ed25519)(?:$|[ _.-])|api[_.-]?key|private[_.-]?key|[A-Za-z0-9_-]{24}/i.test(
    value,
  );
const visible = (value: string) => {
  if (value.length > 512 || value === WITHHELD) return false;
  const parts = value.split('/');
  return (
    parts.length <= 8 &&
    parts.every(
      (part) =>
        /^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(part) &&
        part.trim() === part &&
        part !== WITHHELD &&
        !sensitive(part),
    )
  );
};
export function skillLocation(locator: string): SkillLocation {
  if (locator === '') return { label: '.', redacted: false };
  return visible(locator)
    ? { label: locator, redacted: false }
    : { label: WITHHELD, redacted: true };
}
export function validateSkillLocation(value: unknown): value is SkillLocation {
  return (
    closed(value, ['label', 'redacted']) &&
    Object.keys(value).length === 2 &&
    typeof value.label === 'string' &&
    typeof value.redacted === 'boolean' &&
    (value.redacted ? value.label === WITHHELD : value.label === '.' || visible(value.label))
  );
}
