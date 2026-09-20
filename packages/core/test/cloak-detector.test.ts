import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCloakDetector } from '../src/cloak/detector.js';
import { FileSecretIndex } from '../src/secrets/index.js';

const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

function fixture() {
  const stroqHome = mkdtempSync(join(tmpdir(), 'stroq-cloakdet-'));
  const home = mkdtempSync(join(tmpdir(), 'stroq-cloakdet-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'stroq-cloakdet-cwd-'));
  mkdirSync(join(home, '.aws'));
  writeFileSync(
    join(home, '.aws', 'credentials'),
    `[default]\naws_secret_access_key = ${AWS_SECRET}\n`,
  );
  const secrets = new FileSecretIndex(join(stroqHome, 'secrets.json'), home, {});
  return { cwd, detect: createCloakDetector({ secrets, cwd }) };
}

describe('createCloakDetector', () => {
  it('finds patterns with no secret index at all', async () => {
    const detect = createCloakDetector({ cwd: '.' });
    const spans = await detect.detect('write to a@b.example');
    expect(spans.map((s) => s.kind)).toEqual(['email']);
  });

  it('finds a known secret value in free text and marks it non-restorable', async () => {
    const { detect } = fixture();
    const text = `the config says key=${AWS_SECRET} today`;
    const spans = await detect.detect(text);
    const secret = spans.find((s) => s.kind === 'secret');
    expect(secret).toBeDefined();
    expect(text.slice(secret!.start, secret!.end)).toBe(AWS_SECRET);
    expect(secret!.restorable).toBe(false);
    expect(secret!.label).toBe('aws_secret_access_key (~/.aws/credentials)');
  });

  it('returns patterns and secrets together, in position order and never overlapping', async () => {
    const { detect } = fixture();
    const text = `a@b.example then ${AWS_SECRET} then c@d.example`;
    const spans = await detect.detect(text);
    expect(spans.map((s) => s.kind)).toEqual(['email', 'secret', 'email']);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
    }
  });

  it('does not scan past the documented bound', async () => {
    const { detect } = fixture();
    const spans = await detect.detect('x'.repeat(3 * 1024 * 1024));
    expect(spans).toEqual([]);
  });

  it('reports nothing for text with neither a pattern nor a known value', async () => {
    const { detect } = fixture();
    expect(await detect.detect('an ordinary sentence about widgets')).toEqual([]);
  });
});
