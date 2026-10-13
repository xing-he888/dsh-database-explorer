/**
 * dsh-database-explorer — v0.9.25 套件（test-v108）
 *
 * 覆盖分页浏览（亿级表场景）的三处审计修复：
 *   ① COUNT 缓存：翻页不再每页重跑 COUNT(*)（InnoDB 全索引扫描是翻页卡顿主因），
 *      筛选条件变化/写操作后必须失效，否则行数会长期显示旧值；
 *   ② 页号上限：旧代码把 page 硬截到 100000（1e8 行 / 200 = 500000 页），
 *      表尾 80% 永远翻不到——现在上限 10000000 且钳制方向正确；
 *   ③ pageSize 白名单回落 200、page <= 0 归一到 1。
 *
 * 用真 SQLite（node:sqlite）当后端，SQL 由 peekPage 真实拼出并执行，
 * 所以 LIMIT/OFFSET 与 COUNT 的一致性是被真库验证的，不是 mock 断言。
 *
 * 运行：node test/test-v108.mjs
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repo = dirname(require.resolve('../package.json'));
const { createConnectionManager } = require(join(repo, 'lib', 'connections.js'));
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e?.stack || e?.message || e}`); }
}

const dirs = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), `peek-v108-${process.pid}-`)); dirs.push(d); return d; };

/** 真 SQLite 句柄：把 peekPage 拼出的 SQL 原样执行。 */
function sqliteHandle(db) {
  return {
    async query(sql, params) {
      const stmt = db.prepare(sql);
      const rows = params === undefined ? stmt.all() : stmt.all(...params);
      const fields = stmt.columns().map((c) => ({ name: c.column ?? c.name }));
      return { rows, fields };
    },
    async close() { db.close(); },
  };
}

async function main() {
  const m = createConnectionManager(tempDir());
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, label TEXT)');
  const ins = db.prepare('INSERT INTO big (id, label) VALUES (?, ?)');
  for (let i = 1; i <= 450; i++) ins.run(i, `row-${i}`);

  const handle = sqliteHandle(db);
  m.live.set('c1', { kind: 'sqlite', handle, profile: { id: 'c1', name: 'p', kind: 'sqlite' } });

  const base = { id: 'c1', database: '', table: 'big', pageSize: 200 };

  await checkAsync('第 1 页：200 行，total=450，paginated=true', async () => {
    const r = await m.peekPage({ ...base, page: 1 });
    assert.equal(r.rows.length, 200);
    assert.equal(r.total, 450);
    assert.equal(r.paginated, true);
    assert.equal(r.rows[0].id, 1);
  });

  await checkAsync('第 3 页：50 行（450-400），OFFSET 正确', async () => {
    const r = await m.peekPage({ ...base, page: 3 });
    assert.equal(r.rows.length, 50);
    assert.equal(r.rows[0].id, 401);
    assert.equal(r.page, 3);
  });

  await checkAsync('COUNT 缓存：连续翻页只 COUNT 一次', async () => {
    let counts = 0;
    const wrapped = {
      async query(sql, params) { if (/COUNT\(\*\)/i.test(sql)) counts++; return handle.query(sql, params); },
      async close() {},
    };
    m.live.set('c2', { kind: 'sqlite', handle: wrapped, profile: { id: 'c2', name: 'p2', kind: 'sqlite' } });
    const b2 = { id: 'c2', database: '', table: 'big', pageSize: 200 };
    await m.peekPage({ ...b2, page: 1 });
    await m.peekPage({ ...b2, page: 2 });
    await m.peekPage({ ...b2, page: 3 });
    assert.equal(counts, 1, `COUNT 应只跑 1 次，实际 ${counts}`);
  });

  await checkAsync('筛选条件变化 → 新 key，重新 COUNT 且 total 变化', async () => {
    let counts = 0;
    const wrapped = {
      async query(sql, params) { if (/COUNT\(\*\)/i.test(sql)) counts++; return handle.query(sql, params); },
      async close() {},
    };
    m.live.set('c3', { kind: 'sqlite', handle: wrapped, profile: { id: 'c3', name: 'p3', kind: 'sqlite' } });
    const b3 = { id: 'c3', database: '', table: 'big', pageSize: 200 };
    await m.peekPage({ ...b3, page: 1 });
    const f = await m.peekPage({ ...b3, page: 1, filter: { column: 'id', op: '>', value: '400' } });
    assert.equal(f.total, 50);
    assert.equal(counts, 2);
  });

  await checkAsync('写操作后失效：invalidateCount → 重新 COUNT 读到新行数', async () => {
    let counts = 0;
    const wrapped = {
      async query(sql, params) { if (/COUNT\(\*\)/i.test(sql)) counts++; return handle.query(sql, params); },
      async close() {},
    };
    m.live.set('c4', { kind: 'sqlite', handle: wrapped, profile: { id: 'c4', name: 'p4', kind: 'sqlite' } });
    const b4 = { id: 'c4', database: '', table: 'big', pageSize: 200 };
    assert.equal((await m.peekPage({ ...b4, page: 1 })).total, 450);
    db.prepare('INSERT INTO big (id, label) VALUES (?, ?)').run(9999, 'new');
    m.invalidateCount('c4');
    const after = await m.peekPage({ ...b4, page: 1 });
    assert.equal(after.total, 451, '写后失效必须读到 451');
    assert.equal(counts, 2);
  });

  await checkAsync('页号钳制：1e8 行 / 200 = 500000 页可直达（旧上限 100000 会截断）', async () => {
    const r = await m.peekPage({ ...base, page: 500000 });
    assert.equal(r.page, 500000);
    const hi = await m.peekPage({ ...base, page: 1e12 });
    assert.equal(hi.page, 10000000);
  });

  await checkAsync('页号下限：0 / -9 / NaN → 1', async () => {
    assert.equal((await m.peekPage({ ...base, page: 0 })).page, 1);
    assert.equal((await m.peekPage({ ...base, page: -9 })).page, 1);
    assert.equal((await m.peekPage({ ...base, page: NaN })).page, 1);
  });

  await checkAsync('pageSize 白名单：7 → 200，1000 保留', async () => {
    assert.equal((await m.peekPage({ ...base, pageSize: 7 })).pageSize, 200);
    assert.equal((await m.peekPage({ ...base, pageSize: 1000 })).pageSize, 1000);
  });

  await checkAsync('countCache 有界：>200 条时裁剪，且能整体清空', async () => {
    for (let i = 0; i < 300; i++) m.cacheCount(`cX|d|t${i}|k`, i);
    assert.ok(m.countCache.size <= 200, `size=${m.countCache.size} 应 <= 200`);
    m.invalidateCount(undefined);
    assert.equal(m.countCache.size, 0);
  });

  await checkAsync('排序 + 分页：DESC 首页是最大 id（含前面插入的 9999）', async () => {
    const r = await m.peekPage({ ...base, page: 1, sort: { column: 'id', dir: 'DESC' } });
    assert.equal(r.rows[0].id, 9999);
  });

  await checkAsync('越界页返回空 rows（客户端据 total 回跳末页）', async () => {
    const r = await m.peekPage({ ...base, page: 99 });
    assert.equal(r.rows.length, 0);
    assert.equal(r.total, 451, 'total 仍然准确，供客户端钳制');
  });

  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(`\n==== test-v108: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
