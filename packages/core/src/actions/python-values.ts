import { COMMAND_ENVIRONMENT } from './command-environment.js';
import type { PythonToken } from './inline-python.js';
import type { Names } from './python-bindings.js';
import { isName, isOp } from './python-vocabulary.js';

/**
 * The values a Python program binds to a name once and uses as the arguments of a process it starts
 * (`python-processes.ts`): a command line written out as a list (`cmd = ['bash', 'run.sh']`), and a
 * copy of the environment that gets variables written out (`env = os.environ.copy(); env['A'] = '1'`).
 *
 * Neither is a value the reader may take for what it looks like unless nothing else touches the name.
 * A string is the same wherever it is read; a list is changed by `cmd.append(x)`, `cmd[0] = x` and
 * `cmd += y`, none of which binds the name again, and an environment by `env.update(x)`, `env.pop(k)`
 * and `f(env)`. So a name qualifies only where every place the program writes it is accounted for: a
 * list is written twice (where it is bound, and where it is used), and an environment where it is bound,
 * where a variable is set in it with two strings written out, and where it is given to a process as `env=`.
 * A name used in any other way is left to the caller, as unread.
 */

export interface NamedValues {
  /** A name bound once to a list or tuple written out, by the token range of the literal. */
  readonly lists: ReadonlyMap<string, readonly [number, number]>;
  /** A name bound once to `os.environ.copy()` and set only to strings written out, by its variables in order. */
  readonly environments: ReadonlyMap<string, readonly (readonly [string, string])[]>;
  /** The `environ` tokens of those copies, which read the environment and do not change it. */
  readonly copies: ReadonlySet<number>;
}

/** A name written more often than this in one program is not followed: the cost of reading it is bounded. */
const MAX_OCCURRENCES = 256;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Variables that make a program start something else, beyond the ones a command line reader
 * already knows (`COMMAND_ENVIRONMENT`): the start-up files and option variables of the interpreters
 * and package managers (`NODE_OPTIONS`, `PYTHONSTARTUP`, `npm_config_script_shell`), the files a shell
 * reads, and the places a tool looks for its configuration. A process given one is not read.
 */
const STARTUP_VARIABLE =
  /^(?:PYTHON|NODE|NPM|RUBY|GEM|BUNDLE|PERL|JAVA|_JAVA|JDK|CLASSPATH|MAVEN|GRADLE|CARGO|RUST|GO|PIP|UV_|POETRY|PNPM|YARN|COMPOSER|BASH|SHELL|SSH_|XDG_|HOME$|ZDOTDIR$|TMPDIR$)/i;

/** A variable that a process may be given without changing what it runs. */
export function isPlainVariable(key: string): boolean {
  return (
    VARIABLE_NAME.test(key) && !STARTUP_VARIABLE.test(key) && !COMMAND_ENVIRONMENT.test(`${key}=`)
  );
}

const noValues: NamedValues = { lists: new Map(), environments: new Map(), copies: new Set() };

export function readNamedValues(
  tokens: readonly PythonToken[],
  match: ReadonlyMap<number, number>,
  names: Names,
  skip: (i: number) => boolean,
): NamedValues {
  const occurrences = new Map<string, number[]>();
  tokens.forEach((tok, i) => {
    if (tok.kind !== 'name' || skip(i)) return;
    const found = occurrences.get(tok.text);
    if (found === undefined) occurrences.set(tok.text, [i]);
    else if (found.length <= MAX_OCCURRENCES) found.push(i);
  });
  const startsStatement = (at: number): boolean => {
    const before = tokens[at - 1];
    return before === undefined || before.kind === 'nl' || isOp(before, ';');
  };
  const endsStatement = (at: number): boolean => {
    const tok = tokens[at];
    return tok === undefined || tok.kind === 'nl' || isOp(tok, ';');
  };
  const lists = new Map<string, readonly [number, number]>();
  const environments = new Map<string, readonly (readonly [string, string])[]>();
  const copies = new Set<number>();
  const seen = new Set<string>();
  for (let i = 1; i < tokens.length; i += 1) {
    const target = tokens[i - 1] as PythonToken;
    if (!isOp(tokens[i], '=') || target.kind !== 'name' || !startsStatement(i - 1)) continue;
    const name = target.text;
    const where = occurrences.get(name) ?? [];
    if (seen.has(name) || names.imported.has(name) || where.length > MAX_OCCURRENCES) continue;
    seen.add(name);
    const open = tokens[i + 1];
    if (open !== undefined && (isOp(open, '[') || isOp(open, '('))) {
      const close = match.get(i + 1);
      // Written twice: where it is bound, and where it is used as the command line.
      if (close !== undefined && endsStatement(close + 1) && where.length === 2)
        lists.set(name, [i + 1, close + 1]);
      continue;
    }
    const environ = copiedEnvironment(tokens, names, i + 1, endsStatement);
    if (environ === null) continue;
    const variables = environmentVariables(tokens, where, i - 1, startsStatement, endsStatement);
    if (variables === null) continue;
    environments.set(name, variables);
    copies.add(environ);
  }
  return lists.size === 0 && environments.size === 0 ? noValues : { lists, environments, copies };
}

/** The index of `environ` in `os.environ.copy()` at `at`, or null when the tokens there are anything else. */
function copiedEnvironment(
  tokens: readonly PythonToken[],
  names: Names,
  at: number,
  endsStatement: (at: number) => boolean,
): number | null {
  const owner = tokens[at];
  const found =
    owner !== undefined &&
    owner.kind === 'name' &&
    names.os.has(owner.text) &&
    isOp(tokens[at + 1], '.') &&
    isName(tokens[at + 2], 'environ') &&
    isOp(tokens[at + 3], '.') &&
    isName(tokens[at + 4], 'copy') &&
    isOp(tokens[at + 5], '(') &&
    isOp(tokens[at + 6], ')') &&
    endsStatement(at + 7);
  return found ? at + 2 : null;
}

/**
 * The variables set in a copy of the environment, in order, or null when the name is written
 * anywhere the reader does not account for: each of its places is the binding (`bound`), a
 * statement `env['KEY'] = 'value'` with both strings written out, or the value of `env=` in a call
 * (and, when the name is `env` itself, the keyword before it, which reads nothing).
 */
function environmentVariables(
  tokens: readonly PythonToken[],
  where: readonly number[],
  bound: number,
  startsStatement: (at: number) => boolean,
  endsStatement: (at: number) => boolean,
): readonly (readonly [string, string])[] | null {
  const variables: Array<readonly [string, string]> = [];
  const keys = new Set<string>();
  const accounted = new Set<number>([bound]);
  for (const at of where) {
    const key = tokens[at + 2];
    const value = tokens[at + 5];
    const sets =
      startsStatement(at) &&
      isOp(tokens[at + 1], '[') &&
      key?.value !== undefined &&
      isOp(tokens[at + 3], ']') &&
      isOp(tokens[at + 4], '=') &&
      value?.value !== undefined &&
      endsStatement(at + 6);
    if (sets) {
      if (!isPlainVariable(key.value as string) || keys.has(key.value as string)) return null;
      keys.add(key.value as string);
      variables.push([key.value as string, value.value as string]);
      accounted.add(at);
    } else if (
      isOp(tokens[at - 1], '=') &&
      isName(tokens[at - 2], 'env') &&
      (isOp(tokens[at - 3], '(') || isOp(tokens[at - 3], ',')) &&
      (isOp(tokens[at + 1], ',') || isOp(tokens[at + 1], ')'))
    ) {
      accounted.add(at);
      accounted.add(at - 2);
    }
  }
  return where.every((at) => accounted.has(at)) ? variables : null;
}
