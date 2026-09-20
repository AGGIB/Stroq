import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';

/**
 * The proxy is spawned BY the MCP client, so its own environment is whatever the
 * client had — for every client but Claude Desktop, the user's whole shell. These
 * go through the real `spawn` and read back the environment the server process was
 * actually handed, which is the only way to prove a variable never reached it.
 */

const envReportServer = join(import.meta.dirname, 'env-report-server.mjs');
/** Exported by the user's shell and nothing to do with this server. */
const AMBIENT_VAR = 'STROQ_TEST_AMBIENT_SECRET';
/** Merged in by the client from the config entry's own `env` block. */
const DECLARED_VAR = 'STROQ_TEST_DECLARED_TOKEN';

let cwd: string;
let reports = 0;

beforeEach(() => {
  process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-mcp-env-'));
  cwd = mkdtempSync(join(tmpdir(), 'stroq-mcp-env-cwd-'));
  // Set the same way the client leaves them, which is the whole problem: from
  // inside the proxy these two are indistinguishable, so only a pass-list recorded
  // at install time can tell them apart.
  process.env[AMBIENT_VAR] = 'aws-secret-value';
  process.env[DECLARED_VAR] = 'declared-token-value';
});

/** The environment the wrapped server was actually started with. */
async function serverEnv(
  passEnv: readonly string[] | null,
): Promise<Record<string, string | undefined>> {
  reports += 1;
  const report = join(cwd, `env-${reports}.json`);
  const code = await runMcpProxy({
    engine: createEngine(),
    sessionId: 'mcp:test',
    server: 'demo',
    cwd,
    passEnv,
    command: process.execPath,
    args: [envReportServer, report],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  expect(code).toBe(0);
  return JSON.parse(readFileSync(report, 'utf8')) as Record<string, string | undefined>;
}

describe('the environment the proxy hands the server it wraps', () => {
  it('carries the variables the wrapper recorded, and leaves the rest behind', async () => {
    const env = await serverEnv([DECLARED_VAR]);
    expect(env[DECLARED_VAR]).toBe('declared-token-value');
    // The server still starts: PATH is infrastructure, not something a config has
    // to declare.
    expect(env['PATH']).toBe(process.env['PATH']);
    expect(env[AMBIENT_VAR]).toBeUndefined();
  }, 15_000);

  it('carries neither when the entry declared no env of its own', async () => {
    const env = await serverEnv([]);
    expect(env[DECLARED_VAR]).toBeUndefined();
    expect(env[AMBIENT_VAR]).toBeUndefined();
    expect(env['PATH']).toBe(process.env['PATH']);
  }, 15_000);

  it('still inherits everything for a wrapper written before --pass-env existed', async () => {
    // The migration path, not the intended state: an installed wrapper that has no
    // recorded pass-list keeps working exactly as it did, and `runMcp` says so on
    // stderr rather than dropping a credential and leaving the user to guess.
    const env = await serverEnv(null);
    expect(env[AMBIENT_VAR]).toBe('aws-secret-value');
    expect(env[DECLARED_VAR]).toBe('declared-token-value');
  }, 15_000);
});
