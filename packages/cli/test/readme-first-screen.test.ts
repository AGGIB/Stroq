import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { usage } from '../src/help.js';
import { ATTACK_COUNT } from '../src/help-listing.js';

// The first screen of a README is the page a stranger reads before anything else. It says one thing,
// shows the card, gives one line to run and lists five commands. There are two such pages: README.md,
// which GitHub shows, and packages/cli/README.md, which npm shows. These checks hold both to the
// product: the words the card avoids stay off them, their commands are the ones `stroq --help` lists,
// the pictures they show are there and small, and the two say the same things in the same words.
// npm cannot follow a path inside the repository, so its page names every picture and link in full.

const root = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

/** Where npm finds what a repository page names by path. */
const RAW = 'https://raw.githubusercontent.com/AGGIB/Stroq/main/';

interface Page {
  readonly name: string;
  /** What comes before `docs/assets/...` in the pictures the page shows. */
  readonly pictureBase: string;
  readonly firstScreen: string;
}

const page = (name: string, pictureBase: string): Page => {
  const text = readFileSync(root(name), 'utf8');
  return { name, pictureBase, firstScreen: text.slice(0, text.indexOf('\n## ')) };
};

const github = page('README.md', '');
const npm = page('packages/cli/README.md', RAW);
const PAGES = [github, npm];

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The biggest a picture on the first screen may be. */
const MAX_PICTURE_BYTES = 200 * 1024;

/** The fenced blocks of a screen, and what is left of it once they are taken out. */
const splitFences = (screen: string): { code: string[]; rest: string } => {
  const code: string[] = [];
  const rest = screen.replace(/```[a-z]*\n[\s\S]*?```\n?/g, (block) => {
    code.push(block);
    return '';
  });
  return { code, rest };
};

/** The sentences of a screen: paragraphs that are neither markup, a heading nor a link line. */
const prose = (screen: string): string[] =>
  splitFences(screen)
    .rest.split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => /^[A-Za-z]/.test(paragraph));

describe.each(PAGES)('the first screen of $name', ({ firstScreen, pictureBase }) => {
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
      expect(firstScreen, file).toContain(`"${pictureBase}docs/assets/readme/${file}"`);
      expect(statSync(root(`docs/assets/readme/${file}`)).size, file).toBeLessThan(
        MAX_PICTURE_BYTES,
      );
    }
    expect(firstScreen).toMatch(
      /<sub>An example: a made-up machine with made-up sessions, keys and hosts\./,
    );
  });
});

describe('the first screen of packages/cli/README.md, on npm', () => {
  it('names every picture and link in full, because npm cannot follow a path in the repository', () => {
    const paths = [
      ...npm.firstScreen.matchAll(/\b(?:src|srcset|href)="([^"]*)"/g),
      ...npm.firstScreen.matchAll(/\]\(([^)\s]*)\)/g),
    ].map((match) => match[1] ?? '');
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) expect(path, path).toMatch(/^https:\/\/|^#/);
  });

  it('points the pictures it hosts at files that exist in this repository', () => {
    const hosted = [
      ...npm.firstScreen.matchAll(
        /"https:\/\/raw\.githubusercontent\.com\/AGGIB\/Stroq\/main\/([^"]+)"/g,
      ),
    ];
    expect(hosted.length).toBeGreaterThanOrEqual(4);
    for (const match of hosted)
      expect(statSync(root(match[1] ?? '')).isFile(), match[1]).toBe(true);
  });
});

describe('the two first screens', () => {
  it('say the same, in the same words', () => {
    expect(prose(npm.firstScreen)).toEqual(prose(github.firstScreen));
    expect(prose(github.firstScreen)).toHaveLength(3);
  });

  it('make the same promise', () => {
    const promise =
      'Stroq reads your own Claude Code and Codex sessions and shows how many commands came from text your agent read, and which keys left your machine.';
    expect(prose(github.firstScreen)[0]).toBe(promise);
    expect(prose(npm.firstScreen)[0]).toBe(promise);
  });

  it('show the same commands and the same line to run', () => {
    expect(splitFences(npm.firstScreen).code).toEqual(splitFences(github.firstScreen).code);
    expect(splitFences(github.firstScreen).code).toHaveLength(2);
  });

  it('put the same question first and describe the card picture the same way', () => {
    const alt = (screen: string): string => /alt="(The Stroq card[^"]*)"/.exec(screen)?.[1] ?? '';
    const question = (screen: string): string => /^### (.+)$/m.exec(screen)?.[1] ?? '';
    expect(question(npm.firstScreen)).toBe('Who is really in charge of your agent?');
    expect(question(npm.firstScreen)).toBe(question(github.firstScreen));
    expect(alt(github.firstScreen).length).toBeGreaterThan(100);
    expect(alt(npm.firstScreen)).toBe(alt(github.firstScreen));
  });
});
