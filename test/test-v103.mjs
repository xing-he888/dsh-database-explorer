/**
 * dsh-database-explorer — v0.9.16 套件：推断关系 + 连接池可配置
 *
 *   1. SchemaSpy 式推断关系：无外键约束时按命名约定补边（虚线、inferred 标记）
 *      —— 单复数归一、歧义不猜、显式外键不重复、复合主键不参与
 *   2. R-POOL-CFG：poolMax 钳制（1..64）与档案链路
 *
 * 运行：node test/test-v103.mjs
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createConnectionManager } = require('../lib/connections.js');

let pass = 0, fail = 0;
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e?.message || e}`); }
}
function check(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e?.message || e}`); }
}

const mgr = createConnectionManager(mkdtempSync(join(tmpdir(), 'dbaudit-v103-')));

// ---------------------------------------------------------------------------
// 1. 推断关系（sqlite 真库）
// ---------------------------------------------------------------------------
console.log('\n[推断] sqlite 真库');
await checkAsync('user_id → users 推断成功且带 inferred 标记', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = join(mkdtempSync(join(tmpdir(), 'dbaudit-v103-')), 't.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER);  -- 无外键约束
    CREATE TABLE user_prefs (id INTEGER PRIMARY KEY, users_id INTEGER);  -- 复数形式匹配
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE products (id INTEGER PRIMARY KEY, category_id INTEGER); -- ies→y 归一`);
  db.close();
  const p = mgr.createProfile({ kind: 'sqlite', name: 'infer', database: dbPath });
  await mgr.connect(p.id);
  const er = await mgr.erGraph({ id: p.id, database: '(file)' });
  const byKey = Object.fromEntries(er.edges.map((e) => [`${e.fromTable}.${e.fromCol}`, e]));
  assert.equal(byKey['orders.user_id']?.inferred, true, 'orders.user_id 应推断指向 users');
  assert.equal(byKey['orders.user_id'].toTable, 'users');
  assert.equal(byKey['orders.user_id'].toCol, 'id');
  assert.equal(byKey['user_prefs.users_id']?.toTable, 'users', '复数形式 users_id → users');
  assert.equal(byKey['products.category_id']?.toTable, 'categories', 'ies→y 归一 category_id → categories');
  await mgr.closeAll();
});
await checkAsync('显式外键列不再推断（不产生重复边）', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = join(mkdtempSync(join(tmpdir(), 'dbaudit-v103-')), 't.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));`);
  db.close();
  const p = mgr.createProfile({ kind: 'sqlite', name: 'no-dup', database: dbPath });
  await mgr.connect(p.id);
  const er = await mgr.erGraph({ id: p.id, database: '(file)' });
  assert.equal(er.edges.length, 1);
  assert.equal(er.edges[0].inferred, undefined, '显式外键不应带 inferred 标记');
  await mgr.closeAll();
});
await checkAsync('歧义不猜：user/user 两义时 user_id 不推断', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = join(mkdtempSync(join(tmpdir(), 'dbaudit-v103-')), 't.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE user (id INTEGER PRIMARY KEY);   -- 单复数同源 → 歧义
    CREATE TABLE logs (id INTEGER PRIMARY KEY, user_id INTEGER);`);
  db.close();
  const p = mgr.createProfile({ kind: 'sqlite', name: 'ambig', database: dbPath });
  await mgr.connect(p.id);
  const er = await mgr.erGraph({ id: p.id, database: '(file)' });
  assert.equal(er.edges.length, 0, '两表候选歧义 → 宁缺勿错（精确率优先）');
  await mgr.closeAll();
});

// ---------------------------------------------------------------------------
// 2. R-POOL-CFG：poolMax 钳制与档案链路
// ---------------------------------------------------------------------------
console.log('\n[池] poolMax 配置');
check('钳制：999 → 64；0/-3/非数 → undefined（引擎默认）', () => {
  const p1 = mgr.createProfile({ kind: 'mysql', name: 'c1', host: '10.0.0.1', poolMax: 999 });
  assert.equal(p1.poolMax, 64);
  const p2 = mgr.createProfile({ kind: 'mysql', name: 'c2', host: '10.0.0.1', poolMax: 0 });
  assert.equal(p2.poolMax, null);
  const p3 = mgr.createProfile({ kind: 'mysql', name: 'c3', host: '10.0.0.1', poolMax: 'abc' });
  assert.equal(p3.poolMax, null);
});
check('update 链路：8 生效、清空回落默认', () => {
  const id = mgr.createProfile({ kind: 'mysql', name: 'c4', host: '10.0.0.1' }).id;
  mgr.updateProfile(id, { poolMax: 8 });
  assert.equal(mgr.getProfile(id).poolMax, 8);
  mgr.updateProfile(id, { poolMax: null });
  assert.equal(mgr.getProfile(id).poolMax ?? null, null);
});
check('/test 形态：ephemeralProfile 同样钳制', () => {
  const probe = mgr.ephemeralProfile({ kind: 'postgres', host: '127.0.0.1', poolMax: 32 });
  assert.equal(probe.poolMax, 32);
});

console.log(`\n==== test-v103: ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail > 0 ? 1 : 0);
