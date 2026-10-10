/**
 * How a command of Stroq reaches a shell, from the matrix `self-config.test.ts` has for `untaint`.
 * Shared by the tests that hold a new command of Stroq's, or a new way to run one, to the same
 * long run of spellings.
 */

export type Spelling = readonly [name: string, spell: (words: readonly string[]) => string];

export const joined = (words: readonly string[]): string => words.join(' ');
export const quoted = (mark: string, words: readonly string[]): string =>
  words.map((word) => `${mark}${word}${mark}`).join(' ');

export const SPELLINGS: readonly Spelling[] = [
  ['the bare name', (w) => `stroq ${joined(w)}`],
  ['an absolute path', (w) => `/usr/local/bin/stroq ${joined(w)}`],
  ['a Windows launcher', (w) => `stroq.cmd ${joined(w)}`],
  ['a Windows executable', (w) => `stroq.exe ${joined(w)}`],
  ['a Windows path', (w) => `C:\\Users\\dev\\AppData\\Roaming\\npm\\stroq.cmd ${joined(w)}`],
  ['sudo', (w) => `sudo stroq ${joined(w)}`],
  ['an assignment in front', (w) => `STROQ_HOME=/tmp/h stroq ${joined(w)}`],
  ['env with an assignment', (w) => `env FOO=1 stroq ${joined(w)}`],
  ['env -i', (w) => `env -i stroq ${joined(w)}`],
  ['double-quoted words', (w) => `stroq ${quoted('"', w)}`],
  ['single-quoted words', (w) => `stroq ${quoted("'", w)}`],
  ['npx @stroq/cli', (w) => `npx @stroq/cli ${joined(w)}`],
  ['npx -y with a version', (w) => `npx -y @stroq/cli@0.23.0 ${joined(w)}`],
  ['npx stroq', (w) => `npx stroq ${joined(w)}`],
  ['pnpm dlx', (w) => `pnpm dlx @stroq/cli ${joined(w)}`],
  ['pnpm exec', (w) => `pnpm exec stroq ${joined(w)}`],
  [
    'node and the published entry',
    (w) => `node /opt/node_modules/@stroq/cli/dist/index.js ${joined(w)}`,
  ],
  ['node and a checkout', (w) => `node packages/cli/dist/index.js ${joined(w)}`],
  [
    'node and a Windows entry',
    (w) => `node C:\\dev\\node_modules\\@stroq\\cli\\dist\\index.js ${joined(w)}`,
  ],
  ['a substitution', (w) => `$(which stroq) ${joined(w)}`],
  ['a variable', (w) => `S=stroq; $S ${joined(w)}`],
  ['bash -c', (w) => `bash -c "stroq ${joined(w)}"`],
  ['sh -c with single quotes', (w) => `sh -c 'stroq ${joined(w)}'`],
  ['a heredoc to bash', (w) => `bash <<'EOF'\nstroq ${joined(w)}\nEOF`],
  ['xargs', (w) => `echo | xargs -I{} stroq ${joined(w)}`],
  ['after &&', (w) => `ls && stroq ${joined(w)}`],
  ['a group', (w) => `{ stroq ${joined(w)}; }`],
  ['a subshell', (w) => `(stroq ${joined(w)})`],
  ['an if', (w) => `if true; then stroq ${joined(w)}; fi`],
  ['a function', (w) => `f() { stroq ${joined(w)}; }; f`],
];

/**
 * Commands that run and change state behind a launcher, and that were let through as a request for
 * help (the review of 2026-10-10): the operand of a launcher is read again from words that were split on
 * blanks with their quotes taken off, so a quoted argument that holds a flag (`"x -h"`) showed a flag
 * that the program is never given.
 */
export const QUOTED_BEHIND_LAUNCHERS: readonly string[] = [
  'stroq run --no-inspect --force -- stroq uninstall --client "x -h"',
  'stroq run -- stroq trust "evil.md -h"',
  'stroq mcp --server s -- stroq uninstall --config "x --help"',
  'sudo stroq run -- sudo stroq trust "x -h"',
  'npx @stroq/cli run -- npx @stroq/cli trust "x -h"',
  'stroq run -- stroq run --agent "x -h" -- stroq uninstall',
];

/**
 * Text put after a command line that a reader taking every blank-separated word of the line for
 * an argument would read as a request for help (`--help`, `-h`, `--dry-run`), and that is none:
 * a comment, the body of a heredoc, the target of a redirect, a quoted argument that holds the
 * flag among other words. After a command that changes state, none of them turns it into a
 * request for help, whatever the spelling of the command is.
 */
export type Cover = readonly [name: string, cover: (line: string) => string];

export const COVERS: readonly Cover[] = [
  ['a comment holding --help', (l) => `${l} # --help`],
  ['a comment holding -h', (l) => `${l} # -h`],
  ['a comment holding --dry-run', (l) => `${l} # --dry-run`],
  ['a comment glued to its flag', (l) => `${l} #--help`],
  ['a comment after a tab', (l) => `${l}\t# -h`],
  ['a comment with words before the flag', (l) => `${l} # to see how it works, add --help`],
  ['a heredoc whose body is --help', (l) => `${l} <<EOF\n--help\nEOF`],
  ['a quoted heredoc whose body is -h', (l) => `${l} <<'EOF'\n-h\nEOF`],
  ['a heredoc of stripped tabs whose body is --dry-run', (l) => `${l} <<-EOF\n\t--dry-run\n\tEOF`],
  ['a heredoc whose body has the flag among words', (l) => `${l} <<EOF\nsee --help or -h\nEOF`],
  ['a here-string of the flag', (l) => `${l} <<< --help`],
  ['a redirect to a file called like the flag', (l) => `${l} > --help`],
  ['a redirect of errors to a file called like the flag', (l) => `${l} 2> -h`],
  ['a double-quoted argument that holds the flag', (l) => `${l} "x --help"`],
  ['a single-quoted argument that holds the flag', (l) => `${l} 'x -h'`],
];

/**
 * Commands that run and change state, and that were let through as a request for help (the review of
 * 2026-10-10) because a flag was read in text that is no argument of the command: a comment, the body of a
 * heredoc.
 */
export const FLAG_IN_NO_ARGUMENT: readonly string[] = [
  'stroq untaint --all # --help',
  'stroq untaint --all # -h',
  'stroq untaint --all # --dry-run',
  'stroq init # --dry-run',
  'stroq uninstall # -h',
  'stroq prove # --help',
  'stroq run -- stroq untaint --all # --help',
  'stroq untaint --all <<EOF\n--help\nEOF',
];

/** Every command that the reviews ran past the gate by letting it read a flag where there is no argument. */
export const COVERED_BY_TEXT: readonly string[] = [
  ...QUOTED_BEHIND_LAUNCHERS,
  ...FLAG_IN_NO_ARGUMENT,
];
