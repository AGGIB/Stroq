import { describe, expect, it } from 'vitest';
import { recordLines } from '../../src/commands/harden-record.js';
import type { ManifestEntry } from '../../src/harden/manifest.js';
import type { RecordedEdit } from '../../src/harden/types.js';

/**
 * The record of what Stroq changed, as lines for a person to read before they undo it. The record is a
 * file Stroq wrote, and it holds text that came from the owner's file, so what is printed is made safe
 * and kept short.
 */

const entry = (
  edits: readonly RecordedEdit[],
  overrides: Partial<ManifestEntry> = {},
): ManifestEntry => ({
  recipe: 'claude-read-deny',
  created: false,
  real: '/home/me/.claude/settings.json',
  root: '/home/me',
  edits,
  shaBefore: 'a'.repeat(64),
  shaAfter: 'b'.repeat(64),
  backup: null,
  stroqVersion: '0.0.0-test',
  appliedAt: '2026-10-10T10:00:00.000Z',
  ...overrides,
});

const add = (value: unknown, preexisting = false): RecordedEdit => ({
  kind: 'json-array-add',
  path: ['permissions', 'deny'],
  value: value as never,
  preexisting,
  createdFrom: 2,
});

describe('recordLines', () => {
  it('says how many changes, when, by which recipe, and what was added', () => {
    const lines = recordLines([entry([add('Read(./.env)'), add('Read(~/.ssh/**)')])]);

    expect(lines).toEqual([
      'Stroq recorded 1 change to it.',
      '  Applied 2026-10-10T10:00:00.000Z by claude-read-deny.',
      '  Added 2 rules to permissions.deny:',
      '    - Read(./.env)',
      '    - Read(~/.ssh/**)',
    ]);
  });

  it('counts the changes, oldest first', () => {
    const lines = recordLines([
      entry([add('a')], { appliedAt: '2026-10-09T00:00:00.000Z' }),
      entry([add('b')], { appliedAt: '2026-10-10T00:00:00.000Z' }),
    ]);

    expect(lines[0]).toBe('Stroq recorded 2 changes to it.');
    expect(lines.indexOf('  Applied 2026-10-09T00:00:00.000Z by claude-read-deny.')).toBeLessThan(
      lines.indexOf('  Applied 2026-10-10T00:00:00.000Z by claude-read-deny.'),
    );
  });

  it('names the rules that were already there and are not touched', () => {
    const lines = recordLines([entry([add('a'), add('b', true), add('c', true)])]);

    expect(lines).toContain('  Added 1 rule to permissions.deny:');
    expect(lines).toContain('  2 rules were already there and are not touched: b, c');
  });

  it('says when the change made the file', () => {
    const lines = recordLines([entry([add('a')], { created: true })]);

    expect(lines).toContain(
      '  Applied 2026-10-10T10:00:00.000Z by claude-read-deny; it made the file.',
    );
  });

  it('describes a block of lines', () => {
    const lines = recordLines([
      entry([
        {
          kind: 'text-block',
          id: 'cursor-ignore',
          lines: ['.env', '.env.*'],
          previous: null,
          prefix: '\n',
          closesLastLine: false,
          suffix: '\n',
        },
      ]),
    ]);

    expect(lines).toContain('  Added a block of 2 lines, between two marker lines:');
    expect(lines).toContain('    - .env.*');
  });

  it('describes a value that was set', () => {
    const lines = recordLines([
      entry([
        {
          kind: 'json-set',
          path: ['sandbox', 'enabled'],
          value: true,
          previous: { present: false },
          createdFrom: 1,
        },
      ]),
    ]);

    expect(lines).toContain('  Set sandbox.enabled (it was not there).');
  });

  it('shows a few of a long list and counts the rest', () => {
    const many = Array.from({ length: 100 }, (_, i) => add(`Read(~/f${i})`));

    const lines = recordLines([entry(many)]);

    expect(lines.filter((line) => line.startsWith('    - Read'))).toHaveLength(30);
    expect(lines).toContain('    - ... and 70 more');
    expect(lines).toContain('  Added 100 rules to permissions.deny:');
  });

  it('writes a control character out, and keeps each value to one line', () => {
    const lines = recordLines([
      entry([add('Read(\u001b[2J)\nforged: line'), add({ nested: 'x'.repeat(500) })]),
    ]);

    expect(lines.join('\n')).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
    expect(lines).toContain('    - Read(\\u001b[2J)\\nforged: line');
    expect(lines.every((line) => line.length < 200)).toBe(true);
  });
});
