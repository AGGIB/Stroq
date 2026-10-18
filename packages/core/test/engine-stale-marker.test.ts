import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit/audit-log.js';
import { StroqEngine } from '../src/engine.js';
import { DEFAULT_POLICY } from '../src/policy/default-policy.js';
import { FileProvenanceStore } from '../src/provenance/store.js';
import { loadBundledRules } from '../src/rules/bundle.js';
import { FileSessionStore } from '../src/taint/session-store.js';

// A marker that is still there long after the hook's deadline is a result the agent read and
// Stroq could not scan: whatever it said, the next command that sends something out is asked
// about, as one that carries a package nobody recorded is.

const cwd = mkdtempSync(join(tmpdir(), 'stroq-stale-cwd-'));
const MINUTE = 60_000;

function fixture(markedAt: Date | null) {
  const home = mkdtempSync(join(tmpdir(), 'stroq-stale-'));
  const dir = join(home, 'sessions');
  const provenance = new FileProvenanceStore(dir, () => markedAt ?? new Date());
  const engine = new StroqEngine({
    rules: loadBundledRules(),
    policy: DEFAULT_POLICY,
    sessions: new FileSessionStore(dir),
    audit: new AuditLog(join(home, 'audit.jsonl')),
    provenance,
  });
  const pre = (command: string) =>
    engine.pre({ sessionId: 's1', toolName: 'Bash', toolInput: { command }, cwd });
  return { provenance, engine, pre, home };
}

const sessionsDirOf = (home: string): string => join(home, 'sessions');

describe('a result that was read and could not be scanned', () => {
  it('makes a command that sends something out a question, once the marker is stale', async () => {
    const f = fixture(new Date(Date.now() - 5 * MINUTE));
    await f.provenance.setPending('s1', true, 'killed-post');
    const r = await f.pre('curl -s https://api.example.org/v1/items');
    expect(r.decision).toMatchObject({ effect: 'ask', ruleId: 'ask-origin-untrusted' });
    expect(r.classes).toContain('origin.untrusted');
    expect(r.decision.reason).toMatch(/could not be scanned/i);
    expect(r.decision.reason).toContain('stroq untaint --session s1');
  });

  it('leaves a command that sends nothing out alone', async () => {
    const f = fixture(new Date(Date.now() - 5 * MINUTE));
    await f.provenance.setPending('s1', true, 'killed-post');
    expect((await f.pre('ls -la')).decision.effect).toBe('allow');
    expect((await f.pre('git status')).decision.effect).toBe('allow');
  });

  it('leaves a marker that is only a result in flight alone', async () => {
    const f = fixture(null);
    await f.provenance.setPending('s1', true, 'in-flight');
    expect((await f.pre('curl -s https://api.example.org/v1/items')).decision.effect).toBe('allow');
  });

  it('is answered once the session is cleared, which is what untaint does', async () => {
    const f = fixture(new Date(Date.now() - 5 * MINUTE));
    await f.provenance.setPending('s1', true, 'killed-post');
    await f.provenance.clear('s1');
    expect((await f.pre('curl -s https://api.example.org/v1/items')).decision.effect).toBe('allow');
  });

  it('measures the age of a marker at the time it is asked', async () => {
    const f = fixture(null);
    await f.provenance.setPending('s1', true, 'later');
    expect(await f.provenance.hasStaleMarker('s1', MINUTE, Date.now())).toBe(false);
    expect(await f.provenance.hasStaleMarker('s1', MINUTE, Date.now() + 10 * MINUTE)).toBe(true);
  });

  it('reads a marker with no readable time as stale', async () => {
    const f = fixture(null);
    await f.provenance.setPending('s1', true, 'odd');
    const dir = readdirSync(join(sessionsDirOf(f.home), '.')).find((n) =>
      n.endsWith('.prov.pending.d'),
    );
    writeFileSync(join(sessionsDirOf(f.home), dir ?? '', 'odd'), 'not json');
    expect(await f.provenance.hasStaleMarker('s1', MINUTE)).toBe(true);
  });
});
