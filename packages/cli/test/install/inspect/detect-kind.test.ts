import { describe, expect, it } from 'vitest';
import { InspectError } from '../../../src/install/inspect/index.js';
import { passportOf, type Files } from '../../helpers/inspect.js';

const auto = (files: Files) => passportOf(files, { kind: 'auto' });

function cannotTell(files: Files): InspectError {
  try {
    auto(files);
  } catch (error) {
    if (error instanceof InspectError) return error;
    throw error;
  }
  throw new Error('expected an InspectError, and nothing was thrown');
}

describe('kind detection', () => {
  it('takes a SKILL.md at the root for a skill', () => {
    expect(auto({ 'SKILL.md': '# s\n' }).artifact.kind).toBe('skill');
  });

  it('takes a skill.md written in lower case for a skill, as a disk that ignores case does', () => {
    expect(auto({ 'skill.md': '# s\n' }).artifact.kind).toBe('skill');
  });

  it('takes a package with a bin and a dependency on the MCP SDK for a server', () => {
    const passport = auto({
      'package.json': JSON.stringify({
        name: 'weather',
        bin: { weather: 'index.js' },
        dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
      }),
      'index.js': 'console.log(1)\n',
    });

    expect(passport.artifact.kind).toBe('mcp');
  });

  it('takes a package with a main and a scoped MCP name for a server', () => {
    const passport = auto({
      'package.json': JSON.stringify({
        name: '@modelcontextprotocol/server-x',
        main: 'dist/index.js',
      }),
    });

    expect(passport.artifact.kind).toBe('mcp');
  });

  it('takes a package with an mcp in its name and a main for a server', () => {
    const passport = auto({
      'package.json': JSON.stringify({ name: 'my-mcp-server', main: 'index.js' }),
    });

    expect(passport.artifact.kind).toBe('mcp');
  });

  it('does not take a package for a server because of a name that only contains the letters', () => {
    const error = cannotTell({
      'package.json': JSON.stringify({ name: 'mcpherson-utils', main: 'index.js' }),
    });

    expect(error.code).toBe('cannot-tell-kind');
  });

  it('takes a .mcp.json at the root for a server', () => {
    expect(auto({ '.mcp.json': '{"mcpServers":{}}' }).artifact.kind).toBe('mcp');
  });

  it('takes a Python project that depends on mcp for a server', () => {
    const passport = auto({
      'pyproject.toml': '[project]\nname = "x"\ndependencies = ["mcp>=1.0"]\n',
    });

    expect(passport.artifact.kind).toBe('mcp');
  });

  it('takes a plugin manifest for a plugin, even beside a .mcp.json and a SKILL.md', () => {
    const passport = auto({
      '.claude-plugin/plugin.json': '{"name":"p"}',
      '.mcp.json': '{"mcpServers":{}}',
      'SKILL.md': '# s\n',
    });

    expect(passport.artifact.kind).toBe('plugin');
  });

  it('does not take a package with an MCP dependency and no bin or main for a server', () => {
    const error = cannotTell({
      'package.json': JSON.stringify({
        name: 'lib',
        dependencies: { '@modelcontextprotocol/sdk': '^1' },
      }),
    });

    expect(error.code).toBe('cannot-tell-kind');
  });

  it('refuses to guess between a skill and a server', () => {
    const error = cannotTell({
      'SKILL.md': '# s\n',
      'package.json': JSON.stringify({ name: 'x-mcp', main: 'i.js' }),
    });

    expect(error.code).toBe('cannot-tell-kind');
    expect(error.message).toContain('more than one');
  });

  it('refuses a tree with nothing that says what it is, and says what to do', () => {
    const error = cannotTell({ 'README.md': '# hi\n' });

    expect(error.code).toBe('cannot-tell-kind');
    expect(error.message).toContain('say which');
  });

  it('refuses an empty tree', () => {
    expect(cannotTell({}).code).toBe('cannot-tell-kind');
  });

  it('does not take a SKILL.md in a folder for the skill at the root', () => {
    expect(cannotTell({ 'skills/a/SKILL.md': '# a\n' }).code).toBe('cannot-tell-kind');
  });

  it('is not misled by a package.json that is not JSON', () => {
    const passport = auto({ 'SKILL.md': '# s\n', 'package.json': '{ not json' });

    expect(passport.artifact.kind).toBe('skill');
  });

  it('is not misled by a package.json that is an array or has odd keys', () => {
    expect(auto({ 'SKILL.md': '# s\n', 'package.json': '[1,2,3]' }).artifact.kind).toBe('skill');
    expect(
      auto({
        'SKILL.md': '# s\n',
        'package.json': '{"__proto__":{"main":"x"},"name":"mcp-thing"}',
      }).artifact.kind,
    ).toBe('skill');
  });

  it('uses the kind it is told, whatever the files look like', () => {
    expect(passportOf({ 'README.md': '# hi\n' }, { kind: 'plugin' }).artifact.kind).toBe('plugin');
    expect(passportOf({ 'SKILL.md': '# s\n' }, { kind: 'mcp' }).artifact.kind).toBe('mcp');
  });
});
