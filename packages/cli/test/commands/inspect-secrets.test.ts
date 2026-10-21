import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInspect } from '../../src/commands/inspect.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { commitFiles, scratchRepo } from '../helpers/scratch-repo.js';

/**
 * Nothing a repository's configs hold in an env, a header, an argument or an address is written
 * out, in any format: the key, a digest under a key made for the run and a length are. An address
 * loses its user, its password and its query, and an Authorization or Bearer text is removed. The
 * marker is built while the test runs, so no secret-shaped text sits in the source.
 */

const SECRET = ['FAKE', 'SECRET', 'zz', String(9999 * 7)].join('_');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const json = (value: object): string => JSON.stringify(value, null, 2);

/** A config in each place that can carry a secret. */
const FILES: Readonly<Record<string, string>> = {
  '.claude/settings.json': json({
    env: {
      TOKEN: SECRET,
      ANTHROPIC_BASE_URL: `https://user:${SECRET}@proxy.example.invalid/v1?k=${SECRET}`,
    },
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `curl -H "Authorization: Bearer ${SECRET}" https://x.example.invalid/?t=${SECRET}`,
              env: { T: SECRET },
            },
          ],
        },
      ],
    },
  }),
  '.mcp.json': json({
    mcpServers: {
      local: { command: 'x', args: ['--key', SECRET], env: { TOKEN: SECRET } },
      remote: {
        type: 'http',
        url: `https://user:${SECRET}@h.example.invalid/mcp?k=${SECRET}`,
        headers: { Authorization: `Bearer ${SECRET}` },
      },
    },
  }),
  '.codex/config.toml': `[shell_environment_policy]\nset = { TOKEN = "${SECRET}" }\n[mcp_servers.s]\ncommand = "x"\nargs = ["--key", "${SECRET}"]\n`,
  '.devcontainer/devcontainer.json': json({
    remoteEnv: { T: SECRET },
    build: { dockerfile: 'Dockerfile', args: { T: SECRET } },
  }),
  '.devcontainer/Dockerfile': 'FROM node\n',
  '.vscode/tasks.json': json({
    version: '2.0.0',
    tasks: [
      {
        label: 't',
        command: 'node x.js',
        options: { env: { T: SECRET } },
        runOptions: { runOn: 'folderOpen' },
      },
    ],
  }),
};

function run(args: readonly string[]): string {
  const lines: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => lines.push(String(chunk)) > 0) as typeof out;
  process.stderr.write = ((chunk: string) => lines.push(String(chunk)) > 0) as typeof err;
  try {
    runInspect(args);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return lines.join('');
}

describe('a secret in a repository config, in every output', () => {
  const FORMATS = ['text', 'json', 'sarif', 'github'] as const;

  it.each(FORMATS)('never writes it in a change, as %s', (format) => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { 'README.md': 'x\n' });
    commitFiles(dir, FILES);
    const output = run([dir, '--changed-from', base, '--format', format]);
    expect(output.length).toBeGreaterThan(100);
    expect(output).not.toContain(SECRET);
  });

  // Nor a hash of it: a fingerprint of a public repository's code scanning would let anyone test
  // guesses at a weak secret. No SARIF string holds a digest of any text that holds the secret.
  it('never writes a hash of it into SARIF', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { 'README.md': 'x\n' });
    commitFiles(dir, FILES);
    const output = run([dir, '--changed-from', base, '--format', 'sarif']);
    const raw = agentChanges(dir, base)
      .hits.filter((h) => h.value.includes(SECRET))
      .flatMap((h) => [h.value, [h.kind, h.file, h.name, h.value].join('\u0000')]);
    expect(raw.length).toBeGreaterThan(5);
    const digests = [SECRET, ...raw].map((t) => createHash('sha256').update(t).digest('hex'));
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v);
      else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk);
    };
    walk(JSON.parse(output));
    for (const text of strings) {
      expect(text).not.toContain(SECRET);
      for (const d of digests) {
        expect(text).not.toContain(d.slice(0, 32));
        expect(d).not.toContain(text.length >= 16 ? text : '\u0000');
      }
    }
  });

  it.each(FORMATS)('never writes it from the folder on disk, as %s', (format) => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-secrets-'));
    dirs.push(dir);
    for (const [path, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const output = run([dir, '--format', format]);
    expect(output.length).toBeGreaterThan(100);
    expect(output).not.toContain(SECRET);
  });
});
