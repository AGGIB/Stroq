import { readConfigText } from '../commands/config-file.js';
import { removeFile, writeFileAtomic } from '../harden/atomic.js';
import type { McpConfigJson } from '../commands/mcp-config.js';

/** Roll back exact bytes (or absence), rather than parsing and rewriting the backup. */
export async function commitMcpConfig(
  file: string,
  config: McpConfigJson,
  save: () => Promise<void>,
  options: { readonly before?: string | null; readonly root?: string } = {},
): Promise<void> {
  const before =
    options.before === undefined ? readConfigText(file, { strict: true }) : options.before;
  const written = `${JSON.stringify(config, null, 2)}\n`;
  const rules = {
    ...(options.root === undefined ? {} : { root: options.root }),
    initRule: false,
  };
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
    const unchanged = () => {
      if (readConfigText(file, { strict: true }) !== written)
        throw new Error('lock write failed; an outside config edit was preserved', {
          cause: error,
        });
    };
    unchanged();
    if (before === null) await removeFile(file, { ...rules, beforeRemove: unchanged });
    else await writeFileAtomic(file, before, { ...rules, beforeRename: unchanged });
    throw error;
  }
}
