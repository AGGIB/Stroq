import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { cpuNow } from '../cpu-time.js';

/**
 * A command is written by the agent and reaches the classifier whole: hook stdin has
 * no length cap. The classifier runs inside the agent's hook, a regex that goes
 * super-linear blocks the event loop so Stroq's own deadline cannot fire, and a hook
 * that runs past the agent's timeout is answered by the agent — for Codex and Copilot,
 * as an allow. So every input below is one that used to take seconds (16 KiB of
 * `eval ` took 28 s; `find . -exec` and 4 KiB of spaces, 23.7 s), or the repeated
 * trigger of a pattern that could.
 *
 * What is held is the growth, not a number of milliseconds: each input is timed at a
 * sixteenth of its size, a quarter and its full size, and each is compared with the one
 * before. Linear work takes about four times as long; the patterns this guards against
 * took sixteen times as long or more. Only an input that is both slow and growing faster
 * than it should fails. A size that looks too slow is timed again, twice, and the least is kept: on a shared
 * runner one measurement of the same input has differed by a factor of three, and a quadratic pattern is slow
 * every time. A time alone does not work on a shared runner — linear work on
 * 37,000 lines of `eval x` took 1.3 s there under coverage, against 0.2 s on a laptop —
 * and a ratio alone does not work on timings of a millisecond, which are noise. Three
 * sizes and not two, because a command that is estimated to cost too much to read is not
 * read (`reading-cost.ts`) and is fast at the full size, which hid a pattern that took 17 s
 * at a quarter of it from a comparison of those two alone.
 */
const SIZE = 256 * 1024;
const SIZES = [SIZE / 16, SIZE / 4, SIZE] as const;
const BOUND_MS = 1_000;
/**
 * What a quadruple of the size may cost in times: linear work takes about four, quadratic work sixteen. The limit
 * was eight, the middle between them, and shapes that are linear failed it on a runner: from 64 KiB to 256 KiB
 * the reading of `git rebase -x 'x' ` repeated takes seven times as long (eight and a half on a shared runner with
 * coverage on) and from 128 KiB on it doubles with the size, so the step is a cost that arrives once (the string
 * and its pieces stop fitting in the caches), not a growth. A quadratic pattern is at fifteen or more every time.
 */
const MAX_GROWTH = 11;

type Build = (repeat: (unit: string) => string) => string;

const ADVERSARIAL: ReadonlyArray<readonly [string, Build]> = [
  ['eval chain', (r) => r('eval ')],
  ['eval with arguments', (r) => r('eval x ')],
  ['eval chain, lines', (r) => r('eval x\n')],
  ['find -exec and spaces', (r) => `find . -exec${r(' ')}x`],
  ['-exec heads', (r) => `find . ${r('-exec ')}`],
  ['slashes', (r) => `cat ${r('/')}x`],
  ['backslashes', (r) => `cat ${r('\\')}x`],
  ['rm -rf C: and slashes', (r) => `rm -rf C:${r('/')}x`],
  ['Remove-Item and backslashes', (r) => `Remove-Item C:${r('\\')}x`],
  ['word dots', (r) => r('a.')],
  ['ssh target shape', (r) => `ssh ${r('a.')}`],
  ['source dots', (r) => r('a.b ')],
  ['shells', (r) => r('bash ')],
  ['sh -c', (r) => r('sh -c ')],
  ['open quotes after sh -c', (r) => r('bash -c "')],
  ['process substitution, then dots', (r) => `<( ${r('. ')}`],
  ['git push', (r) => r('git push ')],
  ['git clean -', (r) => r('git clean -')],
  ['git -c', (r) => r('git x ')],
  ['git config', (r) => r('git config ')],
  ['config reads', (r) => r('config ')],
  ['git submodule foreach', (r) => r('git submodule foreach x ')],
  // A word of closers that ends in something else, in the arguments of a command of Stroq's own.
  ['stroq state command, parentheses', (r) => `stroq untaint ${r(')')}x`],
  ['stroq state command, braces', (r) => `stroq untaint ${r('}')}x`],
  ['dd', (r) => r('dd ')],
  ['terraform apply', (r) => r('terraform apply ')],
  ['drizzle-kit push', (r) => r('drizzle-kit push ')],
  ['prisma db push', (r) => r('prisma db push ')],
  ['supabase db reset', (r) => r('supabase db reset ')],
  ['gh repo create', (r) => r('gh repo create ')],
  ['/proc/', (r) => `cat ${r('/proc/')}`],
  ['certutil', (r) => r('certutil ')],
  ['bitsadmin', (r) => r('bitsadmin ')],
  ['powershell', (r) => r('powershell ')],
  ['Buffer.from(', (r) => `node -e ${r('Buffer.from(')}`],
  ['spaces', (r) => `echo${r(' ')}x`],
  ['tabs', (r) => `echo${r('\t')}x`],
  ['dots', (r) => `echo ${r('.')}`],
  ['quotes', (r) => `echo ${r("'")}`],
  ['double quotes', (r) => `echo ${r('"')}`],
  ['$(', (r) => `echo ${r('$(')}`],
  ['backticks', (r) => `echo ${r('`')}`],
  ['rm -rf', (r) => r('rm -rf ')],
  ['http://', (r) => `curl ${r('http://')}`],
  ['x@', (r) => `ssh ${r('x@')}`],
  ['semicolons', (r) => r(';')],
  ['pipes', (r) => r('|')],
  ['instruction file names', (r) => `echo x > ${r('CLAUDE.md ')}`],
  ['memory paths', (r) => `cat notes >> ${r('.claude/projects/')}`],
  ['memory path separators', (r) => `cat notes >> .claude/projects/x${r('/')}m`],
  // `joinText` (join-text.ts) reads every command once for quotes and heredocs.
  ['quoted heredoc operators with no close', (r) => `cat ${r("<<'a")}`],
  ['bare heredoc operators', (r) => `cat ${r('<<a ')}\n`],
  ['open quotes before sh -c', (r) => `${r('bash -c "x')}`],
  ['heredoc body lines', (r) => `cat <<EOF\n${r('stroq init\n')}`],
  ['stroq runner flags', (r) => `npx ${r('-y ')}stroq untaint`],
  // `stroq run -- …` starts the program after its `--`, and that program is read again as a command
  // line of its own, to a depth (`stroq-state.ts`).
  ['stroq launchers', (r) => r('stroq run -- ')],
  ['stroq launchers, then a command of Stroq', (r) => `${r('stroq run -- ')}stroq prove`],
  ['stroq mcp launchers', (r) => r('stroq mcp --server x -- ')],
  ['stroq launcher options', (r) => `stroq run ${r('--agent x ')}-- claude`],
  ['stroq launcher dashes', (r) => `stroq run ${r('-- ')}stroq prove`],
  ['stroq launchers under wrappers', (r) => r('sudo stroq run -- env -i ')],
  ['stroq launchers and shell strings', (r) => r("stroq run -- sh -c 'stroq run -- ")],
  ['stroq task prompts', (r) => `stroq task -- ${r('fix --help ')}`],
  ['many heredocs closed in turn', (r) => `cat ${r('<<a ')}\n${r('a\n')}`],
  // The 2026-Q3 detectors: persistence files, remote commands, trap and Windows bodies.
  ['redirects to startup files', (r) => r('echo x >> ~/.zshrc; ')],
  ['startup file names', (r) => `cat x >> ${r('.zshrc/')}`],
  ['ssh authorized_keys paths', (r) => `cp k ${r('.ssh/')}`],
  ['sed -i', (r) => r('sed -i x ')],
  ['crontab', (r) => r('crontab ')],
  ['schtasks', (r) => r('schtasks /create ')],
  ['ssh invocations', (r) => r('ssh a ')],
  ['ssh with open quote', (r) => r('ssh a "')],
  ['ssh with escaped quotes', (r) => `ssh a "${r('\\"')}`],
  ['ssh options', (r) => `ssh ${r('-o x ')}host`],
  ['ssh and pipes', (r) => `ssh a "${r('x | ')}`],
  ['a long pipeline of commands', (r) => `echo ${r('x | ')}`],
  ['a long pipeline ending in a shell', (r) => `${r('x | ')}sh`],
  ['trap', (r) => r('trap ')],
  ['trap with open quote', (r) => r("trap '")],
  ['cmd /c', (r) => r('cmd /c ')],
  ['cmd /c with open quote', (r) => r('cmd /c "')],
  ['cmd /c with escaped quotes', (r) => `cmd /c "${r('\\"')}`],
  ['powershell -Command', (r) => r('powershell -Command "')],
  ['powershell options', (r) => `powershell ${r('-NoProfile ')}-Command "x"`],
  ['kubectl delete', (r) => r('kubectl delete ')],
  ['gcloud words', (r) => `gcloud ${r('a ')}delete`],
  ['az words', (r) => `az ${r('a ')}delete`],
  ['aws s3 sync', (r) => r('aws s3 sync ')],
  ['aws services', (r) => `aws ${r('a-')}x`],
  ['git --output', (r) => `git show ${r('-o ')}`],
  ['rsync --delete', (r) => r('rsync --delete ')],
  ['lftp', (r) => r('lftp ')],
  ['script runners', (r) => r('bash x.sh; ')],
  ['dollar braces', (r) => `echo ${r('${a')}`],
  ['git config text keys', (r) => `echo "[core]" > c; ${r('fsmonitor = x\n')}`],
  // What reads fetched text that is run without a pipe (`fetched-exec.ts`) and code in values.
  ['dynamic commands after a fetch', (r) => `curl x; ${r('$x ; ')}`],
  ['fetch substitutions as commands', (r) => r('$(curl x) ')],
  ['variables from fetches', (r) => r('x=$(curl y); $x; ')],
  ['dynamic stages after a fetch', (r) => `curl x | ${r('$l | ')}`],
  ['interpreter programs from fetches', (r) => `curl x; ${r('python3 -c "$x" ; ')}`],
  ['here-strings after a fetch', (r) => `curl x; ${r('python3 <<< "$x" ; ')}`],
  ['named pipes after a fetch', (r) => `curl x; ${r('mkfifo p ; ')}`],
  ['prompt strings', (r) => r('PS4=x ')],
  ['prompt strings with text', (r) => r("PS4='a ")],
  ['subscripts', (r) => r('a[')],
  ['subscripts with text', (r) => r('a[b ')],
  ['subscript assignments', (r) => r('x=a[b ')],
  ['subscript assignment with a long name', (r) => `x=${r('a')}[`],
  ['export options', (r) => `export ${r('-x ')}`],
  ['read options', (r) => `read ${r('-r ')}`],
  ['abbreviated options', (r) => `curl x | tar ${r('--use-comp ')}`],
  ['bundled options', (r) => `curl x | tar ${r('xIf ')}`],
  ['env search options', (r) => `curl x | env ${r('-P b ')}head`],
  ['names read as variables', (r) => `curl x | head; ${r('PATH ')}`],
  ['names that are not', (r) => `curl x | head; ${r('MYPATH ')}`],
  ['enable options', (r) => `curl x | head; ${r('enable -f ')}`],
  ['here-documents in substitutions', (r) => r("$(cat <<'EOF'\n)\nEOF\n)")],
  ['here-documents in nested substitutions', (r) => r("$(echo $(cat <<'EOF'\nx\nEOF\n))")],
  // The fifth review's readings: what the shells read in ways of their own, what git is given to run,
  // the command lines of tools, a parameter as a program, and a script that is a process substitution.
  ['arithmetic openers', (r) => r("((x<<'EOF'))\n")],
  ['arithmetic openers with no close', (r) => r('((')],
  ['comments after brackets', (r) => r("(true)# <<'EOF'\n")],
  ['hashes after redirects', (r) => r('echo >#x <#y ')],
  ['ANSI-C strings with escapes', (r) => r("echo $'\\'' ; ")],
  ['ANSI-C strings with no close', (r) => `echo ${r("$'a\\")}`],
  ['pipes and a heredoc each line', (r) => r("cat <<'a' |\na\n")],
  ['git rebase -x', (r) => r("git rebase -x 'x' ")],
  ['git rebase -x with no value', (r) => r('git rebase -x ')],
  ['git difftool -x', (r) => r('git difftool -x ')],
  ['git grep -O', (r) => r('git grep -O ')],
  ['git clone -u', (r) => r('git clone -u x ')],
  ['git options that are one word with spaces', (r) => r("git fetch '--upload-pack=x y' ")],
  ['git ext urls', (r) => r('git fetch ext::x ')],
  ['git config keys by environment', (r) => r('GIT_CONFIG_KEY_0=core.fsmonitor ')],
  ['git exec path variables', (r) => r('GIT_EXEC_PATH=x ')],
  ['git remote keys', (r) => r('git config remote.o.uploadpack x; ')],
  ['variables that hold command lines', (r) => r("GIT_SSH_COMMAND='a b' ")],
  ['editor variables', (r) => r('EDITOR=x PAGER=y ')],
  ['default-assigning expansions of listed names', (r) => r('${PATH:=x} ')],
  ['parameters as programs', (r) => r('python3 -c "$x"; ')],
  ['parameter here-strings as programs', (r) => r('python3 <<< "$x"; ')],
  ['pipes into an interpreter from a parameter', (r) => r('echo "$x" | python3; ')],
  ['process substitution scripts', (r) => r('python3 <(echo "$(x)"); ')],
  ['process substitution scripts with no close', (r) => r('python3 <(echo ')],
  ['printers as command words', (r) => r('$(echo touch) x; ')],
  // The functions of a command (`inlined-functions.ts`): the pattern that finds a definition, the body
  // that is found for it, and the calls that are put in place, in each text read from the command.
  ['definition openers', (r) => r('f() { ')],
  ['definitions with a body', (r) => r('f() { x; }; ')],
  ['the function keyword', (r) => r('function f ')],
  ['the function keyword with parentheses', (r) => r('function f() ')],
  ['line breaks after a paren, then a brace', (r) => `(${r('\n')}){`],
  ['line breaks and blanks after a paren, then a brace', (r) => `(${r('\n ')}){`],
  ['starts and blanks', (r) => `${r('; ')}x(){`],
  ['names with dots and dashes', (r) => r('a.b-c:d() { x; }; ')],
  ['calls of a function', (r) => `f() { x "$@"; }; ${r('f a; ')}`],
  ['calls with arguments', (r) => `f() { x "$1" "$2" "$@"; }; ${r('f "a b" c d e; ')}`],
  ['calls with redirects', (r) => `f() { x "$1"; }; ${r('f 2> /dev/null a; ')}`],
  ['calls in a pipeline', (r) => `f() { x "$@"; }; ${r('f a | ')}`],
  ['calls in substitutions', (r) => `f() { x "$@"; }; ${r('echo $(f a); ')}`],
  ['calls in groups', (r) => `f() { x "$@"; }; ${r('{ f a; } ')}`],
  [
    'calls that call calls',
    (r) => `a() { b "$@"; }; b() { c "$@"; }; c() { x "$@"; }; ${r('a x; ')}`,
  ],
  ['calls in exported shells', (r) => `f() { x; }; export -f f; ${r("bash -c 'f'; ")}`],
  ['a long body', (r) => `f() { ${r('echo "$@" ; ')}}; f a`],
  ['a body with no end', (r) => `f() { ${r('echo "$@" ; ')}`],
  ['a body of quotes', (r) => `f() { ${r("echo '")}`],
  ['a body of substitutions', (r) => `f() { ${r('echo $(')}`],
  ['a body of comments', (r) => `f() { ${r('# x\n')}}; f`],
  ['a call with many words', (r) => `f() { x "$@"; }; f ${r('"a b" ')}`],
  ['a call with many words, one at a time', (r) => `f() { x "$1"; }; f ${r('a ')}`],
  ['one name defined again and again', (r) => `${r('f() { a; }; ')}f x`],
  // The second look at functions: names of any kind, declarations, case arms, comments and continuations
  // between a header and its body, the words of a call that are put in place, shifts, documents that
  // expand, and the configuration that git is given.
  ['comments after a header', (r) => `f() ${r('# a b c\n')}`],
  ['a comment that never ends after a header', (r) => `f() # ${r('a b ')}`],
  ['continuations after a header', (r) => `f() ${r('\\\n')}`],
  ['hashes and blanks after a header', (r) => `f() ${r('# ')}`],
  ['hashes and escaped line breaks after a header', (r) => `f() ${r('#\\\n')}`],
  ['names of every kind', (r) => r('a+b() { x; }; ')],
  ['declarations', (r) => r('export f() { x; }; ')],
  ['case arms', (r) => r('x) f() { y; };; ')],
  ['calls of functions named like wrappers', (r) => `sudo() { x "$@"; }; ${r('sudo a; ')}`],
  ['quoted words as arguments', (r) => `f() { x $1 $@; }; f ${r('"a b" ')}`],
  ['shifts', (r) => `f() { ${r('shift; ')}x; }; f a`],
  ['comments in a body', (r) => `f() { ${r('# don\'t "x\n')}x "$1"; }; f a`],
  ['parameters in a document', (r) => `f() { cat <<EOF\n${r('$1 ${2:-x} ${3%y} ')}\nEOF\n}; f a`],
  ['unquoted parameters', (r) => `f() { ${r('x $1 ${2:-w} ${@:2} $# ')}}; f a b`],
  ['git config parameters', (r) => r('GIT_CONFIG_PARAMETERS=')],
  ['git -c pairs', (r) => r('git -c a=b ')],
  ['git -c pairs with ext', (r) => r('git -c a=ext::b ')],
  ['git config keys by environment, quoted', (r) => r("GIT_CONFIG_KEY_0='url.ext::' ")],
  ['git --config-env pairs', (r) => r('git --config-env=a.url=B ')],
  ['definitions whose documents never end', (r) => r('f() { cat <<X\n')],
  ['definitions with a document and a body', (r) => r('f() { cat <<X\nx\nX\n}; ')],
  ['subshell definitions', (r) => r('f() ( x ); ')],
  ['subshell definition openers', (r) => r('f() ( ')],
  ['compound definitions', (r) => r('f() if x; then y; fi; ')],
  ['calls of subshell functions', (r) => `f() ( x "$@" ); ${r('f a; ')}`],
  ['calls spelled with quotes', (r) => `f() { x "$@"; }; ${r('"f" a; ')}`],
  ['parameters with defaults', (r) => `f() { x "\${1:-w}" "\${@:2}"; }; f ${r('a ')}`],
  ['parameter forms with no close', (r) => `f() { x ${r('"${1:-')}`],
  // What the second review of the function reading and the sweep of wrapping forms added.
  ['lines continued in the words of a call', (r) => `f() { x "$@"; }; f ${r('\\\n a ')}`],
  ['call words of semicolons', (r) => `f() { echo "$1"; }; f "${r(';')}"`],
  ['parameter forms of a long value', (r) => `f() { echo "\${1//a/b}" "\${1%.*}"; }; f ${r('a')}`],
  ['parameter forms of many values', (r) => `f() { echo ${r('"${1##*.}" ')}; }; f a.b`],
  ['arithmetic that does not close', (r) => `f() { ${r('((')} }; f`],
  ['arithmetic commands', (r) => `f() { ${r('(( x = 1 << 3 )); ')} }; f`],
  ['case arms', (r) => `case x in ${r('a) ls ;; ')}esac`],
  ['case headers', (r) => `case${r(' ')}in x) ls ;; esac`],
  ['zsh brace bodies', (r) => `${r('if x { ls }; ')}`],
  ['zsh brace openers', (r) => `if x${r(' ')}{ ls }`],
  ['watch strings', (r) => `watch -n1 ${r("'a b; c' ")}`],
  ['parallel templates and data', (r) => `parallel 'a b' ::: ${r('x ')}`],
  ['su options', (r) => `su ${r('-c ')}x`],
  ['script clusters', (r) => `script ${r('-qc ')}x`],
  ['entr options', (r) => `echo | entr ${r('-s ')}x`],
  ['npx options', (r) => `npx ${r('-c ')}x`],
  ['editor escapes', (r) => `vim ${r("-c '!x' ")}`],
  ['at lines', (r) => `cat > f.py <<'EOF'\n${r('at 5pm\n')}EOF`],
  ['stroq mentions', (r) => r('stroq untaint; ')],
  ['stroq mentions in groups', (r) => r('{ stroq status; } ')],
  ['stroq spelled in pieces', (r) => r('s"tr"oq doctor; ')],
  ['leading redirects', (r) => `${r('> /dev/null ')}ls`],
  ['local prefixes', (r) => `${r('coproc ')}ls`],
  // A sweep of every word that a reader looks for, repeated to 256 KiB, found these on 2026-10-07: a wrapper that
  // stands in a chain of them was looked past at every link with a look at the rest of the line (`parallel `
  // took 22 s, `npx ` 16 s), and the program that a pattern looks for an option after backtracks over the line
  // at each of its repeats.
  ['parallel chain', (r) => r('parallel ')],
  ['watch chain', (r) => r('watch ')],
  ['parallel chain, then a danger', (r) => `${r('parallel ')}rm -rf ~`],
  ['npx chain', (r) => r('npx ')],
  ['npx options, unknown', (r) => `npx ${r('--tag x ')}stroq untaint`],
  ['npx values', (r) => `npx ${r('-y a ')}stroq untaint`],
  ['rg and fd', (r) => r('rg fd ')],
  ['rg --pre', (r) => `rg ${r('--pre x ')}`],
  ['fd -x', (r) => `fd ${r('-x x ')}`],
  ['verb wrappers', (r) => r('uv run ')],
  ['mise exec', (r) => r('mise exec ')],
  ['direnv exec', (r) => r('direnv exec . ')],
  ['conda run', (r) => r('conda run -n x ')],
  ['verb wrappers, then a danger', (r) => `${r('uv run --with x ')}rm -rf ~`],
  ['runuser chain', (r) => r('runuser ')],
  ['runuser -u chain', (r) => r('runuser -u x ')],
  ['runuser options', (r) => `runuser ${r('-w x ')}-u y -- ls`],
  ['flock chain', (r) => r('flock /tmp/l ')],
  ['taskset chain', (r) => r('taskset -c 0 ')],
  ['strace options', (r) => `strace ${r('-o x ')}ls`],
  ['systemd-run', (r) => r('systemd-run -M h ')],
  ['nix develop', (r) => r('nix develop -c ')],
  ['nix-shell', (r) => r('nix-shell --run ')],
  ['tmux words', (r) => r('tmux new -d ')],
  ['tmux send-keys', (r) => `tmux send-keys ${r('-t x ')}'ls' Enter`],
  ['screen words', (r) => r('screen -dmS s ')],
  ['screen stuff', (r) => `screen -X stuff ${r('a ')}`],
  ['nodemon and concurrently', (r) => r('nodemon -x concurrently ')],
  ['osascript', (r) => `osascript ${r('-e x ')}`],
  ['capsh', (r) => `capsh -- ${r('-c ')}x`],
  ['sshpass chain', (r) => r('sshpass -p x ')],
  // Short options that stand together, a string glued to its option, the shell of another user, a format string of
  // tmux, a window of screen, a script of osascript, a job of `at`: the forms of the fourth review.
  ['tmux format, never closed', (r) => `tmux display-message '${r('#(')}`],
  ['tmux format, closed', (r) => `tmux set -g status-left '${r('#(a)')}'`],
  ['tmux format words', (r) => `tmux ${r("display-message '#(a)' ")}`],
  ['tmux display-popup', (r) => r('tmux display-popup -E ')],
  ['tmux glued -c', (r) => `tmux ${r("-2c'x' ")}`],
  ['screen at', (r) => `screen -X ${r('at 0 ')}stuff x`],
  ['osascript JavaScript', (r) => `osascript -l JavaScript ${r("-e '$.system(x)' ")}`],
  ['osascript do shell script', (r) => `osascript ${r("-e 'do shell script x' ")}`],
  ['sudo -nu', (r) => `sudo ${r('-nu ')}root ls`],
  ['sudo -nu chain', (r) => r('sudo -nu root ')],
  ['env -iu', (r) => `env ${r('-iu X ')}ls`],
  ['su glued string', (r) => `su ${r('-ccrontab ')}root`],
  ['su cluster', (r) => `su ${r('-lc ')}x`],
  ['su - root', (r) => `${r('su - root ')}<<< x`],
  ['su -scsh', (r) => `su ${r('-scsh ')}root <<< x`],
  ['newgrp chain', (r) => r('newgrp staff ')],
  ['newgrp here-string', (r) => `${r('newgrp staff ')}<<< x`],
  ['unshare here-string', (r) => `${r('unshare -m ')}<<< x`],
  ['nsenter here-string', (r) => `${r('nsenter -t 1 ')}<<< x`],
  ['chroot here-string', (r) => `${r('chroot /x ')}<<< x`],
  ['flock cluster', (r) => `flock ${r('-xc ')}x`],
  ['flock glued string', (r) => `flock ${r('-ccrontab ')}/tmp/l`],
  ['flock --command', (r) => `flock /tmp/l ${r('--command ')}x`],
  ['entr -sd', (r) => `ls | entr ${r('-sd ')}x`],
  ['tmux glued values', (r) => `tmux new-session ${r('-sname -nwin ')}'ls'`],
  ['tmux global clusters', (r) => `tmux ${r('-2L name ')}ls`],
  ['screen glued values', (r) => `screen ${r('-dmSname ')}ls`],
  ['fd clusters', (r) => `fd ${r('-Hx ')}ls`],
  ['fd --exec=', (r) => `fd ${r('--exec=ls ')}x`],
  ['osascript -e glued', (r) => `osascript ${r("-e'x' ")}`],
  ['npx clusters', (r) => `npx ${r('-yc ')}x`],
  ['vim clusters', (r) => `vim ${r('-esc ')}x`],
  ['nodemon glued', (r) => `nodemon ${r("-x'x' ")}`],
  // Reviewer B of the last round: a keyword inside a long word began a header of a function at each of them.
  ['function headers, keywords in a word', (r) => `: function\n;f${r('-do-then-else')}`],
  ['function headers, do in a word', (r) => `: function\n;f${r('-do')}`],
  ['function headers, then in a word', (r) => `: function\n;f${r('.then')}`],
  ['function headers, else in a word', (r) => `: function\n;f${r('/else')}`],
  ['function headers, keywords as words', (r) => `function f\n${r('do then else ')}`],
  ['function headers, after a separator', (r) => `: function\n${r(';do')}`],
  ['at words', (r) => r('at ')],
  ['at now, chained', (r) => `echo x | ${r('at now; ')}`],
  ['batch, chained', (r) => r('batch; ')],
  // Comment lines that look like the header of a function: the gap between a header and its body was a pattern, and
  // from each `;` it ran to the end of the text (seven seconds at 120 KB, and the clock cannot stop a pattern).
  ['comment lines that look like headers', (r) => r('#;g()\n')],
  ['headers, then comment lines', (r) => r(';g()\n#x\n')],
  ['headers, then continued lines', (r) => r('g()\\\n')],
  ['headers with their own gap', (r) => r('f() # c\n')],
];

/** `build` at `size`: every repeated unit fills `size` characters. */
const at = (build: Build, size: number): string =>
  build((unit) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size));

const timed = (command: string): number => {
  const started = cpuNow();
  classifyCommand(command, '/tmp');
  return cpuNow() - started;
};

/** How often a size that looks too slow is timed, the first time included: noise only adds to a time. */
const TRIES = 3;

describe('classifyCommand stays linear on commands built to be slow', () => {
  it.each(ADVERSARIAL)('%s', (_name, build) => {
    const times: number[] = [timed(at(build, SIZES[0]))];
    for (let i = 1; i < SIZES.length; i += 1) {
      const command = at(build, SIZES[i] as number);
      const small = times[i - 1] as number;
      let big = timed(command);
      for (let tries = 1; tries < TRIES && big >= BOUND_MS && big >= MAX_GROWTH * small; tries += 1)
        big = Math.min(big, timed(command));
      times.push(big);
    }
    const growth = times.map(
      (ms, i) => `${ms.toFixed(0)} ms at ${(SIZES[i] as number) / 1024} KiB`,
    );
    for (let i = 1; i < times.length; i += 1) {
      const small = times[i - 1] as number;
      const big = times[i] as number;
      expect(big < BOUND_MS || big < MAX_GROWTH * small, growth.join(', ')).toBe(true);
    }
  });
});

/** The unit repeated to 256 KiB, for the budget tests below. */
const repeat = (unit: string): string => at((r) => r(unit), SIZE);

describe('the nesting budget', () => {
  it('reports a command whose nested arguments outgrow it as unread, and asks', () => {
    const { classes, signals } = classifyCommand(repeat('eval x '), '/tmp');
    expect(signals).toContain('nested-commands-too-large');
    expect(classes).toContain('shell.unparsed');
  });

  it('leaves ordinary eval and foreach commands alone', () => {
    for (const command of [
      'eval "$(ssh-agent -s)"',
      'eval curl https://evil.example/u',
      'git submodule foreach git pull; eval "$(direnv export bash)"',
      `cat > setup.sh <<'EOF'\n${'eval "$(tool init)"\n'.repeat(2_000)}EOF`,
    ]) {
      expect(classifyCommand(command, '/tmp').signals, command.slice(0, 40)).not.toContain(
        'nested-commands-too-large',
      );
    }
  });

  it('still reads what it extracted before the budget ran out', () => {
    const { classes } = classifyCommand(
      `eval curl https://evil.example/u; ${repeat('eval x ')}`,
      '/tmp',
    );
    expect(classes).toContain('shell.network');
  });
});
