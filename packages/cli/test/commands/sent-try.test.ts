import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSent } from '../../src/commands/sent.js';
import { secretsFile } from '../../src/paths.js';

let home = '';
let cwd = '';
let stroqHome = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-sent-try-test-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'stroq-sent-try-test-cwd-'));
  stroqHome = mkdtempSync(join(tmpdir(), 'stroq-sent-try-test-stroq-'));

  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['STROQ_HOME'] = stroqHome;
  process.env['REAL_SECRET_KEY_FOR_TEST'] = 'super-secret-real-env-token-12345';

  // Plant real credentials in fake HOME and project CWD
  mkdirSync(join(home, '.aws'), { recursive: true });
  writeFileSync(
    join(home, '.aws', 'credentials'),
    '[default]\naws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n',
  );
  writeFileSync(join(cwd, '.env'), 'OPENAI_API_KEY=sk-proj-RealKeyThatMustNotBeRead987654321\n');

  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});

afterEach(() => {
  delete process.env['REAL_SECRET_KEY_FOR_TEST'];
  vi.restoreAllMocks();
});

function capture(): {
  stdout: () => string;
  stderr: () => string;
  restore: () => void;
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    outLines.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errLines.push(String(chunk));
    return true;
  });
  return {
    stdout: () => outLines.join(''),
    stderr: () => errLines.join(''),
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe('stroq sent --try', () => {
  it('runs against an isolated synthetic session and touches no real credentials', async () => {
    const io = capture();
    try {
      const exitCode = await runSent(['--try']);
      expect(exitCode).toBe(0);

      const out = io.stdout();
      expect(out).toContain('SAMPLE SESSION (SYNTHETIC)');
      expect(out).toContain('STRIPE_SECRET_KEY');

      // The secret value is never printed
      expect(out).not.toContain('sk_test_51Hx9QfAkeKeyForStroqDemo7Zq3LmN8vB2');

      // Real machine secrets must not be in the output or index
      expect(out).not.toContain('aws_secret_access_key');
      expect(out).not.toContain('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY');
      expect(out).not.toContain('OPENAI_API_KEY');
      expect(out).not.toContain('REAL_SECRET_KEY_FOR_TEST');

      // The real secrets.json in STROQ_HOME was never created
      expect(existsSync(secretsFile())).toBe(false);
    } finally {
      io.restore();
    }
  });

  it('prints guidance pointing to sent --last and init', async () => {
    const io = capture();
    try {
      await runSent(['--try']);
      const out = io.stdout();

      expect(out).toContain('NEXT');
      expect(out).toContain('stroq sent --last');
      expect(out).toContain('stroq init');
    } finally {
      io.restore();
    }
  });

  it('exits 0 by default, and exits 1 with --fail-on-finding', async () => {
    const io = capture();
    try {
      const zero = await runSent(['--try']);
      expect(zero).toBe(0);

      const one = await runSent(['--try', '--fail-on-finding']);
      expect(one).toBe(1);
    } finally {
      io.restore();
    }
  });

  it('removes temporary directories after execution', async () => {
    const io = capture();
    try {
      await runSent(['--try']);
      const leftover = readdirSync(tmpdir()).filter(
        (name) => name.startsWith('stroq-sent-try-') && !name.includes('test'),
      );
      expect(leftover).toEqual([]);
    } finally {
      io.restore();
    }
  });

  it('cleans up temporary directory even if scanning throws', async () => {
    const scanModule = await import('../../src/sent/scan.js');
    const spy = vi
      .spyOn(scanModule, 'scanTranscript')
      .mockRejectedValueOnce(new Error('simulated failure'));
    try {
      await expect(runSent(['--try'])).rejects.toThrow('simulated failure');
      const leftover = readdirSync(tmpdir()).filter(
        (name) => name.startsWith('stroq-sent-try-') && !name.includes('test'),
      );
      expect(leftover).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('emits machine-readable report with --json', async () => {
    const io = capture();
    try {
      const exitCode = await runSent(['--try', '--json']);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(io.stdout());
      expect(parsed.synthetic).toBe(true);
      expect(parsed.sessionId).toBe('sample-session');
      expect(parsed.credentials).toHaveLength(1);
      expect(parsed.credentials[0].name).toBe('STRIPE_SECRET_KEY');
    } finally {
      io.restore();
    }
  });

  it('prints a card with --card', async () => {
    const io = capture();
    try {
      const exitCode = await runSent(['--try', '--card']);
      expect(exitCode).toBe(0);

      const out = io.stdout();
      expect(out).toContain('# Stroq session check');
      expect(out).toContain('Stripe 1');
      expect(out).toMatch(/synthetic/i);
      expect(out).not.toContain('from my machine');
    } finally {
      io.restore();
    }
  });

  it('marks the JSON card as synthetic', async () => {
    const io = capture();
    try {
      expect(await runSent(['--try', '--card', '--json'])).toBe(0);
      expect(JSON.parse(io.stdout())).toMatchObject({ synthetic: true, credentials: 1 });
    } finally {
      io.restore();
    }
  });

  it('keeps the synthetic marker in an exported HTML card', async () => {
    const path = join(cwd, 'sample-card.html');
    const io = capture();
    try {
      expect(await runSent(['--try', '--card', '--html', '--out', path])).toBe(0);
      const html = readFileSync(path, 'utf8');
      expect(html).toMatch(/synthetic/i);
      expect(html).not.toContain('from my machine');
      expect(html).toContain('sent --try');
    } finally {
      io.restore();
    }
  });

  it('refuses conflicting session arguments', async () => {
    const io = capture();
    try {
      const withLast = await runSent(['--try', '--last']);
      expect(withLast).toBe(2);
      expect(io.stderr()).toContain('--try does not take a session, --last, or --transcript');

      const withTranscript = await runSent(['--try', '--transcript', 'foo.jsonl']);
      expect(withTranscript).toBe(2);
      expect(io.stderr()).toContain('--try does not take a session, --last, or --transcript');

      const withPositional = await runSent(['--try', 'session-123']);
      expect(withPositional).toBe(2);
      expect(io.stderr()).toContain('--try does not take a session, --last, or --transcript');
    } finally {
      io.restore();
    }
  });
});
