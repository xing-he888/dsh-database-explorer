/**
 * dsh-database-explorer — 外部报告（probe2）复核套件（v101，缺陷锚定）
 *
 * 对外部复审报告指向 v0.9.12 的高危项逐条在【当前代码】上动态复现。
 * 每条断言锚定【当前缺陷行为】；修复时翻转为新期望（套件即变回归）。
 * 报告中的 S3（envPassword 绕过）= 本仓库第 4 轮 S1，已在 v0.9.13 修复，
 * 由 test-v099 覆盖，本套件不重复。
 *
 * 运行：node test/test-v101.mjs
 */

import { strict as assert } from 'node:assert';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openNoSqlHandle } = require('../lib/nosql.js');

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e?.message || e}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e?.message || e}`); }
}
/** 起一个临时端口上的 TCP/HTTP 服务，用完自动关。 */
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ---------------------------------------------------------------------------
// S5（P1 实证）：真实 Redis 的 +PONG 被解析成 {__t:'status'} 对象，
//              与字符串 'PONG' 比较恒不相等 → 真实 Redis 永远握手失败
// ---------------------------------------------------------------------------
console.log('\n[S5] Redis +PONG 握手');
await checkAsync('缺陷锚定：标准 +PONG 应答被判定为握手失败（修复后应连接成功并翻转）', async () => {
  const server = http.createServer();
  await new Promise((resolve) => { server.close(); resolve(); }); // 占位 no-op
  const raw = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.on('data', () => sock.write('+PONG\r\n')); // 对任何命令（含 PING）回标准 status
  });
  const port = await listen(raw);
  try {
    await openNoSqlHandle({ kind: 'redis', host: '127.0.0.1', port }, '');
    assert.fail('若此项 FAIL（没抛错），说明握手已修复——请翻转断言并更新登记册 R-REDIS-PONG');
  } catch (e) {
    assert.match(String(e?.message || e), /握手失败/);
    assert.match(String(e?.message || e), /__t/); // 证明是被解析成对象后误判
  } finally {
    raw.close();
  }
});

// ---------------------------------------------------------------------------
// S1（P0 实证，子进程）：Redis 端口误指向 HTTP 等 TCP 服务时，
//     RESP 解析异常在 socket.on('data') 内裸抛 → uncaught → 宿主进程退出
// ---------------------------------------------------------------------------
console.log('\n[S1] RESP 解析异常杀死宿主进程（子进程实测）');
{
  const victim = join(here, 'helpers', 'redis-victim.mjs');
  const garbage = net.createServer((sock) => {
    sock.on('error', () => {}); // victim 进程崩溃会 RST 掉这条 socket，别让测试脚手架跟着死
    sock.on('data', () => sock.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'));
  });
  const port = await listen(garbage);
  const r = spawn(process.execPath, [victim, 'connect', String(port)], { timeout: 15000 });
  const [code, stderr] = await new Promise((resolve) => {
    let err = '';
    r.stderr.on('data', (c) => { err += c; });
    r.on('close', (c) => resolve([c, err]));
  });
  garbage.close();
  check('缺陷锚定：把 HTTP 服务当 Redis 连 → 进程非零退出（修复后应存活并 reject）', () => {
    assert.notEqual(code, 0, '若此项 FAIL（exit=0），说明崩溃已修复——请翻转断言');
  });
  check('缺陷锚定：退出原因是 RESP 协议错误的未捕获异常', () => {
    assert.match(stderr, /RESP 协议错误/);
  });
}

// ---------------------------------------------------------------------------
// S2（P0 实证，子进程）：RESP '*' 分支递归无深度上限 → 栈溢出 fatal
// ---------------------------------------------------------------------------
console.log('\n[S2] RESP 递归栈溢出（子进程实测）');
{
  const victim = join(here, 'helpers', 'redis-victim.mjs');
  const deep = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.on('data', () => sock.write(Buffer.from('*1\r\n'.repeat(200000))));
  });
  const port = await listen(deep);
  const r = spawn(process.execPath, [victim, 'connect', String(port)], { timeout: 15000 });
  const [code, stderr] = await new Promise((resolve) => {
    let err = '';
    r.stderr.on('data', (c) => { err += c; });
    r.on('close', (c) => resolve([c, err]));
  });
  deep.close();
  check('缺陷锚定：20 万层嵌套 *1 → 非零退出（修复后应存活并 reject「嵌套过深」）', () => {
    assert.notEqual(code, 0, '若此项 FAIL（exit=0），说明深度上限已加——请翻转断言');
  });
  check('缺陷锚定：退出原因是 Maximum call stack size exceeded', () => {
    assert.match(stderr, /call stack size exceeded/i);
  });
}

// ---------------------------------------------------------------------------
// S4（P1 实证）：fetchJson 跟随重定向，Qdrant 自定义 api-key 头跨源转发
// ---------------------------------------------------------------------------
console.log('\n[S4] 重定向转发自定义凭证头');
await checkAsync('缺陷锚定：302 跳转后 api-key 明文到达目标服务器（修复后应 3xx 即报错）', async () => {
  const received = [];
  const B = http.createServer((req, res) => {
    received.push({ path: req.url, apiKey: req.headers['api-key'] });
    res.setHeader('content-type', 'application/json');
    res.end('{"version":"attacker"}');
  });
  const bPort = await listen(B);
  const A = http.createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${bPort}/redirected` });
    res.end();
  });
  const aPort = await listen(A);
  try {
    const handle = await openNoSqlHandle({ kind: 'qdrant', host: '127.0.0.1', port: aPort }, 'QDRANT_SECRET_XYZ');
    await handle.adminPing();
    assert.equal(received.length > 0, true, '重定向未发生？');
    assert.equal(received[0].apiKey, 'QDRANT_SECRET_XYZ', '若此项 FAIL（api-key 未转发），说明 S4 已修复——请翻转断言');
    assert.equal(received[0].path, '/redirected');
  } finally {
    A.close(); B.close();
  }
});

// ---------------------------------------------------------------------------
// ES 认证条件缺陷（P1 实证）：条件引用不存在的 profile.password 字段，
//                           只填密码不填用户名时永远不发 Authorization
// ---------------------------------------------------------------------------
console.log('\n[ES-AUTH] 只填密码不填用户名 → 静默匿名');
await checkAsync('缺陷锚定：password 传入但 user 为空 → 请求不带 Authorization（修复后应带 Basic）', async () => {
  const captured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    captured.push({ url: String(url), headers: opts?.headers ?? {} });
    return {
      ok: true,
      text: async () => JSON.stringify({ version: { number: '8.0.0' } }),
    };
  };
  try {
    await openNoSqlHandle({ kind: 'elasticsearch', host: '127.0.0.1', port: 9200 }, 'ES_SECRET');
    assert.equal(captured.length > 0, true);
    assert.equal(captured[0].headers.authorization, undefined,
      '若此项 FAIL（带了 Basic 头），说明 ES-AUTH 已修复——请翻转断言');
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n==== test-v101: ${pass} PASS / ${fail} FAIL ====`);
// 显式退出：S5 探针触发握手失败后，RedisClient 的 socket 按当前缺陷保持打开
// （正是报告指出的「AUTH/PING 失败不关闭 socket」），事件循环排不空，必须强退。
process.exit(fail > 0 ? 1 : 0);
