/**
 * Only a small grammar of synchronous stdin readers is known to handle data.
 * All other JavaScript stays unknown, including computed calls and extra statements.
 */
export type NodeProgramVerdict = 'data' | 'exec' | 'unknown';

const MAX_PROGRAM_CHARS = 16_000;
const CONTROL = /[\0-\x08\x0b\x0c\x0e-\x1f]/;

/** Obvious execution primitives are denied rather than merely asked about. */
export const NODE_EXEC =
  /\b(?:child_process|execSync|execFileSync|spawnSync|spawn|fork|eval|Function|WebAssembly)\b|\brequire\s*\(\s*['"\x60](?:vm|child_process|worker_threads|cluster)|\bimport\s*\(|process\s*\.\s*(?:binding|mainModule|dlopen)/;

const PROTOTYPE_ESCAPE = /\b(?:constructor|__proto__|prototype|globalThis|global)\b/;
const FS_BINDING =
  /^const\s+fs\s*=\s*require\s*\(\s*(?:'(?:(?:node:)?fs)'|"(?:(?:node:)?fs)")\s*\)\s*;\s*/;
const STDIN_READ =
  /^(?:require\s*\(\s*(?:'(?:node:)?fs'|"(?:node:)?fs")\s*\)|fs)\s*\.\s*readFileSync\s*\(\s*(?:0|process\s*\.\s*stdin\s*\.\s*fd)\s*(?:,\s*(?:'utf-?8'|"utf-?8")\s*)?\)/;
const JSON_PARSE = /^JSON\s*\.\s*parse\s*\(\s*/;
const PRINT = /^console\s*\.\s*log\s*\(\s*/;
const PROPERTY =
  /^(?:\.\s*[A-Za-z_$][\w$]*|\[\s*(?:\d+|'[A-Za-z0-9_$.-]*'|"[A-Za-z0-9_$.-]*")\s*\])\s*/;

/** Reads one expression; there are no arbitrary calls, assignments or executable property keys. */
function readExpression(program: string, boundFs: boolean): string | null {
  const json = JSON_PARSE.exec(program);
  let rest = json ? program.slice(json[0].length) : program;
  const read = STDIN_READ.exec(rest);
  if (!read || (!boundFs && /^fs\b/.test(rest))) return null;
  rest = rest.slice(read[0].length).trimStart();
  if (json) {
    if (!rest.startsWith(')')) return null;
    rest = rest.slice(1).trimStart();
  }
  for (;;) {
    const property = PROPERTY.exec(rest);
    if (!property) return rest;
    rest = rest.slice(property[0].length).trimStart();
  }
}

export function judgeNodeProgram(program: string): NodeProgramVerdict {
  if (program.length > MAX_PROGRAM_CHARS || CONTROL.test(program)) return 'unknown';
  if (NODE_EXEC.test(program)) return 'exec';
  if (PROTOTYPE_ESCAPE.test(program)) return 'unknown';

  let rest = program.trim();
  const binding = FS_BINDING.exec(rest);
  if (binding) rest = rest.slice(binding[0].length);
  const print = PRINT.exec(rest);
  if (print) rest = rest.slice(print[0].length);
  const tail = readExpression(rest, binding !== null);
  if (tail === null) return 'unknown';
  rest = tail;
  if (print) {
    if (!rest.startsWith(')')) return 'unknown';
    rest = rest.slice(1).trim();
  }
  return rest === '' || rest === ';' ? 'data' : 'unknown';
}
