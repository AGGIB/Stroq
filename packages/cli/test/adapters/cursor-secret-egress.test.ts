import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleCursorHook } from '../../src/adapters/cursor.js';
import { createEngine } from '../../src/engine-factory.js';

const SECRET_VALUE = 'stroq_test_cursor_token_0123456789';

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-cursor-egress-'));
  process.env['STROQ_HOME'] = home;
  project = mkdtempSync(join(tmpdir(), 'stroq-cursor-project-'));
  writeFileSync(join(project, '.env'), `API_TOKEN=${SECRET_VALUE}\n`);
});

const body = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

const addIssueComment = (tool_input: unknown) =>
  handleCursorHook(createEngine(), {
    conversation_id: 'cur-egress',
    hook_event_name: 'beforeMCPExecution',
    workspace_roots: [project],
    cwd: project,
    mcp_server_name: 'github',
    tool_name: 'add_issue_comment',
    tool_input,
  });

describe('handleCursorHook — MCP secret egress end to end', () => {
  it('denies when the secret value is inside a JSON-string tool_input', async () => {
    const out = await addIssueComment(JSON.stringify({ body: `see token ${SECRET_VALUE}` }));
    const json = body(out.stdout);
    expect(json['permission']).toBe('deny');
    expect(String(json['user_message'])).toContain('deny-secret-egress');
    expect(String(json['agent_message'])).toContain('API_TOKEN');
    expect(String(json['agent_message'])).not.toContain(SECRET_VALUE);
  });

  it('denies when the secret value is inside an object tool_input', async () => {
    const out = await addIssueComment({ body: `see token ${SECRET_VALUE}` });
    const json = body(out.stdout);
    expect(json['permission']).toBe('deny');
    expect(String(json['user_message'])).toContain('deny-secret-egress');
  });

  it('prints nothing for a harmless body', async () => {
    expect(await addIssueComment(JSON.stringify({ body: 'looks fine' }))).toEqual({
      stdout: '',
      exitCode: 0,
    });
  });

  it('never writes the secret value to the audit log', async () => {
    await addIssueComment(JSON.stringify({ body: `see token ${SECRET_VALUE}` }));
    const audit = readFileSync(join(home, 'audit.jsonl'), 'utf8');
    expect(audit).not.toContain(SECRET_VALUE);
  });
});
