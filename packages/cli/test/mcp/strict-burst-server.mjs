// A stdio server that writes N lines that are not JSON, then exits at once. Strict mode
// withholds each, and the lines are still queued when the proxy sees the server close.
const lines = Number(process.env['BURST_LINES'] ?? 30);
let out = '';
for (let i = 0; i < lines; i += 1) out += `not json ${i}\n`;
process.stdout.write(out, () => process.exit(0));
