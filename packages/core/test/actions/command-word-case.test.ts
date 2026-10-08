import { describe, expect, it } from 'vitest';
import { programName } from '../../src/actions/known-commands.js';
import { classifyTool } from '../../src/actions/classify-tool.js';

const classes = (command: string): readonly string[] =>
  classifyTool('Bash', { command }, '/home/dev/project').classes;

/**
 * A file system that does not tell `RM` from `rm` (a Mac's, Windows') runs both, so a command in
 * capitals is read as the command. A builtin has no file to find: `EXPORT` is a word, and the
 * pattern of `grep -E "error|EXPORT|warning"`, which the plain cut leaves as a segment of its own,
 * does not dump the environment. Found on a real `xcodebuild … | grep -E "error|EXPORT|Exported"`,
 * which the first capital-folding made `fs.secrets`.
 */
describe('a command word in capitals is the program the file system finds, not a builtin', () => {
  it.each([
    ['rm', 'rm'],
    ['RM', 'rm'],
    ['Git', 'git'],
    ['ENV', 'env'],
    ['PRINTENV', 'printenv'],
    ['EXPORT', 'EXPORT'],
    ['Set', 'Set'],
    ['EVAL', 'EVAL'],
    ['export', 'export'],
  ])('%s is read as %s', (word, read) => {
    expect(programName(word)).toBe(read);
  });

  it.each([
    'xcodebuild -exportArchive -x 2>&1 | grep -E "error|EXPORT|Exported|warning: " | head -10',
    'ls | grep -E "a|SET|b"',
    'EXPORT',
    'SET',
  ])('does not dump the environment: %s', (command) => {
    expect(classes(command)).not.toContain('fs.secrets');
  });

  it.each(['env', 'ENV', 'printenv', 'PRINTENV', 'export', 'set'])(
    'still dumps the environment: %s',
    (command) => {
      expect(classes(command)).toContain('fs.secrets');
    },
  );

  it('still reads a program in capitals as the program', () => {
    expect(classes('RM -rf ~')).toContain('shell.destructive');
    expect(classes('sudo RM -rf ~')).toContain('shell.destructive');
    expect(classes('GIT reset --hard')).toContain('shell.destructive');
  });
});
