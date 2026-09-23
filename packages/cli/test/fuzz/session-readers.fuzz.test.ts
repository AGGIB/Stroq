import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Transcript } from '../../src/replay/transcript.js';
import { createTranscriptParser } from '../../src/replay/transcript.js';
import { createCodexParser } from '../../src/sent/codex.js';
import { readObjectLiteral } from '../../src/sent/codex-literal.js';
import { parseCursorStore } from '../../src/sent/cursor.js';
import { withoutHeredocData } from '../../src/sent/heredoc.js';

/**
 * Property tests for the readers `stroq sent` and `stroq replay` run over sessions
 * an agent recorded — text the model wrote, shaped by whatever it read. Each must
 * answer every input without throwing, quickly, and without inventing structure.
 */

function fast<T>(fn: () => T, ms = 250): T {
  const started = performance.now();
  const out = fn();
  expect(performance.now() - started).toBeLessThan(ms);
  return out;
}

/** Every `post` answers a `pre` with the same id that came before it. */
function pairedInOrder(transcript: Transcript): void {
  const seen = new Set<string>();
  for (const event of transcript.events) {
    if (event.kind === 'pre') seen.add(event.id);
    else expect(seen.has(event.id)).toBe(true);
  }
}

/** Lines that are sometimes records of the agent's own format and sometimes noise. */
const claudeLine = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc
    .record({
      sessionId: fc.string({ maxLength: 8 }),
      timestamp: fc.string({ maxLength: 30 }),
      message: fc.record({
        content: fc.array(
          fc.oneof(
            fc.record({
              type: fc.constant('tool_use'),
              id: fc.string({ maxLength: 4 }),
              name: fc.string({ maxLength: 10 }),
              input: fc.jsonValue({ maxDepth: 2 }),
            }),
            fc.record({
              type: fc.constant('tool_result'),
              tool_use_id: fc.string({ maxLength: 4 }),
              content: fc.jsonValue({ maxDepth: 2 }),
            }),
            fc.jsonValue({ maxDepth: 2 }),
          ),
          { maxLength: 4 },
        ),
      }),
    })
    .map((r) => JSON.stringify(r)),
);

describe('Claude transcript reader on arbitrary lines', () => {
  it('never throws and never pairs a result with a call it did not see', () => {
    fc.assert(
      fc.property(fc.array(claudeLine, { maxLength: 30 }), (lines) => {
        const parser = createTranscriptParser();
        fast(() => {
          for (const line of lines) parser.push(line);
        });
        pairedInOrder(parser.finish());
      }),
      { numRuns: 300 },
    );
  });
});

const codexLine = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc
    .record({
      timestamp: fc.string({ maxLength: 30 }),
      type: fc.constantFrom('response_item', 'session_meta', 'event_msg', 'x'),
      payload: fc.oneof(
        fc.record({
          type: fc.constantFrom('custom_tool_call', 'function_call', 'x'),
          call_id: fc.string({ maxLength: 4 }),
          name: fc.string({ maxLength: 12 }),
          input: fc.string({ maxLength: 120 }),
          arguments: fc.string({ maxLength: 120 }),
        }),
        fc.record({
          type: fc.constantFrom('custom_tool_call_output', 'function_call_output'),
          call_id: fc.string({ maxLength: 4 }),
          output: fc.jsonValue({ maxDepth: 2 }),
        }),
        fc.jsonValue({ maxDepth: 2 }),
      ),
    })
    .map((r) => JSON.stringify(r)),
);

describe('Codex rollout reader on arbitrary lines', () => {
  it('never throws and never pairs a result with a call it did not see', () => {
    fc.assert(
      fc.property(fc.array(codexLine, { maxLength: 30 }), (lines) => {
        const parser = createCodexParser();
        fast(() => {
          for (const line of lines) parser.push(line);
        });
        pairedInOrder(parser.finish());
      }),
      { numRuns: 300 },
    );
  });
});

describe('Codex object-literal reader', () => {
  // The literal reader exists for the 82% of Codex arguments that are JavaScript
  // rather than JSON, but every JSON object is also a valid literal: it must come
  // back exactly, or the reader is silently rewriting the arguments it reports.
  it('reads any JSON object back exactly', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 3 })),
        (obj) => {
          const src = JSON.stringify(obj);
          const read = fast(() => readObjectLiteral(src, 0));
          // `-0` serialises as `0`; the reader can only be held to what the text says.
          expect(read?.value).toEqual(JSON.parse(src));
          expect(read?.end).toBe(src.length);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('answers arbitrary source with null or a value, never a throw', () => {
    const js = fc
      .array(fc.constantFrom(...'{}[],:\'"`${}\\ \n abc123-.e+truefalsenull'.split('')), {
        maxLength: 200,
      })
      .map((p) => `{${p.join('')}`);
    fc.assert(
      fc.property(fc.oneof(js, fc.string({ maxLength: 200 })), fc.nat(10), (src, at) => {
        fast(() => readObjectLiteral(src, Math.min(at, src.length)));
      }),
      { numRuns: 500 },
    );
  });
});

describe('Cursor store reader on arbitrary rows', () => {
  it('never throws, pairs results in order, and dates every session', () => {
    const row = fc.record({
      key: fc.oneof(
        fc.string({ maxLength: 30 }),
        fc
          .tuple(fc.constantFrom('s1', 's2'), fc.string({ maxLength: 6 }))
          .map(([s, b]) => `bubbleId:${s}:${b}`),
      ),
      value: fc.oneof(
        fc.string({ maxLength: 100 }),
        fc
          .record({
            createdAt: fc.string({ maxLength: 30 }),
            toolFormerData: fc.record({
              name: fc.constantFrom('read_file_v2', 'run_terminal_command_v2', 'mcp-x-y', 'z'),
              toolCallId: fc.string({ maxLength: 4 }),
              params: fc.oneof(
                fc.string({ maxLength: 60 }),
                fc.jsonValue({ maxDepth: 2 }).map((v) => JSON.stringify(v)),
              ),
              result: fc.oneof(
                fc.string({ maxLength: 60 }),
                fc.jsonValue({ maxDepth: 2 }).map((v) => JSON.stringify(v)),
              ),
            }),
          })
          .map((v) => JSON.stringify(v)),
      ),
    });
    fc.assert(
      fc.property(fc.array(row, { maxLength: 30 }), (rows) => {
        const sessions = fast(() => parseCursorStore(rows));
        for (const session of sessions) {
          pairedInOrder(session.transcript);
          expect(Number.isFinite(session.mtimeMs)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('heredoc filter on arbitrary commands', () => {
  const heredocish = fc
    .array(
      fc.constantFrom(
        'cat > f <<EOF',
        "bash <<'X'",
        '<<-EOF',
        'EOF',
        'X',
        '\tEOF',
        '~/.npmrc',
        'echo hi',
        '| sh',
        'env A=b',
        '<<<',
        '$((1<<n))',
        '',
      ),
      { maxLength: 20 },
    )
    .map((lines) => lines.join('\n'));

  it('only ever removes whole lines, keeps their order, and settles after one pass', () => {
    fc.assert(
      fc.property(fc.oneof(heredocish, fc.string({ maxLength: 300 })), (command) => {
        const once = fast(() => withoutHeredocData(command));
        const kept = once.split('\n');
        const original = command.split('\n');
        let at = 0;
        for (const line of kept) {
          while (at < original.length && original[at] !== line) at += 1;
          expect(at).toBeLessThan(original.length);
          at += 1;
        }
        expect(withoutHeredocData(once)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  // Well-formed heredocs, so the property is about bodies actually being judged:
  // a body written to a file is dropped, a body a shell runs is kept, whatever
  // surrounds them.
  it('drops a body written to a file and keeps one a shell runs', () => {
    const marker = '~/.npmrc';
    const body = fc.array(fc.constantFrom('echo x', marker, 'ls', ''), {
      minLength: 1,
      maxLength: 4,
    });
    const heredoc = fc.record({
      consumer: fc.constantFrom(
        'cat > out.txt',
        'tee notes.md',
        'git commit -F -',
        'bash',
        'sh',
        'python3 -',
        'cat | sh',
      ),
      delim: fc.constantFrom('EOF', 'X', 'PY'),
      quote: fc.constantFrom('', "'", '"'),
      body,
      before: fc.constantFrom('', 'cd /tmp && ', 'set -e; '),
    });
    fc.assert(
      fc.property(heredoc, ({ consumer, delim, quote, body: lines, before }) => {
        const [first, ...pipe] = consumer.split(' | ');
        const header = `${before}${first} <<${quote}${delim}${quote}${pipe.length > 0 ? ` | ${pipe.join(' | ')}` : ''}`;
        const command = [header, ...lines, delim].join('\n');
        const out = fast(() => withoutHeredocData(command));
        const runs = /^(bash|sh|python3 -)$/.test(first ?? '') || pipe.length > 0;
        if (lines.includes(marker)) expect(out.includes(marker)).toBe(runs);
        expect(out.startsWith(header)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
