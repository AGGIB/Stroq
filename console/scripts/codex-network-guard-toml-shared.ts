import { parse } from 'smol-toml';
import {
  indexCodexSkillToml,
  findCodexSkillTomlValue,
  type TomlFieldSpan,
  type TomlValueSpan,
} from './codex-skill-control-toml-lex.ts';
import { plain, same, safeText, validOperation } from './codex-skill-control-toml-shared.ts';
export { plain, same, validOperation, findCodexSkillTomlValue };
export const networkTomlError = (code: 'invalid' | 'limit' | 'conflict'): never => {
  throw Error('codex-network-guard-' + code);
};
export type NetworkTomlMutation = { start: number; end: number; text: string };
export const markerFor = (id: string) => '# stroq-network-guard ' + id;
export function readNetworkToml(bytes: Uint8Array | null) {
  if (bytes !== null && !(bytes instanceof Uint8Array)) return networkTomlError('invalid');
  if (bytes !== null && bytes.byteLength > 256 * 1024) return networkTomlError('limit');
  let text: string, document: Record<string, unknown>;
  try {
    text =
      bytes === null ? '' : new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes);
    document = parse(text.replace(/^\uFEFF/, ''), {
      maxDepth: 32,
      unsafeKeyBehaviour: 'throw',
      integersAsBigInt: true,
    });
  } catch {
    return networkTomlError('invalid');
  }
  let nodes = 0;
  const visit = (v: unknown, depth = 0): void => {
    if (++nodes > 16384 || depth > 32) networkTomlError('limit');
    if (Array.isArray(v)) for (const x of v) visit(x, depth + 1);
    else if (plain(v)) for (const x of Object.values(v)) visit(x, depth + 1);
  };
  visit(document);
  if (
    (document.default_permissions !== undefined && !safeText(document.default_permissions, 2048)) ||
    (document.permissions !== undefined && !plain(document.permissions)) ||
    (document.sandbox_mode !== undefined && !safeText(document.sandbox_mode, 64)) ||
    (document.sandbox_workspace_write !== undefined && !plain(document.sandbox_workspace_write))
  )
    return networkTomlError('invalid');
  if (
    plain(document.sandbox_workspace_write) &&
    document.sandbox_workspace_write.network_access !== undefined &&
    typeof document.sandbox_workspace_write.network_access !== 'boolean'
  )
    return networkTomlError('invalid');
  try {
    return { text, document, index: indexCodexSkillToml(text) };
  } catch (e) {
    return networkTomlError((e as Error).message.endsWith('-limit') ? 'limit' : 'invalid');
  }
}
export function mutateNetworkToml(text: string, changes: NetworkTomlMutation[]) {
  let last = text.length,
    result = text;
  for (const c of [...changes].sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (
      c.start < 0 ||
      c.end < c.start ||
      c.end > last ||
      !Number.isSafeInteger(c.start) ||
      !Number.isSafeInteger(c.end)
    )
      return networkTomlError('conflict');
    result = result.slice(0, c.start) + c.text + result.slice(c.end);
    last = c.start;
  }
  return result;
}
export function inlineInsertion(node: TomlValueSpan, text: string): NetworkTomlMutation {
  if (node.kind !== 'inline') return networkTomlError('invalid');
  const last = node.fields.at(-1)?.value.end,
    trailing = last !== undefined && node.commas.some((n) => n >= last);
  return {
    start: node.end - 1,
    end: node.end - 1,
    text: (last === undefined ? '' : trailing ? ' ' : ', ') + text + (trailing ? ', ' : ''),
  };
}
export const replaceValue = (field: TomlFieldSpan | null, text: string): NetworkTomlMutation => {
  if (!field) return networkTomlError('invalid');
  return { start: field.value.start, end: field.value.end, text };
};
export const eolFor = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');
export const separatorFor = (text: string, eol: string) =>
  text.length > 0 && !/[\r\n]$/.test(text) ? eol : '';
export function inlineNetworkFieldOwner(
  current: ReturnType<typeof readNetworkToml>,
  path: string[],
  field: TomlFieldSpan,
) {
  for (let n = path.length - 1; n > 0; n--) {
    const parent = findCodexSkillTomlValue(current.index, path.slice(0, n));
    if (parent?.value.kind === 'inline' && parent.value.fields.includes(field)) return parent.value;
  }
  return null;
}
/** Add a leaf without reopening a sealed inline table or redefining a dotted table. */
export function insertNetworkTomlLeaf(
  before: ReturnType<typeof readNetworkToml>,
  path: string[],
  value: string,
): NetworkTomlMutation {
  const eol = eolFor(before.text),
    key = (parts: string[]) => parts.map((p) => JSON.stringify(p)).join('.');
  for (let n = path.length - 1; n > 0; n--) {
    const parent = findCodexSkillTomlValue(before.index, path.slice(0, n));
    if (parent?.value.kind === 'inline')
      return inlineInsertion(parent.value, key(path.slice(n)) + ' = ' + value);
  }
  const header = [...before.index.headers]
    .filter((h) => !h.array && h.path.length < path.length && h.path.every((p, i) => path[i] === p))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (header) {
    const line = before.text.indexOf('\n', header.end),
      at = line < 0 ? before.text.length : line + 1;
    return {
      start: at,
      end: at,
      text: (line < 0 ? eol : '') + key(path.slice(header.path.length)) + ' = ' + value + eol,
    };
  }
  const at = before.index.headers[0]?.start ?? before.text.length;
  return {
    start: at,
    end: at,
    text:
      (at === before.text.length ? separatorFor(before.text, eol) : '') +
      key(path) +
      ' = ' +
      value +
      eol,
  };
}
export function ownerMarkerSpan(current: ReturnType<typeof readNetworkToml>, marker: string) {
  const matches = current.index.comments.filter(
    (c) => current.text.slice(c.start, c.end) === marker,
  );
  if (matches.length !== 1) return networkTomlError('conflict');
  const c = matches[0]!,
    start = current.text.lastIndexOf('\n', c.start - 1) + 1;
  if (start !== c.start) return networkTomlError('conflict');
  const end =
    c.end +
    (current.text.slice(c.end, c.end + 2) === '\r\n'
      ? 2
      : /[\r\n]/.test(current.text[c.end] ?? '')
        ? 1
        : 0);
  return { start, end, text: '' };
}
export function uniqueInsertionRemoval(
  text: string,
  changes: NetworkTomlMutation[],
): NetworkTomlMutation[] | null {
  const found: NetworkTomlMutation[] = [];
  for (const c of changes.filter((c) => c.start === c.end)) {
    const at = text.indexOf(c.text);
    if (at < 0 || text.indexOf(c.text, at + c.text.length) >= 0) return null;
    found.push({ start: at, end: at + c.text.length, text: '' });
  }
  return found;
}
