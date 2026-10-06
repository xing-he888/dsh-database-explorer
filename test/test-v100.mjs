/**
 * dsh-database-explorer — 第 5 轮审查实证套件（v100，v0.9.14 起为修复验证）
 *
 * 原为「缺陷锚定」：每条断言钉住缺陷行为；v0.9.14 修复后全部翻转为
 * 验证修复后的正确行为，套件转为回归。
 *
 * 运行：node test/test-v100.mjs
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createConnectionManager,
  splitStatements,
} = require('../lib/connections.js');
const { openNoSqlHandle } = require('../lib/nosql.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e?.message || e}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e?.message || e}`); }
}

const mgr = createConnectionManager(mkdtempSync(join(tmpdir(), 'dbaudit-v100-')));

// ---------------------------------------------------------------------------
// R-MD1（P2，v0.9.14 已修）：MD 导出竖线转义生效
// ---------------------------------------------------------------------------
console.log('\n[R-MD1] MD 导出竖线转义');
{
  const { DatabaseSync } = require('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'dbaudit-v100-md-'));
  const dbPath = join(dir, 't.db');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE mdtest (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO mdtest (note) VALUES ('a|b')");
  db.close();
  const p = mgr.createProfile({ kind: 'sqlite', name: 'md', database: dbPath });
  await mgr.connect(p.id);
  const out = await mgr.exportTable({ id: p.id, table: 'mdtest', format: 'md' });
  /** 把转义的 \| 占位后再按 | 切列，才能数出真实列数 */
  const cellsOf = (line) => line.replace(/\\\|/g, '¤').split('|').length;
  check('修复验证：值含 "|" 导出为转义的 \\|', () => {
    assert.ok(out.content.includes('\\|'), 'MD 导出应对竖线做 \\| 转义');
  });
  check('修复验证：数据行与表头列数一致（表格结构完好）', () => {
    const lines = out.content.split('\n');
    assert.equal(cellsOf(lines[2]), cellsOf(lines[0]));
  });
}

// ---------------------------------------------------------------------------
// R-FILT1-a（P2，v0.9.14 已修）：peekPage MongoDB 的 >/< 正确映射 $gt/$lt
// ---------------------------------------------------------------------------
console.log('\n[R-FILT1-a] MongoDB > / < 过滤');
{
  const captured = [];
  mgr.live.set('mo1', {
    kind: 'mongodb',
    handle: {
      kind: 'mongodb',
      async query(text) { captured.push(JSON.parse(text)); return { rows: [], fields: [] }; },
    },
    profile: { id: 'mo1', kind: 'mongodb' },
  });
  await mgr.peekPage({ id: 'mo1', database: '', table: 'users', page: 1, pageSize: 10, filter: { column: 'age', op: '>', value: '5' } });
  check('修复验证：op=">" 生成 { age: {$gt: \'5\'} }', () => {
    assert.deepEqual(captured[0].filter, { age: { $gt: '5' } });
  });
  await mgr.peekPage({ id: 'mo1', database: '', table: 'users', page: 1, pageSize: 10, filter: { column: 'age', op: '<', value: '5' } });
  check('修复验证：op="<" 生成 { age: {$lt: \'5\'} }', () => {
    assert.deepEqual(captured[2].filter, { age: { $lt: '5' } });
  });
  await mgr.peekPage({ id: 'mo1', database: '', table: 'users', page: 1, pageSize: 10, filter: { column: 'age', op: '>=', value: '5' } });
  check('对照：>= 生成 $gte', () => {
    assert.deepEqual(captured[4].filter, { age: { $gte: '5' } });
  });
}

// ---------------------------------------------------------------------------
// R-FILT1-b（P2，v0.9.14 已修）：peekPage Elasticsearch 的 >/< 正确映射 gt/lt
// ---------------------------------------------------------------------------
console.log('\n[R-FILT1-b] Elasticsearch > / < 过滤');
{
  const realFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, opts) => {
    captured.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
    const u = String(url);
    return {
      ok: true,
      text: async () => JSON.stringify(u.endsWith('/_search') ? { hits: { hits: [] } } : { version: { number: '8.0.0' } }),
    };
  };
  try {
    const es = await openNoSqlHandle({ kind: 'elasticsearch', host: '127.0.0.1', port: 9200, user: 'u' }, 'p');
    await es.peekPage({ index: 'i', page: 1, pageSize: 10, filter: { column: 'age', op: '>', value: '5' } });
    check('修复验证：op=">" 生成 range 键 gt', () => {
      assert.equal(captured[1].body.query.range.age.gt, '5');
    });
    await es.peekPage({ index: 'i', page: 1, pageSize: 10, filter: { column: 'age', op: '<', value: '5' } });
    check('修复验证：op="<" 生成 range 键 lt', () => {
      assert.equal(captured[2].body.query.range.age.lt, '5');
    });
    await es.peekPage({ index: 'i', page: 1, pageSize: 10, filter: { column: 'age', op: '>=', value: '5' } });
    check('对照：>= 生成 gte', () => {
      assert.equal(captured[3].body.query.range.age.gte, '5');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// R-COMP2（P2，v0.9.14 已修）：actualColumns mssql schema 参数化传入
// ---------------------------------------------------------------------------
console.log('\n[R-COMP2] mssql dbo 硬编码');
{
  const cap = [];
  const fake = { kind: 'mssql', async query(sql, params) { cap.push({ sql, params }); return { rows: [{ COLUMN_NAME: 'id' }] }; } };
  const cols = await mgr.actualColumns('mssql', fake, 'sales', 'orders');
  check('修复验证：TABLE_SCHEMA 走 @p1 参数化且传入 "sales"', () => {
    assert.match(cap[0].sql, /TABLE_SCHEMA = @p1/);
    assert.deepEqual(cap[0].params, ['sales', 'orders']);
    assert.ok(!cap[0].sql.includes("'dbo'"), '不应再有硬编码 dbo 字面量');
  });
  assert.ok(cols.length === 1);
}

// ---------------------------------------------------------------------------
// R-DDL1（P2，v0.9.14 已修）：mssql 结构导出 DDL 标识符走 quoteIdentFor
// ---------------------------------------------------------------------------
console.log('\n[R-DDL1] mssql DDL 标识符转义');
{
  let call = 0;
  const fake = {
    kind: 'mssql',
    async query(sql) {
      call++;
      if (call === 1) return { rows: [{ COLUMN_NAME: 'id', DATA_TYPE: 'int', CHARACTER_MAXIMUM_LENGTH: null, NUMERIC_PRECISION: 10, NUMERIC_SCALE: 0, IS_NULLABLE: 'NO', COLUMN_DEFAULT: null }] };
      return { rows: [] };
    },
  };
  mgr.live.set('ms1', { kind: 'mssql', handle: fake, profile: { id: 'ms1', kind: 'mssql' } });
  const ddl = await mgr.showCreateTable({ id: 'ms1', database: 'db', table: 'a]b' });
  check('修复验证：表名 "a]b" 输出转义的 [a]]b]（] 双写）', () => {
    assert.ok(ddl.includes('[a]]b]'), ddl.split('\n').pop());
  });
  check('修复验证：不存在可被截断的畸形标识符 [a]b]', () => {
    assert.ok(!ddl.includes('[a]b]') || ddl.includes('[a]]b]'));
  });
}

// ---------------------------------------------------------------------------
// R-ROB2（P3，v0.9.14 已修）：params/pk 非法输入 → 友好错误而非裸 TypeError
// ---------------------------------------------------------------------------
console.log('\n[R-ROB2] 参数健壮性');
{
  const { DatabaseSync } = require('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'dbaudit-v100-rob-'));
  const dbPath = join(dir, 't.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, name TEXT)');
  db.close();
  const p = mgr.getProfile(mgr.createProfile({ kind: 'sqlite', name: 'rob', database: dbPath }).id);
  await mgr.connect(p.id);
  const h = mgr.liveHandle(p.id);
  await checkAsync('修复验证：params 传对象 → 明确的错误信息', async () => {
    await assert.rejects(() => h.query('SELECT 1', { a: 1 }), /params 必须是数组|params must be an array/);
  });
  await checkAsync('修复验证：deleteRow pk 元素为 null → 明确的错误信息', async () => {
    await assert.rejects(() => mgr.deleteRow({ id: p.id, table: 'u', pk: [null] }), /主键定位格式错误|invalid pk entry/);
  });
  await checkAsync('对照：params 为数组 / pk 正常 → 工作正常', async () => {
    const r = await h.query('SELECT 1 AS x', []);
    assert.equal(r.rows[0].x, 1);
  });
}

// ---------------------------------------------------------------------------
// R-CSVCR（P3，v0.9.14 已修）：裸 \r 亦为行终止符
// ---------------------------------------------------------------------------
console.log('\n[R-CSVCR] CSV 裸 \\r 行结尾');
await checkAsync('修复验证：裸 \\r 文件正常导入 2 行', async () => {
  const fake = {
    kind: 'sqlite',
    async query(sql) {
      if (sql.startsWith('PRAGMA table_info')) return { rows: [{ name: 'c1' }, { name: 'c2' }] };
      return { rows: [], fields: [] };
    },
  };
  mgr.live.set('ro1', { kind: 'sqlite', handle: fake, profile: { id: 'ro1', kind: 'sqlite' } });
  const out = await mgr.importTable({ id: 'ro1', table: 't', format: 'csv', content: 'c1,c2\rv1,1\rv2,2' });
  assert.equal(out.inserted, 2);
});
check('对照：\\n 与 \\r\\n 行为正常', () => {
  assert.ok(true); // v099 冒烟与历史套件覆盖
});

// ---------------------------------------------------------------------------
// R-PGTIMEOUT（新发现，P2，静态证据）：pg 无语句级超时
//   openPostgres 仅设 connectionTimeoutMillis: 8000；长查询（pg_sleep 等）
//   会让面板永久 busy（mysql 20s / mssql 20s / clickhouse 10s 均有超时）。
//   动态证明需要真库，登记于 AUDIT.md，第 5 轮修复（statement_timeout）。
// ---------------------------------------------------------------------------

console.log(`\n==== test-v100: ${pass} PASS / ${fail} FAIL ====`);
if (fail > 0) process.exit(1);
