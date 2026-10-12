// The part of the fake `claude` that behaves like a host with a hook: it reads the argv it was started with,
// runs the hook command of the settings it was given (the real `stroq hook claude-code`, in the tests that
// use this), and obeys what the hook says. It is a stand-in: it shows that a driver, a hook and `verifyHost`
// work together, and nothing about what the real Claude Code does with a hook.
//
// It is a source text because it runs inside the fake executable (`fake-claude.ts` writes it to a file next
// to the program), as a module of its own.
export const EMULATOR_SOURCE = `
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

/**
 * options: apiKeySource (what init says), ignoreDeny (runs a command the hook denied), protectGit (the
 * host's own permission step stops a command that writes below .git, whatever the hook said),
 * pauseAfterInitMs (it takes this long to get going after its first message, as a host waiting on a model
 * does).
 */
export function emulate(args, options) {
  const get = (flag) => args[args.indexOf(flag) + 1];
  const prompt = get('-p');
  const command = /\`\`\`\\n([\\s\\S]*?)\\n\`\`\`/.exec(prompt)?.[1] ?? '';
  const settings = JSON.parse(get('--settings'));
  const hook = settings.hooks.PreToolUse[0].hooks[0].command;
  const cwd = process.cwd();
  const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');

  say({
    type: 'system',
    subtype: 'init',
    cwd: realpathSync(cwd),
    session_id: get('--session-id'),
    tools: ['Bash'],
    model: 'claude-haiku-4-5-20251001',
    permissionMode: get('--permission-mode'),
    apiKeySource: options.apiKeySource ?? 'none',
    claude_code_version: '2.1.271',
  });
  say({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: false } });
  if (options.pauseAfterInitMs)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.pauseAfterInitMs);
  say({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command } }] },
  });

  const asked = spawnSync('/bin/sh', ['-c', hook], {
    input: JSON.stringify({
      session_id: get('--session-id'),
      cwd,
      permission_mode: get('--permission-mode'),
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 'toolu_1',
    }),
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: 30000,
  });
  let verdict = {};
  try {
    verdict = JSON.parse(asked.stdout || '{}').hookSpecificOutput ?? {};
  } catch {
    verdict = {};
  }
  let blockedBy = null;
  if (['deny', 'ask'].includes(verdict.permissionDecision) && !options.ignoreDeny)
    blockedBy = verdict.permissionDecisionReason ?? 'denied';
  if (blockedBy === null && options.protectGit && command.includes('/.git/'))
    blockedBy = 'This Bash command contains multiple operations. The following parts require approval: ' + command;

  let content = '(Bash completed with no output)';
  if (blockedBy === null) {
    const ran = spawnSync('/bin/sh', ['-c', command], { cwd, env: process.env, encoding: 'utf8', timeout: 30000 });
    content = (ran.stdout + ran.stderr).trim() || content;
  }
  say({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: blockedBy ?? content, is_error: blockedBy !== null }],
    },
  });
  const reply = blockedBy === null ? 'DONE' : 'BLOCKED';
  say({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  say({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: reply,
    modelUsage: { 'claude-haiku-4-5-20251001': { provider: 'firstParty' } },
  });
}
`;
