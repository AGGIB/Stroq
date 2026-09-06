import { describe, expect, it } from 'vitest';
import {
  openclawAllowOutput,
  openclawBadPhaseOutput,
  openclawBlockOutput,
  openclawDecisionOutput,
  openclawPostErrorOutput,
  openclawResultText,
  openclawScanOutput,
  openclawToolInput,
  renderDecision,
} from '../../src/adapters/openclaw.js';

const call = (toolName: string, params?: unknown) => openclawToolInput({ toolName, params });
const body = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

const PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new.ts',
  '+export const a = 1;',
  '*** Delete File: .openclaw/openclaw.json',
  '*** End Patch',
].join('\n');

describe('openclawToolInput', () => {
  it('normalises the shell input, whatever shape it arrived in', () => {
    expect(call('exec', { command: 'ls -la', timeout: 30 })).toEqual({ command: 'ls -la' });
    expect(call('exec', '{"command":"ls -la"}')).toEqual({ command: 'ls -la' });
    expect(call('exec', 'ls -la')).toEqual({ command: 'ls -la' });
    // `<shell> -c` argv classifies the script alone; any other argv is POSIX-quoted,
    // so an argument is never re-read as a command of its own (Codex's rules, reused).
    expect(call('exec', { command: ['bash', '-lc', 'ls'] })).toEqual({ command: 'ls' });
    expect(call('exec', { command: ['git', 'commit', '-m', 'rm -rf /'] })).toEqual({
      command: "git commit -m 'rm -rf /'",
    });
    // `cwd` never reaches the engine as part of the action: it is where the command
    // runs, not part of what it does, and `summarizeInput` would rather name the file.
    expect(call('exec', { command: 'ls', cwd: '/tmp' })).toEqual({ command: 'ls' });
    expect(call('exec')).toEqual({ command: '' });
  });

  it("renames OpenClaw's `path` to the `file_path` every rule reads", () => {
    expect(call('write', { path: 'src/new.ts', content: 'x' })).toEqual({
      content: 'x',
      file_path: 'src/new.ts',
    });
    expect(call('edit', { path: 'src/old.ts', old_string: 'a', new_string: 'b' })).toEqual({
      old_string: 'a',
      new_string: 'b',
      file_path: 'src/old.ts',
    });
    expect(call('read', { path: '.env' })).toEqual({ file_path: '.env' });
    // An agent that already spells it `file_path`, and a bare string, both work.
    expect(call('write', { file_path: 'src/a.ts' })).toEqual({ file_path: 'src/a.ts' });
    expect(call('write', 'src/a.ts')).toEqual({ raw: 'src/a.ts', file_path: 'src/a.ts' });
    expect(call('write', {})).toEqual({ file_path: '' });
    // Two spellings that disagree are BOTH judged; `preInputs` fans out over the list.
    expect(call('write', { path: 'safe.txt', file_path: '.openclaw/openclaw.json' })).toEqual({
      file_path: 'safe.txt',
      file_paths: ['safe.txt', '.openclaw/openclaw.json'],
    });
  });

  it('exposes the first patched path plus the whole list', () => {
    expect(call('apply_patch', { input: PATCH })).toEqual({
      file_path: 'src/new.ts',
      file_paths: ['src/new.ts', '.openclaw/openclaw.json'],
    });
    for (const key of ['command', 'patch'])
      expect(call('apply_patch', { [key]: PATCH })['file_path'], key).toBe('src/new.ts');
    expect(call('apply_patch', { command: 'no headers' })).toEqual({
      file_path: '',
      file_paths: [],
    });
  });

  it('guarantees web_fetch a string url without losing its other arguments', () => {
    // Only `url` and `prompt` feed the secret guard today: core scans those two
    // fields for WebFetch, not the whole record. The record is kept whole here
    // anyway, so a value dropped from the mapping could never be caught leaving
    // once the guard's coverage widens.
    expect(call('web_fetch', { url: 'https://x.example/a', prompt: 'summarise' })).toEqual({
      url: 'https://x.example/a',
      prompt: 'summarise',
    });
    expect(call('web_fetch', 'https://x.example/a')).toEqual({
      raw: 'https://x.example/a',
      url: 'https://x.example/a',
    });
    expect(call('web_fetch', { url: 'https://x.example/a', href: 'https://y.example/b' })).toEqual({
      url: 'https://x.example/a',
      href: 'https://y.example/b',
      urls: ['https://x.example/a', 'https://y.example/b'],
    });
    // A non-string `url` is NOT quietly mapped to `''` and allowed: it yields no
    // candidate, and the adapter denies the call as `openclaw-unreadable-input`
    // (asserted end to end in openclaw-shapes.test.ts). An EMPTY `params` is a
    // different thing — nothing to act on — and keeps running through the engine.
    expect(call('web_fetch', {})).toEqual({ url: '' });
  });

  it('keeps MCP and pass-through arguments visible to the secret guard', () => {
    expect(call('message', { channel: 'ops', text: 'hi' })).toEqual({ channel: 'ops', text: 'hi' });
    expect(call('message', '{"text":"hi"}')).toEqual({ text: 'hi' });
    expect(call('message', 'TOKEN=abcdefghijkl')).toEqual({ raw: 'TOKEN=abcdefghijkl' });
    expect(call('browser', ['a', 'b'])).toEqual({ raw: '["a","b"]' });
    expect(call('message', 7)).toEqual({ raw: '7' });
    expect(call('message')).toEqual({});
    expect(call('web_search', { query: 'stroq' })).toEqual({ query: 'stroq' });
    expect(call('ask_user', { question: 'ok?' })).toEqual({ question: 'ok?' });
  });
});

describe('openclawResultText', () => {
  it('reads every result shape, then appends the error text', () => {
    expect(openclawResultText('plain string')).toBe('plain string');
    expect(openclawResultText({ text: 'content block' })).toBe('content block');
    expect(openclawResultText({ content: [{ type: 'text', text: 'blocks' }] })).toBe('blocks');
    expect(openclawResultText({ output: 'unified' })).toBe('unified');
    // An empty `output` must not shadow the streams that carry the real result.
    expect(openclawResultText({ output: '', stdout: 'o', stderr: 'e' })).toBe('o\ne');
    expect(openclawResultText(undefined)).toBe('');
    expect(openclawResultText(null)).toBe('');
    // A failed tool's error text is scanned too: a poisoned failure is still poison.
    expect(openclawResultText('ok', 'boom')).toBe('ok\nboom');
    expect(openclawResultText(undefined, { message: 'boom' })).toBe('boom');
    expect(openclawResultText({ output: 'ok' }, { code: 7 })).toBe('ok\n{"code":7}');
    expect(openclawResultText(undefined, null)).toBe('');
  });
});

describe('renderDecision and the raw outputs', () => {
  const secrets = [{ name: 'DB_PASSWORD', source: '.env', canary: false }];

  it('says allow out loud, because the plugin reads a reply rather than a silence', () => {
    expect(renderDecision({ effect: 'allow', ruleId: null, reason: 'ok' }, [], [])).toEqual({
      stdout: '{"decision":"allow"}',
      exitCode: 0,
    });
    expect(openclawAllowOutput()).toEqual({ stdout: '{"decision":"allow"}', exitCode: 0 });
  });

  it('keeps the rule id in its own field and the evidence in the reason', () => {
    const out = renderDecision(
      {
        effect: 'deny',
        ruleId: 'deny-secret-egress',
        reason: 'Arguments contain the value of a known secret; outbound use is blocked',
      },
      [],
      secrets,
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBeUndefined();
    const fields = body(out.stdout);
    expect(fields['decision']).toBe('deny');
    expect(fields['ruleId']).toBe('deny-secret-egress');
    // The sentence the user sees is composed by the plugin; the CLI ships the parts.
    expect(String(fields['reason'])).toMatch(
      /^Arguments contain the value of a known secret; outbound use is blocked Evidence: /,
    );
    expect(String(fields['reason'])).toContain('DB_PASSWORD');
    expect(String(fields['reason'])).toContain('.env');
    expect(out.stdout).not.toContain('Stroq blocked this action');
  });

  it('asks for real, because OpenClaw can prompt', () => {
    expect(
      body(
        renderDecision(
          {
            effect: 'ask',
            ruleId: 'ask-destructive',
            reason: 'Destructive command requires confirmation',
          },
          [],
          [],
        ).stdout,
      ),
    ).toEqual({
      decision: 'ask',
      ruleId: 'ask-destructive',
      reason: 'Destructive command requires confirmation',
    });
  });

  it('omits a rule id it does not have rather than printing null', () => {
    expect(openclawDecisionOutput('deny', null, 'no rule')).toEqual({
      stdout: '{"decision":"deny","reason":"no rule"}',
      exitCode: 0,
    });
  });

  it('separates the scan answers, the post error and the exit-2 block', () => {
    expect(openclawScanOutput(false, 'clean', null)).toEqual({
      stdout: '{"scanned":false}',
      exitCode: 0,
    });
    expect(openclawScanOutput(true, 'clean', null)).toEqual({
      stdout: '{"scanned":true,"verdict":"clean"}',
      exitCode: 0,
    });
    expect(openclawScanOutput(true, 'suspect', 'careful')).toEqual({
      stdout: '{"scanned":true,"verdict":"suspect","warning":"careful"}',
      exitCode: 0,
    });
    expect(openclawPostErrorOutput('boom')).toEqual({
      stdout: '{"scanned":false,"error":"boom"}',
      exitCode: 0,
    });
    expect(openclawBlockOutput('boom')).toEqual({ stdout: '', stderr: 'boom', exitCode: 2 });
    const badPhase = openclawBadPhaseOutput('before_tool_call');
    expect(badPhase.exitCode).toBe(2);
    expect(badPhase.stdout).toBe('');
    expect(String(badPhase.stderr)).toContain('needs a phase argument');
    expect(String(badPhase.stderr)).toContain('before_tool_call');
  });
});
