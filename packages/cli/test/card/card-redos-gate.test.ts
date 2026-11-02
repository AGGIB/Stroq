import { describe, it } from 'vitest';
import { hitsOf, sanitizeKeys } from '../../src/card/key-result.js';
import { commandCouldLink, couldCarryLink } from '../../src/card/lean.js';
import { packagesOf } from '../../src/card/package-claims.js';
import { scrubber } from '../../src/card/scrub.js';
import { pipelinesOf, splitWords } from '../../src/card/shell-view.js';
import { decodesAndRuns, runsPipeToShell, strictLink } from '../../src/card/strict-link.js';
import { NOTHING_DECLARED } from '../../src/card/package-claims.js';
import { clean, shortPath, wrap } from '../../src/card/text.js';
import { keyFinder } from '../../src/sent/keys.js';
import { expectLinear, repeat, SIZES, type EntryPoint } from '../helpers/linear-gate.js';

/**
 * Everything the card reads in a session was written by the agent or by what the agent read, so each
 * reader of that text is timed on text built to be slow for it, at three sizes, in processor time
 * (see `linear-gate.ts`).
 */

const gate = (run: EntryPoint, shape: (size: number) => string): void =>
  expectLinear(SIZES.map(shape), run);

const SHAPES: readonly (readonly [string, (size: number) => string])[] = [
  ['token prefixes', repeat('sk-')],
  ['cloud key prefixes', repeat('AKIA')],
  ['hosting token prefixes', repeat('ghp_')],
  ['a long run of a token alphabet', (size) => `sk-${'a'.repeat(size)}`],
  ['a long run after a prefix', (size) => `AIza${'A'.repeat(size)}`],
  ['key block openers', repeat('-----BEGIN ')],
  ['key block openers with capitals', (size) => `-----BEGIN ${'A'.repeat(size)}`],
  ['slack-like prefixes', repeat('xox')],
  ['canary prefixes', repeat('stroq_attack_')],
  ['fetchers', repeat('curl ')],
  ['downloads', repeat('wget -O ')],
  ['clone words', repeat('git clone ')],
  ['gh words', repeat('gh ')],
  ['a long word after git', (size) => `git ${'a'.repeat(size)}`],
  ['runners', repeat('npx ')],
  ['installers', repeat('npm i -D ')],
  ['pipes', repeat('|')],
  ['pipes to shells', repeat('curl x | sh; ')],
  ['quotes', repeat(`'`)],
  ['double quotes', repeat('"')],
  ['backslashes', repeat('\\')],
  ['heredoc openers', repeat('cat <<E ')],
  ['heredoc lines', repeat('cat <<E\nx\n')],
  ['shell programs', repeat('bash -c ')],
  ['nested shell programs', repeat(`bash -c '`)],
  ['substitutions', repeat('$(')],
  ['process substitutions', repeat('bash <(')],
  ['decoders', repeat('base64 -d | ')],
  ['xxd words', repeat('xxd -')],
  ['assignments', repeat('K=v ')],
  ['wrappers', repeat('sudo -u x env ')],
  ['blobs', (size) => 'A1b2'.repeat(size / 4)],
  ['hex runs', (size) => 'ab12'.repeat(size / 4)],
  ['percent escapes', repeat('%41')],
  ['zero-width characters', repeat('n​p​x ')],
  ['blanks', repeat(' ')],
  ['controls', repeat('\u001b[2K')],
  ['slashes', repeat('a/')],
  ['dots', repeat('..')],
  ['long words', (size) => 'x'.repeat(size)],
];

/** A key this gate looks for; made up. */
const GATE_KEY = { name: 'GATE_KEY', source: 'env', value: 'FAKEgateKeyValue0123456789abcdef' };

describe('the card reads session text in linear time', () => {
  it.each(SHAPES)('the cleaning of a key result before it is kept: %s', (_name, shape) => {
    const finder = keyFinder([GATE_KEY]);
    const scrub = scrubber(finder);
    gate(
      (text) =>
        sanitizeKeys(
          {
            id: text,
            hits: [
              {
                k: 0,
                place: {
                  tier: 'third_party',
                  route: 'command',
                  tool: text,
                  detail: text,
                  host: text,
                  service: text,
                  then: { route: 'command', host: text, at: text, detail: text },
                },
                at: text,
                subagent: text,
                times: 1,
                seen: 1,
                later: 0,
              },
            ],
          },
          finder,
          scrub,
        ),
      shape,
    );
  });

  it.each(SHAPES)('the times and places a key result keeps: %s', (_name, shape) => {
    gate(
      (text) =>
        hitsOf(
          [
            {
              key: 0,
              place: { tier: 'seen', route: 'result', tool: 'Read', then: undefined } as never,
              at: text,
              subagent: text,
            },
          ],
          [0],
        ),
      shape,
    );
  });

  it.each(SHAPES)('the key and token scrubber: %s', (_name, shape) => {
    gate(scrubber(keyFinder([])), shape);
  });

  it.each(SHAPES)('the reading of a command: %s', (_name, shape) => {
    gate((text) => pipelinesOf(text), shape);
    gate((text) => splitWords(text), shape);
    gate((text) => commandCouldLink(text), shape);
  });

  it.each(SHAPES)('the packages a command runs: %s', (_name, shape) => {
    gate((text) => pipelinesOf(text).flat().flatMap(packagesOf), shape);
  });

  it.each(SHAPES)('the proof that a command runs what a text said: %s', (_name, shape) => {
    gate((text) => {
      const pipelines = pipelinesOf(text);
      return [runsPipeToShell(pipelines), decodesAndRuns(pipelines)];
    }, shape);
    gate(
      (text) =>
        strictLink(
          {
            tool: 'Bash',
            summary: text,
            classes: ['shell.exec_encoded'],
            decision: { effect: 'ask' },
            provenance: [
              {
                kind: 'pkg',
                excerpt: 'some-unknown-pkg',
                tool: 'Read',
                source: 's',
                at: 'a',
                suspect: true,
              },
            ],
          },
          NOTHING_DECLARED,
        ),
      shape,
    );
  });

  it.each(SHAPES)('the check of a result for what could be a link: %s', (_name, shape) => {
    gate((text) => couldCarryLink(text), shape);
  });

  it.each(SHAPES)('the words of the card: %s', (_name, shape) => {
    gate((text) => clean(text, 4_096), shape);
    gate((text) => shortPath(text, '/Users/dev'), shape);
    gate((text) => wrap(text, 60, '1  '), shape);
  });
});
