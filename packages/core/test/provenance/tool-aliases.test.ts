import { describe, expect, it } from 'vitest';
import { extractActionAtoms, extractAtoms } from '../../src/provenance/atoms.js';

// Every package manager spells its verbs more than one way, and the spelling the agent types is
// the one that must be found: a verb missing from the table is a command that installs a package
// and names none. This table is each manager's own list of aliases, and a test reads every one of
// them from a command and from a page, so a spelling that is missing fails here.
//
// Where they come from: npm `lib/utils/cmd-list.js` (`aliases`), `pnpm --help` ([alias: ...]),
// `bun --help` (`bun i`, `bun a`, `bun c`), RubyGems `Gem::CommandManager::ALIAS_COMMANDS`, and
// the commands of yarn, pip, uv and cargo, which have no aliases for these verbs. Add a manager's
// new alias here when it ships one.

interface Documented {
  /** The words that start a command, and the verbs after them that install or update a package. */
  readonly installers: readonly string[];
  /** The verbs that fetch a package and run it. */
  readonly runners: readonly string[];
}

const DOCUMENTED: Readonly<Record<string, Documented>> = {
  npm: {
    installers: [
      // install: add, i, in, ins, inst, insta, instal, isnt, isnta, isntal, isntall
      ...['install', 'add', 'i', 'in', 'ins', 'inst', 'insta', 'instal'],
      ...['isnt', 'isnta', 'isntal', 'isntall'],
      // install-test: it
      ...['install-test', 'it'],
      // update: up, upgrade, udpate
      ...['update', 'up', 'upgrade', 'udpate'],
      // link: ln
      ...['link', 'ln'],
    ],
    // exec: x; init: create, innit
    runners: ['exec', 'x', 'init', 'create', 'innit'],
  },
  pnpm: {
    // install: i; install-test: it; update: up, upgrade; link: ln
    installers: [
      'add',
      'install',
      'i',
      'install-test',
      'it',
      'update',
      'up',
      'upgrade',
      'link',
      'ln',
    ],
    runners: ['dlx', 'create'],
  },
  yarn: {
    installers: ['add', 'upgrade', 'up', 'link', 'global add', 'global upgrade'],
    runners: ['dlx', 'create'],
  },
  bun: {
    // install: i; add: a
    installers: ['add', 'a', 'install', 'i', 'update', 'link'],
    // x: bunx; create: c
    runners: ['x', 'create', 'c'],
  },
  pip: { installers: ['install'], runners: [] },
  uv: { installers: ['add', 'pip install', 'tool install'], runners: ['tool run'] },
  cargo: { installers: ['add', 'install', 'binstall'], runners: [] },
  // ALIAS_COMMANDS: i => install, up => update
  gem: { installers: ['install', 'i', 'update', 'up'], runners: [] },
};

/** The tools that are a runner on their own. */
const STANDALONE: readonly string[] = ['npx', 'pnpx', 'bunx', 'uvx'];

const NAME = 'evil-helper-fix';

const phrases = (): string[] =>
  Object.entries(DOCUMENTED).flatMap(([tool, { installers, runners }]) =>
    [...installers, ...runners].map((verb) => `${tool} ${verb}`),
  );

const commandNames = (command: string): string[] =>
  extractActionAtoms(command)
    .atoms.filter((a) => a.kind === 'pkg')
    .map((a) => a.value);

describe('every alias of the package managers', () => {
  it.each([...phrases(), ...STANDALONE])('is read from a command: %s', (phrase) => {
    expect(commandNames(`${phrase} ${NAME}`)).toContain(NAME);
  });

  it.each([...phrases(), ...STANDALONE])('is read from a page: %s', (phrase) => {
    const page = `To set up, run:\n\n    ${phrase} ${NAME}\n\nThen continue.`;
    expect(extractAtoms(page)).toContainEqual({ kind: 'pkg', value: NAME });
  });

  it.each(phrases())('is read behind a global option: %s', (phrase) => {
    const [tool = '', ...verb] = phrase.split(' ');
    expect(commandNames(`${tool} --silent ${verb.join(' ')} ${NAME}`)).toContain(NAME);
  });

  it('spells pip and python -m pip the ways that run', () => {
    for (const prefix of ['pip', 'pip3', 'pip3.11', 'python -m pip', 'python3 -m pip', 'py -m pip'])
      expect(commandNames(`${prefix} install ${NAME}`), prefix).toContain(NAME);
  });
});
