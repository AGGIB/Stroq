// What may be the name of a file that comes out of somebody else's archive.
//
// The path of an entry is the one thing in an archive that picks where on the disk a byte goes, and
// it is chosen by the author of the archive. So the rules here are not about tidiness: each one shuts
// a way that a name has been used to write outside the folder it was meant for, to overwrite a file
// that was already vouched for, to plant a file a tool runs by itself (`.git`), or to look like
// something it is not when it is shown to the person who has to decide.
//
// A path is judged as text, before any filesystem is asked, so that the answer does not depend on the
// disk of the machine (it does follow the Unicode tables of the Node that runs it, see below). This
// file is plain ASCII on purpose: the characters it refuses are written as numbers, so that none of
// them can sit unseen in the source of the code that refuses them.
import { nameKey } from './path-collision.js';
import { LIMITS } from './types.js';

export type PathCheck =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

// ---------------------------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------------------------

/** Inclusive ranges of code points: `[first, last]`. */
type Ranges = readonly (readonly [number, number])[];

/**
 * What is refused is decided by the properties Unicode gives a character, and not by a list: a list
 * copied from two display helpers was found to miss the soft hyphen, the Hangul fillers, the Arabic
 * letter mark, the Mongolian free variation selectors, the grapheme joiner and more, every one of
 * which shows nothing or reorders what is shown. A `\p{}` class follows the Unicode tables of the
 * Node that runs this, so a newer Node may refuse a character that an older one lets through (Unicode
 * keeps these properties stable, so in practice they only grow, and Node 22 and 24 agree on every one
 * of them today). The explicit ranges below stay beside the classes as the floor that does not depend
 * on those tables.
 *
 * - control: `Cc`, the C0 and C1 blocks (NUL, the escape that starts a terminal sequence, DEL, and
 *   0x9b, the 8-bit form of CSI);
 * - hidden: `Cf` (format characters, the direction marks among them), `Cs` (a surrogate that stands
 *   alone), `Zl` and `Zp` (the line and paragraph separators) and `Default_Ignorable_Code_Point`,
 *   which is Unicode's own list of what a renderer is told to leave out: fillers, joiners, variation
 *   selectors, the tag block, and code points reserved for characters of this kind.
 */
const CONTROL_PROPERTIES = '\\p{Cc}';
const HIDDEN_PROPERTIES = '\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}';

/**
 * The C0 controls, DEL, and the C1 block. This is what `neutralizeControls` in core writes out, and
 * more: it leaves the tab and the newline for text that has several lines, and the name of a file
 * never has.
 */
const CONTROLS: Ranges = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
];

/**
 * A list, kept as a floor, of what shows nothing or changes what is shown: the union of what
 * `neutralizeControls` covers (the direction overrides and isolates, which write a name backwards)
 * and what the replay page writes out (`INVISIBLE` in replay/html.ts). The properties above hold all
 * of it and more; `safe-path-parity.test.ts` asks both helpers about every code point and fails if
 * either has learned one that the check does not refuse.
 */
const HIDDEN: Ranges = [
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width space, joiners, left-to-right and right-to-left marks
  [0x2028, 0x202e], // line and paragraph separators, direction embeddings and overrides
  [0x2060, 0x2064], // word joiner and the invisible operators
  [0x2066, 0x206f], // direction isolates, and the deprecated format characters
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // byte order mark, zero-width no-break space
  [0xfff9, 0xfffb], // interlinear annotation
  [0xe0000, 0xe007f], // tag characters
  [0xe0100, 0xe01ef], // variation selectors supplement
];

/** The inside of a regular expression class that holds `ranges` (to be used with the `u` flag). */
const classOf = (ranges: Ranges): string =>
  ranges.map(([first, last]) => `\\u{${first.toString(16)}}-\\u{${last.toString(16)}}`).join('');

const CONTROL = new RegExp(`[${CONTROL_PROPERTIES}${classOf(CONTROLS)}]`, 'u');
const HIDDEN_CHAR = new RegExp(`[${HIDDEN_PROPERTIES}${classOf(HIDDEN)}]`, 'u');
/** Every character above, each to be found one at a time. */
const UNSAFE_EACH = new RegExp(
  `[${CONTROL_PROPERTIES}${classOf(CONTROLS)}${HIDDEN_PROPERTIES}${classOf(HIDDEN)}]`,
  'gu',
);
/**
 * `< > " | ? *`: Windows does not allow them in the name of a file, and a shell or a command line
 * reads some of them as a pattern or a redirection. A path is promised to be a name on any filesystem.
 * Only these exact characters: the full-width forms CJK names use in their place are other characters.
 */
const WINDOWS_FORBIDDEN = /["*<>?|]/;
/** A surrogate that is not half of a pair: under the `u` flag a pair is one character, and is not matched. */
const LONE_SURROGATE = /[\u{d800}-\u{dfff}]/u;

/**
 * Whether `text` survives being written as UTF-8 and read back: no surrogate stands alone. What is
 * hashed is the UTF-8 of a name, and a lone surrogate has none, so two different names would be one.
 */
export const isWellFormed = (text: string): boolean => !LONE_SURROGATE.test(text);

/** What a decoder writes for bytes that were not UTF-8, so that two different names become one. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);
const ELLIPSIS = String.fromCodePoint(0x2026);

// ---------------------------------------------------------------------------------------------
// Names Windows treats as something else
// ---------------------------------------------------------------------------------------------

const DRIVE_LETTER = /^[A-Za-z]:/;
/**
 * `GIT~1`: the short name NTFS gives `.git`, which opens the same directory. This is the only 8.3
 * alias that is covered. NTFS gives every long name a short one (`GITMOD~1` for `.gitmodules`,
 * `GITATT~1` for `.gitattributes`), and a name that is not itself dangerous is not refused for what it
 * could be called: `.gitmodules` and `.gitattributes` are ordinary files in a tree, and their aliases
 * are not looked for. Nor is the alias of one ordinary name of a folder being another ordinary name of
 * it (`a-long-script.sh` and `a-long~1.sh`): that is a known limit, in the hazards of the spec.
 */
const GIT_SHORT_NAME = /^git~\d+$/;
/**
 * Names that Windows opens as a device whatever folder they are in and whatever follows a dot:
 * `NUL.txt` is NUL. `COM0` and `LPT0` are included, and so are the console handles, because the cost
 * of refusing a file of that name is nothing. (`COM` with a superscript digit is a device too; it is
 * found through `nameKey`, which turns the superscript into the plain digit.)
 */
const DEVICE_NAMES: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'conin$',
  'conout$',
  ...Array.from({ length: 10 }, (_, n) => `com${n}`),
  ...Array.from({ length: 10 }, (_, n) => `lpt${n}`),
]);

const TOO_LONG = `longer than ${LIMITS.maxPathBytes} bytes`;
const TOO_DEEP = `deeper than ${LIMITS.maxDepth} components`;

const refuse = (reason: string): PathCheck => ({ ok: false, reason });

/** What is wrong with one component of a path, or null. The text is fixed: it never repeats the component. */
function componentProblem(component: string): string | null {
  if (component === '') return 'empty component';
  if (component === '.' || component === '..') return "'.' or '..' component";
  // From here on the component is judged as a program that narrows names to a smaller character set
  // would see it (see `nameKey`). The end of the name is part of that: Windows drops a trailing dot or
  // space, and a full-width full stop or an ideographic space is one once narrowed, so `.git` followed
  // by either opens `.git`. The structural characters (`/`, `\`, `:`) are still judged as spelled.
  const name = nameKey(component);
  if (name.endsWith('.') || name.endsWith(' ')) {
    return 'component ending in a dot or a space';
  }
  if (name === '.git' || GIT_SHORT_NAME.test(name)) {
    return 'component named .git (or its Windows short name)';
  }
  // The device is what comes before the first dot, and Windows ignores spaces left before that dot.
  // The dot is looked for in the folded name, so that a full-width dot is one too.
  const dot = name.indexOf('.');
  const device = (dot === -1 ? name : name.slice(0, dot)).trimEnd();
  if (DEVICE_NAMES.has(device)) return 'Windows device name';
  return null;
}

/**
 * Whether `path` may be the name of an entry of a tree: relative, inside the folder it is put in, on
 * any filesystem, and showable. It is not rewritten; a path that passes is returned as it was.
 *
 * Refused: an empty path or component; `.` and `..`; an absolute path; any backslash; a drive letter;
 * a colon (an NTFS alternate data stream, which hides data behind a visible name); the six
 * characters Windows does not allow in a name (`< > " | ? *`); controls and every character that shows
 * nothing or changes what is shown (by Unicode property, see above); text that is not valid Unicode;
 * a component named `.git`, or by its NTFS short name `git~N`, or a Windows device name, in any case
 * and in any compatibility spelling (see `nameKey`: full-width letters, superscript digits, the
 * dotless i); a component that ends in a dot or a space (Windows drops it, so `a.` and `a` are one
 * file), also when it only ends in one once made plain (a full-width full stop, an ideographic space,
 * a no-break space, an ellipsis); and a path over the limits.
 *
 * The reason is a fixed phrase and never quotes the path, so that it can be printed as it is.
 */
export function checkEntryPath(path: unknown): PathCheck {
  if (typeof path !== 'string') return refuse('not text');
  if (path === '') return refuse('empty path');
  // A UTF-16 unit is at least one byte, so a longer string is too long, and nothing below has to
  // read more than the limit however long the path it was given.
  if (path.length > LIMITS.maxPathBytes) return refuse(TOO_LONG);
  if (!isWellFormed(path)) return refuse('not valid Unicode text (a lone surrogate)');
  if (Buffer.byteLength(path, 'utf8') > LIMITS.maxPathBytes) return refuse(TOO_LONG);
  if (path.includes(REPLACEMENT_CHARACTER)) {
    return refuse('replacement character (the name was not valid UTF-8)');
  }
  if (CONTROL.test(path)) return refuse('control character');
  if (HIDDEN_CHAR.test(path)) return refuse('invisible or direction-changing character');
  if (path.startsWith('/') || path.startsWith('\\')) return refuse('absolute path');
  if (path.includes('\\')) return refuse('backslash');
  if (DRIVE_LETTER.test(path)) return refuse('drive letter');
  if (path.includes(':')) return refuse("':' (a Windows alternate data stream)");
  if (WINDOWS_FORBIDDEN.test(path)) {
    return refuse('character Windows does not allow in a file name');
  }
  const components = path.split('/');
  if (components.length > LIMITS.maxDepth) return refuse(TOO_DEEP);
  for (const component of components) {
    const problem = componentProblem(component);
    if (problem !== null) return refuse(problem);
  }
  return { ok: true, path };
}

// ---------------------------------------------------------------------------------------------
// Tarballs
// ---------------------------------------------------------------------------------------------

/** The first component of `path` when there is a path below it, and it is a name and not a dot. */
function folderOf(path: string): string | null {
  const slash = path.indexOf('/');
  if (slash <= 0 || slash === path.length - 1) return null;
  const folder = path.slice(0, slash);
  return folder === '.' || folder === '..' ? null : folder;
}

/**
 * The paths of a tarball without the one folder it is wrapped in (`package/`, `owner-repo-1a2b3c/`):
 * when every path has the same first component and something below it, that one component is taken
 * off, and exactly one. Otherwise the paths are returned as they are. Either way the list returned is
 * a new one.
 *
 * A first component that is empty or a dot is not taken for a folder. The paths under it are then
 * judged as they are, and refused, instead of being turned into paths that would pass.
 */
export function stripTopComponent(paths: readonly string[]): readonly string[] {
  const first = paths[0];
  const folder = first === undefined ? null : folderOf(first);
  if (folder === null || !paths.every((path) => folderOf(path) === folder)) return [...paths];
  return paths.map((path) => path.slice(folder.length + 1));
}

// ---------------------------------------------------------------------------------------------
// Showing a path that was refused
// ---------------------------------------------------------------------------------------------

/** How much of a path an error message quotes. */
const QUOTED_UNITS = 80;

/**
 * A path as it may be put in a message: in quotes, cut short, and with every control, invisible and
 * direction-changing character written out as an escape, so that a name chosen by an attacker cannot
 * move the cursor, write the clipboard or reverse itself in the line that reports it.
 */
export function quotePath(path: string): string {
  const clipped = path.length > QUOTED_UNITS ? `${path.slice(0, QUOTED_UNITS)}${ELLIPSIS}` : path;
  // JSON writes the quote, the backslash, the C0 controls and lone surrogates; the pattern does the rest.
  return JSON.stringify(clipped).replace(UNSAFE_EACH, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}
