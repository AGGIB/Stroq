/**
 * Which scenario channels each host actually sends to Stroq.
 *
 * `stroq attack` replays the 36-scenario corpus in-process through `@stroq/core` using
 * Claude Code's event shapes (`PreToolUse` and `PostToolUse`). Other hosts do not emit
 * every channel a scenario step uses: Cursor, Codex and Windsurf have no hook for their
 * built-in web fetches, Codex has no file-read hook, Antigravity's `PostToolUse` omits
 * the tool's output, and `stroq mcp` only sees traffic on wrapped stdio MCP servers.
 *
 * `stroq attack --host <id>` and `docs/HOSTS.md` both read this table so that a step a
 * host never sends is reported as `unsupported` rather than counted as blocked or asked.
 *
 * Every `"not seen"` cell must cite a real section of `docs/AGENTS.md` or a recorded
 * fixture under `packages/cli/test/fixtures/hosts/`; an untested cell must be `"unknown"`,
 * never `"seen"`.
 */

export const ATTACK_HOSTS = [
  'claude-code',
  'cursor',
  'codex',
  'copilot',
  'openclaw',
  'windsurf',
  'antigravity',
  'mcp',
] as const;

export type AttackHost = (typeof ATTACK_HOSTS)[number];

export const ATTACK_CHANNELS = [
  'shell command',
  'file write',
  'file read',
  'MCP call',
  'tool result',
  'web fetch',
] as const;

export type AttackChannel = (typeof ATTACK_CHANNELS)[number];

export const CHANNEL_STATUSES = ['seen', 'partial', 'not seen', 'unknown'] as const;

export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export interface HostChannelCell {
  readonly status: ChannelStatus;
  /** One-line citation pointing to `docs/AGENTS.md#<section>` or a recorded fixture path. */
  readonly evidence: string;
  /** Restrict a partial channel to these canonical replay tools in each phase. */
  readonly tools?: Readonly<Record<'pre' | 'post', readonly string[]>>;
}

export interface HostChannelEntry {
  readonly id: AttackHost;
  readonly label: string;
  /** Heading anchor in `docs/AGENTS.md` for bijective docs checks. */
  readonly agentsAnchor: string;
  readonly channels: Readonly<Record<AttackChannel, HostChannelCell>>;
}

const c = (
  status: ChannelStatus,
  evidence: string,
  tools?: HostChannelCell['tools'],
): HostChannelCell => ({ status, evidence, ...(tools === undefined ? {} : { tools }) });

export const HOST_CHANNELS: Readonly<Record<AttackHost, HostChannelEntry>> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    agentsAnchor: 'claude-code',
    channels: {
      'shell command': c(
        'seen',
        'packages/cli/test/fixtures/hosts/claude-code/2.1.271/deny.real.acceptEdits.jsonl — PreToolUse classifies Bash and PowerShell with allow, ask and deny.',
      ),
      'file write': c(
        'seen',
        'docs/AGENTS.md#claude-code — PreToolUse classifies Write, Edit, MultiEdit and NotebookEdit before the write runs.',
      ),
      'file read': c(
        'seen',
        'docs/AGENTS.md#claude-code — PreToolUse checks Read paths and PostToolUse scans the file body.',
      ),
      'MCP call': c(
        'seen',
        'docs/AGENTS.md#claude-code — PreToolUse matches mcp__.* and classifies server, tool and arguments.',
      ),
      'tool result': c(
        'seen',
        'docs/AGENTS.md#claude-code — PostToolUse and PostToolUseFailure scan Bash, PowerShell and mcp__.* output.',
      ),
      'web fetch': c(
        'partial',
        'docs/AGENTS.md#claude-code — PreToolUse classifies WebFetch URLs; PostToolUse scans WebFetch and WebSearch results. WebSearch has no installed pre-hook.',
        { pre: ['WebFetch'], post: ['WebFetch', 'WebSearch'] },
      ),
    },
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    agentsAnchor: 'cursor',
    channels: {
      'shell command': c(
        'seen',
        'docs/AGENTS.md#cursor — beforeShellExecution classifies commands with deny and ask; the recorded Windows capture measured editor writes only.',
      ),
      'file write': c(
        'partial',
        'packages/cli/test/fixtures/hosts/cursor/3.24.18-win32/hooks.jsonl — preToolUse (Write|Delete) classifies target paths with ask mapped to deny; Tab edits are outside hooks.',
      ),
      'file read': c(
        'partial',
        'docs/AGENTS.md#cursor — beforeReadFile scans file content and denies credential reads under taint, without an ask decision.',
      ),
      'MCP call': c(
        'seen',
        'docs/AGENTS.md#cursor — beforeMCPExecution classifies MCP calls and arguments with deny and ask.',
      ),
      'tool result': c(
        'partial',
        'docs/AGENTS.md#cursor — afterShellExecution and afterMCPExecution scan output and taint the session; afterShellExecution honours no warning output.',
      ),
      'web fetch': c(
        'not seen',
        'docs/AGENTS.md#cursor — Cursor emits no hook event for content its agent fetches from the web.',
      ),
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    agentsAnchor: 'codex',
    channels: {
      'shell command': c(
        'partial',
        'packages/cli/test/fixtures/hosts/codex/0.162.1/deny.real.jsonl — PreToolUse (Bash) classifies shell commands; ask is mapped to deny.',
      ),
      'file write': c(
        'partial',
        'docs/AGENTS.md#codex — PreToolUse (apply_patch) classifies declared paths only, not patch body text, with ask mapped to deny.',
      ),
      'file read': c(
        'not seen',
        'docs/AGENTS.md#codex — PreToolUse and PostToolUse matchers cover Bash, apply_patch and mcp__.* only; Codex emits no file-read hook.',
      ),
      'MCP call': c(
        'partial',
        'docs/AGENTS.md#codex — PreToolUse (mcp__.*) classifies MCP calls and arguments, with ask mapped to deny.',
      ),
      'tool result': c(
        'partial',
        'docs/AGENTS.md#codex — PostToolUse scans Bash and mcp__.* output and warns via additionalContext.',
      ),
      'web fetch': c(
        'not seen',
        'docs/AGENTS.md#codex — Hosted tools such as WebSearch never reach Codex hooks.',
      ),
    },
  },
  copilot: {
    id: 'copilot',
    label: 'Copilot CLI',
    agentsAnchor: 'copilot-cli',
    channels: {
      'shell command': c(
        'seen',
        'docs/AGENTS.md#copilot-cli — preToolUse classifies bash and powershell commands with deny and ask.',
      ),
      'file write': c(
        'seen',
        'docs/AGENTS.md#copilot-cli — preToolUse classifies create/edit/write and apply_patch with deny and ask.',
      ),
      'file read': c(
        'seen',
        'docs/AGENTS.md#copilot-cli — preToolUse checks view/read paths and postToolUse scans the file body.',
      ),
      'MCP call': c(
        'partial',
        'docs/AGENTS.md#copilot-cli — preToolUse classifies non-native tools as mcp__copilot__<tool>; server name is omitted by the host.',
      ),
      'tool result': c(
        'partial',
        'docs/AGENTS.md#copilot-cli — postToolUse scans command and MCP output and taints the session silently because stdout is ignored.',
      ),
      'web fetch': c(
        'seen',
        'docs/AGENTS.md#copilot-cli — preToolUse classifies web_fetch URLs and postToolUse scans fetched content.',
      ),
    },
  },
  openclaw: {
    id: 'openclaw',
    label: 'OpenClaw',
    agentsAnchor: 'openclaw',
    channels: {
      'shell command': c(
        'seen',
        'docs/AGENTS.md#openclaw — before_tool_call classifies exec and shell aliases with block and requireApproval.',
      ),
      'file write': c(
        'seen',
        'docs/AGENTS.md#openclaw — before_tool_call classifies write, edit and apply_patch with block and requireApproval.',
      ),
      'file read': c(
        'seen',
        'docs/AGENTS.md#openclaw — before_tool_call checks read paths and after_tool_call scans the returned file body.',
      ),
      'MCP call': c(
        'partial',
        'docs/AGENTS.md#openclaw — before_tool_call classifies non-native tools as mcp__openclaw__<tool>; server name is omitted.',
      ),
      'tool result': c(
        'partial',
        'docs/AGENTS.md#openclaw — after_tool_call scans tool output and taints the session silently as a fire-and-forget event.',
      ),
      'web fetch': c(
        'seen',
        'docs/AGENTS.md#openclaw — before_tool_call classifies web_fetch URLs and after_tool_call scans fetched pages.',
      ),
    },
  },
  windsurf: {
    id: 'windsurf',
    label: 'Windsurf',
    agentsAnchor: 'windsurf',
    channels: {
      'shell command': c(
        'partial',
        'docs/AGENTS.md#windsurf — pre_run_command classifies command lines and blocks via exit 2, with ask mapped to block.',
      ),
      'file write': c(
        'partial',
        'docs/AGENTS.md#windsurf — pre_write_code classifies target paths and edits, with ask mapped to block.',
      ),
      'file read': c(
        'partial',
        'docs/AGENTS.md#windsurf — pre_read_code checks paths and post_read_code opens and scans the file on disk up to 1 MiB.',
      ),
      'MCP call': c(
        'partial',
        'docs/AGENTS.md#windsurf — pre_mcp_tool_use classifies mcp__<server>__<tool> and arguments, with ask mapped to block.',
      ),
      'tool result': c(
        'partial',
        'docs/AGENTS.md#windsurf — post_mcp_tool_use scans MCP results; post_run_command carries no command output.',
        { pre: [], post: ['mcp__.*'] },
      ),
      'web fetch': c(
        'not seen',
        'docs/AGENTS.md#windsurf — Cascade web fetches have no hook event and never reach Stroq.',
      ),
    },
  },
  antigravity: {
    id: 'antigravity',
    label: 'Google Antigravity',
    agentsAnchor: 'google-antigravity',
    channels: {
      'shell command': c(
        'seen',
        'docs/AGENTS.md#google-antigravity — PreToolUse classifies run_command and shell aliases with deny and force_ask.',
      ),
      'file write': c(
        'seen',
        'docs/AGENTS.md#google-antigravity — PreToolUse classifies create_file and edit_file with deny and force_ask.',
      ),
      'file read': c(
        'partial',
        'docs/AGENTS.md#google-antigravity — PreToolUse checks view_file paths and PostToolUse opens the file on disk up to 1 MiB.',
      ),
      'MCP call': c(
        'partial',
        'docs/AGENTS.md#google-antigravity — PreToolUse classifies non-native tools as mcp__antigravity__<tool>; server name is omitted.',
      ),
      'tool result': c(
        'not seen',
        'docs/AGENTS.md#google-antigravity — PostToolUse carries no tool_response field; command and MCP results never reach hooks.',
      ),
      'web fetch': c(
        'partial',
        'docs/AGENTS.md#google-antigravity — PreToolUse classifies read_url_content and web_fetch URLs; PostToolUse carries no page body.',
        { pre: ['WebFetch'], post: [] },
      ),
    },
  },
  mcp: {
    id: 'mcp',
    label: 'MCP proxy (any MCP client)',
    agentsAnchor: 'mcp-proxy-any-mcp-client',
    channels: {
      'shell command': c(
        'not seen',
        'docs/AGENTS.md#mcp-proxy-any-mcp-client — Stdio MCP proxy sees wrapped MCP servers only, not the host’s native shell tool.',
      ),
      'file write': c(
        'not seen',
        'docs/AGENTS.md#mcp-proxy-any-mcp-client — Stdio MCP proxy sees wrapped MCP servers only, not the host’s native file writes.',
      ),
      'file read': c(
        'not seen',
        'docs/AGENTS.md#mcp-proxy-any-mcp-client — Stdio MCP proxy sees wrapped MCP servers only, not the host’s native file reads.',
      ),
      'MCP call': c(
        'partial',
        'docs/AGENTS.md#mcp-proxy-any-mcp-client — tools/call requests on wrapped servers are classified and blocked via isError: true.',
      ),
      'tool result': c(
        'partial',
        'docs/AGENTS.md#mcp-proxy-any-mcp-client — tools/call, tools/list, resources/read and prompts/get responses on wrapped servers are scanned.',
        { pre: [], post: ['mcp__.*'] },
      ),
      'web fetch': c(
        'not seen',
        'docs/AGENTS.md#mcp-proxy-any-mcp-client — Stdio MCP proxy sees wrapped MCP servers only, not the host’s native web fetches.',
      ),
    },
  },
};

export function isAttackHost(value: string): value is AttackHost {
  return (ATTACK_HOSTS as readonly string[]).includes(value);
}

/**
 * Whether a host sends a scenario channel to Stroq (`seen` or `partial`).
 * Both `'not seen'` and `'unknown'` are treated as unsupported so an untested channel is
 * never counted as a protection.
 */
export function isChannelSupported(status: ChannelStatus): boolean {
  return status === 'seen' || status === 'partial';
}

/** Maps a scenario step's phase and Claude Code tool name to one of the six host channels. */
export function stepChannel(phase: 'pre' | 'post', tool: string): AttackChannel {
  if (tool === 'Read') return 'file read';
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'web fetch';
  if (phase === 'post') return 'tool result';
  if (tool.startsWith('mcp__')) return 'MCP call';
  if (
    tool === 'Write' ||
    tool === 'Edit' ||
    tool === 'MultiEdit' ||
    tool === 'NotebookEdit' ||
    tool === 'Delete'
  ) {
    return 'file write';
  }
  return 'shell command';
}

export function hostStepSupport(
  host: AttackHost,
  phase: 'pre' | 'post',
  tool: string,
): {
  readonly channel: AttackChannel;
  readonly cell: HostChannelCell;
  readonly supported: boolean;
} {
  const channel = stepChannel(phase, tool);
  const cell = HOST_CHANNELS[host].channels[channel];
  return {
    channel,
    cell,
    supported:
      isChannelSupported(cell.status) &&
      (cell.tools === undefined ||
        cell.tools[phase].some((name) =>
          name === 'mcp__.*' ? tool.startsWith('mcp__') : name === tool,
        )),
  };
}
