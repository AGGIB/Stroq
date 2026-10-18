import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRuleOverrides } from '../../../../scripts/lib/rules-pipeline.js';
import { translatePcre } from '../../src/rules/compile.js';
import { loadBundledRules } from '../../src/rules/bundle.js';

/**
 * The patterns that replaced a super-linear one in `rules/atr-overrides.yaml` must match the same
 * strings. Each condition below has a generator for strings of the shape it reads (most of them
 * match) and the original pattern is compared with its replacement on every one, after a few of
 * them have lost or gained a character. The bounds that were added on purpose (a persona name of
 * more than 65 characters, a gap of more than 200 or 300) are outside what is generated.
 */
const ROUNDS = 4_000;
let seed = 987_654;
const rnd = (): number => {
  seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T>(values: readonly T[]): T => values[Math.floor(rnd() * values.length)] as T;
const ws0 = () => pick(['', '', ' ', '  ', '\n', ' \n ', '\t', '\n\n', '\n  ', '   ']);
const ws1 = () => pick([' ', ' ', '  ', '\n', ' \n ', '\t', '\n\n', '\n  ']);
const sp = () => pick([' ', '  ']);
const opt = (s: string) => (rnd() < 0.5 ? s : '');
const gap = (max = 30, nl = true) =>
  Array.from({ length: Math.floor(rnd() * max) }, () =>
    pick(['a', 'b', ' ', '.', ',', '1', nl ? '\n' : 'c']),
  ).join('');
const pre = () => pick(['', '', '\n', 'x\n', '\n\n', ' \n ', 'x', 'a b\n', '\\n']);
const caps = (s: string) => (rnd() < 0.3 ? s.toUpperCase() : rnd() < 0.2 ? s.toLowerCase() : s);
const b64 = (n: number) =>
  Array.from({ length: n }, () => pick([...'ABCDEFabcdef0123456789+/'])).join('');
const T: Record<string, () => string> = {
  'ATR-2026-00139#0': () =>
    caps(
      `${opt(pick(['fyi', 'btw', 'heads up']))}${ws0()}${opt('the' + sp())}${pick(['orchestrator', 'coordinator', 'manager', 'admin', 'boss', 'supervisor', 'lead'])}${sp()}${pick(['wants', 'want', 'said', 'told', 'instructed', 'requires', 'require', 'decided'])}${gap(40, false)}${pick(['append', 'send', 'redirect', 'forward', 'pipe', 'write', 'log'])}${sp()}${opt('all' + sp())}${pick(['data', 'output', 'results', 'result', 'logs', 'log', 'info'])}${gap(40, false)}${pick(['//', 'http://', 'https://', '10.2', '1.2', 'x'])}`,
    ),
  'ATR-2026-00256#4': () =>
    `${pre()}${ws0()}${b64(pick([60, 79, 80, 81, 100]))}${'='.repeat(Math.floor(rnd() * 5))}${pick(['\\n', ' ', '\n', '  ', '\\n\\n', ''])}${pick(['', 'a ', 'a b ', 'a b c '])}${pick(['decode', 'decoded', 'translate', 'interpret', 'execute', 'run', 'follow', 'walk'])}${pick(['', ' ', 'x', '.'])}`,
  'ATR-2026-00265#2': () =>
    `${pre()}${ws0()}${'-'.repeat(1 + Math.floor(rnd() * 5))}${ws0()}${pick(['\n', '\n', ' \n', '\n\n', ''])}${ws0()}${pick(['CONFIDENTIAL', 'INTERNAL', 'HIDDEN', 'IMPORTANT', 'NOTE', 'INSTRUCTION', 'OTHER'])}${ws0()}:${ws0()}${pick(['ignore', 'disregard', 'forget', 'you must', 'you  should', 'you are required', 'you may'])}`,
  'ATR-2026-00277#1': () =>
    `${pre()}${ws0()}${pick(['ECHO', 'echo', 'ECH'])}${ws0()}:${ws0()}${pick(['{{abc}}', '{{}}', '`(ls)', '$(ls)', '${x}', '<?php x ?>', '<?= x ?>', 'import os', '__import__', 'subprocess', 'eval (', 'exec(', 'hello'])}`,
  'ATR-2026-00282#0': () =>
    `${pre()}${ws0()}${pick(['IGNORE', 'DISREGARD', 'FORGET', 'OVERRIDE', 'ignore'])}${ws1()}${opt('ALL' + ws1())}${pick(['PREVIOUS', 'PRIOR', 'ABOVE', 'EARLIER', 'THE PREVIOUS', 'THE  ABOVE', 'THE'])}${ws1()}${pick(['INSTRUCTIONS', 'INSTRUCTION', 'PROMPTS', 'CONTEXT', 'TEXT', 'DIRECTIONS', 'GUIDELINE', 'RULES', 'CONSTRAINT', 'THINGS'])}${pick(['', ' ', 'S', '.'])}`,
  'ATR-2026-00282#1': () =>
    `${pick(['\n', 'x\n', '\n\n', ' \n ', '', 'x'])}${ws0()}${pick(['---', '===', '***', '###', '--', '----', '=='])}${ws0()}${pick(['\n', '\n', ' \n', '\n\n', ''])}${ws0()}${pick(['IGNORE', 'DISREGARD', 'NEW TASK', 'NEW  INSTRUCTION', 'NEW OBJECTIVE', 'ACTUALLY', 'NEW'])}`,
  'ATR-2026-00282#4': () =>
    `${pre()}${Array.from({ length: Math.floor(rnd() * 5) }, () => pick(['>', ' >', '> ', '\n>', '  ', '>>'])).join('')}${ws0()}${pick(['IGNORE', 'DISREGARD', 'NEW INSTRUCTION', 'NEW  INSTRUCTION', 'OVERRIDE', 'SYSTEM:', 'SYSTEM :', 'SYSTEM'])}`,
  'ATR-2026-00290#3': () =>
    `${Array.from({ length: 36 + Math.floor(rnd() * 8) }, () => pick(['a', 'bb', 'w1', 'A']) + pick([' ', ' ', '  ', '\n'])).join('')}${pick(['\x01\x01\x01', '\x01\x01', '\x01\x01\x01\x01', '', 'x\x01\x01\x01'])}`,
  'ATR-2026-00321#4': () =>
    `${pick(['__ {', '_{', '_ {', '>>', '>', 'a__ {', '___{ ', '_', ''])}${ws0()}${pick(['__', '_', '_ _', '_  _', '___', ' _ _ _', '_\n_', ''])}${ws0()}${pick(['System', 'system', 'Syste'])}${ws1()}${pick(['annou', 'anno', 'announce'])}`,
  'ATR-2026-00328#3': () =>
    `${pick(['x', 'ab', '12', 'a1b2', ''])}${pick([' ', '', '  '])}${pick(['Dev', 'DAN', 'x'])}${sp()}Mode${sp()}${pick(['output', 'response', 'responses', 'outputs'])}${gap(30)}${pick(['generating any kind of content', "ignoring OpenAI's content polic", 'ignoring OpenAl content polic', 'ignoring OpenAI content polic', 'nothing'])}`,
  'ATR-2026-00330#2': () =>
    `${pick(['DAN', 'D4N', 'dan', 'A', 'AB', '1AB', 'A1'])}${sp()}${pick(['respond', 'always respond', 'will respond', 'responds'])}${sp()}as${sp()}the${sp()}character${gap(60, true)}${pick(['DAN', 'ZZ', 'Q'])}${sp()}always${sp()}respond${sp()}as${sp()}the${sp()}character`,
  'ATR-2026-00418#3': () =>
    caps(
      `${pre()}${ws0()}command${ws0()}:${ws0()}${pick(['', "'", '"'])}${pick(['curl', 'wget', 'sh', 'cur'])}${pick(['', "'", '"'])}${ws0()}${pick(['\n', '\n', ' \n', '\n\n', ''])}${ws0()}${pick(['args', 'arg', 'ars'])}${ws0()}:`,
    ),
  'ATR-2026-00418#4': () =>
    caps(
      `${pre()}${ws0()}command${ws0()}:${ws0()}${pick(['', "'", '"'])}${pick(['bash', 'sh', 'cmd', 'powershell', 'zsh'])}${pick(['', "'", '"'])}${ws0()}${pick(['\n', '\n', ' \n', '\n\n', ''])}${ws0()}${pick(['args', 'arg'])}${ws0()}:${gap(40)}${pick(['https://', '| sh', '|bash', '-enc', '-encodedcommand', 'base64', 'iwr', 'invoke-webrequest', 'nothing'])}`,
    ),
  'ATR-2026-00418#8': () =>
    caps(
      `${pre()}${ws0()}-${ws1()}-${pick(['c', 'e', '-eval', '-command', 'x'])}${ws0()}${pick(['', '', 'x'])}`,
    ),
  'ATR-2026-00508#3': () =>
    caps(
      `${pick(['---', '===', '***', '\\\\\\', '--', '-', '----', '=*-'])}${gap(40)}${pick(['stop everything', 'ignore all previous instructions', 'ignore previous and following instructions', 'ignore  above x instruction', 'ignore the following', 'ignore any prior and following instructions'])}`,
    ),
  'ATR-2026-00566#1': () =>
    caps(
      `${pick(['header', 'headers', 'HTTP-header', 'http_headers', 'x-api-key', 'X_Auth', 'xa', 'x'])}${ws0()}${pick([':', '=', ''])}${ws0()}${gap(40, false)}{{${ws0()}${pick(['API_KEY', 'MY_TOKEN', 'x', 'SECRET', 'API-KEY', 'AUTH'])}${ws0()}}}`,
    ),
  'ATR-2026-01463#3': () =>
    caps(
      pick([
        `${pick(['##', '###', '#', 'a##', '####'])}${ws0()}[SYSTEM${pick([':', ']', 'x'])}${pick(['', '(', 'x'])}`,
        '<|system|>',
        `[SYSTEM${ws0()}${pick(['PROMPT', 'MESSAGE', 'OVERRIDE', 'X'])}]${pick(['', '('])}`,
      ]),
    ),
  'ATR-2026-00426#1': () =>
    caps(
      `${pick(['', '!', 'x '])}[${gap(10, false)}${pick(['', '[', 'a['])}${gap(5, false)}](${ws0()}${pick(['http://', 'https://', 'ftp://'])}${gap(30, false)}${pick(['$API_KEY', '${TOKEN}', '{{ api_key', '{{token', '$SECRET', '$NOPE', 'x'])}${pick(['', ' ', ')', 'b'])}`,
    ),
  'ATR-2026-01865#0': () =>
    caps(
      `${pick(['', 'x ', 'a ['])}${pick(['[', '[[', '[[[', '{{'])}${ws0()}${pick(['EMAIL', 'MAIL', 'MSG', 'MESSAGE', 'email', 'message', 'msg', 'mail', 'x'])}${pick(['_', ' ', ''])}${pick(['END', 'START', 'BOUNDARY', 'SEPARATOR', 'DIVIDER', '2', '12', ' 3', ''])}${pick(['_', ' ', ''])}${pick(['INDICATOR', 'MARKER', 'SEPARATOR', ''])}${ws0()}${pick([']', '}}', ']]]', '', ')'])}`,
    ),
  'ATR-2026-00416#2': () =>
    caps(
      `${pick(['', '{', '{{', 'x'])}${gap(40, false)}${pick(['', '{', '}'])}"transport"${ws0()}:${ws0()}"${pick(['stdio', 'http'])}"${gap(40, false)}${pick(['', '}'])}"command"${ws0()}:${ws0()}"${pick(['bash', 'sh', 'node', 'ruby'])}"`,
    ),
  'ATR-2026-00419#1': () =>
    caps(
      `${pick(['', '{', '{{', 'x'])}${gap(60, false)}${pick(['', '}'])}"${pick(['mcpServers', 'mcpServer', 'mcp_servers', 'mcp_server', 'mcpx'])}"${ws0()}:${ws0()}${pick(['{', '[', ''])}${gap(60, false)}${pick(['', '}'])}"command"${ws0()}:${ws0()}"${pick(['curl', 'wget', 'ls'])}"`,
    ),
  'ATR-2026-02351#0': () =>
    `${pick(['', 'a.', 'a-b.', 'a.b.c.d.e.f.', 'a.b.c.d.e.f.g.'])}${pick(['169', '16', 'x169'])}${pick(['.', '-'])}254${pick(['.', '-'])}169${pick(['.', '-'])}254.${pick(['nip.io', 'sslip.io', 'xip.io', 'traefik.me', 'foo.io'])}${pick(['', 'x', ' ', '-'])}`,
};

const overrides = loadRuleOverrides(
  join(import.meta.dirname, '../../../../rules/atr-overrides.yaml'),
);
const original = new Map<string, string>(
  loadBundledRules().flatMap((rule) =>
    rule.tests.map((test, index): [string, string] => [`${rule.id}#${index}`, test.value]),
  ),
);

describe.each(Object.keys(T))('%s, after the replacement', (key) => {
  const [id, index] = key.split('#') as [string, string];
  const replacement = overrides.get(id)?.conditions.find((c) => c.index === Number(index));

  it('is a recorded override whose original is the vendored pattern', () => {
    expect(replacement).toBeDefined();
  });

  it('matches the same strings as the original', () => {
    const from = replacement?.from ?? '';
    const to = replacement?.to ?? '';
    const before = new RegExp(translatePcre(from).source, translatePcre(from).flags);
    const after = new RegExp(translatePcre(to).source, translatePcre(to).flags);
    const make = T[key] as () => string;
    let matched = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      let text = make();
      if (rnd() < 0.25 && text.length > 2) {
        const at = Math.floor(rnd() * text.length);
        text =
          rnd() < 0.5
            ? text.slice(0, at) + text.slice(at + 1)
            : text.slice(0, at) + pick(['a', ' ', '\n', '-']) + text.slice(at);
      }
      if (rnd() < 0.2)
        text = pick(['', 'text ', 'x\n', '\n\n  ']) + text + pick(['', ' tail', '\nmore']);
      const expected = before.test(text);
      if (expected) matched += 1;
      expect(after.test(text), JSON.stringify(text)).toBe(expected);
    }
    // The generator has to produce the shape, or an equal answer on every string means nothing.
    expect(matched).toBeGreaterThan(ROUNDS / 100);
  });

  it('is applied to the rule in the bundle', () => {
    expect(original.get(key)).toBe(replacement?.to);
  });
});
