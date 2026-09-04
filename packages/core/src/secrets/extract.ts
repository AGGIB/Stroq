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
// `//registry.npmjs.org/:_authToken`. Only `=` separates name and value.
const KEY_VALUE = /^\s*(?:export\s+)?([A-Za-z_/][\w./:-]*)\s*=\s*(.+?)\s*$/;

export function looksLikeToken(value: string): boolean {
  return TOKEN_SHAPES.some((re) => re.test(value));
}

/**
 * A value worth indexing: long enough, whitespace-free, not a placeholder, not a
 * path, and not a location — a URL, a hostname, a `host:port` or a `.cookie.domain`
 * is configuration, and indexing `http://localhost:3000` would deny every request
 * to the app itself. A vendor-shaped token is a credential whatever else it resembles.
 */
export function isSecretValue(value: string): boolean {
  if (value.length < MIN_SECRET_LENGTH || /\s/.test(value)) return false;
  if (PLACEHOLDER.test(value) || PATH_LIKE.test(value)) return false;
  if (looksLikeToken(value)) return true;
  return !URL_SCHEME.test(value) && !LOCAL_PREFIX.test(value) && !HOST_LIKE.test(value);
}

function unquote(value: string): string {
  const m = /^(["'])(.*)\1$/.exec(value);
  return m ? (m[2] ?? '') : value;
}

function stripInlineComment(value: string): string {
  if (/^["']/.test(value)) return value;
  const i = value.search(/[ \t]#/);
  return i > 0 ? value.slice(0, i).trim() : value;
}

function classify(name: string, value: string): ExtractedSecret | null {
  if (!isSecretValue(value)) return null;
  const canary = CANARY_NAME.test(name);
  if (canary) return { name, value, canary };
  if (looksLikeToken(value)) return { name, value, canary: false };
  if (EXCLUDED_NAME.test(name) || !SECRET_NAME.test(name)) return null;
  return { name, value, canary: false };
}

/** dotenv, ini (AWS credentials) and npmrc lines: `NAME=VALUE`. */
export function extractKeyValues(text: string): ExtractedSecret[] {
  return text
    .slice(0, MAX_TEXT_CHARS)
    .split('\n')
    .slice(0, MAX_LINES)
    .flatMap((raw) => {
      const line = raw.slice(0, MAX_LINE_CHARS);
      if (/^\s*[#;]/.test(line)) return [];
      const m = KEY_VALUE.exec(line);
      if (!m) return [];
      const found = classify(m[1] ?? '', unquote(stripInlineComment(m[2] ?? '')));
      return found ? [found] : [];
    });
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
