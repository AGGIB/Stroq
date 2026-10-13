/**
 * Variables that change what a command word means, or what runs beside it: `PATH=./bin cat` runs a
 * file the agent wrote, `GIT_EDITOR='sh -s'` and `EDITOR=…` an editor that reads what is piped in,
 * `PAGER=sh bat` a program that is given the output, `BROWSER=sh gh browse` and `SSH_ASKPASS` a
 * program a tool starts, `TAR_OPTIONS=--to-command=sh` and the like the options of a tool that reads
 * them from its environment, `LD_PRELOAD` a library. A name that is written in this way anywhere in
 * a command is not the program it says it is.
 *
 * The name is read wherever it stands that is not a read of it (`$PATH`, `${PATH}`, `${PATH:-b}`): `PATH=b`,
 * `PATH+=:b`, `export PATH`, `printf -v PATH`, `read PATH`, `for PATH in b` and `declare -n p=PATH`
 * are all ways to set it, and a list of the ways is never finished where a list of the names is not.
 * Also `enable -f`, which loads a file as a builtin of any name.
 *
 * Matched when the text has had its quotes taken off (`env -S 'PATH=./bin cat'`, `"PA""TH"=x`).
 */
const NAMES = [
  'PATH',
  'CDPATH',
  'IFS',
  'ENV',
  'BASH_ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'PS4',
  'PROMPT_COMMAND',
  '[A-Z_]*EDITOR',
  'VISUAL',
  'FCEDIT',
  '[A-Z_]*BROWSER',
  '[A-Z_]*ASKPASS(?:_REQUIRE)?',
  'VIMINIT',
  'EXINIT',
  'MAILER',
  '[A-Z_]*_RSH',
  '[A-Z_]*PAGER',
  'LESS[A-Z]*',
  'LD_[A-Z_]+',
  'DYLD_[A-Z_]+',
  'GIT_[A-Z_]+',
  'GH_[A-Z_]+',
  'TAR_OPTIONS',
  'GZIP',
  'BZIP2',
  'XZ_OPT',
  'XZ_DEFAULTS',
  'BAT_[A-Z_]+',
  'RIPGREP_CONFIG_PATH',
  'GREP_OPTIONS',
  'SORT_[A-Z_]+',
];

const NAME = `(?:${NAMES.join('|')})`;

/**
 * `${PATH}` and `${PATH:-x}` read the name, and `${PATH:=x}` and `${PATH=x}` give it a value if it has
 * none: that one is a way to set it, which a lookahead for the operator keeps in.
 */
export const COMMAND_ENVIRONMENT = new RegExp(
  `(?<![A-Za-z0-9_$/.])(?:(?<!\\$\\{)${NAME}(?![A-Za-z0-9_])|(?<=\\$\\{)${NAME}(?=:?=))|(?<![\\w./-])enable\\s+-[A-Za-z]*f`,
);
