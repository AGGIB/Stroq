import { describe, expect, it } from 'vitest';
import {
  extractActionAtoms,
  extractAtoms,
  extractAtomsDeepWithLoss,
} from '../../src/provenance/atoms.js';
import { cpuNow } from '../cpu-time.js';

/**
 * A tool result and a command both reach the extractor whole, inside a hook that has seconds to
 * answer. The cost of reading what follows a runner or installer is the line window times the
 * number of matches whenever matches sit on one long line, so the shapes below are the ones that
 * make every match read a full window: a runner or an installer repeated with no line end between
 * them, wrapped commands, flags without end, and the lines of an installer that is only blanks.
 * Reading is held to a budget of characters for the whole pass (`MAX_LINE_WORK`); these show that
 * 200,000 characters of any of them is read in well under a second, where the window alone cost
 * four seconds of `npm i a ` (25,000 matches of 2,048 characters).
 */
const SIZE = 200_000;
const BOUND_MS = 1_000;

const repeat = (unit: string, head = ''): string =>
  `${head}${unit.repeat(Math.ceil(SIZE / unit.length))}`.slice(0, SIZE);

const SHAPES: ReadonlyArray<readonly [string, string]> = [
  ['npx a, repeated', repeat('npx a ')],
  [
    'a long run of padding characters',
    `sha512-${'A'.repeat(86)}${'='.repeat(SIZE)}`.slice(0, SIZE),
  ],
  ['padding runs between hash-shaped tokens', repeat(`${'A'.repeat(30)}${'='.repeat(40)} `)],
  ['npm i a, repeated', repeat('npm i a ')],
  ['pip install a, repeated', repeat('pip install a ')],
  ['npx -y, repeated', repeat('npx -y ')],
  ['npx and a wrapped line, repeated', repeat('npx \\\n  ')],
  ['npm install and a flag line, repeated', repeat('npm install\n  --x ')],
  ['npm install wrapped on itself', repeat('  npm install \\\n', 'npm install \\\n')],
  ['npm install, wrapped, one package', repeat('npm install \\\n  a\n')],
  ['npm install and blanks', `npm install${' '.repeat(SIZE)}`.slice(0, SIZE)],
  ['npm install and backslash lines', repeat(' \\\n', 'npm install')],
  ['npx and backslash breaks with no indent', repeat('npx \\\n')],
  ['backslash breaks and flags', repeat('\\\n-y ', 'npx ')],
  ['carriage returns and backslashes', repeat('npm install \\\r\n  a\r\n')],
  ['an installer and backslash breaks with blanks', repeat('\\\n  ', 'pip install ')],
  ['quotes in a runner line', repeat('npx a"b" ')],
  ['quotes never closed', repeat('npx "a ')],
  ['backticks in a runner line', repeat('npx a`b ')],
  ['variables in an installer line', repeat('npm i $A ')],
  ['-p flags, repeated', repeat('npx -p a ')],
  ['backslash escapes in words', repeat('npx a\\b ')],
  ['curl, repeated', repeat('curl a ')],
  ['sh <(curl, repeated', repeat('sh <(curl a ')],
  ['urls, repeated', repeat('http://a.example/x ')],
  ['base64 alphabet', repeat('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/')],
  ['integrity strings', repeat(`sha512-${'A'.repeat(86)}== `)],
];

const EXTRACTORS: ReadonlyArray<readonly [string, (text: string) => unknown]> = [
  ['extractAtoms', extractAtoms],
  ['extractAtomsDeepWithLoss', extractAtomsDeepWithLoss],
  ['extractActionAtoms', extractActionAtoms],
];

describe.each(EXTRACTORS)('%s on 200,000 characters of an adversarial shape', (_name, extract) => {
  it.each(SHAPES)('reads %s in under a second', (_shape, text) => {
    expect(text).toHaveLength(SIZE);
    const started = cpuNow();
    extract(text);
    expect(cpuNow() - started).toBeLessThan(BOUND_MS);
  });
});
