/**
 * redis-victim — test-v101 的子进程受害者脚本。
 *
 * 用法：node redis-victim.mjs connect <port>
 * 以 openNoSqlHandle 建立一条真实 Redis handle（不做任何 mock）。
 * 若宿主解析器在 socket 回调里裸抛（S1）或递归栈溢出（S2），
 * 本进程将带着 uncaught exception 退出——由父进程检查退出码与 stderr。
 */
const { openNoSqlHandle } = await import('../../lib/nosql.js').then((m) => m.default ?? m).catch(async () => {
  // 兼容被直接以相对路径运行
  return await import(new URL('../../lib/nosql.js', import.meta.url));
});

const [, , mode, portArg] = process.argv;
if (mode !== 'connect') {
  console.error('usage: node redis-victim.mjs connect <port>');
  process.exit(2);
}
const handle = await openNoSqlHandle({ kind: 'redis', host: '127.0.0.1', port: Number(portArg) }, '');
console.log('CONNECTED_OK', handle.kind);
process.exit(0);
