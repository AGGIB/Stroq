import type { ActionClass } from '../types.js';
import { classifyCommand, type CommandClassification } from './classify-bash.js';

export interface ToolClassification extends CommandClassification {
  readonly mcp?: { readonly server: string; readonly tool: string };
}

const SELF_CONFIG_PATH = /(\.claude\/settings(\.local)?\.json|\.cursor\/hooks\.json|\.stroq(\/|$))/;
const SECRET_PATH =
  /(\/\.ssh\/|\bid_(rsa|ed25519|ecdsa|dsa)\b|\/\.aws\/|(^|\/)\.env(\.[\w-]+)?$|\.(pem|p12|pfx|key)$|\/\.(npmrc|netrc|pgpass|git-credentials)$|\/\.kube\/config$|\/\.config\/gcloud\/|\/etc\/(shadow|passwd)$)/;
const SIDE_EFFECT_TOOL =
  /(send|post|publish|upload|email|mail|message|notify|pay|transfer|purchase|delete|remove|drop|deploy|execute|exec|run|shell|write|update|create|comment|merge|push)/i;
// `config.self` on an MCP call requires BOTH a write-shaped tool name and the
// protected path sitting in a path-like argument key — a path merely
// mentioned in a text/body/title value, or read by a read-shaped tool, is
// not self-tampering.
const WRITE_SHAPED_TOOL =
  /(write|edit|delete|remove|move|rename|append|put|save|update|create_file|mkdir)/i;
const PATH_LIKE_KEY = /^(path|filepath|file_path|file|target|dest|destination|uri|url)s?$/i;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const EMPTY: CommandClassification = { classes: [], hosts: [], signals: [] };

export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice('mcp__'.length);
  const idx = rest.lastIndexOf('__');
  if (idx <= 0 || idx === rest.length - 2) return null;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}

function pathOf(toolInput: Readonly<Record<string, unknown>>): string {
  const candidate = toolInput['file_path'] ?? toolInput['notebook_path'] ?? toolInput['path'] ?? '';
  return typeof candidate === 'string' ? candidate : '';
}

function classifyPath(path: string, write: boolean): ToolClassification {
  const classes: ActionClass[] = [];
  const signals: string[] = [];
  if (write && SELF_CONFIG_PATH.test(path)) {
    classes.push('config.self');
    signals.push('self-config-write');
  }
  if (SECRET_PATH.test(path)) {
    classes.push('fs.secrets');
    signals.push('secret-path');
  }
  return { classes, hosts: [], signals };
}

/**
 * Scans path-like keys of `toolInput` (one level deep, plus arrays of
 * strings under such a key) for the protected path. A path mentioned in a
 * non-path key (`body`, `text`, `title`, …) does not count — that is
 * incidental text, not an argument telling the tool where to write.
 */
function touchesSelfConfigPathLikeKey(toolInput: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(toolInput).some(([key, value]) => {
    if (!PATH_LIKE_KEY.test(key)) return false;
    if (typeof value === 'string') return SELF_CONFIG_PATH.test(value);
    if (Array.isArray(value)) {
      return value.some((v) => typeof v === 'string' && SELF_CONFIG_PATH.test(v));
    }
    return false;
  });
}

function classifyMcp(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
): ToolClassification {
  const mcp = parseMcpToolName(toolName);
  if (!mcp) return EMPTY;
  const sideEffect = SIDE_EFFECT_TOOL.test(mcp.tool);
  const selfConfig = WRITE_SHAPED_TOOL.test(mcp.tool) && touchesSelfConfigPathLikeKey(toolInput);
  const classes: ActionClass[] = ['mcp.call'];
  if (sideEffect) classes.push('mcp.side_effect');
  if (selfConfig) classes.push('config.self');
  const signals: string[] = [];
  if (sideEffect) signals.push('mcp-side-effect-name');
  if (selfConfig) signals.push('self-config-write');
  return { classes, hosts: [], signals, mcp };
}

function classifyFetch(toolInput: Readonly<Record<string, unknown>>): ToolClassification {
  const url = typeof toolInput['url'] === 'string' ? toolInput['url'] : '';
  const host = /^https?:\/\/([^/\s:]+)/.exec(url)?.[1];
  return { classes: ['network.fetch'], hosts: host ? [host] : [], signals: ['web-fetch'] };
}

export function classifyTool(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  cwd: string,
): ToolClassification {
  if (toolName === 'Bash') {
    const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
    return classifyCommand(command, cwd);
  }
  if (WRITE_TOOLS.has(toolName)) return classifyPath(pathOf(toolInput), true);
  if (toolName === 'Read') return classifyPath(pathOf(toolInput), false);
  if (toolName === 'WebFetch') return classifyFetch(toolInput);
  if (toolName.startsWith('mcp__')) return classifyMcp(toolName, toolInput);
  return EMPTY;
}
