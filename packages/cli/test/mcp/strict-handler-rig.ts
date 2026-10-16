import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StroqEngine } from '@stroq/core';
import { afterEach } from 'vitest';
import { createStrictHandler, type StrictHandlerDeps } from '../../src/mcp/strict-handler.js';
import { StrictLedger } from '../../src/mcp/strict-ledger.js';
import type { SplitLine } from '../../src/mcp/framing.js';

/**
 * `createStrictHandler` with every dependency injected: no process, no streams, no scan
 * clock. A test hands it server lines and reads what it would have written to the client
 * (`sent`, `lines`), to the server (`toServer`), the number of times it asked for the
 * server to be stopped and the audit it left in a private Stroq home.
 */

export interface HandlerRig {
  readonly ledger: StrictLedger;
  readonly sent: unknown[];
  readonly lines: string[];
  readonly toServer: unknown[];
  readonly notes: string[];
  readonly terminated: () => number;
  readonly home: string;
  /** Feeds one server line to the handler. */
  feed(text: string, options?: Partial<SplitLine>): Promise<void>;
  /** The audit entries, parsed. */
  audit(): Record<string, unknown>[];
  /** The audit entries' rule ids. */
  ruleIds(): string[];
  readonly handler: ReturnType<typeof createStrictHandler>;
}

/** An engine whose scan always comes back clean: the handler's own decisions are what is tested. */
const cleanEngine = {
  post: async () => ({
    scan: { verdict: 'clean', score: 0, matches: [] },
    taint: null,
    scanned: true,
    atoms: [],
    provenanceError: null,
  }),
} as unknown as StroqEngine;

/** The homes handler rigs made and the value of STROQ_HOME before the first, put back after each test. */
const homes: string[] = [];
let homeBefore: { value: string | undefined } | null = null;

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (homeBefore === null) return;
  if (homeBefore.value === undefined) delete process.env['STROQ_HOME'];
  else process.env['STROQ_HOME'] = homeBefore.value;
  homeBefore = null;
});

export function handlerRig(overrides: Partial<StrictHandlerDeps> = {}): HandlerRig {
  const home = mkdtempSync(join(tmpdir(), 'stroq-handler-home-'));
  homes.push(home);
  homeBefore ??= { value: process.env['STROQ_HOME'] };
  process.env['STROQ_HOME'] = home;
  const ledger = new StrictLedger();
  const sent: unknown[] = [];
  const lines: string[] = [];
  const toServer: unknown[] = [];
  const notes: string[] = [];
  let terminated = 0;
  const handler = createStrictHandler({
    ctx: { engine: cleanEngine, sessionId: 'mcp:unit', server: 'srv', cwd: home },
    ledger,
    cloak: null,
    maxWithheld: 20,
    scan: () => 'ok',
    toClient: async (value) => {
      sent.push(value);
    },
    toClientLine: async (line) => {
      lines.push(line);
    },
    toServer: (value) => {
      toServer.push(value);
    },
    terminate: () => {
      terminated += 1;
    },
    note: (text) => {
      notes.push(text);
    },
    ...overrides,
  });
  const rig: HandlerRig = {
    ledger,
    sent,
    lines,
    toServer,
    notes,
    terminated: () => terminated,
    home,
    handler,
    feed: (text, options = {}) =>
      handler.onServerLine({ text, eol: '\n', oversize: false, ...options }),
    audit: () => {
      const file = join(home, 'audit.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    ruleIds: () =>
      rig
        .audit()
        .map((entry) => (entry['decision'] as { ruleId?: string } | undefined)?.ruleId)
        .filter((id): id is string => typeof id === 'string'),
  };
  return rig;
}

/** Tracks a client request on the rig's ledger the way the pump does. */
export const track = (
  rig: HandlerRig,
  id: string | number,
  method = 'tools/call',
  toolName = 'mcp__srv__t',
): void => rig.ledger.track({ id, method, toolName });
