import type {
  buildSkillTomlDisable,
  CodexSkillDisableOwnership,
} from './codex-skill-control-toml.ts';
import {
  codexSkillTomlArrayRemoval,
  codexSkillTomlFieldRemoval,
  findCodexSkillTomlValue,
} from './codex-skill-control-toml-lex.ts';
import {
  plain,
  readSkillControlToml,
  removeSkillTomlSpans,
  same,
  skillTomlError,
  verifySkillTomlRestore,
} from './codex-skill-control-toml-shared.ts';

const equalBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const occurrences = (text: string, needle: string) => {
  const result: number[] = [];
  let at = 0;
  while (at <= text.length) {
    const found = text.indexOf(needle, at);
    if (found < 0) break;
    result.push(found);
    at = found + Math.max(1, needle.length);
  }
  return result;
};
function verifiedOwnership(owned: CodexSkillDisableOwnership, build: typeof buildSkillTomlDisable) {
  if (
    !plain(owned) ||
    Object.keys(owned).sort().join() !==
      ['schema', 'operationId', 'documentPath', 'before', 'candidate'].sort().join() ||
    owned.schema !== 'stroq-codex-skill-disable-transform/1' ||
    !(owned.candidate instanceof Uint8Array)
  )
    return skillTomlError('conflict');
  let planned: ReturnType<typeof buildSkillTomlDisable>;
  try {
    planned = build({
      bytes: owned.before,
      operationId: owned.operationId,
      documentPath: owned.documentPath,
    });
  } catch {
    return skillTomlError('conflict');
  }
  if (!equalBytes(owned.candidate, planned.bytes)) return skillTomlError('conflict');
  return planned;
}
function markerSpan(text: string, comments: { start: number; end: number }[], marker: string) {
  const matches = comments.filter((c) => text.slice(c.start, c.end) === marker);
  if (matches.length !== 1) return skillTomlError('conflict');
  const c = matches[0]!,
    lineStart = text.lastIndexOf('\n', c.start - 1) + 1;
  if (lineStart !== c.start) return skillTomlError('conflict');
  const end =
    c.end +
    (text.slice(c.end, c.end + 2) === '\r\n' ? 2 : /[\r\n]/.test(text[c.end] ?? '') ? 1 : 0);
  return { start: lineStart, end };
}

/** Re-derive private ownership, then remove only its known rule and comment. Never roll back a later file. */
export function restoreSkillTomlOwnership(
  input: { bytes: Uint8Array; owned: CodexSkillDisableOwnership },
  build: typeof buildSkillTomlDisable,
): Uint8Array | null {
  const planned = verifiedOwnership(input.owned, build),
    current = readSkillControlToml(input.bytes),
    ownIndex = planned.before.rules.length;
  if (equalBytes(input.bytes, planned.bytes))
    return input.owned.before === null ? null : Buffer.from(input.owned.before);
  const ownRule = { path: input.owned.documentPath, enabled: false };
  if (
    !same(current.rules.slice(0, ownIndex), planned.before.rules) ||
    !same(current.rules[ownIndex], ownRule)
  )
    return skillTomlError('conflict');
  const marker = markerSpan(current.text, current.index.comments, planned.marker);
  const accept = (text: string): Uint8Array => {
    const bytes = Buffer.from(text),
      after = readSkillControlToml(bytes);
    verifySkillTomlRestore(current.document, after.document, planned.before.document, ownIndex);
    return bytes;
  };
  // Preserve original punctuation/presence whenever all inserted spans still exist.
  const exact = planned.inserts.map((i) => ({
    text: i.text,
    positions: occurrences(current.text, i.text),
  }));
  if (exact.every((i) => i.positions.length === 1)) {
    try {
      return accept(
        removeSkillTomlSpans(
          current.text,
          exact.map((i) => ({ start: i.positions[0]!, end: i.positions[0]! + i.text.length })),
        ),
      );
    } catch {}
  }
  const array = findCodexSkillTomlValue(current.index, ['skills', 'config']);
  let spans: { start: number; end: number }[];
  if (array) {
    const node = array.value,
      own = node.children[ownIndex];
    if (node.kind !== 'array' || !own || current.text.slice(own.start, own.end) !== planned.row)
      return skillTomlError('conflict');
    const parent = findCodexSkillTomlValue(current.index, ['skills']);
    if (
      planned.shape === 'inline-table' &&
      current.rules.length === 1 &&
      parent?.value.kind === 'inline' &&
      current.text.slice(array.start, array.value.end) === 'config = [' + planned.row + ']'
    )
      spans = codexSkillTomlFieldRemoval(parent.value, array);
    else spans = codexSkillTomlArrayRemoval(node, ownIndex);
  } else {
    const headers = current.index.headers.filter(
        (h) => h.array && h.path.length === 2 && h.path[0] === 'skills' && h.path[1] === 'config',
      ),
      header = headers[ownIndex];
    if (!header) return skillTomlError('conflict');
    const block =
      '[[skills.config]]' +
      planned.eol +
      'path = ' +
      JSON.stringify(input.owned.documentPath) +
      planned.eol +
      'enabled = false' +
      planned.eol;
    if (current.text.slice(header.start, header.start + block.length) !== block)
      return skillTomlError('conflict');
    spans = [{ start: header.start, end: header.start + block.length }];
  }
  try {
    return accept(removeSkillTomlSpans(current.text, [...spans, marker]));
  } catch {
    return skillTomlError('conflict');
  }
}
