// The name of the file a text came from, for the card.
//
// A provenance record keeps the first `MAX_STORED_CHARS` characters of what a read named, and the audit
// keeps the first `MAX_AUDIT_SUMMARY` of it. On a deep path either one can end inside a folder name, and
// the last piece of what is left is then not the file: the card called a README by the folder it sat
// in. Those two stored forms are left as they are (the replay matches a read to what came of it by
// comparing them), so the card works from the longer of the two forms of the read it has in hand, and
// says a file's name only when that form is whole. When none is, the card says "a file" and no name.

import { MAX_AUDIT_SUMMARY, MAX_STORED_CHARS } from '@stroq/core';

/** The tools whose reads name a file. */
export const FILE_TOOL = /^(?:Read|Grep|Glob)$/;

/** What the card keeps of a read's source: the longest form it has, and the file's name when it is whole. */
export interface ReadSource {
  readonly source: string;
  readonly name?: string;
}

/** A cut ends with an ellipsis in the records of older versions. */
const ELLIPSIS = /…$/;

/** The last piece of a path, or undefined when it ends in a slash. */
function lastPiece(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name === '' ? undefined : name;
}

/**
 * `stored` is the source a provenance record kept; `audited` is the summary of the same read in the
 * audit, when it is at hand. The audit form is used when the stored one is as long as a record keeps
 * (so it may have been cut) and the audit form is the same text, only longer: a short source is whole,
 * and a longer summary that merely begins with it is another file (`README` and `README.md`). A form is
 * whole when it is shorter than the length it is cut at: one that is exactly as long may have been cut.
 */
export function readSourceOf(
  tool: string,
  stored: string,
  audited: string | undefined,
): ReadSource {
  const longer =
    audited !== undefined &&
    stored.length >= MAX_STORED_CHARS &&
    audited.length > stored.length &&
    audited.startsWith(stored);
  const source = longer ? audited : stored;
  const limit = longer ? MAX_AUDIT_SUMMARY : MAX_STORED_CHARS;
  if (!FILE_TOOL.test(tool) || source.length >= limit || ELLIPSIS.test(source)) return { source };
  const name = lastPiece(source);
  return name === undefined ? { source } : { source, name };
}
