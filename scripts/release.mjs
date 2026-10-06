/**
 * release.mjs — 发布流水线（工程基建 #13，替代手工三副本 diff）。
 *
 * 用法：
 *   npm run release                 # 校验模式：版本握手 / pack 清单 / 三副本 diff / 全量测试
 *   npm run release -- --sync      # + 把仓库副本同步到 local-plugins 与已安装副本
 *   npm run release -- --tag       # + git commit（若有变更）并打 v{version} tag
 *   npm run release -- --publish   # + npm publish（最后一步，仍需人工确认语义）
 *
 * 顺序固定：校验 → 同步 → 再校验 → 测试 → 提交/打标 → 发布。
 * 任何一步失败立即非零退出，后续步骤不执行。
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
let step = 0;
// Windows 上 npm 是 .cmd：Node 安全补丁后 spawnSync 直调 .cmd 会 EINVAL，
// 必须经 shell 调起；参数为受控常量（不含空格），单字符串形式规避 DEP0190。
const runNpm = (args, opts = {}) => {
  const r = spawnSync(`npm ${args.join(' ')}`, { cwd: repo, ...opts, shell: true, encoding: 'utf8' });
  if (r.status !== 0) fail(`npm ${args.join(' ')} 退出码 ${r.status}${r.error ? '（' + (r.error.code || r.error.message) + '）' : ''}`);
  return r;
};
const fail = (msg) => { console.error(`\n[x] 第 ${step} 步失败：${msg}`); process.exit(1); };
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: repo, ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} 退出码 ${r.status}`);
};

const copies = [
  join(homedir(), '.dsh', 'local-plugins', 'dsh-database-explorer'),
  join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-database-explorer'),
];

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const clientSrc = readFileSync(join(repo, 'lib', 'client.js'), 'utf8');
const clientVersion = clientSrc.match(/const CLIENT_VERSION = "([^"]+)"/)?.[1];

// ---- 1. 版本握手 ----------------------------------------------------------
step = 1;
console.log(`\n[1] 版本握手（package.json ${pkg.version} vs client.js ${clientVersion}）`);
if (pkg.version !== clientVersion) fail(`版本不一致：package.json=${pkg.version}，CLIENT_VERSION=${clientVersion}`);
console.log('    OK');

// ---- 2. npm pack 清单（files 白名单之外的东西不该进包）--------------------
step = 2;
console.log('\n[2] npm pack --dry-run 清单检查');
{
  // Windows 上 npm 是 .cmd，必须经 shell 调起（见 runNpm 注释）
  const r = runNpm(['pack', '--dry-run']);
  if (r.status !== 0) fail('npm pack --dry-run 失败');
  const out = r.stdout + r.stderr;
  if (/AUDIT\.md|test\//.test(out)) fail('pack 清单里出现了内部文件（AUDIT.md / test/）——检查 package.json files');
  const files = out.match(/total files:\s*(\d+)/)?.[1];
  console.log(`    OK（${files ?? '?'} 个文件）`);
}

// ---- 3. 三副本同步（--sync 时复制，否则仅 diff）---------------------------
step = 3;
console.log(`\n[3] 三副本${flags.has('--sync') ? '同步' : '比对'}（local-plugins / 安装目录）`);
const sameFile = (a, b) => existsSync(b) && readFileSync(a).equals(readFileSync(b));
const sameDir = (a, b) => {
  if (!existsSync(b)) return false;
  const la = readdirSync(a).sort(), lb = readdirSync(b).sort();
  if (la.join() !== lb.join()) return false;
  return la.every((f) => readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
};
if (flags.has('--sync')) {
  for (const dir of copies) {
    if (!existsSync(dir)) { console.warn(`    跳过（不存在）：${dir}`); continue; }
    rmSync(join(dir, 'lib'), { recursive: true, force: true });
    cpSync(join(repo, 'lib'), join(dir, 'lib'), { recursive: true });
    cpSync(join(repo, 'package.json'), join(dir, 'package.json'));
    cpSync(join(repo, 'README.md'), join(dir, 'README.md'));
    cpSync(join(repo, 'cordis.patch.yml'), join(dir, 'cordis.patch.yml'));
  }
}
for (const dir of copies) {
  if (!existsSync(dir)) { console.warn(`    跳过（不存在）：${dir}`); continue; }
  if (!sameDir(join(repo, 'lib'), join(dir, 'lib'))) fail(`lib/ 不一致：${dir}`);
  if (!sameFile(join(repo, 'package.json'), join(dir, 'package.json'))) fail(`package.json 不一致：${dir}`);
}
console.log('    OK（三副本 lib + package.json 一致）');

// ---- 4. 全量回归 ----------------------------------------------------------
step = 4;
console.log('\n[4] 全量回归（npm test）');
run(process.execPath, ['test/run-all.mjs']);

// ---- 5. git 提交 + 打标（--tag）-------------------------------------------
if (flags.has('--tag')) {
  step = 5;
  console.log('\n[5] git 提交 + tag');
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  if (status.stdout.trim() !== '') {
    run('git', ['add', '-A', ':!AUDIT.md']); // AUDIT.md 保持不入库（含未闭环登记册）
    run('git', ['commit', '-m', `v${pkg.version}`]);
  } else {
    console.log('    工作区干净，跳过提交');
  }
  run('git', ['tag', '-f', `v${pkg.version}`]);
}

// ---- 6. npm publish（--publish）-------------------------------------------
if (flags.has('--publish')) {
  step = 6;
  console.log('\n[6] npm publish');
  runNpm(['publish']);
}

console.log(`\n[完成] v${pkg.version}${flags.has('--publish') ? ' 已发布' : '（校验/同步模式——加 --tag 打标、--publish 发布）'}`);
