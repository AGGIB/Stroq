import { AuditLog } from '@stroq/core';
import { auditFile } from '../paths.js';

export async function runVerify(): Promise<number> {
  const result = await new AuditLog(auditFile()).verify();
  if (result.ok) {
    process.stdout.write(`audit chain OK (${result.count} entries)\n`);
    return 0;
  }
  process.stdout.write(`audit chain BROKEN at seq ${result.brokenAt} (${result.count} entries)\n`);
  return 1;
}
