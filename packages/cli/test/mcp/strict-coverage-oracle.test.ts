import { describe, expect, it } from 'vitest';
import { isCovered } from '../../src/mcp/strict-leaves.js';
import { readStrictError, readStrictResult } from '../../src/mcp/strict-result.js';

/**
 * The coverage oracle: strict mode's invariant, tested by mutation.
 *
 * Take valid results of every shape strict mode reads, and change each in every way an
 * adversary can put a string into a result: replace any string value with a marker, add
 * a key to any object holding a marker as a string, in an object or in an array, add a key
 * whose NAME is the marker, and add an outer `text` beside any nested object so the strings
 * inside are the kind a shortcut would skip. For every mutant that strict mode reads at
 * all, the marker must be in the text it would scan. A mutant that is refused is fine: the
 * client is never given it. A mutant that is read and whose marker is not scanned is a gap
 * the client can be handed a string through, and there must be none.
 *
 * It started as a reviewer's probe that found four gaps in the first version.
 */

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const TEMPLATES: Readonly<Record<string, readonly unknown[]>> = {
  'tools/call': [
    { content: [{ type: 'text', text: 'hello' }], isError: false },
    { content: [{ type: 'image', mimeType: 'image/png', data: PNG }] },
    { content: [{ type: 'resource_link', uri: 'file:///a', name: 'n', description: 'd' }] },
    {
      content: [
        { type: 'resource', resource: { uri: 'file:///a', mimeType: 'text/plain', text: 'body' } },
      ],
    },
    {
      content: [
        { type: 'resource', resource: { uri: 'file:///a', mimeType: 'image/png', blob: PNG } },
      ],
    },
    {
      content: [{ type: 'text', text: 'x' }],
      structuredContent: { a: { b: 'c' } },
      _meta: { m: 'n' },
      resultType: 'complete',
    },
  ],
  'tools/list': [
    {
      tools: [
        {
          name: 'a',
          title: 't',
          description: 'd',
          inputSchema: { type: 'object', properties: { p: { description: 'q' } } },
          outputSchema: { type: 'object' },
          annotations: { title: 'x' },
          _meta: { z: 1 },
          icons: [{ src: 'a', mimeType: 'image/png' }],
        },
      ],
      nextCursor: 'abc',
    },
  ],
  'resources/read': [
    {
      contents: [
        {
          uri: 'file:///a',
          mimeType: 'text/plain',
          text: 'body',
          _meta: { k: 'v' },
          annotations: { audience: ['user'] },
        },
      ],
    },
    { contents: [{ uri: 'file:///a', mimeType: 'image/png', blob: PNG }] },
  ],
  'prompts/get': [
    { description: 'desc', messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }] },
    {
      description: 'desc',
      messages: [
        { role: 'user', content: { type: 'resource', resource: { uri: 'u', text: 'body' } } },
      ],
    },
    {
      description: 'desc',
      messages: [{ role: 'user', content: { type: 'image', mimeType: 'image/png', data: PNG } }],
    },
  ],
  'resources/list': [{ resources: [{ uri: 'a', name: 'b' }] }],
  initialize: [
    {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'n', version: '1' },
      instructions: 'i',
    },
  ],
};

type Path = (string | number)[];
type Node = Record<string | number, unknown>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const at = (root: unknown, path: Path): unknown =>
  path.reduce<unknown>((node, key) => (node as Node)[key], root);

function paths(root: unknown): Path[] {
  const found: Path[] = [];
  const visit = (node: unknown, path: Path): void => {
    found.push(path);
    if (Array.isArray(node)) node.forEach((child, i) => visit(child, [...path, i]));
    else if (node !== null && typeof node === 'object')
      for (const key of Object.keys(node)) visit((node as Node)[key], [...path, key]);
  };
  visit(root, []);
  return found;
}

const isObject = (node: unknown): node is Node =>
  node !== null && typeof node === 'object' && !Array.isArray(node);

interface Mutant {
  readonly method: string;
  readonly result: unknown;
  readonly marker: string;
  readonly what: string;
}

function* mutants(): Generator<Mutant> {
  let serial = 0;
  const marker = (): string => `MK${serial++}`;
  for (const [method, templates] of Object.entries(TEMPLATES)) {
    for (const base of templates) {
      for (const path of paths(base)) {
        const node = at(base, path);
        if (typeof node === 'string' && path.length > 0) {
          const m = marker();
          const result = clone(base);
          (at(result, path.slice(0, -1)) as Node)[path[path.length - 1] as string | number] = m;
          yield { method, result, marker: m, what: `replace the string at ${path.join('.')}` };
        }
        if (!isObject(node)) continue;
        const variants: [string, (m: string) => unknown][] = [
          ['a string', (m) => m],
          ['an object holding it', (m) => ({ deep: m })],
          ['an array holding it', (m) => [m]],
        ];
        for (const [label, make] of variants) {
          const m = marker();
          const result = clone(base);
          (path.length === 0 ? (result as Node) : (at(result, path) as Node))['zzinj'] = make(m);
          yield {
            method,
            result,
            marker: m,
            what: `add ${label} under a new key at ${path.join('.') || '<root>'}`,
          };
        }
        {
          const m = marker();
          const result = clone(base);
          (path.length === 0 ? (result as Node) : (at(result, path) as Node))[m] = 1;
          yield {
            method,
            result,
            marker: m,
            what: `add a key named by the marker at ${path.join('.') || '<root>'}`,
          };
        }
        if (typeof node['text'] !== 'string') {
          // An outer text beside a nested object: every string below it must still be read.
          const outer = clone(base);
          const target = (path.length === 0 ? outer : at(outer, path)) as Node;
          target['text'] = 'x';
          const inner: Path[] = [];
          const collect = (n: unknown, p: Path): void => {
            if (typeof n === 'string' && p.length > 0) inner.push(p);
            else if (Array.isArray(n)) n.forEach((c, i) => collect(c, [...p, i]));
            else if (isObject(n)) for (const k of Object.keys(n)) collect(n[k], [...p, k]);
          };
          collect(target, []);
          for (const sub of inner) {
            if (sub.length === 1 && sub[0] === 'text') continue;
            const m = marker();
            const result = clone(outer);
            const t = (path.length === 0 ? result : at(result, path)) as Node;
            (at(t, sub.slice(0, -1)) as Node)[sub[sub.length - 1] as string | number] = m;
            yield {
              method,
              result,
              marker: m,
              what: `with an outer text at ${path.join('.') || '<root>'}, replace ${sub.join('.')}`,
            };
          }
        }
      }
    }
  }
}

describe('the coverage oracle', () => {
  it('finds every injected string in the scan text of every mutant strict mode reads', () => {
    const gaps: string[] = [];
    let read = 0;
    let refused = 0;
    let total = 0;
    for (const mutant of mutants()) {
      total += 1;
      const outcome = readStrictResult(mutant.method, mutant.result);
      if (!outcome.ok) {
        refused += 1;
        continue;
      }
      read += 1;
      if (!outcome.text.includes(mutant.marker))
        gaps.push(
          `${mutant.method}: ${mutant.what}: ${JSON.stringify(mutant.result).slice(0, 200)}`,
        );
      // The delivered structure and the scan text agree exactly, not just on the marker.
      if (!isCovered(mutant.result, outcome.media, outcome.text))
        gaps.push(`${mutant.method}: ${mutant.what}: not covered`);
    }
    expect(total).toBeGreaterThan(300);
    expect(read).toBeGreaterThan(150);
    expect(refused).toBeGreaterThan(0);
    expect(gaps).toEqual([]);
  });

  it('finds the strings of a JSON-RPC error too', () => {
    for (const data of [{ a: 'MKERR' }, ['MKERR'], 'MKERR', { 'MKERR-key': 1 }]) {
      const outcome = readStrictError({ code: -1, message: 'm', data });
      expect(outcome.ok && outcome.text.includes('MKERR')).toBe(true);
    }
  });
});
