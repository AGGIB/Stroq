import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logFile } from './paths.js';

export function logError(context: string, err: unknown): void {
  try {
    mkdirSync(dirname(logFile()), { recursive: true });
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    appendFileSync(logFile(), `${new Date().toISOString()} ${context}: ${detail}\n`);
  } catch {
    // logging must never throw inside a hook
  }
}
