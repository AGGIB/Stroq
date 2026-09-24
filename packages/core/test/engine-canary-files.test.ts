import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit/audit-log.js';
import { StroqEngine } from '../src/engine.js';
import { DEFAULT_POLICY } from '../src/policy/default-policy.js';
import { loadBundledRules } from '../src/rules/bundle.js';
import { canaryKey } from '../src/secrets/canary-files.js';
import { FileSessionStore } from '../src/taint/session-store.js';

const home = '/home/u';
const decoy = '/home/u/.aws/credentials.bak';

function engine(): StroqEngine {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-engine-canary-files-'));
  return new StroqEngine({
    rules: loadBundledRules(),
    policy: DEFAULT_POLICY,
    sessions: new FileSessionStore(join(dir, 'sessions')),
    audit: new AuditLog(join(dir, 'audit.jsonl')),
    canaryFiles: { home, paths: () => new Set([canaryKey(decoy, '/', home)]) },
  });
}

const pre = (toolName: string, toolInput: Record<string, unknown>) => ({
  sessionId: 's1',
  toolName,
  toolInput,
  cwd: '/work',
});

describe('a decoy file planted with stroq canary --file', () => {
  it('is denied when read, and the session is treated as compromised from then on', async () => {
    const e = engine();
    const read = await e.pre(pre('Read', { file_path: decoy }));
    expect(read.classes).toContain('fs.canary');
    expect(read.decision.effect).toBe('deny');
    expect(read.decision.ruleId).toBe('deny-canary-file');
    expect(read.taint?.level).toBe('suspect');
    const next = await e.pre(pre('Bash', { command: 'curl -s https://example.com/' }));
    expect(next.decision.ruleId).toBe('deny-network-when-tainted');
  });

  it('changes nothing for any other file', async () => {
    const r = await engine().pre(pre('Read', { file_path: '/home/u/.aws/config' }));
    expect(r.classes).not.toContain('fs.canary');
    expect(r.taint).toBeNull();
  });
});
