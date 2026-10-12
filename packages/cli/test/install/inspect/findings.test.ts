import { describe, expect, it } from 'vitest';
import { MAX_LINES, MAX_PLACES } from '../../../src/install/inspect/blind-spots.js';
import { Findings, type LineInput } from '../../../src/install/inspect/findings.js';
import { PassportLineSchema } from '../../../src/install/types.js';

const base: LineInput = {
  kind: 'net',
  subject: 'example.com',
  basis: 'observed',
  sensitive: true,
  file: 'SKILL.md',
  line: 3,
  detector: 'a host in shell text',
};

describe('Findings: lines', () => {
  it('keeps a line and checks it against the schema of a line', () => {
    const findings = new Findings();

    findings.line(base);
    const { lines } = findings.result();

    expect(lines).toHaveLength(1);
    expect(PassportLineSchema.safeParse(lines[0]).success).toBe(true);
    expect(lines[0]).toEqual({
      kind: 'net',
      subject: 'example.com',
      basis: 'observed',
      sensitive: true,
      where: [{ file: 'SKILL.md', line: 3 }],
      detector: 'a host in shell text',
    });
  });

  it('joins the same finding in several places into one line with every place', () => {
    const findings = new Findings();

    findings.line(base);
    findings.line({ ...base, file: 'lib/a.js', line: 40 });
    findings.line({ ...base, file: 'SKILL.md', line: 1 });
    const { lines } = findings.result();

    expect(lines).toHaveLength(1);
    expect(lines[0]?.where).toEqual([
      { file: 'SKILL.md', line: 1 },
      { file: 'SKILL.md', line: 3 },
      { file: 'lib/a.js', line: 40 },
    ]);
  });

  it('lists a place once, however often it is found there', () => {
    const findings = new Findings();

    findings.line(base);
    findings.line(base);
    findings.line({ ...base, line: null });

    expect(findings.result().lines[0]?.where).toEqual([
      { file: 'SKILL.md', line: null },
      { file: 'SKILL.md', line: 3 },
    ]);
  });

  it('keeps findings that differ in kind, subject, basis or sensitivity apart', () => {
    const findings = new Findings();

    findings.line(base);
    findings.line({ ...base, subject: 'other.example' });
    findings.line({ ...base, basis: 'declared' });
    findings.line({ ...base, sensitive: false });
    findings.line({ ...base, kind: 'exec' });

    expect(findings.result().lines).toHaveLength(5);
  });

  it('joins the same finding made by two readings into one line that names both, in a fixed order', () => {
    const forward = new Findings();
    const backward = new Findings();

    forward.line({ ...base, detector: 'reading b' });
    forward.line({ ...base, detector: 'reading a', file: 'src/a.js' });
    backward.line({ ...base, detector: 'reading a', file: 'src/a.js' });
    backward.line({ ...base, detector: 'reading b' });

    expect(forward.result().lines).toHaveLength(1);
    expect(forward.result().lines[0]?.detector).toBe('reading a; reading b');
    expect(JSON.stringify(forward.result())).toBe(JSON.stringify(backward.result()));
  });

  it('says once at the end that no reading is a verdict, when the readings that are joined each end that way', () => {
    const findings = new Findings();

    findings.line({
      ...base,
      detector: 'an address in shell text; a signal to look at, not a verdict',
    });
    findings.line({
      ...base,
      detector: 'an address in source; a signal to look at, not a verdict',
    });

    expect(findings.result().lines[0]?.detector).toBe(
      'an address in shell text; an address in source; a signal to look at, not a verdict',
    );
  });

  it('keeps a bounded number of different findings, and counts the ones it let go', () => {
    const findings = new Findings();

    for (let i = 0; i < 20_050; i += 1) findings.line({ ...base, subject: `h${i}.example` });
    const result = findings.result();

    expect(result.lines).toHaveLength(MAX_LINES);
    expect(
      result.blindSpots.some((spot) =>
        spot.startsWith(`${20_050 - MAX_LINES} more findings were found`),
      ),
    ).toBe(true);
  });

  it('puts the lines in an order that does not depend on the order they were found in', () => {
    const inputs: LineInput[] = [
      { ...base, kind: 'net', subject: 'b.example' },
      { ...base, kind: 'cred.env', subject: 'TOKEN' },
      { ...base, kind: 'net', subject: 'a.example', file: 'z.md' },
      { ...base, kind: 'net', subject: 'a.example', file: 'a.md' },
      { ...base, kind: 'exec', subject: 'curl' },
    ];
    const forward = new Findings();
    const backward = new Findings();

    for (const input of inputs) forward.line(input);
    for (const input of [...inputs].reverse()) backward.line(input);

    expect(JSON.stringify(forward.result())).toBe(JSON.stringify(backward.result()));
    expect(forward.result().lines.map((line) => `${line.kind} ${line.subject}`)).toEqual([
      'cred.env TOKEN',
      'exec curl',
      'net a.example',
      'net b.example',
    ]);
    expect(forward.result().lines[2]?.where.map((place) => place.file)).toEqual(['a.md', 'z.md']);
  });

  it('writes out a character the schema would refuse, in a subject and in a place', () => {
    const findings = new Findings();

    findings.line({ ...base, subject: 'evil‮host', file: 'a\u001bb' });
    const { lines } = findings.result();

    expect(PassportLineSchema.safeParse(lines[0]).success).toBe(true);
    expect(lines[0]?.subject).toContain('\\u202e');
  });

  it('gives a subject that is nothing but blanks a name rather than an empty one', () => {
    const findings = new Findings();

    findings.line({ ...base, subject: '   \n\t ' });

    expect(findings.result().lines[0]?.subject.length).toBeGreaterThan(0);
  });

  it('lists a few places for a finding and says that there are more', () => {
    const findings = new Findings();

    for (let i = 0; i < MAX_PLACES + 10; i += 1) {
      findings.line({ ...base, file: `f${String(i).padStart(3, '0')}.md`, line: 1 });
    }
    const result = findings.result();

    expect(result.lines[0]?.where).toHaveLength(MAX_PLACES);
    expect(result.lines[0]?.where[0]?.file).toBe('f000.md');
    expect(result.blindSpots.join(' ')).toContain('more places than are listed');
  });

  it('lists at most the number of lines a passport lists, the sensitive ones first, and says so', () => {
    const findings = new Findings();

    for (let i = 0; i < MAX_LINES + 25; i += 1) {
      findings.line({
        ...base,
        subject: `h${String(i).padStart(4, '0')}.example`,
        sensitive: i % 2 === 0,
      });
    }
    const { lines, blindSpots } = findings.result();

    expect(lines).toHaveLength(MAX_LINES);
    expect(lines.filter((line) => line.sensitive)).toHaveLength(Math.ceil((MAX_LINES + 25) / 2));
    expect(blindSpots.join(' ')).toContain('25 more findings were found');
  });
});

describe('Findings: signals', () => {
  it('makes a signal of the passport and a line that says what matched', () => {
    const findings = new Findings();

    findings.signal({
      ruleId: 'process-spawn',
      file: 'lib/run.js',
      line: 7,
      sensitive: true,
      detail: 'child_process',
      detector: 'a signal to look at, not a verdict',
    });
    const result = findings.result();

    expect(result.signals).toEqual([{ ruleId: 'process-spawn', file: 'lib/run.js' }]);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      kind: 'signal',
      subject: 'process-spawn: child_process',
      basis: 'observed',
      sensitive: true,
      where: [{ file: 'lib/run.js', line: 7 }],
    });
  });

  it('says a signal rests on what the artifact declares, when it is told', () => {
    const findings = new Findings();

    findings.signal({
      ruleId: 'non-registry-dependency',
      file: 'package.json',
      line: 3,
      sensitive: true,
      basis: 'declared',
      detector: 'x',
    });

    expect(findings.result().lines[0]?.basis).toBe('declared');
  });

  it('names a signal by its rule alone when there is no detail', () => {
    const findings = new Findings();

    findings.signal({
      ruleId: 'obfuscated',
      file: 'a.js',
      line: null,
      sensitive: true,
      detector: 'x',
    });

    expect(findings.result().lines[0]?.subject).toBe('obfuscated');
  });

  it('lists a rule once for a file, whatever number of places it matched in', () => {
    const findings = new Findings();
    const input = { ruleId: 'dynamic-code', file: 'a.js', sensitive: true, detector: 'x' };

    findings.signal({ ...input, line: 1 });
    findings.signal({ ...input, line: 2 });
    findings.signal({ ...input, line: 3, detail: 'eval' });
    findings.signal({ ...input, file: 'b.js', line: 1 });

    expect(findings.result().signals).toEqual([
      { ruleId: 'dynamic-code', file: 'a.js' },
      { ruleId: 'dynamic-code', file: 'b.js' },
    ]);
  });

  it('puts the signals in a fixed order', () => {
    const findings = new Findings();

    findings.signal({ ruleId: 'z-rule', file: 'a', line: 1, sensitive: false, detector: 'x' });
    findings.signal({ ruleId: 'a-rule', file: 'b', line: 1, sensitive: false, detector: 'x' });
    findings.signal({ ruleId: 'a-rule', file: 'a', line: 1, sensitive: false, detector: 'x' });

    expect(findings.result().signals).toEqual([
      { ruleId: 'a-rule', file: 'a' },
      { ruleId: 'a-rule', file: 'b' },
      { ruleId: 'z-rule', file: 'a' },
    ]);
  });
});

describe('Findings: blind spots', () => {
  it('lists what it was told, sorted and once', () => {
    const findings = new Findings();

    findings.blindSpot('b spot');
    findings.blindSpot('a spot');
    findings.blindSpot('b spot');

    const spots = findings.result().blindSpots;

    expect(spots.filter((spot) => spot.endsWith(' spot'))).toEqual(['a spot', 'b spot']);
    expect(spots).toEqual([...spots].sort());
  });

  it('turns a count into words, and says nothing of a count of none', () => {
    const findings = new Findings();

    findings.tally('unreadable-text', 3);
    findings.tally('partial-file');
    findings.tally('gitlink', 0);
    const { blindSpots } = findings.result();

    expect(blindSpots.some((spot) => spot.startsWith('3 files looked binary'))).toBe(true);
    expect(blindSpots.some((spot) => spot.startsWith('1 file was not read in full'))).toBe(true);
    expect(blindSpots.some((spot) => spot.includes('nested repositor'))).toBe(false);
  });

  it('names no file of the artifact', () => {
    const findings = new Findings();

    findings.tally('obfuscated-file', 2);

    expect(findings.result().blindSpots.join('')).not.toMatch(/\.js|\.py|SKILL/);
  });

  it('always says that nothing was run and that run-time behaviour was not looked at', () => {
    const { blindSpots } = new Findings().result();

    expect(blindSpots.some((spot) => spot.startsWith('nothing was run'))).toBe(true);
    expect(blindSpots.some((spot) => spot.includes('at run time'))).toBe(true);
    expect(blindSpots.some((spot) => spot.includes('other than JavaScript'))).toBe(true);
  });

  it('refuses to add a blind spot with nothing in it', () => {
    const findings = new Findings();

    findings.blindSpot('  ');

    expect(findings.result().blindSpots.every((spot) => spot.trim() !== '')).toBe(true);
  });
});
