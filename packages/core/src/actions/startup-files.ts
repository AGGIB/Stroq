/**
 * The files a shell runs as it starts, when a command says where to find them.
 *
 * `BASH_ENV=x.sh bash y.sh` and `ENV=x.sh sh -i` name the file. `ZDOTDIR=d zsh -c true` and
 * `HOME=d bash -ic true` name the directory the shell looks in: zsh reads `.zshenv` even when
 * it is not interactive, so a directory the agent has just written makes a shell run what is in
 * it, and `-c true` shows nothing of that. Read wherever the variable is set, as the shell that
 * is started later would find it (`export ZDOTDIR=d; zsh -c true`), for every file the shells
 * look for there: a few more are read than the one that runs, which can only add a danger.
 *
 * Not read: a directory that is the user's own home (`HOME=$HOME`, `ZDOTDIR=~`), which every
 * shell reads whatever the command says.
 */

const FILE_VARIABLE = /(?:^|[\s"'])(?:export\s+)?(?:BASH_ENV|ENV)=("[^"]*"|'[^']*'|[^\s"']+)/;
const DIRECTORY_VARIABLE = /(?:^|[\s"'])(?:export\s+)?(ZDOTDIR|HOME)=("[^"]*"|'[^']*'|[^\s"']+)/g;
const ZSH_FILES: readonly string[] = ['.zshenv', '.zprofile', '.zshrc', '.zlogin'];
const HOME_FILES: readonly string[] = [
  ...ZSH_FILES,
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
];
const USERS_OWN_HOME = /^(?:~|\$HOME|\$\{HOME\})$/;

const unquoted = (value: string): string => value.replace(/^["']|["']$/g, '');

/** The names of the startup files a segment points a shell at, as written. */
export function startupFileNames(segment: string): string[] {
  const names: string[] = [];
  const file = FILE_VARIABLE.exec(segment)?.[1];
  if (file !== undefined) names.push(unquoted(file));
  for (const match of segment.matchAll(DIRECTORY_VARIABLE)) {
    const directory = unquoted(match[2] as string).replace(/\/+$/, '');
    if (directory === '' || USERS_OWN_HOME.test(directory)) continue;
    for (const name of match[1] === 'ZDOTDIR' ? ZSH_FILES : HOME_FILES)
      names.push(`${directory}/${name}`);
  }
  return names;
}
