// The one place a command's usage is written down. The top-level `stroq --help`,
// `stroq <command> --help`, `stroq help <command>` and the unknown-option check are
// all read from `COMMANDS`, so a flag a command parses but this table omits fails
// `test/help.test.ts` rather than going missing from the help.

/** One flag: how it is written, and what it does. */
type Flag = readonly [spelling: string, meaning: string];

interface CommandHelp {
  readonly name: string;
  /** Everything after `stroq `, as the top-level list prints it. */
  readonly synopsis: string;
  /** What the command does, a line or three. */
  readonly about: readonly string[];
  readonly flags: readonly Flag[];
  /** Arguments after `--` belong to another program; flags there are not checked. */
  readonly passThrough?: boolean;
}

const COMMANDS: readonly CommandHelp[] = [
  {
    name: 'init',
    synopsis: 'init [--agent <name>] [--user] [--dry-run] [--yes] [--no-input]',
    about: [
      'install hooks for an agent, in this project by default,',
      "or wrap an MCP client's stdio servers in Stroq's proxy (--agent mcp).",
      'On a terminal it shows what it will change, asks first and, for Claude',
      'Code, Codex, Cursor and Antigravity, checks that the hook it wrote starts',
      'and judges. On Windows it writes the hook line of Antigravity, Cursor and',
      'Codex without quotes (a host that escapes each quote cannot start a line',
      'that has one) and starts it through cmd.exe, as such a host does, before',
      'it keeps it.',
    ],
    flags: [
      [
        '--agent <name>',
        'claude-code, cursor, codex, copilot, openclaw, windsurf, antigravity or mcp. With none, on a terminal: every agent it found (claude-code when none), after it has asked. In a script, in CI or with --no-input: claude-code when it is installed or nothing is; the one other agent when only one is; with several, nothing is installed and the command for each is printed',
      ],
      ['--user', "install into the user's config instead of this project's"],
      ['--dry-run', 'print the change and write nothing'],
      [
        '--yes',
        'on a terminal, init shows what it will change and asks first; --yes answers for you (with no --agent, it guards every agent it found)',
      ],
      ['--no-input', 'never ask, and print the plain installer output (what scripts and CI get)'],
      ['--client <name>', 'with --agent mcp: claude-desktop, windsurf, cursor or claude-code'],
      ['--config <path>', 'with --agent mcp: any file with an "mcpServers" object'],
      ['--unwrap', 'with --agent mcp: put every wrapped server back the way it was'],
      [
        '--cloak',
        'with --agent mcp: replace detected values in results before the model reads them',
      ],
    ],
  },
  {
    name: 'uninstall',
    synopsis: 'uninstall [--agent <name>] [--user] [--dry-run]',
    about: [
      "take Stroq's hooks out of an agent's config, leaving everything else in it as it",
      'was; with --agent mcp, put every wrapped MCP server back',
    ],
    flags: [
      ['--agent <name>', 'the agent to remove Stroq from, as for init (default claude-code)'],
      ['--user', "remove from the user's config instead of this project's"],
      ['--dry-run', 'print the result and change nothing'],
      ['--client <name>', 'with --agent mcp: the client whose servers to unwrap'],
      ['--config <path>', 'with --agent mcp: the config file to unwrap'],
    ],
  },
  {
    name: 'hook',
    synopsis: 'hook <agent> [<phase>]',
    about: [
      'the entrypoint an agent runs on every tool call: reads the event JSON on stdin and',
      'prints a decision. Agents: claude-code, cursor, codex, windsurf, copilot <pre|post>,',
      'openclaw <pre|post>, antigravity <pre|post|preinvocation>. `stroq init` writes it',
    ],
    flags: [],
  },
  {
    name: 'run',
    synopsis: 'run [--sandbox] [--agent <id>] -- <agent> …',
    about: [
      'start an agent already confined: sets the git settings that stop a repository',
      'running a command during the startup "git status", refuses to launch into a',
      'repository that runs something before you could approve it, and checks that',
      "Stroq's hooks are installed for that agent",
    ],
    flags: [
      ['--agent <id>', 'the agent whose hooks to check, when the command does not say'],
      [
        '--sandbox',
        "also wrap the launch in Anthropic's srt, with this machine's credential files unreadable",
      ],
      ['--allow-domain <host>', 'with --sandbox: a host the agent may reach; repeat for more'],
      ['--no-inspect', 'skip reading what the repository runs'],
      ['--force', 'launch even after printing a refusal'],
      ['--dry-run', 'print what would run and start nothing'],
    ],
    passThrough: true,
  },
  {
    name: 'mcp',
    synopsis: 'mcp --server <name> [--cloak] -- <command> …',
    about: [
      'the stdio MCP proxy `init --agent mcp` writes into a client config: judges every',
      'tools/call against your policy and scans every result on its way back',
    ],
    flags: [
      ['--server <name>', 'the server name from the client config'],
      ['--client <name>', 'the client, for the session id and the audit'],
      ['--cwd <dir>', 'the project directory decisions are made for'],
      ['--session <id>', 'the session id; default mcp:<client>'],
      ['--pass-env <names>', 'comma-separated variables the server is started with'],
      ['--cloak', 'replace detected values in results before the model reads them'],
    ],
    passThrough: true,
  },
  {
    name: 'doctor',
    synopsis: 'doctor [--all]',
    about: [
      'check the installation: Node, rules, the hooks of every agent',
      'and when each was last called, a self-test',
    ],
    flags: [['--all', 'list every agent and scope, installed or not']],
  },
  {
    name: 'log',
    synopsis: 'log [--count 20] [--json]',
    about: ['show recent audit entries'],
    flags: [
      ['--count <n>', 'how many entries, newest last (default 20)'],
      ['--json', 'one JSON object per line'],
    ],
  },
  {
    name: 'verify',
    synopsis: 'verify',
    about: ['verify the hash chain of the audit log'],
    flags: [],
  },
  {
    name: 'untaint',
    synopsis: 'untaint [--session <id>] [--all]',
    about: [
      "clear a false-positive session's taint and provenance, or every session's.",
      '`stroq why` and `stroq log` show the session id',
    ],
    flags: [
      ['--session <id>', 'the session to clear'],
      ['--all', 'clear every session'],
    ],
  },
  {
    name: 'why',
    synopsis: 'why [--seq <n>]',
    about: ['explain the most recent denied or asked action: rule, provenance, taint'],
    flags: [['--seq <n>', 'explain the audit entry with this sequence number instead']],
  },
  {
    name: 'replay',
    synopsis:
      'replay [<session>] [--last] [--transcript <path>] [--json] [--list] [--html] [--out <file>]',
    about: [
      'rebuild the recorded sequence: which content the agent read, and which later',
      "actions matched it. --last reads the agent's own transcript, so it works on",
      'sessions that ran before you installed',
    ],
    flags: [
      [
        '--last',
        'the newest session recorded for this project (this directory, or the folder above it)',
      ],
      ['--transcript <path>', 'a specific transcript'],
      ['--json', 'machine-readable output'],
      ['--list', 'list the sessions in the audit log'],
      ['--html', 'one HTML file with the chain drawn (no script, no link, no external resource)'],
      ['--out <file>', 'write the page to a file that does not exist yet'],
    ],
  },
  {
    name: 'sent',
    synopsis:
      'sent [<session>] [--last] [--transcript <path>] [--json] [--card [--html] [--out <file>]] [--fail-on-finding]',
    about: [
      'which credentials appear in a recorded agent session, and in which tool result',
      'or call. Reads names and sources only, never a value',
    ],
    flags: [
      [
        '--last',
        'the newest session recorded for this project (this directory, or the folder above it)',
      ],
      ['--transcript <path>', 'a specific transcript or rollout'],
      ['--json', 'machine-readable output'],
      [
        '--card',
        'a card to share instead of the report: counts, providers and the limits of the check, no value, name, path, command or hash',
      ],
      ['--html', 'with --card: one HTML file with no script and no external resource'],
      ['--out <file>', 'with --card: write it to a file that does not exist yet'],
      ['--fail-on-finding', 'exit 1 when a credential is found'],
    ],
  },
  {
    name: 'canary',
    synopsis: 'canary [--name <NAME>] [--file <path>]',
    about: [
      'print a canary secret to plant, or plant it as a decoy file. Its outbound use, or',
      'any call naming the file, is denied and taints the session',
    ],
    flags: [
      ['--name <NAME>', 'the variable name to print it under (default STROQ_CANARY_KEY)'],
      ['--file <path>', 'create a credentials-shaped decoy file holding it'],
    ],
  },
  {
    name: 'attack',
    synopsis: 'attack [--json] [--only <id>] [--fuzz]',
    about: ['replay recorded attacks against your policy; exit 1 if any gets through'],
    flags: [
      ['--json', 'machine-readable output'],
      ['--only <id>', 'one scenario, e.g. 05'],
      ['--fuzz', 'cross every scenario with every mutation and print the ones that escape'],
    ],
  },
  {
    name: 'exposure',
    synopsis: 'exposure [--probe] [--share] [--json] [--verbose]',
    about: ["map this machine's agent surface and report what reaches you; exit 1 on a finding"],
    flags: [
      ['--probe', 'start your MCP servers once to read their tool descriptions'],
      ['--share', 'print a redacted summary you can paste'],
      ['--json', 'machine-readable output'],
      ['--verbose', 'list every file behind a count'],
    ],
  },
  {
    name: 'inspect',
    synopsis: 'inspect [<dir>] [--json|--sarif] [--env]',
    about: ['read what a repository runs before you open it with an agent'],
    flags: [
      ['--json', 'machine-readable output'],
      ['--sarif', 'SARIF 2.1.0, for code scanning'],
      ['--env', 'print the git settings that neutralise it'],
    ],
  },
  {
    name: 'trust',
    synopsis: 'trust [<file>] [--list] [--remove <file>] [--json]',
    about: [
      "waive a false positive on a file's exact content; any change to the file taints",
      'again. Without arguments, list what is trusted',
    ],
    flags: [
      ['--list', 'list trusted files'],
      ['--remove <file>', 'stop trusting a file'],
      ['--json', 'machine-readable output'],
    ],
  },
  {
    name: 'bench',
    synopsis: 'bench [--corpus <dir> | --actions] [--json] [--verbose]',
    about: [
      'measure how much benign developer text the rule set flags,',
      'or (--actions) how much ordinary agent work your policy interrupts',
    ],
    flags: [
      ['--corpus <dir>', 'measure your own files instead of the shipped corpus'],
      ['--actions', 'replay 75 scenarios of ordinary agent work against your policy'],
      ['--json', 'machine-readable output'],
      ['--verbose', 'list the flagged files'],
    ],
  },
  {
    name: 'coverage',
    synopsis: 'coverage [--format table|navigator] [--json]',
    about: ['the control mapping against MITRE ATLAS and OWASP ASI'],
    flags: [
      ['--format <table|navigator>', 'navigator emits an ATT&CK Navigator layer'],
      ['--json', 'machine-readable output'],
    ],
  },
];

const byName = new Map(COMMANDS.map((c) => [c.name, c]));
const INDENT = 37;

const START_INDENT = 22;

/** What a newcomer runs, in order: the rest of the list is for later. */
const START_HERE: readonly (readonly [string, string])[] = [
  ['stroq init', 'guard the agents on this machine (it asks first)'],
  ['stroq sent --last', 'which of your keys did your agent already see?'],
  ['stroq doctor', 'are the hooks in place, and was Stroq called?'],
];

/** `stroq --help`: every command, one block each. */
export function usage(): string {
  const blocks = COMMANDS.map((c) => {
    const head = `  ${c.synopsis}`;
    const [first = '', ...more] = c.about;
    const lines =
      head.length < INDENT - 1
        ? [`${head.padEnd(INDENT)}${first}`, ...more.map((l) => `${' '.repeat(INDENT)}${l}`)]
        : [head, ...c.about.map((l) => `${' '.repeat(INDENT)}${l}`)];
    return lines.join('\n');
  });
  return [
    'stroq <command>',
    '',
    'Start here:',
    ...START_HERE.map(([command, meaning]) => `${`  ${command}`.padEnd(START_INDENT)}${meaning}`),
    '',
    'Commands:',
    ...blocks,
    `${'  help [<command>]'.padEnd(INDENT)}this list, or one command's options`,
    `${'  --version'.padEnd(INDENT)}print the CLI version`,
    '',
    'Run "stroq <command> --help" for its options.',
    '',
  ].join('\n');
}

/** `stroq <command> --help`, or null for a name that is not a command. */
export function commandHelp(name: string): string | null {
  const c = byName.get(name);
  if (c === undefined) return null;
  const width = Math.max(0, ...c.flags.map(([spelling]) => spelling.length)) + 4;
  return [
    `stroq ${c.synopsis}`,
    '',
    ...c.about.map((line) => `  ${line}`),
    ...(c.flags.length === 0
      ? []
      : [
          '',
          'Options:',
          ...c.flags.map(([spelling, meaning]) => `  ${spelling.padEnd(width)}${meaning}`),
        ]),
    '',
  ].join('\n');
}

/** Arguments before the `--` a pass-through command hands to another program. */
function ownArgs(name: string, args: readonly string[]): readonly string[] {
  if (byName.get(name)?.passThrough !== true) return args;
  const end = args.indexOf('--');
  return end === -1 ? args : args.slice(0, end);
}

export function wantsHelp(name: string, args: readonly string[]): boolean {
  return ownArgs(name, args).some((arg) => arg === '--help' || arg === '-h');
}

/** The first option `name` does not have, or null. Values and positionals are not options. */
export function unknownOption(name: string, args: readonly string[]): string | null {
  const c = byName.get(name);
  if (c === undefined) return null;
  const known = new Set([
    '--help',
    '-h',
    ...c.flags.map(([spelling]) => spelling.split(/[\s|<]/)[0]),
  ]);
  for (const arg of ownArgs(name, args)) {
    if (!arg.startsWith('-') || arg === '-' || arg === '--') continue;
    const option = arg.split('=')[0] ?? arg;
    if (!known.has(option)) return option;
  }
  return null;
}

/** What a usage error prints, from the command and what was wrong with it. */
export function usageError(name: string, problem: string): string {
  return `stroq ${name}: ${problem}\nRun "stroq ${name} --help" to see its options.\n`;
}

/**
 * `node:util.parseArgs` throws `ERR_PARSE_ARGS_*` with a message written for the
 * developer of the CLI ("To specify a positional argument starting with a '-', …").
 * The first sentence is the part a user can act on.
 */
export function parseArgsProblem(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !code.startsWith('ERR_PARSE_ARGS_')) return null;
  const message = err instanceof Error ? err.message : String(err);
  const first = message.split(/(?<=\.)\s/)[0] ?? message;
  return first.replace(/\.$/, '');
}

/** The closest command to a typo, or null when nothing is close. */
export function suggestCommand(typed: string): string | null {
  let best: string | null = null;
  let bestDistance = 3;
  for (const { name } of COMMANDS) {
    const d = distance(typed.toLowerCase(), name);
    if (d < bestDistance) {
      best = name;
      bestDistance = d;
    }
  }
  return best;
}

/** Levenshtein distance, with an adjacent swap counted as one edit. */
function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = rows[i]!;
      const above = rows[i - 1]!;
      row[j] = Math.min(above[j]! + 1, row[j - 1]! + 1, above[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        row[j] = Math.min(row[j]!, rows[i - 2]![j - 2]! + 1);
    }
  }
  return rows[a.length]![b.length]!;
}
