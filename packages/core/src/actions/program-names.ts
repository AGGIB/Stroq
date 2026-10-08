import { functionsDefinedIn } from './function-definitions.js';
import { SHELL_WORDS, lex } from './shell-lex.js';
import { ASSIGNED_SHELL, OVERRIDES_PRINTERS, mayHandShell } from './shell-names.js';
import { baseOf, resolve, type Resolved } from './shell-words.js';

/**
 * The names a text gives, which a program decoded from it or nested in it can use without the text
 * that gives them being in sight: a variable that stands for a shell, a copy of one, a function, an
 * alias, a hook that runs by itself.
 */

/**
 * What a text gives names to. A text nested in it, or decoded from it, runs where these are in
 * effect, so they are carried down to it: `export x=bash; bash -c 'echo … | $x'`.
 */
export interface Names {
  /** `echo` or `printf` is defined or aliased in the text: what they print is not what they say. */
  readonly overridden: boolean;
  /** A shell is assigned to a variable in the text, so a command word that expands may be one. */
  readonly assignsShell: boolean;
  /** Names the text gives to a copy of a shell or a link to one: `ln -s /bin/bash ./zz`. */
  readonly aliases: ReadonlySet<string>;
  /** Names of the functions the text defines: what they hold runs with the input they are given. */
  readonly functions: ReadonlySet<string>;
  /** The bodies of those functions, where they are read (null where a body is not): what a call hands its input to. */
  readonly bodies: ReadonlyMap<string, readonly (string | null)[]>;
  /** A hook runs what it holds without being called by name: a `DEBUG` trap, zsh's `chpwd`. */
  readonly implicit: boolean;
}

export const NO_NAMES: Names = {
  overridden: false,
  assignsShell: false,
  aliases: new Set(),
  functions: new Set(),
  bodies: new Map(),
  implicit: false,
};

/** The most function and copy-of-a-shell names kept and looked for; past it, a text may use one. */
const MAX_NAMES = 32;

export function mergeNames(a: Names, b: Names): Names {
  if (b === NO_NAMES) return a;
  if (a === NO_NAMES) return b;
  const limited = (x: ReadonlySet<string>, y: ReadonlySet<string>): Set<string> =>
    new Set([...x, ...y].slice(0, MAX_NAMES + 1));
  return {
    overridden: a.overridden || b.overridden,
    assignsShell: a.assignsShell || b.assignsShell,
    implicit: a.implicit || b.implicit,
    aliases: limited(a.aliases, b.aliases),
    functions: limited(a.functions, b.functions),
    bodies: mergedBodies(a.bodies, b.bodies),
  };
}

/** The bodies of the functions of two texts: a name that both define has the bodies of both. */
function mergedBodies(
  a: Names['bodies'],
  b: Names['bodies'],
): Map<string, readonly (string | null)[]> {
  const merged = new Map(a);
  for (const [name, found] of b) merged.set(name, [...(merged.get(name) ?? []), ...found]);
  return merged;
}

/** The bodies of the functions a text defines, by name. */
export function functionBodies(text: string): Map<string, readonly (string | null)[]> {
  const bodies = new Map<string, readonly (string | null)[]>();
  for (const definition of functionsDefinedIn(text).definitions) {
    const name = definition.name.toLowerCase();
    bodies.set(name, [...(bodies.get(name) ?? []), definition.body]);
  }
  return bodies;
}

/** The names without one of them: what a function's own body says of itself is not a mention of another. */
export const withoutFunction = (names: Names, name: string): Names => ({
  ...names,
  functions: new Set([...names.functions].filter((each) => each !== name)),
});

/** The words of a text, as a set: a name is looked up in it once, and not searched for in it. */
const wordsOf = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(/[\s;|&(){}<>"'`$=\\/]+/));

/**
 * Whether a text may use a name that was given elsewhere: a variable that stands for a shell where
 * a variable was given one, a function the text defines, a copy of a shell. A function whose body is
 * known is a name only where `holdsShell` says that its body runs one.
 */
export function namesMentioned(
  text: string,
  names: Names,
  holdsShell: (functionName: string) => boolean = () => true,
): boolean {
  if (names.implicit || (names.assignsShell && text.includes('$'))) return true;
  const count = names.functions.size + names.aliases.size;
  if (count === 0) return false;
  if (count > MAX_NAMES) return true;
  const words = wordsOf(text);
  for (const name of names.aliases) if (words.has(name)) return true;
  for (const name of names.functions) if (words.has(name) && holdsShell(name)) return true;
  return false;
}

/** The names a text gives to copies of a shell, and to functions: found before it is read. */
export function namesIn(
  lines: readonly { readonly commands: readonly (Resolved | null)[] }[],
): Pick<Names, 'aliases' | 'functions'> {
  const aliases = new Set<string>();
  const functions = new Set<string>();
  for (const line of lines)
    for (const command of line.commands) {
      if (command === null) continue;
      for (const name of command.defined) functions.add(name.toLowerCase());
      const copy = copyOfShell(command);
      if (copy !== null) aliases.add(copy.toLowerCase());
      for (const name of aliasedShells(command)) aliases.add(name.toLowerCase());
    }
  return { aliases, functions };
}

/** What could give a name: a function head, an alias, or a command that copies a file. */
const MAY_DEFINE = /\(\s*\)|\bfunction\b|\balias\b|\b(?:ln|cp|install|mv)\b/;

/**
 * A hook that runs by itself: a trap on `DEBUG`, `ERR` or `RETURN`, a zsh `TRAP…` function or a
 * `chpwd`, `precmd`, `preexec`, `periodic`, a missing-command handler. With a shell in the text,
 * what any command inside a body hands on may reach it.
 */
const IMPLICIT_HOOK =
  /\btrap\b[^\n;]{0,200}?\b(?:DEBUG|ERR|RETURN|ZERR)\b|\bTRAP[A-Z]+\b|\b(?:chpwd|precmd|preexec|periodic|command_not_found_handler?)\b/;
export const hooksRun = (text: string): boolean => IMPLICIT_HOOK.test(text) && mayHandShell(text);

/**
 * What a text gives names to, for the texts nested in it: found by reading it, which costs what
 * its text does and is done only where something in it could give one. A text there is no room
 * to read may give any.
 */
export function namesOfText(text: string, budget: { room: number }): Names {
  const overridden = OVERRIDES_PRINTERS.test(text);
  const assignsShell = ASSIGNED_SHELL.test(text);
  const implicit = hooksRun(text);
  if (!MAY_DEFINE.test(text))
    return overridden || assignsShell || implicit
      ? { ...NO_NAMES, overridden, assignsShell, implicit }
      : NO_NAMES;
  if (text.length > budget.room) return { ...NO_NAMES, overridden, assignsShell: true, implicit };
  budget.room -= text.length;
  const lines = lex(text).pipelines.map((stages) => ({
    commands: stages.map((stage) => resolve(stage.text)),
  }));
  return { overridden, assignsShell, implicit, ...namesIn(lines), bodies: functionBodies(text) };
}

/** `alias b=bash`, `alias -g B='| bash'`: the names an alias gives to a shell. */
function aliasedShells(command: Resolved): string[] {
  if (command.name !== 'alias') return [];
  return command.args.flatMap((word) => {
    const match = /^([^=\s]+)=(.*)$/s.exec(word.value);
    const first = (match?.[2] ?? '').replace(/^[\s'"|;&]+/, '').split(/\s+/)[0] ?? '';
    return match !== null && SHELL_WORDS.has(baseOf(first).toLowerCase())
      ? [match[1] as string]
      : [];
  });
}

/** `ln -s /bin/bash ./zz`, `cp /bin/sh x`: the name the copy of a shell is given. */
function copyOfShell(command: Resolved): string | null {
  if (!['ln', 'cp', 'install', 'mv'].includes(command.name)) return null;
  const operands = command.args
    .filter((w) => !w.redirect && (!w.value.startsWith('-') || w.value === '-'))
    .map((w) => w.value);
  const last = operands[operands.length - 1];
  const copiesShell = operands.slice(0, -1).some((o) => SHELL_WORDS.has(baseOf(o)));
  return operands.length < 2 || last === undefined || !copiesShell
    ? null
    : baseOf(last.replace(/\/+$/, ''));
}
