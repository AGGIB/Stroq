import { describe, expect, it } from 'vitest';
import { rawMember } from '../../src/install/opaque-json.js';

describe('opaque JSON member preservation', () => {
  it.each([
    ['{"mcp":{"n":12345678901234567890},"skills":{}}', '{"n":12345678901234567890}'],
    [
      '{ "skills": {"mcp":1}, "mcp" : {"s":"a\\\"},b","a":[1,{"z":2}]} }',
      '{"s":"a\\\"},b","a":[1,{"z":2}]}',
    ],
    ['{"mcp":{},"mcp":{"last":true}}', '{"last":true}'],
    ['{"m\\u0063p":{"__proto__":null}}', '{"__proto__":null}'],
    ['{"skills":{}}', undefined],
  ])('keeps the last top-level member in %s', (json, expected) => {
    JSON.parse(json);
    expect(rawMember(json, 'mcp')).toBe(expected);
  });
});
