import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MCP_STRICT_NOTE } from '../../src/commands/init-mcp.js';
import { commandHelp } from '../../src/help.js';
import { MAX_LINE_CHARS } from '../../src/mcp/framing.js';
import {
  DEFAULT_STRICT_MAX_WITHHELD,
  STRICT_COPY_MAX_CHARS,
  STRICT_COPY_STRING_CHARS,
  STRICT_MAX_BENIGN_WITHHELD,
  STRICT_MAX_TEXT_CHARS,
  STRICT_SCAN_DEADLINE_MS,
} from '../../src/mcp/strict-limits.js';
import { FORWARDED_SERVER_METHODS } from '../../src/mcp/strict-messages.js';
import { WITHHOLD_REASONS, countClass } from '../../src/mcp/strict-reasons.js';

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

  it('states the two caps and the scan deadline the code uses', () => {
    expect(section).toContain(
      `more than ${DEFAULT_STRICT_MAX_WITHHELD} of the malformed or hostile kind`,
    );
    expect(section).toContain(
      `more than ${STRICT_MAX_BENIGN_WITHHELD} of the kinds a benign server`,
    );
    expect(section).toContain(`${STRICT_SCAN_DEADLINE_MS / 1000}-second deadline`);
    expect(commandHelp('mcp')).toContain(`default ${DEFAULT_STRICT_MAX_WITHHELD}`);
    expect(commandHelp('mcp')).toContain(`cap of ${STRICT_MAX_BENIGN_WITHHELD}`);
  });

  it('states the cuts of the serialised copy the code makes', () => {
    expect(section).toContain(
      `strings cut to ${STRICT_COPY_STRING_CHARS.toLocaleString('en-US')} characters`,
    );
    expect(section).toContain(`the whole copy to ${STRICT_COPY_MAX_CHARS / 1024} KiB`);
    expect(section).toContain(`${STRICT_MAX_TEXT_CHARS.toLocaleString('en-US')}-character window`);
  });

  describe('which cap each reason counts toward', () => {
    const line = (prefix: string): string =>
      section.split('\n').find((l) => l.startsWith(prefix)) ?? '';
    const hostile = line('- Counts toward `--strict-max-withheld`');
    const benign = line('- Counts toward the separate cap of');

    it('has a line for each', () => {
      expect(hostile).not.toBe('');
      expect(benign).not.toBe('');
      expect(benign).toContain(String(STRICT_MAX_BENIGN_WITHHELD));
    });

    it.each([...WITHHOLD_REASONS])('puts %s on the line the code puts it on', (reason) => {
      const named = `\`${reason}\``;
      if (countClass(reason) === 'benign') expect(benign).toContain(named);
      else expect(hostile).toContain(named);
    });

    it('puts the chatty kinds of unsolicited message on the benign line, by method', () => {
      expect(countClass('unsolicited', 'notifications/message')).toBe('benign');
      expect(benign).toContain('`notifications/message`');
      expect(benign).toContain('`notifications/progress`');
    });
  });
});

describe('the note `stroq init --agent mcp --strict` prints', () => {
  it('states the numbers the code uses, not numbers typed twice', () => {
    expect(MCP_STRICT_NOTE).toContain(
      `more than ${DEFAULT_STRICT_MAX_WITHHELD} malformed or hostile`,
    );
    expect(MCP_STRICT_NOTE).toContain(`${STRICT_MAX_BENIGN_WITHHELD} for log lines`);
    expect(MCP_STRICT_NOTE).toContain(`above ${MAX_LINE_CHARS / (1024 * 1024)} MiB`);
  });

  it('says what it costs and what it is not', () => {
    expect(MCP_STRICT_NOTE).toContain('not a sandbox');
    expect(MCP_STRICT_NOTE).toContain('--unwrap');
    expect(MCP_STRICT_NOTE).toContain('byte for byte');
    expect(MCP_STRICT_NOTE).toContain('keeps it on');
  });
});

describe('the sizes the client is told about when a message is withheld', () => {
  it('are the real ones', async () => {
    const { withheldMessage } = await import('../../src/mcp/strict-reasons.js');
    expect(withheldMessage('oversize')).toContain(`${MAX_LINE_CHARS / (1024 * 1024)} MiB`);
    expect(withheldMessage('oversize-text')).toContain(
      `${STRICT_MAX_TEXT_CHARS.toLocaleString('en-US')} characters`,
    );
  });
});
