// Cleans a raw stream of `claude -p` (or the audit log of the hook in the same run) so that it can be
// committed as a fixture: no path of a person's machine, no id that names a real session, no random value
// that differs from one capture to the next. `test/fixtures/hosts/claude-code/README.md` lists what is
// changed; the runner is `scripts/clean-host-fixture.ts`, and `clean-fixture.test.ts` holds this file to it.
//
// Only what is listed is touched. Everything the parser reads is left as the host wrote it, so that a
// fixture is still a record of the host and not of whoever cleaned it.

/** The directory every cleaned stream says its project is. */
export const FIXTURE_PROJECT = '/tmp/stroq-live-fixture/project';
/** The nonce and the made-up key of every cleaned stream: the commands in them are built around these. */
export const FIXTURE_NONCE = 'stroq-live-0123456789abcdef';
export const FIXTURE_FAKE = 'stroq_attack_0123456789abcdef01234567';
/** The first UUID of a stream is the session of its run, and the cleaner numbers it first. */
export const FIXTURE_SESSION = '00000000-0000-4000-8000-000000000001';

/** Keys the host fills from the machine it runs on, and that no test reads. */
const DROPPED_KEYS: ReadonlySet<string> = new Set([
  'slash_commands',
  'terminal_slash_commands',
  'skills',
  'plugins',
  'agents',
  'memory_paths',
  'messaging_socket_path',
]);

const UUID =
  /\b(?!00000000-0000-4000-8000-0000000000\d\d\b)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Ids are `msg_01...`: a long run of letters and digits, which tells them from a name like `msg_lifecycle_v1`. */
const PREFIXED_ID = /\b(msg|req|toolu)_(?!FIXTURE)[A-Za-z0-9]{16,}\b/g;
/** The throwaway project of a capture, under either spelling of the system temp directory. */
const PROJECT = /(?:\/private)?\/[^"\\\s]*?\/stroq-capture-[A-Za-z0-9]+\/project/g;
const HOME_DIR = /\/Users\/(?!fixture-user\b)[^/"\\\s]+/g;
const NONCE = /stroq-live-[0-9a-f]{16}/g;
const FAKE = /stroq_attack_[0-9a-f]{24}/g;

/** What a capture made on a machine looks like, and a cleaned one does not. */
const LEAKS: readonly RegExp[] = [
  /\/var\/folders/,
  /\/private\/var/,
  /stroq-capture-/,
  /\/Users\/(?!fixture-user\b)/,
  /\/home\/(?!fixture-user\b)/,
  /"(?:slash_commands|terminal_slash_commands|skills|plugins|agents|memory_paths|messaging_socket_path|signature)"/,
];

export interface CleanOptions {
  /** `[from, to]` pairs of plain text to replace everywhere, after the rest (a name the capture used and the probe does not). */
  readonly renames?: readonly (readonly [from: string, to: string])[];
}

/** A map from each distinct value to the stand-in of its place in the order of appearance. */
function numbered(make: (n: number) => string): (value: string) => string {
  const seen = new Map<string, string>();
  return (value) => {
    const known = seen.get(value);
    if (known !== undefined) return known;
    const made = make(seen.size + 1);
    seen.set(value, made);
    return made;
  };
}

/** Takes the dropped keys, and the signature of every thinking block, out of a parsed line. */
function pruned(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruned);
  if (value === null || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const isThinking = object['type'] === 'thinking';
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => !DROPPED_KEYS.has(key) && !(isThinking && key === 'signature'))
      .map(([key, each]) => [key, pruned(each)]),
  );
}

/**
 * The cleaned text of a whole raw file, line by line. The ids are numbered in the order they first appear
 * in the file, so that a tool call and its result still name each other.
 */
export function cleanFixture(raw: string, options: CleanOptions = {}): string {
  const uuid = numbered((n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
  const byPrefix = new Map<string, (id: string) => string>();
  const prefixed = (whole: string, prefix: string): string => {
    const make =
      byPrefix.get(prefix) ?? numbered((n) => `${prefix}_FIXTURE${String(n).padStart(4, '0')}`);
    byPrefix.set(prefix, make);
    return make(whole);
  };
  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  const cleaned = lines.map((line) => {
    let text = JSON.stringify(pruned(JSON.parse(line)))
      .replace(PROJECT, FIXTURE_PROJECT)
      .replace(HOME_DIR, '/Users/fixture-user')
      .replace(UUID, uuid)
      .replace(PREFIXED_ID, prefixed)
      .replace(NONCE, FIXTURE_NONCE)
      .replace(FAKE, FIXTURE_FAKE);
    for (const [from, to] of options.renames ?? []) text = text.split(from).join(to);
    return text;
  });
  return `${cleaned.join('\n')}\n`;
}

/** What is left in a text that a cleaned fixture must not hold, one description for each kind found. */
export function leaksIn(text: string): string[] {
  return LEAKS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}
