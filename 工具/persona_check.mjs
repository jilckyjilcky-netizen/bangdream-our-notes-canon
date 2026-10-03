#!/usr/bin/env node
/**
 * persona_check.mjs —— 扮演结果自动校验器
 *
 * 闭环的最后一步：用「模型」生成的对话，回头用「模型」自己的量化指标打分。
 * 口径与 persona_stats.mjs / persona_compare.mjs 完全一致（句长 = 纯汉字）。
 *
 * 用法：
 *   node persona_check.mjs <对话md> <角色名> <语料md> [更多语料md...]
 *
 * 对话md 支持格式：**角色名**：台词   （或 角色名：台词）
 * 语料md 为 素材全量/按角色/... 的产物（"- " 条目）
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('用法: node persona_check.mjs <对话md> <角色名> <语料md> [更多语料md...]');
  process.exit(1);
}
const [dialoguePath, charName, ...corpusPaths] = args;

const hasCJK = s => /[\u4e00-\u9fa5]/.test(s);
const cjkLen = s => (s.match(/[\u4e00-\u9fa5]/g) || []).length;

/* ---------- 从对话文件抽取某角色的台词 ---------- */
function parseDialogue(file) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\*\*(.+?)\*\*[：:]\s*(.*)$/) || line.match(/^([\u4e00-\u9fa5]{1,6})[：:]\s*(.+)$/);
    if (m && m[2].trim()) out.push({ who: m[1].trim(), t: m[2].trim() });
  }
  return out;
}

/* ---------- 从语料文件抽取（与 persona_stats 同口径） ---------- */
function parseCorpus(files) {
  const items = [];
  for (const f of files) {
    const raw = readFileSync(f, 'utf8').split(/\r?\n/);
    let cur = null, e = null, skip = false;
    const push = () => { if (e && cur !== null) items.push(e.trim()); e = null; };
    for (const l of raw) {
      if (/^##\s/.test(l)) { push(); const t = l.replace(/^##\s+/, '').trim(); skip = t === '出处目录'; cur = skip ? null : t; continue; }
      if (skip) continue;
      if (/^<sub>/.test(l) || /^#/.test(l) || /^>/.test(l) || /^---/.test(l)) continue;
      if (/^-\s/.test(l)) { push(); e = l.replace(/^-\s+/, ''); continue; }
      if (!l.trim()) { push(); continue; }
      if (e !== null) e += l.trim();
    }
    push();
  }
  const flat = s => s.replace(/\s/g, '');
  // 返回「台词 + 沉默」全集：剔除歌词与心声（它们是另一语域），但**保留**纯省略号行，
  // 否则「无文字占比」的分母会被抽空，真值与生成值不可比。
  return items
    .map(flat)
    .filter(t => !/^[『♪]/.test(t) && !/^（/.test(t));
}

/* ---------- 指标计算 ----------
 * lines = 该角色的全部条目（含纯省略号行）。
 * 「无文字占比」分母 = 全部条目；其余比率分母 = 含汉字的条目。
 */
function metrics(lines) {
  const total = lines.length;
  const noText = lines.filter(t => !hasCJK(t)).length;
  const sp = lines.filter(hasCJK);
  const n = sp.length || 1;
  const L = sp.map(cjkLen);
  const r = (c) => c / n * 100;
  return {
    '条目数': total,
    '无文字占比': noText / (total || 1) * 100,
    '平均句长(汉字)': L.reduce((a, b) => a + b, 0) / n,
    '最长句': L.length ? Math.max(...L) : 0,
    '≤6字占比': r(L.filter(x => x <= 6).length),
    '省略号率': r(sp.filter(t => /…/.test(t)).length),
    '以…结尾': r(sp.filter(t => /…$/.test(t)).length),
    '疑问率': r(sp.filter(t => /？/.test(t)).length),
    '感叹率': r(sp.filter(t => /！/.test(t)).length),
    '口吃率': r(sp.filter(t => /([\u4e00-\u9fa5])、\1/.test(t)).length),
    '「小X」呼称率': r(sp.filter(t => /小[\u4e00-\u9fa5]/.test(t)).length),
  };
}

const mine = metrics(parseDialogue(dialoguePath).filter(x => x.who === charName).map(x => x.t));
const canon = metrics(parseCorpus(corpusPaths));

/* 小样本容差：n 越小越宽 */
const n = mine['条目数'];
const slack = n >= 60 ? 1.0 : n >= 30 ? 1.3 : 1.7;
const BANDS = {
  '省略号率':            { abs: 15 * slack },
  '以…结尾':            { abs: 15 * slack },
  '疑问率':              { abs: 16 * slack },
  '感叹率':              { abs: 18 * slack },
  '≤6字占比':            { abs: 20 * slack },
  '无文字占比':          { abs: 10 * slack },
  '口吃率':              { abs: 9 * slack },
  '「小X」呼称率':        { abs: 16 * slack },
  '平均句长(汉字)':       { rel: 0.55 },   // ±55% 相对
};

const rows = [];
let fails = 0, warns = 0;
for (const k of Object.keys(canon)) {
  if (k === '条目数' || k === '最长句') continue;
  const a = mine[k], b = canon[k];
  const band = BANDS[k];
  let lo, hi, ok;
  if (band.rel) { lo = b * (1 - band.rel); hi = b * (1 + band.rel); ok = a >= lo && a <= hi; }
  else { lo = b - band.abs; hi = b + band.abs; ok = a >= lo && a <= hi; }
  const verdict = ok ? '✅' : (Math.abs(a - b) <= (band.abs ? band.abs * 1.6 : b * band.rel * 1.6)) ? '⚠️' : '❌';
  if (verdict === '❌') fails++; else if (verdict === '⚠️') warns++;
  rows.push([k, b.toFixed(1), a.toFixed(1), `${lo.toFixed(1)} ~ ${hi.toFixed(1)}`, verdict]);
}

const W = (s, w) => String(s).padEnd(w, ' ');
console.log(`\n扮演校验：${charName}  样本 n=${n} 条（容差系数 ×${slack}）\n`);
console.log(W('指标', 20) + W('语料真值', 10) + W('本次生成', 10) + W('允许区间', 18) + '判定');
console.log('-'.repeat(66));
for (const r of rows) console.log(W(r[0], 20) + W(r[1], 10) + W(r[2], 10) + W(r[3], 18) + r[4]);
console.log('-'.repeat(66));
console.log(`\n结果：${rows.length - fails - warns} 项达标 / ${warns} 项警告 / ${fails} 项偏离`);
if (n < 30) console.log(`⚠️ n=${n} 偏小，单项指标波动大，只宜看趋势。`);
process.exitCode = fails ? 1 : 0;
