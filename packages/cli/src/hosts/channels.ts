import type { ClaudeHookEvent } from '../adapters/claude-code.js';

export const CHANNELS = [
  'shell command',
  'file write',
  'file read',
  'MCP call',
  'tool result',
  'web fetch',
] as const;

export type Channel = (typeof CHANNELS)[number];

export const HOST_IDS = [
  'claude-code',
  'cursor',
  'codex',
  'copilot',
  'openclaw',
  'windsurf',
  'antigravity',
  'mcp',
] as const;

export type HostId = (typeof HOST_IDS)[number];

export type ChannelStatus = 'seen' | 'not seen' | 'partial' | 'unknown';

export interface ChannelSupport {
  readonly status: ChannelStatus;
  readonly evidence: string;
}

const entry = (status: ChannelStatus, evidence: string): ChannelSupport =>
  Object.freeze({ status, evidence });

export const HOST_CHANNELS: Readonly<Record<HostId, Readonly<Record<Channel, ChannelSupport>>>> =
  Object.freeze({
    'claude-code': Object.freeze({
      'shell command': entry(
        'seen',
        'PreToolUse on Bash and command execution tools (docs/AGENTS.md)',
      ),
      'file write': entry('seen', 'PreToolUse on Write and Edit tools (docs/AGENTS.md)'),
      'file read': entry('seen', 'PreToolUse on Read tool (docs/AGENTS.md)'),
      'MCP call': entry('seen', 'PreToolUse on mcp__* tools (docs/AGENTS.md)'),
      'tool result': entry(
        'seen',
        'PostToolUse on terminal, file, fetch, and MCP outputs (docs/AGENTS.md)',
      ),
      'web fetch': entry(
        'seen',
        'PreToolUse and PostToolUse on WebFetch and WebSearch (docs/AGENTS.md)',
      ),
    }),
    cursor: Object.freeze({
      'shell command': entry('seen', 'beforeShellExecution hook (docs/AGENTS.md#cursor)'),
      'file write': entry(
        'partial',
        'preToolUse matched to Write and Delete; untargeted editor edits not intercepted (docs/AGENTS.md#cursor)',
      ),
      'file read': entry(
        'partial',
        'beforeReadFile can allow or deny, but cannot prompt an ask (docs/AGENTS.md#cursor)',
      ),
      'MCP call': entry('seen', 'beforeMCPExecution hook (docs/AGENTS.md#cursor)'),
      'tool result': entry(
        'seen',
        'afterShellExecution, afterMCPExecution, and afterFileEdit (docs/AGENTS.md#cursor)',
      ),
      'web fetch': entry(
        'not seen',
        'Cursor has no hook for web content fetched by agent (docs/AGENTS.md#cursor)',
      ),
    }),
    codex: Object.freeze({
      'shell command': entry(
        'seen',
        'PreToolUse on Bash and shell execution aliases (docs/AGENTS.md#codex)',
      ),
      'file write': entry('seen', 'PreToolUse on apply_patch headers (docs/AGENTS.md#codex)'),
      'file read': entry(
        'not seen',
        'Codex has no pre-read hook; files are read directly without a tool hook (docs/AGENTS.md#codex)',
      ),
      'MCP call': entry('seen', 'PreToolUse on mcp__.* tools (docs/AGENTS.md#codex)'),
      'tool result': entry(
        'partial',
        'PostToolUse on shell and MCP results; web reads never reach hooks (docs/AGENTS.md#codex)',
      ),
      'web fetch': entry(
        'not seen',
        'Hosted tools such as WebSearch never reach hooks (docs/AGENTS.md#codex)',
      ),
    }),
    copilot: Object.freeze({
      'shell command': entry(
        'seen',
        'preToolUse on bash and shell command tools (docs/AGENTS.md#copilot-cli)',
      ),
      'file write': entry(
        'seen',
        'preToolUse on file tools and apply_patch (docs/AGENTS.md#copilot-cli)',
      ),
      'file read': entry(
        'seen',
        'preToolUse on file tools including str_replace_editor view (docs/AGENTS.md#copilot-cli)',
      ),
      'MCP call': entry(
        'seen',
        'preToolUse treating unlisted tools as MCP calls (docs/AGENTS.md#copilot-cli)',
      ),
      'tool result': entry(
        'seen',
        'postToolUse scanning output, files, web pages, and MCP (docs/AGENTS.md#copilot-cli)',
      ),
      'web fetch': entry('seen', 'preToolUse on web_fetch URLs (docs/AGENTS.md#copilot-cli)'),
    }),
    openclaw: Object.freeze({
      'shell command': entry(
        'seen',
        'before_tool_call on exec and terminal shell tools (docs/AGENTS.md#openclaw)',
      ),
      'file write': entry(
        'seen',
        'before_tool_call on write, edit, and apply_patch (docs/AGENTS.md#openclaw)',
      ),
      'file read': entry('seen', 'before_tool_call on read (docs/AGENTS.md#openclaw)'),
      'MCP call': entry(
        'seen',
        'before_tool_call treating unrecognised tools as mcp__openclaw__* (docs/AGENTS.md#openclaw)',
      ),
      'tool result': entry(
        'seen',
        'after_tool_call observe hook scanning output, files, web, and tools (docs/AGENTS.md#openclaw)',
      ),
      'web fetch': entry(
        'seen',
        'before_tool_call on web_fetch and web_search (docs/AGENTS.md#openclaw)',
      ),
    }),
    windsurf: Object.freeze({
      'shell command': entry('seen', 'pre_run_command hook (docs/AGENTS.md#windsurf)'),
      'file write': entry('seen', 'pre_write_code hook (docs/AGENTS.md#windsurf)'),
      'file read': entry('seen', 'pre_read_code hook (docs/AGENTS.md#windsurf)'),
      'MCP call': entry('seen', 'pre_mcp_tool_use hook (docs/AGENTS.md#windsurf)'),
      'tool result': entry(
        'partial',
        'post_read_code and post_mcp_tool_use; command output and web pages invisible (docs/AGENTS.md#windsurf)',
      ),
      'web fetch': entry(
        'not seen',
        'Web pages Cascade fetches have no hook event at all (docs/AGENTS.md#windsurf)',
      ),
    }),
    antigravity: Object.freeze({
      'shell command': entry(
        'seen',
        'PreToolUse on CommandLine (docs/AGENTS.md#google-antigravity)',
      ),
      'file write': entry(
        'seen',
        'PreToolUse on create_file and edit_file (docs/AGENTS.md#google-antigravity)',
      ),
      'file read': entry(
        'seen',
        'PreToolUse on file read tools (docs/AGENTS.md#google-antigravity)',
      ),
      'MCP call': entry(
        'seen',
        'PreToolUse on mcp__antigravity__* tools (docs/AGENTS.md#google-antigravity)',
      ),
      'tool result': entry(
        'partial',
        'PostToolUse opens read path up to 1 MiB and scans errors only; no result field (docs/AGENTS.md#google-antigravity)',
      ),
      'web fetch': entry(
        'seen',
        'PreToolUse on Url and fetch tools (docs/AGENTS.md#google-antigravity)',
      ),
    }),
    mcp: Object.freeze({
      'shell command': entry(
        'not seen',
        'stdio proxy intercepts MCP JSON-RPC, has no shell execution channel (docs/AGENTS.md#mcp-proxy-any-mcp-client)',
      ),
      'file write': entry(
        'not seen',
        'proxy intercepts MCP tools/call, has no native file write channel (docs/AGENTS.md#mcp-proxy-any-mcp-client)',
      ),
      'file read': entry(
        'not seen',
        'proxy intercepts MCP tools/call and resources/read, no native file read (docs/AGENTS.md#mcp-proxy-any-mcp-client)',
      ),
      'MCP call': entry(
        'seen',
        'tools/call request interception (docs/AGENTS.md#mcp-proxy-any-mcp-client)',
      ),
      'tool result': entry(
        'seen',
        'tools/call, tools/list, and resources/read result scanning (docs/AGENTS.md#mcp-proxy-any-mcp-client)',
      ),
      'web fetch': entry(
        'not seen',
        'proxy has no web fetch interception channel (docs/AGENTS.md#mcp-proxy-any-mcp-client)',
      ),
    }),
  });

/**
 * Determines the channel a scenario hook step uses.
 */
export function channelForStep(event: ClaudeHookEvent): Channel {
  if (event.hook_event_name === 'PostToolUse' || event.hook_event_name === 'PostToolUseFailure') {
    return 'tool result';
  }

  const tool = event.tool_name;
  if (tool === 'Bash' || tool === 'PowerShell') return 'shell command';
  if (tool === 'Write' || tool === 'Edit') return 'file write';
  if (tool === 'Read') return 'file read';
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'web fetch';
  if (tool.startsWith('mcp__')) return 'MCP call';

  return 'MCP call';
}

/**
 * Returns channel support details for a given host and channel, or undefined if unknown host.
 */
export function supportFor(host: string, channel: Channel): ChannelSupport | undefined {
  if (!Object.hasOwn(HOST_CHANNELS, host)) return undefined;
  const hostRecord = HOST_CHANNELS[host as HostId];
  return hostRecord[channel];
}

/**
 * Checks whether a scenario step is supported (i.e. not 'not seen') on a given host.
 */
export function isStepSupportedOnHost(
  host: string,
  event: ClaudeHookEvent,
): { supported: boolean; channel: Channel; status: ChannelStatus; evidence: string } | null {
  if (!Object.hasOwn(HOST_CHANNELS, host)) return null;
  const channel = channelForStep(event);
  const support = supportFor(host, channel);
  if (!support) return null;
  return {
    supported: support.status !== 'not seen',
    channel,
    status: support.status,
    evidence: support.evidence,
  };
}

/**
 * Formats docs/HOSTS.md body from the host channel visibility table.
 */
export function formatHostsMarkdown(): string {
  const lines: string[] = [
    '# Host channel visibility',
    '',
    'Which event channels each host hook interface observes, and which steps of recorded attacks each host can actually see.',
    '',
    'Stroq runs against multiple agent hosts and hook architectures. Each host exposes a different subset of tool invocations and results: some hosts observe shell execution and file edits but never native file reads; some observe MCP tool calls but have no hook for web fetching; others observe only proxy traffic.',
    '',
    "When evaluating attack scenarios with `stroq attack --host <id>`, Stroq identifies steps that occur on channels not observed by that host. If any step of an attack scenario occurs on an unobserved channel, that step is flagged as unsupported, and the attack run exits 1 — ensuring that an attack is never reported as defended when the host could not have observed the attack's precursor actions.",
    '',
    '## Channels',
    '',
    '- `shell command`: PreToolUse hook on terminal and shell commands (`Bash`, `PowerShell`, `exec`, etc.).',
    '- `file write`: PreToolUse hook on file modification tools (`Write`, `Edit`, `apply_patch`, etc.).',
    '- `file read`: PreToolUse hook on file reading tools (`Read`, `str_replace_editor view`, etc.).',
    '- `MCP call`: PreToolUse hook on Model Context Protocol tool execution (`mcp__*`, etc.).',
    '- `tool result`: PostToolUse observation hook scanning command output, file bodies, or tool responses.',
    '- `web fetch`: PreToolUse / PostToolUse hook on URL requests and web fetching tools (`WebFetch`, `WebSearch`, `web_fetch`, etc.).',
    '',
    '## Channel visibility matrix',
    '',
    `| Host | ${CHANNELS.join(' | ')} |`,
    `| --- | ${CHANNELS.map(() => '---').join(' | ')} |`,
  ];

  for (const host of HOST_IDS) {
    const row = [`\`${host}\``, ...CHANNELS.map((ch) => HOST_CHANNELS[host][ch].status)];
    lines.push(`| ${row.join(' | ')} |`);
  }

  lines.push(
    '',
    '## Host details',
    '',
    '| Host | Channel | Status | Evidence / Reference |',
    '| --- | --- | --- | --- |',
  );

  for (const host of HOST_IDS) {
    for (const ch of CHANNELS) {
      const record = HOST_CHANNELS[host][ch];
      lines.push(`| \`${host}\` | ${ch} | ${record.status} | ${record.evidence} |`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
