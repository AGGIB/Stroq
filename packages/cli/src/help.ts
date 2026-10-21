// The one place a command's usage is written down. `stroq <command> --help`,
// `stroq help <command>` and the unknown-option check are all read from `COMMANDS`, so a
// flag a command parses but this table omits fails `test/help.test.ts` rather than going
// missing from the help. The short lists, `stroq --help` and `stroq help --all`, and the
// tier of each command are in help-listing.ts.

export { tierOf, usage, usageAll, type Tier } from './help-listing.js';

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

export const COMMANDS: readonly CommandHelp[] = [
  {
    name: 'add',
    synopsis:
      'add <local-source|installed-name> [--user] [--restore] [--rollback] [--kind skill|mcp] [--client <name>|--config <path>] [--entrypoint <file>] [--pass-env <names>] [--name <name>] [--cwd <dir>] [--strict] [--force]',
    about: [
      'install a skill from a local folder or tar archive, after a check. Stroq reads',
      'the files and shows a report with a sha256 fingerprint. To install, you type',
      'the first 12 characters of its fingerprint. Stroq then installs exactly the',
      'files it showed you, even if the folder changes while you read.',
      'Give the name of something you installed to update it from the same place.',
      'The report says what Stroq saw. It does not prove the files are safe.',
      'With --kind mcp, it adds a local Node MCP server the same way: Stroq keeps a',
      "copy, and the client's config starts only that copy. Only Node servers work.",
      'With --strict, Stroq holds back any message from the server that it could not',
      'fully read and scan. Changing that later needs the typed fingerprint again;',
      'an update keeps it.',
    ],
    flags: [
      ['--user', "install into ~/.claude/skills instead of this project's .claude/skills"],
      ['--restore', 'restore an installed skill or MCP wrapper from confirmed store bytes'],
      ['--rollback', 'roll back an updated skill or MCP server to its previous stored revision'],
      ['--kind <kind>', 'skill (default) or mcp'],
      ['--client <name>', 'with --kind mcp: the client whose config gets the entry'],
      ['--config <path>', 'with --kind mcp: the client config file to edit'],
      ['--entrypoint <file>', 'with --kind mcp: the start file, when package.json does not say'],
      ['--pass-env <names>', 'with --kind mcp: comma-separated variables the server may see'],
      ['--name <name>', 'with --kind mcp: the server name in the config'],
      ['--cwd <dir>', 'with --kind mcp: the project directory decisions are made for'],
      ['--strict', 'with --kind mcp: confirm strict mode in the pinned wrapper'],
      ['--force', 'with --kind mcp: update an entry changed outside Stroq'],
    ],
  },
  {
    name: 'remove',
    synopsis:
      'remove <name> [--user] [--force] [--kind skill|mcp] [--client <name>|--config <path>]',
    about: [
      'remove a confirmed skill after a terminal y/N question, and record a receipt;',
      'with --kind mcp, delete the config entry or restore the one it replaced',
      'For a wrapper with no lock record, give --force and --client or --config.',
    ],
    flags: [
      ['--user', "remove from ~/.claude/skills instead of this project's .claude/skills"],
      [
        '--force',
        'also remove a skill or entry changed outside Stroq; still requires a person at a terminal',
      ],
      ['--kind <kind>', 'skill (default) or mcp'],
      ['--client <name>', 'with --kind mcp: the client config containing an orphan wrapper'],
      ['--config <path>', 'with --kind mcp: the explicit config containing an orphan wrapper'],
    ],
  },
  {
    name: 'init',
    synopsis: 'init [--agent <name>] [--user] [--dry-run] [--yes] [--no-input]',
    about: [
      "install Stroq's hooks into an agent, in this project by default. The agent then",
      'calls Stroq on its tool calls, and Stroq can block one or ask you first.',
      'With --agent mcp, it routes the MCP servers a client starts through Stroq instead.',
      'On a terminal it shows what it will change and asks first. For Claude Code, Codex,',
      'Cursor and Antigravity it then checks that the hook it wrote starts and answers.',
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
      [
        '--strict',
        'with --agent mcp: withhold any server message Stroq could not fully read and scan; keeps wrappers confirmed by add unchanged and prints the add --strict --force confirmation command',
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
    name: 'task',
    synopsis:
      'task [--profile repo-edit-and-test] [--read <glob>] [--write <glob>] [--ttl 30m] -- "<task>"',
    about: [
      'preview and confirm a signed Claude Code task; srt is required by default',
      'The parent controller judges hooks; --hook-only is advisory without OS isolation.',
    ],
    flags: [
      ['--profile <name>', 'repo-edit-and-test'],
      ['--read <glob>', 'read allowlist; repeat; default project/**'],
      ['--write <glob>', 'write allowlist; repeat; default project/**'],
      ['--ttl <duration>', '1m through 24h, default 30m'],
      ['--hook-only', 'explicit advisory mode without a sandbox'],
    ],
    passThrough: true,
  },
  {
    name: 'permit',
    synopsis: 'permit list | show <task> | extend <task> <fingerprint> | revoke <task>',
    about: ['inspect signed tasks, confirm a refused exact operation once, or revoke a task'],
    flags: [],
  },
  {
    name: 'mcp',
    synopsis: 'mcp --server <name> [--pin sha256:<digest>] [--cloak] [--strict] -- <command> …',
    about: [
      'the stdio MCP proxy `init --agent mcp` writes into a client config: judges every',
      'tools/call against your policy and scans every result on its way back.',
      'With --strict, a server message Stroq could not fully read and scan is withheld',
      'instead of forwarded: it filters what the client receives, it is not a sandbox',
    ],
    flags: [
      ['--server <name>', 'the server name from the client config'],
      ['--client <name>', 'the client, for the session id and the audit'],
      ['--cwd <dir>', 'the project directory decisions are made for'],
      ['--session <id>', 'the session id; default mcp:<client>'],
      ['--pass-env <names>', 'comma-separated variables the server is started with'],
      ['--pin sha256:<digest>', 'run only locally confirmed server bytes from a private copy'],
      ['--cloak', 'replace detected values in results before the model reads them'],
      [
        '--strict',
        'withhold what cannot be fully scanned (oversize, unparsable, unread fields, unsolicited messages) and answer the request with an error',
      ],
      [
        '--strict-max-withheld <n>',
        'with --strict: end a server with more than n malformed or hostile messages withheld (default 20); log lines, progress messages and the like have their own cap of 1000',
      ],
    ],
    passThrough: true,
  },
  {
    name: 'doctor',
    synopsis: 'doctor [--all] [--json]',
    about: [
      'check the installation: Node, rules, the hooks of every agent',
      'and when each was last called, a self-test',
    ],
    flags: [
      ['--all', 'list every agent and scope, installed or not'],
      ['--json', 'machine-readable output (version 1)'],
    ],
  },
  {
    name: 'prove',
    synopsis: 'prove [--agent <id>] [--yes] [--dry-run] [--json] [--max-requests <n>]',
    about: [
      'check that blocking really works on this machine. Your agent runs 3 harmless',
      'commands with the hook in place. Stroq checks that the ones your policy blocks did',
      'not run, and that they do run with the hook out of the way. It checks the files the',
      "commands leave and its own log, not the agent's reply.",
      'It makes up to 3 short requests on your own login (your subscription, never an API',
      'key). It says so and asks first. Exit 0: it works. 1: it failed. 3: anything else.',
    ],
    flags: [
      [
        '--agent <id>',
        'claude-code (default, macOS/Linux) or codex (Windows, measured CLI 0.162.1 only)',
      ],
      ['--yes', 'make the requests without asking; needed where there is no terminal to ask on'],
      ['--dry-run', 'say what would be done, make no request and write nothing'],
      ['--json', 'machine-readable output (version 1)'],
      ['--max-requests <n>', 'the most requests to make, 1 to 6 (default 3)'],
    ],
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
      'sent [<session>] [--here] [--last] [--transcript <path>] [--try] [--json] [--counts] [--card [--html] [--out <file>]] [--fail-if third-party|any]',
    about: [
      'did your AI agent pass your keys on? Checks every session on this machine and says',
      'where each key went. Prints names, never a value, and writes nothing',
    ],
    flags: [
      ['--here', 'only the sessions of this project'],
      [
        '--last',
        'only the newest session of this project (this directory, or the folder above it)',
      ],
      ['--transcript <path>', 'one transcript or rollout'],
      ['--try', 'run the check on a built-in sample with a made-up key; reads nothing'],
      ['--json', 'the full report as JSON, never a value'],
      ['--counts', 'numbers only, as JSON: no names, paths or hosts'],
      ['--card', 'a card to share: counts and services only'],
      ['--html', 'with --card: one HTML file with no script and no external resource'],
      ['--out <file>', 'with --card: write it to a file that does not exist yet'],
      ['--fail-if <level>', 'exit 1 when a key was found: third-party or any'],
      ['--fail-on-finding', 'the same as --fail-if any'],
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
    synopsis: 'attack [--json] [--only <id>] [--fuzz] [--host <id>]',
    about: [
      'replay recorded attacks against your policy; exit 1 if any gets through or could not be judged',
    ],
    flags: [
      ['--json', 'machine-readable output'],
      ['--only <id>', 'one scenario, e.g. 05'],
      ['--fuzz', 'cross every scenario with every mutation and print the ones that escape'],
      [
        '--host <id>',
        'claude-code, cursor, codex, copilot, openclaw, windsurf, antigravity or mcp: filter by what the host can actually see',
      ],
    ],
  },
  {
    name: 'policy',
    synopsis:
      'policy check [<file>] [--json] | policy test [--policy <file>] [--baseline <file>] [--cases <file>] [--max-new-interruptions <n>] [--json]',
    about: [
      'see what an edit to your policy.yaml does before you rely on it; both only read. check',
      'loads a file as the hook does and lists what is wrong: faults by field, a rule that can',
      'never be the first match, a protection of the default policy the file quietly drops,',
      'default: allow, a high threshold; exit 1 on a finding. test replays the attack corpus,',
      'the ordinary-work benchmark and your own cases under the policy and under a baseline,',
      'and prints every step whose decision changed; exit 1 if an attack gets through, a case',
      'is not met, something could not be judged, or ordinary work is newly interrupted more',
      'than --max-new-interruptions allows. Exit 2: wrong command line or an unreadable file',
    ],
    flags: [
      ['--policy <file>', 'test: the policy to try (default: the policy in force)'],
      [
        '--baseline <default|file>',
        'test: what to compare it with (default: the built-in default policy)',
      ],
      [
        '--cases <file>',
        'test: your own cases, YAML or JSON, up to 256 KiB and 200 cases: attacks that must not pass, and ordinary work with the answer you expect (allow, ask or deny)',
      ],
      [
        '--max-new-interruptions <n>',
        'test: fail when more steps of ordinary work than this newly ask or deny',
      ],
      ['--json', 'machine-readable output (version 1)'],
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
    synopsis:
      'inspect [<dir>] [--changed-from <rev>] [--format text|json|sarif|github] [--fail-on new|any|none] [--env]',
    about: [
      'read what a repository runs before you open it with an agent or editor. Exit 1 when',
      'something fails the check, 2 for a usage error, 3 when the check cannot run',
    ],
    flags: [
      ['--changed-from <rev>', 'compare with <rev> and mark each entry new, changed or present'],
      [
        '--format <text|json|sarif|github>',
        'github: a job summary on stdout, annotations on stderr',
      ],
      ['--fail-on <new|any|none>', 'what fails: new (needs --changed-from, its default) or any'],
      ['--json', 'the same as --format json'],
      ['--sarif', 'the same as --format sarif (SARIF 2.1.0, for code scanning)'],
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
    synopsis:
      'bench [--corpus <dir> | --actions | --latency] [--n <count>] [--warmup <count>] [--json] [--verbose]',
    about: [
      'measure how much benign developer text the rule set flags,',
      '(--actions) how much ordinary agent work your policy interrupts,',
      'or (--latency) what a hook call costs in processor and wall time (p50/p95/p99)',
    ],
    flags: [
      ['--corpus <dir>', 'measure your own files instead of the shipped corpus'],
      ['--actions', 'replay 75 scenarios of ordinary agent work against your policy'],
      ['--latency', 'measure hook invocation processor and wall time on claude-code'],
      ['--n <count>', 'number of measured runs per event (default 100)'],
      ['--warmup <count>', 'number of warmup runs per event (default 5)'],
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
  {
    name: 'harden',
    synopsis:
      'harden [plan|apply|undo|status] [--agent <id>] [--scope user|project] [--recipe <name>] [--json] [--yes]',
    about: [
      "make the host's own protection of credential files stronger, and give it back. plan (the",
      'default) shows exactly what would change and writes nothing; apply asks you, then changes the',
      'file and keeps what undo needs; undo takes it back; status says what is in place. Recipes:',
      "claude-read-deny (read rules in Claude Code's settings) and cursor-ignore (a block in",
      '.cursorignore). A filter inside the host, a best effort and not a guarantee: a program that',
      'reads the file itself is not covered, and only an OS sandbox covers that.',
      'Exit codes: 0 done or nothing to do, 1 refused or failed, 2 wrong command line, 3 a flag is missing',
    ],
    flags: [
      ['--agent <id>', 'claude-code (the default) or cursor'],
      [
        '--scope <user|project>',
        "user: the person's own settings, ~/.claude/settings.json (the default for claude-code); project: this folder, .claude/settings.local.json, or .cursorignore for cursor (the only scope of cursor)",
      ],
      ['--recipe <name>', 'claude-read-deny or cursor-ignore; the agent follows from it'],
      ['--json', 'machine-readable output, with plan, apply and status'],
      [
        '--yes',
        'with apply and undo: answer the question yourself. On a terminal they ask first; anywhere else they do nothing without it',
      ],
      [
        '--acknowledge-link',
        'the path is a link and the change lands in the file it leads to. A plan hides its diff until it is given',
      ],
      [
        '--acknowledge-credential-loss',
        'apply may replace a value that looks like a credential; no copy of it is kept, so undo cannot put it back',
      ],
      [
        '--acknowledge-reformat',
        'apply may lay the whole file out again, not only the lines it adds',
      ],
    ],
  },
  {
    name: 'vet',
    synopsis:
      'vet --from <dir or .tgz> [--online <source>] [--kind skill|mcp|plugin] [--probe] [--entrypoint <file>] [--json | --card] [--expect <sha256>] [--out <file>]',
    about: [
      'read a skill, an MCP server or a plugin, from a folder, a tar archive, or online from npm or GitHub,',
      'before you add it, and show its passport: what it asks for or can do, each line marked declared, observed,',
      'limited or unknown, the rules that matched, and every blind spot. The files are read and none of them is run',
      'unless --probe is explicitly requested for an MCP server in a sandbox. A reading, not a security certificate:',
      'an absent line means nothing was seen, not that nothing is there. Exit codes: 0 the passport is complete, 1 --expect',
      'did not match or a reading failed, 2 wrong command line, 3 the files cannot be read as an artifact',
    ],
    flags: [
      [
        '--from <dir or .tgz>',
        'the folder or the archive to read. An archive is a tar file, plain or gzipped (.tgz, .tar.gz, .tar), as npm pack and git archive write it: it is read in memory, never unpacked to a disk, and refused if it holds a link, a device, a sparse file or a path that climbs out. In a folder, .git and node_modules are left out, and it says so',
      ],
      [
        '--online <source>',
        'read a package from npm (npm:<package>[@version|tag]), GitHub (github:<owner>/<repo>[#ref][:subdir]), or an https URL (https://<host>/<path>.tgz). The host is printed before any request; downloads are kept in memory and held to 20 MiB compressed',
      ],
      [
        '--kind <skill|mcp|plugin>',
        'what the folder or archive is, when its files do not say (or say two things)',
      ],
      [
        '--json',
        'the passport itself, in a canonical form: the same bytes for the same files, so that an author can commit it',
      ],
      [
        '--expect <sha256>',
        'exit 1 unless the digest of the files is this one (64 hex digits, bare or as sha256:<hex>). Not for a folder on Windows, where it has no executable bit and its digest depends on the platform; an archive carries its own and works there',
      ],
      [
        '--card',
        'a Markdown snippet for a README: the name, the digest, the counts and the command that reproduces it, and nothing else from the artifact',
      ],
      [
        '--out <file>',
        "write the output to a file that does not exist yet, never over one. Write it outside the folder it describes: inside, it is one of that folder's files and changes its digest",
      ],
      [
        '--probe',
        'run a sandboxed stdio MCP handshake (initialize and paginated tools/list) using srt on macOS or Linux after terminal confirmation; limits: 20 pages, 500 tools, 10 MiB, 10 s timeout',
      ],
      [
        '--entrypoint <file>',
        'the start file of an MCP server (.js, .mjs, .cjs) when package.json does not declare one',
      ],
    ],
  },
];

const byName = new Map(COMMANDS.map((c) => [c.name, c]));

/** The name of every command, hidden ones included. */
export const commandNames = (): readonly string[] => COMMANDS.map((c) => c.name);

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

/**
 * Words that are not commands of Stroq but that a person will type, and what to say to them. A Map and
 * not an object, so that `constructor` and `__proto__` are words with no hint and not properties.
 */
const HINTS: ReadonlyMap<string, string> = new Map([
  [
    'install',
    'stroq has no install: `stroq init` guards an agent, `stroq add` adds a local skill after a check.',
  ],
]);

/** What to say to a word that is not a command, in one line, or null when there is nothing special to say. */
export function commandHint(typed: string): string | null {
  return HINTS.get(typed.toLowerCase()) ?? null;
}

/**
 * The closest command to a typo, or null when nothing is close. A word that has a hint gets none: "install"
 * is two letters from "uninstall", the one command that takes Stroq out, which is the opposite of what the
 * person who typed it wants.
 */
export function suggestCommand(typed: string): string | null {
  if (commandHint(typed) !== null) return null;
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
