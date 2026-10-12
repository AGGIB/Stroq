// The shell in a Markdown document: fenced blocks tagged as a shell, and inline commands.
//
// A skill is documentation that an agent follows, so the commands in its examples are things the agent
// may run. Two shapes carry them: a fenced block whose tag names a shell (` ```bash `), and the inline
// form `` !`command` `` that a host runs while it loads a skill. Everything is read one line at a
// time, with `indexOf` and character tests and no pattern that could backtrack, so the work follows the
// size of the document and nothing else; a block is kept up to a size and no more.
import { SHELL_SNIPPET_MAX } from './blind-spots.js';

export interface FencedShell {
  /** The line of the file that the first line of the block is on. */
  readonly line: number;
  readonly lang: string;
  readonly text: string;
  /** True when the block was longer than a reading takes and was cut. */
  readonly cut: boolean;
}

export interface InlineShell {
  readonly line: number;
  readonly text: string;
}

export interface MarkdownShell {
  readonly blocks: readonly FencedShell[];
  readonly inline: readonly InlineShell[];
  /** Fenced blocks with no language, which are not read as shell because it is not said that they are. */
  readonly untagged: number;
}

const SHELL_LANGS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'shell',
  'console',
  'powershell',
  'pwsh',
  'ps1',
  'bat',
  'cmd',
  'shellscript',
  'sh-session',
  'shell-session',
]);
const PROMPT = '$ ';
const LANG_AT_START = /^[{.]*([A-Za-z0-9_+-]+)/;
/** The most of an info string that is looked at for the tag. */
const INFO_MAX = 64;

interface Fence {
  readonly char: string;
  readonly length: number;
  readonly indent: number;
  readonly info: string;
}

/** The fence that a line opens or closes, or null. A fence is three or more backticks or tildes. */
function fenceOf(raw: string): Fence | null {
  let indent = 0;
  while (
    indent < raw.length &&
    (raw.charCodeAt(indent) === 0x20 || raw.charCodeAt(indent) === 0x09)
  ) {
    indent += 1;
  }
  const char = raw.charAt(indent);
  if (char !== '`' && char !== '~') return null;
  let length = 0;
  while (raw.charAt(indent + length) === char) length += 1;
  if (length < 3) return null;
  return { char, length, indent, info: raw.slice(indent + length, indent + length + 1024) };
}

/** The tag of a fence: the first word of its info string, without braces, dots or attributes; '' if none. */
function langOf(info: string): string {
  const word = info.trim().slice(0, INFO_MAX).split(/\s/, 1)[0] ?? '';
  return (LANG_AT_START.exec(word)?.[1] ?? '').toLowerCase();
}

/** What a fence closes: the same character, at least as many, and nothing after but blanks. */
function closes(raw: string, open: Fence): boolean {
  const fence = fenceOf(raw);
  return (
    fence !== null &&
    fence.char === open.char &&
    fence.length >= open.length &&
    fence.info.trim() === ''
  );
}

/** A line of a block without the indentation of its fence, as Markdown takes it off. */
function dedent(line: string, indent: number): string {
  let strip = 0;
  while (
    strip < indent &&
    strip < line.length &&
    (line.charCodeAt(strip) === 0x20 || line.charCodeAt(strip) === 0x09)
  ) {
    strip += 1;
  }
  return line.slice(strip);
}

/** The `` !`command` `` forms on one line. */
function inlineOn(line: string, number: number, found: InlineShell[]): void {
  for (let at = line.indexOf('!`'); at !== -1;) {
    const end = line.indexOf('`', at + 2);
    // No closing backtick on this line means there is none for any later opening either.
    if (end === -1) return;
    const text = line.slice(at + 2, end);
    if (text.trim() !== '') found.push({ line: number, text });
    at = line.indexOf('!`', end + 1);
  }
}

interface OpenBlock {
  readonly fence: Fence;
  readonly lang: string;
  readonly shell: boolean;
  readonly first: number;
  readonly lines: string[];
  size: number;
  cut: boolean;
}

/** The text of a finished block, with the prompts of a console taken off. */
function finish(block: OpenBlock): FencedShell | null {
  const lines =
    block.lang === 'console'
      ? block.lines
          .filter((line) => line.startsWith(PROMPT))
          .map((line) => line.slice(PROMPT.length))
      : block.lines;
  const text = lines.join('\n');
  return text.trim() === '' ? null : { line: block.first, lang: block.lang, text, cut: block.cut };
}

export function readMarkdownShell(text: string): MarkdownShell {
  const blocks: FencedShell[] = [];
  const inline: InlineShell[] = [];
  let untagged = 0;
  let open: OpenBlock | null = null;

  let number = 0;
  for (let start = 0; start <= text.length;) {
    const next = text.indexOf('\n', start);
    const end = next === -1 ? text.length : next;
    const raw =
      text.endsWith('\r', end) && end > start ? text.slice(start, end - 1) : text.slice(start, end);
    number += 1;

    if (open !== null) {
      if (closes(raw, open.fence)) {
        const done = finish(open);
        if (done !== null) blocks.push(done);
        open = null;
      } else if (open.shell) {
        // Keep what fits, to the character: a line past the cap is cut where the cap falls.
        const room = SHELL_SNIPPET_MAX - open.size;
        const line = dedent(raw, open.fence.indent);
        if (line.length + 1 > room) open.cut = true;
        if (room > 0) {
          open.lines.push(line.slice(0, room));
          open.size += Math.min(line.length, room) + 1;
        }
      } else {
        inlineOn(raw, number, inline);
      }
    } else {
      const fence = fenceOf(raw);
      // A backtick fence has no backtick in its info string; a line that has one is inline code.
      if (fence !== null && !(fence.char === '`' && fence.info.includes('`'))) {
        const lang = langOf(fence.info);
        if (lang === '') untagged += 1;
        open = {
          fence,
          lang,
          shell: SHELL_LANGS.has(lang),
          first: number + 1,
          lines: [],
          size: 0,
          cut: false,
        };
      } else {
        inlineOn(raw, number, inline);
      }
    }
    if (next === -1) break;
    start = next + 1;
  }
  if (open !== null) {
    const done = finish(open);
    if (done !== null) blocks.push(done);
  }
  return { blocks, inline, untagged };
}
