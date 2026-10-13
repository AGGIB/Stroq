import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codexArgv } from '../../../src/live/drivers/codex-argv.js';
import { CODEX_LOGIN_STATUS } from '../../../src/live/drivers/codex.js';
import { leaksIn, FIXTURE_NONCE, FIXTURE_PROJECT } from './clean-fixture.js';
import { probe } from '../probe-helpers.js';

const root = fileURLToPath(new URL('../../fixtures/hosts/codex/', import.meta.url));
const files = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.jsonl?$/.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name));
const read = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, '0.162.1', name), 'utf8'));

describe('recorded Codex conformance fixtures', () => {
  it.each(files.map((file) => [relative(root, file), file]))(
    '%s contains no machine data',
    (_name, file) => {
      expect(leaksIn(readFileSync(file!, 'utf8'))).toEqual([]);
    },
  );
  it.each(['allow.real', 'deny.real', 'deny.control'])(
    '%s reproduces the recorded invocation',
    (name) => {
      const argv = read(`${name}.invocation.json`)['argv'] as string[];
      const hook = argv.find((arg) => arg.startsWith('hooks.PreToolUse='))!;
      const command = JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(hook)![1]!) as string;
      const p = probe(name.startsWith('allow') ? 'allow' : 'deny', FIXTURE_NONCE, FIXTURE_PROJECT);
      expect(codexArgv(p, command)).toEqual(argv);
    },
  );
  it('records the exact login status required by the driver', () => {
    const login = read('login.json');
    expect(login['exitCode']).toBe(0);
    expect(`${login['stdout']}${login['stderr']}`.trim()).toBe(CODEX_LOGIN_STATUS);
  });
});
