import { describe, expect, it } from 'vitest';
import { ClaudeStreamParser, parseClaudeStream } from '../../../src/live/drivers/claude-stream.js';
import { cpuNow } from '../../helpers/cpu-time.js';
import { FIXTURE_NONCE, FIXTURE_PROJECT, linesOf, readFixture, STREAMS } from './fixtures.js';
import { assistant, init, parse, result } from './stream-lines.js';

/**
 * The parser of the stream of `claude -p`, against what a real host printed and against streams that go
 * wrong: fed in pieces of any size, longer than it will read, or built to be slow.
 */

describe('the streams of a real host', () => {
  it('reads a request with no tools: init, a text, a result, and who pays for it', () => {
    const { parsed, stop } = parseClaudeStream(readFixture(STREAMS.plain));
    expect(stop).toBeNull();
    expect(parsed.stream).toEqual([
      { type: 'init' },
      { type: 'text', text: 'ok' },
      { type: 'result', isError: false, text: 'ok' },
    ]);
    expect(parsed).toMatchObject({
      apiKeySource: 'none',
      apiProvider: 'firstParty',
      cwd: FIXTURE_PROJECT,
      unparsedLines: 0,
    });
    expect(parsed.limitHit).toBeUndefined();
  });

  it('reads the allow probe that ran: the call, its result, the reply', () => {
    const { parsed, stop } = parseClaudeStream(readFixture(STREAMS.allowRan));
    expect(stop).toBeNull();
    expect(parsed.stream).toEqual([
      { type: 'init' },
      {
        type: 'tool_use',
        name: 'Bash',
        input: { command: `echo ${FIXTURE_NONCE} > ${FIXTURE_PROJECT}/stroq-live-allow.txt` },
      },
      { type: 'tool_result', isError: false, text: '(Bash completed with no output)' },
      { type: 'text', text: 'DONE' },
      { type: 'result', isError: false, text: 'DONE' },
    ]);
    expect(parsed.apiKeySource).toBe('none');
    expect(parsed.cwd).toBe(FIXTURE_PROJECT);
    expect(parsed.unparsedLines).toBe(0);
  });

  it('says nothing of the provider for a host whose result line does not name it (2.1.144)', () => {
    expect(parse(readFixture(STREAMS.noProvider)).apiProvider).toBeUndefined();
  });

  it('reads the provider from the result line when it is there (2.1.271)', () => {
    expect(parse(readFixture(STREAMS.allowRan)).apiProvider).toBe('firstParty');
  });

  it("keeps the hook's own words in the result of a call the hook denied", () => {
    const { parsed } = parseClaudeStream(readFixture(STREAMS.denyBlocked));
    expect(parsed.stream.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'text',
      'result',
    ]);
    const result = parsed.stream.find((event) => event.type === 'tool_result');
    expect(result?.isError).toBe(true);
    expect(result?.text).toMatch(/^Stroq blocked this action \(deny-git-exec\): /);
  });

  it("keeps the host's own words in the result of a call the host's permission step stopped", () => {
    const stopped = parse(readFixture(STREAMS.denyControlUnarmed)).stream.find(
      (event) => event.type === 'tool_result',
    );
    expect(stopped).toMatchObject({ isError: true, text: 'This command requires approval' });
    expect(stopped?.text).not.toContain('Stroq blocked this action');
  });

  it('reads the command that ran in a control that was armed, and a result with no error', () => {
    const { parsed } = parseClaudeStream(readFixture(STREAMS.denyControl));
    expect(parsed.stream.find((event) => event.type === 'tool_use')).toMatchObject({
      input: {
        command: `git config --file ${FIXTURE_PROJECT}/stroq-live-git-config.txt core.hooksPath ${FIXTURE_NONCE}`,
      },
    });
    expect(parsed.stream.find((event) => event.type === 'tool_result')).toMatchObject({
      isError: false,
    });
  });

  it('reads the secret-egress probe the model declined: no call at all, and an answer that begins BLOCKED', () => {
    const { parsed, stop } = parseClaudeStream(readFixture(STREAMS.egressRefused));
    expect(stop).toBeNull();
    expect(parsed.stream.map((event) => event.type)).toEqual(['init', 'text', 'result']);
    expect(parsed.stream.some((event) => event.type === 'tool_use')).toBe(false);
    expect(parsed.stream[1]?.text).toMatch(/^BLOCKED/);
    expect(parsed.apiProvider).toBe('firstParty');
  });

  it('puts the thinking of the model nowhere in the stream', () => {
    for (const stream of Object.values(STREAMS)) {
      const { parsed } = parseClaudeStream(readFixture(stream));
      expect(JSON.stringify(parsed.stream)).not.toContain('"thinking"');
      expect(parsed.unparsedLines, stream.file).toBe(0);
    }
  });

  it('reads every cleaned stream to the end without stopping the host', () => {
    for (const stream of Object.values(STREAMS)) {
      const { parsed, stop } = parseClaudeStream(readFixture(stream));
      expect(stop, stream.file).toBeNull();
      expect(parsed.stream[0]?.type, stream.file).toBe('init');
      expect(parsed.stream[parsed.stream.length - 1]?.type, stream.file).toBe('result');
      expect(parsed.limitHit, stream.file).toBeUndefined();
    }
  });
});

describe('a stream fed in pieces', () => {
  it.each([1, 3, 7, 64, 1000])(
    'is read the same when it arrives %i characters at a time',
    (size) => {
      for (const stream of Object.values(STREAMS)) {
        const text = readFixture(stream);
        const whole = parseClaudeStream(text).parsed;
        const parser = new ClaudeStreamParser();
        for (let at = 0; at < text.length; at += size) parser.push(text.slice(at, at + size));
        expect(parser.finish(), stream.file).toEqual(whole);
      }
    },
  );

  it('reads a last line that has no newline after it', () => {
    const text = (init() + result()).trimEnd();
    const parsed = parse(text);
    expect(parsed.stream.map((event) => event.type)).toEqual(['init', 'result']);
    expect(parsed.unparsedLines).toBe(0);
  });

  it('counts a last line that was cut in the middle as a line it could not read', () => {
    const parsed = parse(`${init()}{"type":"result","subtype":"suc`);
    expect(parsed.unparsedLines).toBe(1);
    expect(parsed.stream.map((event) => event.type)).toEqual(['init']);
  });

  it('reads lines that end in a carriage return and skips blank ones', () => {
    const parsed = parse(`${init().trimEnd()}\r\n\r\n\n${result()}`);
    expect(parsed.stream.map((event) => event.type)).toEqual(['init', 'result']);
    expect(parsed.unparsedLines).toBe(0);
  });
});

describe('how much is read', () => {
  it('stops the host that prints more than the cap, and does not trust what it printed', () => {
    const parser = new ClaudeStreamParser({ maxChars: 500, maxLineChars: 400 });
    const lines = Array.from({ length: 30 }, (_, i) =>
      assistant({ type: 'text', text: `n${i}` }),
    ).join('');
    const stop = parser.push(lines);
    expect(stop?.kind).toBe('too-much-output');
    expect(parser.finish().unparsedLines).toBeGreaterThan(0);
  });

  it('reads past a line that is longer than the cap for a line, and counts it once', () => {
    const parser = new ClaudeStreamParser({ maxChars: 100_000, maxLineChars: 1000 });
    const big = `{"type":"assistant","message":{"content":[{"type":"text","text":"${'y'.repeat(5000)}"}]}}\n`;
    // The long line arrives in pieces, as a pipe delivers it.
    for (let at = 0; at < big.length; at += 700) parser.push(big.slice(at, at + 700));
    parser.push(result());
    const parsed = parser.finish();
    expect(parsed.unparsedLines).toBe(1);
    expect(parsed.stream.map((event) => event.type)).toEqual(['result']);
  });

  it('reads lines in linear time: eight times the lines take about eight times as long', () => {
    const one = assistant({ type: 'text', text: 'x'.repeat(200) });
    const small = one.repeat(5000);
    const large = one.repeat(40_000);
    const limits = { maxChars: 64 * 1024 * 1024, maxLineChars: 1024 * 1024 };
    const time = (text: string): number => {
      const start = cpuNow();
      parseClaudeStream(text, limits);
      return cpuNow() - start;
    };
    time(small);
    const t1 = Math.max(time(small), 5);
    const t2 = time(large);
    // A reading that went with the square of the lines would be forty times as long, or worse.
    expect(t2 / t1).toBeLessThan(40);
    expect(t2).toBeLessThan(4000);
  });

  it('does not take a long line of one repeated character for something slow to read', () => {
    const text = `${'a'.repeat(900_000)}\n${'{'.repeat(100_000)}\n${init()}`;
    const start = cpuNow();
    const parsed = parseClaudeStream(text, {
      maxChars: 4 * 1024 * 1024,
      maxLineChars: 2 * 1024 * 1024,
    }).parsed;
    expect(cpuNow() - start).toBeLessThan(2000);
    expect(parsed.unparsedLines).toBe(2);
  });
});

describe('the fixtures themselves', () => {
  it('are one JSON object a line', () => {
    for (const stream of Object.values(STREAMS))
      for (const each of linesOf(readFixture(stream)))
        expect(typeof (JSON.parse(each) as Record<string, unknown>)['type']).toBe('string');
  });
});
