import { describe, expect, it } from 'vitest';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { PAYLOADS, spellings } from './spelling-matrix.js';

/**
 * A command keeps the classes it has when the shell reads it the same way in another spelling:
 * after a command that ends it however that is written, inside a group or a string a shell is
 * handed, behind a wrapper, with its name in capitals or its words quoted. The cases are a cross
 * product (`spelling-matrix.ts`), not examples; the first three families the review of 2026-10-05
 * found by writing it down: `sleep 1&rm -rf ~`, `(rm -rf ~)` and `git "reset" --hard` ran, and were
 * not asked about.
 *
 * Asking (`shell.unparsed`) is an answer: a spelling the reading cannot tell is not a hole.
 */
const cwd = '/home/dev/project';
const classes = (command: string): readonly string[] =>
  classifyTool('Bash', { command }, cwd).classes;

/** The spellings of the payload that lost a class it has alone, and were not asked about. */
function lostIn(payload: string): string[] {
  const base = classes(payload);
  const lost: string[] = [];
  for (const command of spellings(payload)) {
    const got = classes(command);
    if (got.includes('shell.unparsed')) continue;
    const missing = base.filter((c) => !got.includes(c));
    if (missing.length > 0) lost.push(`${JSON.stringify(command)} lost ${missing.join(',')}`);
  }
  return lost;
}

describe('a command keeps its classes in another spelling the shell reads the same', () => {
  it.each(PAYLOADS)('%s has classes of its own', (payload) => {
    expect(classes(payload)).not.toEqual([]);
  });

  it.each(PAYLOADS)('%s, spelt every way', (payload) => {
    expect(lostIn(payload)).toEqual([]);
  });
});

describe('a string that only holds a command is not that command', () => {
  // The detectors that read words find the command word; the ones that read text match a
  // quoted `git reset --hard` as they match an unquoted one, and are not asked here.
  it.each([
    "echo 'rm -rf ~'",
    'echo "rm -rf ~"',
    'printf "%s" "(rm -rf ~)"',
    'echo "find ~ -delete"',
    "grep -r 'rm -rf /' docs/",
  ])('%s', (command) => {
    expect(classes(command)).toEqual([]);
  });
});
