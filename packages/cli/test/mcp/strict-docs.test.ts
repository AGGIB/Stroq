import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commandHelp } from '../../src/help.js';
import {
  DEFAULT_STRICT_MAX_WITHHELD,
  STRICT_SCAN_DEADLINE_MS,
} from '../../src/mcp/strict-limits.js';
import { FORWARDED_SERVER_METHODS } from '../../src/mcp/strict-messages.js';
import { WITHHOLD_REASONS } from '../../src/mcp/strict-reasons.js';

/**
 * The strict-mode section of docs/AGENTS.md, held to the code. It names the exact set of
 * server-originated methods still forwarded, every reason a message can be withheld and
 * the two numbers that bound the mode; a method added to the forwarded list, a reason
 * added to the type or a default changed fails here until the section says so.
 */

const agents = readFileSync(
  fileURLToPath(new URL('../../../../docs/AGENTS.md', import.meta.url)),
  'utf8',
);
const start = agents.indexOf('#### `--strict`');
const section = agents.slice(start, agents.indexOf('**Limits.**', start));

describe('the --strict section of docs/AGENTS.md', () => {
  it('is there to be read', () => {
    expect(start).toBeGreaterThan(0);
    expect(section.length).toBeGreaterThan(2000);
  });

  it.each([...FORWARDED_SERVER_METHODS])('names the method it still forwards: %s', (method) => {
    expect(section).toContain(`\`${method}\``);
  });

  it('says how many methods that is', () => {
    expect(section).toContain('Exactly five methods');
    expect(FORWARDED_SERVER_METHODS).toHaveLength(5);
  });

  it.each([...WITHHOLD_REASONS])('names the withhold reason: %s', (reason) => {
    expect(section).toContain(`\`${reason}\``);
  });

  it('states the default limit and the scan deadline the code uses', () => {
    expect(section).toContain(`more than ${DEFAULT_STRICT_MAX_WITHHELD} of them`);
    expect(section).toContain(`${STRICT_SCAN_DEADLINE_MS / 1000}-second deadline`);
    expect(commandHelp('mcp')).toContain(`default ${DEFAULT_STRICT_MAX_WITHHELD}`);
  });
});
