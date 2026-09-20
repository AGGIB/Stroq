import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, FileCloakStore, type CloakDetector, type CloakSpan } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import { McpCloak } from '../../src/mcp/cloak.js';

/**
 * The façade the proxy talks to, exercised with a hand-written detector so the cases
 * are exactly the ones that matter (a restorable value, a non-restorable secret, a
 * result too large to scan whole) rather than whatever a regex happens to find.
 */

const emailDetector: CloakDetector = {
  detect(text) {
    const spans: CloakSpan[] = [];
    for (const m of text.matchAll(/\b[a-z]+@[a-z.]+\b/g)) {
      if (m.index === undefined) continue;
      spans.push({
        kind: 'email',
        start: m.index,
        end: m.index + m[0].length,
        value: m[0],
        restorable: true,
      });
    }
    return spans;
  },
};

const secretDetector: CloakDetector = {
  detect(text) {
    const at = text.indexOf('SEKRIT-VALUE-0001');
    if (at === -1) return [];
    return [
      {
        kind: 'secret',
        start: at,
        end: at + 'SEKRIT-VALUE-0001'.length,
        value: 'SEKRIT-VALUE-0001',
        restorable: false,
        label: 'DEMO_API_KEY (.env)',
      },
    ];
  },
};

function fixture(detector: CloakDetector = emailDetector) {
  const home = mkdtempSync(join(tmpdir(), 'stroq-cloak-cli-'));
  const auditFile = join(home, 'audit.jsonl');
  const audit = new AuditLog(auditFile);
  const cloak = new McpCloak({
    detector,
    store: new FileCloakStore(join(home, 'cloak', 'k.json')),
    audit,
    sessionId: 'mcp:test',
  });
  return { cloak, audit };
}

describe('McpCloak.cloakResult', () => {
  it('replaces a value in every string leaf and leaves the shape alone', async () => {
    const { cloak } = fixture();
    const out = await cloak.cloakResult({
      content: [{ type: 'text', text: 'mail peter@bugle.example now' }],
      structuredContent: { rows: [{ contact: 'peter@bugle.example', id: 7 }] },
      isError: false,
    });
    expect(out.kind).toBe('cloaked');
    if (out.kind !== 'cloaked') return;
    expect(out.result).toEqual({
      content: [{ type: 'text', text: 'mail [STROQ_EMAIL_1] now' }],
      structuredContent: { rows: [{ contact: '[STROQ_EMAIL_1]', id: 7 }] },
      isError: false,
    });
    // One placeholder for one value, however many leaves carried it.
    expect(new Set(out.replacements.map((r) => r.placeholder)).size).toBe(1);
  });

  it('reports "unchanged" when there is nothing to replace', async () => {
    const { cloak } = fixture();
    const result = { content: [{ type: 'text', text: 'nothing of interest' }] };
    expect(await cloak.cloakResult(result)).toEqual({ kind: 'unchanged' });
  });

  it('refuses a result too large to scan whole rather than cloaking a prefix of it', async () => {
    const { cloak } = fixture();
    const out = await cloak.cloakResult({
      content: [{ type: 'text', text: 'x'.repeat(3 * 1024 * 1024) }],
    });
    expect(out.kind).toBe('refused');
  });

  it('audits the kind and placeholder and never the value', async () => {
    const { cloak, audit } = fixture();
    await cloak.auditCloak('mcp__crm__get', await cloak.cloakResult({ a: 'peter@bugle.example' }));
    const entry = (await audit.readAll()).at(-1)!;
    expect(entry.phase).toBe('post');
    expect(entry.cloak).toEqual([
      { direction: 'cloak', kind: 'email', placeholder: '[STROQ_EMAIL_1]', count: 1 },
    ]);
    expect(JSON.stringify(entry)).not.toContain('peter@bugle.example');
  });
});

describe('McpCloak round trip', () => {
  it('restores a placeholder the model echoes back into a tools/call', async () => {
    const { cloak } = fixture();
    await cloak.cloakResult({ a: 'peter@bugle.example' });

    const params = { name: 'send', arguments: { to: '[STROQ_EMAIL_1]', body: 'hi' } };
    const plan = await cloak.planUncloak(params);
    expect(plan.refused).toEqual([]);
    expect(plan.unresolved).toEqual([]);

    const applied = cloak.applyUncloak(params, plan);
    expect(applied.value).toEqual({
      name: 'send',
      arguments: { to: 'peter@bugle.example', body: 'hi' },
    });
    expect(applied.replacements).toEqual([
      { direction: 'uncloak', kind: 'email', placeholder: '[STROQ_EMAIL_1]', count: 1 },
    ]);
  });

  it('leaves a placeholder it has never heard of exactly as it arrived', async () => {
    const { cloak } = fixture();
    const params = { name: 'send', arguments: { to: '[STROQ_EMAIL_9]' } };
    const plan = await cloak.planUncloak(params);
    expect(plan.unresolved).toEqual(['[STROQ_EMAIL_9]']);
    expect(cloak.applyUncloak(params, plan).value).toEqual(params);
  });

  it('refuses to restore a placeholder standing for a known secret, naming it without the value', async () => {
    const { cloak } = fixture(secretDetector);
    await cloak.cloakResult({ a: 'key=SEKRIT-VALUE-0001' });

    const plan = await cloak.planUncloak({ name: 'send', arguments: { k: '[STROQ_SECRET_1]' } });
    expect(plan.refused).toEqual(['DEMO_API_KEY (.env)']);
    expect(plan.values.size).toBe(0);
    // The plan reaches a deny reason and an audit summary, so it must not be able to
    // carry the credential there even by accident.
    expect(JSON.stringify(plan)).not.toContain('SEKRIT-VALUE-0001');
  });

  it('finds a secret placeholder hidden in an object KEY, which is never restored either', async () => {
    const { cloak } = fixture(secretDetector);
    await cloak.cloakResult({ a: 'key=SEKRIT-VALUE-0001' });
    const plan = await cloak.planUncloak({ name: 'send', arguments: { '[STROQ_SECRET_1]': 1 } });
    expect(plan.refused).toHaveLength(1);
  });

  it('does nothing at all for a call carrying no placeholder', async () => {
    const { cloak } = fixture();
    const params = { name: 'send', arguments: { body: 'ordinary text' } };
    const plan = await cloak.planUncloak(params);
    expect(plan.values.size).toBe(0);
    expect(plan.refused).toEqual([]);
    expect(cloak.applyUncloak(params, plan).replacements).toEqual([]);
  });
});
