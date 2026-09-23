// Telling a heredoc that RUNS from a heredoc that is merely TEXT.
//
// `stroq sent` reports a credential file a shell command named, and it used to search
// the whole command string for the path. Measured over this machine's 626 Claude Code
// transcripts, 20 Bash calls named a credential file: 8 as an argument of the command
// (`cat ~/.npmrc | sed …`, `ls -la ~/.aws/credentials`, a node script that reads the
// token) and 12 only inside a heredoc body written out as data — `cat > page.html
// <<'EOF'` whose HTML listed `~/.npmrc` as an example, a test file, a commit message.
// Those 12 were reported as "named in the command", and the first one the author ran
// before a launch post was exactly that: a site edit, not a read.
//
// A body is data unless something executes it. `bash <<EOF`, `cat <<EOF | sh`,
// `python3 - <<EOF`, `ssh host <<EOF` all run what is inside, and a path there is a
// path the machine will open — so those bodies are kept. None of the 626 transcripts
// holds one that names a credential file, which is the point of keeping them: the
// rule costs nothing measured, and a real `bash <<EOF cat ~/.npmrc EOF` still shows.

/** `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`; never `<<<`. */
const HEREDOC = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/g;

/**
 * A command that executes what it reads on stdin, at the start of a pipeline stage.
 * Deliberately generous: calling a data body code only keeps a mention the report
 * already made, while calling a code body data would hide a read.
 */
//
// The assignment is `NAME=value` with a name that cannot contain `=`: the earlier
// `\S+=\S*` let the two halves trade characters, and `env a=a=a=…` backtracked for
// 42 s at 400 KB. A stage is also read only as far as its command word can be.
const EXECUTES_STDIN =
  /^(?:sudo\s+)?(?:(?:\S*\/)?env\s+(?:[A-Za-z_]\w*=\S*\s+)*)?(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|python\d*(?:\.\d+)?|node|deno|bun|tsx|ruby|perl|php|osascript|ssh|eval|source|\.|xargs|npx|pnpm|uv)(?:\s|$)/;

/** How much of a pipeline stage the interpreter check reads. */
const STAGE_PREFIX = 512;

/** Whether the stage receiving the heredoc on `line`, or one piped after it, runs it. */
function bodyIsExecuted(line: string, operatorStart: number, operatorEnd: number): boolean {
  // The stage that receives the heredoc is whatever follows the last separator before
  // the operator — including a plain `|`, so `x | bash <<EOF` is read as bash's.
  const before = line.slice(0, operatorStart).split(/&&|\|\||;|\$\(|\|/);
  const stages = [before[before.length - 1] ?? '', ...line.slice(operatorEnd).split('|').slice(1)];
  return stages.some((stage) => EXECUTES_STDIN.test(stage.trim().slice(0, STAGE_PREFIX)));
}

/**
 * `command` with the body of every heredoc that is only data removed.
 *
 * A body whose delimiter never closes is left in place. Bash would read one to the
 * end of the input, but an unclosed `<<n` is as likely to be a shift inside `$(( ))`,
 * and dropping the rest of the command on that guess could hide a real read.
 */
export function withoutHeredocData(command: string): string {
  if (!command.includes('<<')) return command;
  const lines = command.split('\n');
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    kept.push(line);
    const operators = [...line.matchAll(HEREDOC)];
    i += 1;
    if (operators.length === 0) continue;
    // Several heredocs on one line take their bodies one after another, in order.
    for (const op of operators) {
      const dash = op[1] === '-';
      const delimiter = op[3] ?? '';
      let end = i;
      while (end < lines.length) {
        const candidate = lines[end] ?? '';
        if ((dash ? candidate.replace(/^\t+/, '') : candidate) === delimiter) break;
        end += 1;
      }
      if (end >= lines.length) return command;
      const start = op.index;
      const executed = bodyIsExecuted(line, start, start + op[0].length);
      if (executed) kept.push(...lines.slice(i, end));
      kept.push(lines[end] ?? '');
      i = end + 1;
    }
  }
  return kept.join('\n');
}
