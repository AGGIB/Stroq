import { isDangerousRmTarget } from './dangerous-target.js';

/**
 * The dangerous PowerShell and cmd forms, added to the classifier the POSIX shells
 * already go through.
 *
 * ## Why this exists
 *
 * Two agents list `powershell` as a shell tool, and the command text went straight to
 * `classify-bash.ts`, which looks for `curl … | sh`, for `rm -rf`, for `base64 -d`.
 * PowerShell writes every one of those differently, so the flagship shapes —
 * `iwr … | iex`, `Remove-Item -Recurse -Force C:\`, `powershell -enc …` — classified
 * to nothing at all and the hook answered `allow`. Not "less accurately": the
 * measured result before this module was an empty class list for every one of them.
 *
 * ## Why it is not gated on a dialect
 *
 * The obvious design is a flag from the adapter saying which shell a command is
 * written in, and it is the wrong one. Copilot and Antigravity also expose
 * `run_command` and `terminal`, which on Windows ARE PowerShell under a
 * dialect-neutral name, and a `bash` tool on Windows may be Git Bash, WSL or a shim.
 * Nothing in the payload settles it. A flag would therefore be a guess, and a guess
 * that came out wrong would reinstate the silent clean this module removes, one
 * layer further up where it is harder to see. So these detectors run on every
 * command, and each is written to be inert on POSIX text: `Invoke-WebRequest`,
 * `Remove-Item`, `Format-Volume` and `-EncodedCommand` do not occur in a shell
 * command that means something else. The cost is the one this codebase already
 * accepts elsewhere (see `disablesAgentPlugin`): a command that merely QUOTES one of
 * these names can be classified, which is the conservative direction.
 *
 * ## Why there is an "I could not read this" verdict
 *
 * The alternative to a real PowerShell parser is a subset, and a subset that stays
 * quiet about what it did not understand is the same silent clean in a new place. So
 * a dynamic-execution sink whose operand cannot be read — `iex $payload`, `& $cmd`,
 * a pipeline fed into `iex` from something that is not a fetch — yields
 * `shell.unparsed`, which the default policy turns into an `ask`.
 *
 * That verdict is deliberately triggered by a CONSTRUCT and never by failure to
 * recognise a command. Asking about every PowerShell command Stroq does not know
 * would put a prompt in front of `Get-ChildItem`, and a check that fires on ordinary
 * work is a check people switch off — the same reasoning that keeps husky hooks out
 * of `repo-surface.ts`'s findings. What is left uncovered by that choice is stated
 * rather than implied: a dangerous cmdlet this file does not name, spelled plainly
 * with literal arguments, is still classified as nothing.
 */

/**
 * PowerShell's HTTP surface, and the two Windows LOLBins that exist to fetch files.
 * `curl` and `wget` are absent on purpose: they are PowerShell aliases for
 * `Invoke-WebRequest`, and `classify-bash.ts` already treats both as network
 * commands under either spelling.
 */
const PS_NETWORK =
  /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer|Net\.WebClient|DownloadString|DownloadFile|DownloadData)\b/i;
/** `certutil` and `bitsadmin` are ordinary admin tools until they are given a transfer to do. */
const PS_LOLBIN_FETCH = /\bcertutil\b[^\n]*-urlcache\b|\bbitsadmin\b[^\n]*\/transfer\b/i;

const isPsNetwork = (segment: string): boolean =>
  PS_NETWORK.test(segment) || PS_LOLBIN_FETCH.test(segment);

/**
 * `Invoke-Expression` and its alias, as a whole word.
 *
 * `iex` is also the Elixir REPL, which is why nothing here treats the bare word as a
 * signal on its own: it counts only as a pipeline sink standing alone, or with an
 * operand that is plainly an expression. `iex -S mix` and `iex --version` are
 * neither, and are left alone.
 */
const EXEC_SINK_ALONE = /^(?:iex|invoke-expression)$/i;
/** `iex $x`, `iex (…)`, `iex @(…)` — an operand whose value this file cannot read. */
const EXEC_SINK_EXPRESSION = /(?:^|[\s;|({])(?:iex|invoke-expression)\s+[$(@[]/i;
/**
 * PowerShell's call operator applied to an expression: `& $cmd`, `&(Get-Thing)`.
 * The dot-sourcing operator is deliberately not here — `. $HOME/.bashrc` is ordinary
 * POSIX work, and flagging it would cost a prompt on something nobody needs to see.
 */
const CALL_OPERATOR_EXPRESSION = /(?:^|[\s;|({])&\s*[$(]/;

/**
 * `-EncodedCommand` and the prefixes PowerShell accepts for it. Anchored on the
 * interpreter's own name in the same segment, so `sed -e` and `node -e` — which
 * share the short spelling — are untouched.
 */
const PS_ENCODED_COMMAND =
  /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*?\s-e(?:c|nc|ncodedcommand)?\s+\S/i;
/** The same flag reached through a wrapper that does not name the interpreter. */
const PS_ENCODED_COMMAND_LONG = /\s-(?:enc|encodedcommand)\s+\S/i;
/** Decoding in-process, which is how a payload avoids the flag above entirely. */
const PS_BASE64_DECODE = /\[(?:System\.)?Convert\]::FromBase64String/i;

/** Cmdlets that destroy a volume rather than a file; no target check applies. */
const PS_DISK_DESTRUCTIVE =
  /\b(?:Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition|diskpart)\b/i;

/** The whole environment listed at once, PowerShell's spelling of `env`/`printenv`. */
const PS_ENV_DUMP = /(?:^|[\s;|(])(?:Get-ChildItem|Get-Item|gci|gi|ls|dir)\s+env:(?![\w:])/i;

/**
 * Verbs that delete a tree. `rm` is here as well as in the POSIX check because in
 * PowerShell it is an alias for `Remove-Item` and takes `-Recurse` rather than `-r`,
 * so the POSIX reader — which needs a combined short flag containing `r` — does not
 * see the recursion.
 */
const RECURSIVE_DELETE_VERBS = new Set(['remove-item', 'ri', 'rm', 'rd', 'rmdir', 'del', 'erase']);
/** `-Recurse` and the prefixes PowerShell accepts, plus cmd's `/s`. */
const RECURSE_FLAG = /^(?:-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?|\/s)$/i;

/**
 * Tokens split on whitespace ONLY.
 *
 * `tokenize` in shell-segments.ts strips backslashes, which is correct for POSIX —
 * there a backslash escapes the next character — and destroys a Windows path, since
 * `C:\Windows\System32` would come back as one meaningless word. Nothing in this
 * file may use that reader, and nothing in `classify-bash.ts` may use this one.
 */
const psTokens = (segment: string): string[] =>
  segment
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '');

/** A command word with its directory and its Windows extension taken off. */
const psVerb = (token: string): string =>
  token
    .replace(/^.*[/\\]/, '')
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();

/**
 * A recursive delete aimed somewhere outside the working tree. The target test is
 * `isDangerousRmTarget`, shared with the POSIX `rm` check rather than reimplemented,
 * so the two cannot drift: a target that is dangerous for one is dangerous for both.
 */
function psDeleteIsDangerous(segment: string, cwd: string): boolean {
  const tokens = psTokens(segment);
  const verbAt = tokens.findIndex((t) => RECURSIVE_DELETE_VERBS.has(psVerb(t)));
  if (verbAt < 0) return false;
  const args = tokens.slice(verbAt + 1);
  if (!args.some((a) => RECURSE_FLAG.test(a))) return false;
  return args
    .filter((a) => !a.startsWith('-') && !a.startsWith('/'))
    .some((a) => isDangerousRmTarget(a, cwd));
}

/** Signals this module contributes, grouped by the action class that carries them. */
export interface PowerShellSignals {
  readonly encoded: readonly string[];
  readonly network: readonly string[];
  readonly destructive: readonly string[];
  readonly secrets: readonly string[];
  readonly unparsed: readonly string[];
}

const EMPTY_SIGNALS: PowerShellSignals = {
  encoded: [],
  network: [],
  destructive: [],
  secrets: [],
  unparsed: [],
};

/**
 * Reads the already-split segments of one command. Splitting is shared with the
 * POSIX path and needs no dialect of its own: PowerShell and cmd use the same `|`,
 * `;`, `&&` and `||` that `splitSegments` breaks on.
 */
export function powershellSignals(segments: readonly string[], cwd: string): PowerShellSignals {
  if (segments.length === 0) return EMPTY_SIGNALS;
  const encoded: string[] = [];
  const network: string[] = [];
  const destructive: string[] = [];
  const secrets: string[] = [];
  const unparsed: string[] = [];

  segments.forEach((segment, i) => {
    if (isPsNetwork(segment)) network.push('ps-network-command');
    if (PS_ENCODED_COMMAND.test(segment) || PS_ENCODED_COMMAND_LONG.test(segment))
      encoded.push('ps-encoded-command');
    if (PS_BASE64_DECODE.test(segment)) encoded.push('ps-base64-decode');
    if (PS_DISK_DESTRUCTIVE.test(segment)) destructive.push('ps-disk-destructive');
    if (psDeleteIsDangerous(segment, cwd)) destructive.push('ps-delete-dangerous-target');
    if (PS_ENV_DUMP.test(segment)) secrets.push('env-dump');

    // A fetch and an execution in ONE segment is the download cradle written without
    // a pipe: `IEX (New-Object Net.WebClient).DownloadString(…)`.
    const sinkHere = EXEC_SINK_ALONE.test(segment) || EXEC_SINK_EXPRESSION.test(segment);
    if (sinkHere && isPsNetwork(segment)) {
      encoded.push('ps-remote-exec');
      return;
    }
    // Split across a pipe, the source is an earlier segment: `iwr … | iex`.
    // `i > 0` is what makes this a pipeline SINK rather than a bare word: `iex`
    // standing alone at the head of a command executes nothing — in PowerShell it
    // waits for an argument, and in Elixir it is the REPL — so flagging it would
    // put a confirmation prompt in front of `iex` every time an Elixir developer
    // opened a shell.
    if (i > 0 && EXEC_SINK_ALONE.test(segment)) {
      // Whatever came down the pipe is executed. If it was fetched, that is the
      // download cradle; if it was anything else, Stroq did not read what runs and
      // says so rather than reporting a command it never classified.
      if (segments.slice(0, i).some(isPsNetwork)) encoded.push('ps-remote-exec');
      else unparsed.push('ps-exec-unreadable-pipe');
      return;
    }
    if (EXEC_SINK_EXPRESSION.test(segment)) unparsed.push('ps-exec-expression');
    if (CALL_OPERATOR_EXPRESSION.test(segment)) unparsed.push('ps-call-operator-expression');
  });

  return { encoded, network, destructive, secrets, unparsed };
}
