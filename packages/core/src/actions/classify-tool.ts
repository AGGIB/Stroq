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

function classifyMcp(toolName: string): ToolClassification {
  const mcp = parseMcpToolName(toolName);
  if (!mcp) return EMPTY;
  const sideEffect = SIDE_EFFECT_TOOL.test(mcp.tool);
  return {
    classes: sideEffect ? ['mcp.call', 'mcp.side_effect'] : ['mcp.call'],
    hosts: [],
    signals: sideEffect ? ['mcp-side-effect-name'] : [],
    mcp,
  };
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
  if (toolName.startsWith('mcp__')) return classifyMcp(toolName);
  return EMPTY;
}
