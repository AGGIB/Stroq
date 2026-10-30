import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

// Only the parent supplies this fixed build path. Browser input cannot select code.
try {
  const { loadBundledRules, scanContent } = await import(pathToFileURL(workerData.corePath).href);
  const { content, target } = workerData;
  const rules = loadBundledRules();
  const scanned = scanContent(
    rules,
    content,
    { maxChars: content.length, budgetMs: 4000, threshold: 0.6 },
    target === 'skill'
      ? { target: 'instruction_file' }
      : { target: 'tool_result', tool_response: content },
  );
  parentPort.postMessage({
    ...scanned,
    timedOut: scanned.timedOut === true,
    target,
    characters: content.length,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  });
} catch {
  parentPort.postMessage({ error: 'engine-failed' });
}
