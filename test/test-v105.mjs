/**
 * dsh-database-explorer — 连接级只读 + V1 修复套件（v105，v0.9.18）
 *
 * 覆盖：
 *   1. V1（第 8 轮审计 P0）：updateCell 缺 value → 明确拒绝，绝不绑定 undefined
 *      （pg/mssql 驱动会把 undefined 绑成 NULL 静默改库）；null 仍是合法「清空」
 *   2. assertWritable：六个结构化写方法在 readOnly 档案上全部硬拒绝
 *   3. runQuery SQL 预检：首词白名单 / WITH 拒绝 / 多语句拒绝 / INTO OUTFILE
 *      拒绝 / 注释与反斜杠转义感知（复用被审计的分词器）
 *   4. runQuery NoSQL 预检：redis 读命令白名单 / mongo 命令白名单 /
 *      es·qdrant 方法+端点白名单
 *   5. 引擎级强制：sqlite readOnly 真文件打开（native 拒绝写）；
 *      pg options / clickhouse_settings 的连接配置注入（fake driver 捕获）
 *   6. agent 工具：db_query 走收口（只读拒写）；db_update_cell value 必填
 *      （oneOf[string,null] + required）+ 缺 value 友好报错
 *   7. profile 字段链路：create/update/redact 全程携带 readOnly
 *
 * 运行：node test/test-v105.mjs
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createConnectionManager } = require('../lib/connections.js');
const { registerAgentTools } = require('../lib/tools.js');

let pass = 0, fail = 0;
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e?.message || e}`); }
}
function check(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e?.message || e}`); }
}

const fakeDefineTool = (def) => def;
function makeFakeCtx() {
  const registered = [];
  const ctx = {
    effect(fn) { const gen = fn(); for (const item of gen) registered.push(item); return () => {}; },
    tools: { register: (tool) => tool },
  };
  return { ctx, registered };
}

/** 捕获 SQL/参数的假句柄：内省查询应答一列 a（供 insertRow 的列白名单走通），
 *  其余语句记录调用并返回恰好 1 行受影响——updateCell/deleteRow 的
 *  affected===0/>1 三态检查要求"恰改一行"的成功路径。 */
function makeSpyHandle(kind) {
  const calls = [];
  return {
    kind,
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/information_schema|sqlite_master|pg_catalog|sys\.columns/i.test(String(sql))) {
        return { rows: [{ column_name: 'a', COLUMN_NAME: 'a', data_type: 'integer', DATA_TYPE: 'integer' }], fields: [], rowCount: 1 };
      }
      return { rows: [], fields: [], affectedRows: 1, rowCount: 1, insertId: 0 };
    },
    async close() {},
  };
}

/** 往管理器里塞一个已连接档案（profiles + live 双侧）。 */
function attachLive(mgr, { id, kind = 'mysql', readOnly = false, handle }) {
  const profile = { id, name: id, kind, host: '127.0.0.1', port: 3306, readOnly };
  mgr.profiles.push(profile);
  mgr.live.set(id, { kind, handle, profile });
  return profile;
}

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `dbaudit-v105-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 1. V1：updateCell 的 value 契约
// ---------------------------------------------------------------------------
console.log('\n[V1] updateCell 的 value 契约');
{
  const mgr = createConnectionManager(tempDir('v1'));
  const handle = makeSpyHandle('pg');
  attachLive(mgr, { id: 'c1', kind: 'postgres', readOnly: false, handle });
  const base = { id: 'c1', table: 't', column: 'c', pk: [{ column: 'id', value: 1 }] };

  await checkAsync('缺 value → 明确报错（不再静默绑定 NULL）', async () => {
    await assert.rejects(() => mgr.updateCell({ ...base }), /缺少新值|missing value/i);
  });
  check('缺 value → 驱动从未收到 UPDATE', () => {
    assert.equal(handle.calls.length, 0);
  });
  await checkAsync('value=null 合法（清空语义）且绑定的是 null', async () => {
    await mgr.updateCell({ ...base, value: null });
    assert.equal(handle.calls.length, 1);
    assert.deepEqual(handle.calls[0].params[0], null);
  });
  await checkAsync('value 空串按空串写入（不吞值）', async () => {
    await mgr.updateCell({ ...base, value: '' });
    assert.equal(handle.calls[1].params[0], '');
  });
}

// ---------------------------------------------------------------------------
// 2. assertWritable：六个写方法在 readOnly 档案上硬拒绝
// ---------------------------------------------------------------------------
console.log('\n[只读] 结构化写方法硬拒绝');
{
  const mgr = createConnectionManager(tempDir('writable'));
  const roHandle = makeSpyHandle('pg');
  attachLive(mgr, { id: 'ro', kind: 'postgres', readOnly: true, handle: roHandle });
  const rwHandle = makeSpyHandle('pg');
  attachLive(mgr, { id: 'rw', kind: 'postgres', readOnly: false, handle: rwHandle });

  const roCases = [
    ['updateCell', () => mgr.updateCell({ id: 'ro', table: 't', column: 'c', pk: [{ column: 'id', value: 1 }], value: 'x' })],
    ['deleteRow', () => mgr.deleteRow({ id: 'ro', table: 't', pk: [{ column: 'id', value: 1 }] })],
    ['insertRow', () => mgr.insertRow({ id: 'ro', table: 't', values: { a: 1 } })],
    ['importTable', () => mgr.importTable({ id: 'ro', table: 't', format: 'csv', content: 'a\n1' })],
    ['createTable', () => mgr.createTable({ id: 'ro', table: 't', columns: [{ name: 'a', type: 'integer' }] })],
    ['alterTable', () => mgr.alterTable({ id: 'ro', table: 't', add: [{ name: 'b', type: 'integer' }] })],
  ];
  for (const [name, fn] of roCases) {
    await checkAsync(`readOnly → ${name} 拒绝`, async () => {
      await assert.rejects(fn, /只读|read-only/i);
    });
  }
  check('readOnly → 假句柄从未收到任何 SQL', () => {
    assert.equal(roHandle.calls.length, 0);
  });
  await checkAsync('非只读 → 同一批写方法照常执行', async () => {
    await mgr.updateCell({ id: 'rw', table: 't', column: 'c', pk: [{ column: 'id', value: 1 }], value: 'x' });
    await mgr.deleteRow({ id: 'rw', table: 't', pk: [{ column: 'id', value: 1 }] });
    await mgr.insertRow({ id: 'rw', table: 't', values: { a: 1 } });
    // updateCell + deleteRow + insertRow（含其列内省一次），≥3 次到驱动
    assert.ok(rwHandle.calls.length >= 3, `expected >=3 calls, got ${rwHandle.calls.length}`);
    assert.ok(rwHandle.calls.some((c) => /^INSERT INTO/i.test(c.sql)), 'INSERT 应已下发');
  });
  await checkAsync('readOnly + dryRun → 预览放行且绝不发 INSERT（N3 修复钉住）', async () => {
    const dryHandle = makeSpyHandle('pg');
    attachLive(mgr, { id: 'dry', kind: 'postgres', readOnly: true, handle: dryHandle });
    const r = await mgr.importTable({ id: 'dry', table: 't', format: 'csv', content: 'a\n1', dryRun: true });
    assert.equal(r.dryRun, true, '应返回预览而非真实导入结果');
    assert.ok(!dryHandle.calls.some((c) => /^INSERT/i.test(String(c.sql))), '预览不得下发 INSERT');
  });
  await checkAsync('非只读 dryRun 同样只做映射（路由转发 dryRun 后的行为契约）', async () => {
    const dryHandle2 = makeSpyHandle('pg');
    attachLive(mgr, { id: 'dry2', kind: 'postgres', readOnly: false, handle: dryHandle2 });
    const r = await mgr.importTable({ id: 'dry2', table: 't', format: 'csv', content: 'a\n1', dryRun: true });
    assert.equal(r.dryRun, true);
    assert.ok(!dryHandle2.calls.some((c) => /^INSERT/i.test(String(c.sql))));
  });
}

// ---------------------------------------------------------------------------
// 3. runQuery：SQL 只读预检
// ---------------------------------------------------------------------------
console.log('\n[只读] SQL 语句预检（runQuery 收口）');
{
  const mgr = createConnectionManager(tempDir('sqlguard'));
  const handle = makeSpyHandle('mssql');
  attachLive(mgr, { id: 'ro-mssql', kind: 'mssql', readOnly: true, handle });
  const rwHandle = makeSpyHandle('mssql');
  attachLive(mgr, { id: 'rw-mssql', kind: 'mssql', readOnly: false, handle: rwHandle });

  const readSql = [
    'SELECT 1',
    '-- 注释在前\nSELECT 1',
    '/* block */ SHOW TABLES',
    'EXPLAIN SELECT 1',
    'select * from t where a = 1',
    'PRAGMA table_info("t")',
    'DESC t',
  ];
  for (const sql of readSql) {
    await checkAsync(`放行读语句：${JSON.stringify(sql.slice(0, 28))}`, async () => {
      await mgr.runQuery('ro-mssql', sql);
    });
  }
  const writeSql = [
    ['UPDATE t SET a=1', /只读|read-only/i],
    ['INSERT INTO t VALUES (1)', /只读|read-only/i],
    ['DELETE FROM t', /只读|read-only/i],
    ['DROP TABLE t', /只读|read-only/i],
    ['ALTER TABLE t ADD c INT', /只读|read-only/i],
    ['TRUNCATE TABLE t', /只读|read-only/i],
    ['CREATE TABLE t(a INT)', /只读|read-only/i],
    ['GRANT SELECT ON t TO x', /只读|read-only/i],
    ['WITH x AS (SELECT 1) SELECT * FROM x', /WITH/i],
    // N1（审计）：SELECT…INTO 建表 / set_config 撤防引擎级只读
    ['SELECT 1 AS a INTO pwned', /只读|read-only/i],
    ['SELECT set_config(\'transaction_read_only\',\'off\',false)', /set_config|只读/i],
    // N4（审计）：INTO 与 OUTFILE 之间的注释夹心在剥注释后被拦
    ['SELECT 1 INTO/*x*/ OUTFILE \'/tmp/x\'', /只读|read-only|INTO/i],
    ['SELECT 1 INTO OUTFILE \'/tmp/x\'', /只读|read-only|INTO/i],
    ['SELECT 1; SELECT 2', /单条|single/i],
    ["SELECT '\\'; UPDATE t SET a=1", /只读|read-only/i], // 反斜杠转义感知：'\' 未闭合引号不是语句边界——整条仍是单语句，但首词 UPDATE 触发拒绝才是正确形态
    ['', /只读|read-only|空语句/i],
  ];
  for (const [sql, re] of writeSql) {
    await checkAsync(`拒绝写语句：${JSON.stringify(sql.slice(0, 34))}`, async () => {
      await assert.rejects(() => mgr.runQuery('ro-mssql', sql), re);
    });
  }
  await checkAsync('mysql 反斜杠转义感知：`\'\\`; UPDATE…` 是单语句且首词 SELECT → 放行预检（方言差异钉住）', async () => {
    const roMysql = makeSpyHandle('mysql');
    attachLive(mgr, { id: 'ro-mysql', kind: 'mysql', readOnly: true, handle: roMysql });
    await mgr.runQuery('ro-mysql', "SELECT '\\'; UPDATE t SET a=1"); // 分词器判定单语句、首词 SELECT——驱动层对畸形 SQL 自行报错
  });
  await checkAsync('只读连接上驱动从未收到写语句（读语句放行属预期）', async () => {
    const writes = handle.calls.filter((c) => /^(UPDATE|INSERT|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|MERGE|REPLACE|CALL)\b/i.test(String(c.sql).trim()));
    assert.equal(writes.length, 0);
  });
  await checkAsync('非只读连接 UPDATE 照常执行', async () => {
    await mgr.runQuery('rw-mssql', 'UPDATE t SET a=1');
    assert.equal(rwHandle.calls.length, 1);
  });
}

// ---------------------------------------------------------------------------
// 4. runQuery：NoSQL / mongo 只读预检
// ---------------------------------------------------------------------------
console.log('\n[只读] NoSQL 命令预检');
{
  const mgr = createConnectionManager(tempDir('nosqlguard'));
  const roRedis = makeSpyHandle('redis');
  attachLive(mgr, { id: 'ro-redis', kind: 'redis', readOnly: true, handle: roRedis });
  const roMongo = makeSpyHandle('mongodb');
  attachLive(mgr, { id: 'ro-mongo', kind: 'mongodb', readOnly: true, handle: roMongo });
  const roEs = makeSpyHandle('elasticsearch');
  attachLive(mgr, { id: 'ro-es', kind: 'elasticsearch', readOnly: true, handle: roEs });
  const roQd = makeSpyHandle('qdrant');
  attachLive(mgr, { id: 'ro-qd', kind: 'qdrant', readOnly: true, handle: roQd });

  await checkAsync('redis：GET 放行', async () => { await mgr.runQuery('ro-redis', 'GET mykey'); });
  await checkAsync('redis：SCAN 放行', async () => { await mgr.runQuery('ro-redis', 'SCAN 0 MATCH u:* COUNT 100'); });
  await checkAsync('redis：SET 拒绝', async () => {
    await assert.rejects(() => mgr.runQuery('ro-redis', 'SET k v'), /只读|read-only/i);
  });
  await checkAsync('redis：DEL 拒绝', async () => {
    await assert.rejects(() => mgr.runQuery('ro-redis', 'DEL k'), /只读|read-only/i);
  });
  await checkAsync('redis：CONFIG 拒绝', async () => {
    await assert.rejects(() => mgr.runQuery('ro-redis', 'CONFIG GET maxmemory'), /只读|read-only/i);
  });
  await checkAsync('redis：小写命令 get 放行', async () => { await mgr.runQuery('ro-redis', 'get mykey'); });

  await checkAsync('mongo：find 放行', async () => { await mgr.runQuery('ro-mongo', JSON.stringify({ collection: 'c', command: 'find', filter: {} })); });
  await checkAsync('mongo：updateMany 拒绝', async () => {
    await assert.rejects(() => mgr.runQuery('ro-mongo', JSON.stringify({ collection: 'c', command: 'updateMany', update: {} })), /只读|read-only/i);
  });
  await checkAsync('mongo：deleteMany 拒绝', async () => {
    await assert.rejects(() => mgr.runQuery('ro-mongo', JSON.stringify({ collection: 'c', command: 'deleteMany' })), /只读|read-only/i);
  });
  await checkAsync('mongo：aggregate 带 $out 拒绝（N5）', async () => {
    await assert.rejects(
      () => mgr.runQuery('ro-mongo', JSON.stringify({ collection: 'c', command: 'aggregate', pipeline: [{ $match: {} }, { $out: 'other' }] })),
      /只读|read-only|\$out/i,
    );
  });

  await checkAsync('es：{"index",…} 搜索形态放行', async () => {
    await mgr.runQuery('ro-es', JSON.stringify({ index: 'idx', query: { match_all: {} } }));
  });
  await checkAsync('es：POST _search 放行', async () => {
    await mgr.runQuery('ro-es', JSON.stringify({ method: 'POST', path: 'idx/_search', body: {} }));
  });
  await checkAsync('es：POST _bulk 拒绝', async () => {
    await assert.rejects(() => mgr.runQuery('ro-es', JSON.stringify({ method: 'POST', path: '_bulk', body: {} })), /只读|read-only/i);
  });
  await checkAsync('es：_search/../_bulk 路径穿越拒绝（N2，端到端实证过的旁路）', async () => {
    await assert.rejects(() => mgr.runQuery('ro-es', JSON.stringify({ method: 'POST', path: 'idx/_search/../_bulk', body: {} })), /只读|read-only|穿越/i);
  });
  await checkAsync('es：qdrant points/search/../delete 同型拒绝', async () => {
    await assert.rejects(() => mgr.runQuery('ro-qd', JSON.stringify({ method: 'POST', path: 'collections/c/points/search/../delete', body: {} })), /只读|read-only|穿越/i);
  });
  await checkAsync('es：PUT 写文档拒绝', async () => {
    await assert.rejects(() => mgr.runQuery('ro-es', JSON.stringify({ method: 'PUT', path: 'idx/_doc/1', body: {} })), /只读|read-only/i);
  });
  await checkAsync('qdrant：search 命令放行', async () => {
    await mgr.runQuery('ro-qd', JSON.stringify({ collection: 'c', command: 'search', vector: [0.1], limit: 5 }));
  });
  await checkAsync('qdrant：points/delete 拒绝', async () => {
    await assert.rejects(() => mgr.runQuery('ro-qd', JSON.stringify({ method: 'POST', path: 'collections/c/points/delete', body: {} })), /只读|read-only/i);
  });
  await checkAsync('qdrant：GET collections 放行', async () => {
    await mgr.runQuery('ro-qd', JSON.stringify({ method: 'GET', path: 'collections' }));
  });
}

// ---------------------------------------------------------------------------
// 5. 引擎级强制：sqlite 真文件 / pg·clickhouse 连接配置注入
// ---------------------------------------------------------------------------
console.log('\n[只读] 引擎级强制');
{
  const mgr = createConnectionManager(tempDir('sqlite'));
  const { DatabaseSync } = require('node:sqlite');
  const file = join(tempDir('file'), 'ro.db');
  const setup = new DatabaseSync(file);
  setup.exec('CREATE TABLE t(a INTEGER)');
  setup.exec('INSERT INTO t VALUES (1)');
  setup.close();

  mgr.profiles.push({ id: 'ro-sqlite', name: 'ro', kind: 'sqlite', database: file, readOnly: true });
  await mgr.connect('ro-sqlite');

  await checkAsync('sqlite 只读：SELECT 正常', async () => {
    const r = await mgr.runQuery('ro-sqlite', 'SELECT a FROM t');
    assert.equal(r.rows[0]?.a, 1);
  });
  await checkAsync('sqlite 只读：写语句被客户端预检拒绝', async () => {
    await assert.rejects(() => mgr.runQuery('ro-sqlite', 'INSERT INTO t VALUES (2)'), /只读|read-only/i);
  });
  await checkAsync('sqlite 只读：绕过预检直调驱动，引擎仍拒绝写（native）', async () => {
    await assert.rejects(() => mgr.liveHandle('ro-sqlite').query('INSERT INTO t VALUES (2)'), /readonly|read-only/i);
    const r = await mgr.liveHandle('ro-sqlite').query('SELECT COUNT(*) AS n FROM t');
    assert.equal(Number(r.rows[0].n ?? r.rows[0]['COUNT(*)']), 1, '数据未被改动');
  });

  // pg / clickhouse：fake driver 捕获连接配置，断言只读开关注入
  const mgr2 = createConnectionManager(tempDir('drivers'));
  let pgConfig = null, chConfig = null;
  mgr2.loadDriver = (kind) => {
    if (kind === 'postgres') {
      return { Pool: class { constructor(config) { pgConfig = config; } async query() { return { rows: [], fields: [], rowCount: 0, command: 'SELECT' }; } async end() {} } };
    }
    if (kind === 'clickhouse') {
      return { ClickHouseClient: class { constructor(config) { chConfig = config; } async query() { return { json: async () => [] }; } async close() {} } };
    }
    throw new Error(`unexpected driver ${kind}`);
  };
  mgr2.profiles.push({ id: 'ro-pg', name: 'ro', kind: 'postgres', host: '127.0.0.1', readOnly: true });
  mgr2.profiles.push({ id: 'ro-ch', name: 'ro', kind: 'clickhouse', host: '127.0.0.1', readOnly: true });
  await checkAsync('pg 只读：连接串带 default_transaction_read_only=on', async () => {
    await mgr2.connect('ro-pg');
    assert.equal(pgConfig?.options, '-c default_transaction_read_only=on');
  });
  await checkAsync('clickhouse 只读：client 带 readonly=1 设置', async () => {
    await mgr2.connect('ro-ch');
    assert.equal(chConfig?.clickhouse_settings?.readonly, 1);
  });
  const mgr3 = createConnectionManager(tempDir('drivers-rw'));
  let pgConfigRw = null;
  mgr3.loadDriver = (kind) => {
    if (kind === 'postgres') {
      return { Pool: class { constructor(config) { pgConfigRw = config; } async query() { return { rows: [], fields: [], rowCount: 0, command: 'SELECT' }; } async end() {} } };
    }
    throw new Error(`unexpected driver ${kind}`);
  };
  mgr3.profiles.push({ id: 'rw-pg', name: 'rw', kind: 'postgres', host: '127.0.0.1' });
  await checkAsync('非只读 pg：不注入只读 options（行为不变）', async () => {
    await mgr3.connect('rw-pg');
    assert.equal(pgConfigRw?.options, undefined);
  });
}

// ---------------------------------------------------------------------------
// 6. agent 工具链路：db_query 收口 + db_update_cell value 必填
// ---------------------------------------------------------------------------
console.log('\n[agent] 写工具在只读连接上的行为');
{
  const dataDir = tempDir('agent');
  const mgr = createConnectionManager(tempDir('agent-mgr'));
  const handle = makeSpyHandle('pg');
  attachLive(mgr, { id: 'ro-agent', kind: 'postgres', readOnly: true, handle });
  const { ctx, registered } = makeFakeCtx();
  await registerAgentTools(ctx, mgr, dataDir, { defineTool: fakeDefineTool, writeToolsEnabled: true });
  const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

  check('db_update_cell value 参数：required + oneOf[string,null]', () => {
    const v = byName.db_update_cell.parameters.value;
    assert.equal(v.required, true);
    assert.ok(Array.isArray(v.oneOf), 'value 需要 oneOf 以放行显式 null');
    assert.ok(v.oneOf.some((b) => b.type === 'string') && v.oneOf.some((b) => b.type === 'null'));
  });
  await checkAsync('db_query 只读连接：SELECT 放行', async () => {
    const r = await byName.db_query.execute({ id: 'ro-agent', sql: 'SELECT 1' });
    assert.ok(r);
  });
  await checkAsync('db_query 只读连接：UPDATE 拒绝', async () => {
    await assert.rejects(() => byName.db_query.execute({ id: 'ro-agent', sql: 'UPDATE t SET a=1' }), /只读|read-only/i);
  });
  await checkAsync('db_update_cell 缺 value → 友好报错（V1，可写连接上验证）', async () => {
    attachLive(mgr, { id: 'rw-agent', kind: 'postgres', readOnly: false, handle });
    await assert.rejects(
      () => byName.db_update_cell.execute({ id: 'rw-agent', table: 't', column: 'c', pk: '[{"column":"id","value":1}]' }),
      /缺少新值|missing value/i,
    );
  });
  await checkAsync('db_update_cell 显式 null → 走到驱动（清空语义保留）', async () => {
    // 只读连接上 assertWritable 先触发——换成非只读档案验证 null 链路
    attachLive(mgr, { id: 'rw-agent', kind: 'postgres', readOnly: false, handle });
    await byName.db_update_cell.execute({ id: 'rw-agent', table: 't', column: 'c', pk: '[{"column":"id","value":1}]', value: null });
    assert.equal(handle.calls.at(-1).params[0], null);
  });
}

// ---------------------------------------------------------------------------
// 7. profile 字段链路
// ---------------------------------------------------------------------------
console.log('\n[profile] readOnly 字段全程携带');
{
  const mgr = createConnectionManager(tempDir('profile'));
  check('createProfile：readOnly 存储并回显', () => {
    const p = mgr.createProfile({ name: 'prod', kind: 'mysql', host: '127.0.0.1', readOnly: true });
    assert.equal(p.readOnly, true);
    assert.equal(mgr.getProfile(p.id).readOnly, true);
  });
  check('createProfile：缺省为 false', () => {
    const p = mgr.createProfile({ name: 'dev', kind: 'mysql', host: '127.0.0.1' });
    assert.equal(p.readOnly, false);
  });
  check('createProfile：readOnly:"yes" 等真值字符串不启用（严格 === true）', () => {
    const p = mgr.createProfile({ name: 'strict', kind: 'mysql', host: '127.0.0.1', readOnly: 'yes' });
    assert.equal(p.readOnly, false);
  });
  check('updateProfile：翻转 readOnly 即刻回显', () => {
    const p = mgr.createProfile({ name: 'flip', kind: 'mysql', host: '127.0.0.1' });
    const updated = mgr.updateProfile(p.id, { readOnly: true });
    // updateProfile 关闭连接后异步返回——同步阶段先看存储
    assert.equal(mgr.getProfile(p.id).readOnly, true);
    assert.ok(updated instanceof Promise || updated?.readOnly === true);
  });
}

// ---------------------------------------------------------------------------
console.log(`\n==== test-v105: ${pass} PASS / ${fail} FAIL ====`);
for (const dir of tempDirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 平台锁忽略 */ } }
process.exit(fail > 0 ? 1 : 0);
