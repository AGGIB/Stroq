export interface McpToolContractChange {
  path: string;
  kind: 'added' | 'changed' | 'removed';
}
export interface McpToolContractComparison {
  status: 'first-seen' | 'baseline-unavailable' | 'unchanged' | 'changed' | 'incomplete';
  baselineSha256: string | null;
  baselineApprovedAt: string | null;
  counts: { added: number; changed: number; removed: number } | null;
  changes: McpToolContractChange[];
}
interface Baseline {
  sha256: string;
  approvedAt: string;
}
export function sameMcpToolContractComparison(
  left: McpToolContractComparison,
  right: McpToolContractComparison,
): boolean {
  return (
    left.status === right.status &&
    left.baselineSha256 === right.baselineSha256 &&
    left.baselineApprovedAt === right.baselineApprovedAt &&
    (left.counts === null || right.counts === null
      ? left.counts === right.counts
      : (['added', 'changed', 'removed'] as const).every(
          (kind) => left.counts![kind] === right.counts![kind],
        )) &&
    left.changes.length === right.changes.length &&
    left.changes.every(
      (row, i) => row.path === right.changes[i]?.path && row.kind === right.changes[i]?.kind,
    )
  );
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const pointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

/** Descriptive evidence only. Authority remains in the native exact-version store. */
export function compareMcpToolContract(
  current: string,
  previous: string | null,
  baseline: Baseline | null,
): McpToolContractComparison {
  const identity = {
    baselineSha256: baseline?.sha256 ?? null,
    baselineApprovedAt: baseline?.approvedAt ?? null,
  };
  const incomplete = (): McpToolContractComparison => ({
    ...identity,
    status: 'incomplete',
    counts: null,
    changes: [],
  });
  if (previous === null)
    return {
      ...identity,
      status: baseline ? 'baseline-unavailable' : 'first-seen',
      counts: null,
      changes: [],
    };
  if (!baseline) return incomplete();
  try {
    if (
      new TextEncoder().encode(current).length > 65_536 ||
      new TextEncoder().encode(previous).length > 65_536
    )
      return incomplete();
    const before: unknown = JSON.parse(previous);
    const after: unknown = JSON.parse(current);
    const changes: McpToolContractChange[] = [];
    let nodes = 0;
    let pathBytes = 0;
    const add = (path: string, kind: McpToolContractChange['kind']) => {
      pathBytes += new TextEncoder().encode(path).length;
      if (changes.length >= 256 || pathBytes > 65_536) throw new Error('comparison-limit');
      changes.push({ path, kind });
    };
    const visit = (left: unknown, right: unknown, path: string, depth: number): void => {
      if (++nodes > 40_000 || depth > 32) throw new Error('comparison-limit');
      if (object(left) && object(right)) {
        for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
          const next = `${path}/${pointer(key)}`;
          if (!own(left, key)) add(next, 'added');
          else if (!own(right, key)) add(next, 'removed');
          else visit(left[key], right[key], next, depth + 1);
        }
      } else if (JSON.stringify(left) !== JSON.stringify(right)) add(path, 'changed');
    };
    visit(before, after, '', 0);
    const counts = { added: 0, changed: 0, removed: 0 };
    for (const change of changes) counts[change.kind] += 1;
    return { ...identity, status: changes.length ? 'changed' : 'unchanged', counts, changes };
  } catch {
    return incomplete();
  }
}

/** Resolve only a captured JSON pointer, preserving missing versus the literal JSON null. */
export function getMcpToolContractFragment(contract: string, path: string): string | undefined {
  if (path !== '' && !path.startsWith('/')) return undefined;
  try {
    let value: unknown = JSON.parse(contract);
    for (const part of path === '' ? [] : path.slice(1).split('/')) {
      if (/~(?![01])/u.test(part)) return undefined;
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
      if (value === null || typeof value !== 'object' || !own(value, key)) return undefined;
      value = (value as Record<string, unknown>)[key];
    }
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
