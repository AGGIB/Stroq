import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as harden from '../../src/harden/index.js';
import { hardenManifestFileIn } from '../../src/paths.js';
import { engine } from './engine-setup.js';
import { removeTempDirs } from './helpers.js';
import { signedText } from './manifest-fixtures.js';

afterEach(removeTempDirs);

describe('exact strict manifest snapshots', () => {
  it.each([
    '{"version":1,"version":1,"files":{}}',
    '{"version":1,"files":{},"fi\\u006ces":{}}',
    '{"version":1.0000000000000001,"files":{}}',
    '{"version":1,"files":{},"unknown":-0}',
  ])('refuses ambiguous/lossy manifest bytes before using any record', (text) => {
    const e = engine();
    const file = hardenManifestFileIn(e.env.home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, { mode: 0o600 });
    expect(() => harden.readManifest(e.env)).toThrow();
    expect(() => harden.readManifestSnapshot(e.env)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('returns the exact bounded raw bytes and identity without normalizing their layout', () => {
    const e = engine();
    const file = hardenManifestFileIn(e.env.home);
    // Signed by this home, then laid out as Stroq never writes it: the tag covers what it says.
    const { mac } = JSON.parse(signedText(e.home, {})) as { mac: string };
    const bytes = Buffer.from(
      `{\r\n\t"version": 2,\r\n\t"files": {},\r\n\t"mac": "${mac}"\r\n}\r\n`,
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    chmodSync(file, 0o600);
    const snapshot = harden.readManifestSnapshot(e.env);
    expect(snapshot.bytes).toEqual(bytes);
    expect(snapshot.sha256).toBe(harden.sha256Text(bytes.toString('utf8')));
    expect(snapshot.identity?.ino).toMatch(/^\d+$/);
    expect(snapshot.identity?.size).toBe(bytes.length);
    expect(snapshot.manifest).toEqual({ version: 2, files: {} });
  });

  it('does not reflect a private manifest path or value through a schema error', () => {
    const e = engine();
    const file = hardenManifestFileIn(e.env.home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        files: {
          '/fixture-private-path-sentinel': [{ unsafe: 'fixture-private-value-sentinel' }],
        },
      }),
      { mode: 0o600 },
    );
    let thrown: unknown;
    try {
      harden.readManifestSnapshot(e.env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'manifest-invalid' });
    expect(String(thrown)).not.toContain('fixture-private-path-sentinel');
    expect(String(thrown)).not.toContain('fixture-private-value-sentinel');
  });
});
