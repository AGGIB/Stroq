import type { ToolClassification } from './classify-tool.js';

/** The classification of a call that touches nothing. */
export const NONE: ToolClassification = { classes: [], hosts: [], signals: [] };

/**
 * Several classifications as one: each class, host and signal once, the MCP identity of the first that
 * has one, and every script text.
 */
export function mergeClassifications(...items: readonly ToolClassification[]): ToolClassification {
  const mcp = items.find((item) => item.mcp !== undefined)?.mcp;
  const scripts = items.flatMap((item) => item.scripts ?? []);
  return {
    classes: [...new Set(items.flatMap((item) => item.classes))],
    hosts: [...new Set(items.flatMap((item) => item.hosts))],
    signals: [...new Set(items.flatMap((item) => item.signals))],
    ...(mcp === undefined ? {} : { mcp }),
    ...(scripts.length === 0 ? {} : { scripts }),
  };
}
