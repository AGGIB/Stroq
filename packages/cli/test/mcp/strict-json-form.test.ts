import { loadBundledRules, scanContent, scanFieldsForTool, scanTargetForTool } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import { mcpResultText, resultTextFor } from '../../src/mcp/judge.js';
import { leafText } from '../../src/mcp/strict-leaves.js';
import {
  STRICT_COPY_MAX_CHARS,
  STRICT_COPY_STRING_CHARS,
  STRICT_MAX_TEXT_CHARS,
} from '../../src/mcp/strict-limits.js';
import { readStrictResult } from '../../src/mcp/strict-result.js';

/**
 * Strict mode scans at least what the default proxy scans. The default scans the JSON
 * form of `structuredContent`, of an input schema, of annotations: text in which a key
 * and its value sit side by side (`"query": "x'; DROP TABLE users; --"`). About forty of
 * the bundled rules have a pattern in exactly that syntax, and they cannot match a list of
 * decoded strings, in which the key and the value are two separate lines. So one of the
 * views of a result (see `strict-views.ts`) is the result as JSON.
 */

const rules = loadBundledRules();
const verdictOf = (body: string, tool = 'mcp__srv__call'): string =>
  scanContent(
    rules,
    body,
    { budgetMs: 120_000 },
    { target: scanTargetForTool(tool), ...scanFieldsForTool(tool, body) },
  ).verdict;

type Read = ReturnType<typeof readStrictResult>;
const viewsOf = (read: Read) => {
  if (!read.ok) throw new Error(`expected a readable result, got ${read.reason}`);
  return read.views;
};
const viewText = (read: Read, name: 'default' | 'strings' | 'json'): string =>
  viewsOf(read).find((view) => view.name === name)?.text ?? '';
/** The verdict over the views: suspect when any of them is. */
const strictVerdict = (read: Read, tool = 'mcp__srv__call'): string =>
  viewsOf(read).some((view) => verdictOf(view.text, tool) === 'suspect') ? 'suspect' : 'clean';

const INJECTED = { status: 'ok', query: "x'; DROP TABLE users; --" };

describe('a rule whose pattern is JSON syntax', () => {
  it('fires on a tools/call structuredContent in strict mode as it does in default mode', () => {
    const result = { content: [{ type: 'text', text: 'ok' }], structuredContent: INJECTED };
    expect(verdictOf(mcpResultText(result))).toBe('suspect');
    expect(strictVerdict(readStrictResult('tools/call', result))).toBe('suspect');
  });

  it('fires on a field of an initialize result, which the default proxy never scans', () => {
    const result = { protocolVersion: '2025-06-18', serverInfo: { name: 'x' }, ...INJECTED };
    expect(strictVerdict(readStrictResult('initialize', result), 'mcp__srv__initialize')).toBe(
      'suspect',
    );
  });

  it('is in the strict views of a tools/list inputSchema and annotations, as the default reads them', () => {
    const tool = {
      name: 't',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, ...INJECTED },
      annotations: { title: 'T', readOnlyHint: true },
    };
    const read = readStrictResult('tools/list', { tools: [tool] });
    // What the default proxy hands the scanner for the schema and the annotations, as JSON.
    expect(viewText(read, 'default')).toContain(JSON.stringify(tool.inputSchema));
    expect(viewText(read, 'json')).toContain(JSON.stringify(tool.inputSchema));
    expect(viewText(read, 'json')).toContain(JSON.stringify(tool.annotations));
    expect(resultTextFor('tools/list', { tools: [tool] })).toContain(
      JSON.stringify(tool.inputSchema),
    );
  });

  it('is in the strict views of the other two scanned fields as the default reads them', () => {
    const structured = { status: 'ok', rows: [{ id: 1, name: 'alice' }] };
    const call = readStrictResult('tools/call', { content: [], structuredContent: structured });
    expect(viewText(call, 'default')).toContain(JSON.stringify(structured));
    expect(viewText(call, 'json')).toContain(JSON.stringify(structured));
    const inputRequests = { ask: { type: 'text', prompt: 'which one' } };
    const input = readStrictResult('tools/call', { content: [], inputRequests });
    expect(viewText(input, 'default')).toContain(JSON.stringify(inputRequests));
    expect(viewText(input, 'json')).toContain(JSON.stringify(inputRequests));
  });
});

describe('a clean structure', () => {
  it('stays clean in strict mode, as in default mode', () => {
    const result = {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { status: 'ok', rows: 3, name: 'alice', tags: ['a', 'b'] },
    };
    expect(verdictOf(mcpResultText(result))).toBe('clean');
    expect(strictVerdict(readStrictResult('tools/call', result))).toBe('clean');
  });
});

describe('the JSON view', () => {
  const result = { content: [{ type: 'text', text: 'hello' }], structuredContent: { a: 'b' } };

  it('is the serialised structure and nothing else', () => {
    expect(viewText(readStrictResult('tools/call', result), 'json')).toBe(JSON.stringify(result));
  });

  it('reads back as the same structure, keys included', () => {
    const json = viewText(readStrictResult('tools/call', result), 'json');
    expect(JSON.parse(json)).toEqual(result);
    expect(json).toContain('"structuredContent":{"a":"b"}');
  });

  it('cuts a long string, and does not cut the decoded strings', () => {
    const long = 'x'.repeat(STRICT_COPY_STRING_CHARS + 500);
    const read = readStrictResult('tools/call', { content: [], structuredContent: { long } });
    expect(viewText(read, 'strings')).toContain(long);
    const json = viewText(read, 'json');
    expect(json).toContain('x'.repeat(STRICT_COPY_STRING_CHARS));
    expect(json).not.toContain('x'.repeat(STRICT_COPY_STRING_CHARS + 1));
  });

  it('is capped', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i, label: `row number ${i}` }));
    const read = readStrictResult('tools/call', { content: [], structuredContent: { rows } });
    expect(viewText(read, 'json').length).toBe(STRICT_COPY_MAX_CHARS);
  });

  it('keeps a key even when its value is not a string', () => {
    const read = readStrictResult('tools/call', { content: [], structuredContent: { zzkey: 7 } });
    expect(viewText(read, 'json')).toContain('"zzkey":7');
  });

  it('leaves a recognised picture’s payload out too', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString(
      'base64',
    );
    const read = readStrictResult('tools/call', {
      content: [{ type: 'image', data: png, mimeType: 'image/png' }],
    });
    for (const view of viewsOf(read)) expect(view.text).not.toContain(png);
    expect(viewText(read, 'json')).toContain('"mimeType":"image/png"');
  });

  it('is absent for a result with nothing in it', () => {
    const read = readStrictResult('ping', {});
    expect(viewsOf(read)).toEqual([]);
  });
});

describe('a long text is cut short exactly as before', () => {
  const body = (n: number) => ({ content: [{ type: 'text', text: 'a'.repeat(n) }] });
  const leafOverhead = (leafText(body(0)) as string).length;
  const fill = STRICT_MAX_TEXT_CHARS - leafOverhead;

  it('is withheld one character past the window of decoded strings, as it was', () => {
    expect(readStrictResult('tools/call', body(fill + 1))).toEqual({
      ok: false,
      reason: 'oversize-text',
    });
  });

  it('is read exactly at the window', () => {
    const read = readStrictResult('tools/call', body(fill));
    expect(read.ok && read.text).toHaveLength(STRICT_MAX_TEXT_CHARS);
  });

  it('is not made oversize by the other views: a text that fits as decoded strings is read', () => {
    for (const margin of [1, 10, 100, 5_000]) {
      const read = readStrictResult('tools/call', body(fill - margin));
      expect(read.ok).toBe(true);
      expect(read.ok && read.text.length).toBeLessThanOrEqual(STRICT_MAX_TEXT_CHARS);
    }
  });
});
