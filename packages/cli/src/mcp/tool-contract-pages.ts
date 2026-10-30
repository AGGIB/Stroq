import {
  canonicalizeToolsList,
  contractRecord,
  validateContractJson,
} from './tool-contract-canonical.js';
import { STRICT_MAX_TEXT_CHARS } from './strict-limits.js';
import { contractError, type ContractJson, type ToolContractError } from './tool-contract-types.js';

export type ToolContractPageStep =
  { kind: 'next'; cursor: string } | { kind: 'complete'; result: { tools: unknown[] } };

const MAX_PAGES = 16;
const MAX_CURSOR_BYTES = 4096;

function readCursor(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f-\u009f\ufffd]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    return contractError('tool-contract-invalid');
  if (Buffer.byteLength(value) > MAX_CURSOR_BYTES) return contractError('tool-contract-limit');
  return value;
}

function readPage(value: unknown): { tools: ContractJson[]; cursor: string | undefined } {
  if (!contractRecord(value)) return contractError('tool-contract-invalid');
  if (Reflect.ownKeys(value).some((key) => key !== 'tools' && key !== 'nextCursor'))
    return contractError('tool-contract-unsupported');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors))
    if (!descriptor.enumerable || !('value' in descriptor))
      return contractError('tool-contract-invalid');
  const member = descriptors.tools;
  if (!member) return contractError('tool-contract-invalid');
  const copied = validateContractJson({ tools: member.value });
  canonicalizeToolsList(copied);
  if (!contractRecord(copied) || !Array.isArray(copied.tools))
    return contractError('tool-contract-invalid');
  return {
    tools: copied.tools as ContractJson[],
    cursor: descriptors.nextCursor ? readCursor(descriptors.nextCursor.value) : undefined,
  };
}

function failureCode(error: unknown): ToolContractError {
  try {
    const message = error instanceof Error ? error.message : undefined;
    if (
      message === 'tool-contract-invalid' ||
      message === 'tool-contract-limit' ||
      message === 'tool-contract-unsupported'
    )
      return message;
  } catch {
    // An untrusted object may even throw while its error is being inspected.
  }
  return 'tool-contract-invalid';
}

/** Collect one bounded listing in memory; cursors are opaque and only a final page releases tools. */
export function createToolContractPages(): { add(result: unknown): ToolContractPageStep } {
  let pages = 0;
  let tools: unknown[] = [];
  let ended = false;
  const cursors = new Set<string>();
  return {
    add(result) {
      if (ended) return contractError('tool-contract-invalid');
      try {
        const page = readPage(result);
        if (pages + 1 > MAX_PAGES || (pages + 1 === MAX_PAGES && page.cursor !== undefined))
          return contractError('tool-contract-limit');
        if (page.cursor !== undefined && cursors.has(page.cursor))
          return contractError('tool-contract-invalid');
        const aggregate = { tools: [...tools, ...page.tools] };
        // Revalidation applies the existing capture-byte, raw-name, tool-count and node bounds
        // to the whole listing, rather than allowing those bounds anew for each page.
        canonicalizeToolsList(aggregate);
        // Strict mode clips its JSON view at this window. Releasing a larger synthesized
        // result would leave a JSON tail unread even when its decoded strings fit.
        if (JSON.stringify(aggregate).length > STRICT_MAX_TEXT_CHARS)
          return contractError('tool-contract-limit');
        pages++;
        tools = aggregate.tools;
        if (page.cursor !== undefined) {
          cursors.add(page.cursor);
          return { kind: 'next', cursor: page.cursor };
        }
        ended = true;
        return { kind: 'complete', result: aggregate };
      } catch (error) {
        ended = true;
        tools = [];
        cursors.clear();
        return contractError(failureCode(error));
      }
    },
  };
}
