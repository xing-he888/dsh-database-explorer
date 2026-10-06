/**
 * dsh-database-explorer — 外部报告（probe2）修复验证套件（v101）
 *
 * v0.9.14 起由「缺陷锚定」翻转为「修复验证」：以下断言验证第 5 轮修复后的
 * 正确行为。S3（envPassword 绕过）= 第 4 轮 S1，由 test-v099 覆盖，不在此重复。
 *
 * 运行：node test/test-v101.mjs
 */

import { strict as assert } from 'node:assert';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
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
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
/** 子进程探针：返回 { code, stdout, stderr }。 */
function runVictim(env, timeoutMs = 15000) {
  const victim = join(here, 'helpers', 'redis-victim.mjs');
  const r = spawn(process.execPath, [victim, 'connect', String(env.port)], {
    env: { ...process.env, ...env }, timeout: timeoutMs,
  });
  let stdout = '', stderr = '';
  r.stdout.on('data', (c) => { stdout += c; });
  r.stderr.on('data', (c) => { stderr += c; });
  return new Promise((resolve) => r.on('close', (code) => resolve({ code, stdout, stderr })));
}

// ---------------------------------------------------------------------------
// S5（R-REDIS-PONG）：真实 Redis 的 +PONG 现在握手成功
// ---------------------------------------------------------------------------
console.log('\n[S5] Redis +PONG 握手（修复后应成功）');
await checkAsync('标准 +PONG 应答 → 连接成功', async () => {
  const raw = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.on('data', () => sock.write('+PONG\r\n'));
  });
  const port = await listen(raw);
  try {
    const handle = await openNoSqlHandle({ kind: 'redis', host: '127.0.0.1', port }, '');
    assert.equal(handle.kind, 'redis');
    await handle.close();
  } finally {
    raw.close();
  }
});

// ---------------------------------------------------------------------------
// S1（R-RESP-CRASH）：异常应答不再杀死进程，而是友好拒绝
// ---------------------------------------------------------------------------
console.log('\n[S1] RESP 解析异常（修复后进程存活、调用方拿到错误）');
{
  const garbage = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.on('data', () => sock.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'));
  });
  const port = await listen(garbage);
  const { code, stdout, stderr } = await runVictim({ port });
  garbage.close();
  check('把 HTTP 服务当 Redis 连 → 进程存活（exit 0）', () => {
    assert.equal(code, 0, `stderr: ${stderr.slice(0, 200)}`);
  });
  check('调用方收到友好拒绝（REJECTED_OK），无 uncaught 异常', () => {
    assert.match(stdout, /REJECTED_OK/);
    assert.doesNotMatch(stderr, /RESP 协议错误/);
  });
}

// ---------------------------------------------------------------------------
// S2（R-RESP-DEPTH）：深嵌套应答不再栈溢出，深度上限兜底
// ---------------------------------------------------------------------------
console.log('\n[S2] RESP 深嵌套（修复后进程存活、深度上限兜底）');
{
  const deep = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.on('data', () => sock.write(Buffer.from('*1\r\n'.repeat(200000))));
  });
  const port = await listen(deep);
  const { code, stdout, stderr } = await runVictim({ port });
  deep.close();
  check('20 万层嵌套 *1 → 进程存活（exit 0）', () => {
    assert.equal(code, 0, `stderr: ${stderr.slice(0, 200)}`);
  });
  check('无栈溢出，错误被友好拒绝', () => {
    assert.doesNotMatch(stderr, /call stack size exceeded/i);
    assert.match(stdout, /REJECTED_OK/);
  });
}

// ---------------------------------------------------------------------------
// S4（R-REDIR1）：重定向被拒绝，自定义凭证头不再跨源转发
// ---------------------------------------------------------------------------
console.log('\n[S4] 重定向凭证外泄（修复后 3xx 一律报错）');
await checkAsync('302 → 连接报错，且跳转目标收不到任何请求/凭证', async () => {
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
    await assert.rejects(
      () => openNoSqlHandle({ kind: 'qdrant', host: '127.0.0.1', port: aPort }, 'QDRANT_SECRET_XYZ'),
      /重定向|redirect/i
    );
    assert.equal(received.length, 0, '凭证/请求不应到达跳转目标');
  } finally {
    A.close(); B.close();
  }
});

// ---------------------------------------------------------------------------
// ES-AUTH（R-ES-AUTH）：只填密码不填用户名 → Basic 头正常发出
// ---------------------------------------------------------------------------
console.log('\n[ES-AUTH] 密码认证（修复后带 Basic 头）');
await checkAsync('password 传入但 user 为空 → 请求带 Authorization: Basic', async () => {
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
    assert.match(String(captured[0].headers.authorization ?? ''), /^Basic /);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// R-REDIS-TLS：勾选 SSL → 走 TLS（对明文服务器握手必然失败，负向证明）
// ---------------------------------------------------------------------------
console.log('\n[Redis-TLS] ssl=true 走 TLS（负向：明文服务器无法完成握手）');
{
  const plain = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.on('data', () => sock.write('+PONG\r\n')); // 明文 Redis，不是 TLS 服务
  });
  const port = await listen(plain);
  const { code, stdout, stderr } = await runVictim({ port, VICTIM_SSL: '1' });
  plain.close();
  check('ssl=true 连明文服务 → TLS 握手失败并友好拒绝（证明确实走了 tls.connect）', () => {
    assert.equal(code, 0, `stderr: ${stderr.slice(0, 200)}`);
    assert.match(stdout, /REJECTED_OK/);
  });
}

console.log(`\n==== test-v101: ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail > 0 ? 1 : 0);
