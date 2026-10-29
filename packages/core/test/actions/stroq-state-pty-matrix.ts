/**
 * Programs that run a command inside a pseudo-terminal, as a function of the command they run. The
 * command is a line of words with no quote in it, so that each launcher can be spelled with the quotes it
 * needs around it. Shared by the core tests of the state gate and the hook-level test of the CLI.
 */

export type PtyLauncher = readonly [name: string, launch: (line: string) => string];

/** The spellings that the gate let through on 2026-10-13, each verified against the hook then. */
export const PTY_REPORTED: readonly string[] = [
  'script -q /dev/null stroq untaint',
  "printf '0123456789ab\\n' | script -q /dev/null stroq add ./x",
  `python3 -c 'import pty; pty.spawn(["stroq","untaint"])'`,
  "expect -c 'spawn stroq untaint; interact'",
  'socat - EXEC:"stroq untaint",pty',
];

/** The two that were denied then, and stay so. */
export const PTY_ALREADY_DENIED: readonly string[] = [
  'script -q /dev/null sh -c "stroq init"',
  'script -qc "stroq untaint" /dev/null',
];

/**
 * Launchers whose command is read as a command line: the line they run is judged by what it is, so a command
 * of Stroq's that only reads (`stroq doctor`) stays open behind them. The command has no quote of its own, so
 * each spelling can quote around it.
 */
export const PTY_READ: readonly PtyLauncher[] = [
  ['script, BSD', (c) => `script -q /dev/null ${c}`],
  ['script, BSD, no flags', (c) => `script /dev/null ${c}`],
  ['script, BSD, flags and a log', (c) => `script -aq session.log ${c}`],
  ['script, an output redirect after', (c) => `script -q /dev/null ${c} > out.log`],
  ['script, util-linux -c', (c) => `script -qc "${c}" /dev/null`],
  ['script, util-linux -c alone', (c) => `script -q -c "${c}" /dev/null`],
  ['script, util-linux -c after the file', (c) => `script /dev/null -c "${c}"`],
  ['script --command', (c) => `script --command "${c}" /dev/null`],
  ['script --command=', (c) => `script --command="${c}" /dev/null`],
  ['script, value options then -c', (c) => `script -O /dev/null -c "${c}" trace.log`],
  ['script behind setsid', (c) => `setsid script -q /dev/null ${c}`],
  ['script behind nohup', (c) => `nohup script -q /dev/null ${c}`],
  ['script behind sudo', (c) => `sudo -u root script -q /dev/null ${c}`],
  ['script by its system path', (c) => `/usr/bin/script -q /dev/null ${c}`],
  ['script behind script', (c) => `script -q /dev/null script -q /dev/null ${c}`],
  ['script after &&', (c) => `ls && script -q /dev/null ${c}`],
  ['script in a subshell', (c) => `(script -q /dev/null ${c})`],
  ['unbuffer', (c) => `unbuffer ${c}`],
  ['unbuffer -p', (c) => `unbuffer -p ${c}`],
  ['ptyexec', (c) => `ptyexec ${c}`],
  ['pty', (c) => `pty ${c}`],
  ['expect -c spawn', (c) => `expect -c 'spawn ${c}; interact'`],
  ['expect -c spawn, lines', (c) => `expect -c 'spawn ${c}\ninteract'`],
  ['socat EXEC', (c) => `socat - EXEC:"${c}",pty`],
  ['socat EXEC, options first', (c) => `socat -d -d - EXEC:"${c}",pty,stderr`],
  ['socat exec, lower case, first', (c) => `socat 'exec:${c}' -`],
  ['socat SYSTEM', (c) => `socat - SYSTEM:"${c}",pty`],
  ['socat system, lower case', (c) => `socat - system:'${c}'`],
  ['socat SHELL', (c) => `socat - SHELL:"${c}"`],
];

/**
 * Launchers that hand the command to a program the gate does not read with certainty (an interpreter program
 * that spawns a process, a Tcl script that is not a plain `spawn`): where that text names Stroq, the command is
 * denied, whichever command of Stroq's it names.
 */
export const PTY_UNREAD: readonly PtyLauncher[] = [
  ['expect, a shell is sent the line', (c) => `expect -c 'spawn bash; send "${c}\\r"; interact'`],
  ['expect, Tcl exec', (c) => `expect -c 'exec ${c}'`],
  ['expect, a substitution', (c) => `expect -c 'set p [spawn ${c}]; interact'`],
  ['expect, the arguments are spawned', (c) => `expect -c 'spawn {*}$argv; interact' ${c}`],
  ['expect, a script file and arguments', (c) => `expect run.exp ${c}`],
  ['python pty.spawn of a split line', (c) => `python3 -c 'import pty; pty.spawn("${c}".split())'`],
  ['python, flags before -c', (c) => `python3 -Iuc 'import pty; pty.spawn("${c}".split())'`],
  ['python os.system', (c) => `python -c 'import os; os.system("${c}")'`],
  ['node, node-pty', (c) => `node -e 'require("node-pty").spawn("bash", ["-c", "${c}"])'`],
  ['node, child_process', (c) => `node -e 'require("child_process").execSync("${c}")'`],
  ['node --eval=', (c) => `node --eval='require("child_process").execSync("${c}")'`],
  ['perl IO::Pty', (c) => `perl -MIO::Pty -e 'exec "${c}"'`],
  ['perl system', (c) => `perl -we 'system("${c}")'`],
  ['ruby PTY.spawn', (c) => `ruby -rpty -e 'PTY.spawn("${c}")'`],
];

/** Commands of Stroq that change state, as the line a launcher runs, in the spellings a line can have. */
export const STATE_LINES: readonly string[] = [
  'stroq untaint',
  'stroq untaint --all',
  'stroq add some-server',
  'stroq prove',
  'stroq init',
  'stroq harden apply',
  'stroq permit revoke --all',
  'stroq vet --online ./pkg',
  'stroq trust README.md',
  'stroq task -- fix the failing test',
  'stroq run -- stroq prove',
  '/usr/local/bin/stroq untaint',
  'npx @stroq/cli untaint',
  'npx -y @stroq/cli@0.23.0 add x',
  'node packages/cli/dist/index.js untaint',
  'sudo stroq init',
  'env -i stroq remove x',
];

/** Commands of Stroq that only read: open behind a launcher whose line is read. */
export const READING_LINES: readonly string[] = [
  'stroq doctor',
  'stroq vet ./pkg',
  'stroq harden status',
  'stroq permit list',
  'stroq --help',
];

/** Ordinary work behind each launcher: none names Stroq, and every one stays open. */
export const ORDINARY_LINES: readonly string[] = [
  'make test',
  'npm test',
  'ssh build-host',
  'bash',
  'git log --oneline',
];

/** Ordinary uses of the launchers and of the interpreters that name Stroq only as data, or not at all. */
export const PTY_ORDINARY: readonly string[] = [
  'script -q /dev/null make test',
  'script -q /dev/null',
  'script session.log',
  'script -qc "make test" /dev/null',
  'script -q /dev/null grep stroq notes.txt',
  "expect -c 'spawn ssh host'",
  "expect -c 'spawn ssh host; interact'",
  'expect deploy.exp',
  "expect -c 'spawn npm test; expect eof'",
  'unbuffer npm test',
  'unbuffer -p cat',
  'ptyexec make test',
  'socat - EXEC:"ssh host",pty',
  'socat TCP-LISTEN:8080,fork TCP:stroq.dev:443',
  'socat - OPEN:stroq.log',
  'python3 -c \'import pty; pty.spawn("bash")\'',
  "python3 -c 'import json,sys; print(json.load(sys.stdin))'",
  "perl -pi -e 's/foo/bar/g' README.md",
  "ruby -e 'puts 1'",
];
