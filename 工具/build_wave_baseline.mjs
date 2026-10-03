#!/usr/bin/env node
/**
 * build_wave_baseline.mjs —— 生成/校验「波浪号基线」：各角色全量语料的波浪号率
 *
 * 为什么要这个工具（2026-10-03 修 bug 时新增）：
 *   `canon-tools.mjs` 的 WAVE_EXPECT 原来从**精选台词库 quote_bank** 派生——
 *   规则是"精选库里有 1 条带「～」就算该角色用波浪号"。精选库是人工挑的 ~30 条，
 *   于是祥子（quote_bank 30 条里 1 条带～、全量语料 1314 条里 **0 次**）被判成
 *   "该用波浪号"，她不拖音就恒定吃 +1 维偏差：同一段台词从第 5 名掉到第 16 名。
 *   复现：`归档/_临时诊断/闸门对照_祥子.mjs`；体检：`归档/_临时诊断/祥子_口径体检报告.md` §四。
 *
 * 现在的规则：**全量语料按行的波浪号率 ≥ WAVE_EXPECT_MIN_RATE(2%)** 才算"会用波浪号"。
 *   阈值取自数据断层：真实在用的 14 人最低 2.40%（由乃），其余最高 1.89%（初华）。
 *
 * 用法：
 *   node 工具/build_wave_baseline.mjs            # 打印基线表（人读）
 *   node 工具/build_wave_baseline.mjs --js       # 打印可粘贴的 JS 常量片段
 *   node 工具/build_wave_baseline.mjs --check    # 与 canon-tools 现值对比，不一致退出码 1
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WS } from './_root.mjs';

const 阈值 = 2;
const ONLY_JS = process.argv.includes('--js');
const CHECK = process.argv.includes('--check');

const kb = JSON.parse(readFileSync(join(WS, '资料库', 'kb.json'), 'utf8'));

function 遍历(dir, 前缀 = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...遍历(p, 前缀 ? `${前缀}/${e.name}` : e.name));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const 命中 = new Map(), 总数 = new Map();
for (const f of 遍历(join(WS, '素材全量', '按话', 'zh-Hans'))) {
  for (const l of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\*\*(.+?)\*\*[：:](.*)$/);
    if (!m) continue;
    const who = m[1].trim();
    总数.set(who, (总数.get(who) || 0) + 1);
    if (/[～~]/.test(m[2])) 命中.set(who, (命中.get(who) || 0) + 1);
  }
}

const 表 = kb.characters.map((c) => {
  const n = c.name_short;
  const 总 = 总数.get(n) || 0;
  const 计 = 命中.get(n) || 0;
  return { n, 计, 总, 率: 总 ? +(100 * 计 / 总).toFixed(2) : 0 };
});

if (CHECK) {
  const { WAVE_EXPECT } = await import(new URL('../mcp-canon/canon-tools.mjs', import.meta.url).href);
  let 错 = 0;
  for (const r of 表) {
    const 现 = WAVE_EXPECT.get(r.n);
    const 应 = r.率 >= 阈值;
    if (!现) { console.log(`✗ ${r.n}：canon-tools 里没有这个角色`); 错++; continue; }
    if (现.expect !== 应) { console.log(`✗ ${r.n}：expect 现值 ${现.expect} ≠ 应 ${应}（语料 ${r.计}/${r.总} = ${r.率}%）`); 错++; }
    if (现.语料率 !== undefined && Math.abs(现.语料率 - r.率) > 0.05) { console.log(`✗ ${r.n}：登记的语料率 ${现.语料率}% ≠ 实测 ${r.率}%`); 错++; }
  }
  console.log(错 ? `✗ 波浪号基线有 ${错} 处不一致` : `✓ 波浪号基线 ${表.length} 人全部一致（阈值 ${阈值}%）`);
  process.exit(错 ? 1 : 0);
}

if (ONLY_JS) {
  console.log('export const WAVE_CORPUS_RATE = {   /* 角色 → 波浪号率 %（全量语料按行） */');
  console.log(表.map((r) => `  ${r.n}: ${r.率},`).join('\n'));
  console.log('};');
} else {
  console.log('角色      语料波浪号  语料台词  率        expect(≥' + 阈值 + '%)');
  console.log('-'.repeat(62));
  for (const r of [...表].sort((a, b) => b.率 - a.率)) {
    console.log(`${r.n.padEnd(6, '　')} ${String(r.计).padStart(8)} ${String(r.总).padStart(9)} ${String(r.率 + '%').padStart(8)}   ${r.率 >= 阈值 ? '✓' : '—'}`);
  }
  console.log('-'.repeat(62));
  console.log(`expect=true：${表.filter((r) => r.率 >= 阈值).map((r) => r.n).join('、')}`);
}
