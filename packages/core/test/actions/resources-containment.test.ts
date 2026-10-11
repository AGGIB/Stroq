import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { resourcesOfFileTool } from '../../src/actions/resources.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-resource-containment-')));
  roots.push(root);
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  mkdirSync(project);
  mkdirSync(join(outside, 'child'), { recursive: true });
  writeFileSync(join(outside, 'probe.txt'), 'inert marker');
  symlinkSync(join(outside, 'child'), join(project, 'linked'), 'dir');
  return { project, outside };
}

describe.skipIf(process.platform === 'win32')(
  'resource paths through a link and a parent step',
  () => {
    it.each([false, true])('resolves the uncollapsed path (absolute: %s)', (absolute) => {
      const { project, outside } = fixture();
      const raw = `${absolute ? `${project}/` : ''}linked/../probe.txt`;
      const result = resourcesOfFileTool('Read', { file_path: raw }, project);
      expect(result.paths).toEqual([
        { path: join(project, 'probe.txt'), real: join(outside, 'probe.txt'), op: 'read' },
      ]);
      expect(result.pathsComplete).toBe(true);
    });

    it('retains distinct targets even when their lexical path is the same', () => {
      const { project, outside } = fixture();
      const result = resourcesOfFileTool(
        'Write',
        { file_path: `${project}/linked/../probe.txt`, path: join(project, 'probe.txt') },
        project,
      );
      expect(result.paths).toEqual([
        { path: join(project, 'probe.txt'), real: join(outside, 'probe.txt'), op: 'write' },
        { path: join(project, 'probe.txt'), op: 'write' },
      ]);
    });

    it('resolves a missing final file through the uncollapsed parent', () => {
      const { project, outside } = fixture();
      const result = resourcesOfFileTool('Write', { file_path: 'linked/../new.txt' }, project);
      expect(result.paths[0]?.real).toBe(join(outside, 'new.txt'));
    });

    it('retains the raw Glob base before resolving a climbing pattern', () => {
      const { project } = fixture();
      mkdirSync(join(project, 'a/b'), { recursive: true });
      mkdirSync(join(project, 'x/y'), { recursive: true });
      symlinkSync(join(project, 'x/y'), join(project, 'a/b/link'), 'dir');
      const result = resourcesOfFileTool(
        'Glob',
        { path: 'a/b/link/..', pattern: '../../probe.txt' },
        project,
      );
      expect(result.paths[1]?.real).toBe(join(project, '../probe.txt'));
    });

    it('does not lose an outside link above more than 64 missing parents', () => {
      const { project, outside } = fixture();
      const path = `linked/${'missing/'.repeat(65)}probe.txt`;
      const result = classifyTool('mcp__fs__write_file', { path }, project).resources;
      expect(result?.paths[0]?.real).toBe(
        join(outside, 'child', ...Array(65).fill('missing'), 'probe.txt'),
      );
    });

    it('marks a looping link unresolved instead of approving its lexical path', () => {
      const { project } = fixture();
      symlinkSync('loop', join(project, 'loop'));
      const result = resourcesOfFileTool('Write', { path: 'loop/probe.txt' }, project);
      expect(result.pathsComplete).toBe(false);
    });
  },
);

describe('search and MCP resource completeness', () => {
  const cwd = process.cwd();
  const target = join(cwd, 'elsewhere');

  it.each(['paths', 'files', 'directory', 'root', 'file_path', 'notebook_path'])(
    '%s names every search target',
    (key) => {
      const input = {
        pattern: 'inert',
        [key]: key === 'paths' || key === 'files' ? [target] : target,
      };
      for (const resources of [
        resourcesOfFileTool('Grep', input, cwd),
        classifyTool('Grep', input, cwd).resources,
      ]) {
        expect(resources?.paths).toEqual([{ path: target, op: 'read' }]);
        expect(resources?.pathsComplete).toBe(true);
      }
    },
  );

  it('includes nested search targets already recognized by the classifier', () => {
    const result = classifyTool('Grep', { options: { paths: [target] } }, cwd);
    expect(result.resources?.paths).toEqual([{ path: target, op: 'read' }]);
  });

  it.each([5, null, false])('does not claim a malformed MCP path is complete: %s', (path) => {
    const result = classifyTool('mcp__fs__read_file', { path }, cwd);
    expect(result.resources?.pathsComplete).toBe(false);
    expect(result.classes).toEqual(['mcp.call']);
    expect(result.signals).toEqual([]);
  });

  it('does not hide malformed search aliases behind a valid singular path', () => {
    expect(classifyTool('Grep', { path: target, paths: [5] }, cwd).resources?.pathsComplete).toBe(
      false,
    );
  });

  it.each([{}, { bad: 7 }, []])('rejects a malformed path container %j', (path) => {
    for (const tool of ['Grep', 'mcp__fs__read_file']) {
      const result = classifyTool(tool, { path, paths: [target] }, cwd);
      expect(result.resources?.pathsComplete).toBe(false);
    }
  });

  it('keeps understood path containers complete', () => {
    const result = classifyTool(
      'mcp__fs__write_file',
      { files: [{ path: target }], output: { path: target } },
      cwd,
    );
    expect(result.resources?.pathsComplete).toBe(true);
  });
});
