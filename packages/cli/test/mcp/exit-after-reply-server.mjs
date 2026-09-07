// A minimal stdio server for the dead-sink hang test: it answers exactly ONE
// JSON-RPC request and then exits, so every client line sent after that reply is
// written to a pipe whose reader is gone. `process.exit()` runs from the `write()`
// callback rather than straight after it, because a pipe write is asynchronous on
// POSIX and exiting immediately would risk truncating the reply before the proxy
// ever sees it. Deliberately simpler than fake-server.mjs (no tools, no logging):
// this file exists only to kill the server's end of the pipe at a known moment.
// Its exit code comes from EXIT_AFTER_REPLY_EXIT_CODE so the test can prove the
// proxy propagated the SERVER's own code rather than defaulting to zero.
let answered = false;
let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (answered) return;
  buffer += chunk;
  const nl = buffer.indexOf('\n');
  if (nl === -1) return;
  answered = true;
  const exitCode = Number(process.env['EXIT_AFTER_REPLY_EXIT_CODE'] ?? '0');
  let message;
  try {
    message = JSON.parse(buffer.slice(0, nl));
  } catch {
    process.exit(exitCode);
    return;
  }
  const id = message !== null && typeof message === 'object' ? message.id : undefined;
  if (id === undefined || id === null) {
    process.exit(exitCode);
    return;
  }
  const reply = JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: 'ok' }], isError: false },
  });
  process.stdout.write(`${reply}\n`, () => {
    process.exit(exitCode);
  });
});
