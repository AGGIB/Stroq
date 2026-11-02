// Taking out of a command the credentials Stroq does not hold as keys.
//
// The evidence of a place keeps the call's text (`evidence.ts`), and a command carries secrets that no key file
// holds: a password in a URL, `curl -u user:pass`, an `Authorization` header, `API_TOKEN=…` in front of a program, a
// long random string. Before a text is kept or cached these are replaced by a marker, by what they look like and
// not by what they are. The text is read for the shapes below and nothing else; a secret in a shape not listed
// stays, which is why the text is cut to a few hundred characters and why it is the user's own machine's file.
//
// Every expression is linear: classes that do not share a delimiter, no nested repetition.

/** A marker for a replaced text, and for one already replaced (a key Stroq holds): left alone here. */
export const OPEN = '\u0001';
export const CLOSE = '\u0002';

const secret = `${OPEN}secret${CLOSE}`;

/** Whether a value is already a marker, or a reference to a variable: nothing to take out. */
const spared = (value: string): boolean =>
  value === '' || value.includes(OPEN) || value.startsWith('$') || value.startsWith('<');

/** A value token: up to a blank, a quote, or a shell separator. */
const TOKEN = `[^\\s"'\`;|&()<>${OPEN}${CLOSE}]+`;

const rule = (
  pattern: RegExp,
  replace: (match: string, ...groups: string[]) => string,
): ((text: string) => string) => {
  return (text) => text.replace(pattern, (match, ...rest) => replace(match, ...(rest as string[])));
};

/** Names of variables and fields that hold a secret. */
const SECRET_NAME = /password|passwd|pwd|token|secret|key|credential|auth/i;

const RULES: readonly ((text: string) => string)[] = [
  // `scheme://user:password@host`
  rule(
    /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/)([^\s/?#@:'"\u0001\u0002]*):([^\s/?#@'"\u0001\u0002]*)@/gi,
    (match, scheme = '', _user = '', password = '') =>
      spared(password) ? match : `${scheme}${secret}@`,
  ),
  // `curl -u user:password`, `--user user:password`, `--user=user:password`, `-uuser:password`
  rule(
    new RegExp(`(^|[\\s;|&(])(-u\\s*|--user(?:=|\\s+))([^\\s:"'\\u0001\\u0002]+:${TOKEN})`, 'g'),
    (_m, before = '', option = '') => `${before}${option}${secret}`,
  ),
  // `mysql -pPASSWORD`, `sshpass -p PASSWORD`
  rule(
    new RegExp(
      `(\\b(?:mysql|mysqldump|mysqladmin|mariadb)\\w*\\b[^;|&\\n\\u0001]{0,300}?\\s)-p(${TOKEN})`,
      'g',
    ),
    (match, before = '', value = '') => (spared(value) ? match : `${before}-p${secret}`),
  ),
  rule(
    new RegExp(`(\\bsshpass\\s+(?:-\\w+\\s+)*-p\\s*)(${TOKEN})`, 'g'),
    (match, before = '', value = '') => (spared(value) ? match : `${before}${secret}`),
  ),
  // `--password x`, `--token=x`, `--api-key x`, ...
  rule(
    new RegExp(
      `(--(?:password|passwd|pass|token|secret|api-key|apikey|access-key|secret-key|auth-token|bearer|credentials?)(?:=|\\s+))(${TOKEN})`,
      'gi',
    ),
    (match, before = '', value = '') => (spared(value) ? match : `${before}${secret}`),
  ),
  // `Authorization: Bearer x`, `Proxy-Authorization: Basic x`
  rule(
    new RegExp(
      `(\\b(?:proxy-)?authorization\\s*:\\s*(?:bearer|basic|token|digest|negotiate)\\s+)(${TOKEN})`,
      'gi',
    ),
    (match, before = '', value = '') => (spared(value) ? match : `${before}${secret}`),
  ),
  // `Authorization: x`, with a scheme word left to the rule above (a marker may follow it)
  rule(
    new RegExp(
      `(\\b(?:proxy-)?authorization\\s*:\\s*)(?!(?:bearer|basic|token|digest|negotiate)\\b)(${TOKEN})`,
      'gi',
    ),
    (match, before = '', value = '') => (spared(value) ? match : `${before}${secret}`),
  ),
  // `X-Api-Key: x`, `X-Auth-Token: x`
  rule(
    new RegExp(
      `((?<![\\w-])x-[\\w-]*(?:key|token|secret|auth|password)[\\w-]*\\s*:\\s*)(${TOKEN})`,
      'gi',
    ),
    (match, before = '', value = '') => (spared(value) ? match : `${before}${secret}`),
  ),
  // `Cookie: a=b; c=d`, up to the end of the quoted header
  rule(/(\b(?:set-)?cookie\s*:\s*)([^"'\n\u0001\u0002]+)/gi, (match, before = '', value = '') =>
    spared(value.trim()) ? match : `${before}${secret}`,
  ),
  // `"password": "x"` and its kin in a JSON body
  rule(
    /("(?:password|passwd|secret|token|api_?key|access_?key|private_?key|client_?secret|auth|authorization)"\s*:\s*)"([^"\u0001\u0002]*)"/gi,
    (match, before = '', value = '') => (spared(value) ? match : `${before}"${secret}"`),
  ),
  // `DB_PASSWORD=x`, `export API_TOKEN="x y"`, `AWS_SECRET_ACCESS_KEY='x'`: a name that says what it holds
  rule(
    /(?<![\w.-])([A-Za-z_][\w.-]*=)("[^"\n\u0001\u0002]*"|'[^'\n\u0001\u0002]*'|[^\s"'`;|&()<>\u0001\u0002]+)/g,
    (match, before = '', value = '') => {
      const bare = value.replace(/^["']|["']$/g, '');
      return SECRET_NAME.test(before) && !spared(bare) ? `${before}${secret}` : match;
    },
  ),
];

/** Shannon entropy of a text, in bits for each character. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** The fewest characters of a run taken for a secret by its look, and the entropy it needs. */
const MIN_RUN = 24;
const MIN_ENTROPY = 4;
/** Hex runs: a git object name (40) is not a secret; any other long one may be. */
const MIN_HEX = 32;
const GIT_OBJECT = 40;

/** Whether a run of token characters looks like a secret: long and random, or a long hex string. */
function looksRandom(run: string): boolean {
  if (/^[0-9a-f]+$/i.test(run))
    return (
      run.length >= MIN_HEX && run.length !== GIT_OBJECT && /[a-f]/i.test(run) && /\d/.test(run)
    );
  return (
    run.length >= MIN_RUN && /\d/.test(run) && /[A-Za-z]/.test(run) && entropy(run) >= MIN_ENTROPY
  );
}

/** `text` without the credentials of the shapes above; what is already a marker is left as it is. */
export function redactCredentials(text: string): string {
  let out = text;
  for (const redact of RULES) out = redact(out);
  // Long random runs, in the stretches between markers.
  const markers = new RegExp(`${OPEN}[^${CLOSE}]*${CLOSE}`, 'g');
  const parts = out.split(markers);
  const held = out.match(markers) ?? [];
  const cleaned = parts.map((part) =>
    part.replace(/[A-Za-z0-9_+/=-]{24,}/g, (run) => (looksRandom(run) ? secret : run)),
  );
  return cleaned.map((part, i) => `${part}${held[i] ?? ''}`).join('');
}
