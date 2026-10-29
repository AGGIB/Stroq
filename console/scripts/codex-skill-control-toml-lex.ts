import { parse } from 'smol-toml';

export interface TomlValueSpan {
  kind: 'scalar' | 'array' | 'inline';
  start: number;
  end: number;
  children: TomlValueSpan[];
  fields: TomlFieldSpan[];
  commas: number[];
}
export interface TomlFieldSpan {
  path: string[];
  start: number;
  value: TomlValueSpan;
}
export interface TomlHeaderSpan {
  path: string[];
  array: boolean;
  start: number;
  end: number;
}
export interface TomlCommentSpan {
  start: number;
  end: number;
}
export interface TomlSpanIndex {
  assignments: TomlFieldSpan[];
  headers: TomlHeaderSpan[];
  comments: TomlCommentSpan[];
}
const fail = (): never => {
  throw Error('codex-skill-control-invalid');
};
const samePath = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Strict TOML parsing is the grammar oracle. This reader only indexes original spans. */
export function indexCodexSkillToml(text: string): TomlSpanIndex {
  let at = text.startsWith('\uFEFF') ? 1 : 0,
    nodes = 0;
  const comments: TomlCommentSpan[] = [],
    assignments: TomlFieldSpan[] = [],
    headers: TomlHeaderSpan[] = [];
  const space = () => {
    while (at < text.length) {
      if (/[ \t\r\n]/.test(text[at]!)) {
        at++;
        continue;
      }
      if (text[at] !== '#') break;
      const start = at;
      while (at < text.length && text[at] !== '\n' && text[at] !== '\r') at++;
      comments.push({ start, end: at });
    }
  };
  const stringEnd = (start: number): number => {
    const quote = text[start]!,
      triple = text.slice(start, start + 3) === quote.repeat(3);
    let pos = start + (triple ? 3 : 1);
    while (pos < text.length) {
      if (quote === '"' && text[pos] === '\\') {
        pos += 2;
        continue;
      }
      if (text[pos] !== quote) {
        pos++;
        continue;
      }
      if (!triple) return pos + 1;
      let end = pos;
      while (text[end] === quote) end++;
      if (end - pos >= 3) return end;
      pos = end;
    }
    return fail();
  };
  const key = (): string[] => {
    const keys: string[] = [];
    while (at < text.length) {
      while (/[ \t]/.test(text[at] ?? '')) at++;
      const start = at;
      if (text[at] === '"' || text[at] === "'") at = stringEnd(at);
      else while (/[A-Za-z0-9_-]/.test(text[at] ?? '')) at++;
      if (start === at) return fail();
      try {
        const decoded = parse(text.slice(start, at) + '=0', { unsafeKeyBehaviour: 'throw' });
        const names = Object.keys(decoded);
        if (names.length !== 1) return fail();
        keys.push(names[0]!);
      } catch {
        return fail();
      }
      while (/[ \t]/.test(text[at] ?? '')) at++;
      if (text[at] !== '.') return keys;
      at++;
    }
    return fail();
  };
  const value = (depth = 0): TomlValueSpan => {
    if (depth > 32 || ++nodes > 16384) throw Error('codex-skill-control-limit');
    space();
    const start = at,
      first = text[at],
      node: TomlValueSpan = {
        kind: 'scalar',
        start,
        end: at,
        children: [],
        fields: [],
        commas: [],
      };
    if (first === '"' || first === "'") at = stringEnd(at);
    else if (first === '[' || first === '{') {
      const close = first === '[' ? ']' : '}';
      node.kind = first === '[' ? 'array' : 'inline';
      at++;
      space();
      while (text[at] !== close) {
        if (at >= text.length) return fail();
        if (first === '{') {
          const fieldStart = at,
            path = key();
          if (text[at++] !== '=') return fail();
          const child = value(depth + 1);
          node.fields.push({ path, start: fieldStart, value: child });
        } else node.children.push(value(depth + 1));
        space();
        if (text[at] === ',') {
          node.commas.push(at++);
          space();
        } else if (text[at] !== close) return fail();
      }
      at++;
    } else {
      while (at < text.length && !/[\n\r,#\]}]/.test(text[at]!)) at++;
      while (at > start && /[ \t]/.test(text[at - 1]!)) at--;
      if (at === start) return fail();
    }
    node.end = at;
    return node;
  };
  let context: string[] = [];
  while (at < text.length) {
    space();
    if (at >= text.length) break;
    const start = at;
    if (text[at] === '[') {
      const array = text[at + 1] === '[';
      at += array ? 2 : 1;
      context = key();
      if (text[at++] !== ']' || (array && text[at++] !== ']')) return fail();
      headers.push({ path: context, array, start, end: at });
    } else {
      const path = key();
      if (text[at++] !== '=') return fail();
      assignments.push({ path: [...context, ...path], start, value: value() });
    }
    while (/[ \t]/.test(text[at] ?? '')) at++;
    if (at < text.length && !/[\r\n#]/.test(text[at]!)) return fail();
  }
  return { assignments, headers, comments };
}

export function findCodexSkillTomlValue(
  index: TomlSpanIndex,
  path: readonly string[],
): TomlFieldSpan | null {
  const nested = (field: TomlFieldSpan, prefix: string[]): TomlFieldSpan | null => {
    const full = [...prefix, ...field.path];
    if (samePath(full, path)) return field;
    if (field.value.kind !== 'inline' || !full.every((key, i) => path[i] === key)) return null;
    for (const child of field.value.fields) {
      const found = nested(child, full);
      if (found) return found;
    }
    return null;
  };
  for (const entry of index.assignments) {
    const found = nested(entry, []);
    if (found) return found;
  }
  return null;
}

/** Remove one value and its separator while retaining every intervening comment/trivia byte. */
export function codexSkillTomlArrayRemoval(
  array: TomlValueSpan,
  index: number,
): { start: number; end: number }[] {
  const child = array.children[index];
  if (array.kind !== 'array' || !child) return fail();
  const next = array.commas.find((at) => at >= child.end),
    prior = array.commas.filter((at) => at < child.start).at(-1);
  const comma = next ?? prior;
  return [
    { start: child.start, end: child.end },
    ...(comma === undefined ? [] : [{ start: comma, end: comma + 1 }]),
  ];
}
export function codexSkillTomlFieldRemoval(
  parent: TomlValueSpan,
  field: TomlFieldSpan,
): { start: number; end: number }[] {
  const next = parent.commas.find((at) => at >= field.value.end),
    prior = parent.commas.filter((at) => at < field.start).at(-1);
  const comma = next ?? prior;
  return [
    { start: field.start, end: field.value.end },
    ...(comma === undefined ? [] : [{ start: comma, end: comma + 1 }]),
  ];
}
