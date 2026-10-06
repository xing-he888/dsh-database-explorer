/**
 * dsh-database-explorer — E-R 正确率套件（v102，v0.9.15 引入）
 *
 * 覆盖第 5/6 轮正确率改进：
 *   1. 基数自动推导：单列唯一（PK/UNIQUE）上的外键 → 1:1，否则 N:1（sqlite 真库 + mock 目录行）
 *   2. R-EDGE1：超 400 条外键边 → edgesTruncated 上报总数（不再静默丢弃）
 *   3. 视图过滤：pg/mysql/mssql 的内省 SQL 必须排除 VIEW（与 sqlite 行为对齐）
 *   4. 复合外键列序配对回归（pg WITH ORDINALITY 语义的组装层验证）
 *
 * 运行：node test/test-v102.mjs
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createConnectionManager } = require('../lib/connections.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e?.message || e}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e?.message || e}`); }
}

const mgr = createConnectionManager(mkdtempSync(join(tmpdir(), 'dbaudit-v102-')));

// ---------------------------------------------------------------------------
// 1a. 基数推导（sqlite 真库）：UNIQUE 外键 → 1:1，普通外键 → N:1
// ---------------------------------------------------------------------------
console.log('\n[基数] sqlite 真库推导');
await checkAsync('user_id 有 UNIQUE 约束的子表 → 1:1；无约束的 → N:1', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'dbaudit-v102-er-'));
  const dbPath = join(dir, 't.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE passport (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id));
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));`);
  db.close();
  const p = mgr.createProfile({ kind: 'sqlite', name: 'er', database: dbPath });
  await mgr.connect(p.id);
  const er = await mgr.erGraph({ id: p.id, database: '(file)' });
  assert.equal(er.tables.length, 3);
  const byFrom = Object.fromEntries(er.edges.map((e) => [`${e.fromTable}.${e.fromCol}`, e]));
  assert.equal(byFrom['passport.user_id'].card, '1:1', 'UNIQUE 外键应推导为 1:1');
  assert.equal(byFrom['orders.user_id'].card, 'N:1', '普通外键应为 N:1');
  assert.equal(er.edgesTruncated, undefined, '未截断时不带标记');
  await mgr.closeAll();
});

// ---------------------------------------------------------------------------
// 1b. 基数推导（mysql mock 目录行）
// ---------------------------------------------------------------------------
console.log('\n[基数] mysql 目录推导');
await checkAsync('statistics 单列唯一 → 1:1；复合索引列不算唯一', async () => {
  const captured = [];
  mgr.live.set('my-er', {
    kind: 'mysql',
    handle: {
      kind: 'mysql',
      async query(sql, params) {
        captured.push(sql);
        if (sql.includes('information_schema.columns')) {
          return { rows: [
            { table_name: 'users', column_name: 'id', column_type: 'int', column_key: 'PRI' },
            { table_name: 'one', column_name: 'uid', column_type: 'int', column_key: 'MUL' },
            { table_name: 'many', column_name: 'uid', column_type: 'int', column_key: 'MUL' },
          ] };
        }
        if (sql.includes('key_column_usage')) {
          return { rows: [
            { table_name: 'one', column_name: 'uid', referenced_table_name: 'users', referenced_column_name: 'id' },
            { table_name: 'many', column_name: 'uid', referenced_table_name: 'users', referenced_column_name: 'id' },
          ] };
        }
        if (sql.includes('statistics')) {
          // 单列唯一索引只覆盖 one.uid；many.uid 只有复合索引前缀（被子查询排除）
          return { rows: [{ table_name: 'one', column_name: 'uid' }] };
        }
        return { rows: [] };
      },
    },
    profile: { id: 'my-er', kind: 'mysql' },
  });
  const er = await mgr.erGraph({ id: 'my-er', database: 'shop' });
  const byFrom = Object.fromEntries(er.edges.map((e) => [`${e.fromTable}.${e.fromCol}`, e]));
  assert.equal(byFrom['one.uid'].card, '1:1');
  assert.equal(byFrom['many.uid'].card, 'N:1');
  check('修复验证：mysql 内省 SQL 过滤视图（table_type = BASE TABLE）', () => {
    assert.match(captured[0], /table_type = 'BASE TABLE'/);
  });
});

// ---------------------------------------------------------------------------
// 1c. 基数推导（pg mock）+ 复合外键列序回归
// ---------------------------------------------------------------------------
console.log('\n[基数] pg 目录推导 + 复合外键');
await checkAsync('单列 UNIQUE 约束 → 1:1；复合外键按 conkey 序配对', async () => {
  const captured = [];
  mgr.live.set('pg-er', {
    kind: 'postgres',
    handle: {
      kind: 'postgres',
      async query(sql, params) {
        captured.push(sql);
        if (sql.includes('information_schema.columns')) {
          return { rows: [
            { table_name: 'users', column_name: 'id', data_type: 'integer' },
            { table_name: 'one', column_name: 'uid', data_type: 'integer' },
          ] };
        }
        if (sql.includes("constraint_type = 'PRIMARY KEY'")) {
          return { rows: [{ table_name: 'users', column_name: 'id' }] };
        }
        if (sql.includes('pg_constraint c') && sql.includes('contype = ' + String.fromCharCode(39) + 'f' + String.fromCharCode(39))) {
          // 复合外键 (a,b) → (x,y)，按 conkey/confkey 序配对
          return { rows: [
            { table_name: 'one', column_name: 'uid', ref_table: 'users', ref_col: 'id' },
          ] };
        }
        if (sql.includes("contype IN ('u','p')")) {
          return { rows: [{ table_name: 'one', column_name: 'uid' }] };
        }
        return { rows: [] };
      },
    },
    profile: { id: 'pg-er', kind: 'postgres' },
  });
  const er = await mgr.erGraph({ id: 'pg-er', database: 'public' });
  assert.equal(er.edges.length, 1);
  assert.deepEqual([er.edges[0].fromCol, er.edges[0].toCol, er.edges[0].card], ['uid', 'id', '1:1']);
  check('修复验证：pg 内省 SQL 过滤视图', () => {
    assert.match(captured[0], /table_type = 'BASE TABLE'/);
  });
});

// ---------------------------------------------------------------------------
// 2. R-EDGE1：外键边超 400 → edges[400] + edgesTruncated 上报（不再静默丢弃）
//    200 张表 × 每表 3 条外键 = 600 条边（全部指向清单内表），边上限先于表上限触发
// ---------------------------------------------------------------------------
console.log('\n[R-EDGE1] 边截断上报');
await checkAsync('600 条外键 → edges 恰 400 条 + edgesTruncated=600', async () => {
  const N = 200, FK_PER_TABLE = 3, EDGE_TOTAL = N * FK_PER_TABLE;
  const mock = {
    kind: 'sqlite',
    async query(sql) {
      if (sql.includes('sqlite_master')) {
        return { rows: Array.from({ length: N }, (_, i) => ({ name: `t${String(i).padStart(3, '0')}` })) };
      }
      if (sql.includes('table_info')) return { rows: [{ name: 'id', type: 'INTEGER', pk: 1 }, { name: 'r1', type: 'INTEGER', pk: 0 }, { name: 'r2', type: 'INTEGER', pk: 0 }, { name: 'r3', type: 'INTEGER', pk: 0 }] };
      if (sql.includes('foreign_key_list')) {
        const m = sql.match(/"t(\d+)"/);
        const i = Number(m[1]);
        return { rows: [1, 2, 3].map((k) => ({ from: `r${k}`, table: `t${String((i + k) % N).padStart(3, '0')}`, to: 'id', seq: k - 1 })) };
      }
      if (sql.includes('index_list')) return { rows: [] };
      return { rows: [] };
    },
  };
  mgr.live.set('er-cap', { kind: 'sqlite', handle: mock, profile: { id: 'er-cap', kind: 'sqlite' } });
  const er = await mgr.erGraph({ id: 'er-cap', database: '(file)' });
  assert.equal(er.edges.length, 400);
  assert.equal(er.edgesTruncated, EDGE_TOTAL);
});

// ---------------------------------------------------------------------------
// 3. mssql 视图过滤 + 基数（mock 目录）
// ---------------------------------------------------------------------------
console.log('\n[mssql] 视图过滤 + 基数');
await checkAsync('内省 SQL 过滤视图；UNIQUE 约束列 → 1:1', async () => {
  const captured = [];
  mgr.live.set('ms-er', {
    kind: 'mssql',
    handle: {
      kind: 'mssql',
      async query(sql) {
        captured.push(sql);
        if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
          return { rows: [
            { table_name: 'users', column_name: 'id', data_type: 'int' },
            { table_name: 'one', column_name: 'uid', data_type: 'int' },
          ] };
        }
        if (sql.includes("CONSTRAINT_TYPE = 'PRIMARY KEY'")) {
          return { rows: [{ table_name: 'users', column_name: 'id' }] };
        }
        if (sql.includes("CONSTRAINT_TYPE IN ('UNIQUE','PRIMARY KEY')")) {
          return { rows: [{ table_name: 'one', column_name: 'uid' }] };
        }
        if (sql.includes('sys.foreign_keys')) {
          return { rows: [{ from_table: 'one', from_col: 'uid', to_table: 'users', to_col: 'id' }] };
        }
        return { rows: [] };
      },
    },
    profile: { id: 'ms-er', kind: 'mssql' },
  });
  const er = await mgr.erGraph({ id: 'ms-er', database: 'dbo' });
  assert.equal(er.edges[0].card, '1:1');
  check('修复验证：mssql 内省 SQL 过滤视图（TABLE_TYPE = BASE TABLE）', () => {
    assert.match(captured[0], /TABLE_TYPE = 'BASE TABLE'/);
  });
});

console.log(`\n==== test-v102: ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail > 0 ? 1 : 0);
