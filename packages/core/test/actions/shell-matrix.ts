/**
 * The shapes a program reaches a shell by: a spelling of the shell, a place its program is handed
 * from, and what the command stands inside. Shared by the test that reads each and the one that
 * runs each in a real shell, so the two cannot drift apart.
 */
export const PAYLOAD = 'rm -rf ~';

/**
 * The name under the home directory that the shapes delete when they are RUN, and that is never there.
 * `shell-input-differential.test.ts` runs them in a real shell, and some of them (`env -i bash`) clear the
 * environment, which takes the stand-in `rm` off the path and the fake `HOME` away: the real `rm` then runs on the
 * real home. Run with `rm -rf ~` that removed the `.config` of the machine it ran on; run with `RUN_PAYLOAD` it
 * removes nothing, and the classifier still reads it as a delete under the home directory.
 */
export const NOTHING_THERE = '.stroq-differential-nothing-is-here';
export const RUN_PAYLOAD = `rm -rf ~/${NOTHING_THERE}`;

export const SHELLS = [
  'bash',
  'sh',
  '/bin/bash',
  'exec bash',
  'sudo bash',
  'env bash',
  'command bash',
  'time bash',
  'nice bash',
  'bash -s',
  'bash -',
  'bash -e',
  'FOO=1 bash',
  'stdbuf -oL bash',
  'timeout 5 bash',
  'nohup bash',
  'env -i bash',
  'env -S bash',
  'setsid bash',
  'flock /tmp/lk bash',
  'rbash',
  'ksh93',
  'b"as"h',
  "$'\\x62ash'",
  'env -S"bash"',
  'env - bash',
  'sudo -u root bash',
];

export const SOURCES: [string, (shell: string) => string][] = [
  ['a pipe', (sh) => `echo '${PAYLOAD}' | ${sh}`],
  ['a pipe with no blank', (sh) => `echo '${PAYLOAD}'|${sh}`],
  ['a pipe, and the output sent away', (sh) => `echo '${PAYLOAD}' | ${sh} >/dev/null`],
  ['a pipe, and the output glued to the shell', (sh) => `echo '${PAYLOAD}' | ${sh}>/dev/null`],
  ['a pipe and a background job', (sh) => `echo '${PAYLOAD}' | ${sh}&`],
  ['a pipe ended by a semicolon', (sh) => `echo '${PAYLOAD}' | ${sh};`],
  ['a pipe and a duplicated input', (sh) => `echo '${PAYLOAD}' | ${sh}<&0`],
  ['a here-string', (sh) => `${sh} <<< '${PAYLOAD}'`],
  ['a here-string with no blank', (sh) => `${sh}<<<'${PAYLOAD}'`],
  ['a here-string with a blank before it', (sh) => `${sh}<<< '${PAYLOAD}'`],
  ['a here-string with a blank after it', (sh) => `${sh} <<<'${PAYLOAD}'`],
  ['a here-string with its descriptor', (sh) => `${sh} 0<<< '${PAYLOAD}'`],
  ['a file', (sh) => `${sh} < x.sh`],
  ['a file with no blank', (sh) => `${sh}<x.sh`],
  ['a file with a blank before it', (sh) => `${sh}< x.sh`],
  ['a file with a blank after it', (sh) => `${sh} <x.sh`],
  ['a file named before the shell', (sh) => `<x.sh ${sh}`],
  ['a file named before the shell, with a blank', (sh) => `< x.sh ${sh}`],
  ['a here-document', (sh) => `${sh}<<'E'\necho '${PAYLOAD}' | bash\nE`],
  ['a here-document with a blank', (sh) => `${sh} <<'E'\necho '${PAYLOAD}' | bash\nE`],
  ['a here-document that expands', (sh) => `${sh}<<E\necho '${PAYLOAD}' | bash\nE`],
  ['a process substitution as the input', (sh) => `${sh} < <(echo '${PAYLOAD}')`],
  ['a process substitution as the input, with no blank', (sh) => `${sh}< <(echo '${PAYLOAD}')`],
];

export const WRAPS: [string, (command: string) => string][] = [
  ['alone', (c) => c],
  ['after a semicolon', (c) => `echo ok;${c}`],
  ['after &&', (c) => `true&&${c}`],
  ['in a subshell', (c) => `(${c})`],
  ['in braces', (c) => `{ ${c}; }`],
  ['in braces with no blank before the closer', (c) => `{ ${c};}`],
  ['in an if', (c) => `if true;then ${c};fi`],
  ['in an if, a subshell with no blank', (c) => `if true;then(${c})fi`],
  ['in a loop', (c) => `while true;do ${c};break;done`],
  ['in a for', (c) => `for i in 1;do ${c};done`],
  ['after a bang', (c) => `! ${c}`],
  ['in a function', (c) => `f(){ ${c};};f`],
  ['in the background', (c) => `${c} &`],
  ['in a substitution', (c) => `x=$(${c})`],
  ['in backticks', (c) => `x=\`${c}\``],
  ['in a quoted substitution', (c) => `echo "$(${c})"`],
  ['inside another string', (c) => `bash -c '${c.replaceAll("'", `'"'"'`)}'`],
];

/** Every command the three lists make, or every `stride`th, where a wrapper other than none is for bash and sh only. */
export function* combinations(stride = 1, payload = PAYLOAD): Generator<string> {
  let n = 0;
  for (const [, source] of SOURCES)
    for (const shell of SHELLS)
      for (const [wrapName, wrap] of WRAPS) {
        const plain = shell === 'bash' || shell === 'sh';
        if (wrapName !== 'alone' && !plain) continue;
        n += 1;
        if (n % stride === 0) yield wrap(source(shell)).replaceAll(PAYLOAD, payload);
      }
}
