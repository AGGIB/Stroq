// A stub child process for testing the proxy's signal-escalation path: it traps and
// ignores both SIGTERM and SIGINT, so it never exits on a relayed signal alone. Without
// a server like this, "the proxy relays the signal and waits" and "the proxy relays the
// signal, waits, and escalates to SIGKILL once a server ignores it" are indistinguishable
// by any test using an ordinary, well-behaved child — a well-behaved child just exits on
// the first signal either way. It reads and discards stdin so it never blocks on a full
// pipe buffer, and otherwise does nothing.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.stdin.resume();
// `stdin.resume()` alone stops holding the event loop open the moment stdin ends, so a
// server that merely ignores signals still exits by itself on EOF — which makes the EOF
// escalation path ("stdin closed, then SIGTERM, then SIGKILL") untestable. Behind an env
// flag so the signal-escalation tests keep the plain behaviour they were written against.
if (process.env.STROQ_MCP_STUB_KEEPALIVE === '1') setInterval(() => {}, 1000);
