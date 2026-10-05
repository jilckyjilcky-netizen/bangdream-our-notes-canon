#!/usr/bin/env node
/**
 * 自检.mjs —— 全项目唯一验收入口
 *
 * 为什么要有这个脚本：
 *   此前"验收全绿"这件事散在 11 个入口、记在 3 份文档里（README / 交接.md / 交接计划）。
 *   人记不住跑哪几条，于是每次改动只跑记得住的那几条 —— 这是本项目文档数字反复漂移的
 *   直接成因之一（口径已修 5 轮仍在漂）。现在收成一个入口，退出码非 0 即失败。
 *
 * 硬约束（别改）：
 *   - 子进程一律 `stdio: 'inherit'`。本沙箱里 spawnSync 的**管道模式会静默失败**
 *     （status 恒为 null、stdout undefined，且不报错）——`check_doc_numbers.mjs` 就是撞的这个。
 *     代价：拿不到子进程 stdout 做二次断言，只取退出码。够用，且更诚实。
 *   - 只取**退出码**判定成败，不解析输出文本（文本断言各脚本自己做）。
 *   - 只读。本脚本不写任何文件。
 *
 * 用法：
 *   node 工具/自检.mjs              默认套件（12 项，全是快校验）
 *   node 工具/自检.mjs --all        追加 2 项（台词逐字对账报告 / 文档数字审计）
 *   node 工具/自检.mjs --only 词层  只跑名字含「词层」的那条
 *   node 工具/自检.mjs --list       只列清单不跑
 *   node 工具/自检.mjs --quiet      子脚本输出照常，只在最后打汇总
 *
 * 退出码：任一「必过」项非 0 → 1；全部通过 → 0。
 */

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = join(HERE, '..');

/**
 * kind:
 *   'must' 必过 —— 失败即整体验收失败
 *   'info' 报告类 —— 只跑不判（输出是给人看的报告，脚本本身不以退出码表达成败）
 */
const SUITES = [
  { name: '资料库完整性',   kind: 'must', args: ['工具/check_kb.mjs'] },
  { name: '资产缺口审计',   kind: 'must', args: ['工具/audit_models.mjs'] },
  { name: '词层清单',       kind: 'must', args: ['工具/lexicon.mjs', '--check'] },
  { name: '语域分档',       kind: 'must', args: ['工具/语域分档.mjs', '--check'] },
  { name: '波浪号基线',     kind: 'must', args: ['工具/build_wave_baseline.mjs', '--check'] },
  { name: '文件清单台账',   kind: 'must', args: ['工具/生成文件清单.mjs', '--check'] },
  { name: 'MCP 工具断言',   kind: 'must', args: ['mcp-canon/_test-tools.mjs'] },
  { name: 'MCP 名字索引',   kind: 'must', args: ['mcp-canon/_test-names.mjs'] },
  { name: 'MCP HTTP 传输',  kind: 'must', args: ['mcp-canon/_test-http.mjs'] },
  { name: '闸门复算',       kind: 'must', args: ['跑道/_闸门核对.mjs', '2'] },
  // 已知边界（2026-10-05 实测）：这两条 selftest 内部要起本地 HTTP stub / 再 spawn 子进程，
  // 在**受限沙箱**里会失败（曾观察到 1/15、20 项失败），放开沙箱的同一命令 15/15、20/20 全过。
  // 所以这里失败时先看 note，别急着判回归 —— 换一个放开沙箱的会话复跑一次再下结论。
  { name: '派发器自检',     kind: 'must', args: ['工具/派发器.mjs', '--selftest'],
    note: '受限沙箱内可能因内部 stub server 失败，属环境边界，复跑确认' },
  { name: '回测打分自检',   kind: 'must', args: ['工具/回测_扮演.mjs', '--selftest'],
    note: '受限沙箱内可能因内部 spawn 失败，属环境边界，复跑确认' },

  // ---- 以下 --all 才跑 ----
  { name: 'skill 台词逐字对账', kind: 'info', all: true, args: ['工具/verify_skill_lines.mjs'],
    note: '输出是给人看的报告（当前 96.9%），脚本不以退出码表达成败' },
  { name: '文档数字口径审计', kind: 'info', all: true, args: ['工具/check_doc_numbers.mjs'],
    note: '本沙箱内 spawn 子进程必撞 EBUSY，预期失败；需人工绕开或改进程内调用' },
];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

let list = SUITES.filter((s) => has('--all') ? true : !s.all);
const only = val('--only');
if (only) {
  const hit = SUITES.filter((s) => s.name.includes(only));
  if (!hit.length) { console.error(`--only "${only}" 无匹配，可用：${SUITES.map(s => s.name).join(' / ')}`); process.exit(2); }
  list = hit;
}

if (has('--list')) {
  console.log('\n自检清单：');
  for (const s of SUITES) {
    console.log(`  [${s.kind === 'must' ? '必过' : '报告'}]${s.all ? '[--all]' : '      '} ${s.name.padEnd(18, '　')} node ${s.args.join(' ')}`);
  }
  process.exit(0);
}

const results = [];
console.log(`\n=== 自检 ${list.length} 项 ===\n`);

for (const s of list) {
  const t0 = Date.now();
  if (!has('--quiet')) console.log(`───── ${s.name} ｜ node ${s.args.join(' ')}`);
  let r;
  try {
    r = spawnSync(process.execPath, s.args, { cwd: WS, stdio: 'inherit' });
  } catch (e) {
    results.push({ ...s, status: 'THROW', ms: Date.now() - t0 });
    console.log(`\n[异常] ${s.name}: ${e.code || e.message}`);
    continue;
  }
  const ms = Date.now() - t0;
  // 沙箱边界：管道模式会静默失败（status null）。inherit 正常，但不排除将来回归，故显式识别。
  if (r.status === null) {
    results.push({ ...s, status: 'NULL(管道静默失败)', ms });
    console.log(`\n[异常] ${s.name}: 子进程 status=null —— 撞上本沙箱的 spawn 管道限制，请确认 stdio:'inherit' 未被改动`);
    continue;
  }
  results.push({ ...s, status: r.status, ms });
  if (!has('--quiet')) console.log('');
}

// 中文按 2 列宽算，否则汇总表对不齐
const dispW = (s) => [...String(s)].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dispW(s)));

console.log('\n═════ 汇总 ═════');
let failed = 0;
for (const r of results) {
  const ok = r.status === 0;
  if (!ok && r.kind === 'must') failed++;
  const mark = ok ? '✓' : (r.kind === 'must' ? '✗' : '·');
  console.log(`${mark} ${pad(r.name, 20)} ${pad(r.status, 6)} ${(r.ms / 1000).toFixed(1)}s${r.note && !ok ? '  ← ' + r.note : ''}`);
}

const mustTotal = results.filter((r) => r.kind === 'must').length;
console.log(`\n必过 ${mustTotal - failed}/${mustTotal} 通过${failed ? `，${failed} 项失败` : ''}`);
if (failed) {
  console.log('失败项：' + results.filter((r) => r.kind === 'must' && r.status !== 0).map((r) => r.name).join(' / '));
}
process.exit(failed ? 1 : 0);
