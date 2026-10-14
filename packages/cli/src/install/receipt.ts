import { join } from 'node:path';
import { AuditLog } from '@stroq/core';
import { assertWriteAllowed } from '../harden/atomic.js';
import type { Receipt } from './lock.js';

/** Receipts also live in the atomic lock; the audit line is a second, chronological record. */
export async function auditReceipt(
  home: string,
  receipt: Receipt,
  kind: 'skill' | 'mcp' = 'skill',
): Promise<void> {
  const file = join(home, 'audit.jsonl');
  try {
    assertWriteAllowed(file, { root: home, initRule: false });
    await new AuditLog(file).append({
      sessionId: `safe-install:${receipt.name}`,
      phase: 'post',
      tool: `stroq.${receipt.action}`,
      summary: `${receipt.action} ${receipt.name} from=${receipt.from ?? '-'} to=${receipt.to ?? '-'} material=${receipt.material} confirmed=${receipt.confirmed}`,
    });
  } catch (cause) {
    throw new Error(
      `${kind} ${receipt.action} committed; the receipt is in passports.json, but the audit append failed`,
      { cause },
    );
  }
}
