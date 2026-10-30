import assert from 'node:assert/strict';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeSecretScan } from './secret-scan-process.mjs';
import { real, KEY, AT, session, fixture } from './secret-scan-fixtures.mjs';

test('ordinary Cursor tables retain real supported credential matching', real, async () =>
  fixture(async (options) => {
    const { DatabaseSync } = await import('node:sqlite');
    const folder =
      process.platform === 'darwin'
        ? join(options.userHome, 'Library/Application Support/Cursor/User/globalStorage')
        : process.platform === 'win32'
          ? join(options.userHome, 'AppData/Roaming/Cursor/User/globalStorage')
          : join(options.userHome, '.config/Cursor/User/globalStorage');
    await mkdir(folder, { recursive: true });
    const database = new DatabaseSync(join(folder, 'state.vscdb'));
    database.exec('create table cursorDiskKV (key text primary key,value text)');
    database.prepare('insert into cursorDiskKV values (?,?)').run(
      'bubbleId:private-fixture:b1',
      JSON.stringify({
        _v: 3,
        type: 2,
        bubbleId: 'b1',
        createdAt: AT,
        toolFormerData: {
          toolCallId: 'b1',
          status: 'completed',
          name: 'read_file_v2',
          params: JSON.stringify({ targetFile: join(options.project, '.env') }),
          result: JSON.stringify({ contents: `STRIPE_SECRET_KEY=${KEY}` }),
        },
      }),
    );
    database.close();
    const report = await executeSecretScan({ scope: 'project' }, options);
    assert.equal(report.sessions.cursor, 1);
    assert.equal(report.totals.modelVisible, 1);
    assert.equal(report.findings[0].provider, 'Stripe');
    assert.equal(report.findings[0].agent, 'cursor');
    assert.ok(!JSON.stringify(report).includes(KEY));
    assert.ok(!JSON.stringify(report).includes('private-fixture'));
  }),
);

test(
  'large SQLite stores are refused before existing all-rows scanner allocates them',
  real,
  async () =>
    fixture(async (options) => {
      const folder =
        process.platform === 'darwin'
          ? join(options.userHome, 'Library/Application Support/Cursor/User/globalStorage')
          : process.platform === 'win32'
            ? join(options.userHome, 'AppData/Roaming/Cursor/User/globalStorage')
            : join(options.userHome, '.config/Cursor/User/globalStorage');
      await mkdir(folder, { recursive: true });
      const handle = await open(join(folder, 'state.vscdb'), 'w');
      await handle.truncate(17 * 1024 * 1024);
      await handle.close();
      await assert.rejects(executeSecretScan({ scope: 'project' }, options), {
        message: 'input-limit',
      });
    }),
);

test(
  'unreadable or unsupported Cursor stores cannot silently yield a complete scan',
  real,
  async () =>
    fixture(async (options) => {
      const folder =
        process.platform === 'darwin'
          ? join(options.userHome, 'Library/Application Support/Cursor/User/globalStorage')
          : process.platform === 'win32'
            ? join(options.userHome, 'AppData/Roaming/Cursor/User/globalStorage')
            : join(options.userHome, '.config/Cursor/User/globalStorage');
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'state.vscdb'), 'THIS_IS_NOT_SQLITE');
      await session(options, options.project, 'valid-other-host', [`Please use ${KEY}`]);
      await assert.rejects(executeSecretScan({ scope: 'project' }, options), {
        message: 'scan-failed',
      });
    }),
);

test(
  'corrupt SQLite data pages cannot pass a schema-only preflight as complete coverage',
  real,
  async () =>
    fixture(async (options) => {
      const { DatabaseSync } = await import('node:sqlite');
      const folder =
        process.platform === 'darwin'
          ? join(options.userHome, 'Library/Application Support/Cursor/User/globalStorage')
          : process.platform === 'win32'
            ? join(options.userHome, 'AppData/Roaming/Cursor/User/globalStorage')
            : join(options.userHome, '.config/Cursor/User/globalStorage');
      await mkdir(folder, { recursive: true });
      const path = join(folder, 'state.vscdb');
      const database = new DatabaseSync(path);
      database.exec(
        "create table cursorDiskKV (key text, value text); insert into cursorDiskKV values ('bubbleId:fixture:1','{}')",
      );
      const pageSize = Number(database.prepare('pragma page_size').get().page_size);
      const rootPage = Number(
        database.prepare("select rootpage from sqlite_master where name='cursorDiskKV'").get()
          .rootpage,
      );
      database.close();
      const handle = await open(path, 'r+');
      await handle.write(Buffer.from([0]), 0, 1, (rootPage - 1) * pageSize);
      await handle.close();
      await session(options, options.project, 'valid-other-host', [`Please use ${KEY}`]);
      await assert.rejects(executeSecretScan({ scope: 'project' }, options), {
        message: 'scan-failed',
      });
    }),
);

test(
  'tiny SQLite views and generated columns cannot bypass scanner allocation bounds',
  real,
  async () =>
    fixture(async (options) => {
      const { DatabaseSync } = await import('node:sqlite');
      const folder =
        process.platform === 'darwin'
          ? join(options.userHome, 'Library/Application Support/Cursor/User/globalStorage')
          : process.platform === 'win32'
            ? join(options.userHome, 'AppData/Roaming/Cursor/User/globalStorage')
            : join(options.userHome, '.config/Cursor/User/globalStorage');
      await mkdir(folder, { recursive: true });
      const path = join(folder, 'state.vscdb');
      for (const sql of [
        "create view cursorDiskKV as select 'bubbleId:fixture:1' as key, hex(zeroblob(1000000)) as value",
        'create table cursorDiskKV (key text,value text generated always as (hex(zeroblob(1000000))) virtual)',
      ]) {
        const database = new DatabaseSync(path);
        database.exec(sql);
        database.close();
        await assert.rejects(executeSecretScan({ scope: 'project' }, options), {
          message: 'scan-failed',
        });
        await rm(path);
      }
    }),
);
