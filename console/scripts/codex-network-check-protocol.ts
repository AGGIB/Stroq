import { createHash } from 'node:crypto';
import { parseJsonDocument } from '../../packages/cli/src/harden/json-doc.js';
import type { CodexNetworkGuardCheckPreparation } from '../lib/codex-network-guard-check-private';
import type { CodexNetworkCheckProbe } from '../lib/codex-network-check';

export const NETWORK_CHECK_PROTOCOL_VERSION = 'stroq-codex-network-canary/1';
export const NETWORK_CHECK_SUITE_VERSION = 'stroq-codex-network-suite/1';
export const NETWORK_CHECK_PINNED_NATIVE_SHA256 =
  'a04752e4d46a4d89e53e6f61c59c5349a638c8ce172ffbf391fd482b4d902a4e';
export const NETWORK_CHECK_SCRATCH_PREFIX = 'stroq-console-net-';
export const NETWORK_CHECK_MARKER = '.stroq-live-throwaway';
export const NETWORK_CHECK_MARKER_TEXT =
  'made by stroq prove: everything in this directory may be removed\n';
export const NETWORK_CHECK_CONNECT_TIMEOUT_MS = 1000;
export type NetworkProfileCopy = Pick<
  CodexNetworkGuardCheckPreparation,
  'kind' | 'profiles' | 'selectedProfile' | 'networkOff'
>;
export type CanaryCode = 'allowed' | 'EPERM' | 'EACCES' | 'error';
export interface CanaryWire {
  schema: string;
  nonce: string;
  results: { id: 'tcp' | 'unix'; attempted: true; code: CanaryCode }[];
}
const plain = (v: unknown): v is Record<string, any> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
const exact = (v: unknown, names: string[]): v is Record<string, any> =>
  plain(v) && Reflect.ownKeys(v).length === names.length && names.every((k) => Object.hasOwn(v, k));
export const networkCheckFail = (code: string): never => {
  throw new Error(code);
};

/** Reject non-JSON values and accessors; ordering is independent of capture object insertion order. */
export function canonicalJSON(value: unknown): string {
  const seen = new Set<object>();
  const encode = (v: unknown, depth: number): string => {
    if (depth > 64) return networkCheckFail('invalid-input');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number')
      return Number.isFinite(v) ? JSON.stringify(v) : networkCheckFail('invalid-input');
    if (typeof v !== 'object' || seen.has(v) || (!Array.isArray(v) && !plain(v)))
      return networkCheckFail('invalid-input');
    if (
      Reflect.ownKeys(v).some((k) => typeof k !== 'string') ||
      (Array.isArray(v) &&
        (Object.keys(v).length !== v.length || Object.keys(v).some((k, i) => k !== String(i))))
    )
      return networkCheckFail('invalid-input');
    seen.add(v);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Object.values(descriptors).some((d) => !Object.hasOwn(d, 'value')))
      return networkCheckFail('invalid-input');
    const result = Array.isArray(v)
      ? '[' + v.map((x) => encode(x, depth + 1)).join(',') + ']'
      : '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + encode(descriptors[k]!.value, depth + 1))
          .join(',') +
        '}';
    seen.delete(v);
    return result;
  };
  return encode(value, 0);
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export function getProfileCopySha(copy: NetworkProfileCopy): string {
  return digest(
    canonicalJSON({
      kind: copy.kind,
      selectedProfile: copy.selectedProfile,
      profiles: copy.profiles,
      networkOff: true,
    }),
  );
}

/** Fixed program: only two literal local endpoints supplied by the engine, never user command text. */
export const NETWORK_CHECK_CANARY_SOURCE = `'use strict';
const net = require('node:net');
const [nonce, portText, socketPath] = process.argv.slice(1);
const port = Number(portText);
if (!/^[a-f0-9]{64}$/.test(nonce || '') || !Number.isInteger(port) || port < 1 || port > 65535 || typeof socketPath !== 'string' || !socketPath.startsWith('/')) process.exit(3);
function probe(id, target) {
  return new Promise(resolve => {
    let socket, done = false;
    const finish = code => { if (done) return; done = true; socket?.destroy(); resolve({ id, attempted: true, code }); };
    try {
      socket = net.createConnection(target);
      socket.once('connect', () => finish('allowed'));
      socket.once('error', error => finish(error.code === 'EPERM' || error.code === 'EACCES' ? error.code : 'error'));
      socket.setTimeout(${NETWORK_CHECK_CONNECT_TIMEOUT_MS}, () => finish('error'));
    } catch (error) { finish(error.code === 'EPERM' || error.code === 'EACCES' ? error.code : 'error'); }
  });
}
Promise.all([probe('tcp', { host: '127.0.0.1', port }), probe('unix', { path: socketPath })]).then(results => process.stdout.write(JSON.stringify({ schema: '${NETWORK_CHECK_PROTOCOL_VERSION}', nonce, results }) + '\\n'));
`;
export function getSuiteSha(): string {
  return digest(
    canonicalJSON({
      version: NETWORK_CHECK_SUITE_VERSION,
      protocol: NETWORK_CHECK_PROTOCOL_VERSION,
      program: NETWORK_CHECK_CANARY_SOURCE,
      command: [
        'sandbox',
        '--permission-profile=<selected>',
        '--cd=<fixture>',
        '--',
        '<node>',
        '-e',
        '<program>',
        '<nonce>',
        '<port>',
        '<socket>',
      ],
    }),
  );
}

/** The backend validates field types. Independently reject unresolved/cyclic graphs and network-on selection. */
export function validateNetworkCopy(copy: NetworkProfileCopy): boolean {
  if (
    !plain(copy) ||
    !['profile', 'legacy-translated', 'implicit-translated'].includes(copy.kind) ||
    copy.networkOff !== true ||
    !plain(copy.profiles) ||
    Object.keys(copy.profiles).length > 16 ||
    typeof copy.selectedProfile !== 'string'
  )
    return false;
  const resolve = (id: string, stack: Set<string>): boolean | null => {
    if (id === ':workspace' || id === ':read-only') return false;
    if (id.startsWith(':') || stack.has(id) || stack.size >= 16) return null;
    const p = copy.profiles[id];
    if (!plain(p)) return null;
    const next = new Set(stack);
    next.add(id);
    const parent =
      p.extends === undefined
        ? false
        : typeof p.extends === 'string'
          ? resolve(p.extends, next)
          : null;
    if (parent === null) return null;
    return p.network?.enabled === undefined
      ? parent
      : typeof p.network.enabled === 'boolean'
        ? p.network.enabled
        : null;
  };
  return (
    Object.keys(copy.profiles).every(
      (id) => !id.startsWith(':') && resolve(id, new Set()) !== null,
    ) && resolve(copy.selectedProfile, new Set()) === false
  );
}
export function serializeProfileCopy(copy: NetworkProfileCopy): string {
  if (!validateNetworkCopy(copy)) return networkCheckFail('unsupported');
  const toml = (v: any): string => {
    if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number')
      return JSON.stringify(v);
    if (!plain(v)) return networkCheckFail('invalid-input');
    return (
      '{ ' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ' = ' + toml(v[k]))
        .join(', ') +
      ' }'
    );
  };
  return (
    'default_permissions = ' +
    JSON.stringify(copy.selectedProfile) +
    '\npermissions = ' +
    toml(copy.profiles) +
    '\n'
  );
}
export function decodeCanaryWire(text: string, nonce: string): CanaryWire | null {
  try {
    const parsed = parseJsonDocument(text);
    if (!parsed.ok) return null;
    const v: unknown = parsed.doc;
    if (
      !exact(v, ['schema', 'nonce', 'results']) ||
      v.schema !== NETWORK_CHECK_PROTOCOL_VERSION ||
      v.nonce !== nonce ||
      !Array.isArray(v.results) ||
      v.results.length !== 2
    )
      return null;
    if (
      !v.results.every(
        (r: unknown, i: number) =>
          exact(r, ['id', 'attempted', 'code']) &&
          r.id === ['tcp', 'unix'][i] &&
          r.attempted === true &&
          ['allowed', 'EPERM', 'EACCES', 'error'].includes(r.code),
      )
    )
      return null;
    return v as unknown as CanaryWire;
  } catch {
    return null;
  }
}
export function projectNetworkChecks(
  wire: CanaryWire | null,
  positive: number[],
  connections: number[],
): CodexNetworkCheckProbe[] {
  if ([...positive, ...connections].some((n) => !Number.isInteger(n) || n < 0 || n > 1))
    return networkCheckFail('invalid-report');
  return (['tcp', 'unix'] as const).map((id, i) => {
    const r = wire?.results[i],
      count = connections[i] ?? 0;
    if (r?.code === 'allowed' && count === 1)
      return {
        id,
        positiveConnections: positive[i] ?? 0,
        attempted: true,
        effect: 'allowed',
        connections: 1,
        errno: null,
      };
    if (r && (r.code === 'EPERM' || r.code === 'EACCES') && count === 0)
      return {
        id,
        positiveConnections: positive[i] ?? 0,
        attempted: true,
        effect: 'denied',
        connections: 0,
        errno: r.code,
      };
    if (count !== 0) return networkCheckFail('invalid-report');
    return {
      id,
      positiveConnections: positive[i] ?? 0,
      attempted: r !== undefined,
      effect: r ? 'error' : 'unreached',
      connections: 0,
      errno: null,
    };
  });
}
