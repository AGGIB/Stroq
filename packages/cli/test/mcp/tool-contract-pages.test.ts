import { describe, expect, it } from 'vitest';
import { canonicalizeToolsList } from '../../src/mcp/tool-contract-canonical.js';
import { createToolContractPages } from '../../src/mcp/tool-contract-pages.js';
import { readStrictResult } from '../../src/mcp/strict-result.js';

const tool = (name = 'read', fields: Record<string, unknown> = {}) => ({
  name,
  inputSchema: { type: 'object' },
  ...fields,
});

describe('bounded tool contract pages', () => {
  it('releases only a complete aggregate with the full supported contracts', () => {
    const first = tool('z:read', {
      title: 'Read notes',
      description: 'A complete description',
      outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
      annotations: { readOnlyHint: true },
      _meta: { revision: '2' },
      icons: [{ src: 'https://never-fetch.invalid/icon.png' }],
      execution: { taskSupport: 'optional' },
    });
    const second = tool('a_read');
    const pages = createToolContractPages();
    expect(pages.add({ tools: [first], nextCursor: 'opaque:/page?two=2' })).toEqual({
      kind: 'next',
      cursor: 'opaque:/page?two=2',
    });
    const final = pages.add({ tools: [second] });
    expect(final).toEqual({ kind: 'complete', result: { tools: [first, second] } });
    if (final.kind !== 'complete') throw new Error('expected complete');
    expect(canonicalizeToolsList(final.result)).toEqual(
      canonicalizeToolsList({ tools: [first, second] }),
    );
    expect(() => pages.add({ tools: [] })).toThrow('tool-contract-invalid');
  });

  it('accepts an empty final list and empty intermediate pages', () => {
    expect(createToolContractPages().add({ tools: [] })).toEqual({
      kind: 'complete',
      result: { tools: [] },
    });
    const pages = createToolContractPages();
    expect(pages.add({ tools: [], nextCursor: 'first' })).toEqual({
      kind: 'next',
      cursor: 'first',
    });
    expect(pages.add({ tools: [], nextCursor: 'second' })).toEqual({
      kind: 'next',
      cursor: 'second',
    });
    expect(pages.add({ tools: [] })).toEqual({ kind: 'complete', result: { tools: [] } });
  });

  it('retains copies so later caller mutation cannot alter an earlier page', () => {
    const first = { ...tool('read'), description: 'original' };
    const input = { tools: [first], nextCursor: 'second' };
    const pages = createToolContractPages();
    pages.add(input);
    first.name = 'changed';
    first.description = 'changed';
    first.inputSchema.type = 'array';
    input.tools.length = 0;
    expect(pages.add({ tools: [] })).toEqual({
      kind: 'complete',
      result: { tools: [tool('read', { description: 'original' })] },
    });
  });

  it.each([
    null,
    [],
    'tools',
    {},
    { tools: null },
    { tools: [] as unknown[], nextCursor: null },
    { tools: [] as unknown[], nextCursor: undefined },
    { tools: [] as unknown[], nextCursor: '' },
    { tools: [] as unknown[], nextCursor: 2 },
  ])('refuses malformed page or explicit invalid continuation %#', (page) => {
    const pages = createToolContractPages();
    expect(() => pages.add(page)).toThrow('tool-contract-invalid');
    expect(() => pages.add({ tools: [] })).toThrow(/^tool-contract-invalid$/);
  });

  it.each(['_meta', 'resultType', 'futureField'])('refuses unsupported page key %s', (key) => {
    const pages = createToolContractPages();
    expect(() => pages.add({ tools: [], [key]: 'hidden' })).toThrow('tool-contract-unsupported');
    expect(() => pages.add({ tools: [] })).toThrow(/^tool-contract-invalid$/);
  });

  it('refuses symbols, inherited records, accessors and nonenumerable members without reading them', () => {
    let invoked = 0;
    const accessor = (key: string) =>
      Object.defineProperty({ tools: [] }, key, {
        enumerable: true,
        get() {
          invoked++;
          return key === 'tools' ? [] : 'next';
        },
      });
    for (const page of [
      { tools: [], [Symbol('hidden')]: 'unread' },
      Object.create({ tools: [] }),
      accessor('tools'),
      accessor('nextCursor'),
      Object.defineProperty({ tools: [] }, 'nextCursor', { value: 'hidden' }),
    ])
      expect(() => createToolContractPages().add(page)).toThrow(/tool-contract-/);
    expect(invoked).toBe(0);
    expect(
      createToolContractPages().add(Object.assign(Object.create(null), { tools: [] })),
    ).toEqual({ kind: 'complete', result: { tools: [] } });
  });

  it.each([
    '\u0000',
    'page\nnext',
    'page\tsecond',
    '\u007f',
    '\u0085',
    '\ud800',
    '\udc00',
    '\ufffd',
  ])('refuses malformed cursor text %#', (nextCursor) => {
    expect(() => createToolContractPages().add({ tools: [], nextCursor })).toThrow(
      'tool-contract-invalid',
    );
  });

  it('bounds cursor UTF-8 bytes and preserves valid Unicode and URL-shaped cursors', () => {
    const nextCursor = '\u00e9'.repeat(2048);
    expect(createToolContractPages().add({ tools: [], nextCursor })).toEqual({
      kind: 'next',
      cursor: nextCursor,
    });
    expect(() =>
      createToolContractPages().add({ tools: [], nextCursor: nextCursor + 'a' }),
    ).toThrow('tool-contract-limit');
    expect(
      createToolContractPages().add({
        tools: [],
        nextCursor: 'https://never-fetch.invalid/page?cursor=one#two',
      }),
    ).toEqual({
      kind: 'next',
      cursor: 'https://never-fetch.invalid/page?cursor=one#two',
    });
  });

  it('rejects both immediate and longer cursor cycles and cannot recover afterward', () => {
    for (const cursors of [
      ['same', 'same'],
      ['first', 'second', 'first'],
    ]) {
      const pages = createToolContractPages();
      for (const nextCursor of cursors.slice(0, -1)) pages.add({ tools: [], nextCursor });
      expect(() => pages.add({ tools: [], nextCursor: cursors.at(-1) })).toThrow(
        'tool-contract-invalid',
      );
      expect(() => pages.add({ tools: [tool()] })).toThrow(/^tool-contract-invalid$/);
    }
  });

  it('validates every full page and rejects exact raw name duplicates across pages', () => {
    const pages = createToolContractPages();
    pages.add({ tools: [tool('a:b')], nextCursor: 'next' });
    expect(pages.add({ tools: [tool('a_b')] })).toEqual({
      kind: 'complete',
      result: { tools: [tool('a:b'), tool('a_b')] },
    });
    const duplicate = createToolContractPages();
    duplicate.add({ tools: [tool()], nextCursor: 'next' });
    expect(() => duplicate.add({ tools: [tool()] })).toThrow('tool-contract-invalid');
    for (const bad of [
      tool('read', { futureField: true }),
      tool('read', { inputSchema: { type: 'string' } }),
      tool('read', { description: 5 }),
      tool('read', { description: 'x'.repeat(66_000) }),
      tool('read', { inputSchema: { properties: { '2': {}, '10': {} } } }),
    ])
      expect(() => createToolContractPages().add({ tools: [bad], nextCursor: 'next' })).toThrow(
        /tool-contract-/,
      );
  });

  it('bounds the complete tool count across individually valid pages', () => {
    const first = Array.from({ length: 128 }, (_, i) => tool('first' + i));
    const second = Array.from({ length: 128 }, (_, i) => tool('second' + i));
    const pages = createToolContractPages();
    pages.add({ tools: first, nextCursor: 'next' });
    expect(pages.add({ tools: second })).toEqual({
      kind: 'complete',
      result: { tools: [...first, ...second] },
    });
    const extra = createToolContractPages();
    extra.add({ tools: first, nextCursor: 'next' });
    expect(() => extra.add({ tools: [...second, tool('extra')] })).toThrow('tool-contract-limit');
    expect(() => extra.add({ tools: [] })).toThrow(/^tool-contract-invalid$/);
  });

  it('allows at most sixteen pages and requires the sixteenth to finish', () => {
    for (const final of [true, false]) {
      const pages = createToolContractPages();
      for (let i = 0; i < 15; i++) pages.add({ tools: [], nextCursor: 'page' + i });
      if (final)
        expect(pages.add({ tools: [] })).toEqual({ kind: 'complete', result: { tools: [] } });
      else {
        expect(() => pages.add({ tools: [], nextCursor: 'page16' })).toThrow('tool-contract-limit');
        expect(() => pages.add({ tools: [] })).toThrow(/^tool-contract-invalid$/);
      }
    }
  });

  it('bounds combined serialized JSON to the strict scan window before releasing tools', () => {
    const make = (n: number, length: number) =>
      tool('tool' + n, { description: 'x'.repeat(length) });
    const first = [make(0, 49_900), make(1, 49_900)];
    const second = [make(2, 49_900), make(3, 49_900)];
    const aggregate = { tools: [...first, ...second] };
    const remaining = 200_000 - JSON.stringify(aggregate).length;
    second[1] = make(3, 49_900 + remaining);
    expect(JSON.stringify({ tools: [...first, ...second] })).toHaveLength(200_000);
    const pages = createToolContractPages();
    pages.add({ tools: first, nextCursor: 'next' });
    const final = pages.add({ tools: second });
    expect(final.kind).toBe('complete');
    if (final.kind !== 'complete') throw new Error('expected complete');
    expect(readStrictResult('tools/list', final.result).ok).toBe(true);
    const tooLong = createToolContractPages();
    tooLong.add({ tools: first, nextCursor: 'next' });
    second[1] = make(3, 49_901 + remaining);
    expect(() => tooLong.add({ tools: second })).toThrow('tool-contract-limit');
  });

  it('refuses cumulative structural limits even when each individual page is valid', () => {
    const structure = { values: Array.from({ length: 1000 }, () => true) };
    const pages = createToolContractPages();
    const first = Array.from({ length: 10 }, (_, i) =>
      tool('first' + i, { annotations: structure }),
    );
    const second = Array.from({ length: 10 }, (_, i) =>
      tool('second' + i, { annotations: structure }),
    );
    expect(() => canonicalizeToolsList({ tools: first })).not.toThrow();
    expect(() => canonicalizeToolsList({ tools: second })).not.toThrow();
    pages.add({ tools: first, nextCursor: 'next' });
    expect(() => pages.add({ tools: second })).toThrow('tool-contract-limit');
    expect(() => pages.add({ tools: [] })).toThrow(/^tool-contract-invalid$/);
  });

  it('normalizes unexpected reader failures without leaking server detail', () => {
    const pages = createToolContractPages();
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('private-server-detail');
        },
      },
    );
    expect(() => pages.add(hostile)).toThrow(/^tool-contract-invalid$/);
    expect(() => pages.add({ tools: [] })).toThrow(/^tool-contract-invalid$/);
  });
});
