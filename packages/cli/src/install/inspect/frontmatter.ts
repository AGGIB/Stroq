// The front matter of a skill: the block of YAML between two `---` lines at the top of a Markdown file.
//
// It is the one place a skill declares what it asks for (`allowed-tools`) and what it runs (`hooks`),
// and it is written by the author, so it is read as hostile input: at most 16 KiB of it, parsed in safe
// mode (the core schema, which has no tag that builds an object, and no alias at all, so a document
// cannot be made to expand into a million nodes), and anything that does not parse is a sign to look
// at and never an error. A front matter that cannot be read declares nothing here, and that is said:
// the host that runs the skill may read it more leniently than this does.
import { parseDocument, type DocumentOptions, type ParseOptions, type SchemaOptions } from 'yaml';
import { FRONTMATTER_CAP_BYTES } from './blind-spots.js';
import { isObject, type JsonObject } from './json.js';
import type { TextFile } from './text-files.js';

export type Frontmatter =
  /** The file does not begin with a front matter. */
  | { readonly status: 'absent' }
  /** A mapping, and the line of the file that each of its top-level keys is on. */
  | {
      readonly status: 'ok';
      readonly data: JsonObject;
      readonly keyLines: ReadonlyMap<string, number>;
    }
  /** There is one and it cannot be read; `reason` is a fixed phrase. */
  | { readonly status: 'broken'; readonly reason: string; readonly tooLong: boolean };

/** Safe mode: the core schema, no aliases, no merge keys, no repeated key, and a document that is one. */
const YAML_OPTIONS: ParseOptions & DocumentOptions & SchemaOptions = {
  schema: 'core',
  version: '1.2',
  uniqueKeys: true,
  strict: true,
  merge: false,
  prettyErrors: false,
};

const DELIMITER = '---';
const BYTE_ORDER_MARK = '﻿';

const broken = (reason: string, tooLong = false): Frontmatter => ({
  status: 'broken',
  reason,
  tooLong,
});

/** Whether a line is the end of a front matter: three dashes (or dots) and nothing after them but blanks. */
function closes(line: string): boolean {
  const body = line.trimEnd();
  return body === DELIMITER || body === '...';
}

/** The lines of the block between the two delimiters, and where it ends; null if it never ends in the cap. */
function findBlock(text: string): { block: string; end: number; firstLine: number } | null {
  const first = text.indexOf('\n');
  if (first === -1) return null;
  let lineStart = first + 1;
  while (lineStart <= text.length) {
    const next = text.indexOf('\n', lineStart);
    const lineEnd = next === -1 ? text.length : next;
    const line = text.slice(lineStart, lineEnd);
    // The text through the closing line, without its newline, must be inside the cap.
    if (closes(line)) {
      const end = lineStart + line.trimEnd().length;
      return { block: text.slice(first + 1, lineStart), end, firstLine: 2 };
    }
    if (lineEnd > FRONTMATTER_CAP_BYTES || next === -1) return null;
    lineStart = next + 1;
  }
  return null;
}

/** The line (from 1) of each top-level key of a block, for pointing a person at it. */
function keyLinesOf(block: string, firstLine: number): Map<string, number> {
  const lines = new Map<string, number>();
  let number = firstLine;
  for (const line of block.split('\n')) {
    const first = line.charCodeAt(0);
    // A top-level key starts in the first column with something other than a comment, a list dash or a blank.
    if (first > 0x20 && first !== 0x23 && first !== 0x2d) {
      const colon = line.indexOf(':');
      const key = (colon > 0 ? line.slice(0, colon) : '').trim().replace(/^["']|["']$/g, '');
      if (key !== '' && !lines.has(key)) lines.set(key, number);
    }
    number += 1;
  }
  return lines;
}

/** The front matter of a Markdown file. */
export function readFrontmatter(file: TextFile): Frontmatter {
  const text = file.text.startsWith(BYTE_ORDER_MARK) ? file.text.slice(1) : file.text;
  const firstLineEnd = text.indexOf('\n');
  const opening = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  if (opening.trimEnd() !== DELIMITER) return { status: 'absent' };

  const found = findBlock(text);
  if (found === null) {
    return broken('is longer than the 16 KiB that is read, or is never closed', true);
  }
  if (Buffer.byteLength(text.slice(0, found.end), 'utf8') > FRONTMATTER_CAP_BYTES) {
    return broken('is longer than the 16 KiB that is read, or is never closed', true);
  }
  const block = found.block.replace(/\r$/gm, '');
  try {
    const document = parseDocument(block, YAML_OPTIONS);
    if (document.errors.length > 0) return broken('is not valid YAML');
    const data: unknown = document.toJS({ maxAliasCount: 0 });
    if (data === null || data === undefined) {
      return { status: 'ok', data: {}, keyLines: new Map() };
    }
    if (!isObject(data)) return broken('is not a mapping of keys to values');
    return { status: 'ok', data, keyLines: keyLinesOf(block, found.firstLine) };
  } catch {
    // An alias, a nesting too deep to walk: whatever stops the parser, the front matter is not read.
    return broken('is not valid YAML, or uses a feature that is not read (an alias)');
  }
}
