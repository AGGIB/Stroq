import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit-log.js';
import { StroqEngine } from '../../src/engine.js';
import { DEFAULT_POLICY } from '../../src/policy/default-policy.js';
import { FileProvenanceStore } from '../../src/provenance/store.js';
import { loadBundledRules } from '../../src/rules/bundle.js';
import { HARD_CLASSES } from '../../src/scope/hard-set.js';
import { FileSessionStore } from '../../src/taint/session-store.js';
import { gateFixture } from './gate-fixture.js';
import { PROJECT, SESSION } from './helpers.js';

// The ask that incomplete provenance produces is `origin.untrusted` with no record behind it.
// In a task, where nobody can answer, it must become a refusal the task's owner can lift for
// that one call. A flagged record's `origin.suspect` is in the hard set, which no scope can
// lift; uncertainty is not evidence, and the hard set is only evidence.
describe('incomplete provenance in a task, through the real gate', () => {
  const taskEngine = () => {
    const f = gateFixture();
    const home = mkdtempSync(join(tmpdir(), 'stroq-gate-incomplete-'));
    const dir = join(home, 'sessions');
    const provenance = new FileProvenanceStore(dir);
    const engine = new StroqEngine({
      rules: loadBundledRules(),
      policy: DEFAULT_POLICY,
      sessions: new FileSessionStore(dir),
      audit: new AuditLog(join(home, 'audit.jsonl')),
      provenance,
      scope: f.gate,
    });
    const run = (command: string) =>
      engine.pre({
        sessionId: SESSION,
        toolName: 'Bash',
        toolInput: { command },
        cwd: PROJECT,
      });
    return { run, provenance };
  };

  it('refuses an unrecorded package with a way to extend it, and not as a hard class', async () => {
    const { run, provenance } = taskEngine();
    expect((await run('npx evil-helper-fix')).decision.effect).toBe('allow');

    await provenance.markIncomplete(SESSION);
    const r = await run('npx evil-helper-fix');

    expect(r.classes).toContain('origin.untrusted');
    expect(r.decision.effect).toBe('deny');
    expect(r.decision.ruleId).toBe('task-ask:ask-origin-untrusted');
    expect(r.decision.reason).toMatch(/to extend: stroq permit extend fix-login-1 [0-9a-f]{64}/);
    expect(r.decision.reason).toMatch(/provenance .*incomplete/i);
    expect(HARD_CLASSES).not.toContain('origin.untrusted');
  });

  it('leaves a command with no atom in it to the task as it was', async () => {
    const { run, provenance } = taskEngine();
    await provenance.markIncomplete(SESSION);
    expect((await run('ls -la')).decision.effect).toBe('allow');
  });
});
