import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing, type TaggedHit } from '../../src/exposure/agent-change.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { commitFiles, scratchRepo } from '../helpers/scratch-repo.js';

/**
 * Claude Code asks before it starts each server of `.mcp.json`, and VS Code before it starts a
 * workspace server. Most other hosts start every server of the project's list once the folder is
 * trusted, which is when a hook runs: a server a change adds there is as serious as a hook.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const failing = (hits: readonly TaggedHit[]): string[] =>
  hits.filter((h) => isFailing(h, 'new')).map((h) => `${h.status} ${h.kind} ${h.file}`);

const servers = (key: string) =>
  JSON.stringify({ [key]: { x: { command: 'node', args: ['s.js'] } } });

const NO_PROMPT: readonly (readonly [path: string, text: string])[] = [
  ['.codex/config.toml', '[mcp_servers.x]\ncommand = "node"\nargs = ["s.js"]\n'],
  ['.gemini/settings.json', servers('mcpServers')],
  ['.qwen/settings.json', servers('mcpServers')],
  ['opencode.json', JSON.stringify({ mcp: { x: { type: 'local', command: ['node', 's.js'] } } })],
  [
    '.zed/settings.json',
    JSON.stringify({ context_servers: { x: { command: { path: 'node', args: ['s.js'] } } } }),
  ],
  ['.roo/mcp.json', servers('mcpServers')],
  ['.kiro/settings/mcp.json', servers('mcpServers')],
  ['.cursor/mcp.json', servers('mcpServers')],
  ['.amazonq/mcp.json', servers('mcpServers')],
];

describe('a server a change adds to a host that starts it without asking', () => {
  it.each(NO_PROMPT)('fails a new server in %s', (path, text) => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { 'README.md': 'x\n' });
    commitFiles(dir, { [path]: text, 's.js': 'require("child_process").exec("id")\n' });
    expect(failing(agentChanges(dir, base).hits)).toContain(`new mcp-server ${path}`);
  });

  it.each(NO_PROMPT)('fails a change to the script a server of %s already runs', (path, text) => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { [path]: text, 's.js': 'console.log(1)\n' });
    commitFiles(dir, { 's.js': 'require("child_process").exec("id")\n' });
    expect(failing(agentChanges(dir, base).hits)).toEqual(['changed agent-run-file-changed s.js']);
  });

  it.each([
    ['.mcp.json', servers('mcpServers')],
    ['.vscode/mcp.json', servers('servers')],
  ])('lists a new server in %s to review, since its host asks first', (path, text) => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { 'README.md': 'x\n' });
    commitFiles(dir, { [path]: text, 's.js': '1\n' });
    const hits = agentChanges(dir, base).hits;
    expect(failing(hits)).toEqual([]);
    expect(hits.map((h) => `${h.status} ${h.kind} ${h.severity}`)).toContain(
      'new mcp-server warning',
    );
  });
});
