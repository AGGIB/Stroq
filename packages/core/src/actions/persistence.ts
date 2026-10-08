import { EDITOR_AUTORUN_TEXT } from './git-exec.js';
import { normalizePathForMatch } from './normalize-path.js';
import {
  WINDOWS_WRITE_COMMANDS,
  hasInlineCode,
  isDownloadToFile,
  namesFile,
  shellAssignments,
  windowsVerb,
} from './self-config.js';
import { lex } from './shell-lex.js';
import { bodyMayBeScript } from './text-heredocs.js';
import { commandWord, splitSegments } from './shell-segments.js';
import { readWords, type Word } from './shell-words.js';
import { quotedSpans } from './written-text.js';

/**
 * Files that a trusted process runs later, by itself, as the user: a shell's startup
 * files, the SSH login hooks and `authorized_keys`, and the scheduler and service
 * directories. Writing one is how an injected instruction outlives the session that
 * carried it — and, unlike `CLAUDE.md`, it does not need the agent to be running to
 * take effect.
 *
 * The incident record has every one of them. The Claude Code worktree escape
 * (CVE-2026-55607) ends by overwriting `~/.zshenv`; the Antigravity `.vscode` time bomb
 * appends to `~/.zshrc`; an npm package that sets up an "MCP server" appends a key to
 * `~/.ssh/authorized_keys` and turns remote login on. All of it is ordinary text to
 * the hook, and none of it is a credential READ, so nothing else here saw it.
 *
 * Each dotfile is a whole path segment, so `.zshrc.bak` and `my.profile` are somebody's
 * own files. Every separator is `[/\\]+` for the reason `SELF_CONFIG_FILE` gives, and
 * the match is case-insensitive, as the filesystems that fold `.ZSHRC` are. The system
 * crontabs and unit directories under `/etc` are not here: an administrator edits those
 * every day, and a question for each would be the check people switch off.
 */
export const PERSISTENCE_FILE = new RegExp(
  [
    String.raw`(?<![\w.-])\.(?:zshrc|zshenv|zprofile|zlogin|zlogout|bashrc|bash_profile|bash_login|bash_logout|bash_aliases|profile|pam_environment|kshrc|cshrc|tcshrc|xprofile|xinitrc|xsession)(?![\w.-])`,
    String.raw`\.config[/\\]+fish[/\\]+(?:config\.fish|conf\.d|functions)(?![\w.-])`,
    // `/private/etc` is where macOS keeps `/etc`, and where a link to it resolves.
    String.raw`(?:(?<![\w.-])|(?<=[/\\]private))[/\\]etc[/\\]+(?:profile|bash\.bashrc|bashrc|zshenv|zshrc|zprofile|zlogin|environment|sudoers)(?![\w-])`,
    String.raw`(?<![\w.-])(?:[\w.]*_)?profile\.ps1(?![\w.-])`,
    // PowerShell's own name for its profile files, as a shell command writes it.
    String.raw`(?<![\w$])\$profile(?:\.(?:CurrentUser|AllUsers)(?:AllHosts|CurrentHost))?(?![\w])`,
    String.raw`\.ssh[/\\]+(?:authorized_keys2?|rc|environment)(?![\w.-])`,
    String.raw`[/\\]Library[/\\]+Launch(?:Agents|Daemons)(?![\w-])`,
    String.raw`\.config[/\\]+autostart(?![\w-])`,
    String.raw`\.config[/\\]+(?:systemd[/\\]+user|environment\.d)(?![\w-])`,
    String.raw`Start Menu[/\\]+Programs[/\\]+Startup(?![\w-])`,
  ].join('|'),
  'i',
);

/** `schtasks /create`, `launchctl submit`, a timer from `systemd-run`: the other ways to say `crontab`. */
const SCHEDULE_TASK =
  /\bschtasks(?:\.exe)?\s+\/create\b|\blaunchctl\s+(?:submit|bootstrap)\b|\bsystemd-run\b[^|;&\n]{0,400}?\s--on-(?:calendar|boot|startup|active|unit-active)\b|\b(?:Register|Set|New)-ScheduledTask\b|\breg(?:\.exe)?\s+add\s+\S{0,300}[/\\](?:Run|RunOnce)\b/i;
/** `crontab -l` only reads; every other form installs or removes a table. */
const CRONTAB_READ = /\s-l(?:\s|$)/;
/**
 * `at` and `batch` run what they are given later, once: `at now + 1 hour`, `at 17:00 -f job.sh`, `at midnight`, a
 * lone `batch`. A line of a source file or a document that begins with the word (`at = item.scheduledAt`, `at
 * least three`, `at noon we meet`) is no job: `at` refuses a time with a word in it that is not one ("garbled
 * time"), so a line is a job only when every word after the options is part of a time. `at -l`, `-c`, `-d` and
 * `-V` list, print, delete and name a version, and have no time.
 */
const AT_WORDS =
  /^(?:now|noon|midnight|teatime|today|tomorrow|next|am|pm|utc|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*|(?:min|hour|day|week|month|year)[a-z]*)$/i;
function isAJob(job: string): boolean {
  const words = readWords(job).words;
  let timed = false;
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] as Word;
    // What follows a redirect is the script of the job, not its time.
    if (word.redirect) break;
    const text = word.value;
    // `-f file`, `-q queue`, `-t time` take the word after them.
    if (!word.quoted && /^-[A-Za-z]+$/.test(text)) {
      if (/[fqt]$/.test(text)) i += 1;
      // `-t 202612251200` is the time.
      if (/t$/.test(text)) timed = true;
      continue;
    }
    // Only the characters of a time are one: `batch = []` and `at (x) => 1` are code, whatever words they hold.
    if (!/^[A-Za-z0-9+:./,\s-]*$/.test(text)) return false;
    // The pieces of a time are read as `at` reads them: `5pm` is `5` `pm`, `now+1hour` is `now` `+` `1` `hour`.
    for (const piece of text.match(/\d+|[A-Za-z]+/g) ?? []) {
      if (!/^\d/.test(piece) && !AT_WORDS.test(piece)) return false;
      timed = true;
    }
  }
  return timed || words[0]?.value.toLowerCase() === 'batch';
}
const AT_READ = /\s-[lcdrV](?:\s|$)/;
const AT_WORD = /(?:^|\s)(?:at|batch)(?=\s|$)/i;
/** Whether a text has the word `at` or `batch` where a command could begin, and so may schedule a job. */
const MENTIONS_A_JOB = /(?:^|[\s;&|({`])(?:at|batch)(?=[\s;&|)}`]|$)/i;

/**
 * The commands of the texts in which `at` and `batch` are looked for, as the lexer cuts them: it knows the bodies
 * of here-documents and the strings that span lines, which a cut by lines does not, so a line of prose that begins
 * `at noon` in a document that is text (`cat <<EOF`, a commit message) is not among them. The lines of a body are
 * among them where it may be a script that runs later: the command that is given it writes a file that is not a
 * text file (`cat > run.sh <<EOF`), or is a job (`at now <<EOF`). A document that a filter or an interpreter is given
 * is data or another language, and one that a shell is given is read as the program it is, by itself. A text the
 * lexer was not sure of is cut the plain way.
 */
export function jobStages(texts: readonly string[]): string[] {
  const stages: string[] = [];
  for (const text of texts) {
    if (!MENTIONS_A_JOB.test(text)) continue;
    const lexed = lex(text);
    if (lexed.uncertain) {
      stages.push(...splitSegments(text));
      continue;
    }
    for (const pipeline of lexed.pipelines)
      pipeline.forEach((stage, index) => {
        stages.push(stage.text);
        if (stage.heredoc !== null && bodyMayBeScript(stage, index > 0))
          stages.push(...splitSegments(stage.heredoc.body));
      });
  }
  return stages;
}

const runsLater = (segment: string): boolean => {
  const from = AT_WORD.exec(segment);
  if (from === null) return false;
  const job = segment.slice(from.index).trim();
  return !AT_READ.test(job) && isAJob(job);
};

/** Verbs whose DESTINATION is the last argument: `cp x ~/.zshrc` writes it, `cp ~/.zshrc x` reads it. */
const DESTINATION_LAST: ReadonlySet<string> = new Set(['cp', 'mv', 'install', 'ln', 'rsync']);
/**
 * Verbs that put their input into every file they are given. `rm`, `chmod`, `touch` and
 * `truncate` are not here: they change a startup file without installing anything in it,
 * and `chmod 600 ~/.ssh/config` is what `ssh` itself tells you to run.
 */
const ANY_ARGUMENT: ReadonlySet<string> = new Set(['tee', 'patch', 'sponge']);
/** Interpreters that take a program on the command line, with a version in the name (`python3.12`). */
const INLINE_INTERPRETER = /^(?:perl|python|ruby|node|bun|deno)[\d.]*$/;
/**
 * An inline interpreter that names a startup file is a write only if its code writes:
 * `python3 -c "print(open('/home/me/.zshrc').read())"` reads one. The gap after `open(` is
 * bounded; unbounded, a command of 100,000 `open(` took 21 s.
 */
const INLINE_WRITE =
  /write|append|\bopen\s*\([^)]{0,200},\s*['"][^'"]{0,8}[wax+]|\b(?:copy\w*|move|rename|symlink|link|system|popen|exec\w*|spawn\w*|subprocess|tee|sed)\b|>>/i;
/** An interpreter started with its program on the command line: `python3.12 -c`, `perl -le`, `node -pe`. */
/** Interpreters that take a program on the command line, followed by their options. */
const INTERPRETER_WORD = /\b(?:perl|python|ruby|node|bun)[\d.]*(?=\s)/g;
const MAX_INTERPRETER_CALLS = 64;
const MAX_INLINE_CODE_CHARS = 64 * 1024;

/**
 * Whether the command starts an interpreter with its program on the command line:
 * `python3.12 -c`, `perl -le`, `node -pe`, within the first few options. Read word by word:
 * a regular expression that let a run of option letters be split two ways took 3.3 s on
 * `python3 -EEEE…` of 64 KiB.
 */
function inlineInterpreterCode(command: string): string[] {
  INTERPRETER_WORD.lastIndex = 0;
  const code: string[] = [];
  let calls = 0;
  for (let m = INTERPRETER_WORD.exec(command); m !== null; m = INTERPRETER_WORD.exec(command)) {
    calls += 1;
    if (calls > MAX_INTERPRETER_CALLS) return [command];
    const after = m.index + m[0].length;
    const options = command
      .slice(after, after + 400)
      .trim()
      .split(/\s+/)
      .slice(0, 5);
    let inline = false;
    for (const word of options) {
      if (!word.startsWith('-')) break;
      const letters = /^-([A-Za-z]+)(?:=.*)?$/.exec(word)?.[1];
      if (
        (letters !== undefined && /[ecEp]/.test(letters)) ||
        /^--(?:eval|print)(?:=|$)/.test(word)
      ) {
        inline = true;
        break;
      }
    }
    if (!inline) continue;
    // The program is the first quoted string after the interpreter; unquoted, the rest of the line.
    const rest = command.slice(after, after + MAX_INLINE_CODE_CHARS);
    const quoted = quotedSpans(rest)[0];
    code.push(quoted ?? rest.split('\n')[0] ?? '');
  }
  return code;
}

/** A URL is where a download comes from, not where it goes: `curl -o /tmp/x https://…/.bashrc`. */
const URL_WORD = /^[a-z][a-z0-9+.-]*:\/\//i;
/**
 * `> file`, `2>> file`, `>| file`, `{fd}> file` (a descriptor the shell makes), `1<> file` (opened to read and write),
 * zsh's `>! file` and `>>! file`, and the redirects that send both streams to a file: `&> file`, `&>> file`, `>& file`
 * (bash and zsh), `>>& file`, `&>| file`, `&>! file` (zsh). `>&2` and `2>&1` copy a descriptor and name no file.
 */
const REDIRECT_OPERATOR = /^(?:(?:\d*|\{[A-Za-z_]\w*\})(?:>>?[|!]?|<>)|&>>?[|!]?|>>?&[|!]?)$/;
const REDIRECT_GLUED = /^(?:&>>?[|!]?|>>?&[|!]?|(?:\d*|\{[A-Za-z_]\w*\})(?:>>?[|!]?|<>))(.+)$/;
const RELATIVE_PATH = /^(?![/\\~$]|[A-Za-z]:)/;
const MAX_BRACE_ALTERNATIVES = 16;

const unquote = (word: string): string => word.replace(/["']/g, '');

/**
 * `~/.{zshrc,bashrc}` as the shell expands it: braces with alternatives, a few rounds, at
 * most `MAX_BRACE_ALTERNATIVES` words. Bounded so that a word of braces cannot multiply.
 */
function braceExpanded(word: string): string[] {
  let current = [word];
  for (let round = 0; round < 4; round += 1) {
    const next: string[] = [];
    let changed = false;
    for (const candidate of current) {
      const brace = /\{([^{},]*(?:,[^{},]*){1,15})\}/.exec(candidate);
      if (brace === null) {
        next.push(candidate);
        continue;
      }
      changed = true;
      const head = candidate.slice(0, brace.index);
      const tail = candidate.slice(brace.index + brace[0].length);
      for (const alternative of (brace[1] as string).split(','))
        next.push(`${head}${alternative}${tail}`);
    }
    current = next.slice(0, MAX_BRACE_ALTERNATIVES);
    if (!changed) break;
  }
  return current;
}

/** A shell word: quoted spans and other non-space characters, run together. */
const SHELL_WORD = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g;

/** `git show --output=<f>`, `git diff --output <f>`, `git archive -o <f>`: the file git writes. */
function gitOutputs(words: readonly string[]): string[] {
  const out: string[] = [];
  const archive = words.some((w) => w === 'archive' || w === 'format-patch');
  words.forEach((w, i) => {
    const glued = /^--output(?:-directory)?=(.+)$/.exec(w);
    if (glued) out.push(unquote(glued[1] as string));
    else if (
      (w === '--output' || w === '--output-directory' || (archive && w === '-o')) &&
      words[i + 1] !== undefined
    ) {
      out.push(unquote(words[i + 1] as string));
    }
  });
  return out;
}

/** Whether an interpreter's options ask it to edit its files in place (`perl -pi`, `ruby -i.bak`). */
const inPlaceEdit = (words: readonly string[]): boolean =>
  words.slice(1, 6).some((w) => /^-[A-Za-z]*i/.test(w));

/** The files a segment's redirects write: `>> ~/.zshrc`, `>~/.zshrc`, not `2>/dev/null`. */
function redirectTargets(words: readonly string[]): string[] {
  const targets: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as string;
    if (REDIRECT_OPERATOR.test(word)) {
      const next = words[i + 1];
      if (next !== undefined) targets.push(unquote(next));
      continue;
    }
    const glued = REDIRECT_GLUED.exec(word);
    if (glued) targets.push(unquote(glued[1] as string));
  }
  return targets.filter((t) => t !== '' && t !== '/dev/null' && !t.startsWith('&'));
}

/** The directory a `tar -C`, `tar --directory=` or `unzip -d` extracts into. */
function extractionDirectories(words: readonly string[]): string[] {
  const dirs: string[] = [];
  words.forEach((w, i) => {
    if (/^(?:-C|-d)$/.test(w) && words[i + 1] !== undefined)
      dirs.push(unquote(words[i + 1] as string));
    const long = /^--directory=(.+)$/.exec(w);
    if (long) dirs.push(unquote(long[1] as string));
  });
  return dirs;
}

/**
 * The files this segment WRITES, as it spells them. Narrower than the self-tamper gate's
 * write intent on purpose: that gate reads any `>` as a write because a question about
 * its own configuration is cheap, and applied here it asked about `grep … ~/.ssh/config
 * 2>/dev/null` and about every `ssh host "… > /dev/null"`. A read of a startup file is
 * not an installation, so the writer verb must act on the file, a redirect must land in
 * it, and for the verbs that have a source and a destination it must be the destination.
 */
function writtenFiles(segment: string, word: string): string[] {
  // A quoted string is one word: `git commit -m "… >> ~/.zshrc"` has no redirect in it, and
  // `"C:\…\Start Menu\Programs\Startup\x.bat"` is one path though it has a space.
  const words = segment.match(SHELL_WORD) ?? [];
  const targets = redirectTargets(words);
  const verb = windowsVerb(word);
  const args = words
    .slice(1)
    .filter((w) => !w.startsWith('-'))
    .map(unquote);
  const lower = word.toLowerCase();
  if (DESTINATION_LAST.has(word) && args.length > 0) targets.push(args[args.length - 1] as string);
  else if (word === 'git' && args[0] === 'clone' && args.length > 2) {
    targets.push(args[args.length - 1] as string);
  } else if (word === 'git') targets.push(...gitOutputs(words));
  else if (INLINE_INTERPRETER.test(lower) && inPlaceEdit(words)) {
    // `perl -pi -e '…' ~/.zshrc`, `ruby -i -pe …`: the interpreter rewrites the files it is given.
    targets.push(
      ...words
        .slice(1)
        .filter((w) => !w.startsWith('-') && !/^['"]/.test(w))
        .map(unquote),
    );
  } else if (word === 'sed') {
    // `-i`, `-i.bak`, `-ni`, `--in-place`, `--in-place=.bak`: an option whose letters include `i`.
    if (words.some((w) => /^-[A-Za-z]*i/.test(w) || /^--in-place(?:=|$)/.test(w)))
      targets.push(...args);
  } else if (ANY_ARGUMENT.has(word)) targets.push(...args);
  else if (word === 'dd') {
    for (const w of words) if (w.startsWith('of=')) targets.push(unquote(w.slice(3)));
  } else if (word === 'defaults') {
    const write = args.findIndex((a) => /^(?:write|import|delete|rename)$/.test(a));
    if (write !== -1 && args[write + 1] !== undefined) targets.push(args[write + 1] as string);
  } else if (lower === 'plistbuddy') {
    if (args.length > 0) targets.push(args[args.length - 1] as string);
  } else if (word === 'tar' || word === 'unzip') targets.push(...extractionDirectories(words));
  else if (WINDOWS_WRITE_COMMANDS.has(verb)) targets.push(...words.slice(1).map(unquote));
  else if (isDownloadToFile(segment, word)) {
    targets.push(
      ...words
        .slice(1)
        .map(unquote)
        .filter((w) => !URL_WORD.test(w)),
    );
  }
  return targets.flatMap(braceExpanded);
}

/** What a `cd` or `pushd` segment moves into, or null. */
function changedDirectory(segment: string, word: string): string | null {
  if (word !== 'cd' && word !== 'pushd') return null;
  const target = segment
    .split(/\s+/)
    .slice(1)
    .find((w) => w !== '' && !w.startsWith('-'));
  return target === undefined ? null : unquote(target);
}

/** A segment of a command, the program it runs, and the files it writes (see `writtenFiles`). */
interface SegmentWrites {
  readonly segment: string;
  readonly word: string;
  /** The files the segment writes, as a writer verb, a redirect or a download names them. */
  readonly written: readonly string[];
  /**
   * Every word of an inline interpreter whose code writes (`python3 -c "open(…,'a')"`): the
   * file is somewhere in the code, so each word is asked whether it names a startup file.
   * Not a list of files, so it is not read for what is written to them.
   */
  readonly inline: readonly string[];
}

/** The words of a segment whose inline interpreter code writes a file, or none. */
function inlineWriteWords(segment: string, word: string): string[] {
  if (!INLINE_INTERPRETER.test(word.toLowerCase()) || !hasInlineCode(segment)) return [];
  if (!inlineInterpreterCode(segment).some((code) => INLINE_WRITE.test(code))) return [];
  return (segment.match(SHELL_WORD) ?? []).map(unquote);
}

/**
 * How many `)` a segment ends with, read back from its end. Not `/[\s)]*$/`, which is
 * retried from every position and took 35 s on a run of 256 KiB of spaces.
 */
function trailingCloses(raw: string): number {
  let count = 0;
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const ch = raw.charAt(i);
    if (ch === ')') count += 1;
    else if (!/\s/.test(ch)) break;
  }
  return count;
}

/**
 * Each segment with the files it writes, a relative name joined to the directory the
 * command is in as well as spelled as written: the process's own working directory, then
 * whatever an earlier `cd` moved into (`cd ~/.ssh && echo k >> authorized_keys`). A `cd`
 * inside parentheses runs in a subshell and is undone when it closes: `cd ~/.config/systemd/
 * user && (cd /tmp) && echo … > x.service` writes the unit.
 */
function segmentWrites(segments: readonly string[], cwd: string | null): SegmentWrites[] {
  let directory: string | null = cwd;
  const saved: Array<string | null> = [];
  const out: SegmentWrites[] = [];
  for (const raw of segments) {
    const opens = /^[\s(]*/.exec(raw)?.[0].replace(/\s/g, '').length ?? 0;
    for (let k = 0; k < opens; k += 1) saved.push(directory);
    // `(cd ~/.ssh && …)` and `{ cd ~/.ssh; …; }` begin with the grouping, not the command.
    const segment = raw.replace(/^(?:\s|\(|\{(?=\s|$))+/, '');
    const word = commandWord(segment);
    directory = changedDirectory(segment, word) ?? directory;
    const spelled = writtenFiles(segment, word);
    const moved = directory;
    const written =
      moved === null
        ? spelled
        : spelled.flatMap((file) =>
            RELATIVE_PATH.test(file) ? [file, `${moved}/${file}`] : [file],
          );
    out.push({ segment, word, written, inline: inlineWriteWords(segment, word) });
    const closes = trailingCloses(raw);
    for (let k = 0; k < closes && saved.length > 0; k += 1) directory = saved.pop() ?? null;
  }
  return out;
}

/**
 * Every file a command writes, as spelled and as its directory would resolve it, without
 * repeats. Not capped: the caller asks each one only cheap questions about its path, and a
 * cap was a place to hide the one that matters behind decoys.
 */
export function commandWrittenFiles(
  segments: readonly string[],
  cwd: string | null = null,
): string[] {
  return [...new Set(segmentWrites(segments, cwd).flatMap((entry) => entry.written))];
}

/**
 * `persistence-file-write` for a segment that writes one of the files above (see
 * `writtenFiles`), with a variable assigned earlier in the command expanded, as the
 * instruction-file check does. `crontab` and the other ways to schedule a job need no
 * file in the text: installing the job is the whole of what they do.
 */
export function persistenceSignals(
  segments: readonly string[],
  command = '',
  cwd: string | null = null,
  /**
   * The commands of the reading as the lexer cuts them, which `at` and `batch` are looked for in: the lexer knows
   * the bodies of here-documents and the strings that span lines, and a line of prose in one that begins `at noon`
   * is no command. `segments` are cut where the shell cuts and keep those lines, which a write to a startup file
   * needs (`cat <<EOF >> ~/.zshrc`). A document that a shell is given is read as the program it is, by itself.
   */
  commands: readonly string[] = segments,
): string[] {
  const assigned = shellAssignments(segments);
  const out = new Set<string>();
  const autorunText = EDITOR_AUTORUN_TEXT.test(command);
  const sshDirective = SSH_COMMAND_DIRECTIVE.test(command);
  // Code given to an interpreter on the command line is cut at every `;` and `&&` in it,
  // whatever the quotes say, so the interpreter and the file it names can land in different
  // segments. The command as a whole is asked as well.
  if (
    inlineInterpreterCode(command).some(
      (code) => INLINE_WRITE.test(code) && PERSISTENCE_FILE.test(code),
    )
  ) {
    out.add('persistence-file-write');
  }
  for (const { segment, word, written, inline } of segmentWrites(segments, cwd)) {
    if (word === 'crontab' && !CRONTAB_READ.test(segment)) out.add('crontab-write');
    if (SCHEDULE_TASK.test(segment)) out.add('scheduled-task-create');
    if ([...written, ...inline].some((file) => namesFile(file, assigned, PERSISTENCE_FILE))) {
      out.add('persistence-file-write');
    }
    if (sshDirective && written.some((file) => namesFile(file, assigned, SSH_CONFIG_FILE))) {
      out.add('persistence-file-write');
    }
    // The text of an auto-run task, in a command that writes the file it belongs in:
    // `cat > .vscode/tasks.json <<EOF`. A document that merely quotes one is written
    // to some other file.
    if (autorunText && written.some((file) => AUTORUN_FILE.test(file))) {
      out.add('editor-autorun-task');
    }
  }
  for (const segment of commands) {
    const word = commandWord(segment);
    if ((word === 'at' || word === 'batch') && runsLater(segment)) out.add('scheduled-task-create');
  }
  return [...out];
}

/** The files an editor reads an auto-run task from. */
const AUTORUN_FILE = /(?:^|[/\\])(?:tasks\.json|settings\.json|[^/\\]+\.code-workspace)$/i;

/**
 * `~/.ssh/config` runs a program only through a handful of directives. Adding a `Host`
 * entry is ordinary, so the file is persistence only when what is written names one.
 */
const SSH_CONFIG_FILE = /\.ssh[/\\]+config(?:\.d[/\\]+[^/\\]+)?(?![\w.-])/i;
const SSH_COMMAND_DIRECTIVE =
  /\b(?:ProxyCommand|LocalCommand|PermitLocalCommand|KnownHostsCommand)\b|\bMatch\s+(?:\S+\s+){0,6}?exec\b/i;

/** Whether `path` is an SSH client configuration file. */
export const isSshConfigPath = (path: string): boolean =>
  SSH_CONFIG_FILE.test(normalizePathForMatch(path));

/** Whether `text`, written to `path`, makes an SSH client configuration that runs a command. */
export function sshConfigRunsCommand(path: string, text: string): boolean {
  return SSH_CONFIG_FILE.test(normalizePathForMatch(path)) && SSH_COMMAND_DIRECTIVE.test(text);
}

/** True for a path the user's own shell, login or scheduler will run something from. */
export function isPersistencePath(path: string): boolean {
  return PERSISTENCE_FILE.test(normalizePathForMatch(path));
}
