import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { usage } from '../src/help.js';
import { ATTACK_COUNT } from '../src/help-listing.js';

// The first screen of the root README is the page a stranger reads before anything else. It says one
// thing, shows the card, gives one line to run and lists five commands. These checks hold it to the
// product: the words the card avoids stay off it, its commands are the ones `stroq --help` lists, and
// the pictures it shows are there and small.

const root = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const readme = readFileSync(root('README.md'), 'utf8');
const firstScreen = readme.slice(0, readme.indexOf('\n## '));

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The biggest a picture on the first screen may be. */
const MAX_PICTURE_BYTES = 200 * 1024;

describe('the first screen of README.md', () => {
  it('ends where the first section starts, and is not empty', () => {
    expect(firstScreen.length).toBeGreaterThan(500);
    expect(firstScreen).toContain('Who is really in charge of your agent?');
  });

  it('uses none of the words the card itself avoids', () => {
    for (const word of ['taint', 'provenance', 'suspect', 'default'])
      expect(firstScreen, word).not.toMatch(new RegExp(`\\b${word}`, 'i'));
  });

  it('gives the one line to run, and says what it does with your machine', () => {
    expect(firstScreen).toMatch(/```bash\nnpx @stroq\/cli\n```/);
    expect(firstScreen).toContain('small cache under `~/.stroq`');
    expect(firstScreen).toContain('sends nothing');
    expect(firstScreen).toContain('No account, no telemetry');
    expect(firstScreen).toContain('Needs Node.js 22 or newer');
  });

  it('lists the commands `stroq --help` lists, with the words it uses for them', () => {
    const help = [...usage().matchAll(/^stroq(?: ([a-z-]+))? {2,}(\S.*)$/gm)].map((m) => ({
      name: m[1],
      summary: m[2] ?? '',
    }));
    const named = help.filter((line) => line.name !== undefined);
    expect(named.map((line) => line.name)).toEqual(['init', 'why', 'attack', 'uninstall']);
    const block = /```text\n((?:npx @stroq\/cli.*\n)+)```/.exec(firstScreen)?.[1] ?? '';
    expect(block.trimEnd().split('\n')).toHaveLength(5);
    for (const { name, summary } of named)
      expect(block, name).toMatch(
        new RegExp(`^npx @stroq/cli {1,}${name} {2,}${escaped(summary)}$`, 'm'),
      );
    expect(block).toMatch(/^npx @stroq\/cli {12}a card of your own sessions/m);
  });

  it('keeps the attack badge at the number of attacks the CLI replays, none passing through', () => {
    expect(firstScreen).toContain(
      `[![stroq attack: 0 of ${ATTACK_COUNT} passed through](https://img.shields.io/badge/stroq%20attack-0%20of%20${ATTACK_COUNT}%20passed%20through-`,
    );
  });

  it('shows the card in a light and a dark picture, each small, and says it is an example', () => {
    for (const file of ['card.png', 'card-dark.png']) {
      expect(firstScreen, file).toContain(`docs/assets/readme/${file}`);
      expect(statSync(root(`docs/assets/readme/${file}`)).size, file).toBeLessThan(
        MAX_PICTURE_BYTES,
      );
    }
    expect(firstScreen).toMatch(
      /<sub>An example: a made-up machine with made-up sessions, keys and hosts\./,
    );
  });
});
