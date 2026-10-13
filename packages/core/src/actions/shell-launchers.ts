import { clusterValue, gluedValue, valueOfLetters, valuedLettersOf } from './shell-wrappers.js';
import type { Resolved, Word } from './shell-words.js';

/** What a launcher runs, as the line of a shell: and whether any word of it is an expansion. */
export interface LaunchedLine {
  readonly line: string;
  readonly expands: boolean;
}

const joined = (words: readonly Word[], separator = ' '): LaunchedLine | null =>
  words.length === 0
    ? null
    : {
        line: words.map((w) => w.value).join(separator),
        expands: words.some((w) => w.expands),
      };

const valueOf = (word: Word): LaunchedLine => ({ line: word.value, expands: word.expands });

/** The commands of tmux that are given a line to run with a shell, or the program with its arguments. */
const TMUX_RUNS =
  /^(?:new-session|new|new-window|neww|split-window|splitw|run-shell|run|if-shell|if|respawn-pane|respawnp|respawn-window|respawnw|pipe-pane|pipep|display-popup|popup)$/;
/** The letters of the options of each command of tmux that take the word after them. */
const tmuxValueLetters = (verb: string): string =>
  /^send(?:-keys)?$/.test(verb)
    ? 'tNc'
    : /^run(?:-shell)?$/.test(verb)
      ? 'dtc'
      : /popup$/.test(verb)
        ? 'bcdehsStTwxy'
        : 'cefFnstxyl';
/** A format string of tmux runs the command in `#(…)` for what it prints: `status-left`, `display-message`. */
const TMUX_FORMAT_OPEN = '#(';

/** `tmux new-session -d 'cmd'`, `tmux run-shell 'cmd'`, `tmux send-keys 'cmd' Enter`, `tmux -c 'cmd'`. */
function tmuxLine(args: readonly Word[]): LaunchedLine | null {
  const lines = [...tmuxCommandLines(args), ...formatCommands(args)];
  return lines.length === 0
    ? null
    : { line: lines.map((found) => found.line).join('\n'), expands: lines.some((f) => f.expands) };
}

/**
 * The commands in the `#(…)` of the words of any command of tmux, each to the first `)` after it. Looked for with
 * `indexOf`: a pattern that reads to the closing parenthesis from every `#(` is quadratic in a word that has many
 * and none.
 */
function formatCommands(args: readonly Word[]): LaunchedLine[] {
  const found: LaunchedLine[] = [];
  for (const word of args) {
    const text = word.value;
    let open = text.indexOf(TMUX_FORMAT_OPEN);
    while (open !== -1) {
      const close = text.indexOf(')', open + TMUX_FORMAT_OPEN.length);
      if (close === -1) break;
      found.push({
        line: text.slice(open + TMUX_FORMAT_OPEN.length, close),
        expands: word.expands,
      });
      open = text.indexOf(TMUX_FORMAT_OPEN, close + 1);
    }
  }
  return found;
}

function tmuxCommandLines(args: readonly Word[]): LaunchedLine[] {
  const one = (line: LaunchedLine | null): LaunchedLine[] => (line === null ? [] : [line]);
  return one(tmuxRunsLine(args));
}

function tmuxRunsLine(args: readonly Word[]): LaunchedLine | null {
  let i = 0;
  while (i < args.length && (args[i] as Word).value.startsWith('-')) {
    const option = (args[i] as Word).value;
    const next = args[i + 1];
    if (/^-[A-Za-z]*c$/.test(option) && next !== undefined) return valueOf(next);
    // `tmux -c'cmd'`, `tmux -2c'cmd'`: the string is glued to the option.
    const glued = gluedValue('tmux', option, 'c');
    if (glued !== null) return { line: glued, expands: (args[i] as Word).expands };
    // `tmux -L name new-session …`, `tmux -2L name …`: the options of tmux itself that take a value.
    i += clusterValue('tmux', option) === 'next' ? 2 : 1;
  }
  const verb = args[i]?.value ?? '';
  const sends = /^send(?:-keys)?$/.test(verb);
  if (!sends && !TMUX_RUNS.test(verb)) return null;
  const letters = tmuxValueLetters(verb);
  const given: Word[] = [];
  for (let j = i + 1; j < args.length; j += 1) {
    const word = args[j] as Word;
    if (word.value.length > 1 && word.value.startsWith('-')) {
      // `-s name` takes the word after it, `-sname` has its value in it.
      if (valueOfLetters(letters, word.value) === 'next') j += 1;
      continue;
    }
    given.push(word);
  }
  // `if-shell` is given the line to test first, and tmux commands after it.
  const words = /^if(?:-shell)?$/.test(verb) ? given.slice(0, 1) : given;
  return joined(words);
}

/** The letters of the options of `screen` that take the word after them: `-dmS name`, `-t title`. */
const SCREEN_VALUE_LETTERS = 'StcpehTs';

/** The words after `from` that are no option of `screen`, with the values of those that take one left out. */
function afterScreenOptions(args: readonly Word[], from: number): Word[] {
  let i = from;
  while (i < args.length && (args[i] as Word).value.startsWith('-')) {
    // `-S name` takes the word after it, `-dmSname` has its value in it.
    i += valueOfLetters(SCREEN_VALUE_LETTERS, (args[i] as Word).value) === 'next' ? 2 : 1;
  }
  return args.slice(i);
}

/** `screen -dmS name cmd args`, `screen -S name -X stuff 'cmd\n'`, `screen -X screen -t title cmd`. */
function screenLine(args: readonly Word[]): LaunchedLine | null {
  const remote = args.findIndex((w) => w.value === '-X');
  if (remote === -1) return joined(afterScreenOptions(args, 0));
  // `-X at 0 stuff 'cmd'`: the window that the command is sent to comes first.
  const at = args[remote + 1]?.value === 'at' ? remote + 2 : remote;
  const verb = args[at + 1]?.value;
  if (verb === 'screen' || verb === 'exec') return joined(afterScreenOptions(args, at + 2));
  if (verb !== 'stuff') return null;
  // What `stuff` types ends a line with `\n` or `^M`, which a shell reads as the end of one.
  const found = joined(args.slice(at + 2));
  return found === null
    ? null
    : { line: found.line.replace(/\\[nr]|\^M/g, '\n'), expands: found.expands };
}

/** The value of the first of the options, written `--exec cmd` or `--exec=cmd`: `nodemon --exec 'cmd'`, `rg --pre cmd`. */
function optionValue(args: readonly Word[], options: readonly string[]): LaunchedLine | null {
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word;
    const next = args[i + 1];
    if (options.includes(word.value) && next !== undefined) return valueOf(next);
    // `-x'cmd'`: a short option has its value in the same word.
    const short = options.find(
      (option) => /^-[A-Za-z]$/.test(option) && word.value.startsWith(option),
    );
    if (short !== undefined && word.value.length > short.length)
      return { line: word.value.slice(short.length), expands: word.expands };
    const equal = options.find(
      (option) => option.startsWith('--') && word.value.startsWith(`${option}=`),
    );
    if (equal !== undefined)
      return { line: word.value.slice(equal.length + 1), expands: word.expands };
  }
  return null;
}

/** `concurrently 'cmd' 'cmd'`: each word that is no option is a command, run with a shell (an option's value is read too). */
function concurrentlyLine(args: readonly Word[]): LaunchedLine | null {
  return joined(
    args.filter((w) => !w.value.startsWith('-')),
    '\n',
  );
}

/** `fd . -x cmd args`, `fd -Hx cmd`, `fd -X cmd`, `fd --exec cmd ;`, `fd --exec=cmd`: what follows the option. */
function fdLine(args: readonly Word[]): LaunchedLine | null {
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word;
    if (/^--exec(?:-batch)?$/.test(word.value)) return joined(args.slice(i + 1));
    const equal = /^--exec(?:-batch)?=(.*)$/s.exec(word.value);
    const glued = equal === null ? gluedValue('fd', word.value, 'xX') : (equal[1] as string);
    if (glued !== null) return joined([{ ...word, value: glued }, ...args.slice(i + 1)]);
    // `-x` ends a word of flags (`-HIx`) unless an option before it takes the rest of the word (`-ex`: the extension x).
    if (
      /[xX]$/.test(word.value) &&
      valueOfLetters(`${valuedLettersOf('fd')}xX`, word.value) === 'next'
    )
      return joined(args.slice(i + 1));
  }
  return null;
}

/** `do shell script "cmd"`, `do script "cmd"` of AppleScript, and `doShellScript("cmd")` of its JavaScript. */
const APPLESCRIPT_LINE =
  /\bdo\s+(?:shell\s+)?script\s+"((?:[^"\\]|\\.)*)"|\b(?:doShellScript|system)\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\)/g;
/** What runs a shell in AppleScript and in its JavaScript, whatever it is given: a script that has it and no string to read is asked about. */
const RUNS_A_SHELL_SCRIPT = /\bdo\s+(?:shell\s+)?script\b|\bdoShellScript\b|\$\.system\b/;
const unescapeLiteral = (text: string): string =>
  text.replace(/\\(.)/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));

/** `osascript -e 'do shell script "cmd"'`: the string that the script gives to a shell. */
function osascriptLine(args: readonly Word[]): LaunchedLine | null {
  const lines: string[] = [];
  let expands = false;
  let unread = '';
  for (let i = 0; i < args.length; i += 1) {
    // `-e script`, `-escript`: the next word, or the rest of this one.
    const word = args[i] as Word;
    const glued = gluedValue('osascript', word.value, 'e');
    const script =
      glued !== null ? { ...word, value: glued } : word.value === '-e' ? args[i + 1] : undefined;
    if (script === undefined) continue;
    let read = 0;
    for (const found of script.value.matchAll(APPLESCRIPT_LINE)) {
      lines.push(unescapeLiteral(found[1] ?? found[2] ?? found[3] ?? ''));
      expands ||= script.expands;
      read += 1;
    }
    // `do shell script x`: a shell is run with a line that is not written out, and nobody can read it.
    if (read === 0 && RUNS_A_SHELL_SCRIPT.test(script.value)) unread += `${script.value}\n`;
  }
  // Asked about as `eval "$x"` is: what the script runs is made as it runs.
  if (unread !== '')
    return { line: lines.concat('eval "$osascript_line"').join('\n'), expands: true };
  return lines.length === 0 ? null : { line: lines.join('\n'), expands };
}

/** `capsh --drop=cap_chown -- -c 'cmd'`: the shell that capsh starts is given the line. */
function capshLine(args: readonly Word[]): LaunchedLine | null {
  const at = args.findIndex((w) => /^-[A-Za-z]*c$/.test(w.value));
  const line = at === -1 ? undefined : args[at + 1];
  return line === undefined ? null : valueOf(line);
}

/**
 * What the commands that hand a line, or the words of a command, to a shell or to a program they run are given,
 * apart from `sh -c`: a terminal multiplexer (`tmux new-session -d 'cmd'`, `screen -dmS name cmd`), a watcher
 * (`nodemon --exec 'cmd'`, `concurrently 'cmd' 'cmd'`), a finder that runs a command on what it finds (`fd -x cmd`),
 * a search that preprocesses what it reads with one (`rg --pre cmd`), AppleScript that runs a shell script
 * (`osascript -e 'do shell script "cmd"'`) and `capsh -- -c 'cmd'`. Read as the line of a shell is. Null where the command
 * is none of them.
 */
export function launchedLine(command: Resolved): LaunchedLine | null {
  const args = command.args.filter((w) => !w.redirect);
  switch (command.name) {
    case 'tmux':
      return tmuxLine(args);
    case 'screen':
      return screenLine(args);
    case 'nodemon':
      return optionValue(args, ['-x', '--exec']);
    case 'concurrently':
      return concurrentlyLine(args);
    case 'rg':
      return optionValue(args, ['--pre']);
    case 'fd':
      return fdLine(args);
    case 'osascript':
      return osascriptLine(args);
    case 'capsh':
      return capshLine(args);
    default:
      return null;
  }
}
