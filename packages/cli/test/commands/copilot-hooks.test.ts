import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COPILOT_HOOK_EVENTS,
  buildCopilotHooks,
  copilotHooksPath,
  installCopilotHooks,
  isStroqCopilotHooks,
  readCopilotHooks,
  type CopilotHooksFile,
} from '../../src/commands/copilot-hooks.js';

const pre = '"/usr/bin/node" "/x/index.js" hook copilot pre';
const post = '"/usr/bin/node" "/x/index.js" hook copilot post';

describe('buildCopilotHooks', () => {
  it('writes the whole file Copilot documents, both phases, no matcher', () => {
    expect(buildCopilotHooks(pre, post)).toEqual({
      version: 1,
      hooks: {
        preToolUse: [
          {
            type: 'command',
            bash: pre,
            powershell: `& ${pre}`,
            timeoutSec: 15,
            comment: 'Stroq',
          },
        ],
        postToolUse: [
          {
            type: 'command',
            bash: post,
            powershell: `& ${post}`,
            timeoutSec: 15,
            comment: 'Stroq',
          },
        ],
      },
    });
    // No matcher on purpose: MCP names are unknown to hooks, so every tool has to
    // reach Stroq, and one it does not care about returns nothing in a few ms.
    expect(JSON.stringify(buildCopilotHooks(pre, post))).not.toContain('matcher');
    expect(COPILOT_HOOK_EVENTS).toEqual(['preToolUse', 'postToolUse']);
  });

  it('recognises only a file carrying both of its own entries', () => {
    const file = buildCopilotHooks(pre, post);
    expect(isStroqCopilotHooks(file)).toBe(true);
    expect(isStroqCopilotHooks({})).toBe(false);
    expect(isStroqCopilotHooks({ version: 1, hooks: { preToolUse: file.hooks.preToolUse } })).toBe(
      false,
    );
    expect(
      isStroqCopilotHooks({
        version: 1,
        hooks: {
          preToolUse: [{ type: 'command', bash: 'echo hi', timeoutSec: 5 }],
          postToolUse: [{ type: 'command', bash: 'echo hi', timeoutSec: 5 }],
        },
      }),
    ).toBe(false);
  });

  it('survives a hand-mangled file without throwing', () => {
    for (const json of [
      { hooks: 'nope' },
      { hooks: { preToolUse: 'nope', postToolUse: 7 } },
      { hooks: { preToolUse: [null, 'x'], postToolUse: [{ bash: 7 }] } },
      null,
      'nope',
    ])
      expect(isStroqCopilotHooks(json)).toBe(false);
  });
});

describe('copilotHooksPath', () => {
  it('is the repository hooks directory for a project', () => {
    expect(copilotHooksPath('project', '/w')).toBe('/w/.github/hooks/stroq.json');
  });

  it('honours COPILOT_HOME for the user scope, and falls back to ~/.copilot', () => {
    expect(copilotHooksPath('user', '/w', { COPILOT_HOME: '/opt/copilot' })).toBe(
      '/opt/copilot/hooks/stroq.json',
    );
    expect(copilotHooksPath('user', '/w', {})).toMatch(/\.copilot\/hooks\/stroq\.json$/);
    // An empty variable is not a home directory.
    expect(copilotHooksPath('user', '/w', { COPILOT_HOME: '' })).toMatch(
      /\.copilot\/hooks\/stroq\.json$/,
    );
  });
});

describe('installCopilotHooks', () => {
  const project = () => mkdtempSync(join(tmpdir(), 'stroq-copilot-init-'));

  it('creates the directory, writes the file, and rewrites it identically', () => {
    const dir = project();
    const file = copilotHooksPath('project', dir);
    expect(readCopilotHooks(file)).toEqual({});
    installCopilotHooks(file, pre, post);
    expect(existsSync(file)).toBe(true);
    const first = readFileSync(file, 'utf8');
    expect(JSON.parse(first)).toEqual(buildCopilotHooks(pre, post));
    installCopilotHooks(file, pre, post);
    expect(readFileSync(file, 'utf8')).toBe(first);
    expect(isStroqCopilotHooks(readCopilotHooks(file))).toBe(true);
  });

  it('never touches another file in the hooks directory', () => {
    // Copilot loads every *.json in the directory independently, so there is nothing
    // to merge — and nothing of anyone else's to rewrite.
    const dir = project();
    const file = copilotHooksPath('project', dir);
    mkdirSync(dirname(file), { recursive: true });
    const foreign = join(dirname(file), 'team.json');
    writeFileSync(foreign, '{ "version": 1, "hooks": { "sessionStart": [] } }');
    installCopilotHooks(file, pre, post);
    expect(readFileSync(foreign, 'utf8')).toBe('{ "version": 1, "hooks": { "sessionStart": [] } }');
  });

  it('replaces an older Stroq file wholesale, including one written by hand', () => {
    const dir = project();
    const file = copilotHooksPath('project', dir);
    installCopilotHooks(file, '"/old/node" "/old/index.js" hook copilot pre', post);
    installCopilotHooks(file, pre, post);
    const written = JSON.parse(readFileSync(file, 'utf8')) as CopilotHooksFile;
    // Stroq owns the name `stroq.json`; a second entry is never stacked.
    expect(written.hooks.preToolUse).toHaveLength(1);
    expect(written.hooks.preToolUse[0]?.bash).toBe(pre);
    expect(JSON.stringify(written)).not.toContain('/old/node');
  });

  it('throws a descriptive error when the file exists but is not JSON', () => {
    const dir = project();
    const file = copilotHooksPath('project', dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    expect(() => readCopilotHooks(file)).toThrow(/cannot parse/);
  });
});
