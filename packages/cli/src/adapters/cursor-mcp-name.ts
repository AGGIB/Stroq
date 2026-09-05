// Composes the `mcp__<server>__<tool>` tool name the Claude Code adapter uses from the
// server and tool names Cursor reports, so one classifier covers both agents. Every
// rule here exists because an MCP server chooses its own tool names, i.e. the
// adversary in Stroq's threat model does.

// Underscore is treated as unsafe here too: a RUN of unsafe characters (including
// pre-existing underscores) collapses to exactly one `_`, so padding a raw value
// with e.g. two spaces can never synthesise a fresh `__` that core's
// `parseMcpToolName` (which splits on the LAST `__`) would mistake for the
// `mcp__<server>__<tool>` separator. The second pass is a defence-in-depth
// squeeze for whenever two already-sanitised segments end up back to back.
const UNSAFE_RUN = /[^A-Za-z0-9-]+/g;
const DOUBLE_UNDERSCORE = /_{2,}/g;
const sanitize = (value: string): string =>
  value.replace(UNSAFE_RUN, '_').replace(DOUBLE_UNDERSCORE, '_');

/**
 * One `mcp__<server>__<tool>` segment. Sanitising alone is not enough: a value made
 * entirely of unsafe characters (`"__"`, `"!"`, `"✉"`, `"发送"`, `"/"`) collapses to a lone
 * `_`, and the composed `mcp__<server>___` then defeats core's `parseMcpToolName` (it
 * splits on the LAST `__` and rejects an empty tool part) — no `mcp.call`, so no
 * secret-egress lookup, so a `.env` value out through a hostile tool name. Trimming the
 * edge underscores empties such a segment and the `unknown`/`call` fallback takes over.
 */
const segment = (value: string): string => sanitize(value).replace(/^_+|_+$/g, '');

/**
 * A pre-shaped `mcp__<server>__<tool>` name with no separate server to check it
 * against is split at its FIRST `__` and each half re-sanitised, so a tool literally
 * named `send__data` cannot smuggle a second separator past core's last-`__` split.
 */
function passThroughMcpName(rawTool: string): string {
  const rest = rawTool.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  const server = separator > 0 ? rest.slice(0, separator) : rest;
  const tool = separator > 0 ? rest.slice(separator + 2) : '';
  return `mcp__${segment(server) || 'unknown'}__${segment(tool) || 'call'}`;
}

/**
 * A `tool_name` that already arrives as `mcp__<server>__<tool>` is trusted (re-sanitised)
 * only when there is no separate `mcp_server_name` to check it against: otherwise an
 * adversary who controls `tool_name` alone could forge `mcp__<trusted-looking>__<tool>`
 * and have it override the server Cursor actually reports the call went to. Once a
 * server is given, the name is always composed from it; the tool part is sanitised,
 * never parsed, even when it already looks like `mcp__…__…`.
 */
export function mcpToolName(rawServer: string, rawTool: string): string {
  if (rawServer === '' && rawTool.startsWith('mcp__')) return passThroughMcpName(rawTool);
  const server = segment(rawServer) || 'unknown';
  const tool = segment(rawTool);
  return `mcp__${server}__${tool || 'call'}`;
}
