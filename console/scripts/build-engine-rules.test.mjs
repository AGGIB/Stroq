import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import ts from 'typescript';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(repository, 'console/scripts/build-engine.mjs');
const sourcePath = join(repository, 'packages/core/src/rules.bundle.json');
const sourceBefore = await readFile(sourcePath);
const sourceHash = createHash('sha256').update(sourceBefore).digest('hex');
const raw = JSON.parse(sourceBefore);
function runtimeReferences(text) {
  const file = ts.createSourceFile(
    'fixture.mjs',
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  const imports = [],
    compiler = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      imports.push(node.moduleSpecifier.getText(file));
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      imports.push(node.getText(file));
    if (
      ts.isIdentifier(node) &&
      ['transpileModule', 'createRuntimeRulesPlugin'].includes(node.text)
    )
      compiler.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { imports, compiler };
}
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-runtime-rules-test-')));
after(() => rm(output, { recursive: true, force: true }));
async function plugin() {
  // This assertion also makes the red test safe: the old script must never build shared output.
  assert.match(await readFile(script, 'utf8'), /export async function createRuntimeRulesPlugin\(/);
  const module = await import(pathToFileURL(script).href);
  return module.createRuntimeRulesPlugin();
}
const options = {
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  config: false,
  dts: false,
  splitting: false,
  silent: true,
  outExtension: () => ({ js: '.mjs' }),
  noExternal: ['zod'],
};
async function projectionCallback() {
  const p = await plugin();
  let callback, filter;
  p.setup({
    onLoad(rule, action) {
      filter = rule.filter;
      callback = action;
    },
  });
  assert.ok(filter.test(sourcePath));
  return { callback, filter };
}
test('console projection uses the existing runtime function and preserves source JSON', async () => {
  const { callback, filter } = await projectionCallback();
  const loaded = await callback({ path: sourcePath });
  assert.equal(loaded.loader, 'json');
  const projected = JSON.parse(loaded.contents);
  assert.equal(projected.rules.length, raw.rules.length);
  assert.deepEqual(projected.disabled, raw.disabled);
  assert.equal(projected.generatedAt, raw.generatedAt);
  assert.ok(Buffer.byteLength(loaded.contents) < sourceBefore.length / 2);
  const directory = join(output, 'idempotent', 'core', 'src');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'rules.bundle.json');
  await writeFile(path, loaded.contents);
  assert.equal((await callback({ path })).contents, loaded.contents);
  assert.equal(filter.test(join(directory, 'other.json')), false);
  assert.equal(filter.test('C:\\fixture\\core\\src\\rules.bundle.json'), true);
  assert.deepEqual(await readFile(sourcePath), sourceBefore);
});
test('projected and ordinary source loaders return identical compiled rules and disabled coverage', async (t) => {
  const entry = join(repository, 'packages/core/src/rules/bundle.ts');
  await build({ ...options, entry: { reference: entry }, outDir: join(output, 'reference') });
  await build({
    ...options,
    entry: { projected: entry },
    outDir: join(output, 'projected'),
    esbuildPlugins: [await plugin()],
  });
  const reference = await import(pathToFileURL(join(output, 'reference/reference.mjs')).href);
  const projected = await import(pathToFileURL(join(output, 'projected/projected.mjs')).href);
  const expected = reference.loadBundledRules(),
    actual = projected.loadBundledRules();
  assert.deepEqual(actual, expected);
  assert.ok(actual.length > 0);
  const enabled = new Set(
    raw.rules.filter((rule) => !raw.disabled.includes(rule.id)).map((rule) => rule.id),
  );
  assert.ok(actual.every((rule) => enabled.has(rule.id) && !raw.disabled.includes(rule.id)));
  assert.deepEqual(
    actual.map((rule) => rule.id),
    expected.map((rule) => rule.id),
  );
  const semantic = (rules) =>
    JSON.stringify(
      rules.map((rule) => ({
        ...rule,
        tests: rule.tests.map((test) => ({
          ...test,
          regex: test.regex ? { source: test.regex.source, flags: test.regex.flags } : null,
        })),
      })),
    );
  assert.equal(semantic(actual), semantic(expected));
  assert.equal(
    createHash('sha256')
      .update(await readFile(sourcePath))
      .digest('hex'),
    sourceHash,
  );
  const built = join(output, 'projected/projected.mjs'),
    text = await readFile(built, 'utf8');
  assert.deepEqual(runtimeReferences(text), { imports: [], compiler: [] });
  const referenceBytes = (await stat(join(output, 'reference/reference.mjs'))).size;
  const projectedBytes = (await stat(built)).size;
  t.diagnostic(
    JSON.stringify({
      sourceRules: raw.rules.length,
      disabledIds: raw.disabled.length,
      compiledRules: actual.length,
      referenceBytes,
      projectedBytes,
      savedBytes: referenceBytes - projectedBytes,
      semanticSha256: createHash('sha256').update(semantic(actual)).digest('hex'),
      sourceSha256: sourceHash,
    }),
  );
});
test('independent fixture paths bundle projected data with no external source/runtime dependency', async () => {
  const input = {
    version: 1,
    generatedAt: 'fixture',
    disabled: ['disabled'],
    rules: [
      {
        id: 'enabled',
        title: 'Rule',
        severity: 'high',
        description: 'DO_NOT_SHIP_RAW_CASE',
        tags: {
          category: 'prompt-injection',
          scan_target: 'instruction_file',
          confidence: 'private',
        },
        detection: {
          condition: 'any',
          conditions: [
            {
              field: 'content',
              operator: 'contains',
              value: 'retain exact value',
              description: 'DO_NOT_SHIP_RAW_CASE',
            },
          ],
        },
        test_cases: { payload: 'DO_NOT_SHIP_RAW_CASE' },
      },
      {
        id: 'disabled',
        title: 'Disabled stays in data',
        severity: 'low',
        detection: { condition: 'all', conditions: [] },
      },
    ],
  };
  for (const name of ['first', 'independent']) {
    const directory = join(output, name),
      source = join(directory, 'core/src/rules.bundle.json');
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, JSON.stringify(input));
    const entry = join(directory, 'entry.ts');
    await writeFile(
      entry,
      "import rules from './core/src/rules.bundle.json' with {type:'json'};export default rules;\n",
    );
    await build({
      ...options,
      entry: { fixture: entry },
      outDir: join(directory, 'out'),
      esbuildPlugins: [await plugin()],
    });
    const built = join(directory, 'out/fixture.mjs'),
      text = await readFile(built, 'utf8');
    assert.equal(text.includes('DO_NOT_SHIP_RAW_CASE'), false);
    assert.deepEqual(runtimeReferences(text), { imports: [], compiler: [] });
    assert.equal(text.includes(repository), false);
    const value = (await import(pathToFileURL(built).href)).default;
    assert.deepEqual(value.disabled, input.disabled);
    assert.equal(value.rules.length, 2);
    assert.equal(value.rules[0].detection.conditions[0].value, 'retain exact value');
    assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), input);
  }
});
