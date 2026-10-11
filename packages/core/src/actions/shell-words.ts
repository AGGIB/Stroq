import {
  commandDescribes,
  gluedValue,
  LOCAL_WRAPPERS,
  MAX_LOOKAHEAD,
  optionTakesValue,
  PREFIX_WORDS,
  replacesPositional,
  runuserRunsCommand,
  VERB_WRAPPERS,
  verbWrapperLength,
  verbWrapperNamed,
  wrapperNamed,
} from './shell-wrappers.js';
import { argv, readWords, REDIRECT, type Word } from './shell-word-reader.js';

// The reading of the words themselves (`Word`, `readWords`, `argv`, `REDIRECT`, `groupMarks`) is
// `shell-word-reader.ts`; it is exported from here as well, where it has always been imported from.
export * from './shell-word-reader.js';

// -------------------------------------------------------------------------------------------
// The command a stage runs
// -------------------------------------------------------------------------------------------

export const baseOf = (word: string): string => word.replace(/^.*\//, '');

/** `bash5`, `bash-5.2`, `zsh-5.9`, `rksh`: a shell by the name of another version or a restricted one. */
const VERSIONED_SHELL =
  /^(r?(?:bash|zsh|ksh|dash|ash|csh|tcsh|fish|mksh|oksh|yash|posh))-?\d+(?:\.\d+)*$/;

/** The name a command is known by: a shell with a version or an `r` before it is that shell. */
function canonicalName(name: string): string {
  const base = VERSIONED_SHELL.exec(name)?.[1] ?? name;
  return base === 'rksh' || base === 'rzsh' ? base.slice(1) : base;
}
const isAssignment = (word: string): boolean => /^[A-Za-z_]\w*=/.test(word);

/** `f`: the name of a function or an alias. */
const NAME = /^[^\s;&|()<>$`"'\\={}!#-][^\s;&|()<>$`"'\\={}]*$/u;
/** A brace or a parenthesis standing as a word of its own after a keyword: `time { bash; }`. */
const GROUPERS: ReadonlySet<string> = new Set(['{', '(', '!']);
const KEYWORDS: ReadonlySet<string> = new Set([
  '!',
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
]);

/** Wrappers that give the command that follows them to a shell as one line. */
const STRING_WRAPPERS: ReadonlySet<string> = new Set(['watch', 'parallel']);
/** The wrappers that start a shell where they are given no command. */
const STARTS_A_SHELL: ReadonlySet<string> = new Set(['chroot', 'unshare', 'nsenter']);
/** A word that begins the values that `parallel` is given: `:::`, `::::`, `:::+`. */
const DATA_MARK = /^::::?\+?$/;
/** The words that stand after the one at `at`, as far as a wrapper looks at them. */
const valuesAfter = (words: readonly Word[], at: number): string[] =>
  words.slice(at + 1, at + 1 + MAX_LOOKAHEAD).map((w) => w.value);
/** Whether the options say that the command is run as it is: `watch -x`, `watch --exec`, `parallel --no-shell`. */
const runsWithoutShell = (words: readonly Word[], from: number, to: number): boolean =>
  words
    .slice(from, to)
    .some((w) => w.value === '-x' || w.value === '--exec' || w.value === '--no-shell');
/** Wrapper words whose arguments are not the program's input: the program's arguments, or none. */
const ARGUMENT_WRAPPERS: ReadonlySet<string> = new Set(['watch', 'xargs', 'parallel']);

/** Wrappers that run what they are given with its input and its output unchanged. */
export const PLAIN_WRAPPERS: ReadonlySet<string> = new Set([
  ...[...PREFIX_WORDS].filter((word) => !ARGUMENT_WRAPPERS.has(word)),
  ...Object.keys(LOCAL_WRAPPERS),
  ...Object.keys(VERB_WRAPPERS),
]);

/** How many times `eval` and `env -S` may split their argument again: each copies the words. */
const MAX_SPLITS = 8;
/** The programs of the verb table that `locate` is told to stop at: none. */
const NOT_KEPT: ReadonlySet<string> = new Set();

export interface Resolved {
  /** What the stage runs, by its base name; `$` when the word is an expansion. */
  readonly name: string;
  /** What `eval` was given, joined as it joins it: a command line the shell runs in turn. */
  readonly evalProgram: { readonly text: string; readonly dynamic: boolean } | null;
  /** The names of the functions this stage defines: a later stage that calls one runs its body. */
  readonly defined: readonly string[];
  /** Wrappers were nested deeper than they are read, so what runs under them is not known. */
  readonly deep: boolean;
  /** The command word as the shell reads it, quotes taken off: `$SHELL`, `bash`, `/bin/sh`. */
  readonly word: string;
  /** The words after it. */
  readonly args: readonly Word[];
  /** The wrappers that were looked through to find it, by name. */
  readonly wrappers: readonly string[];
  /** A wrapper changed where the command is looked up (`env -P dir`, `env -C dir`): its name is not the program of that name. */
  readonly searchChanged?: boolean;
  /** Variables are set for the command (`NAME=value cmd`, `env NAME=value cmd`). */
  readonly assigned?: boolean;
}

/** The wrapper a word names, if it does: bare, or by its place in a directory only root writes. */
function wrapperOf(word: string): string | null {
  const name = word.toLowerCase();
  if (name === 'eval' || Object.hasOwn(LOCAL_WRAPPERS, name)) return name;
  return wrapperNamed(word);
}

/** The wrapper's own options and what it takes before its command, read from `from`. */
interface Skipped {
  readonly words: readonly Word[];
  readonly at: number;
  /** `sudo -s`, `sudo -i`: no command follows, and the shell it starts reads standard input. */
  readonly impliesShell: boolean;
  /** `env -P dir`, `env -C dir`: where the command is looked up is not where it always is. */
  readonly searchChanged: boolean;
  /** `env NAME=value cmd`. */
  readonly assigned: boolean;
}

/**
 * Skips the options of a wrapper, and what it takes before its command: returns the words with
 * `env -S 'bash -s'` split into the words it stands for, and the index of the command's word.
 */
function afterOptions(
  words: readonly Word[],
  from: number,
  wrapper: string,
  splits: { left: number },
): Skipped {
  let all = words;
  let i = from;
  let impliesShell = false;
  let searchChanged = false;
  let named = false;
  // `flock -x -c 'cmd' FILE`: the string that flock hands to a shell, wherever its option stands.
  let string: Word | null = null;
  while (i < all.length) {
    const option = (all[i] as Word).value;
    if (option === '--') {
      i += 1;
      break;
    }
    // `env -` is `env -i`; any other lone dash or word is where the command begins.
    if (!option.startsWith('-') || (option === '-' && wrapper !== 'env')) break;
    i += 1;
    if (wrapper === 'flock') {
      const inline = /^--command=(.*)$/s.exec(option)?.[1] ?? gluedValue('flock', option, 'c');
      if (inline !== null) {
        string = plainWord(inline, (all[i - 1] as Word).expands);
        continue;
      }
      if (/^(?:--command|-[A-Za-z]*c)$/.test(option) && all[i] !== undefined) {
        string = all[i] as Word;
        i += 1;
        continue;
      }
    }
    named ||= replacesPositional(wrapper, option);
    if (wrapper === 'sudo' && /^(?:-[A-Za-z]*[si][A-Za-z]*|--shell|--login)$/.test(option))
      impliesShell = true;
    if (wrapper === 'env' && /^(?:-[PC]|--chdir)/.test(option)) searchChanged = true;
    const split = wrapper === 'env' ? splitString(option, all, i) : null;
    if (split !== null && splits.left > 0) {
      splits.left -= 1;
      all = [
        ...all.slice(0, i - 1 + split.keep),
        ...argv(split.string),
        ...all.slice(i + split.skip),
      ];
      i = i - 1 + split.keep;
    } else if (optionTakesValue(wrapper, option)) i += 1;
  }
  const positional =
    Object.hasOwn(LOCAL_WRAPPERS, wrapper) && !named ? (LOCAL_WRAPPERS[wrapper] ?? 0) : 0;
  const afterEnv = wrapper === 'env' ? skipAssignments(all, i) : i;
  const assigned = afterEnv > i;
  const at = wrapper === 'timeout' && afterEnv < all.length ? afterEnv + 1 : afterEnv;
  const command = Math.min(all.length, at + positional);
  if (string !== null)
    return {
      words: [...all.slice(0, from), plainWord('sh'), plainWord('-c'), string],
      at: from,
      impliesShell,
      searchChanged,
      assigned,
    };
  return {
    words: wrapper === 'flock' ? withShell(all, command) : all,
    at: command,
    impliesShell,
    searchChanged,
    assigned,
  };
}

/**
 * `flock FILE -c 'cmd'` and `flock FILE --command=cmd` hand the string to a shell: the words of
 * `sh -c 'cmd'`, put where the command would be.
 */
function withShell(words: readonly Word[], at: number): readonly Word[] {
  const word = words[at];
  const option = word?.value ?? '';
  if (option === '-c' || option === '--command')
    return [...words.slice(0, at), plainWord('sh'), plainWord('-c'), ...words.slice(at + 1)];
  if (option.startsWith('--command=') && word !== undefined)
    return [
      ...words.slice(0, at),
      plainWord('sh'),
      plainWord('-c'),
      plainWord(option.slice('--command='.length), word.expands),
      ...words.slice(at + 1),
    ];
  return words;
}

/** A word that was written plainly: no quote, no operator. */
function plainWord(value: string, expands = false): Word {
  return { value, quoted: false, redirect: false, group: false, expands };
}

/**
 * `env -S 'bash -s'`, `env -Sbash`, `env --split-string=bash`: the string it splits into words.
 * `keep` is how many words before the string stay (the option itself is replaced, with the
 * string's words in its place), and `skip` how many words of the original it takes.
 */
function splitString(
  option: string,
  words: readonly Word[],
  next: number,
): { readonly string: string; readonly keep: number; readonly skip: number } | null {
  if (option === '-S' || option === '--split-string')
    return { string: (words[next] as Word | undefined)?.value ?? '', keep: 0, skip: 1 };
  if (option.startsWith('--split-string='))
    return { string: option.slice('--split-string='.length), keep: 0, skip: 0 };
  if (option.startsWith('-S') && option.length > 2)
    return { string: option.slice(2), keep: 0, skip: 0 };
  return null;
}

function skipAssignments(words: readonly Word[], from: number): number {
  let i = from;
  while (i < words.length && isAssignment((words[i] as Word).value)) i += 1;
  return i;
}

/**
 * How many words a function definition's head takes at `i`: `function f`, `function f()`,
 * `f()` and `f ()`, and the name it gives. The parentheses are words of their own.
 */
function functionHeader(
  words: readonly Word[],
  i: number,
): { readonly length: number; readonly name: string } | null {
  const word = words[i] as Word;
  if (word.quoted || word.group) return null;
  const opens = words[i + 1]?.group === true && words[i + 1]?.value === '(';
  const closes = words[i + 2]?.group === true && words[i + 2]?.value === ')';
  if (word.value === 'function' && words[i + 1] !== undefined) {
    const name = (words[i + 1] as Word).value;
    const parens = words[i + 2]?.group === true && words[i + 3]?.group === true;
    return { length: parens ? 4 : 2, name };
  }
  return NAME.test(word.value) && opens && closes ? { length: 3, name: word.value } : null;
}

/**
 * The words of a command up to the `)` or the `}` that closes the group it is in, and after it
 * only redirects, which feed the group. zsh closes a brace group at a `}` that follows a command
 * directly (`{ echo x | bash } always { :; }`), where bash wants a `;` first, so a `}` that is a
 * word of its own ends the command here: for a command in no group it is a syntax error anyway.
 */
function argumentsOf(rest: readonly Word[]): Word[] {
  const close = rest.findIndex(
    (w) => !w.quoted && ((w.group && w.value === ')') || w.value === '}'),
  );
  if (close === -1) return [...rest];
  const kept = rest.slice(0, close);
  for (let i = close + 1; i < rest.length; i += 1) {
    const word = rest[i] as Word;
    if (!word.redirect) continue;
    kept.push(word);
    const match = REDIRECT.exec(word.value);
    if (match !== null && word.value.length === match[0].length && rest[i + 1] !== undefined) {
      i += 1;
      kept.push(rest[i] as Word);
    }
  }
  return kept;
}

interface Located {
  readonly words: readonly Word[];
  readonly at: number;
  readonly wrappers: readonly string[];
  readonly leading: readonly Word[];
  readonly defined: readonly string[];
  readonly evalProgram: Resolved['evalProgram'];
  readonly deep: boolean;
  readonly impliesShell: boolean;
  readonly searchChanged: boolean;
  readonly assigned: boolean;
}

/**
 * Finds the command word: past redirects, assignments, keywords, groups, function heads, wrappers.
 * `eval` and `env -S` split their arguments into words again, a copy of them each time: `resplits`
 * is how many times they may; with none, the word after them stands where the command is. `keep`
 * names the programs of the verb table that are not looked past, for a reader that judges that
 * program itself (`stroq run -- …` is a launcher to most, and a command of Stroq's to the one
 * that asks what it changes).
 */
export function locate(
  start: readonly Word[],
  resplits = MAX_SPLITS,
  keep: ReadonlySet<string> = NOT_KEPT,
): Located {
  let words = start;
  const wrappers: string[] = [];
  // Redirects may come before the command word: `< x.sh bash`. They stay with its words.
  const leading: Word[] = [];
  const defined: string[] = [];
  const splits = { left: resplits };
  let evalProgram: Resolved['evalProgram'] = null;
  let impliesShell = false;
  let searchChanged = false;
  let assigned = false;
  let deep = false;
  let i = 0;
  while (i < words.length) {
    const word = words[i] as Word;
    const redirect = word.redirect ? REDIRECT.exec(word.value) : null;
    if (redirect !== null) {
      const taken = word.value.length === redirect[0].length ? 2 : 1;
      leading.push(...words.slice(i, i + taken));
      i += taken;
      continue;
    }
    const keyword = !word.quoted && (KEYWORDS.has(word.value) || GROUPERS.has(word.value));
    if (isAssignment(word.value) || keyword || word.group) {
      if (isAssignment(word.value)) assigned = true;
      i += 1;
      continue;
    }
    const header = functionHeader(words, i);
    if (header !== null) {
      defined.push(header.name);
      i += header.length;
      continue;
    }
    // `direnv exec DIR cmd`, `mise exec -- cmd`, `uv run cmd`: a program that runs another after a verb.
    const verbWrapper = verbWrapperNamed(word.value);
    const verbLength =
      verbWrapper === null || keep.has(verbWrapper)
        ? null
        : verbWrapperLength(verbWrapper, valuesAfter(words, i));
    if (verbWrapper !== null && verbLength !== null) {
      wrappers.push(verbWrapper);
      i += 1 + verbLength;
      continue;
    }
    const wrapper = wrapperOf(word.value);
    if (wrapper === null) break;
    // `runuser -l user -c 'cmd'` gives a string to the user's shell, as `su` does: it is the command, not a wrapper.
    if (wrapper === 'runuser' && !runuserRunsCommand(valuesAfter(words, i))) break;
    // `command -v at` looks `at` up and runs nothing: `command` is the command.
    if (wrapper === 'command' && commandDescribes(valuesAfter(words, i))) break;
    wrappers.push(wrapper);
    i += 1;
    if (wrapper === 'eval') {
      // `eval` joins its arguments and reads them as a command: `eval 'bash -s'` is `bash -s`.
      if (splits.left === 0) {
        deep = true;
        break;
      }
      splits.left -= 1;
      const joined = words
        .slice(i)
        .map((w) => w.value)
        .join(' ');
      evalProgram ??= { text: joined, dynamic: words.slice(i).some((w) => w.expands) };
      words = [...words.slice(0, i), ...argv(joined)];
      continue;
    }
    const optionsFrom = i;
    const after = afterOptions(words, i, wrapper, splits);
    words = after.words;
    i = after.at;
    impliesShell ||= after.impliesShell;
    searchChanged ||= after.searchChanged;
    assigned ||= after.assigned;
    // `watch 'rm -rf ~'` and `parallel 'rm -rf {}' ::: a` hand what follows to a shell, as one line: it is read
    // as the line it is, as the argument of `eval` is (`watch -x` and `parallel --no-shell`... run it as it is).
    if (
      STRING_WRAPPERS.has(wrapper) &&
      splits.left > 0 &&
      !runsWithoutShell(words, optionsFrom, i)
    ) {
      // Only a line that is one word with a blank or a shell operator in it is a string to read again: the
      // words of `watch head` and `parallel echo {}` are the command already. It is one word where nothing
      // follows it, or (for `parallel`) the values that it is given begin right after it.
      const template = words[i];
      const next = words[i + 1];
      const alone = next === undefined || (wrapper === 'parallel' && DATA_MARK.test(next.value));
      if (template !== undefined && alone && /[\s;&|<>$`()]/.test(template.value)) {
        splits.left -= 1;
        // The values that `parallel` is given are the arguments of the line, put where it has `{}` or after it.
        const data = words.slice(i + 1).filter((w) => !DATA_MARK.test(w.value));
        const line = [template, ...data];
        const joined = line.map((w) => w.value).join(' ');
        evalProgram ??= { text: joined, dynamic: line.some((w) => w.expands) };
        words = [...words.slice(0, i), ...argv(joined)];
      }
    }
  }
  return {
    words,
    at: i,
    wrappers,
    leading,
    defined,
    evalProgram,
    deep,
    impliesShell,
    searchChanged,
    assigned,
  };
}

/**
 * The command a stage runs, and its words: the first word that is not an assignment, a keyword,
 * `!`, a group or a wrapper (with the options a wrapper takes), written however it is written. A
 * command word that is an expansion (`$SHELL`) is a command nobody can name, which is said as `$`.
 */
export function resolve(text: string, keep: ReadonlySet<string> = NOT_KEPT): Resolved | null {
  const found = locate(argv(text), MAX_SPLITS, keep);
  const first = found.words[found.at];
  const common = {
    evalProgram: found.evalProgram,
    defined: found.defined,
    deep: found.deep,
    searchChanged: found.searchChanged,
    assigned: found.assigned,
  };
  if (first === undefined) {
    // `exec <<< 'x'` with no command changes the input of the shells that follow it, and
    // `sudo -s` with no command is a shell.
    const last = found.wrappers[found.wrappers.length - 1];
    if (found.impliesShell && found.leading.length >= 0 && last === 'sudo')
      return {
        ...common,
        name: 'sh',
        word: 'sudo',
        args: [...found.leading],
        wrappers: found.wrappers,
      };
    // `unshare -m`, `nsenter -t 1 -m`, `chroot /x`, `runuser -l user` with no command start a shell.
    if (last !== undefined && STARTS_A_SHELL.has(last))
      return {
        ...common,
        name: 'sh',
        word: last,
        args: [...found.leading],
        wrappers: found.wrappers,
      };
    if (last === 'exec' && found.leading.length > 0)
      return {
        ...common,
        name: 'exec',
        word: 'exec',
        args: [...found.leading],
        wrappers: found.wrappers.slice(0, -1),
      };
    // A stage of only redirects (`<<< x` after the `esac` that closes a `case`) is the redirect of
    // the compound command before it, with no command word of its own.
    if (found.leading.length > 0)
      return { ...common, name: '', word: '', args: [...found.leading], wrappers: found.wrappers };
    return found.defined.length > 0
      ? { ...common, name: '', word: '', args: [], wrappers: [] }
      : null;
  }
  return {
    ...common,
    name: first.expands ? '$' : canonicalName(baseOf(first.value).toLowerCase()),
    word: first.value,
    args: [...found.leading, ...argumentsOf(found.words.slice(found.at + 1))],
    wrappers: found.wrappers,
  };
}

/** The words of a stage that are text to it, not redirects: `2>&1` and `> out` are not printed. */
export function withoutRedirects(words: readonly Word[]): Word[] {
  const kept: Word[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] as Word;
    const redirect = w.redirect ? REDIRECT.exec(w.value) : null;
    if (redirect === null) kept.push(w);
    else if (w.value.length === redirect[0].length) i += 1;
  }
  return kept;
}
