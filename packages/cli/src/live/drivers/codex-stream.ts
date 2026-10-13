import { limitTextOf } from '../limit-text.js';
import { type StreamEvent } from '../types.js';
import { type Interpreted, type StreamStop, MAX_EVENT_TEXT_CHARS } from './claude-message.js';
import { ClaudeStreamParser, DEFAULT_STREAM_LIMITS, type StreamLimits } from './claude-stream.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const read = (events: readonly StreamEvent[] = [], unreadable = false): Interpreted => ({
  events,
  facts: {},
  stop: null,
  unreadable,
});
const cap = (text: string): string => text.slice(0, MAX_EVENT_TEXT_CHARS);

/** Codex renders an argv, including the shell wrapper, rather than the model's cmd field. */
export function codexCommand(text: string): string {
  const wrapped =
    /^(?:"([^"\n]+)"|'([^'\n]+)'|([^\s]+))\s+(?:-lc|-c|-Command)\s+'((?:[^']|'')*)'$/.exec(text);
  if (wrapped === null) return text;
  const executable = wrapped[1] ?? wrapped[2] ?? wrapped[3] ?? '';
  if (!/(?:^|[\\/])(?:bash|sh|zsh|dash|pwsh|powershell)(?:\.exe)?$/i.test(executable)) return text;
  return (wrapped[4] ?? '').replaceAll("''", "'");
}

function hostError(text: string): Interpreted {
  const events: StreamEvent[] = [{ type: 'result', isError: true, text: cap(text) }];
  if (/api[ _-]?key|api billing|usage.based billing/i.test(text))
    return {
      events,
      facts: { apiKeySource: 'api-key' },
      unreadable: false,
      stop: { kind: 'api-key', detail: 'the host reported API billing' },
    };
  const limit = limitTextOf(text);
  return limit === null
    ? read(events)
    : {
        events,
        facts: { limitHit: limit },
        unreadable: false,
        stop: { kind: 'limit', detail: limit },
      };
}

/** Read the JSONL event shapes of codex exec. Unknown items fail closed: they may be tool activity. */
function interpreter(): (message: Obj) => Interpreted {
  const issued = new Map<string, string>();
  return (message) => {
    const kind = message['type'];
    if (kind === 'thread.started') return read([{ type: 'init' }]);
    if (kind === 'turn.started') return read();
    if (kind === 'turn.completed') return read([{ type: 'result', isError: false }]);
    if (kind === 'error')
      return typeof message['message'] === 'string'
        ? hostError(message['message'])
        : read([], true);
    if (kind === 'turn.failed') {
      const error = message['error'];
      return object(error) && typeof error['message'] === 'string'
        ? hostError(error['message'])
        : read([], true);
    }
    if (kind !== 'item.started' && kind !== 'item.updated' && kind !== 'item.completed')
      return read([], true);
    const item = message['item'];
    if (!object(item) || typeof item['id'] !== 'string') return read([], true);
    const type = item['type'];
    if (type === 'reasoning') return read();
    if (type === 'agent_message')
      return typeof item['text'] === 'string'
        ? read(kind === 'item.completed' ? [{ type: 'text', text: cap(item['text']) }] : [])
        : read([], true);
    if (type === 'error') {
      // Codex emits its hook-trust warning as an error item even on a successful run.
      const text = item['message'];
      if (typeof text !== 'string') return read([], true);
      return /api[ _-]?key|api billing|usage.based billing/i.test(text) ||
        limitTextOf(text) !== null
        ? hostError(text)
        : read([{ type: 'other', text: cap(text) }]);
    }
    if (type !== 'command_execution' || typeof item['command'] !== 'string') return read([], true);
    const events: StreamEvent[] = [];
    const earlier = issued.get(item['id']);
    if (earlier !== undefined && earlier !== item['command']) return read([], true);
    if (!issued.has(item['id'])) {
      issued.set(item['id'], item['command']);
      events.push({
        type: 'tool_use',
        name: 'Bash',
        input: { command: codexCommand(item['command']) },
      });
    }
    if (kind === 'item.completed') {
      if (
        typeof item['aggregated_output'] !== 'string' ||
        (item['exit_code'] !== null && typeof item['exit_code'] !== 'number')
      )
        return read(events, true);
      events.push({
        type: 'tool_result',
        text: cap(item['aggregated_output']),
        isError: item['status'] === 'failed' || item['exit_code'] !== 0,
      });
    }
    return read(events);
  };
}

/** Shared framing bounds, separate event vocabulary. No billing claim is invented from thread.started. */
export class CodexStreamParser extends ClaudeStreamParser {
  private stderrPending = '';
  private stderrEvents: StreamEvent[] = [];
  private stderrRead: Interpreted = read();
  private stderrSeen = 0;
  private stderrUnparsed = 0;
  private stderrSkipping = false;

  constructor(private readonly stderrLimits: StreamLimits = DEFAULT_STREAM_LIMITS) {
    super(stderrLimits, interpreter());
  }

  /** Codex omits hook-denied calls from JSONL. Only its own router diagnostic supplies them. */
  pushStderr(chunk: string): StreamStop | null {
    if (this.stderrRead.stop !== null) return this.stderrRead.stop;
    this.stderrSeen += chunk.length;
    if (this.stderrSeen > this.stderrLimits.maxChars) {
      this.stderrUnparsed += 1;
      this.stderrPending = '';
      this.stderrRead = {
        ...read(),
        stop: {
          kind: 'too-much-output',
          detail: 'the host printed more stderr than the check reads, so it was stopped',
        },
      };
      return this.stderrRead.stop;
    }
    let start = 0;
    while (this.stderrRead.stop === null) {
      const end = chunk.indexOf('\n', start);
      const rest = chunk.slice(start, end === -1 ? undefined : end);
      if (
        !this.stderrSkipping &&
        this.stderrPending.length + rest.length > this.stderrLimits.maxLineChars
      ) {
        this.stderrPending = '';
        this.stderrSkipping = true;
        this.stderrUnparsed += 1;
      }
      if (!this.stderrSkipping) this.stderrPending += rest;
      if (end === -1) break;
      if (!this.stderrSkipping) this.stderrLine(this.stderrPending);
      this.stderrPending = '';
      this.stderrSkipping = false;
      start = end + 1;
    }
    return this.stderrRead.stop;
  }

  private stderrLine(line: string): void {
    const denied =
      /^\S+\s+ERROR codex_core::tools::router: error=Command blocked by PreToolUse hook: (.+?) Command: (.+)\r?$/.exec(
        line,
      );
    if (denied !== null) {
      this.stderrEvents.push(
        { type: 'tool_use', name: 'Bash', input: { command: denied[2]!.trimEnd() } },
        { type: 'tool_result', text: cap(denied[1]!), isError: true },
      );
      return;
    }
    // Tools' output is in JSONL, not the host log. Never read a model's words as a billing signal.
    if (
      /^\S+\s+ERROR codex_/.test(line) &&
      /api[ _-]?key|api billing|usage.based billing/i.test(line)
    )
      this.stderrRead = hostError(line);
  }

  override finish(): ReturnType<ClaudeStreamParser['finish']> {
    if (this.stderrRead.stop === null && !this.stderrSkipping && this.stderrPending !== '')
      this.stderrLine(this.stderrPending);
    this.stderrPending = '';
    const parsed = super.finish();
    return {
      ...parsed,
      ...this.stderrRead.facts,
      unparsedLines: parsed.unparsedLines + this.stderrUnparsed,
      stream: [...parsed.stream, ...this.stderrEvents, ...this.stderrRead.events],
    };
  }
}
