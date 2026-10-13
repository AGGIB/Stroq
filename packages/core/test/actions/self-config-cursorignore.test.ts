import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { SELF_CONFIG_FILE } from '../../src/actions/self-config.js';

/**
 * `.cursorignore` is the file that keeps `.env` and keys out of what Cursor sends to a model. `stroq
 * harden` writes a block into it, so an agent that can edit it can take that block out again. It is
 * protected like the other files that switch a protection off: the file itself, as a whole path
 * segment, and not a file whose name merely contains it.
 */
describe('SELF_CONFIG_FILE and .cursorignore', () => {
  it.each([
    '.cursorignore',
    './.cursorignore',
    '/work/project/.cursorignore',
    'echo ".env" >> .cursorignore',
    'rm -f ~/project/.cursorignore',
    'C:\\work\\project\\.cursorignore',
    '.CURSORIGNORE',
  ])('matches %s', (text) => expect(SELF_CONFIG_FILE.test(text)).toBe(true));

  it.each([
    'my.cursorignore',
    'old-.cursorignore',
    '.cursorignore.bak',
    '.cursorignored',
    'cat .cursorignore-notes.md',
    '.cursor/rules/style.md',
    'cursorignore',
  ])('does not match %s', (text) => expect(SELF_CONFIG_FILE.test(text)).toBe(false));
});

describe('an agent writing .cursorignore', () => {
  it('is self-tampering when a Write names the file', () => {
    const result = classifyTool('Write', { file_path: '/work/project/.cursorignore' }, '/work');
    expect(result.classes).toContain('config.self');
  });

  it('is self-tampering when an Edit names the file', () => {
    const result = classifyTool('Edit', { file_path: '/work/project/.cursorignore' }, '/work');
    expect(result.classes).toContain('config.self');
  });

  it('is self-tampering when a shell redirect writes the file', () => {
    const result = classifyCommand('printf "" > .cursorignore', '/work');
    expect(result.classes).toContain('config.self');
  });

  it('is not self-tampering to read the file', () => {
    const result = classifyCommand('cat .cursorignore', '/work');
    expect(result.classes).not.toContain('config.self');
  });

  it('is not self-tampering to write a file that only resembles it', () => {
    const result = classifyTool('Write', { file_path: '/work/project/my.cursorignore' }, '/work');
    expect(result.classes).not.toContain('config.self');
  });
});
