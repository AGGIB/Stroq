import { parseDocument } from 'yaml';

/**
 * YAML read the way the hook reads a policy, and refused in words of ours.
 *
 * The hook calls `parse` from the `yaml` package and lets it throw. `parse` is `parseDocument`, a throw
 * of the first error, and `toJS`, so this does the same three things and gets the same value, with two
 * differences that matter to a person looking at a file somebody else wrote: it never lets the package
 * write a warning to the terminal (those quote the text of the file), and it turns every refusal into a
 * fixed phrase, a line number and the package's own error code, which is one of a fixed list of
 * capitals, never a piece of the file.
 *
 * `toJS` is what refuses an alias bomb (`maxAliasCount`, 100 by default in the package): nested anchors
 * that would expand to billions of nodes throw before they are built.
 */

export interface YamlFault {
  /** What is wrong, in a phrase that holds nothing from the file. */
  readonly what: string;
  /** The package's error code (`BAD_INDENT`, `DUPLICATE_KEY`, ...), or null for a refusal that has none. */
  readonly code: string | null;
  /** The line the first error is on, counting from 1, or null when it has none. */
  readonly line: number | null;
}

export type YamlRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly fault: YamlFault };

/** The package's codes are capitals and underscores; anything else is not taken for a code. */
const FIXED_CODE = /^[A-Z][A-Z_]{1,40}$/;

const NOT_YAML = 'the file is not valid YAML';
const ALIAS_BOMB =
  'the file uses YAML aliases that would expand to far more than it holds, and was refused';
const TOO_DEEP = 'the file is nested more deeply than can be read';
const UNREADABLE = 'the file could not be read as YAML';

function faultOfThrown(err: unknown): YamlFault {
  // The package throws a ReferenceError for an alias count over its limit, and the JavaScript engine
  // throws a RangeError when a document nests deeper than the stack allows.
  if (err instanceof ReferenceError) return { what: ALIAS_BOMB, code: null, line: null };
  if (err instanceof RangeError) return { what: TOO_DEEP, code: null, line: null };
  return { what: UNREADABLE, code: null, line: null };
}

export function readYaml(text: string): YamlRead {
  try {
    const document = parseDocument(text);
    const first = document.errors[0];
    if (first !== undefined) {
      return {
        ok: false,
        fault: {
          what: NOT_YAML,
          code: FIXED_CODE.test(first.code) ? first.code : null,
          line: first.linePos?.[0].line ?? null,
        },
      };
    }
    return { ok: true, value: document.toJS() };
  } catch (err) {
    return { ok: false, fault: faultOfThrown(err) };
  }
}
