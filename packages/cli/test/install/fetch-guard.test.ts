import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Section 6 of the Safe Install spec:
 * "The only network code is install/fetch.ts; a guard test forbids fetch(, http.request and https. in the rest of cli/src."
 */
const srcDir = fileURLToPath(new URL('../../src', import.meta.url));

function allSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...allSourceFiles(full));
    } else if (stat.isFile() && (full.endsWith('.ts') || full.endsWith('.js'))) {
      files.push(full);
    }
  }
  return files;
}

describe('network call boundary', () => {
  const allFiles = allSourceFiles(srcDir);
  const otherFiles = allFiles.filter(
    (file) => !file.endsWith('/src/install/fetch.ts') && !file.endsWith('\\src\\install\\fetch.ts'),
  );

  it.each(otherFiles)('forbids network calls in %s', (filePath) => {
    const content = readFileSync(filePath, 'utf8');
    const relative = filePath.replace(srcDir, 'src');

    // Forbids raw fetch( calls
    expect(content, `${relative} must not call fetch()`).not.toMatch(/\bfetch\s*\(/);

    // Forbids http.request
    expect(content, `${relative} must not use http.request`).not.toMatch(/\bhttp\.request\b/);

    // Forbids https. (https.request, https.get, etc.)
    expect(content, `${relative} must not use https.`).not.toMatch(/\bhttps\./);

    // Forbids importing node:http or node:https directly
    expect(content, `${relative} must not import http or https`).not.toMatch(
      /from\s+['"]node:https?['"]/,
    );
  });
});
