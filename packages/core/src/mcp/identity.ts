/** A producer's exact reported server name, not endpoint or cryptographic identity. */
export const MCP_IDENTITY_CHANNELS = [
  'claude-code',
  'codex',
  'cursor',
  'windsurf',
  'mcp-proxy',
] as const;
export type McpIdentityChannel = (typeof MCP_IDENTITY_CHANNELS)[number];
export const MCP_IDENTITY_UNAVAILABLE_REASONS = [
  'missing',
  'invalid',
  'ambiguous',
  'overlong',
] as const;
export type McpIdentityUnavailableReason = (typeof MCP_IDENTITY_UNAVAILABLE_REASONS)[number];
export type McpIdentity =
  | { readonly kind: 'server'; readonly channel: McpIdentityChannel; readonly name: string }
  | {
      readonly kind: 'unavailable';
      readonly channel: McpIdentityChannel;
      readonly reason: McpIdentityUnavailableReason;
    };

const SERVER_BYTES = 256;
const ENCODED_BYTES = 1024;
const hidden =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff\uD800-\uDFFF]/u;
const encoder = new TextEncoder();
const channel = (v: unknown): v is McpIdentityChannel =>
  typeof v === 'string' && (MCP_IDENTITY_CHANNELS as readonly string[]).includes(v);
const withinBytes = (v: string, limit: number) =>
  v.length <= limit && encoder.encode(v).length <= limit;
const visible = (v: string) => v.length > 0 && v.trim() === v && !hidden.test(v);
const validName = (v: unknown): v is string =>
  typeof v === 'string' && withinBytes(v, SERVER_BYTES) && visible(v);
const unavailable = (
  source: McpIdentityChannel,
  reason: McpIdentityUnavailableReason,
): McpIdentity => Object.freeze({ kind: 'unavailable', channel: source, reason });

/** No normalization: distinct raw config keys must never authorize each other's calls. */
export function mcpIdentityFromServer(source: McpIdentityChannel, name: unknown): McpIdentity {
  if (!channel(source)) throw new TypeError('invalid-mcp-identity-channel');
  if (name === undefined || name === '') return unavailable(source, 'missing');
  if (typeof name === 'string' && !withinBytes(name, SERVER_BYTES))
    return unavailable(source, 'overlong');
  if (!validName(name)) return unavailable(source, 'invalid');
  return Object.freeze({ kind: 'server', channel: source, name });
}

/** Only Claude/Codex report identity in this original encoded envelope. */
export function mcpIdentityFromEncodedTool(
  source: 'claude-code' | 'codex',
  raw: unknown,
): McpIdentity | undefined {
  if (source !== 'claude-code' && source !== 'codex')
    throw new TypeError('invalid-mcp-identity-channel');
  if (typeof raw !== 'string' || !raw.startsWith('mcp__')) return undefined;
  if (!withinBytes(raw, ENCODED_BYTES)) return unavailable(source, 'overlong');
  const rest = raw.slice(5),
    separator = rest.indexOf('__');
  if (separator < 1 || separator + 2 >= rest.length) return unavailable(source, 'invalid');
  if (separator !== rest.lastIndexOf('__')) return unavailable(source, 'ambiguous');
  const name = rest.slice(0, separator),
    tool = rest.slice(separator + 2);
  if (/^_|_$/.test(name) || /^_|_$/.test(tool)) return unavailable(source, 'ambiguous');
  if (!visible(tool)) return unavailable(source, 'invalid');
  return mcpIdentityFromServer(source, name);
}

/**
 * One own-data snapshot. Authorization must consume this clone rather than read the
 * original again: a Proxy's get trap can disagree with its property descriptors.
 */
export function snapshotMcpIdentity(value: unknown): McpIdentity | null {
  try {
    if (value === null || typeof value !== 'object') return null;
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || !keys.every((k) => typeof k === 'string')) return null;
    const data = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)]));
    if ([...data.values()].some((v) => !v || !Object.hasOwn(v, 'value'))) return null;
    const kind = data.get('kind')?.value,
      source = data.get('channel')?.value;
    if (!channel(source)) return null;
    if (kind === 'server' && data.has('name') && validName(data.get('name')?.value))
      return Object.freeze({ kind, channel: source, name: data.get('name')!.value as string });
    const reason = data.get('reason')?.value;
    if (
      kind !== 'unavailable' ||
      !(MCP_IDENTITY_UNAVAILABLE_REASONS as readonly unknown[]).includes(reason)
    )
      return null;
    return unavailable(source, reason as McpIdentityUnavailableReason);
  } catch {
    return null;
  }
}

/** Shape check only; use snapshotMcpIdentity when making an authorization decision. */
export function isMcpIdentity(value: unknown): value is McpIdentity {
  return snapshotMcpIdentity(value) !== null;
}
