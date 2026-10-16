import { loadBundledRules, scanContent, scanFieldsForTool, scanTargetForTool } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import { mcpResultText, resultTextFor } from '../../src/mcp/judge.js';
import { leafText } from '../../src/mcp/strict-leaves.js';
import {
  STRICT_COPY_MAX_CHARS,
  STRICT_COPY_SEPARATOR,
  STRICT_COPY_STRING_CHARS,
  STRICT_MAX_TEXT_CHARS,
} from '../../src/mcp/strict-limits.js';
import { readStrictResult } from '../../src/mcp/strict-result.js';

/**
 * Strict mode scans at least what the default proxy scans. The default scans the JSON
 * form of `structuredContent`, of an input schema, of annotations: text in which a key
 * and its value sit side by side (`"query": "x'; DROP TABLE users; --"`). About forty of
 * the bundled rules have a pattern in exactly that syntax, and they cannot match a list of
 * decoded strings, in which the key and the value are two separate lines. So the strict
 * scan text is the decoded strings (what the previous commits made it), then one separator
 * line, then a clipped serialised copy of the same structure.
 */

const rules = loadBundledRules();
const verdictOf = (body: string, tool = 'mcp__srv__call'): string =>
  scanContent(
    rules,
    body,
    { budgetMs: 120_000 },
    { target: scanTargetForTool(tool), ...scanFieldsForTool(tool, body) },
  ).verdict;

const textOf = (read: ReturnType<typeof readStrictResult>): string => {
  if (!read.ok) throw new Error(`expected a readable result, got ${read.reason}`);
  return read.text;
};

const INJECTED = { status: 'ok', query: "x'; DROP TABLE users; --" };

describe('a rule whose pattern is JSON syntax', () => {
  it('fires on a tools/call structuredContent in strict mode as it does in default mode', () => {
    const result = { content: [{ type: 'text', text: 'ok' }], structuredContent: INJECTED };
    expect(verdictOf(mcpResultText(result))).toBe('suspect');
    expect(verdictOf(textOf(readStrictResult('tools/call', result)))).toBe('suspect');
  });

  it('fires on a field of an initialize result, which the default proxy never scans', () => {
    const result = { protocolVersion: '2025-06-18', serverInfo: { name: 'x' }, ...INJECTED };
    expect(verdictOf(textOf(readStrictResult('initialize', result)), 'mcp__srv__initialize')).toBe(
      'suspect',
    );
  });

  it('is in the strict text of a tools/list inputSchema and annotations, as the default reads them', () => {
    const tool = {
      name: 't',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, ...INJECTED },
      annotations: { title: 'T', readOnlyHint: true },
    };
    const text = textOf(readStrictResult('tools/list', { tools: [tool] }));
    const defaultText = resultTextFor('tools/list', { tools: [tool] });
    // What the default proxy hands the scanner for the schema and the annotations, as JSON.
    expect(text).toContain(JSON.stringify(tool.inputSchema));
    expect(text).toContain(JSON.stringify(tool.annotations));
    expect(defaultText).toContain(JSON.stringify(tool.inputSchema));
  });

  it('is in the strict text of the other two scanned methods as the default reads them', () => {
    const structured = { status: 'ok', rows: [{ id: 1, name: 'alice' }] };
    const call = textOf(
      readStrictResult('tools/call', { content: [], structuredContent: structured }),
    );
    expect(call).toContain(JSON.stringify(structured));
    const inputRequests = { ask: { type: 'text', prompt: 'which one' } };
    const input = textOf(readStrictResult('tools/call', { content: [], inputRequests }));
    expect(input).toContain(JSON.stringify(inputRequests));
  });
});

describe('a clean structure', () => {
  it('stays clean in strict mode, as in default mode', () => {
    const result = {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { status: 'ok', rows: 3, name: 'alice', tags: ['a', 'b'] },
    };
    expect(verdictOf(mcpResultText(result))).toBe('clean');
    expect(verdictOf(textOf(readStrictResult('tools/call', result)))).toBe('clean');
  });
});

describe('the shape of the scan text', () => {
  const result = { content: [{ type: 'text', text: 'hello' }], structuredContent: { a: 'b' } };

  it('is the decoded strings, one separator, then the serialised structure', () => {
    const text = textOf(readStrictResult('tools/call', result));
    const leaves = leafText(result) as string;
    expect(text.startsWith(leaves)).toBe(true);
    expect(text.slice(leaves.length)).toBe(`${STRICT_COPY_SEPARATOR}${JSON.stringify(result)}`);
  });

  it('has a copy that reads back as the same structure, keys included', () => {
    const text = textOf(readStrictResult('tools/call', result));
    const copy = text.slice(text.indexOf(STRICT_COPY_SEPARATOR) + STRICT_COPY_SEPARATOR.length);
    expect(JSON.parse(copy)).toEqual(result);
    expect(copy).toContain('"structuredContent":{"a":"b"}');
  });

  it('cuts a long string in the copy and not in the part that is the decoded strings', () => {
    const long = 'x'.repeat(STRICT_COPY_STRING_CHARS + 500);
    const text = textOf(
      readStrictResult('tools/call', { content: [], structuredContent: { long } }),
    );
    expect(text).toContain(long);
    const copy = text.slice(text.lastIndexOf(STRICT_COPY_SEPARATOR));
    expect(copy).toContain('x'.repeat(STRICT_COPY_STRING_CHARS));
    expect(copy).not.toContain('x'.repeat(STRICT_COPY_STRING_CHARS + 1));
  });

  it('caps the copy', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i, label: `row number ${i}` }));
    const text = textOf(
      readStrictResult('tools/call', { content: [], structuredContent: { rows } }),
    );
    const leaves = leafText({ content: [], structuredContent: { rows } }) as string;
    expect(text.length - leaves.length).toBeLessThanOrEqual(
      STRICT_COPY_SEPARATOR.length + STRICT_COPY_MAX_CHARS,
    );
    expect(text.length).toBeGreaterThan(leaves.length);
  });

  it('keeps a key in the copy even when its value is not a string', () => {
    const text = textOf(
      readStrictResult('tools/call', { content: [], structuredContent: { zzkey: 7 } }),
    );
    expect(text.slice(text.indexOf(STRICT_COPY_SEPARATOR))).toContain('"zzkey":7');
  });

  it('leaves a recognised picture’s payload out of the copy too', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString(
      'base64',
    );
    const text = textOf(
      readStrictResult('tools/call', {
        content: [{ type: 'image', data: png, mimeType: 'image/png' }],
      }),
    );
    expect(text).not.toContain(png);
    expect(text).toContain('"mimeType":"image/png"');
  });

  it('has no copy for a result with nothing in it', () => {
    expect(textOf(readStrictResult('ping', {}))).toBe('');
  });

  it('is cut at the window, never past it', () => {
    const overhead = (leafText({ content: [{ type: 'text', text: '' }] }) as string).length;
    const fill = STRICT_MAX_TEXT_CHARS - overhead - 40; // leaves 40 characters of room
    const text = textOf(
      readStrictResult('tools/call', { content: [{ type: 'text', text: 'a'.repeat(fill) }] }),
    );
    expect(text.length).toBe(STRICT_MAX_TEXT_CHARS);
    expect(text.slice(-10)).not.toBe('a'.repeat(10));
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

  it('is read exactly at the window, with no room left for a copy', () => {
    const text = textOf(readStrictResult('tools/call', body(fill)));
    expect(text).toHaveLength(STRICT_MAX_TEXT_CHARS);
    expect(text).not.toContain(STRICT_COPY_SEPARATOR);
  });

  it('is not made oversize by the copy: a text that fits as decoded strings is read', () => {
    for (const margin of [1, 10, 100, 5_000]) {
      const read = readStrictResult('tools/call', body(fill - margin));
      expect(read.ok).toBe(true);
      expect(textOf(read).length).toBeLessThanOrEqual(STRICT_MAX_TEXT_CHARS);
    }
  });
});
