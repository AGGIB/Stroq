import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { classifySelfConfigSegment } from '../../src/actions/self-config.js';
import { DEFAULT_POLICY } from '../../src/policy/default-policy.js';
import { evaluatePolicy } from '../../src/policy/evaluate.js';

const protectedDirectories = [
  '.claude',
  '.cursor',
  '.codex',
  '.copilot',
  '.openclaw',
  '.stroq',
  '.windsurf',
  '.devin',
  '.codeium',
  '.agents',
  '.gemini',
  '.github/hooks',
  '.github/copilot',
];

// These are command strings for the classifiers, never commands to execute.
const bareTargets: (readonly [string, string])[] = protectedDirectories.flatMap((directory) => {
  const windowsDirectory = directory.replaceAll('/', '\\');
  return [
    [`rm -rf ${directory}//`, '/home/dev/project'],
    [`mv "${directory}///" backup`, '/home/dev/project'],
    [`rm -rf ${directory}///*`, '/home/dev/project'],
    [`Remove-Item -Recurse -Force "C:\\Users\\me\\${windowsDirectory}\\\\"`, 'C:\\src\\app'],
    [`Move-Item '${windowsDirectory}\\\\\\' backup`, 'C:\\src\\app'],
    [`Remove-Item -Recurse -Force '${windowsDirectory}\\/\\*'`, 'C:\\src\\app'],
  ] as const;
});
bareTargets.push(['rm -rf ~/.claude//', '/home/dev/project']);

const editableTargets = [
  ['rm -rf .windsurf///rules/cache', '/home/dev/project'],
  ['mv .claude///CLAUDE.md .claude///notes.md', '/home/dev/project'],
  ['rm .claude///CLAUDE.md.bak', '/home/dev/project'],
  ['rm .agents///reviewer.md', '/home/dev/project'],
  ['rm .codeium///windsurf/notes.txt', '/home/dev/project'],
  ['rm -rf .github///workflows//', '/home/dev/project'],
  ['rm -rf .claude-backup///', '/home/dev/project'],
  ['Set-Content ".cursor\\\\rules\\style.md" -Value test', 'C:\\src\\app'],
  ['Remove-Item -Recurse -Force ".windsurf\\\\workflows\\cache"', 'C:\\src\\app'],
  ['Remove-Item -Recurse -Force ".github\\\\workflows\\\\"', 'C:\\src\\app'],
] as const;

describe('bare protected directories with repeated trailing separators', () => {
  it.each(bareTargets)('detects write intent in the segment: %s', (command) => {
    expect(classifySelfConfigSegment(command)).toBe('deny');
  });

  it.each(bareTargets)('denies through the default policy: %s', (command, cwd) => {
    const { classes } = classifyCommand(command, cwd);
    expect(classes).toContain('config.self');
    expect(evaluatePolicy(DEFAULT_POLICY, classes, null)).toMatchObject({
      effect: 'deny',
      ruleId: 'deny-self-tamper',
    });
  });

  it.each(editableTargets)(
    'keeps editable subpaths and look-alikes outside self-tamper: %s',
    (command, cwd) => {
      expect(classifySelfConfigSegment(command)).toBeNull();
      const { classes } = classifyCommand(command, cwd);
      expect(classes).not.toContain('config.self');
      expect(evaluatePolicy(DEFAULT_POLICY, classes, null).ruleId).not.toBe('deny-self-tamper');
    },
  );
});
