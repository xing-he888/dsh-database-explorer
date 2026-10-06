/**
 * run-all.mjs — 回归套件统一入口（工程基建 #14）。
 *
 * 用法：npm test（= node test/run-all.mjs）
 * 逐个执行 test/ 下的 vNNN 套件，任一失败即非零退出——CI 与 release.mjs 都走这里。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here).filter((f) => /^test-v\d+\.mjs$/.test(f)).sort();

if (suites.length === 0) {
  console.error('test/ 下没有发现 test-vNNN.mjs 套件');
  process.exit(1);
}

let failed = [];
for (const suite of suites) {
  console.log(`\n========== ${suite} ==========`);
  const r = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(suite);
}

console.log(`\n==== 总结：${suites.length - failed.length}/${suites.length} 套件通过${failed.length ? `（失败：${failed.join(', ')}）` : ''} ====`);
process.exit(failed.length ? 1 : 0);
