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

/**
 * Under a hooks key, every object is a handler unless it is a container: the event map, a list, a
 * group whose own `hooks` key holds the handlers, or a map whose values are all lists or maps. A
 * handler with no command key this reads fails, whatever other fields it has: a `matcher` or
 * `when` object or a list among them does not make it a container.
 */
describe('what makes an object a handler rather than a container', () => {
  it.each([
    { type: 'prompt', prompt: 'x', matcher: { tool: 'Bash' } },
    { type: 'prompt', prompt: 'x', when: { event: 'stop' } },
    { type: 'prompt', prompt: 'x', tags: ['a', 'b'] },
    { type: 'agent', agent: 'x', options: { a: [1] } },
  ])('fails %j', (handler) => {
    const value = { hooks: { Stop: [{ hooks: [handler] }] } };
    expect(kinds('.claude/settings.json', JSON.stringify(value))).toContain(
      'unreadable-config hook not read error',
    );
  });

  it('reads a hook name above the event, and a Kiro command with its trigger, as clean', () => {
    const named = { hooks: { lint: { PostToolUse: [{ command: 'npm run lint' }] } } };
    expect(kinds('.agents/hooks.json', JSON.stringify(named))).toEqual([
      'agent-hook lint.PostToolUse error',
    ]);
    const kiro = {
      name: 'x',
      when: { type: 'fileEdited', patterns: ['**/*.ts'] },
      then: { type: 'runCommand', command: 'npm test' },
    };
    expect(
      kinds('.kiro/hooks/a.kiro.hook', JSON.stringify(kiro)).filter((k) => !k.endsWith('notice')),
    ).toEqual(['agent-hook then error']);
  });
});
