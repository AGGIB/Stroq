import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing, type TaggedHit } from '../../src/exposure/agent-change.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { describe as sentenceOf, plainQuote } from '../../src/exposure/agent-report.js';
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

  // A host that asks first still starts the server on the first yes, and the shape of its command
  // is no proof it is harmless: a new one fails there too.
  it.each([
    ['.mcp.json', servers('mcpServers')],
    ['.vscode/mcp.json', servers('servers')],
  ])('fails a new server in %s too, though its host asks first', (path, text) => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { 'README.md': 'x\n' });
    commitFiles(dir, { [path]: text, 's.js': '1\n' });
    const hits = agentChanges(dir, base).hits;
    expect(failing(hits)).toEqual([`new mcp-server ${path}`]);
    const server = hits.find((h) => h.kind === 'mcp-server') as TaggedHit;
    expect(sentenceOf(server, plainQuote)).toBe(
      'new: MCP server x is new, and starts once its host is told yes, or at once if the settings approve it: node s.js',
    );
  });
});

/**
 * Claude Code keeps the servers it was allowed to start by their names, so a name approved before
 * starts whatever the change now puts under it. Only a server that is new is listed to review.
 */
describe('a server already there whose command a change replaces', () => {
  const npx = (pkg: string) => ({ command: 'npx', args: ['-y', pkg] });

  it.each([
    ['.mcp.json', 'mcpServers'],
    ['.vscode/mcp.json', 'servers'],
  ])('fails in %s', (path, key) => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, {
      [path]: JSON.stringify({ [key]: { docs: npx('docs-mcp@1.0.0') } }),
    });
    commitFiles(dir, { [path]: JSON.stringify({ [key]: { docs: npx('totally-evil-pkg@9') } }) });
    const hits = agentChanges(dir, base).hits;
    expect(failing(hits)).toContain(`changed mcp-server ${path}`);
    const docs = hits.find((h) => h.kind === 'mcp-server') as TaggedHit;
    expect(sentenceOf(docs, plainQuote)).toBe(
      'changed: MCP server docs now starts something else, under a name the host may have approved before: npx -y totally-evil-pkg@9',
    );
  });
});
