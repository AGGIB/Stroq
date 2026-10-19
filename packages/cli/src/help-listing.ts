// What `stroq --help` and `stroq help --all` print: where each command is listed, the form a
// newcomer types first, and what it is for in one line. The full text of a command, every flag
// included, is `stroq <command> --help`, printed from `COMMANDS` in help.ts. `help-unit.test.ts`
// holds the two to each other: every command there has a tier here, and no other name does.

/**
 * core: on the first screen. more: under `stroq help --all` too. hidden: in neither list; the
 * command still works and still has its `--help`.
 */
export type Tier = 'core' | 'more' | 'hidden';

type Job = 'past' | 'guard' | 'before' | 'test' | 'experimental';

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

/** Every listed command, by job, in the order both screens print them. */
const SECTIONS: readonly Section[] = [
  {
    job: 'past',
    title: 'Check past sessions',
    commands: [
      core('sent', 'sent --last', 'Did your agent see or send any of your keys?'),
      more('replay', 'replay --last', 'Which commands came from what the agent read?'),
    ],
  },
  {
    job: 'guard',
    title: 'Guard your agent',
    commands: [
      core('init', 'init', 'Block risky actions from now on (asks first)'),
      core('doctor', 'doctor', 'Is the guard installed and being called?'),
      core('why', 'why', 'Why was the last action blocked or asked about?'),
      core('uninstall', 'uninstall', "Take Stroq out of your agent's config"),
      more('untaint', 'untaint --session <id>', 'Clear a flagged session after a false alarm'),
      more('trust', 'trust <file>', 'Mark a file as fine until it changes'),
      more('log', 'log', "Show the latest entries of Stroq's audit log"),
      more('verify', 'verify', 'Check that the audit log was not edited'),
      more('policy', 'policy check', 'Check your policy file and test what it changes'),
    ],
  },
  {
    job: 'before',
    title: 'Check before you open or install',
    commands: [
      core('inspect', 'inspect [<dir>]', 'What will this repo run when an agent opens it?'),
      core('vet', 'vet --from <path>', 'Read a skill or MCP server before you add it'),
      more('add', 'add <path>', 'Install a skill or MCP server after a check'),
      more('remove', 'remove <name>', 'Remove what stroq add installed'),
      more('exposure', 'exposure', 'Map the agents and MCP servers on this machine'),
      more('run', 'run -- <agent>', 'Start an agent after checking the repo and hooks'),
    ],
  },
  {
    job: 'test',
    title: 'Test Stroq itself',
    commands: [
      more('attack', 'attack', 'Run the built-in attacks against your policy'),
      more('bench', 'bench', 'Measure false alarms, interruptions and speed'),
      more('coverage', 'coverage', 'Map Stroq to the MITRE ATLAS and OWASP lists'),
      more('prove', 'prove', 'Check with your agent that blocking really works'),
      more('canary', 'canary', 'Make a decoy key; sending it out is blocked'),
    ],
  },
  {
    job: 'experimental',
    title: 'Experimental',
    commands: [
      more('task', 'task -- "<task>"', 'Run a Claude Code task with set files and tools'),
      more('permit', 'permit list', "See, extend or end a task's permissions"),
      more('harden', 'harden plan', "Block credential files in your agent's settings"),
    ],
  },
];

/** What Stroq writes into an agent's config (`init`, and `add --kind mcp`). No person types these. */
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

/** The two groups of the first screen, and the jobs whose core commands each one shows. */
const FIRST_SCREEN: readonly { readonly title: string; readonly jobs: readonly Job[] }[] = [
  { title: 'Check (reads only):', jobs: ['past', 'before'] },
  { title: "Guard (init and uninstall change your agent's config):", jobs: ['guard'] },
];

const shown = (brief: string): string => `stroq ${brief}`;

/** One column for both screens, so that a command sits in the same place on each. */
const WIDTH =
  Math.max(...SECTIONS.flatMap((s) => s.commands.map((c) => shown(c.brief).length))) + 2;

const row = (command: Listed): string =>
  `  ${shown(command.brief).padEnd(WIDTH)}${command.summary}`;

/** `stroq --help`: the commands most people need, and where the others are. */
export function usage(): string {
  const groups = FIRST_SCREEN.flatMap(({ title, jobs }) => [
    '',
    title,
    ...SECTIONS.filter((section) => jobs.includes(section.job))
      .flatMap((section) => section.commands)
      .filter((command) => command.tier === 'core')
      .map(row),
  ]);
  return [
    ...TAGLINE,
    ...groups,
    '',
    'All commands:  stroq help --all',
    'One command:   stroq <command> --help',
    '',
  ].join('\n');
}

/** `stroq help --all`: every command that is not plumbing, one line each, by job. */
export function usageAll(): string {
  const groups = SECTIONS.flatMap((section) => [
    '',
    `${section.title}:`,
    ...section.commands.map(row),
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
