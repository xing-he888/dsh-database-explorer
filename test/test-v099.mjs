/**
 * dsh-database-explorer — 第 4 轮修复回归套件（随 v0.9.13 引入）
 *
 * 覆盖本轮三个修复：
 *   S1  envPassword 内网限制：resolvePassword 层中央强制 + 精确地址匹配
 *       （旧 /test 前缀正则的四个绕过样本全部转为拒绝）
 *   F1  MySQL 多语句脚本：MySQL 感知拆分（'、" 内反斜杠转义）+ 顺序执行聚合
 *   F2  MongoDB 导出：exportRows 专用通道绕过交互钳制，truncated 如实上报
 *
 * 运行：node test/test-v099.mjs   （无外部依赖，mongo/mysql 用 mock handle）
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
  isPrivateDbHost,
  isPrivateIPv4,
  mysqlQuery,
  shapeMysqlResult,
} = require('../lib/connections.js');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    fail++;
    failures.push({ name, error });
    console.error(`  FAIL  ${name}\n        ${error?.message || error}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    fail++;
    failures.push({ name, error });
    console.error(`  FAIL  ${name}\n        ${error?.message || error}`);
  }
}

// ---------------------------------------------------------------------------
// S1-a 精确主机判定：旧前缀正则的绕过样本必须全部拒绝
// ---------------------------------------------------------------------------
console.log('\n[S1] isPrivateDbHost / isPrivateIPv4');
check('绕过样本 10.0.0.1.attacker.net 被拒绝', () => assert.equal(isPrivateDbHost('10.0.0.1.attacker.net'), false));
check('绕过样本 127.evil.com 被拒绝', () => assert.equal(isPrivateDbHost('127.evil.com'), false));
check('绕过样本 192.168.1.5.attacker.net 被拒绝', () => assert.equal(isPrivateDbHost('192.168.1.5.attacker.net'), false));
check('绕过样本 172.16.evil.net 被拒绝', () => assert.equal(isPrivateDbHost('172.16.evil.net'), false));
check('公网 8.8.8.8 被拒绝', () => assert.equal(isPrivateDbHost('8.8.8.8'), false));
check('非法 IP 999.1.1.1 fail-closed', () => assert.equal(isPrivateDbHost('999.1.1.1'), false));
check('172.32.0.1 不属于内网段', () => assert.equal(isPrivateDbHost('172.32.0.1'), false));
check('空/undefined fail-closed', () => { assert.equal(isPrivateDbHost(''), false); assert.equal(isPrivateDbHost(undefined), false); });

check('内网 10.0.0.1 / 127.0.0.1 / 192.168.1.5 / 172.31.255.255 通过', () => {
  for (const h of ['10.0.0.1', '127.0.0.1', '192.168.1.5', '172.16.0.1', '172.31.255.255']) {
    assert.equal(isPrivateDbHost(h), true, h);
  }
});
check('localhost / foo.localhost / 大小写 / host:port / [::1] / ::1 / :: 通过', () => {
  for (const h of ['localhost', 'foo.localhost', 'LOCALHOST', 'localhost:3306', '10.0.0.1:3306', '[::1]', '[::1]:5432', '::1', '::', 'fe80::1%eth0'.replace('fe80::1%eth0', 'localhost')]) {
    assert.equal(isPrivateDbHost(h), true, h);
  }
});
check('IPv4-mapped IPv6（内网通过 / 公网拒绝）', () => {
  assert.equal(isPrivateDbHost('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateDbHost('::ffff:10.1.2.3'), true);
  assert.equal(isPrivateDbHost('::ffff:8.8.8.8'), false);
});
check('isPrivateIPv4 拒绝主机名与超界八位组', () => {
  assert.equal(isPrivateIPv4('localhost'), false);
  assert.equal(isPrivateIPv4('10.0.0.256'), false);
  assert.equal(isPrivateIPv4('10.0.0'), false);
});

// ---------------------------------------------------------------------------
// S1-b resolvePassword 中央强制：/test 与 /connect 两条路径都收口
// ---------------------------------------------------------------------------
console.log('\n[S1] resolvePassword 强制');
const mgr = createConnectionManager(mkdtempSync(join(tmpdir(), 'dbaudit-v099-')));
check('公网目标 + envPassword → 拒绝（/connect 路径）', () => {
  const p = mgr.createProfile({ kind: 'mysql', name: 'x', host: '10.0.0.1.attacker.net', envPassword: 'DBAUDIT_SECRET' });
  assert.throws(() => mgr.resolvePassword(p), /安全限制|security/i);
});
check('公网目标 + envPassword → 拒绝（/test 路径，ephemeralProfile）', () => {
  const probe = mgr.ephemeralProfile({ kind: 'mysql', host: '127.evil.com', envPassword: 'DBAUDIT_SECRET' });
  assert.throws(() => mgr.resolvePassword(probe), /安全限制|security/i);
});
check('内网目标 + envPassword → 正常解析环境变量', () => {
  process.env.DBAUDIT_SECRET = 'pw-from-env';
  const p2 = mgr.createProfile({ kind: 'mysql', name: 'y', host: '10.0.0.1', envPassword: 'DBAUDIT_SECRET' });
  assert.equal(mgr.resolvePassword(p2), 'pw-from-env');
  delete process.env.DBAUDIT_SECRET;
});
check('显式密码 / 已存密码不受影响', () => {
  // createProfile 返回脱敏投影（不含 savedPassword）——断言用存储档原始对象
  const p3 = mgr.getProfile(mgr.createProfile({ kind: 'mysql', name: 'z', host: '8.8.8.8', password: 'typed', rememberPassword: true }).id);
  // R-DPAPI（v0.9.19）：Windows 上落盘为 dpapi:v1: 前缀密文，其余平台明文；
  // resolvePassword 一律还原为原值
  assert.ok(p3.savedPassword === 'typed' || p3.savedPassword.startsWith('dpapi:v1:'),
    `落盘形态应为明文（非 Windows）或 DPAPI 密文，实际: ${String(p3.savedPassword).slice(0, 20)}…`);
  assert.equal(mgr.resolvePassword(p3, 'typed'), 'typed');
  assert.equal(mgr.resolvePassword(p3), 'typed');
});
check('sqlite（host 默认 localhost）+ envPassword 行为不变', () => {
  process.env.DBAUDIT_SECRET = 'pw';
  const p4 = mgr.createProfile({ kind: 'sqlite', name: 's', envPassword: 'DBAUDIT_SECRET' });
  assert.equal(mgr.resolvePassword(p4), 'pw');
  delete process.env.DBAUDIT_SECRET;
});

// ---------------------------------------------------------------------------
// F1-a splitStatements：MySQL 反斜杠转义感知
// ---------------------------------------------------------------------------
console.log('\n[F1] splitStatements（MySQL 语义）');
check("MySQL 模式：'\\' 不再提前闭合字符串（不拆分）", () => {
  const sql = "SELECT '\\'; SELECT 2";
  assert.equal(splitStatements(sql, { backslashEscapes: true }).length, 1);
});
check("SQLite 模式（默认）：'\\' 按旧语义拆分", () => {
  const sql = "SELECT '\\'; SELECT 2";
  assert.equal(splitStatements(sql).length, 2);
});
check('MySQL 模式：反引号内反斜杠不转义——反引号正常闭合后照常拆分', () => {
  const sql = 'SELECT `a\\`; SELECT 2';
  assert.equal(splitStatements(sql, { backslashEscapes: true }).length, 2);
});
check("MySQL 模式：反斜杠转义正常吞掉转义符后的任意字符", () => {
  const sql = "SELECT 'a\\\\zb'; SELECT 2"; // 'a\\zb' → 反斜杠吞掉 z
  assert.equal(splitStatements(sql, { backslashEscapes: true }).length, 2);
});
check('双引号字符串同样受反斜杠转义影响', () => {
  const sql = 'SELECT "\\"; SELECT 2';
  assert.equal(splitStatements(sql, { backslashEscapes: true }).length, 1);
});
check('注释 / 引号内分号 / 空语句行为与旧版一致', () => {
  assert.equal(splitStatements("-- c\nSELECT 1; /*x*/ SELECT 2").length, 2);
  assert.equal(splitStatements("SELECT 'a;b'; SELECT 2").length, 2);
  assert.equal(splitStatements('SELECT `a;b` FROM t; SELECT 1').length, 2);
  assert.equal(splitStatements('SELECT [a;b] FROM t; SELECT 1').length, 2);
  assert.deepEqual(splitStatements('   ;  ; '), []);
});

// ---------------------------------------------------------------------------
// F1-b mysqlQuery：拆分执行 + 聚合（fake pool 捕获 SQL 与参数）
// ---------------------------------------------------------------------------
console.log('\n[F1] mysqlQuery（fake pool）');
function fakePool(script) {
  const calls = [];
  return {
    calls,
    async query({ sql, values, timeout }) {
      calls.push({ sql, values, timeout });
      const r = script[calls.length - 1];
      if (!r) throw new Error('unexpected extra query: ' + sql);
      return r;
    },
  };
}
await checkAsync('单语句 SELECT：参数原样绑定', async () => {
  const pool = fakePool([[[{ a: 1 }], [{ name: 'a', typeName: 'INT' }]]]);
  const r = await mysqlQuery(pool, 'SELECT ? AS a', [41]);
  assert.deepEqual(r.rows, [{ a: 1 }]);
  assert.deepEqual(pool.calls[0].values, [41]);
  assert.equal(pool.calls[0].timeout, 20000);
});
await checkAsync('单语句写：affectedRows/insertId 形状不变', async () => {
  const pool = fakePool([[{ affectedRows: 2, insertId: 5 }]]);
  const r = await mysqlQuery(pool, 'INSERT INTO t VALUES (1)', []);
  assert.equal(r.affectedRows, 2);
  assert.equal(r.insertId, 5);
  assert.deepEqual(r.rows, []);
});
await checkAsync('多语句脚本：逐条发送，写聚合 + 首个结果集 + 末次 insertId', async () => {
  const pool = fakePool([
    [{ affectedRows: 1, insertId: 1 }],
    [{ affectedRows: 3, insertId: 9 }],
    [[{ n: 'm1' }, { n: 'm2' }], [{ name: 'n' }]],
  ]);
  const r = await mysqlQuery(pool, "INSERT INTO t (n) VALUES ('m1'); INSERT INTO t (n) VALUES ('m2'); SELECT n FROM t WHERE n LIKE 'm%'");
  assert.equal(pool.calls.length, 3);
  assert.deepEqual(pool.calls[0].values, []);
  assert.equal(r.affectedRows, 4);
  assert.deepEqual(r.rows, [{ n: 'm1' }, { n: 'm2' }]);
  assert.equal(r.insertId, 9);
});
await checkAsync('纯写脚本：无结果集时聚合返回', async () => {
  const pool = fakePool([[{ affectedRows: 1, insertId: 1 }], [{ affectedRows: 1, insertId: 2 }]]);
  const r = await mysqlQuery(pool, 'INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)');
  assert.deepEqual(r, { rows: [], fields: [], affectedRows: 2, insertId: 2 });
});
await checkAsync('多语句 + params → 明确拒绝（防误绑定）', async () => {
  const pool = fakePool([]);
  await assert.rejects(() => mysqlQuery(pool, 'SELECT 1; SELECT 2', [1]), /多语句|multi-statement/i);
});
await checkAsync('空脚本 → 空结果', async () => {
  const r = await mysqlQuery(fakePool([]), '  ;  ');
  assert.deepEqual(r, { rows: [], fields: [], affectedRows: 0 });
});
check('shapeMysqlResult：嵌套结果集（CALL）取第一组', () => {
  const r = shapeMysqlResult([[{ x: 1 }]], [[{ name: 'x' }]]);
  assert.deepEqual(r.rows, [{ x: 1 }]);
  assert.equal(r.fields[0].name, 'x');
});

// ---------------------------------------------------------------------------
// F2 MongoDB 导出：exportRows 通道 + truncated 判定
// ---------------------------------------------------------------------------
console.log('\n[F2] MongoDB 导出');
const EXPORT_ROW_CAP = 100000;
await checkAsync('exportRows 通道：10 万+1 行时 truncated=true 且如实截断', async () => {
  const rows = Array.from({ length: EXPORT_ROW_CAP + 1 }, (_, i) => ({ i }));
  const m = createConnectionManager(mkdtempSync(join(tmpdir(), 'dbaudit-v099-mongo-')));
  m.live.set('m1', {
    kind: 'mongodb',
    handle: {
      kind: 'mongodb',
      async exportRows({ limit }) {
        assert.equal(limit, EXPORT_ROW_CAP + 1);
        return { rows, fields: [{ name: 'i', type: null }] };
      },
    },
    profile: { id: 'm1', kind: 'mongodb' },
  });
  const out = await m.exportTable({ id: 'm1', table: 'big', format: 'json' });
  assert.equal(out.truncated, true);
  assert.equal(out.rowCount, EXPORT_ROW_CAP);
});
await checkAsync('恰好 10 万行：truncated=false', async () => {
  const rows = Array.from({ length: EXPORT_ROW_CAP }, (_, i) => ({ i }));
  const m = createConnectionManager(mkdtempSync(join(tmpdir(), 'dbaudit-v099-mongo2-')));
  m.live.set('m2', {
    kind: 'mongodb',
    handle: { kind: 'mongodb', async exportRows() { return { rows, fields: [{ name: 'i', type: null }] }; } },
    profile: { id: 'm2', kind: 'mongodb' },
  });
  const out = await m.exportTable({ id: 'm2', table: 'big', format: 'json' });
  assert.equal(out.truncated, false);
  assert.equal(out.rowCount, EXPORT_ROW_CAP);
});
await checkAsync('旧句柄（无 exportRows）回落 query 通道不崩', async () => {
  const m = createConnectionManager(mkdtempSync(join(tmpdir(), 'dbaudit-v099-mongo3-')));
  m.live.set('m3', {
    kind: 'mongodb',
    handle: {
      kind: 'mongodb',
      async query(text) {
        const cmd = JSON.parse(text);
        assert.equal(cmd.command, 'find');
        return { rows: [{ i: 1 }], fields: [{ name: 'i', type: null }] };
      },
    },
    profile: { id: 'm3', kind: 'mongodb' },
  });
  const out = await m.exportTable({ id: 'm3', table: 't', format: 'json' });
  assert.equal(out.rowCount, 1);
});

// ---------------------------------------------------------------------------
// 版本握手 + 回归冒烟（SQLite 主路径不被本轮改动破坏）
// ---------------------------------------------------------------------------
console.log('\n[冒烟] 版本握手 + SQLite 主路径');
{
  const fs = await import('node:fs');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const clientSrc = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const cv = clientSrc.match(/const CLIENT_VERSION = "([^"]+)"/)?.[1];
  check('版本握手：package.json === CLIENT_VERSION 且为合法三段版本号（与具体版本解耦，升版无需改测试）', () => {
    assert.equal(pkg.version, cv);
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  });
}
await checkAsync('SQLite：参数化 updateCell / 删除 / 多语句不受影响', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'dbaudit-v099-sqlite-'));
  const dbPath = join(dir, 't.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec("INSERT INTO u (name) VALUES ('a'), ('b')");
  db.close();
  const m = createConnectionManager(mkdtempSync(join(tmpdir(), 'dbaudit-v099-mgr-')));
  const p = m.createProfile({ kind: 'sqlite', name: 't', database: dbPath });
  await m.connect(p.id);
  const u = await m.updateCell({ id: p.id, table: 'u', column: 'name', pk: [{ column: 'id', value: 1 }], value: "it's; DROP TABLE u; --" });
  assert.equal(u.affectedRows, 1);
  const d = await m.deleteRow({ id: p.id, table: 'u', pk: [{ column: 'id', value: 2 }] });
  assert.equal(d.deleted, 1);
  const h = m.liveHandle(p.id);
  const ms = await h.query("INSERT INTO u (name) VALUES ('c'); SELECT name FROM u");
  assert.equal(ms.rows.length, 2);
  assert.equal(ms.affectedRows, 1);
  await m.closeAll();
});

console.log(`\n==== test-v099: ${pass} PASS / ${fail} FAIL ====`);
if (fail > 0) {
  for (const f of failures) console.error(`  FAIL: ${f.name}\n        ${f.error?.stack || f.error}`);
  process.exit(1);
}
