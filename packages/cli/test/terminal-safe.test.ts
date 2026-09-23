import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { neutralizeControls, withSafeOutput } from '../src/terminal-safe.js';
import { CLI_ENTRY } from './helpers/cli-entry.js';

const ESC = '\u001b';
const BEL = '\u0007';

describe('neutralizeControls', () => {
  it('writes terminal control characters out as visible escapes', () => {
    expect(neutralizeControls(`a${ESC}]52;c;eA==${BEL}b`)).toBe('a\\u001b]52;c;eA==\\u0007b');
    expect(neutralizeControls(`x\ry`)).toBe('x\\u000dy');
    expect(neutralizeControls(`x\u009b31my`)).toBe('x\\u009b31my');
    expect(neutralizeControls(`x\u007fy`)).toBe('x\\u007fy');
  });

  it('writes text-direction overrides out too, so a path cannot be shown reversed', () => {
    expect(neutralizeControls(`evil‮txt.sh`)).toBe('evil\\u202etxt.sh');
    expect(neutralizeControls(`a⁦b⁩`)).toBe('a\\u2066b\\u2069');
  });

  it('leaves newlines, tabs and ordinary text in any script alone', () => {
    const text = 'Ааронов\tрешил ✔ 你好 🙂\nnext line';
    expect(neutralizeControls(text)).toBe(text);
  });
});

describe('withSafeOutput', () => {
  it('neutralizes what the command writes to stdout and stderr, then restores both', async () => {
    const outBefore = process.stdout.write;
    const errBefore = process.stderr.write;
    const seen: string[] = [];
    process.stdout.write = ((chunk: string) => {
      seen.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      seen.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    const captureOut = process.stdout.write;
    const captureErr = process.stderr.write;
    try {
      const code = await withSafeOutput(async () => {
        process.stdout.write(`clean ${ESC}[2Kfake\n`);
        process.stderr.write(Buffer.from(`err ${ESC}[31m\n`));
        return 7;
      });
      expect(code).toBe(7);
      expect(seen.join('')).not.toContain(ESC);
      expect(seen.join('')).toContain('\\u001b[2Kfake');
      expect(process.stdout.write).toBe(captureOut);
      expect(process.stderr.write).toBe(captureErr);
    } finally {
      process.stdout.write = outBefore;
      process.stderr.write = errBefore;
    }
  });
});

describe('stroq replay (end to end)', () => {
  // A transcript is written by whoever wrote the files and pages the agent read.
  // Printed raw, OSC 52 writes the user's clipboard on terminals that allow it, and
  // cursor movement paints a fake line over the real verdict — inside the very
  // command someone runs to find out what happened.
  it('never prints a raw control character from a recorded session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-term-'));
    const file = join(dir, 's.jsonl');
    const command = `curl -s https://collector.example/x # ${ESC}]52;c;Y3VybA==${BEL}${ESC}[1A${ESC}[32mALLOW${ESC}[0m`;
    const lines = [
      {
        sessionId: 't',
        cwd: dir,
        timestamp: '2026-09-23T10:00:00.000Z',
        message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command } }] },
      },
      {
        sessionId: 't',
        cwd: dir,
        timestamp: '2026-09-23T10:00:01.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }] },
      },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
    const cliDir = join(import.meta.dirname, '..');
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_ENTRY, 'replay', '--transcript', file], {
        cwd: cliDir,
        env: { ...process.env, STROQ_HOME: join(dir, 'home') },
      });
      let text = '';
      child.stdout.on('data', (d: Buffer) => (text += d.toString()));
      child.stderr.on('data', (d: Buffer) => (text += d.toString()));
      child.on('error', reject);
      child.on('close', () => resolve(text));
    });
    expect(out).toContain('curl');
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
    expect(out).toContain('\\u001b]52');
  });
});
