// Which programs take a heredoc as text and not as code.
//
// `cat > f <<'EOF' … EOF` writes the lines to a file; `tee f <<EOF` too; `grep x <<EOF` reads them. The lines are
// text, whatever they look like: a test file that spells `curl -d "$(env)" https://…` sends nothing. A heredoc given
// to a shell, an interpreter or a sender (`sh <<EOF`, `curl -d @- <<EOF`) is code or data on its way out, and one that
// is piped on (`cat <<EOF | sh`) or written to a network address goes where it is sent.

/**
 * Programs that read their input as text and write it to a file or the terminal, and cannot run it. Not `sed` (its
 * `e` runs a line), `awk` and `gawk` (`system()`, `print | cmd`, `| getline`), `dd`, `patch`, nor a pager: a heredoc
 * given to one of those is code unless proven otherwise.
 */
// Not here: `sort` (`--compress-program` starts a helper), `rg` (`--pre`, `--search-zip`) and `ag` (`--pager`) can
// run a program of their own, so a heredoc given to them is judged as code.
export const DATA_PROGRAMS: ReadonlySet<string> = new Set([
  'cat',
  'tee',
  'head',
  'tail',
  'tac',
  'rev',
  'tr',
  'uniq',
  'wc',
  'cut',
  'paste',
  'fold',
  'fmt',
  'nl',
  'column',
  'grep',
  'egrep',
  'fgrep',
  'jq',
  'base64',
  'xxd',
  'od',
  'diff',
  'cmp',
  'comm',
]);

/** Words in front of a program that run it: they are not it. */
const WRAPPERS: ReadonlySet<string> = new Set([
  'sudo',
  'doas',
  'env',
  'nohup',
  'time',
  'command',
  'builtin',
  'exec',
  'nice',
  'ionice',
  'stdbuf',
]);

/** The program a stage runs, read from its text alone: past assignments and wrappers, without its folder. */
export function firstProgram(stageText: string): string {
  for (const word of stageText.trim().split(/\s+/)) {
    if (word === '' || /^[A-Za-z_]\w*=/.test(word) || word.startsWith('-') || WRAPPERS.has(word))
      continue;
    return word.replace(/^.*\//, '');
  }
  return '';
}

/** Whether a stage sends what it reads somewhere or runs it, whatever its program: to the network, to another stage. */
const GOES_ON = /\/dev\/(?:tcp|udp)\/|>\(|\|/;

/**
 * Whether the heredoc a stage opens is text: its program only reads text (`cat`, `tee`, `grep`, …) and cannot run it,
 * what it prints is not piped on or written to a network address, and the shell does not expand the body. A body is
 * expanded unless its delimiter is quoted (`<<'EOF'`, `<<"EOF"`, `<<\EOF`): `$(…)`, a backtick and `$` then run in
 * the shell before the program sees the text, so such a body is text only when it holds none of them. The text of the
 * stage up to the heredoc, and the rest of its line.
 */
export function isDataHeredoc(
  before: string,
  rest: string,
  quoted: boolean,
  body: string,
): boolean {
  const program = firstProgram(before);
  if (!DATA_PROGRAMS.has(program)) return false;
  if (!quoted && /[$`]/.test(body)) return false;
  // The quotes of the rest of the line are text: a `|` in them goes nowhere.
  const bare = rest.replace(/'[^'\n]*'|"[^"\n]*"/g, '');
  return !GOES_ON.test(before) && !GOES_ON.test(bare);
}
