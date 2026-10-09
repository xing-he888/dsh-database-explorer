/**
 * dsh-database-explorer — v0.9.22 套件（test-v107）
 *
 * 覆盖 R-DROP-CRASH（P0，2026-10-08 事故）：
 *   lib/index.js 的 /dsh-database/api/designer/drop-table 路由把 async 的
 *   manager.dropTable() 的 promise 丢在了链外（sendJson 同步 200 + 空对象），
 *   确认名输错时拒绝成为 unhandledRejection，被宿主 dsh-app-boot 的 onRejection
 *   按 fatal load failure 处理，整个 Desktop 进程退出（crash-2026-10-08T14-57-17）。
 *
 *   修复后契约（HTTP 层）：
 *     ① confirm 错 → HTTP 400 + JSON error，表完好，进程不崩；
 *     ② confirm 对 → HTTP 200，表删除，审计入账；
 *     ③ async 内省路由（schema/er/describe）失败同样 400，不产生 unhandledRejection。
 *
 * 全部走真 HTTP（node:http 客户端 → 路由 handler → 真 SQLite），unhandledRejection
 * 在测试进程里默认就是崩溃，所以「测试活着走完」本身就是断言的一部分。
 *
 * 运行：node test/test-v107.mjs
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);
const repo = dirname(require.resolve('../package.json'));
// 隔离：apply() 按 DSH_HOME 解析数据目录。测试进程绝不能碰真实的 ~/.dsh。
process.env.DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.includes(process.pid)
  ? process.env.DSH_HOME
  : mkdtempSync(join(tmpdir(), `dsh107-home-${process.pid}-`));
const { apply } = require(join(repo, 'lib', 'index.js'));
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e?.stack || e?.message || e}`); }
}

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `drop-crash-v107-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 假 webServer + 最小 cordis ctx：只复刻 route() 依赖的两个行为
// （register 收集 handler；disposer 数组在 teardown 时逐个调用）
// ---------------------------------------------------------------------------
function makeHarness(dataDir) {
  const handlers = new Map();
  const disposers = [];
  const ctx = {
    effect(fn, _label) {
      const maybe = fn();
      if (typeof maybe === 'function') disposers.push(maybe);
    },
    inject(_deps, cb) {
      // 插件签名：ctx.inject(['webServer'], (hostCtx) => {...})
      cb({
        webServer: {
          register(definition) {
            handlers.set(definition.path, definition.handler);
            // 宿主 register 返回反注册函数；插件把它收进 disposers 数组，
            // teardown 时逐个调用——假的也要返回函数。
            return () => handlers.delete(definition.path);
          },
        },
      });
    },
  };
  apply(ctx);
  async function call(path, { method = 'GET', body } = {}) {
    const chunks = [];
    const req = {
      method,
      url: path,
      headers: { host: '127.0.0.1:19387' }, // Host 允许名单内；无 Origin = 非浏览器客户端
    };
    const res = {
      statusCode: 0,
      headers: null,
      body: '',
      ended: false,
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
      end(payload) { if (payload) this.body += String(payload); this.ended = true; },
      destroy() { this.ended = true; /* 假 socket：no-op */ },
    };
    if (body !== undefined) {
      const text = JSON.stringify(body);
      req[Symbol.asyncIterator] = async function* () {
        yield Buffer.from(text, 'utf8');
      };
    }
    await handlers.get(path.split('?')[0])(req, res);
    // POST 路由在 readJsonBody().then() 里异步收尾，handler 同步返回时响应
    // 还没写——轮询到 end/destroy 为止（真 SQLite I/O 毫秒级，5s 是天顶）。
    for (let i = 0; !res.ended && i < 5000; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    let json = null;
    try { json = JSON.parse(res.body); } catch { /* 非 JSON 响应 */ }
    return { status: res.statusCode, json, raw: res.body };
  }
  return { call, dispose: () => { for (const d of disposers) d(); }, handlers };
}

// ---------------------------------------------------------------------------
// 真 SQLite 夹具：建库 → 连接 → 路由层操作
// ---------------------------------------------------------------------------
async function makeConnection(home, tableName) {
  const dbFile = join(home, 'db.sqlite');
  const setup = new DatabaseSync(dbFile);
  setup.exec(`CREATE TABLE ${tableName}(id INTEGER PRIMARY KEY, v TEXT)`);
  setup.exec(`INSERT INTO ${tableName} VALUES (1, 'x')`);
  setup.close();

  const harness = makeHarness(home);
  const created = await harness.call('/dsh-database/api/profiles', {
    method: 'POST',
    body: { kind: 'sqlite', name: 's', database: dbFile },
  });
  assert.equal(created.status, 200, `profile 创建应成功：${created.raw}`);
  const pid = created.json.profile.id;
  const connected = await harness.call('/dsh-database/api/connect', {
    method: 'POST',
    body: { id: pid },
  });
  assert.equal(connected.status, 200, `connect 应成功：${connected.raw}`);
  return { harness, pid };
}


function tableExists(dbFile, table) {
  const db = new DatabaseSync(dbFile);
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(table).length > 0;
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// ① R-DROP-CRASH 主断言：confirm 错 → 400 + 表完好 + 不崩
// ---------------------------------------------------------------------------
await checkAsync('R-DROP-CRASH：错误确认名 → 400 + 无 unhandledRejection + 表完好 + 入账', async () => {
  const home = tempDir('wrong-confirm');
  const dbFile = join(home, 'db.sqlite');
  const { harness, pid } = await makeConnection(home, 'survivor');

  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const r = await harness.call('/dsh-database/api/designer/drop-table', {
      method: 'POST',
      body: { id: pid, database: '', table: 'survivor', confirm: 'WRONG_NAME' },
    });
    assert.equal(r.status, 400, `错误确认名必须 400，实际 ${r.status} ${r.raw}`);
    assert.match(String(r.json?.error || ''), /确认名|confirmation/i, '错误信息必须可读');
    assert.equal(unhandled, null, `不允许出现 unhandledRejection（事故里它被宿主当 fatal load failure）：${unhandled?.stack || unhandled}`);
    assert.equal(tableExists(dbFile, 'survivor'), true, '表必须还在');
    const audit = await harness.call('/dsh-database/api/audit');
    assert.ok(audit.json?.entries?.some((e) => e.op === 'drop-table' && e.ok === false), '失败尝试必须入账');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    harness.dispose();
  }
});

// ---------------------------------------------------------------------------
// ② confirm 对 → 200 + 表删除 + 审计
// ---------------------------------------------------------------------------
await checkAsync('正向：正确确认名 → 200 + 表删除 + 成功入账', async () => {
  const home = tempDir('right-confirm');
  const dbFile = join(home, 'db.sqlite');
  const { harness, pid } = await makeConnection(home, 'doomed');

  try {
    const r = await harness.call('/dsh-database/api/designer/drop-table', {
      method: 'POST',
      body: { id: pid, database: '', table: 'doomed', confirm: 'doomed' },
    });
    assert.equal(r.status, 200, `正确确认名必须 200，实际 ${r.status} ${r.raw}`);
    assert.equal(r.json?.ok, true);
    assert.equal(tableExists(dbFile, 'doomed'), false, '表应已删除');
    const audit = await harness.call('/dsh-database/api/audit');
    assert.ok(audit.json?.entries?.some((e) => e.op === 'drop-table' && e.ok === true && e.table === 'doomed'), '成功删表必须入账');
  } finally {
    harness.dispose();
  }
});

// ---------------------------------------------------------------------------
// ③ 同类隐患回归：async 内省路由失败必须 400 而不是 unhandledRejection
// ---------------------------------------------------------------------------
await checkAsync('同类隐患：schema / er / describe 失败走 400，无 unhandledRejection', async () => {
  const home = tempDir('async-routes');
  const { harness } = await makeConnection(home, 't');

  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const schema = await harness.call('/dsh-database/api/schema?id=no-such-conn');
    assert.equal(schema.status, 400);
    const er = await harness.call('/dsh-database/api/er?id=no-such-conn');
    assert.equal(er.status, 400);
    const describe = await harness.call('/dsh-database/api/describe?id=no-such-conn&table=t');
    assert.equal(describe.status, 400);
    assert.equal(unhandled, null, `async 内省路由不允许 unhandledRejection：${unhandled?.stack || unhandled}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    harness.dispose();
  }
});

for (const dir of tempDirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 平台锁忽略 */ } }
console.log(`\n==== test-v107: ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
