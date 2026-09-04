import { MIN_SECRET_LENGTH } from './extract.js';

/** Upper bound on tokens hashed per event. */
export const MAX_CANDIDATES = 500;
// Shell, JSON and URL delimiters. `/` is deliberately absent here because AWS-style
// secrets contain it; a second pass below splits on it too.
const DELIMITERS = /[\s"'`=:&?,;()[\]{}<>|\\@#]+/;
const SLASH = /\//;

function textOf(toolName: string, toolInput: Readonly<Record<string, unknown>>): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  if (toolName === 'Bash') return str(toolInput['command']);
  if (toolName === 'WebFetch') return `${str(toolInput['url'])} ${str(toolInput['prompt'])}`;
  if (toolName.startsWith('mcp__')) return JSON.stringify(toolInput);
  return '';
}

/**
 * Substrings of a tool input that could be a secret value: split on delimiters
 * (with and without `/`), keep pieces of secret length, dedupe, cap.
 */
export function candidateTokens(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
): string[] {
  const text = textOf(toolName, toolInput);
  if (text.trim() === '') return [];
  const coarse = text.split(DELIMITERS);
  const fine = coarse.flatMap((piece) => piece.split(SLASH));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of [...coarse, ...fine]) {
    if (token.length < MIN_SECRET_LENGTH || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}
