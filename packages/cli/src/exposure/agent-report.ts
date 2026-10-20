import { showable } from '../install/inspect/safe-text.js';
import {
  inAttackShape,
  isFailing,
  startsWithoutAsking,
  type ChangeStatus,
  type FailOn,
  type TaggedHit,
} from './agent-change.js';
import { envLoadsCode, envNameOf } from './agent-json.js';
import type { AgentHit } from './agent-kinds.js';
import { DEVCONTAINER_ACCESS_KEYS } from './agent-editor.js';
import { PACKAGE_SETTING } from './agent-lines.js';

/**
 * One plain sentence per finding, for every output of `stroq inspect`. Every name and value in
 * a finding was written by whoever wrote the repository, so each goes through `quote` before
 * it is put in a sentence: cut and made visible for a terminal, put in a code span for
 * Markdown.
 */
export type Quote = (text: string) => string;

/** The most characters of one value that are shown. */
export const VALUE_MAX = 160;

/** For a terminal and for SARIF: blanks folded, controls written out, cut to a length. */
export const plainQuote: Quote = (text) => showable(text, VALUE_MAX) || '(empty)';

const BINARY = 'a binary file (it holds a NUL byte), not read as instructions';

/**
 * Words for an entry in the shape of an attack. Only words: a change fails what it adds whatever
 * its shape, and the shape is a heuristic that proves nothing harmless.
 */
const shapeNote = (h: AgentHit): string =>
  inAttackShape(h) ? ', and it looks like it downloads and runs code, or sends a secret out' : '';

/** What an allow rule, or a folder it adds, lets the agent do. */
function grantOf(h: AgentHit): string {
  if (h.name === 'permissions.additionalDirectories')
    return 'read and change the files of a folder outside this repository';
  const tool = h.value.split('(')[0]?.trim().toLowerCase() ?? '';
  if (tool === 'webfetch' || tool === 'websearch') return 'reach any address';
  if (
    [
      'read',
      'edit',
      'write',
      'multiedit',
      'notebookedit',
      'notebookread',
      'glob',
      'grep',
      'ls',
    ].includes(tool)
  )
    return 'read or change files that may be outside this repository';
  return 'run any shell command';
}

function sentence(h: AgentHit & { readonly status?: ChangeStatus }, q: Quote): string {
  const name = q(h.name);
  const value = q(h.value);
  const unparsed = h.name === 'unparsed';
  switch (h.kind) {
    case 'agent-hook':
      return `${name} hook runs: ${value}`;
    case 'agent-helper-command':
      return `${name} runs: ${value}`;
    case 'agent-api-redirect':
      // The line can hold a token: neither it nor anything of it is shown.
      if (h.name === PACKAGE_SETTING)
        return "is a line of a package manager's config, which can name where packages come from, the shell scripts run in or code that loads first, so the next npx, install or script in this folder can run other code (the line is not shown)";
      return /otel|telemetry/i.test(h.name)
        ? `${name} sends the agent's telemetry, which can hold your prompts, to: ${value}`
        : `${name} sends the agent's API traffic, and its key, to: ${value}`;
    case 'agent-env':
      return envLoadsCode(envNameOf(h.name))
        ? `env sets ${name} for every command the agent starts, which can load code or send traffic elsewhere: ${value}`
        : `env sets ${name} for every command the agent and its hooks start, and it is not one of the few names known to be harmless: ${value}`;
    case 'agent-broad-allow':
      return `${name} lets the agent ${grantOf(h)} without asking: ${value}`;
    case 'agent-permission-bypass':
      if (h.name === 'permissions.defaultMode')
        return h.value === 'bypassPermissions'
          ? 'the agent runs every tool without asking (defaultMode is bypassPermissions)'
          : `the agent asks less than by default (defaultMode is ${value})`;
      if (h.name.endsWith('sandbox_mode'))
        return `${name} runs every command outside the sandbox: ${value}`;
      if (h.name.endsWith('folderTrust.enabled'))
        return `${name} switches off the question whether this folder is trusted: ${value}`;
      return `${name} approves tool calls without asking: ${value}`;
    case 'agent-plugin':
      if (h.name === 'plugin code') return 'is plugin code the agent loads and runs when it starts';
      return h.name.startsWith('enabledPlugins.') || h.name === 'plugin'
        ? `turns on the plugin: ${value}`
        : `adds a plugin source: ${value}`;
    case 'mcp-auto-approve':
      if (h.name.endsWith('.trust'))
        return `runs the tools of MCP server ${value} without asking (trust)`;
      return h.name === 'enabledMcpjsonServers'
        ? `starts the MCP server ${value} of .mcp.json without asking (enabledMcpjsonServers)`
        : 'starts every MCP server in the repository without asking (enableAllProjectMcpServers)';
    case 'mcp-server-runs-code':
      return unparsed
        ? 'an MCP server starts a shell or inline code (the file could not be fully read)'
        : `MCP server ${name} starts a shell or inline code, or its env or folder can make it run other code: ${value}`;
    case 'mcp-server':
      // An approval makes an ordinary server an error (see `escalateApproved`), and so does a
      // change that adds one to a host that does not ask (see `startsWithoutAsking`).
      if (h.severity !== 'error') return `MCP server ${name} starts: ${value}`;
      if (startsWithoutAsking(h))
        return `MCP server ${name} starts without asking once the folder is trusted, as this host starts every server of the list: ${value}`;
      if (h.status === 'changed')
        return `MCP server ${name} now starts something else, under a name the host may have approved before${shapeNote(h)}: ${value}`;
      if (h.status === 'new')
        return `MCP server ${name} is new, and starts once its host is told yes, or at once if the settings approve it${shapeNote(h)}: ${value}`;
      return inAttackShape(h)
        ? `MCP server ${name} downloads and runs code, or sends a secret out: ${value}`
        : `MCP server ${name} starts without asking, since the settings approve it: ${value}`;
    case 'editor-autorun-task':
      if (unparsed) return 'a task runs when the folder opens (the file could not be fully read)';
      return h.name === 'task.allowAutomaticTasks'
        ? 'tasks run when the folder opens, without asking (task.allowAutomaticTasks is on)'
        : `task ${name} runs when the folder opens: ${value}`;
    case 'agent-definition-hook':
      return `${name} hook in an agent definition runs: ${value}`;
    case 'instruction-hidden-text':
      return `instruction file holds invisible characters: ${value}`;
    case 'instruction-file':
      return 'instruction file the agent reads in every session';
    case 'binary-file':
      return BINARY;
    case 'devcontainer-host-command':
      return `initializeCommand runs on this machine before the container starts: ${value}`;
    case 'devcontainer-command':
      if (h.name === 'features')
        return `features adds code the dev container runs as root when it is built: ${value}`;
      if ((DEVCONTAINER_ACCESS_KEYS as readonly string[]).includes(h.name))
        return `${name} gives the dev container this machine's files, devices or powers, which its commands then reach: ${value}`;
      return `${name} runs in the dev container${shapeNote(h)}: ${value}`;
    case 'package-script-agent-path':
      return `npm runs the ${name} script on install, and it names an agent config file: ${value}`;
    case 'package-script':
      return `npm runs the ${name} script on install${shapeNote(h)}: ${value}`;
    case 'nested-bare-repo':
      return 'a bare git repository is committed here as plain files';
    case 'unreadable-config':
      if (unparsed)
        return "could not be read, and a host's own reader may still find what it runs in it";
      return h.name === 'stopped'
        ? 'could not be read to the end, so what it runs is not known'
        : `not read: ${value}`;
    case 'config-link-outside':
      return `is a link out of the repository, to: ${value}`;
    case 'config-submodule':
      return `is a submodule, so what it holds comes from another repository and was not read: ${value}`;
    case 'agent-run-file-changed':
      if (/^\d+ more files/.test(h.value)) return `${name} may also run ${value}`;
      return h.value === h.file
        ? `the ${name} may run this file: the command names it or a folder it is in, runs a tool that reads it, runs code of this repository that may load it, or does not say what it runs`
        : `the ${name} may run ${value} of this file`;
  }
}

/** The finding as a sentence, with `new` or `changed` in front when it came with a change. */
export function describe(h: TaggedHit, q: Quote): string {
  const text = sentence(h, q);
  return h.status === 'present' ? text : `${h.status}: ${text}`;
}

/** Where a finding is, as `file:line`, quoted. */
export const placeOf = (h: AgentHit, q: Quote): string => q(`${h.file}:${h.line}`);

export interface Groups {
  readonly failing: readonly TaggedHit[];
  /** New or changed, not failing, and more than a notice. */
  readonly review: readonly TaggedHit[];
  /** There before the change, not failing. Instruction files that did not change are left out. */
  readonly present: readonly TaggedHit[];
  /**
   * New or changed instruction files. Listed by name only: an edit to a dozen skills is
   * ordinary work, and a sentence each would bury the entries that run something.
   */
  readonly notices: readonly TaggedHit[];
}

export function groupHits(hits: readonly TaggedHit[], failOn: FailOn): Groups {
  const failing = hits.filter((h) => isFailing(h, failOn));
  const rest = hits.filter((h) => !isFailing(h, failOn));
  const changed = rest.filter((h) => h.status !== 'present');
  return {
    failing,
    review: changed.filter((h) => h.severity !== 'notice'),
    present: rest.filter((h) => h.status === 'present' && h.severity !== 'notice'),
    notices: changed.filter((h) => h.severity === 'notice'),
  };
}

/** The most notices a terminal lists before it says how many more there are. */
const MAX_NOTICES = 20;

/** The lines of one group for a terminal: a heading, then `  file:line  sentence` each. */
export function textGroup(heading: string, hits: readonly TaggedHit[]): string[] {
  if (hits.length === 0) return [];
  return [
    heading,
    ...hits.map((h) => `  ${placeOf(h, plainQuote)}  ${describe(h, plainQuote)}`),
    '',
  ];
}

/** Notices for a terminal: a heading, then `  file (new)` each, cut at a count. */
export function textNotices(heading: string, hits: readonly TaggedHit[]): string[] {
  if (hits.length === 0) return [];
  const more = hits.length > MAX_NOTICES ? [`  and ${hits.length - MAX_NOTICES} more`] : [];
  return [
    heading,
    ...hits
      .slice(0, MAX_NOTICES)
      .map(
        (h) =>
          `  ${plainQuote(h.file)} (${h.status})${h.kind === 'binary-file' ? `: ${BINARY}` : ''}`,
      ),
    ...more,
    '',
  ];
}
