#!/usr/bin/env node
/**
 * check_kb.mjs —— 资料库 kb.json 完整性校验
 *
 * 每次重跑 build_kb.mjs 之后跑一次：确认「路径能解析、必填字段非空、索引能命中」，
 * 而不是只看角色数量对不对。重构路径逻辑时这个尤其重要。
 *
 * 用法：node 工具/check_kb.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WS } from './_root.mjs';

const KB = join(WS, '资料库', 'kb.json');
if (!existsSync(KB)) { console.error('✗ 找不到 资料库/kb.json'); process.exit(1); }
const k = JSON.parse(readFileSync(KB, 'utf8'));

let fail = 0;
const bad = [];
const chars = k.characters || [];

for (const c of chars) {
  const problems = [];
  if (!c.doc || !existsSync(join(WS, c.doc))) problems.push('doc 路径解析不到 → ' + c.doc);
  if (!c.speech || !Object.keys(c.speech).length) problems.push('语言指纹为空');
  else if (!c.speech['省略号率']) problems.push('指纹缺「省略号率」');
  if (!c.quote_bank || !c.quote_bank.length) problems.push('台词弹药库为空');
  if (!c.name_short) problems.push('缺 name_short');
  if (!c.band) problems.push('缺 band');
  if (problems.length) { fail++; bad.push(`${c.name_short || c.id}：${problems.join('；')}`); }
}

const ids = new Set(chars.map(c => c.id));
const idxNoTarget = Object.keys(k.index || {}).filter(key => {
  const e = key.startsWith('ev_') || (k.events || []).some(x => x.id === key)
    || (k.places || []).some(x => x.id === key) || (k.items || []).some(x => x.id === key);
  return !ids.has(key) && !e;
});

/* ── 语言指标覆盖率：指纹报告里有的指标，kb 里的 speech 是否都抓到了 ──
 * 起因：kb 的 speech 里「疑问率」全员缺失——build_kb 的 parseFingerprint
 * 期望的表格行，指纹报告里其实没有（它写的是「含疑问「吗/呢/吧」」）。 */
const metricUnion = new Set();
for (const c of chars) for (const m of Object.keys(c.speech || {})) metricUnion.add(m);
const missingByChar = [];
for (const c of chars) {
  const miss = [...metricUnion].filter(m => !(c.speech || {})[m]);
  if (miss.length) missingByChar.push(`${c.name_short || c.id}：${miss.join('、')}`);
}

console.log('\n资料库完整性校验\n');
console.log(`  角色             ${chars.length}`);
console.log(`  事件/场所/物件   ${(k.events || []).length} / ${(k.places || []).length} / ${(k.items || []).length}`);
console.log(`  台词总数         ${chars.reduce((a, c) => a + (c.quote_bank || []).length, 0)}`);
console.log(`  索引条目         ${Object.keys(k.index || {}).length}`);
console.log(`  meta.schema      ${JSON.stringify(k.meta?.schema || {})}`);
console.log(`  语言指标种类     ${metricUnion.size}：${[...metricUnion].join(' / ')}`);

if (missingByChar.length) {
  console.log(`\n⚠ ${missingByChar.length} 个角色缺部分语言指标（同一指标有的角色有、有的没有）：`);
  for (const m of missingByChar.slice(0, 6)) console.log('   · ' + m);
  if (missingByChar.length > 6) console.log(`   …另外 ${missingByChar.length - 6} 个`);
}

if (bad.length) {
  console.log(`\n✗ ${fail} 个角色有问题：`);
  for (const b of bad) console.log('   · ' + b);
} else {
  console.log(`\n✓ ${chars.length} 个角色全部通过（doc 可解析 / 指纹非空 / 台词非空 / 必填字段齐）`);
}
if (idxNoTarget.length) console.log(`⚠ ${idxNoTarget.length} 个索引条目找不到对应实体：${idxNoTarget.slice(0, 5).join(', ')}`);

/* ── 波浪号基线一致性（2026-10-03 新增）──
 * canon-tools 的 WAVE_EXPECT 用一份"全量语料波浪号率"常量表；语料更新后会漂移。
 * v1.1 曾因从精选台词库派生，把 0 次使用的祥子判成"该用波浪号"、恒定扣分。
 * 这里只做**提醒级**校验（不阻塞）：正式校验/重算用 工具/build_wave_baseline.mjs --check。 */
try {
  const dir = join(WS, '素材全量', '按话', 'zh-Hans');
  if (existsSync(dir)) {
    const { WAVE_EXPECT, WAVE_EXPECT_MIN_RATE } = await import(new URL('../mcp-canon/canon-tools.mjs', import.meta.url).href);
    const 命中 = new Map(), 总数 = new Map();
    const 走 = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) 走(p);
        else if (e.name.endsWith('.md')) {
          for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) {
            const m = l.match(/^\*\*(.+?)\*\*[：:](.*)$/);
            if (!m) continue;
            const who = m[1].trim();
            总数.set(who, (总数.get(who) || 0) + 1);
            if (/[～~]/.test(m[2])) 命中.set(who, (命中.get(who) || 0) + 1);
          }
        }
      }
    };
    走(dir);
    const 漂 = [];
    for (const c of chars) {
      const 总 = 总数.get(c.name_short) || 0;
      const 率 = 总 ? +(100 * (命中.get(c.name_short) || 0) / 总).toFixed(2) : 0;
      const 现 = WAVE_EXPECT.get(c.name_short);
      if (!现) { 漂.push(`${c.name_short}：canon-tools 未登记`); continue; }
      if (Math.abs(现.语料率 - 率) > 0.05) 漂.push(`${c.name_short}：登记 ${现.语料率}% ≠ 实测 ${率}%`);
      else if (现.expect !== (率 >= WAVE_EXPECT_MIN_RATE)) 漂.push(`${c.name_short}：expect ${现.expect} ≠ 应 ${率 >= WAVE_EXPECT_MIN_RATE}`);
    }
    if (漂.length) {
      console.log(`\n⚠ 波浪号基线与语料不一致（${漂.length} 人）——重跑 node 工具/build_wave_baseline.mjs --js 更新常量：`);
      for (const x of 漂.slice(0, 6)) console.log('   · ' + x);
      if (漂.length > 6) console.log(`   …另外 ${漂.length - 6} 人`);
    } else {
      console.log(`\n✓ 波浪号基线与语料一致（${chars.length} 人，阈值 ${WAVE_EXPECT_MIN_RATE}%）`);
    }
  }
} catch (e) {
  console.log(`\n⚠ 波浪号基线校验跳过：${e.message}`);
}

process.exit(bad.length ? 1 : 0);
