import { unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readConfigText } from '../commands/config-file.js';
import { writeFileAtomic } from '../harden/atomic.js';
import type { McpConfigJson } from '../commands/mcp-config.js';

/** Roll back exact bytes (or absence), rather than parsing and rewriting the backup. */
export async function commitMcpConfig(
  file: string,
  config: McpConfigJson,
  save: () => Promise<void>,
): Promise<void> {
  const before = readConfigText(file, { strict: true });
  const written = `${JSON.stringify(config, null, 2)}\n`;
  const rules = { root: dirname(file), initRule: false };
  await writeFileAtomic(file, written, {
    ...rules,
    beforeRename: () => {
      if (readConfigText(file, { strict: true }) !== before)
        throw new Error('the client config changed before writing; read and confirm again');
    },
  });
  try {
    await save();
  } catch (error) {
    if (readConfigText(file, { strict: true }) !== written)
      throw new Error('lock write failed; an outside config edit was preserved', { cause: error });
    if (before === null) await unlink(file);
    else await writeFileAtomic(file, before, rules);
    throw error;
  }
}
