// Which commands "a text the agent read told it to run": the strict rule of the card.
//
// Precision comes before everything here. On one real machine the loose link ("an action used an
// address, package or blob that was seen in something it read") made 216 links in 13 sessions and not one
// was an attack: agents fetching hosts they found in search results, localhost, a security tool's own
// README (flagged because it quotes attacks) followed by running that tool, a heredoc that writes a test
// file containing `curl … | sh`, GitHub `owner/repo` slugs and random ids taken as encoded blobs, and
// English words taken as package names. A command is counted here only when ALL of this holds:
//
//   1. it is a shell command (not a file write, an MCP call, a search);
//   2. its evidence comes from a read that was FLAGGED, and not the developer's own text;
//   3. the evidence is one of three shapes, and the command really does it:
//        pipe_shell  the command runs a download piped into a shell (not a file that contains one)
//        encoded     the command decodes the blob and runs it
//        pkg         the command installs or runs exactly that package, a valid name, not an English
//                    word, not declared by the project, not Stroq
//      a host or a URL is never enough;
//   4. it has a real effect: network, encoded execution, destruction, a secret file, a change of
//      configuration, or the policy denied or asked it.
//
// Nothing here changes what Stroq enforces. This is only how the card counts.
import {
  isPackageName,
  isStroq,
  nameOf,
  packagesOf,
  samePackage,
  type DeclaredPackages,
  type Ecosystem,
} from './package-claims.js';
import { baseOf, isShellWord, pipelinesOf, type StageView } from './shell-view.js';

/** The evidence a provenance link keeps (the fields of `ProvenanceEvidence` this reads). */
export interface LinkEvidence {
  readonly kind: string;
  readonly excerpt: string;
  readonly tool: string;
  readonly source: string;
  readonly at: string;
  readonly suspect: boolean;
  readonly flaggedOwn?: boolean;
}

/** The audit entry of an action (the fields of `AuditEntry` this reads). */
export interface LinkEntry {
  readonly tool: string;
  /** The command, redacted and clipped by the audit. */
  readonly summary: string;
  readonly classes?: readonly string[];
  readonly decision?: { readonly effect: string };
  readonly provenance?: readonly LinkEvidence[];
}

export type LinkShape = 'pipe_shell' | 'encoded' | 'pkg';

export interface StrictLink {
  readonly shape: LinkShape;
  readonly evidence: LinkEvidence;
  /** For `pkg`: the package the command runs. */
  readonly pkg?: string;
}

const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Monitor']);

/** The classes that mean the command does something. `origin.*` is the link itself and is not one. */
const EFFECT_CLASSES: ReadonlySet<string> = new Set([
  'shell.network',
  'shell.exec_encoded',
  'shell.destructive',
  'fs.secrets',
]);

/** Whether the action has an effect beyond being linked: see the rule above. */
export function hasRealEffect(entry: LinkEntry): boolean {
  const effect = entry.decision?.effect;
  if (effect === 'deny' || effect === 'ask') return true;
  return (entry.classes ?? []).some((c) => EFFECT_CLASSES.has(c) || c.startsWith('config.'));
}

const FETCHERS: ReadonlySet<string> = new Set(['curl', 'wget']);
const INTERPRETERS: ReadonlySet<string> = new Set([
  'python',
  'python3',
  'perl',
  'ruby',
  'node',
  'php',
]);
const PROCESS_SUBSTITUTION = /^\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\s+<\(\s*(?:curl|wget)\b/;
/** A decoder inside a substitution: `$(echo … | base64 -d)`. */
const DECODER_TEXT =
  /\bbase64\s+(?:-[A-Za-z]*[dD]\b|--decode\b)|\bxxd\s+-[a-z]*r\b|\bbasenc\b[^|)]*\s-d\b/;

const commandOf = (view: StageView): string => baseOf(view.words[view.cmd] ?? '');

const runsFetch = (view: StageView): boolean => view.cmd !== -1 && FETCHERS.has(commandOf(view));

const runsShell = (view: StageView): boolean =>
  view.cmd !== -1 && isShellWord(view.words[view.cmd]);

/** Whether a stage decodes: `base64 -d`, `xxd -r`, `openssl enc -d`, `basenc -d`, `uudecode`. */
function decodes(view: StageView): boolean {
  if (view.cmd === -1) return false;
  const flags = view.words.slice(view.cmd + 1);
  switch (commandOf(view)) {
    case 'base64':
      return flags.some((w) => /^-[A-Za-z]*[dD]$/.test(w) || w === '--decode');
    case 'xxd':
      return flags.some((w) => /^-[a-z]*r[a-z]*$/.test(w));
    case 'openssl':
      return flags.includes('-d') && (flags.includes('enc') || flags.includes('base64'));
    case 'basenc':
      return flags.includes('-d') || flags.includes('--decode');
    case 'uudecode':
      return true;
    default:
      return false;
  }
}

/** A real `curl … | sh`: a fetch piped straight into a shell, or a shell given `<(curl …)`. */
export function runsPipeToShell(pipelines: readonly (readonly StageView[])[]): boolean {
  for (const pipeline of pipelines) {
    for (const [i, stage] of pipeline.entries()) {
      if (PROCESS_SUBSTITUTION.test(stage.text)) return true;
      const before = pipeline[i - 1];
      if (before !== undefined && stage.piped && runsShell(stage) && runsFetch(before)) return true;
    }
  }
  return false;
}

/** A real decode that is run: a decoder piped into a shell or an interpreter, or a decode inside what one runs. */
export function decodesAndRuns(pipelines: readonly (readonly StageView[])[]): boolean {
  for (const pipeline of pipelines) {
    for (const [i, stage] of pipeline.entries()) {
      const word = stage.cmd === -1 ? '' : commandOf(stage);
      const runs = isShellWord(stage.words[stage.cmd]) || INTERPRETERS.has(word) || word === 'eval';
      if (!runs) continue;
      if (stage.piped && pipeline.slice(0, i).some(decodes)) return true;
      if (stage.nested.some((text) => DECODER_TEXT.test(text))) return true;
      if (/<\([^)]*(?:base64\s+-[A-Za-z]*[dD]|base64\s+--decode|xxd\s+-r)/.test(stage.text))
        return true;
    }
  }
  return false;
}

/** The package a pipeline runs that is exactly `name`, when one does. */
function runsPackage(
  pipelines: readonly (readonly StageView[])[],
  written: string,
): { readonly name: string; readonly ecosystem: Ecosystem } | null {
  const wanted = nameOf(written);
  for (const stage of pipelines.flat()) {
    for (const mention of packagesOf(stage)) {
      const name = nameOf(mention.name);
      if (samePackage(name, wanted, mention.ecosystem))
        return { name, ecosystem: mention.ecosystem };
    }
  }
  return null;
}

/** The strict link of an action, or null: see the rule at the top of this file. */
export function strictLink(entry: LinkEntry, declared: DeclaredPackages): StrictLink | null {
  if (!SHELL_TOOLS.has(entry.tool)) return null;
  const flagged = (entry.provenance ?? []).filter((e) => e.suspect && e.flaggedOwn !== true);
  if (flagged.length === 0 || !hasRealEffect(entry)) return null;
  const pipelines = pipelinesOf(entry.summary);
  if (pipelines.length === 0) return null;
  for (const evidence of flagged) {
    if (evidence.kind === 'pipe_shell' && runsPipeToShell(pipelines))
      return { shape: 'pipe_shell', evidence };
    if (
      evidence.kind === 'encoded' &&
      (entry.classes ?? []).includes('shell.exec_encoded') &&
      decodesAndRuns(pipelines)
    )
      return { shape: 'encoded', evidence };
    if (evidence.kind === 'pkg') {
      const run = runsPackage(pipelines, evidence.excerpt);
      if (
        run !== null &&
        !isStroq(run.name) &&
        isPackageName(run.name, run.ecosystem) &&
        !declared.has(run.name, run.ecosystem)
      )
        return { shape: 'pkg', evidence, pkg: run.name };
    }
  }
  return null;
}
