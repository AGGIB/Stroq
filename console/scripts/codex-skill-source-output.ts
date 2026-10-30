import {
  CODEX_SKILL_SOURCE_LIMITS,
  type CodexSkillSourcesReport,
} from '../lib/codex-skill-sources.ts';

/** Retain every captured fact; only later match detail is omitted to fit the public byte budget. */
export function boundCodexSkillSourcesReport(
  report: CodexSkillSourcesReport,
  maximumBytes = CODEX_SKILL_SOURCE_LIMITS.responseBytes,
): CodexSkillSourcesReport {
  const fits = (value: CodexSkillSourcesReport) =>
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= maximumBytes;
  if (fits(report)) return report;
  const prefix = (count: number): CodexSkillSourcesReport => ({
    ...report,
    items: report.items.map((item) => {
      const keep = Math.min(count, item.scan.matches.length);
      count -= keep;
      return keep === item.scan.matches.length
        ? item
        : {
            ...item,
            scan: {
              ...item.scan,
              matches: item.scan.matches.slice(0, keep),
              omitted: item.scan.omitted + item.scan.matches.length - keep,
            },
          };
    }),
  });
  let best = prefix(0);
  if (!fits(best)) throw Error('inventory-unavailable');
  let low = 0,
    high = report.items.reduce((sum, item) => sum + item.scan.matches.length, 0);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2),
      candidate = prefix(middle);
    if (fits(candidate)) {
      low = middle;
      best = candidate;
    } else high = middle - 1;
  }
  return best;
}
