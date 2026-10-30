import { findCodexSkillTomlValue } from './codex-skill-control-toml-lex.ts';
import {
  assertSkillDocumentPath,
  markerFor,
  plain,
  readSkillControlToml,
  same,
  skillTomlError,
  validOperation,
} from './codex-skill-control-toml-shared.ts';
import { restoreSkillTomlOwnership } from './codex-skill-control-toml-restore.ts';
export interface CodexSkillDisableOwnership {
  schema: 'stroq-codex-skill-disable-transform/1';
  operationId: string;
  documentPath: string;
  before: Uint8Array | null;
  candidate: Uint8Array;
}
export interface CodexSkillDisablePlan {
  bytes: Uint8Array;
  owned: CodexSkillDisableOwnership;
  shape: 'aot' | 'inline-array' | 'inline-table';
  rulesBefore: number;
}
export interface CodexSkillTomlInsertion {
  at: number;
  text: string;
}

/** Server-private pure planner: no path is read and no skill or native client executes. */
export function buildSkillTomlDisable(input: {
  bytes: Uint8Array | null;
  documentPath: string;
  operationId: string;
}) {
  assertSkillDocumentPath(input.documentPath);
  if (!validOperation(input.operationId)) return skillTomlError('invalid');
  const before = readSkillControlToml(input.bytes);
  if (before.rules.length >= 512) return skillTomlError('limit');
  const marker = markerFor(input.operationId);
  if (before.text.includes(marker)) return skillTomlError('conflict');
  const eol = before.text.includes('\r\n') ? '\r\n' : '\n',
    row = '{ path = ' + JSON.stringify(input.documentPath) + ', enabled = false }';
  const array = findCodexSkillTomlValue(before.index, ['skills', 'config']),
    parent = findCodexSkillTomlValue(before.index, ['skills']);
  const separator =
    before.text.length > 0 && !before.text.endsWith('\n') && !before.text.endsWith('\r') ? eol : '';
  const inserts: CodexSkillTomlInsertion[] = [];
  let shape: CodexSkillDisablePlan['shape'];
  const append = (
    node: { end: number; commas: number[] },
    lastEnd: number | undefined,
    value: string,
  ) => {
    const trailing = lastEnd !== undefined && node.commas.some((at) => at >= lastEnd);
    const prefix = lastEnd === undefined ? '' : trailing ? ' ' : ', ';
    return { at: node.end - 1, text: prefix + value + (trailing ? ', ' : '') };
  };
  if (array) {
    if (array.value.kind !== 'array') return skillTomlError('invalid');
    shape = 'inline-array';
    inserts.push(append(array.value, array.value.children.at(-1)?.end, row));
    inserts.push({ at: before.text.length, text: separator + marker + eol });
  } else if (parent?.value.kind === 'inline') {
    shape = 'inline-table';
    inserts.push(
      append(parent.value, parent.value.fields.at(-1)?.value.end, 'config = [' + row + ']'),
    );
    inserts.push({ at: before.text.length, text: separator + marker + eol });
  } else {
    shape = 'aot';
    inserts.push({
      at: before.text.length,
      text:
        separator +
        marker +
        eol +
        '[[skills.config]]' +
        eol +
        'path = ' +
        JSON.stringify(input.documentPath) +
        eol +
        'enabled = false' +
        eol,
    });
  }
  let text = before.text;
  for (const insert of [...inserts].sort((a, b) => b.at - a.at))
    text = text.slice(0, insert.at) + insert.text + text.slice(insert.at);
  const bytes = Buffer.from(text),
    after = readSkillControlToml(bytes);
  const expected = {
    ...before.document,
    skills: {
      ...(plain(before.document.skills) ? before.document.skills : {}),
      config: [...before.rules, { path: input.documentPath, enabled: false }],
    },
  };
  if (!same(after.document, expected)) return skillTomlError('invalid');
  return { before, after, bytes, shape, inserts, row, eol, marker };
}
export function planCodexSkillDisable(input: {
  bytes: Uint8Array | null;
  documentPath: string;
  operationId: string;
}): CodexSkillDisablePlan {
  const result = buildSkillTomlDisable(input);
  return {
    bytes: result.bytes,
    shape: result.shape,
    rulesBefore: result.before.rules.length,
    owned: {
      schema: 'stroq-codex-skill-disable-transform/1',
      operationId: input.operationId,
      documentPath: input.documentPath,
      before: input.bytes === null ? null : Buffer.from(input.bytes),
      candidate: Buffer.from(result.bytes),
    },
  };
}
export function restoreCodexSkillDisable(input: {
  bytes: Uint8Array;
  owned: CodexSkillDisableOwnership;
}): Uint8Array | null {
  return restoreSkillTomlOwnership(input, buildSkillTomlDisable);
}
