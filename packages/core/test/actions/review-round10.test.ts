import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { commandWord, firstArgAfter } from '../../src/actions/shell-segments.js';
import { commandDescribes } from '../../src/actions/shell-wrappers.js';
import { resolve } from '../../src/actions/shell-words.js';

/**
 * What the last review of the work on wrappers and launchers found: a keyword inside a long word that began a
 * header of a function at every one of them (160 KiB took thirty seconds), `command -v at` that was read as a job,
 * and lines of prose that were read as `at` jobs in documents given to programs that read data.
 */

const CWD = '/home/dev/project';
const classes = (command: string): readonly string[] => classifyCommand(command, CWD).classes;
const stopped = (command: string): boolean => classes(command).length > 0;
const schedules = (command: string): boolean => classes(command).includes('config.persistence');

describe('a keyword is the start of a header of a function only as a word of its own', () => {
  it.each([
    'if true; then g() { rm "$@"; }; fi; g -rf ~',
    'for i in a; do g() { rm "$@"; }; done; g -rf ~',
    'if false; then :; else g() { rm "$@"; }; fi; g -rf ~',
    'while true; do function g { rm "$@"; }; break; done; g -rf ~',
  ])('a function defined after it is found: %s', (command) => {
    expect(classes(command), command).toContain('shell.destructive');
  });

  it('is not one inside a word (`-do-then-else`), whose name would run to the end of the word', () => {
    const started = process.cpuUsage();
    const command = `: function\n;f${'-do-then-else'.repeat(5000)}`;

    classifyCommand(command, CWD);

    const used = process.cpuUsage(started);
    // 64 KiB took 2.5 s when each keyword in the word began a name: linear work takes a few tens of milliseconds.
    expect((used.user + used.system) / 1000).toBeLessThan(1000);
  });
});

describe('command, told to describe a name, runs nothing', () => {
  it.each([
    [['-v', 'at'], true],
    [['-V', 'at'], true],
    [['-pv', 'at'], true],
    [['-p', '-v', 'at'], true],
    [['-p', 'at', 'now'], false],
    [['--', 'at', 'now'], false],
    [['at', 'now'], false],
    [[], false],
    [['-v'], true],
    [['--', '-v'], false],
  ])('%j describes: %s', (following, describes) => {
    expect(commandDescribes(following)).toBe(describes);
  });

  it.each([
    'command -v at',
    'command -V at',
    'command -v batch',
    'builtin command -v at',
    'command -pv at',
    'command -v crontab',
    'command -v at || echo missing',
    'if ! command -v at >/dev/null; then echo "at is not installed"; fi',
    '[ -x "$(command -v at)" ] && echo ok',
  ])('is no job and no change of a table: %s', (command) => {
    expect(stopped(command), command).toBe(false);
  });

  it.each([
    'command -p at now',
    'command at now',
    'command -- at now',
    'command -v at; at now',
    'which at && at now',
    'command -p crontab -r',
  ])('still runs what it is told to run: %s', (command) => {
    expect(stopped(command), command).toBe(true);
  });

  it('is the command of its stage in each of the readers that look at the words of one', () => {
    expect(commandWord('command -v at')).toBe('command');
    expect(commandWord('builtin command -v crontab')).toBe('command');
    expect(commandWord('command -p at now')).toBe('at');
    expect(firstArgAfter('command -v at')).toBe('at');
    expect(resolve('command -v at')?.name).toBe('command');
    expect(resolve('command -p at now')?.name).toBe('at');
  });
});

describe('a document given to a program that reads data holds no job', () => {
  it.each([
    "sort <<'EOF'\nat 5pm\nbatch 5\nEOF",
    'python3 <<\'EOF\'\ntext = """\nat 5pm we start\n"""\nprint(text)\nEOF',
    'mail -s "Meeting" bob@example.com <<EOF\nHi Bob,\nat 5pm tomorrow\nEOF',
    'jq . <<\'EOF\'\n{"a": "x"}\nat noon\nEOF',
    "base64 <<'EOF'\nat noon\nEOF",
    "node <<'EOF'\nconsole.log(`\nat 5pm\n`)\nEOF",
    "pbcopy <<'EOF'\nat noon\nEOF",
    "xargs echo <<'EOF'\nat 3 things\nEOF",
    "xargs echo <<'EOF'\nat 5pm\nEOF",
    // A here-document with no command to give it to is given to nothing.
    "<<'EOF'\nat 5pm\nEOF",
    "> notes <<'EOF'\nat 5pm\nEOF",
  ])('is no job: %s', (command) => {
    expect(schedules(command), command).toBe(false);
  });

  it.each([
    "cat > x.sh <<'EOF'\n#!/bin/sh\nat now\nEOF",
    "cat > notes <<'EOF'\nat noon\nEOF",
    "tee ~/run.sh <<'EOF'\nat 5pm\nEOF",
    "at now <<'EOF'\nrm -rf /tmp/x\nEOF",
    "bash <<'EOF'\nuname -a\nat now\nEOF",
    "cat <<'EOF' | bash\nat now\nEOF",
    "sudo bash <<'EOF'\nat now\nEOF",
  ])('is a job where it is written to a file that may run, or run: %s', (command) => {
    expect(schedules(command), command).toBe(true);
  });
});

describe('a line is a job only when everything after `at` is a time', () => {
  it.each([
    'at now',
    'at now + 1 hour',
    'at now+1hour',
    'at 5pm',
    'at 5 pm',
    'at 5:30pm',
    'at 4:30 PM',
    'at 17:00',
    'at 1700',
    'at 0100 tomorrow',
    'at noon',
    'at midnight',
    'at teatime',
    'at tomorrow',
    'at today',
    'at 10am tomorrow',
    'at 10am Jul 31',
    'at 10am jul 31 2027',
    'at 10pm Dec 25',
    'at 4pm + 3 days',
    'at now + 1 week',
    'at 12/25/26',
    'at 2026-12-25',
    'at 25.12.26',
    'at 14:30 12/25/26',
    'at noon next week',
    'at next month',
    'at noon sat',
    'at 5pm monday',
    'at 9am Monday',
    'at -f job.sh 17:00',
    'at 17:00 -f job.sh',
    'at -q b now',
    'at -m now',
    'at -M now',
    'at -t 202612251200',
    'at "5pm"',
    "at 'now + 1 hour'",
    'at -f "my job.sh" 17:00',
    "at -f 'job.sh' now",
    "at 'now' <<< 'echo hi'",
    "at now <<< 'echo hi'",
    'at now < job.sh',
    'AT NOW',
    'batch',
    'batch -f job.sh',
    'batch now',
    'echo x | at 5pm tomorrow',
  ])('is a job: %s', (command) => {
    expect(schedules(command), command).toBe(true);
  });

  it.each([
    'at noon we meet',
    'at 5pm we start',
    'at least three',
    'at 3 AM and removes temp files.',
    'at 100% CPU',
    'at next release',
    'at 9 and closes at 5',
    'at the end',
    'at = item.scheduledAt',
    'at (x) => 1',
    'batch size is 5',
    'at 5 attempts',
    'batch = []',
    'batch: list[dict] = []',
    'batch.append(row)',
    'at = 5',
  ])('is prose, even where it stands in a document that may be a script: %s', (line) => {
    const command = `cat > notes <<'EOF'\n${line}\nEOF`;

    expect(schedules(command), command).toBe(false);
  });
});

describe('a name that several definitions share', () => {
  const chain = (bodies: number): string => {
    const arms = Array.from({ length: bodies }, (_, i) => {
      const body = i === bodies - 1 ? 'rm "$@"' : `echo ${i}`;
      return `${i === 0 ? 'if' : 'elif'} [ "$k" = ${i} ]; then f() { ${body}; }`;
    });
    return `${arms.join(' ')}; fi; f -rf ~`;
  };

  it.each([1, 5, 8, 12])('is read as all of its bodies up to twelve: %i', (bodies) => {
    expect(classes(chain(bodies))).toContain('shell.destructive');
  });

  it('is asked about past twelve, for the call may be any of them', () => {
    const command = chain(13);

    expect(classes(command)).toContain('shell.unparsed');
    expect(classes(command)).not.toContain('shell.destructive');
  });
});
