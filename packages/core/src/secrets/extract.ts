export interface ExtractedSecret {
  readonly name: string;
  readonly value: string;
  readonly canary: boolean;
}

/** Shorter values are never treated as secrets (too many collisions with ordinary words). */
export const MIN_SECRET_LENGTH = 12;
/** Ceiling on total extractor input — the same ceiling the index applies to source files. */
export const MAX_TEXT_CHARS = 262_144;
const MAX_LINES = 5000;
const MAX_LINE_CHARS = 4096;
const MAX_NETRC_TOKENS = 20_000;

/** Key / variable names that mark a value as credential-like. */
const SECRET_NAME =
  /(key|token|secret|pass(word|wd)?|pwd|credential|auth|private|signing|salt|dsn|session|cookie)/i;
/**
 * Names that are identifiers, locations or labels even when they contain a
 * secret-ish word. `NEXTAUTH_URL`, `AUTH0_ISSUER_BASE_URL`, `SESSION_COOKIE_DOMAIN`
 * and `API_KEY_HEADER_NAME` are configuration: indexing their values would
 * hard-deny every ordinary request to the app's own endpoints.
 */
const EXCLUDED_NAME =
  /(_sock|_path|_dir|_file|_home|_public|public_key|_id|_url|_uri|_endpoint|_host|_hostname|_domain|_region|_name|_header)$/i;
const CANARY_NAME = /^STROQ_CANARY/i;
const PLACEHOLDER =
  /^(change[-_]?me|replace[-_]?me|todo|example|sample|dummy|placeholder|xxx+|\*+|<[^>]*>|\$\{[^}]*\}|your[-_])/i;
const PATH_LIKE = /^(\/|\.\.?\/|~)/;
/** Locations, not credentials: a URL, a `localhost`/dotted-domain prefix, a hostname or host:port. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_PREFIX = /^(\.|localhost)/i;
const HOST_LIKE = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i;
/** Values with a vendor prefix are secrets regardless of their key name. */
const TOKEN_SHAPES: readonly RegExp[] = [
  /^sk-[A-Za-z0-9_-]{10,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/,
  /^AIza[0-9A-Za-z_-]{30,}$/,
  /^npm_[A-Za-z0-9]{20,}$/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/,
];
// NAME=VALUE with an optional `export`; the name may be an npmrc scope path such as
// `//registry.npmjs.org/:_authToken`. Only `=` separates name and value. The value is the rest of
// the line, trimmed afterwards: a lazy value followed by `\s*$` tried each run of blanks once for
// every place the value could end, and a `.env` is a file the agent or a repository can write.
// `[\s\S]`, not `.`: the lines are cut at `\n`, and a `\r` before it ends the line, not the match.
const KEY_VALUE = /^\s*(?:export\s+)?([A-Za-z_/][\w./:-]*)\s*=([\s\S]*)$/;

export function looksLikeToken(value: string): boolean {
  return TOKEN_SHAPES.some((re) => re.test(value));
}

/**
 * A value worth indexing: long enough, whitespace-free, not a placeholder, not a
 * path, and not a location — a URL, a hostname, a `host:port` or a `.cookie.domain`
 * is configuration, and indexing `http://localhost:3000` would deny every request
 * to the app itself. A vendor-shaped token is a credential whatever else it resembles.
 */
export function isSecretValue(value: string, mayStartLikeAPath = false): boolean {
  if (value.length < MIN_SECRET_LENGTH || /\s/.test(value)) return false;
  if (PLACEHOLDER.test(value)) return false;
  if (PATH_LIKE.test(value) && !mayStartLikeAPath) return false;
  if (looksLikeToken(value)) return true;
  return !URL_SCHEME.test(value) && !LOCAL_PREFIX.test(value) && !HOST_LIKE.test(value);
}

function stripInlineComment(value: string): string {
  const i = value.search(/[ \t]#/);
  return i > 0 ? value.slice(0, i).trim() : value;
}

/**
 * A value as a `.env` reader takes it, in each form a reader may take: a quoted value to its
 * closing quote, with a comment after it left out (`KEY="v" # prod`); in double quotes both as
 * written and with the backslash before `$`, `"`, `` ` `` and `\` taken out, since loaders read
 * escapes differently (dotenv keeps them, a shell does not); a quote not closed on its line, what
 * follows it (the first line of a value that goes on over lines); an unquoted value up to a ` #`
 * comment. One pass over the value.
 */
function parseValue(raw: string): string[] {
  const value = raw.trim();
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return [stripInlineComment(value)];
  let end = -1;
  for (let i = 1; i < value.length; i += 1) {
    if (quote === '"' && value[i] === '\\') {
      i += 1;
      continue;
    }
    if (value[i] === quote) {
      end = i;
      break;
    }
  }
  if (end < 0) return [value.slice(1)];
  const rest = value.slice(end + 1).trim();
  if (rest !== '' && !rest.startsWith('#')) return [value];
  const inner = value.slice(1, end);
  if (quote !== '"') return [inner];
  const unescaped = inner.replace(/\\(["\\$`])/g, '$1');
  return unescaped === inner ? [inner] : [inner, unescaped];
}

/** AWS secret access keys are base64, and one may start with `/`: no path. */
const AWS_SECRET_NAME = /^aws_secret_access_key$/i;

/** A URL with a password in it: `postgres://user:<password>@host`. */
const URL_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;

/** The password a URL value holds, decoded, or null when it holds none. */
function urlPassword(value: string): string | null {
  const authority = URL_AUTHORITY.exec(value)?.[1] ?? '';
  const at = authority.lastIndexOf('@');
  if (at < 0) return null;
  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(':');
  if (colon < 0) return null;
  const password = userinfo.slice(colon + 1);
  try {
    return decodeURIComponent(password);
  } catch {
    return password;
  }
}

function classify(name: string, value: string): ExtractedSecret | null {
  if (!isSecretValue(value, AWS_SECRET_NAME.test(name))) return null;
  const canary = CANARY_NAME.test(name);
  if (canary) return { name, value, canary };
  if (looksLikeToken(value)) return { name, value, canary: false };
  if (EXCLUDED_NAME.test(name) || !SECRET_NAME.test(name)) return null;
  return { name, value, canary: false };
}

/** What a reader of key files asks for beyond what the live guard's index takes. */
export interface ExtractOptions {
  /**
   * The password in a URL value (`postgres://user:<password>@host`) as a key of its own, named
   * `NAME:password`. Off by default, as the live guard reads: a command that uses the project's
   * own database URL is not egress to deny. `stroq sent` asks for it.
   */
  readonly urlPasswords?: boolean;
}

/**
 * dotenv, ini (AWS credentials) and npmrc lines: `NAME=VALUE`, and, when asked, the password in a
 * URL value. `rejected` counts the lines named like a key (not a URL, a host or an id) whose value
 * is not taken: too short, a placeholder, a path or an address.
 */
export function extractKeyValuesCounted(
  text: string,
  options: ExtractOptions = {},
): {
  readonly secrets: ExtractedSecret[];
  readonly rejected: number;
} {
  const secrets: ExtractedSecret[] = [];
  let rejected = 0;
  for (const raw of text.slice(0, MAX_TEXT_CHARS).split('\n').slice(0, MAX_LINES)) {
    const line = raw.slice(0, MAX_LINE_CHARS);
    if (/^\s*[#;]/.test(line)) continue;
    const m = KEY_VALUE.exec(line);
    if (!m) continue;
    const name = m[1] ?? '';
    const forms = parseValue(m[2] ?? '');
    let taken = false;
    const pushed = new Set<string>();
    const push = (secret: ExtractedSecret): void => {
      taken = true;
      if (pushed.has(secret.value)) return;
      pushed.add(secret.value);
      secrets.push(secret);
    };
    for (const value of forms) {
      const found = classify(name, value);
      const password = options.urlPasswords === true ? urlPassword(value) : null;
      if (found) push(found);
      if (password !== null && isSecretValue(password))
        push({ name: `${name}:password`, value: password, canary: false });
    }
    if (
      !taken &&
      (forms[0] ?? '') !== '' &&
      SECRET_NAME.test(name) &&
      !EXCLUDED_NAME.test(name) &&
      !CANARY_NAME.test(name)
    )
      rejected += 1;
  }
  return { secrets, rejected };
}

/** dotenv, ini (AWS credentials) and npmrc lines: `NAME=VALUE`; see `extractKeyValuesCounted`. */
export const extractKeyValues = (text: string, options: ExtractOptions = {}): ExtractedSecret[] =>
  extractKeyValuesCounted(text, options).secrets;

/**
 * `extractKeyValues` over the whole of a text, a piece under its line and character limits at a
 * time, for a reader that must not lose a key past them (`stroq sent`). Pieces are cut at line
 * ends, so no line is split; a line longer than a whole piece is cut there, as the extractor cuts
 * any line far shorter than that. Linear in the text: each line is visited once.
 */
export function extractKeyValuesWhole(
  text: string,
  options: ExtractOptions = {},
): ExtractedSecret[] {
  return extractKeyValuesWholeCounted(text, options).secrets;
}

/** `extractKeyValuesWhole`, with the lines named like a key whose value is not taken counted. */
export function extractKeyValuesWholeCounted(
  text: string,
  options: ExtractOptions = {},
): {
  readonly secrets: ExtractedSecret[];
  readonly rejected: number;
} {
  const out: ExtractedSecret[] = [];
  let rejected = 0;
  let piece: string[] = [];
  let chars = 0;
  const flush = (): void => {
    if (piece.length > 0) {
      const read = extractKeyValuesCounted(piece.join('\n'), options);
      out.push(...read.secrets);
      rejected += read.rejected;
    }
    piece = [];
    chars = 0;
  };
  for (const raw of text.split('\n')) {
    const line = raw.slice(0, MAX_TEXT_CHARS - 1);
    if (piece.length >= MAX_LINES || chars + line.length + 1 > MAX_TEXT_CHARS) flush();
    piece.push(line);
    chars += line.length + 1;
  }
  flush();
  return { secrets: out, rejected };
}

/** Whether `extractNetrc` reads only part of a text: past its character or token limits. */
export function netrcIsCut(text: string): boolean {
  if (text.length > MAX_TEXT_CHARS) return true;
  return text.split(/\s+/).filter((t) => t.length > 0).length > MAX_NETRC_TOKENS;
}

/** `~/.netrc`: `machine <host> login <user> password <secret>`, also across lines. */
export function extractNetrc(text: string): ExtractedSecret[] {
  const tokens = text
    .slice(0, MAX_TEXT_CHARS)
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, MAX_NETRC_TOKENS);
  const out: ExtractedSecret[] = [];
  let machine = 'default';
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token === 'machine' && tokens[i + 1]) {
      machine = tokens[i + 1] ?? machine;
      i += 1;
    } else if (token === 'default') {
      machine = 'default';
    } else if (token === 'password' && tokens[i + 1]) {
      const value = tokens[i + 1] ?? '';
      if (isSecretValue(value)) out.push({ name: `password (${machine})`, value, canary: false });
      i += 1;
    }
  }
  return out;
}

/** `~/.docker/config.json`: `{ auths: { <registry>: { auth: base64("user:pass") } } }`. */
export function extractDockerAuths(text: string): ExtractedSecret[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(0, MAX_TEXT_CHARS));
  } catch {
    return [];
  }
  const auths = (parsed as { auths?: unknown } | null)?.auths;
  if (!auths || typeof auths !== 'object') return [];
  return Object.entries(auths as Record<string, unknown>).flatMap(([registry, entry]) => {
    const auth =
      entry && typeof entry === 'object' ? (entry as { auth?: unknown }).auth : undefined;
    if (typeof auth !== 'string' || !isSecretValue(auth)) return [];
    const decoded = Buffer.from(auth, 'base64').toString('utf8');
    const password = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : '';
    const blob: ExtractedSecret = { name: `docker auth (${registry})`, value: auth, canary: false };
    return isSecretValue(password)
      ? [blob, { name: `docker password (${registry})`, value: password, canary: false }]
      : [blob];
  });
}

/** Environment variables whose names or values look credential-like. */
export function extractEnv(env: Readonly<Record<string, string | undefined>>): ExtractedSecret[] {
  return Object.entries(env).flatMap(([name, value]) => {
    if (typeof value !== 'string') return [];
    const found = classify(name, value.slice(0, MAX_LINE_CHARS));
    return found ? [found] : [];
  });
}
