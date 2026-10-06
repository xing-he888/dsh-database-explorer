/**
 * redis-victim — test-v101 的子进程探针。
 *
 * 用法：node redis-victim.mjs connect <port>
 * 以 openNoSqlHandle 建立一条真实 Redis handle（不做任何 mock）。
 * 修复后无论连接成功还是被友好拒绝，本进程都 exit 0：
 *   CONNECTED_OK  — 握手成功（S5 修复后，对真实 +PONG 服务）
 *   REJECTED_OK   — 被友好拒绝（S1/S2 修复后，异常服务器不再杀死进程）
 * 修复前的缺陷行为是 uncaughtException 直接退出（exit 1）——由父进程检查。
 */
import { openNoSqlHandle } from '../../lib/nosql.js';

const [, , mode, portArg] = process.argv;
if (mode !== 'connect') {
  console.error('usage: node redis-victim.mjs connect <port>');
  process.exit(2);
}
try {
  const handle = await openNoSqlHandle(
    { kind: 'redis', host: '127.0.0.1', port: Number(portArg), ssl: process.env.VICTIM_SSL === '1' },
    process.env.VICTIM_PASSWORD ?? ''
  );
  console.log('CONNECTED_OK', handle.kind);
  process.exit(0);
} catch (error) {
  console.log('REJECTED_OK', String(error?.message || error).slice(0, 120));
  process.exit(0);
}
