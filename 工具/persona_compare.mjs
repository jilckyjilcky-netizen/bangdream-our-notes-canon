#!/usr/bin/env node
/**
 * persona_compare.mjs —— 全角色语言指纹横向对比
 *
 * 为什么需要：单看「灯省略号率 84.6%」无法判断这是不是她的特征。
 * 必须与其他 24 名角色同口径比较，才能确认哪些指标真的有区分度。
 *
 * 用法：node persona_compare.mjs [素材全量根目录]
 * 输出：控制台表格 + 角色模型/全角色指纹对比.md
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WS } from './_root.mjs';

const ROOT = process.argv[2] || join(WS, '素材全量');
const BASE = join(ROOT, '按角色', 'zh-Hans');

const norm = s => s.replace(/[^\u4e00-\u9fa5]/g, '');

function parse(file) {
  const raw = readFileSync(file, 'utf8').split(/\r?\n/);
  const items = []; let cur = null, e = null, skip = false;
  const push = () => { if (e && cur !== null) items.push({ sec: cur, t: e.trim() }); e = null; };
  for (const l of raw) {
    if (/^##\s/.test(l)) { push(); const t = l.replace(/^##\s+/, '').trim(); skip = t === '出处目录'; cur = skip ? null : t; continue; }
    if (skip) continue;
    if (/^<sub>/.test(l) || /^#/.test(l) || /^>/.test(l) || /^---/.test(l)) continue;
    if (/^-\s/.test(l)) { push(); e = l.replace(/^-\s+/, ''); continue; }
    if (!l.trim()) { push(); continue; }
    if (e !== null) e += l.trim();
  }
  push();
  return items;
}

const rows = [];
for (const band of readdirSync(BASE)) {
  const dir = join(BASE, band);
  if (!statSync(dir).isDirectory() || band === '配角') continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const items = parse(join(dir, f));
    const flat = s => s.replace(/\s/g, '');
    const speech = items.filter(o => {
      const t = flat(o.t);
      return !/^[『♪]/.test(t) && !/^[（]/.test(t) && !/^[………\s]*$/.test(t);
    });
    const silent = items.filter(o => /^[………\s]*$/.test(flat(o.t)) && /…/.test(o.t));
    const n = speech.length;
    if (!n) continue;
    const L = speech.map(o => norm(o.t).length).filter(x => x > 0);
    const avg = L.reduce((a, b) => a + b, 0) / L.length;
    const p = (c) => (c / n * 100);
    rows.push({
      角色: f.replace(/\.md$/, '').split('_').pop(),
      总条: items.length,
      台词: n,
      沉默占比: items.length ? silent.length / items.length * 100 : 0,
      均长: avg,
      '≤6字%': p(L.filter(x => x <= 6).length),
      省略号率: p(speech.filter(o => /…/.test(o.t)).length),
      疑问率: p(speech.filter(o => /？/.test(o.t)).length),
      感叹率: p(speech.filter(o => /！/.test(o.t)).length),
      口吃率: p(speech.filter(o => /([\u4e00-\u9fa5])、\1/.test(o.t)).length),
      呼称小X率: p(speech.filter(o => /小[\u4e00-\u9fa5]/.test(o.t)).length),
    });
  }
}

const cols = ['角色', '总条', '沉默占比', '均长', '≤6字%', '省略号率', '疑问率', '感叹率', '口吃率', '呼称小X率'];
const fmt = (r, c) => typeof r[c] === 'number' ? r[c].toFixed(1) : r[c];
const table = [
  '| ' + cols.join(' | ') + ' |',
  '|' + cols.map(() => '---').join('|') + '|',
  ...rows.map(r => '| ' + cols.map(c => fmt(r, c)).join(' | ') + ' |'),
];

const L = [];
L.push('# 全角色语言指纹横向对比\n');
L.push(`> 由 \`persona_compare.mjs\` 生成 ｜ 数据源 \`素材全量/按角色/zh-Hans/\` ｜ 共 ${rows.length} 名主角色\n`);
L.push('**口径说明**：分母为「台词条目数」（已剔除纯歌词、纯心声、纯省略号行）。');
L.push('「沉默占比」的分母则是该角色全部条目数，即**纯省略号行在她所有台词里占多大比例**。\n');
L.push(table.join('\n'));
L.push('\n## 关键读法\n');
const rank = (key, asc = false) => [...rows].sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]);
const show = (key, label, unit = '') => {
  const s = rank(key).slice(0, 3).map(r => `${r.角色} ${fmt(r, key)}${unit}`).join(' · ');
  const e = rank(key).slice(-3).map(r => `${r.角色} ${fmt(r, key)}${unit}`).join(' · ');
  L.push(`- **${label}**：最高 ${s} ｜ 最低 ${e}`);
};
show('省略号率', '省略号率', '%');
show('沉默占比', '纯沉默占比', '%');
show('均长', '平均句长', ' 字');
show('口吃率', '首字口吃率', '%');
show('呼称小X率', '「小X」呼称率', '%');
show('感叹率', '感叹号率', '%');

/* ---- 签名：每人对 25 人中位数的偏离（交叉验证用） ---- */
const median = k => {
  const v = rows.map(r => r[k]).sort((a, b) => a - b);
  const m = v.length / 2;
  return v.length % 2 ? v[Math.floor(m)] : (v[m - 1] + v[m]) / 2;
};
const MEDS = {};
for (const k of ['省略号率', '沉默占比', '均长', '≤6字%', '疑问率', '感叹率', '口吃率', '呼称小X率']) MEDS[k] = median(k);

L.push('\n## 每人语言签名（相对 25 人中位数的偏离）\n');
L.push('> 交叉验证口径：某角色的某指标若超过中位数 1.4 倍或不足 0.7 倍，即视为**语言签名**。');
L.push('> 无签名或签名稀少的角色，说明其说话方式接近"这一代人物的默认腔"，反而不是坏事——那本身就是它的签名。\n');
L.push('| 角色 | 语言签名（显著向上 ↑ / 显著向下 ↓） |');
L.push('|---|---|');
for (const r of rows) {
  const sig = [];
  for (const [k, tag] of [['省略号率', '省略号'], ['沉默占比', '沉默'], ['均长', '句长'], ['感叹率', '感叹'], ['疑问率', '疑问'], ['口吃率', '口吃'], ['呼称小X率', '小X呼称'], ['≤6字%', '短句']]) {
    const ratio = r[k] / MEDS[k];
    if (k === '均长' || k === '≤6字%') {
      if (ratio <= 0.67) sig.push(`${tag}↓(${r[k].toFixed(1)})`);
    } else if (ratio >= 1.4) sig.push(`${tag}↑(${r[k].toFixed(1)})`);
  }
  L.push(`| ${r.角色} | ${sig.length ? sig.join(' ') : '—（接近默认腔）'} |`);
}

console.log(table.join('\n'));
writeFileSync(join(WS, '角色模型', '_全角色指纹对比.md'), L.join('\n'), 'utf8');
console.log(`\n已写出 角色模型/_全角色指纹对比.md`);
