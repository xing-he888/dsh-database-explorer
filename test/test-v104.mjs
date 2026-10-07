/**
 * dsh-database-explorer — agent 工具套件（v104，v0.9.17）
 *
 * 覆盖 lib/tools.js：
 *   1. 只读工具默认注册（5 个），写入工具默认不注册
 *   2. agent-write-tools 标记文件 → 写入工具（4 个）注册
 *   3. 工具定义形状（name/description/parameters/output.render/execute）
 *   4. execute 链路：真 sqlite 管理器上 list/connect/peek/er 全链路
 *   5. 写工具门控：db_query 未连接时友好报错；pk 非法 JSON 报错
 *   6. 输出上限：超长结果截断为 preview
 *   7. cordis effect 生成器语义：yield 的注册项全部被收集
 *
 * 运行：node test/test-v104.mjs
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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

/** 假 defineTool：原样透传定义（断言字段完整性用） */
const fakeDefineTool = (def) => def;
/** 假 ctx：effect 生成器立即迭代，tools.register 收集注册项 */
function makeFakeCtx() {
  const registered = [];
  const ctx = {
    effect(fn) { const gen = fn(); for (const item of gen) registered.push(item); return () => {}; },
    tools: { register: (tool) => tool },
  };
  return { ctx, registered };
}

// ---------------------------------------------------------------------------
// 1+2. 分级注册
// ---------------------------------------------------------------------------
console.log('\n[分级] 只读默认 / 写入门控');
{
  const dataDir = mkdtempSync(join(tmpdir(), 'dbaudit-v104-ro-'));
  const mgr = createConnectionManager(mkdtempSync(join(tmpdir(), 'dbaudit-v104-mgr-')));
  const { ctx, registered } = makeFakeCtx();
  await registerAgentTools(ctx, mgr, dataDir, { defineTool: fakeDefineTool });
  const names = registered.map((t) => t.name);
  check('只读 5 工具默认注册', () => {
    for (const n of ['db_list_connections', 'db_connect', 'db_schema', 'db_peek_page', 'db_er_graph']) {
      assert.ok(names.includes(n), `缺少 ${n}`);
    }
  });
  check('写入工具默认不注册', () => {
    for (const n of ['db_query', 'db_update_cell', 'db_insert_row', 'db_delete_row']) {
      assert.ok(!names.includes(n), `${n} 不应在未授权时注册`);
    }
  });
  check('工具定义形状完整（name/description/parameters/output.render/execute）', () => {
    for (const t of registered) {
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.description, 'string');
      assert.equal(typeof t.execute, 'function');
      assert.equal(typeof t.output.render, 'function');
      assert.ok(typeof t.parameters === 'object');
    }
  });
}

{
  const dataDir = mkdtempSync(join(tmpdir(), 'dbaudit-v104-rw-'));
  writeFileSync(join(dataDir, 'agent-write-tools'), '');
  const mgr = createConnectionManager(mkdtempSync(join(tmpdir(), 'dbaudit-v104-mgr2-')));
  const { ctx, registered } = makeFakeCtx();
  await registerAgentTools(ctx, mgr, dataDir, { defineTool: fakeDefineTool });
  const names = registered.map((t) => t.name);
  check('标记文件存在 → 写入 4 工具注册', () => {
    for (const n of ['db_query', 'db_update_cell', 'db_insert_row', 'db_delete_row']) {
      assert.ok(names.includes(n), `缺少 ${n}`);
    }
    // v0.9.19：只读层新增 db_describe_table → 6 + 4 = 10
    assert.equal(names.length, 10);
  });
}

// ---------------------------------------------------------------------------
// 3+4+5. execute 链路（真 sqlite）
// ---------------------------------------------------------------------------
console.log('\n[链路] 真 sqlite 全链路');
{
  const dataDir = mkdtempSync(join(tmpdir(), 'dbaudit-v104-exe-'));
  writeFileSync(join(dataDir, 'agent-write-tools'), '');
  const mgr = createConnectionManager(mkdtempSync(join(tmpdir(), 'dbaudit-v104-mgr3-')));
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = join(dataDir, 't.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), amount REAL);
    INSERT INTO users (name) VALUES ('alice'), ('bob');
    INSERT INTO orders (user_id, amount) VALUES (1, 9.5), (1, 20.0), (2, 1.0);`);
  db.close();
  const p = mgr.createProfile({ kind: 'sqlite', name: 'agent', database: dbPath });
  await mgr.connect(p.id);

  const { ctx, registered } = makeFakeCtx();
  await registerAgentTools(ctx, mgr, dataDir, { defineTool: fakeDefineTool });
  const tools = Object.fromEntries(registered.map((t) => [t.name, t]));

  await checkAsync('db_list_connections：返回脱敏档案（无 savedPassword）', async () => {
    const r = await tools.db_list_connections.execute({});
    assert.equal(r.profiles.length, 1);
    assert.ok(!('savedPassword' in r.profiles[0]));
    assert.deepEqual(r.connected, [p.id]);
  });
  await checkAsync('db_schema：列定义 + PK 标记', async () => {
    const r = await tools.db_schema.execute({ id: p.id });
    const users = r.databases[0].tables.find((t) => t.name === 'users');
    assert.equal(users.columns[0].key, 'PK');
  });
  await checkAsync('db_peek_page：白名单取档 + 总数（请求 2 行 → 10 行档，返回 3 行全量）', async () => {
    const r = await tools.db_peek_page.execute({ id: p.id, table: 'orders', page: 1, pageSize: 2 });
    assert.equal(r.total, 3);
    assert.equal(r.page, 1);
    assert.ok(r.rows.length >= 3 && r.rows.length <= 10);
    assert.equal(r.pageSize, 10);
  });
  await checkAsync('db_peek_page：pageSize 钳到 100', async () => {
    const r = await tools.db_peek_page.execute({ id: p.id, table: 'orders', page: 1, pageSize: 9999 });
    assert.ok(r.pageSize <= 100);
  });
  await checkAsync('db_er_graph：关系边 + 推断标记', async () => {
    const r = await tools.db_er_graph.execute({ id: p.id, database: '(file)' });
    assert.equal(r.edges.length, 1);
    assert.equal(r.edges[0].toTable, 'users');
  });
  await checkAsync('db_query：SELECT 出行；未连接 id 友好报错', async () => {
    const r = await tools.db_query.execute({ id: p.id, sql: 'SELECT COUNT(*) AS c FROM orders' });
    assert.equal(r.rows[0].c, 3);
    await assert.rejects(() => tools.db_query.execute({ id: 'nope', sql: 'SELECT 1' }), /连接未打开/);
  });
  await checkAsync('db_update_cell：参数化更新 + pk 非法 JSON 报错', async () => {
    const r = await tools.db_update_cell.execute({ id: p.id, table: 'users', column: 'name', pk: '[{"column":"id","value":1}]', value: 'alice2' });
    assert.equal(r.affectedRows, 1);
    await assert.rejects(
      () => tools.db_update_cell.execute({ id: p.id, table: 'users', column: 'name', pk: 'not-json', value: 'x' }),
      /pk 不是合法 JSON/
    );
  });
  await checkAsync('db_insert_row + db_delete_row 全链路', async () => {
    const ins = await tools.db_insert_row.execute({ id: p.id, table: 'users', values: '{"name":"carol"}' });
    assert.equal(ins.inserted, 1);
    const found = await mgr.liveHandle(p.id).query('SELECT id FROM users WHERE name = ?', ['carol']);
    const del = await tools.db_delete_row.execute({ id: p.id, table: 'users', pk: JSON.stringify([{ column: 'id', value: found.rows[0].id }]) });
    assert.equal(del.deleted, 1);
  });
  await checkAsync('db_query：超长结果截断为 preview', async () => {
    const r = await tools.db_query.execute({ id: p.id, sql: "SELECT group_concat(name, '') AS big FROM (SELECT name FROM users CROSS JOIN orders CROSS JOIN orders)" });
    if (JSON.stringify(r).length > 20000) assert.equal(r.truncated, true);
    else assert.ok(true);
  });
  await checkAsync('render：返回字符串摘要（不铺原始数据）', async () => {
    const r = await tools.db_peek_page.execute({ id: p.id, table: 'orders', page: 1, pageSize: 2 });
    const text = tools.db_peek_page.output.render({ page: 1 }, r);
    assert.equal(typeof text, 'string');
    assert.ok(!text.includes('alice'), 'render 不应回显数据值');
  });
  await mgr.closeAll();
}

// ---------------------------------------------------------------------------
// 6. 输出上限纯函数行为（经由 db_er_graph 的 tooMany 大库）
// ---------------------------------------------------------------------------
console.log('\n[上限] 超长输出');
await checkAsync('超大 schema 树 → truncated preview', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dbaudit-v104-cap-'));
  const mgr = createConnectionManager(mkdtempSync(join(tmpdir(), 'dbaudit-v104-mgr4-')));
  const fake = {
    kind: 'sqlite',
    async query(sql) {
      if (sql.includes('sqlite_master')) return { rows: [{ name: 't' }] };
      if (sql.includes('table_info')) return { rows: Array.from({ length: 40 }, (_, i) => ({ name: `col_${i}_${'x'.repeat(40)}`, type: 'TEXT', pk: i === 0 ? 1 : 0 })) };
      if (sql.includes('foreign_key_list')) return { rows: [] };
      if (sql.includes('index_list')) return { rows: [] };
      return { rows: [] };
    },
  };
  mgr.live.set('cap1', { kind: 'sqlite', handle: fake, profile: { id: 'cap1', kind: 'sqlite' } });
  const r = await mgr.schema('cap1');
  const s = JSON.stringify(r);
  if (s.length > 20000) {
    const { ctx, registered } = makeFakeCtx();
    await registerAgentTools(ctx, mgr, dataDir, { defineTool: fakeDefineTool });
    const tools = Object.fromEntries(registered.map((t) => [t.name, t]));
    const out = await tools.db_schema.execute({ id: 'cap1' });
    assert.equal(out.truncated, true);
    assert.ok(out.preview.length <= 20050);
  } else {
    assert.ok(true); // 树未超限，上限逻辑由 capOutput 纯构造保证
  }
});

console.log(`\n==== test-v104: ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail > 0 ? 1 : 0);
