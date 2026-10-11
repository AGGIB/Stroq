import type { ActionClass } from '../types.js';
import {
  agentDefinitionHasHooks,
  isAgentDefinitionPath,
  isMcpConfigPath,
  mcpConfigRunsCode,
} from './agent-config.js';
import type { ToolClassification } from './classify-tool.js';
import {
  editorAutorunText,
  iniRisk,
  isEditorAutorunPath,
  isGitConfigPath,
  type GitConfigRisk,
} from './git-exec.js';
import { NONE, mergeClassifications } from './merge-classifications.js';
import { commandWrittenFiles, isSshConfigPath, sshConfigRunsCommand } from './persistence.js';
import { commandTexts } from './written-text.js';

/**
 * What the TEXT written to `path` is, beyond where it goes: git configuration that runs a
 * command, an editor task that runs on opening the folder, an SSH client configuration
 * that runs a program, an MCP server that starts a shell, an agent definition with hooks.
 * The path rules cannot see these, and the pages that steer an agent into writing them
 * are the ones the scan calls clean.
 *
 * Each string a write carries is read on its own: joined, a harmless `description` beside
 * the content diluted a config that was otherwise recognised.
 */
export function classifyWrittenText(
  path: string,
  facts: WrittenTextFacts | null,
): ToolClassification {
  if (facts === null) return NONE;
  const { bodies } = facts;
  const classes: ActionClass[] = [];
  const signals: string[] = [];
  const found = (test: (body: string) => boolean): boolean => bodies.some(test);
  if (facts.gitConfig !== null && isGitConfigPath(path)) {
    if (facts.gitConfig === 'exec') {
      classes.push('config.git_exec');
      signals.push('git-exec-config-text');
    } else {
      classes.push('config.persistence');
      signals.push(
        facts.gitConfig === 'unread' ? 'git-config-text-unread' : 'git-config-runs-program',
      );
    }
  }
  // The path is asked first: a call can name thousands of paths and carry thousands of
  // strings, and only a file of one of these kinds is read for its text.
  if (isEditorAutorunPath(path) && found((body) => editorAutorunText(path, body))) {
    classes.push('config.persistence');
    signals.push('editor-autorun-task');
  }
  if (isSshConfigPath(path) && found((body) => sshConfigRunsCommand(path, body))) {
    classes.push('config.persistence');
    signals.push('ssh-config-command');
  }
  if (isMcpConfigPath(path) && found((body) => mcpConfigRunsCode(path, body))) {
    classes.push('config.instructions_payload');
    signals.push('mcp-config-runs-code');
  }
  if (isAgentDefinitionPath(path) && found((body) => agentDefinitionHasHooks(path, body))) {
    classes.push('config.instructions_payload');
    signals.push('agent-definition-hooks');
  }
  return { classes, hosts: [], signals };
}

/**
 * What about the written texts does not depend on where they are written, worked out once:
 * a call can name thousands of paths, and the text is the same for each. Null for no text.
 */
export interface WrittenTextFacts {
  readonly bodies: readonly string[];
  readonly gitConfig: GitConfigRisk;
}

const GIT_RISK_ORDER: readonly GitConfigRisk[] = ['exec', 'program', 'unread'];

export function writtenTextFacts(texts: readonly string[]): WrittenTextFacts | null {
  const bodies = texts.filter((text) => text !== '');
  if (bodies.length === 0) return null;
  const risks = new Set(bodies.map(iniRisk));
  const gitConfig = GIT_RISK_ORDER.find((risk) => risks.has(risk)) ?? null;
  return { bodies, gitConfig };
}

/**
 * What a shell command writes into a file whose contents are the point: the command is
 * its own text (a heredoc body is its lines) and so is each quoted string in it, so
 * `cat > .mcp.json <<EOF …` and `echo '[core] fsmonitor = x' > .alt/config` are read as
 * the `Write` of the same text would be.
 */
export function classifyCommandWrites(
  command: string,
  segments: readonly string[],
  cwd: string,
): ToolClassification {
  const files = commandWrittenFiles(segments, cwd);
  if (files.length === 0) return NONE;
  const facts = writtenTextFacts(commandTexts(command));
  return mergeClassifications(...files.map((file) => classifyWrittenText(file, facts)));
}
