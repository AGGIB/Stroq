import { existsSync } from 'node:fs';
import {
  AuditLog,
  DEFAULT_POLICY,
  FileProvenanceStore,
  FileSessionStore,
  StroqEngine,
  loadBundledRules,
  loadPolicyFile,
  type Policy,
} from '@stroq/core';
import { auditFile, policyFile, sessionsDir } from './paths.js';

export function loadPolicy(): Policy {
  const file = policyFile();
  return existsSync(file) ? loadPolicyFile(file) : DEFAULT_POLICY;
}

export function createEngine(): StroqEngine {
  return new StroqEngine({
    rules: loadBundledRules(),
    policy: loadPolicy(),
    sessions: new FileSessionStore(sessionsDir()),
    provenance: new FileProvenanceStore(sessionsDir()),
    audit: new AuditLog(auditFile()),
  });
}
