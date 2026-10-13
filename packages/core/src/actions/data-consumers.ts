import type { Resolved, Word } from './shell-words.js';

/**
 * What a fetch or a decode may be piped into without a question: a command that reads its input as
 * data and does nothing else with it. `curl url | jq .a` and `curl url | head -5` read; `curl url |
 * sqlite3`, `curl url | vim -es` and `curl url | script -q /dev/null sh` run what they read, and so
 * does any program Stroq has not heard of. A list of the programs that run their input is never
 * finished (a reviewer found five that were not on it in half an hour), and a list of the ones that do
 * not is short: in the 642 pipelines of one developer's Claude Code and Codex history in which a fetch
 * or a decode is followed by another stage, the stages are `tail`, `head`, `grep`, `jq`, `sort`, `sed`,
 * `cut`, `uniq`, `tee`, `tr`, `column`, `wc` and `echo`, and a Python or a Node. So this is the list
 * of what reads, and a command that is not on it is a question.
 *
 * A name is trusted as a name: `./head`, `/tmp/head` and a function that the command defines under the
 * name (`head() { sh; }`) are not `head`.
 */
export const DATA_CONSUMERS: ReadonlySet<string> = new Set([
  // Filters and counters.
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'sort',
  'uniq',
  'wc',
  'cut',
  'tr',
  'tee',
  'column',
  'fold',
  'fmt',
  'nl',
  'pr',
  'expand',
  'unexpand',
  'tac',
  'rev',
  'paste',
  'join',
  'comm',
  'diff',
  'cmp',
  'sdiff',
  'colordiff',
  'delta',
  'shuf',
  'split',
  'csplit',
  'cat',
  'less',
  'more',
  'bat',
  'batcat',
  'most',
  'pv',
  'ts',
  'sponge',
  // Formats.
  'jq',
  'yq',
  'xq',
  'gron',
  'jless',
  'htmlq',
  'pup',
  'hq',
  'xmllint',
  'tidy',
  'html2text',
  'glow',
  'mdcat',
  // Encodings, sums and compression.
  'base64',
  'basenc',
  'xxd',
  'hexdump',
  'od',
  'strings',
  'file',
  'iconv',
  'dos2unix',
  'unix2dos',
  'md5',
  'md5sum',
  'sha1sum',
  'sha224sum',
  'sha256sum',
  'sha384sum',
  'sha512sum',
  'shasum',
  'cksum',
  'b2sum',
  'sum',
  'gzip',
  'gunzip',
  'zcat',
  'bzip2',
  'bunzip2',
  'bzcat',
  'xz',
  'unxz',
  'xzcat',
  'zstd',
  'unzstd',
  'zstdcat',
  'lz4',
  'lzma',
  'unlzma',
  'pigz',
  'tar',
  // Where text goes: the clipboard, the screen.
  'pbcopy',
  'xclip',
  'xsel',
  'wl-copy',
  'clip',
  'echo',
  'printf',
  'true',
  'false',
  ':',
  'yes',
  'seq',
  'sleep',
  'date',
  'tput',
  'clear',
  'cd',
  'pwd',
  // Builtins that take their input as text.
  'read',
  'mapfile',
  'readarray',
]);

/**
 * The words of the shell's own structure: the stage that holds one is a loop or a group, and what
 * runs in it is each command that is in it, read for itself.
 */
export const STRUCTURE_WORDS: ReadonlySet<string> = new Set([
  'for',
  'while',
  'until',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'select',
  '{',
  '}',
  '(',
  ')',
  '!',
  'function',
  'time',
  'coproc',
]);

/**
 * How a listed command can be made to run a program: the options that name one. A tool that parses
 * its options with `getopt_long` takes any unambiguous start of a long option for it (`--use-comp` is
 * `--use-compress-program`), so a long option that is the start of one named here is read as it is;
 * a short option is a letter of a cluster (`-xIf`), or of the bundle that `tar` takes without a dash
 * (`tar xIf`). A tool that matches names exactly (`xmllint`) is matched exactly.
 */
interface RunsAProgram {
  /** Long options, by name: `to-command` for `--to-command`. */
  readonly long: readonly string[];
  /** Short options, as the letters that make one: `IF` for `-I` and `-F`. */
  readonly short?: string;
  /** Options that take one dash and have no short form (`xmllint -shell`). */
  readonly single?: readonly string[];
  /** The tool matches a long option's name exactly, not by its start. */
  readonly exact?: boolean;
  /** The first word may be a bundle of short options without a dash (`tar xzf`). */
  readonly bundle?: boolean;
}

const PAGER_OPTION: RunsAProgram = { long: ['pager'] };

/**
 * Options of a listed command that make it run a program: `tar --to-command=sh` pipes each file of
 * the archive into one, `sort --compress-program=sh`, `split --filter=sh`, `bat --pager sh` and
 * `rg --pre sh` start one with the data, `xmllint --shell` reads commands, and `mapfile -C` calls
 * one for each line. One of these makes the stage a question.
 */
const RUNS_A_PROGRAM: Readonly<Record<string, RunsAProgram>> = {
  tar: {
    long: [
      'to-command',
      'checkpoint-action',
      'use-compress-program',
      'rsh-command',
      'rmt-command',
      'info-script',
      'new-volume-script',
      'index-file',
      'transform-command',
    ],
    short: 'IF',
    bundle: true,
  },
  sort: { long: ['compress-program'] },
  split: { long: ['filter'] },
  bat: PAGER_OPTION,
  batcat: PAGER_OPTION,
  delta: PAGER_OPTION,
  ag: PAGER_OPTION,
  ack: PAGER_OPTION,
  rg: { long: ['pre', 'pre-glob'] },
  xmllint: { long: ['shell', 'pretty-shell'], single: ['shell'], exact: true },
  mapfile: { long: [], short: 'C' },
  readarray: { long: [], short: 'C' },
};

/**
 * Commands that read their input as data for some subcommands and are a question for the rest:
 * `docker load` imports an image from a stream, and `docker run -i alpine sh` runs a shell.
 */
const READING_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  docker: new Set(['load', 'import']),
  podman: new Set(['load', 'import']),
};

/** Where a program the system owns lives: a name written with one of these directories is the name. */
const SYSTEM_DIRECTORY =
  /^(?:\/usr\/(?:local\/)?(?:s?bin)|\/s?bin|\/opt\/homebrew\/s?bin|\/home\/linuxbrew\/\.linuxbrew\/bin)\/[\w.+-]+$/;

/** Whether `option` is one of the options that `guard` says run a program. */
function runsAProgram(guard: RunsAProgram, option: string): boolean {
  if (option.startsWith('--')) {
    const name = option.slice(2).split('=')[0] ?? '';
    return (
      name !== '' &&
      guard.long.some((long) => (guard.exact === true ? long === name : long.startsWith(name)))
    );
  }
  const body = option.slice(1).split('=')[0] ?? '';
  if (guard.single?.includes(body) === true) return true;
  return guard.short !== undefined && [...body].some((letter) => guard.short?.includes(letter));
}

/** The words after the command that are options of it, up to the `--` that ends them. */
function optionsOf(args: readonly Word[], bundle: boolean): readonly string[] {
  const words = args.filter((word) => !word.redirect).map((word) => word.value);
  const end = words.indexOf('--');
  const own = end === -1 ? words : words.slice(0, end);
  // `tar xIf 'sh -s' -`: the first word, with no dash, is its options.
  const first = own[0];
  const bundled = bundle && first !== undefined && /^[A-Za-z]+$/.test(first) ? [`-${first}`] : [];
  return [...bundled, ...own.filter((word) => word.startsWith('-') && word !== '-')];
}

/**
 * Whether the command a stage runs is one that only reads what it is given: on the list, called by
 * its name (or by the path of the system's own), and with no option that makes it run a program.
 */
export function readsAsData(
  command: Resolved,
  defined: ReadonlySet<string>,
  untrusted = false,
): boolean {
  // `env -P dir head` looks `head` up in `dir`: it is a file the agent may have written.
  if (untrusted || command.searchChanged === true || defined.has(command.name)) return false;
  if (Object.hasOwn(READING_SUBCOMMANDS, command.name)) {
    const subcommand = command.args.find((word) => !word.redirect && !word.value.startsWith('-'));
    return (
      subcommand !== undefined &&
      (READING_SUBCOMMANDS[command.name] as ReadonlySet<string>).has(subcommand.value) &&
      command.word === command.name
    );
  }
  if (!DATA_CONSUMERS.has(command.name)) return false;
  // `./head` and `/tmp/head` are files the agent may have written, and `HEAD` is not `head` where
  // names have a case: the name must be written as it is on the list, bare or in the system's own
  // directories.
  const base = command.word.slice(command.word.lastIndexOf('/') + 1);
  if (base !== command.name) return false;
  if (command.word.includes('/') && !SYSTEM_DIRECTORY.test(command.word)) return false;
  const guard = Object.hasOwn(RUNS_A_PROGRAM, command.name)
    ? RUNS_A_PROGRAM[command.name]
    : undefined;
  return (
    guard === undefined ||
    !optionsOf(command.args, guard.bundle === true).some((option) => runsAProgram(guard, option))
  );
}
