// Which programs take a heredoc as text and not as code.
//
// `cat > f <<'EOF' … EOF` writes the lines to a file; `tee f <<EOF` too; `grep x <<EOF` reads them. The lines are
// text, whatever they look like: a test file that spells `curl -d "$(env)" https://…` sends nothing. A heredoc given
// to a shell, an interpreter or a sender (`sh <<EOF`, `curl -d @- <<EOF`) is code or data on its way out, and one that
// is piped on (`cat <<EOF | sh`) or written to a network address goes where it is sent.

/** Programs that read their input as text and write it to a file or the terminal. */
export const DATA_PROGRAMS: ReadonlySet<string> = new Set([
  'cat',
  'tee',
  'head',
  'tail',
  'tac',
  'rev',
  'tr',
  'sort',
  'uniq',
  'wc',
  'cut',
  'paste',
  'fold',
  'fmt',
  'nl',
  'column',
  'less',
  'more',
  'bat',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'sed',
  'awk',
  'gawk',
  'jq',
  'base64',
  'xxd',
  'od',
  'dd',
  'patch',
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
 * Whether the heredoc a stage opens is text: its program only reads text (`cat`, `tee`, `grep`, …), it is not given a
 * script to run (`sed -f -`, `awk -f -`), and what it prints is not piped on or written to a network address. The text
 * of the stage up to the heredoc, and the rest of its line.
 */
export function isDataHeredoc(before: string, rest: string): boolean {
  const program = firstProgram(before);
  if (!DATA_PROGRAMS.has(program)) return false;
  if (/^(?:sed|awk|gawk)$/.test(program) && /\s-f\b/.test(before)) return false;
  // The quotes of the rest of the line are text: a `|` in them goes nowhere.
  const bare = rest.replace(/'[^'\n]*'|"[^"\n]*"/g, '');
  return !GOES_ON.test(before) && !GOES_ON.test(bare);
}
