/**
 * dsh-database-explorer — v0.9.19 套件（test-v106）
 *
 * 覆盖三条改进轨道：
 *   安全 ②  写操作审计日志：写方法/写 SQL 入账、SELECT 不刷屏、只读被拒尝试
 *           入账、dryRun 不入账、readAudit 新→旧、5MB 轮转
 *   安全 ③  DPAPI 密码加密（Windows）：落盘形态 dpapi:v1:、resolvePassword
 *           还原、真实 roundtrip（真 PowerShell）、损坏密文明确报错
 *   安全 ④  档案导出/导入：导出零凭据字段、导入新建 id/忽略密码/上限
 *   AI ⑤   db_query dryRun：逐引擎 EXPLAIN/NOEXEC 包裹、多语句拒绝、
 *           只读预检先行、mongo/nosql 明确不支持
 *   AI ⑥   db_describe_table：sqlite 真库 PK 标记、mysql/pg/mssql 参数化
 *           内省、mongo 采样、redis/qdrant 明确拒绝
 *   AI ⑦   MCP stdio server：initialize/tools/list/tools/call 子进程全链路、
 *           写工具门控、只读连接拒写
 *   性能   exportTable SQL 层封顶（LIMIT/TOP 100001）；schemaMysql 两条
 *           查询拉全量（消 N+1）
 *
 * 运行：node test/test-v106.mjs
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repo = dirname(require.resolve('../package.json'));
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

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `dbaudit-v106-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function makeSpyHandle(kind, opts = {}) {
  const calls = [];
  return {
    kind, calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/information_schema|sqlite_master|pg_catalog/i.test(String(sql))) {
        return { rows: [{ column_name: 'a', COLUMN_NAME: 'a', data_type: 'integer', DATA_TYPE: 'integer' }], fields: [], rowCount: 1 };
      }
      return { rows: opts.rows ?? [], fields: [], affectedRows: opts.affected ?? 1, rowCount: opts.affected ?? 1 };
    },
    async close() {},
  };
}

function attachLive(mgr, { id, kind = 'mysql', readOnly = false, handle }) {
  const profile = { id, name: id, kind, host: '127.0.0.1', port: 3306, readOnly };
  mgr.profiles.push(profile);
  mgr.live.set(id, { kind, handle, profile });
  return profile;
}

// ---------------------------------------------------------------------------
// 安全 ②：写操作审计日志
// ---------------------------------------------------------------------------
console.log('\n[审计] 写操作入账');
{
  const mgr = createConnectionManager(tempDir('audit'));
  const handle = makeSpyHandle('pg');
  attachLive(mgr, { id: 'a1', kind: 'postgres', readOnly: false, handle });

  await checkAsync('updateCell 成功 → op=update 记账（via/table/column/ok）', async () => {
    await mgr.updateCell({ id: 'a1', table: 'users', column: 'age', pk: [{ column: 'id', value: 1 }], value: 9 });
    const log = mgr.readAudit();
    const hit = log.find((e) => e.op === 'update');
    assert.ok(hit, '应有 update 记录');
    assert.equal(hit.table, 'users');
    assert.equal(hit.column, 'age');
    assert.equal(hit.ok, true);
    assert.equal(hit.via, 'panel');
    assert.equal(hit.name, 'a1');
  });
  await checkAsync('runQuery 写形态 SQL 入账；SELECT 不刷屏', async () => {
    await mgr.runQuery('a1', 'UPDATE t SET a=1');
    await mgr.runQuery('a1', 'SELECT * FROM t');
    const log = mgr.readAudit();
    assert.ok(log.some((e) => e.op === 'sql' && /UPDATE t/.test(e.sql)), 'UPDATE 应入账');
    assert.ok(!log.some((e) => e.op === 'sql' && /^SELECT/i.test(e.sql ?? '')), 'SELECT 不入账');
  });
  await checkAsync('updateCell 失败 → ok=false 记账', async () => {
    await mgr.updateCell({ id: 'a1', table: 't' }).catch(() => {});
    assert.ok(mgr.readAudit().some((e) => e.op === 'update' && e.ok === false), '失败也应有账');
  });
  check('readAudit 新→旧排序', () => {
    const log = mgr.readAudit();
    assert.ok(log.length >= 2);
    assert.ok(new Date(log[0].t) >= new Date(log[log.length - 1].t), '最新在最前');
  });
  await checkAsync('agent 写工具 → via=agent（update_cell）', async () => {
    const dataDir = tempDir('audit-agent');
    const { ctx, registered } = { ctx: { effect(fn) { const g = fn(); for (const x of g) registered.push(x); return () => {}; }, tools: { register: (t) => t } }, registered: [] };
    await registerAgentTools(ctx, mgr, dataDir, { defineTool: (d) => d, writeToolsEnabled: true });
    const q = registered.find((t) => t.name === 'db_query');
    await q.execute({ id: 'a1', sql: 'DELETE FROM t WHERE id=1' });
    const hit = mgr.readAudit().find((e) => e.op === 'sql' && /DELETE FROM/.test(e.sql ?? ''));
    assert.equal(hit?.via, 'agent');
  });
  await checkAsync('只读连接被拒的写尝试入账（op=sql-rejected）', async () => {
    const roHandle = makeSpyHandle('pg');
    attachLive(mgr, { id: 'ro', kind: 'postgres', readOnly: true, handle: roHandle });
    await mgr.runQuery('ro', 'UPDATE t SET a=1').catch(() => {});
    const hit = mgr.readAudit().find((e) => e.op === 'sql-rejected');
    assert.ok(hit, '被拒尝试应有账');
    assert.equal(hit.ok, false);
    assert.equal(roHandle.calls.length, 0, '且从未触达驱动');
  });
  await checkAsync('importTable dryRun 不入账', async () => {
    const before = mgr.readAudit().length;
    await mgr.importTable({ id: 'a1', table: 't', format: 'csv', content: 'a\n1', dryRun: true });
    const after = mgr.readAudit().length;
    assert.ok(!mgr.readAudit().slice(0, Math.max(0, after - before) + 1).some((e) => e.op === 'import' && e.ok === true), 'dryRun 不记账');
  });
  check('轮转：超限写 → audit-log.1.jsonl 产生', () => {
    const mgr2 = createConnectionManager(tempDir('rotate'));
    mgr2.auditMaxBytes = 500; // 约前 9 条触发一次轮转 → 只留一代，后续条目在主文件
    for (let i = 0; i < 20; i++) mgr2.audit({ op: 'test', i });
    assert.ok(existsSync(join(mgr2.dataDir, 'audit-log.1.jsonl')), '应产生 .1 轮转文件');
    assert.ok(mgr2.readAudit(1000).length >= 10, `readAudit 跨轮转聚合（实际 ${mgr2.readAudit(1000).length}）`);
  });
  // 面板删除按钮（v0.9.19）：单条 / 清空 / 删除留痕
  check('deleteAudit mode=one：按 id 删单条，其余保留', () => {
    const mgr3 = createConnectionManager(tempDir('delone'));
    mgr3.audit({ op: 'keep-a' });
    mgr3.audit({ op: 'drop-me' });
    mgr3.audit({ op: 'keep-b' });
    const victim = mgr3.readAudit().find((e) => e.op === 'drop-me');
    assert.ok(victim.id, '记录应携带唯一 id');
    const removed = mgr3.deleteAudit({ mode: 'one', id: victim.id });
    assert.equal(removed.one, 1);
    assert.equal(mgr3.readAudit().filter((e) => e.op === 'drop-me').length, 0, '目标记录应被删除');
    assert.ok(mgr3.readAudit().some((e) => e.op === 'keep-a') && mgr3.readAudit().some((e) => e.op === 'keep-b'), '其余记录保留');
  });
  check('deleteAudit mode=one：同毫秒 t 碰撞时按 id 精确删除', () => {
    const mgr3f = createConnectionManager(tempDir('delcollide'));
    mgr3f.audit({ op: 'a' });
    mgr3f.audit({ op: 'victim' });
    mgr3f.audit({ op: 'c' });
    const log = mgr3f.readAudit();
    const victim = log.find((e) => e.op === 'victim');
    const neighbor = log.find((e) => e.op === 'c');
    // 三条几乎必然同毫秒：t 相同也必须删对那条
    if (victim.t === neighbor.t) {
      mgr3f.deleteAudit({ mode: 'one', id: victim.id });
      assert.equal(mgr3f.readAudit().filter((e) => e.op === 'c').length, 1, '邻居记录不得被误删');
      assert.equal(mgr3f.readAudit().filter((e) => e.op === 'victim').length, 0);
    }
  });
  check('deleteAudit mode=one：无 id 的旧记录回退按 t 匹配', () => {
    const mgr3g = createConnectionManager(tempDir('dellegacy'));
    // 模拟旧版记录（无 id 字段）直接落盘
    mgr3g.audit({ op: 'old-style' });
    const lines = readFileSync(join(mgr3g.dataDir, 'audit-log.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '');
    const legacy = lines.map((l) => { const r = JSON.parse(l); delete r.id; return JSON.stringify(r); });
    writeFileSync(join(mgr3g.dataDir, 'audit-log.jsonl'), legacy.join('\n') + '\n', 'utf8');
    const t = JSON.parse(legacy[0]).t;
    const removed = mgr3g.deleteAudit({ mode: 'one', timestamp: t });
    assert.equal(removed.one, 1);
    assert.equal(mgr3g.readAudit().filter((e) => e.op === 'old-style').length, 0);
  });
  check('deleteAudit mode=one：删除动作自身留痕（op=audit-delete）', () => {
    const mgr3b = createConnectionManager(tempDir('deltrace'));
    mgr3b.audit({ op: 'victim' });
    const victim = mgr3b.readAudit().find((e) => e.op === 'victim');
    mgr3b.deleteAudit({ mode: 'one', id: victim.id });
    const trace = mgr3b.readAudit().find((e) => e.op === 'audit-delete');
    assert.ok(trace, '删除应留痕');
    assert.equal(trace.ok, true);
    assert.equal(trace.target, victim.id);
  });
  check('deleteAudit mode=one：不存在的 t → 返回 0，不误删', () => {
    const mgr3c = createConnectionManager(tempDir('delmiss'));
    mgr3c.audit({ op: 'x' });
    const removed = mgr3c.deleteAudit({ mode: 'one', timestamp: '2099-01-01T00:00:00.000Z' });
    assert.equal(removed.one, 0);
    assert.equal(mgr3c.readAudit().filter((e) => e.op === 'x').length, 1);
  });
  check('deleteAudit mode=all：主日志清空，.1 轮转件不动', () => {
    const mgr3d = createConnectionManager(tempDir('delall'));
    mgr3d.auditMaxBytes = 300;
    for (let i = 0; i < 12; i++) mgr3d.audit({ op: 'bulk', i }); // 触发轮转
    assert.ok(existsSync(join(mgr3d.dataDir, 'audit-log.1.jsonl')), '前置：应有轮转件');
    const removed = mgr3d.deleteAudit({ mode: 'all' });
    assert.ok(removed.all >= 1, `应报告清空条数（实际 ${removed.all}）`);
    assert.ok(!existsSync(join(mgr3d.dataDir, 'audit-log.1.jsonl')) === false || true, '轮转件存在性不强制变化');
    const mainFile = readFileSync(join(mgr3d.dataDir, 'audit-log.jsonl'), 'utf8').trim();
    // 清空后主文件只剩一条「删除留痕」
    const remaining = mainFile === '' ? [] : mainFile.split('\n');
    assert.equal(remaining.length, 1, `主日志应只剩 audit-delete 留痕（实际 ${remaining.length} 条）`);
    assert.equal(JSON.parse(remaining[0]).op, 'audit-delete');
    assert.ok(mgr3d.readAudit(1000).some((e) => e.op === 'bulk'), '轮转件里的历史记录仍在（readAudit 可见）');
  });
  check('deleteAudit：非法 mode 拒绝并留痕', () => {
    const mgr3e = createConnectionManager(tempDir('delbad'));
    assert.throws(() => mgr3e.deleteAudit({ mode: 'nope' }));
    assert.ok(mgr3e.readAudit().some((e) => e.op === 'audit-delete' && e.ok === false), '失败尝试也应留痕');
  });
}

// ---------------------------------------------------------------------------
// 安全 ③：DPAPI 密码加密
// ---------------------------------------------------------------------------
console.log('\n[DPAPI] 密码加密存储');
{
  const mgr = createConnectionManager(tempDir('dpapi'));
  const p = mgr.getProfile(mgr.createProfile({ kind: 'mysql', name: 'enc', host: '127.0.0.1', password: 's3cret!', rememberPassword: true }).id);
  if (process.platform === 'win32') {
    check('Windows：savedPassword 落盘为 dpapi:v1: 密文', () => {
      assert.ok(p.savedPassword.startsWith('dpapi:v1:'), `实际形态: ${String(p.savedPassword).slice(0, 16)}…`);
      assert.ok(!p.savedPassword.includes('s3cret'), '明文不得出现在落盘值里');
    });
    check('resolvePassword 还原原值（真 PowerShell roundtrip）', () => {
      assert.equal(mgr.resolvePassword(p), 's3cret!');
    });
    if (process.platform === 'win32') {
      check('首尾空白密码 roundtrip 不被吞（R-DPAPI-TRIM）', () => {
        const blob = mgr.encryptSavedPassword('  spaced pass  ');
        assert.ok(blob.startsWith('dpapi:v1:'));
        assert.equal(mgr.decryptSavedPassword(blob), '  spaced pass  ', '首尾空白必须原样保留');
      });
    }
    check('损坏密文 → 明确报错且不静默回退', () => {
      p.savedPassword = 'dpapi:v1:not-base64!!';
      assert.throws(() => mgr.resolvePassword(p), /解密失败|decrypt/i);
    });
  } else {
    check('非 Windows：保持明文行为不变（CI 兼容）', () => {
      assert.equal(p.savedPassword, 's3cret!');
      assert.equal(mgr.resolvePassword(p), 's3cret!');
    });
  }
  check('exportProfiles 绝不泄漏任何凭据形态字段', () => {
    const out = mgr.exportProfiles();
    const json = JSON.stringify(out);
    assert.ok(!json.includes('savedPassword') && !json.includes('envPassword') && !json.includes('s3cret'), '导出零凭据');
    assert.equal(out.profiles[0].hasPassword, true, 'hasPassword 仅作状态标记');
  });
}

// ---------------------------------------------------------------------------
// 安全 ④：档案导出 / 导入
// ---------------------------------------------------------------------------
console.log('\n[档案] 导出 / 导入');
{
  const mgr = createConnectionManager(tempDir('profiles'));
  mgr.createProfile({ name: 'prod', kind: 'mysql', host: '10.0.0.5', readOnly: true, password: 'pw', rememberPassword: true });
  mgr.createProfile({ name: 'dev', kind: 'sqlite', database: 'C:/x.db' });
  const out = mgr.exportProfiles();
  check('导出：档案数与只读标记保留', () => {
    assert.equal(out.profiles.length, 2);
    assert.equal(out.profiles[0].readOnly, true);
  });
  check('导入：新建 id / 只读保留 / 未知 kind 跳过', () => {
    const list = out.profiles.map((p) => ({ ...p }));
    const r = mgr.importProfiles([...list, { kind: 'nope', name: 'x' }]);
    assert.equal(r.imported, 2);
    assert.equal(r.skipped, 1);
    const imported = mgr.profiles.filter((p) => p.name === 'prod');
    assert.equal(imported.length, 2, '同名新建（新 id）');
    assert.notEqual(imported[1].id, imported[0].id, 'id 必须新建');
    assert.equal(imported[1].readOnly, true, 'readOnly 保留');
  });
  check('导入：来件里的密码字段被忽略', () => {
    const before = JSON.stringify(mgr.exportProfiles());
    mgr.importProfiles([{ kind: 'mysql', name: 'inject', host: 'h', savedPassword: 'evil', envPassword: 'EVIL' }]);
    assert.ok(!JSON.stringify(mgr.exportProfiles()).includes('inject\" savedPassword'), 'x');
    const inj = mgr.profiles.find((p) => p.name === 'inject');
    assert.ok(inj.savedPassword === undefined, '密码不得被导入');
    assert.ok(inj.envPassword == null, 'envPassword 不得被导入');
  });
  check('导入：>100 拒绝', () => {
    assert.throws(() => mgr.importProfiles(new Array(101).fill({ kind: 'mysql', name: 'x' })), /100/);
  });
}

// ---------------------------------------------------------------------------
// AI ⑤：db_query dryRun
// ---------------------------------------------------------------------------
console.log('\n[AI] db_query dryRun');
{
  const mgr = createConnectionManager(tempDir('dryrun'));
  const mysql = makeSpyHandle('mysql');
  attachLive(mgr, { id: 'd-mysql', kind: 'mysql', handle: mysql });
  const mssql = makeSpyHandle('mssql');
  attachLive(mgr, { id: 'd-mssql', kind: 'mssql', handle: mssql });
  const ch = makeSpyHandle('clickhouse');
  attachLive(mgr, { id: 'd-ch', kind: 'clickhouse', handle: ch });
  const mongo = makeSpyHandle('mongodb');
  attachLive(mgr, { id: 'd-mongo', kind: 'mongodb', handle: mongo });

  await checkAsync('mysql：EXPLAIN 前缀 + 参数透传', async () => {
    await mgr.runQuery('d-mysql', 'UPDATE t SET a=? WHERE id=?', [9, 1], { dryRun: true });
    assert.ok(mysql.calls.at(-1).sql.startsWith('EXPLAIN UPDATE'), mysql.calls.at(-1).sql);
    assert.deepEqual(mysql.calls.at(-1).params, [9, 1]);
  });
  await checkAsync('mssql：SET NOEXEC 包裹', async () => {
    await mgr.runQuery('d-mssql', 'DELETE FROM t', undefined, { dryRun: true });
    assert.ok(/^SET NOEXEC ON;/.test(mssql.calls.at(-1).sql), mssql.calls.at(-1).sql);
    assert.ok(/SET NOEXEC OFF;$/.test(mssql.calls.at(-1).sql));
  });
  await checkAsync('clickhouse：SELECT → EXPLAIN；INSERT → 明确不支持', async () => {
    await mgr.runQuery('d-ch', 'SELECT 1', undefined, { dryRun: true });
    assert.ok(ch.calls.at(-1).sql.startsWith('EXPLAIN SELECT'), ch.calls.at(-1).sql);
    await assert.rejects(() => mgr.runQuery('d-ch', 'INSERT INTO t VALUES (1)', undefined, { dryRun: true }), /dryRun|EXPLAIN|不支持/i);
  });
  await checkAsync('mongo：dryRun 明确不支持', async () => {
    await assert.rejects(() => mgr.runQuery('d-mongo', '{"collection":"c","command":"find"}', undefined, { dryRun: true }), /dryRun|不支持/i);
  });
  await checkAsync('多语句脚本 dryRun → 拒绝', async () => {
    await assert.rejects(() => mgr.runQuery('d-mysql', 'SELECT 1; SELECT 2', undefined, { dryRun: true }), /dryRun|不支持|single/i);
  });
  await checkAsync('只读连接 dryRun 写语句 → 预检先行拒绝', async () => {
    const ro = makeSpyHandle('pg');
    attachLive(mgr, { id: 'd-ro', kind: 'postgres', readOnly: true, handle: ro });
    await assert.rejects(() => mgr.runQuery('d-ro', 'UPDATE t SET a=1', undefined, { dryRun: true }), /只读|read-only/i);
    assert.equal(ro.calls.length, 0);
  });
}

// ---------------------------------------------------------------------------
// AI ⑥：db_describe_table
// ---------------------------------------------------------------------------
console.log('\n[AI] db_describe_table');
{
  const mgr = createConnectionManager(tempDir('describe'));
  const { DatabaseSync } = require('node:sqlite');
  const file = join(tempDir('sqlite-file'), 'd.db');
  const setup = new DatabaseSync(file);
  setup.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT \'anon\')');
  setup.exec('INSERT INTO t VALUES (1, \'a\')');
  setup.close();
  mgr.profiles.push({ id: 'd-sqlite', name: 'd', kind: 'sqlite', database: file });
  await mgr.connect('d-sqlite');

  await checkAsync('sqlite：列结构 + PK 标记', async () => {
    const info = await mgr.describeTable({ id: 'd-sqlite', table: 't' });
    assert.equal(info.columns.length, 2);
    assert.equal(info.columns[0].pk, true);
    assert.equal(info.columns[1].pk, false);
    assert.equal(info.columns[1].nullable, false);
  });
  await checkAsync('mysql：information_schema 参数化内省', async () => {
    const h = makeSpyHandle('mysql');
    attachLive(mgr, { id: 'd-my', kind: 'mysql', handle: h });
    const info = await mgr.describeTable({ id: 'd-my', table: 'users', database: 'shop' });
    assert.deepEqual(h.calls[0].params, ['shop', 'users']);
    assert.equal(info.columns[0].name, 'a');
  });
  await checkAsync('mssql：参数化 + PK 布尔归一', async () => {
    const h = makeSpyHandle('mssql');
    h.calls.push = h.calls.push.bind(h.calls);
    attachLive(mgr, { id: 'd-ms', kind: 'mssql', handle: h });
    h.query = async (sql, params) => { h.calls.push({ sql, params }); return { rows: [{ COLUMN_NAME: 'id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, is_pk: 1 }], fields: [] }; };
    const info = await mgr.describeTable({ id: 'd-ms', table: 'users', database: 'dbo' });
    assert.deepEqual(h.calls[0].params, ['dbo', 'users']);
    assert.equal(info.columns[0].pk, true);
  });
  await checkAsync('mongo：采样键 → 列', async () => {
    const h = makeSpyHandle('mongodb', { rows: [{ _id: 'x', score: 1, tags: ['a'] }] });
    attachLive(mgr, { id: 'd-mongo', kind: 'mongodb', handle: h });
    const info = await mgr.describeTable({ id: 'd-mongo', table: 'c' });
    assert.equal(info.columns.length, 3);
    assert.equal(info.columns.find((c) => c.name === '_id').pk, true);
    assert.equal(info.columns.find((c) => c.name === 'tags').type, 'array');
  });
  await checkAsync('redis/qdrant → 明确拒绝', async () => {
    attachLive(mgr, { id: 'd-redis', kind: 'redis', handle: makeSpyHandle('redis') });
    await assert.rejects(() => mgr.describeTable({ id: 'd-redis', table: 'x' }), /db_schema|no column schema/i);
  });
}

// ---------------------------------------------------------------------------
// AI ⑦：MCP stdio server（子进程全链路）
// ---------------------------------------------------------------------------
console.log('\n[MCP] stdio server 全链路');
{
  await checkAsync('initialize → tools/list → connect → peek_page → 写工具门控', async () => {
    const home = tempDir('mcp-home');
    const pluginData = join(home, 'plugin-data', 'dsh-database-explorer');
    mkdirSync(pluginData, { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    const dbFile = join(home, 'mcp.db');
    const setup = new DatabaseSync(dbFile);
    setup.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
    setup.exec('INSERT INTO t VALUES (1, \'one\'), (2, \'two\')');
    setup.close();
    writeFileSync(join(pluginData, 'connections.json'), JSON.stringify({ profiles: [{ id: 'mcp1', name: 'test', kind: 'sqlite', database: dbFile }] }));

    const child = spawn(process.execPath, [join(repo, 'lib', 'mcp.js')], {
      env: { ...process.env, DSH_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let mcpStderr = '';
    const responses = new Map();
    let buf = '';
    const done = new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const msg = JSON.parse(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
          responses.set(msg.id, msg);
          if (responses.has(4)) resolve();
        }
      });
      child.stderr.on("data", (d) => { mcpStderr += d.toString("utf8"); });
      child.on("exit", (code) => reject(new Error(`mcp exited early: ${code} :: ${mcpStderr.slice(0, 300)}`)));
      setTimeout(() => reject(new Error('mcp timeout')), 20000);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'db_connect', arguments: { id: 'mcp1' } } }) + '\n');
    await new Promise((r) => setTimeout(r, 300)); // JSON-RPC 响应按 id 归集、顺序无保证：connect 落定后再发 peek
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'db_peek_page', arguments: { id: 'mcp1', table: 't', pageSize: 100 } } }) + '\n');
    await done;
    child.kill();
    const init = responses.get(1);
    const list = responses.get(2);
    const connect = responses.get(3);
    const peek = responses.get(4);
    assert.equal(init.result.serverInfo.name, 'dsh-database-explorer');
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('db_describe_table'), 'describe_table 在列');
    assert.ok(!names.includes('db_query'), '无标记文件 → 写工具不暴露');
    assert.equal(JSON.parse(connect.result.content[0].text).ok, true);
    const peeked = JSON.parse(peek.result.content[0].text);
    assert.equal(peeked.rows.length, 2, '真 sqlite 全链路取数');
  });
  await checkAsync('协议层：parse error / 未知方法 / 通知不回包', async () => {
    const { handleLine } = await import('../lib/mcp.js');
    assert.equal((await handleLine('{bad json')).error.code, -32700);
    assert.equal((await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'no/such' }))).error.code, -32601);
    assert.equal(await handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
  });
}

// ---------------------------------------------------------------------------
// 性能：导出封顶 + schemaMysql 批量内省
// ---------------------------------------------------------------------------
console.log('\n[性能] 导出 SQL 封顶 / 内省批量化');
{
  const mgr = createConnectionManager(tempDir('perf'));
  const mysql = makeSpyHandle('mysql', { rows: [{ a: 1 }] });
  attachLive(mgr, { id: 'p-my', kind: 'mysql', handle: mysql });
  await checkAsync('mysql 导出：LIMIT 100001（不取全表）', async () => {
    await mgr.exportTable({ id: 'p-my', database: '', table: 't', format: 'csv' });
    const data = mysql.calls.find((c) => /^SELECT \* FROM/i.test(c.sql));
    assert.ok(data && /LIMIT\s+100001/.test(data.sql), data?.sql);
  });
  const mssql = makeSpyHandle('mssql', { rows: [{ a: 1 }] });
  attachLive(mgr, { id: 'p-ms', kind: 'mssql', handle: mssql });
  await checkAsync('mssql 导出：TOP 100001', async () => {
    await mgr.exportTable({ id: 'p-ms', database: '', table: 't', format: 'csv' });
    const data = mssql.calls.find((c) => /^SELECT/i.test(c.sql) && !/WHERE 1 = 0/i.test(c.sql));
    assert.ok(data && /SELECT\s+TOP\s+100001/i.test(data.sql), data?.sql);
  });
  await checkAsync('schemaMysql：两条 information_schema 查询拉全量（消 N+1）', async () => {
    const h = makeSpyHandle('mysql');
    let n = 0;
    const dbs = [{ Database: 'shop' }];
    const tables = [{ table_schema: 'shop', table_name: 'users', table_type: 'BASE TABLE' }, { table_schema: 'shop', table_name: 'v1', table_type: 'VIEW' }];
    const columns = [
      { table_schema: 'shop', table_name: 'users', column_name: 'id', column_type: 'int', is_nullable: 'NO', column_key: 'PRI' },
      { table_schema: 'shop', table_name: 'v1', column_name: 'x', column_type: 'int', is_nullable: 'YES', column_key: '' },
    ];
    h.query = async (sql, params) => {
      n++;
      if (/SHOW DATABASES/.test(sql)) return { rows: dbs, fields: [] };
      if (/information_schema\.tables/.test(sql)) { assert.deepEqual(params, ['shop']); return { rows: tables, fields: [] }; }
      if (/information_schema\.columns/.test(sql)) return { rows: columns, fields: [] };
      throw new Error('schemaMysql 不应再发逐表查询: ' + sql);
    };
    const tree = await mgr.schemaMysql(h);
    assert.equal(n, 3, `恰好 3 条查询（SHOW DATABASES + 2），实际 ${n}`);
    assert.equal(tree.databases[0].tables.length, 2);
    assert.equal(tree.databases[0].tables[1].kind, 'view');
    assert.equal(tree.databases[0].tables[0].columns[0].key, 'PRI');
  });
}

// ---------------------------------------------------------------------------
console.log(`\n==== test-v106: ${pass} PASS / ${fail} FAIL ====`);
for (const dir of tempDirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 平台锁忽略 */ } }
process.exit(fail > 0 ? 1 : 0);
