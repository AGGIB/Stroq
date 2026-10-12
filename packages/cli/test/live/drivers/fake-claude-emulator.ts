// The part of the fake `claude` that behaves like a host with a hook: it reads the argv it was started with,
// runs the hook command of the settings it was given (the real `stroq hook claude-code`, in the tests that
// use this), and obeys what the hook says. It is a stand-in: it shows that a driver, a hook and `verifyHost`
// work together, and nothing about what the real Claude Code does with a hook.
//
// It does two things. `emulate` plays a host that thinks: it issues the command it was asked to run, asks the
// hook, runs the command unless it is stopped, and prints a stream of its own. `replay` plays back a stream a
// real Claude Code printed (a cleaned fixture, `test/fixtures/hosts/claude-code/README.md`) and still asks the
// real hook about the call, so that the audit log and the files are the ones this request made.
//
// It is a source text because it runs inside the fake executable (`fake-claude.ts` writes it to a file next
// to the program), as a module of its own.
export const EMULATOR_SOURCE = `
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const flagValue = (args, flag) => args[args.indexOf(flag) + 1];
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');

/** The command the model is asked to run: the text between the two fences of the prompt. */
const commandOf = (args) => /\`\`\`\\n([\\s\\S]*?)\\n\`\`\`/.exec(flagValue(args, '-p'))?.[1] ?? '';

/** The hook of the settings, run with the event of a call; what it decided, or nothing. */
function askHook(args, command, toolUseId) {
  const hook = JSON.parse(flagValue(args, '--settings')).hooks.PreToolUse[0].hooks[0].command;
  const cwd = process.cwd();
  const asked = spawnSync('/bin/sh', ['-c', hook], {
    input: JSON.stringify({
      session_id: flagValue(args, '--session-id'),
      cwd,
      permission_mode: flagValue(args, '--permission-mode'),
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: toolUseId,
    }),
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: 30000,
  });
  try {
    return JSON.parse(asked.stdout || '{}').hookSpecificOutput ?? {};
  } catch {
    return {};
  }
}

/**
 * The host's own permission step, as measured on Claude Code 2.1.271: a command that no rule of
 * --allowedTools covers is stopped with these words, whatever the hook said. Every part of a command that
 * is joined with ; && || or | has to be covered. \`alwaysAsk\` names words the step asks about even when a rule
 * allows them, for a host that does not honour a rule.
 */
function askedAbout(command, args, options) {
  if (!options.permissionStep) return null;
  const rules = args
    .slice(args.indexOf('--allowedTools') + 1)
    .map((rule) => /^Bash\\((.*):\\*\\)$/.exec(rule)?.[1])
    .filter(Boolean);
  const starts = (part, word) => part === word || part.startsWith(word + ' ');
  const parts = command.split(/;|&&|\\|\\||\\|/).map((part) => part.trim()).filter(Boolean);
  const covered = parts.every((part) => rules.some((rule) => starts(part, rule)));
  const asks = parts.some((part) => (options.alwaysAsk ?? []).some((word) => starts(part, word)));
  return covered && !asks ? null : 'This command requires approval';
}

function runCommand(command) {
  const ran = spawnSync('/bin/sh', ['-c', command], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 30000,
  });
  return (ran.stdout + ran.stderr).trim() || '(Bash completed with no output)';
}

/**
 * options: apiKeySource (what init says), ignoreDeny (runs a command the hook denied), permissionStep (the
 * host's own permission step, with alwaysAsk), pauseAfterInitMs (it takes this long to get going after its
 * first message, as a host waiting on a model does).
 */
export function emulate(args, options) {
  const command = commandOf(args);
  say({
    type: 'system',
    subtype: 'init',
    cwd: realpathSync(process.cwd()),
    session_id: flagValue(args, '--session-id'),
    tools: ['Bash'],
    model: 'claude-haiku-4-5-20251001',
    permissionMode: flagValue(args, '--permission-mode'),
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

  const verdict = askHook(args, command, 'toolu_1');
  let blockedBy = null;
  if (['deny', 'ask'].includes(verdict.permissionDecision) && !options.ignoreDeny)
    blockedBy = verdict.permissionDecisionReason ?? 'denied';
  blockedBy = blockedBy ?? askedAbout(command, args, options);

  const content = blockedBy === null ? runCommand(command) : blockedBy;
  say({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content, is_error: blockedBy !== null }],
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

const isCall = (event) =>
  event.type === 'assistant' && (event.message?.content ?? []).some((part) => part.type === 'tool_use');
const isStopped = (event) =>
  event.type === 'user' &&
  (event.message?.content ?? []).some((part) => part.type === 'tool_result' && part.is_error === true);

/**
 * options: lines (the lines of a cleaned stream) and fixed (the project, the session, the nonce and the
 * made-up key the cleaner put in it). The fixed values are swapped for the ones of this request before a
 * line is printed: the project as the command names it everywhere but in the first message, where a host
 * says the real path of the directory it runs in. When the stream has the model make a call, the real hook is
 * asked about it, and the command is run if the stream shows it was not stopped, so that the files are those
 * of a host that ran it.
 */
export function replay(args, options) {
  const command = commandOf(args);
  const found = (pattern) => pattern.exec(command)?.[0];
  const named = /(\\S+?)\\/stroq-live-(?:allow|git-config|egress)\\.txt/.exec(command)?.[1];
  const there = realpathSync(process.cwd());
  const escaped = (text) => JSON.stringify(text).slice(1, -1);
  const swapped = (line, project) =>
    [
      [options.fixed.project, project],
      [options.fixed.session, flagValue(args, '--session-id')],
      [options.fixed.nonce, found(/stroq-live-[0-9a-f]{16}/)],
      [options.fixed.fake, found(/stroq_attack_[0-9a-f]{24}/)],
    ]
      .filter(([, to]) => to !== undefined)
      .reduce((text, [from, to]) => text.split(escaped(from)).join(escaped(to)), line);

  const stopped = options.lines.some((line) => isStopped(JSON.parse(line)));
  for (const line of options.lines) {
    const event = JSON.parse(line);
    const isInit = event.type === 'system' && event.subtype === 'init';
    process.stdout.write(swapped(line, isInit ? there : named ?? there) + '\\n');
    if (!isCall(event)) continue;
    askHook(args, command, 'toolu_replayed');
    if (!stopped) runCommand(command);
  }
}
`;
