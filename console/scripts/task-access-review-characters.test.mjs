import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accessFixture, buildAccessFixture, hash } from './task-access-test-helpers.mjs';

// The review screen shows the refused call as text, and the signature that follows means a person saw
// it. A character that shows nothing or reorders the text around it would let the screen read
// differently from the call, so the server refuses the record before any preview or signature, and
// names the character by its code point. Every character here is built from its number: none is typed.

const built = await buildAccessFixture();
after(() => rm(built.output, { recursive: true, force: true }));
const hex = (code) => code.toString(16).padStart(4, '0');
const browser = (input) => ({ id: input.id, expectedEvidenceSha: input.expectedEvidenceSha });
const bash = (command) => ({ event: { toolName: 'Bash', toolInput: { command } } });

/** Bidi embeddings, overrides and isolates, the two marks, and the zero-width characters. */
const HIDDEN = [
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x200b,
  0x200c, 0x200d, 0x2060, 0xfeff,
];

test('a real refused call holding a hidden character is refused by code point before a preview', async (t) => {
  for (const code of HIDDEN)
    await t.test(`U+${hex(code)}`, async (sub) => {
      const f = await accessFixture(sub, built, bash(`printf safe${String.fromCodePoint(code)}x`));
      const refused = await f.refuse();
      assert.equal(refused.result.decision.effect, 'deny');
      assert.ok(refused.row.approvalRequest, 'the gate signed a request for this review');
      await assert.rejects(f.run('access-preview', refused.input), {
        message: `hidden-character-${hex(code)}`,
      });
      await assert.rejects(lstat(join(f.home, 'tasks', f.body.taskId, 'extensions')), {
        code: 'ENOENT',
      });
    });
});

test('a hidden character in a key, or written as a JSON escape, is refused the same way', async (t) => {
  await t.test('key', async (sub) => {
    const event = {
      toolName: 'mcp__notes__lookup',
      toolInput: { [`query${String.fromCodePoint(0x200b)}`]: 'inert' },
    };
    const f = await accessFixture(sub, built, { event }),
      refused = await f.refuse();
    assert.ok(refused.row.approvalRequest);
    await assert.rejects(f.run('access-preview', refused.input), {
      message: 'hidden-character-200b',
    });
  });
  await t.test('escape', async (sub) => {
    // A signer that wrote U+202E as its JSON escape, six ASCII characters: the raw text holds no
    // bidi character, but the review screen decodes it to one.
    const f = await accessFixture(sub, built, bash('printf inert')),
      original = await f.refuse();
    const row = structuredClone(original.row);
    row.approvalReview = row.approvalReview.replace('printf inert', 'printf \\u202einert');
    assert.notEqual(row.approvalReview, original.row.approvalReview);
    row.approvalRequest = built.core.signTaskAccessRequest(
      { ...row.approvalRequest.body, reviewSha256: hash(row.approvalReview) },
      f.pair.privateKey,
    );
    const { hash: _old, ...body } = row;
    row.hash = built.core.hashEntry(body);
    const raw = JSON.stringify(row);
    await writeFile(f.journalPath, raw + '\n');
    const input = {
      id: 'incident-' + hash(raw),
      expectedEvidenceSha: hash(raw),
      sequence: row.seq,
      recordedAt: row.ts,
    };
    await assert.rejects(f.run('access-preview', input), { message: 'hidden-character-202e' });
  });
});

test('the local API answers with the code point as a closed refusal, and plain text still previews', async (t) => {
  const f = await accessFixture(t, built, bash(`printf a${String.fromCodePoint(0x202e)}b`)),
    service = await f.service();
  const refused = await service.preview(browser((await f.refuse()).input));
  assert.equal(refused.status, 422);
  assert.deepEqual(refused.body, { error: 'hidden-character-202e' });
  assert.match(
    built.schema.TASK_ACCESS_ERROR_MESSAGES['hidden-character-202e'],
    /U\+202E/,
    'the console names the character',
  );
  // Visible text outside ASCII, including an emoji with its presentation selector, is shown as it is.
  const plain = await accessFixture(
    t,
    built,
    bash(`printf ${String.fromCodePoint(0xe9, 0x65e5, 0x2714, 0xfe0f)}`),
  );
  const made = await (await plain.service()).preview(browser((await plain.refuse()).input));
  assert.equal(made.status, 200);
  assert.equal(built.schema.validateTaskAccessPreview(made.body), true);
});
