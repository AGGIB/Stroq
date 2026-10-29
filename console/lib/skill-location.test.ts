import { describe, expect, it } from 'vitest';
import { skillLocation, validateSkillLocation } from './skill-location';

describe('source-relative skill display locations', () => {
  it('distinguishes ordinary nested folders and the source root', () => {
    for (const label of ['release/notes', 'review/notes', 'single-folder', '.']) {
      const value = skillLocation(label === '.' ? '' : label);
      expect(value).toEqual({ label, redacted: false });
      expect(validateSkillLocation(value)).toBe(true);
    }
  });
  it('withholds the whole label if any segment may expose sensitive content', () => {
    for (const value of [
      'private-key/notes',
      'release/.env',
      'SECRET_TOKEN/notes',
      'notes/sk-abcdefghijklmnopqrstuvwx',
      '../notes',
      '/Users/private/notes',
      'release//notes',
      'a/'.repeat(9) + 'notes',
      'unsafe\nname',
      'x'.repeat(81),
    ]) {
      const result = skillLocation(value);
      expect(result).toEqual({ label: 'Folder name withheld', redacted: true });
      expect(validateSkillLocation(result)).toBe(true);
    }
  });
  it('rejects forged redaction, unsafe labels and arbitrary extra fields', () => {
    for (const value of [
      { label: '../notes', redacted: false },
      { label: 'release/SECRET_TOKEN', redacted: false },
      { label: 'customer/folder', redacted: true },
      { label: 'Folder name withheld', redacted: false },
      { label: 'release/notes', redacted: false, path: '/outside' },
      { label: '', redacted: false },
    ])
      expect(validateSkillLocation(value)).toBe(false);
  });
});
