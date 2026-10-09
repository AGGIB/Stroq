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
