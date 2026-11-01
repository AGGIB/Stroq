// What `stroq --help` and `stroq help --all` print: where each command is listed, the form a
// newcomer types first, and what it is for in one line. The full text of a command, every flag
// included, is `stroq <command> --help`, printed from `COMMANDS` in help.ts. `help-unit.test.ts`
// holds the two to each other: every command there has a tier here, and no other name does.

/**
 * core: on the first screen. more: under `stroq help --all` only. hidden: in neither list; the
 * command still works and still has its `--help`.
 */
export type Tier = 'core' | 'more' | 'hidden';

type Job = 'start' | 'past' | 'before' | 'guard';

interface Listed {
  readonly name: string;
  readonly tier: Exclude<Tier, 'hidden'>;
  /** The command as a newcomer types it first, after `stroq `. */
  readonly brief: string;
  /** What it is for, in one line. */
  readonly summary: string;
}

interface Section {
  readonly job: Job;
  readonly title: string;
  readonly commands: readonly Listed[];
}

const core = (name: string, brief: string, summary: string): Listed => ({
  name,
  tier: 'core',
  brief,
  summary,
});

const more = (name: string, brief: string, summary: string): Listed => ({
  name,
  tier: 'more',
  brief,
  summary,
});

/**
 * `stroq` with no words after it. It is the first thing on the first screen, but it is not a
 * command with a name: it has no tier, no `--help` and no entry in `COMMANDS`. Until the card of a
 * person's own sessions is built, it prints the first screen.
 */
const BARE = {
  brief: '',
  summary: 'who is really in charge of your agent? A card of your sessions',
};
/** The same line for `stroq help --all`, whose column starts further right. */
const BARE_ALL = { brief: '', summary: 'A card from your own sessions' };

/**
 * How many attacks `stroq attack` replays, as the first screen says it. The corpus is not read
 * here, because this file is loaded by every hook call; `help-unit.test.ts` holds the number to
 * the length of the corpus, so that adding an attack fails there until the screen says so.
 */
export const ATTACK_COUNT = 36;

/** Every listed command, by job, in the order both screens print them. */
const SECTIONS: readonly Section[] = [
  {
    job: 'start',
    title: 'Start here',
    commands: [
      core('init', 'init', 'stop it next time: guard your agent'),
      core('why', 'why', 'why an action was stopped'),
      core('attack', 'attack', `watch Stroq stop ${ATTACK_COUNT} known attacks, in a sandbox`),
      core('uninstall', 'uninstall', 'remove Stroq'),
    ],
  },
  {
    job: 'past',
    title: 'Check past sessions',
    commands: [
      more('sent', 'sent --last', 'Did your agent see or send any of your keys?'),
      more('replay', 'replay --last', 'Which commands came from what the agent read?'),
    ],
  },
  {
    job: 'before',
    title: 'Check before you open or install',
    commands: [
      more('inspect', 'inspect [<dir>]', 'What will this repo run when an agent opens it?'),
      more('vet', 'vet --from <path>', 'Read a skill or MCP server before you add it'),
      more('exposure', 'exposure', 'Map the agents and MCP servers on this machine'),
    ],
  },
  {
    job: 'guard',
    title: 'Guard your agent',
    commands: [
      more('console', 'console', 'Open the local security platform'),
      more('doctor', 'doctor', 'Is the guard installed and being called?'),
      more('untaint', 'untaint --session <id>', 'Clear a flagged session after a false alarm'),
      more('trust', 'trust <file>', 'Mark a file as fine until it changes'),
      more('log', 'log', "Show the latest entries of Stroq's audit log"),
      more('verify', 'verify', 'Check that the audit log was not edited'),
      more('policy', 'policy check', 'Check your policy file and test what it changes'),
      more('canary', 'canary', 'Make a decoy key; sending it out is blocked'),
    ],
  },
];

/**
 * What Stroq writes into an agent's config (`init`) and older copies of it still call. No person
 * types these. `task-hook` is not a command of the table at all: it is answered in index.ts.
 */
const HIDDEN: readonly string[] = ['hook', 'mcp'];

const TIERS: ReadonlyMap<string, Tier> = new Map([
  ...SECTIONS.flatMap((section) =>
    section.commands.map(({ name, tier }): [string, Tier] => [name, tier]),
  ),
  ...HIDDEN.map((name): [string, Tier] => [name, 'hidden']),
]);

/** Where `name` is listed, or null for a name that is not a command. */
export function tierOf(name: string): Tier | null {
  return TIERS.get(name) ?? null;
}

const TAGLINE = [
  'stroq: see what your AI coding agent saw, ran and installed.',
  'Runs on your machine, no telemetry.',
];

const shown = (brief: string): string => (brief === '' ? 'stroq' : `stroq ${brief}`);

/** The rows of the first screen: the bare `stroq`, then the core commands. */
const FIRST_SCREEN: readonly Pick<Listed, 'brief' | 'summary'>[] = [
  BARE,
  ...SECTIONS.flatMap((section) => section.commands).filter((command) => command.tier === 'core'),
];

const widthOf = (rows: readonly Pick<Listed, 'brief'>[]): number =>
  Math.max(...rows.map((r) => shown(r.brief).length)) + 2;

const row = (command: Pick<Listed, 'brief' | 'summary'>, width: number, indent = ''): string =>
  `${indent}${shown(command.brief).padEnd(width)}${command.summary}`;

/** `stroq --help`: the five things most people need, and where the others are. */
export function usage(): string {
  const width = widthOf(FIRST_SCREEN);
  return [
    ...FIRST_SCREEN.map((command) => row(command, width)),
    '',
    'More commands: stroq help --all',
    '',
  ].join('\n');
}

/** `stroq help --all`: every command that is not plumbing, one line each, by job. */
export function usageAll(): string {
  const everything = [BARE_ALL, ...SECTIONS.flatMap((section) => section.commands)];
  const width = widthOf(everything);
  const groups = SECTIONS.flatMap((section) => [
    '',
    `${section.title}:`,
    ...(section.job === 'start' ? [row(BARE_ALL, width, '  ')] : []),
    ...section.commands.map((command) => row(command, width, '  ')),
  ]);
  return [
    ...TAGLINE,
    ...groups,
    '',
    'One command:   stroq <command> --help',
    'The version:   stroq --version',
    '',
  ].join('\n');
}
