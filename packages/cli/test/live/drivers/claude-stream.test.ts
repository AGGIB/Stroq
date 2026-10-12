import { describe, expect, it } from 'vitest';
import {
  ClaudeStreamParser,
  parseClaudeStream,
  type ParsedStream,
} from '../../../src/live/drivers/claude-stream.js';
import { isSubscriptionKeySource } from '../../../src/live/run-problem.js';
import { cpuNow } from '../../helpers/cpu-time.js';
import { FIXTURE_PROJECT, STREAMS, linesOf, readFixture, withProvider } from './fixtures.js';

/** A line of a stream, as the host prints it. */
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

const init = (over: Record<string, unknown> = {}): string =>
  line({
    type: 'system',
    subtype: 'init',
    cwd: '/project',
    tools: ['Bash'],
    apiKeySource: 'none',
    permissionMode: 'acceptEdits',
    ...over,
  });

const rate = (over: Record<string, unknown> = {}): string =>
  line({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      overageStatus: 'rejected',
      isUsingOverage: false,
      ...over,
    },
  });

const result = (over: Record<string, unknown> = {}): string =>
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'DONE',
    modelUsage: { 'claude-haiku-4-5': { provider: 'firstParty' } },
    ...over,
  });

const assistant = (...content: unknown[]): string =>
  line({ type: 'assistant', message: { content } });
const toolUse = (command: string): unknown => ({
  type: 'tool_use',
  id: 'toolu_1',
  name: 'Bash',
  input: { command },
});
const toolResult = (content: unknown, isError?: boolean): string =>
  line({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content,
          ...(isError === undefined ? {} : { is_error: isError }),
        },
      ],
    },
  });

const parse = (text: string): ParsedStream => parseClaudeStream(text).parsed;

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
        input: {
          command: expect.stringMatching(
            /^echo stroq-live-[0-9a-f]{16} > \/tmp\/stroq-live-fixture\/project\/stroq-live-allow\.txt$/,
          ) as string,
        },
      },
      { type: 'tool_result', isError: false, text: '(Bash completed with no output)' },
      { type: 'text', text: 'DONE' },
      { type: 'result', isError: false, text: 'DONE' },
    ]);
    expect(parsed.apiKeySource).toBe('none');
    expect(parsed.cwd).toBe(FIXTURE_PROJECT);
    expect(parsed.unparsedLines).toBe(0);
  });

  it('says nothing of the provider for a host whose result line does not name it', () => {
    expect(parse(readFixture(STREAMS.allowRan)).apiProvider).toBeUndefined();
  });

  it('reads the provider from the result line when it is there', () => {
    const text = withProvider(readFixture(STREAMS.allowRan), 'firstParty');
    expect(parse(text).apiProvider).toBe('firstParty');
  });

  it("keeps the hook's own words in the result of a call the hook denied", () => {
    const { parsed } = parseClaudeStream(readFixture(STREAMS.egressBlocked));
    const result = parsed.stream.find((event) => event.type === 'tool_result');
    expect(result?.isError).toBe(true);
    expect(result?.text).toMatch(/^Stroq blocked this action \(deny-secret-egress\): /);
  });

  it("keeps the host's own words in the result of a call the host's permission step stopped", () => {
    const control = parse(readFixture(STREAMS.denyControl)).stream.find(
      (event) => event.type === 'tool_result',
    );
    expect(control).toMatchObject({ isError: true });
    expect(control?.text).toMatch(/^This Bash command contains multiple operations\./);
    const dontAsk = parse(readFixture(STREAMS.allowHostBlocked)).stream.find(
      (event) => event.type === 'tool_result',
    );
    expect(dontAsk?.text).toMatch(/^Permission to use Bash has been denied because Claude Code/);
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

describe('who pays: the first message of the host', () => {
  it.each(['none', 'oauth', 'NONE', ' OAuth '])(
    'lets a run go on when the key source is %j',
    (source) => {
      const { stop, parsed } = parseClaudeStream(init({ apiKeySource: source }) + result());
      expect(stop).toBeNull();
      expect(parsed.apiKeySource).toBe(source);
    },
  );

  it.each([
    'user',
    'project',
    'org',
    'temporary',
    'ANTHROPIC_API_KEY',
    'apiKeyHelper',
    '',
    'something-new',
  ])('stops the host at once when the key source is %j, whatever else it printed', (source) => {
    const parser = new ClaudeStreamParser();
    const stop = parser.push(
      init({ apiKeySource: source }) + assistant(toolUse('echo hi')) + result(),
    );
    expect(stop).toEqual({ kind: 'api-key', detail: expect.stringContaining('API key') as string });
    const parsed = parser.finish();
    expect(parsed.apiKeySource).toBe(source);
    // Nothing the host printed after that message is taken for what it did.
    expect(parsed.stream).toEqual([{ type: 'init' }]);
  });

  it.each([[{ apiKeySource: undefined }], [{ apiKeySource: 5 }], [{ apiKeySource: null }]])(
    'stops the host when the first message does not say how it is paid for (%j)',
    (over) => {
      const { stop, parsed } = parseClaudeStream(init(over));
      expect(stop?.kind).toBe('api-key');
      expect(parsed.apiKeySource).toBeUndefined();
    },
  );

  it('agrees with the judgement of a run about which key sources are a login', () => {
    for (const source of ['none', 'oauth', ' None ', 'user', 'org', '', 'x'])
      expect(parseClaudeStream(init({ apiKeySource: source })).stop === null, source).toBe(
        isSubscriptionKeySource(source),
      );
  });

  it('keeps going over lines that arrive after the stop, without reading them', () => {
    const parser = new ClaudeStreamParser();
    parser.push(init({ apiKeySource: 'user' }));
    const again = parser.push(assistant(toolUse('echo hi')));
    expect(again?.kind).toBe('api-key');
    expect(parser.finish().stream).toEqual([{ type: 'init' }]);
  });

  it('reads the directory the host ran in, and ignores one that is not text', () => {
    expect(parse(init({ cwd: '/somewhere' })).cwd).toBe('/somewhere');
    expect(parse(init({ cwd: 12 })).cwd).toBeUndefined();
    expect(parse(init({ cwd: undefined })).cwd).toBeUndefined();
  });

  it.each([
    ['one model', { m1: { provider: 'firstParty' } }, 'firstParty'],
    [
      'two that agree',
      { m1: { provider: 'firstParty' }, m2: { provider: 'firstParty' } },
      'firstParty',
    ],
    ['no model at all', {}, undefined],
    ['a model that does not say', { m1: {} }, undefined],
    ['one that says and one that does not', { m1: { provider: 'firstParty' }, m2: {} }, undefined],
    ['a provider that is not text', { m1: { provider: 7 } }, undefined],
  ])('reads the provider from %s', (_name, modelUsage, wanted) => {
    expect(parse(init() + result({ modelUsage })).apiProvider).toBe(wanted);
  });

  it('does not let two models that disagree read as the first party', () => {
    const provider = parse(
      init() +
        result({ modelUsage: { m1: { provider: 'firstParty' }, m2: { provider: 'bedrock' } } }),
    ).apiProvider;
    expect(provider).toBeDefined();
    expect(provider).not.toBe('firstParty');
  });

  it('says nothing of the provider when there is no model usage in the result', () => {
    expect(parse(init() + result({ modelUsage: undefined })).apiProvider).toBeUndefined();
    expect(parse(init() + result({ modelUsage: 'x' })).apiProvider).toBeUndefined();
  });
});

describe('a subscription that moves on to what is paid for, or runs out', () => {
  it('lets a run go on while the plan allows it, with a warning too', () => {
    for (const status of ['allowed', 'allowed_warning']) {
      const { stop, parsed } = parseClaudeStream(init() + rate({ status }) + result());
      expect(stop, status).toBeNull();
      expect(parsed.limitHit).toBeUndefined();
    }
  });

  it('stops the host the moment the subscription is using extra usage', () => {
    const parser = new ClaudeStreamParser();
    const stop = parser.push(
      init() +
        rate({ isUsingOverage: true, overageStatus: 'allowed' }) +
        assistant(toolUse('echo hi')),
    );
    expect(stop?.kind).toBe('limit');
    const parsed = parser.finish();
    expect(parsed.limitHit).toMatch(/overage/i);
    expect(parsed.stream).toEqual([{ type: 'init' }]);
  });

  it.each(['rejected', 'exceeded', 'blocked', 'something-new', ''])(
    'stops the host when the status of the plan is %j',
    (status) => {
      const { stop, parsed } = parseClaudeStream(init() + rate({ status }) + result());
      expect(stop?.kind).toBe('limit');
      expect(parsed.limitHit).toContain('status');
    },
  );

  it('says in plain short words what the host said, whatever it put in the fields', () => {
    const hostile = `\u001b[31mred\u001b[0m\n${'x'.repeat(5000)}\u0007`;
    const { parsed } = parseClaudeStream(
      init() + rate({ status: hostile, rateLimitType: hostile }) + result(),
    );
    const said = parsed.limitHit ?? '';
    expect(said).toMatch(/^[\x20-\x7e]{1,160}$/);
  });

  it('knows nothing of a rate limit event without a status, and does not stop for it', () => {
    const { stop } = parseClaudeStream(init() + line({ type: 'rate_limit_event' }) + result());
    expect(stop).toBeNull();
    const { stop: other } = parseClaudeStream(
      init() + line({ type: 'rate_limit_event', rate_limit_info: 'x' }) + result(),
    );
    expect(other).toBeNull();
  });
});

describe('the events', () => {
  it('maps a call, its result and the reply of the model', () => {
    const parsed = parse(
      init() +
        assistant({ type: 'thinking', thinking: 'hm' }, toolUse('echo hi'), {
          type: 'text',
          text: 'DONE',
        }) +
        toolResult('hi', false) +
        result(),
    );
    expect(parsed.stream).toEqual([
      { type: 'init' },
      { type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } },
      { type: 'text', text: 'DONE' },
      { type: 'tool_result', isError: false, text: 'hi' },
      { type: 'result', isError: false, text: 'DONE' },
    ]);
  });

  it('reads the text of a result that is a list of blocks', () => {
    const parsed = parse(
      toolResult(
        [
          { type: 'text', text: 'one' },
          { type: 'image', source: {} },
          { type: 'text', text: 'two' },
        ],
        true,
      ),
    );
    expect(parsed.stream).toEqual([{ type: 'tool_result', isError: true, text: 'one\ntwo' }]);
  });

  it('takes a result that does not say it is an error for one that is not, and one without text for empty', () => {
    expect(parse(toolResult('x')).stream).toEqual([
      { type: 'tool_result', isError: false, text: 'x' },
    ]);
    expect(parse(toolResult(undefined)).stream).toEqual([
      { type: 'tool_result', isError: false, text: '' },
    ]);
  });

  it.each([
    ['an error subtype', { subtype: 'error_max_turns', is_error: false }],
    ['is_error', { subtype: 'success', is_error: true }],
    ['both', { subtype: 'error_during_execution', is_error: true }],
  ])('marks a result with %s as an error', (_name, over) => {
    const events = parse(result(over)).stream;
    expect(events[0]).toMatchObject({ type: 'result', isError: true });
  });

  it('gives the text of a result as its words, or the subtype when it has none', () => {
    expect(parse(result({ result: 'You hit your limit' })).stream[0]).toMatchObject({
      text: 'You hit your limit',
    });
    expect(
      parse(result({ result: undefined, subtype: 'error_max_turns' })).stream[0],
    ).toMatchObject({ text: 'error_max_turns' });
  });

  it('counts calls of a tool the host runs for itself as calls', () => {
    const parsed = parse(
      assistant(
        { type: 'server_tool_use', name: 'web_search', input: { query: 'x' } },
        { type: 'mcp_tool_use', name: 'mcp__a__b', input: {} },
      ),
    );
    expect(parsed.stream).toEqual([
      { type: 'tool_use', name: 'web_search', input: { query: 'x' } },
      { type: 'tool_use', name: 'mcp__a__b', input: {} },
    ]);
    expect(parsed.unparsedLines).toBe(0);
  });

  it('does not take a name that is not text for a name', () => {
    const [event] = parse(assistant({ type: 'tool_use', name: 7, input: 'ls' })).stream;
    expect(event).toEqual({ type: 'tool_use', input: 'ls' });
  });

  it('ignores a message it has no use for, without doubting the stream', () => {
    const parsed = parse(
      init() +
        line({ type: 'system', subtype: 'hook_started', hook_name: 'x' }) +
        line({ type: 'stream_event', event: {} }) +
        line({ type: 'brand-new-thing' }) +
        line({ no: 'type at all' }) +
        result(),
    );
    expect(parsed.stream.map((event) => event.type)).toEqual(['init', 'result']);
    expect(parsed.unparsedLines).toBe(0);
  });

  it('keeps the first words of a long result and cuts the rest', () => {
    const words = `Stroq blocked this action (deny-git-exec): ${'x'.repeat(50_000)}`;
    const [event] = parse(toolResult(words, true)).stream;
    expect(event?.text?.startsWith('Stroq blocked this action (deny-git-exec): ')).toBe(true);
    expect(event?.text?.length).toBeLessThanOrEqual(4096);
  });
});

describe('a stream that cannot be read', () => {
  it.each([
    ['text', 'this is not json'],
    ['a half line', '{"type":"assistant","message":'],
    ['an array', '[1,2,3]'],
    ['a number', '42'],
    ['null', 'null'],
    ['a string', '"hello"'],
  ])('counts %s as a line it could not read', (_name, text) => {
    const parsed = parse(`${init()}${text}\n${result()}`);
    expect(parsed.unparsedLines).toBe(1);
    expect(parsed.stream.map((event) => event.type)).toEqual(['init', 'result']);
  });

  it.each([
    ['content that is not a list', line({ type: 'assistant', message: { content: 5 } })],
    ['no message', line({ type: 'assistant' })],
    ['a block it does not know', assistant({ type: 'brand-new-block', x: 1 })],
    ['a block that is not an object', assistant('x')],
    ['a user message of a shape it does not know', line({ type: 'user', message: { content: 5 } })],
    ['a result block that is not an object', line({ type: 'user', message: { content: ['x'] } })],
  ])(
    'counts %s as a line it could not read, because a call could be hidden in it',
    (_name, text) => {
      expect(parse(text).unparsedLines).toBe(1);
    },
  );

  it('does not count a user message that is only text', () => {
    expect(parse(line({ type: 'user', message: { content: 'hello' } })).unparsedLines).toBe(0);
    expect(
      parse(line({ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }))
        .unparsedLines,
    ).toBe(0);
  });

  it('counts every line it could not read', () => {
    expect(parse('a\nb\n{\n[]\n').unparsedLines).toBe(4);
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
