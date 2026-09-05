import { describe, expect, it } from 'vitest';
import { classifyTool, parseMcpToolName } from '../../src/actions/classify-tool.js';

const cwd = '/home/dev/project';

describe('parseMcpToolName', () => {
  it('splits server and tool at the last double underscore', () => {
    expect(parseMcpToolName('mcp__github__create_issue')).toEqual({
      server: 'github',
      tool: 'create_issue',
    });
    expect(parseMcpToolName('mcp__plugin_my-plugin_db__query')).toEqual({
      server: 'plugin_my-plugin_db',
      tool: 'query',
    });
    expect(parseMcpToolName('Bash')).toBeNull();
  });
});

describe('classifyTool', () => {
  it('delegates Bash to the command classifier', () => {
    expect(classifyTool('Bash', { command: 'curl https://x.example' }, cwd).classes).toContain(
      'shell.network',
    );
  });
  it('flags writes to agent security config as config.self', () => {
    expect(
      classifyTool('Write', { file_path: `${cwd}/.claude/settings.json`, content: '{}' }, cwd)
        .classes,
    ).toEqual(['config.self']);
    expect(
      classifyTool('Edit', { file_path: '/home/dev/.cursor/hooks.json' }, cwd).classes,
    ).toEqual(['config.self']);
  });
  it('flags secret paths on Read/Write', () => {
    expect(classifyTool('Read', { file_path: '/home/dev/.ssh/id_ed25519' }, cwd).classes).toEqual([
      'fs.secrets',
    ]);
    expect(
      classifyTool('Write', { file_path: `${cwd}/.env`, content: 'X=1' }, cwd).classes,
    ).toEqual(['fs.secrets']);
    expect(classifyTool('Read', { file_path: `${cwd}/src/index.ts` }, cwd).classes).toEqual([]);
  });
  it('classifies WebFetch as network.fetch with host', () => {
    const r = classifyTool('WebFetch', { url: 'https://docs.example/page' }, cwd);
    expect(r.classes).toEqual(['network.fetch']);
    expect(r.hosts).toEqual(['docs.example']);
  });
  it('classifies MCP calls and side-effecting tool names', () => {
    expect(classifyTool('mcp__fs__read_file', { path: 'a' }, cwd)).toMatchObject({
      classes: ['mcp.call'],
      mcp: { server: 'fs', tool: 'read_file' },
    });
    expect(classifyTool('mcp__gmail__send_email', {}, cwd).classes).toEqual([
      'mcp.call',
      'mcp.side_effect',
    ]);
    expect(classifyTool('mcp__github__delete_repo', {}, cwd).classes).toContain('mcp.side_effect');
  });
  it('returns no classes for unknown tools', () => {
    expect(classifyTool('Glob', { pattern: '*' }, cwd).classes).toEqual([]);
  });

  it('flags an MCP tool writing to the protected config as config.self', () => {
    expect(
      classifyTool('mcp__fs__write_file', { path: '.claude/settings.json' }, cwd).classes,
    ).toContain('config.self');
  });
  it('does not flag an MCP tool touching an unrelated path', () => {
    expect(classifyTool('mcp__fs__read_file', { path: 'src/index.ts' }, cwd).classes).not.toContain(
      'config.self',
    );
  });
  it('scans array-of-string MCP tool inputs one level deep', () => {
    expect(
      classifyTool('mcp__fs__write_files', { paths: ['a.ts', '.claude/settings.json'] }, cwd)
        .classes,
    ).toContain('config.self');
  });
});

describe('F3 self-tamper gate precision: MCP write-shaped tool + path-like key only', () => {
  it('read_file with a path-like key is only mcp.call, no config.self', () => {
    const r = classifyTool('mcp__fs__read_file', { path: '.claude/settings.json' }, cwd);
    expect(r.classes).toEqual(['mcp.call']);
  });
  it('create_issue mentioning the path in a non-path key (body) does not flag config.self', () => {
    const r = classifyTool('mcp__github__create_issue', { body: 'see .claude/settings.json' }, cwd);
    expect(r.classes).not.toContain('config.self');
  });
  it('send_message mentioning the path in a non-path key (text) does not flag config.self', () => {
    const r = classifyTool(
      'mcp__slack__send_message',
      { text: 'I updated .claude/settings.json' },
      cwd,
    );
    expect(r.classes).not.toContain('config.self');
  });
  it('write_file with the path in a path-like key still flags config.self', () => {
    const r = classifyTool('mcp__fs__write_file', { path: '.claude/settings.json' }, cwd);
    expect(r.classes).toContain('config.self');
  });
});

describe('Codex security config is self-config', () => {
  it('flags a write to .codex/hooks.json and .codex/config.toml', () => {
    expect(
      classifyTool('Write', { file_path: `${cwd}/.codex/hooks.json`, content: '{}' }, cwd).classes,
    ).toEqual(['config.self']);
    expect(
      classifyTool('Edit', { file_path: '/home/dev/.codex/config.toml' }, cwd).classes,
    ).toEqual(['config.self']);
  });

  it('flags a find -delete against the .codex directory', () => {
    expect(
      classifyTool('Bash', { command: "find .codex -name 'hooks.json' -delete" }, cwd).classes,
    ).toContain('config.self');
  });

  it('still leaves an ordinary file in .codex alone', () => {
    expect(classifyTool('Write', { file_path: `${cwd}/.codex/notes.md` }, cwd).classes).toEqual([]);
  });
});
