import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuditLog,
  FileKeyStore,
  digestOf,
  verifyTaskAccessRequest,
  parseTaskAccessReview,
} from '@stroq/core';
import { runTask } from '../../src/commands/task.js';
import { taskHook } from '../../src/task/broker.js';
import { CLI_ENTRY } from '../helpers/cli-entry.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the task parent signs refusal evidence without putting its key in the child runtime', () => {
  it('passes the existing key through runTask → launchTask → createEngineAt and records a real broker refusal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stroq-task-access-'));
    roots.push(root);
    const home = join(root, 'data');
    const cwd = join(root, 'project');
    const userHome = join(root, 'user');
    mkdirSync(home);
    mkdirSync(cwd);
    mkdirSync(userHome);
    vi.stubEnv('HOME', userHome);
    vi.stubEnv('USERPROFILE', userHome);
    vi.stubEnv('STROQ_HOME', home);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    let verified = false;
    const launch = async ({ env }: { env: NodeJS.ProcessEnv }) => {
      const signed = JSON.parse(
        readFileSync(join(home, 'tasks/task-access-fixture/permit.json'), 'utf8'),
      );
      expect(JSON.stringify(env)).not.toMatch(/BEGIN PRIVATE KEY|taskAccessSigner|privateKey/);
      expect(existsSync(join(env['HOME']!, '.stroq/keys/permit.key'))).toBe(false);
      const output = await taskHook(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          session_id: signed.body.sessionId,
          tool_use_id: 'refusal-source',
          tool_name: 'Read',
          tool_input: { file_path: join(root, 'outside.txt') },
          cwd,
        }),
        env,
      );
      expect(output.stdout).toContain('deny');
      const row = (await new AuditLog(join(home, 'audit.jsonl')).readAll()).at(-1)!;
      const publicKey = new FileKeyStore({ home }).readPublicKey();
      if (publicKey.kind !== 'ok') throw new Error('missing fixture public key');
      const request = row.approvalRequest!;
      expect(parseTaskAccessReview(row.approvalReview!)?.kind).toBe('read-target');
      expect(
        verifyTaskAccessRequest(request, publicKey.key, {
          ...request.body,
          now: new Date(),
          permitExpiresAt: signed.body.expiresAt,
          permitBodySha256: digestOf(signed.body),
          reviewSha256: hash(row.approvalReview!),
          sessionSha256: hash(signed.body.sessionId),
          callIdSha256: hash('refusal-source'),
        }).ok,
      ).toBe(true);
      verified = true;
      return 0;
    };
    expect(
      await runTask(['--hook-only', '--', 'fixture only'], cwd, {
        home,
        confirm: async () => true,
        taskId: () => 'task-access-fixture',
        launch,
        claude: process.execPath,
        managed: () => false,
        version: () => '2.1.248',
        entry: CLI_ENTRY,
        env: {},
      }),
    ).toBe(0);
    expect(verified).toBe(true);
    expect(
      JSON.parse(readFileSync(join(home, 'tasks/task-access-fixture/receipt.json'), 'utf8'))
        .calls[0],
    ).toMatchObject({ decision: { effect: 'deny' }, status: 'unconfirmed' });
  });
});
