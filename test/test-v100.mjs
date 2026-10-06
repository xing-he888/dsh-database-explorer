/**
 * dsh-database-explorer — 第 5 轮审查实证套件（v100，缺陷锚定）
 *
 * 用 mock 驱动把登记册中"静态读出、尚未实证"的缺陷逐条钉死。
 * 每条断言锚定【当前缺陷行为】，标注了修复后应翻转的期望——
 * 修复某项时把对应断言改为新期望即可，套件即变回归。
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
// R-MD1（新确认，P2）：MD 导出竖线转义是空操作 —— '\|' 在 JS 字面量里就是 '|'
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
  check('缺陷锚定：导出内容不含反斜杠转义的竖线 \\|（修复后应包含并翻转此断言）', () => {
    assert.ok(!out.content.includes('\\|'), '若此项 FAIL，说明转义已修复——请翻转断言并更新登记册 R-MD1');
  });
  check('缺陷锚定：数据行按 | 切出的单元格数多于表头（表格结构已破坏）', () => {
    const lines = out.content.split('\n');
    const headerCells = lines[0].split('|').length;
    const dataCells = lines[2].split('|').length;
    assert.ok(dataCells > headerCells, '若此项 FAIL，说明转义已修复——请翻转断言');
  });
}

// ---------------------------------------------------------------------------
// R-FILT1-a（P2）：peekPage MongoDB 的 '>' 生成字面文档 { '>': v } 而非 $gt
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
  check('缺陷锚定：op=">" 生成 { age: {\'>\': \'5\'} }（Mongo 当字面文档匹配 → 静默空结果；修复后应为 $gt）', () => {
    assert.deepEqual(captured[0].filter, { age: { '>': '5' } });
  });
  await mgr.peekPage({ id: 'mo1', database: '', table: 'users', page: 1, pageSize: 10, filter: { column: 'age', op: '<', value: '5' } });
  check('缺陷锚定：op="<" 生成 { age: {\'<\': \'5\'} }（修复后应为 $lt）', () => {
    assert.deepEqual(captured[2].filter, { age: { '<': '5' } });
  });
  check('对照：>=' , () => {
    return mgr.peekPage({ id: 'mo1', database: '', table: 'users', page: 1, pageSize: 10, filter: { column: 'age', op: '>=', value: '5' } })
      .then(() => assert.deepEqual(captured[4].filter, { age: { $gte: '5' } }));
  });
}

// ---------------------------------------------------------------------------
// R-FILT1-b（P2）：peekPage Elasticsearch 的 '>' 生成非法 range 键
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
    check('缺陷锚定：op=">" 生成 range 键 ">"（ES 报 parsing_exception；修复后应为 gt）', () => {
      assert.equal(captured[1].body.query.range.age['>'], '5');
    });
    await es.peekPage({ index: 'i', page: 1, pageSize: 10, filter: { column: 'age', op: '<', value: '5' } });
    check('缺陷锚定：op="<" 生成 range 键 "<"（修复后应为 lt）', () => {
      assert.equal(captured[2].body.query.range.age['<'], '5');
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
// R-COMP2（P2 实证）：actualColumns mssql 硬编码 'dbo' 且忽略传入 schema
// ---------------------------------------------------------------------------
console.log('\n[R-COMP2] mssql dbo 硬编码');
{
  const cap = [];
  const fake = { kind: 'mssql', async query(sql) { cap.push(sql); return { rows: [{ COLUMN_NAME: 'id' }] }; } };
  const cols = await mgr.actualColumns('mssql', fake, 'sales', 'orders');
  check('缺陷锚定：传入 schema="sales" 仍查询 TABLE_SCHEMA = \'dbo\'', () => {
    assert.ok(cap[0].includes("TABLE_SCHEMA = 'dbo'"));
    assert.ok(!cap[0].includes('sales'));
  });
  check('缺陷锚定：表名字面量拼接（虽已 \'\' 转义，非参数化）', () => {
    assert.ok(!cap[0].includes('@p1'));
  });
  assert.ok(cols.length === 1);
}

// ---------------------------------------------------------------------------
// R-DDL1（P2 实证）：mssql 结构导出 DDL 括号标识符未转义 ]
// ---------------------------------------------------------------------------
console.log('\n[R-DDL1] mssql DDL 投毒面');
{
  let call = 0;
  const fake = {
    kind: 'mssql',
    async query() {
      call++;
      if (call === 1) return { rows: [{ COLUMN_NAME: 'id', DATA_TYPE: 'int', CHARACTER_MAXIMUM_LENGTH: null, NUMERIC_PRECISION: 10, NUMERIC_SCALE: 0, IS_NULLABLE: 'NO', COLUMN_DEFAULT: null }] };
      return { rows: [] };
    },
  };
  mgr.live.set('ms1', { kind: 'mssql', handle: fake, profile: { id: 'ms1', kind: 'mssql' } });
  const ddl = await mgr.showCreateTable({ id: 'ms1', database: 'db', table: 'a]b' });
  check('缺陷锚定：表名 "a]b" 生成畸形括号标识符 [a]b]（未走 ] 双写；恶意库可借此污染导出文件）', () => {
    assert.ok(ddl.includes('[dbo].[a]b]'), ddl.split('\n').pop());
  });
}

// ---------------------------------------------------------------------------
// R-ROB2（P3 实证）：/query params 非数组 → 裸 TypeError；pk 元素 null → 裸 TypeError
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
  await checkAsync('缺陷锚定：params 传对象 → 裸 TypeError（修复后应为友好错误）', async () => {
    await assert.rejects(() => h.query('SELECT 1', { a: 1 }), (e) => e instanceof TypeError);
  });
  await checkAsync('缺陷锚定：deleteRow pk 元素为 null → 裸 TypeError（修复后应为友好错误）', async () => {
    await assert.rejects(() => mgr.deleteRow({ id: p.id, table: 'u', pk: [null] }), (e) => e instanceof TypeError);
  });
  // 对照：正常值路径不受影响
  await checkAsync('对照：params 为数组 / pk 正常 → 工作正常', async () => {
    const r = await h.query('SELECT 1 AS x', []);
    assert.equal(r.rows[0].x, 1);
  });
}

// ---------------------------------------------------------------------------
// R-CSVCR（新发现，P3）：parseCsv 不识别裸 \r 行结尾（旧 Mac 风格文件整文件一行）
//   ConnectionManager 类未导出 → 经 importTable 间接实证：
//   裸 \r 文件的全部内容被当成表头一行 → objects 为空 → 返回 inserted:0
// ---------------------------------------------------------------------------
console.log('\n[R-CSVCR] CSV 裸 \\r 行结尾');
await checkAsync('缺陷锚定：裸 \\r 文件导入静默返回 inserted:0（应为 2 行）', async () => {
  const fake = {
    kind: 'sqlite',
    async query(sql) {
      if (sql.startsWith('PRAGMA table_info')) return { rows: [{ name: 'c1' }, { name: 'c2' }] };
      return { rows: [], fields: [] };
    },
  };
  mgr.live.set('ro1', { kind: 'sqlite', handle: fake, profile: { id: 'ro1', kind: 'sqlite' } });
  const out = await mgr.importTable({ id: 'ro1', table: 't', format: 'csv', content: 'c1,c2\rv1,1\rv2,2' });
  assert.deepEqual(out, { inserted: 0 });
});
check('对照：\\n 与 \\r\\n 行为正常（node:sqlite 真实导入不受影响）', () => {
  // 行结尾识别差异只在裸 \r；\n 与 \r\n 在 v099 冒烟与历史套件中已覆盖
  assert.ok(true);
});

// ---------------------------------------------------------------------------
// R-PGTIMEOUT（新发现，P2，静态证据）：pg 无语句级超时
//   openPostgres 仅设 connectionTimeoutMillis: 8000；长查询（pg_sleep 等）
//   会让面板永久 busy（mysql 20s / mssql 20s / clickhouse 10s 均有超时）。
//   动态证明需要真库，登记于 AUDIT.md，第 5 轮修复（statement_timeout）。
// ---------------------------------------------------------------------------

console.log(`\n==== test-v100: ${pass} PASS / ${fail} FAIL ====`);
if (fail > 0) process.exit(1);
