#!/usr/bin/env node
/**
 * persona_extract.mjs —— 角色"签名时刻"提取器
 *
 * 为写角色模型提供紧凑弹药：不读全文，只抽出该角色最有特征力度的行。
 * 输出一个紧凑 digest，足够定性建模（精确量化看 persona_stats）。
 *
 * 用法：node persona_extract.mjs <角色语料md> [字数阈值=25]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const THRESH = +(process.argv[3] || 25);
if (!file) { console.error('用法: node persona_extract.mjs <语料md> [字数阈值]'); process.exit(1); }

const norm = s => s.replace(/[^\u4e00-\u9fa5]/g, '');
const flat = s => s.replace(/\s/g, '');
const raw = readFileSync(file, 'utf8').split(/\r?\n/);

const sections = [];
let cur = null, e = null, skip = false;
const push = () => { if (e && cur !== null) sections.push({ sec: cur, t: flat(e.trim()) }); e = null; };
for (const l of raw) {
  if (/^##\s/.test(l)) { push(); const t = l.replace(/^##\s+/, '').trim(); skip = t === '出处目录'; cur = skip ? null : t; continue; }
  if (skip) continue;
  if (/^<sub>/.test(l) || /^#/.test(l) || /^>/.test(l) || /^---/.test(l)) continue;
  if (/^-\s/.test(l)) { push(); e = l.replace(/^-\s+/, ''); continue; }
  if (!l.trim()) { push(); continue; }
  if (e !== null) e += l.trim();
}
push();

const all = sections.filter(o => o.t.length > 0);
const speech = all.filter(o => !/^[『♪]/.test(o.t) && !/^（/.test(o.t) && !/^[…\s]*$/.test(o.t));
const silent = all.filter(o => /^[…\s]*$/.test(o.t));
const lyric = all.filter(o => /^[『]/.test(o.t));
const head = x => `${x.slice(0, 60)}${x.length > 60 ? '…' : ''}`;

const L = [];
L.push(`# ${file.split(/[\\/]/).pop()} —— 签名时刻提取\n`);
L.push(`条目 ${all.length} ｜ 台词 ${speech.length} ｜ 纯沉默 ${silent.length} ｜ 歌词 ${lyric.length}\n`);

L.push(`## 最长的 12 句（信息量暴增时刻——它们在什么话题？）`);
speech.map(o => [norm(o.t).length, o]).sort((a, b) => b[0] - a[0]).slice(0, 12)
  .forEach(([n, o]) => L.push(`- [${n}字][${o.sec}] ${head(o.t)}`));

L.push(`\n## 含「！！」的（音量峰值——为什么事？）`);
speech.filter(o => /！！/.test(o.t)).slice(0, 12).forEach(o => L.push(`- [${o.sec}] ${head(o.t)}`));

L.push(`\n## 纯沉默行样本（前 8）`);
silent.slice(0, 8).forEach((o, i) => L.push(`- (${o.sec}) ${o.t}`));

L.push(`\n## 语气特殊句式`);
L.push(`- 口吃（字、字）样本:`);
speech.filter(o => /([\u4e00-\u9fa5])、\1/.test(o.t)).slice(0, 5).forEach(o => L.push(`  · [${o.sec}] ${head(o.t)}`));
L.push(`- 以「～」结尾（波浪号，若有）: ${speech.filter(o => /～$/.test(o.t)).length} 句`);
if (speech.some(o => /～$/.test(o.t))) speech.filter(o => /～$/.test(o.t)).slice(0, 4).forEach(o => L.push(`  · [${o.sec}] ${head(o.t)}`));

L.push(`\n## 高频个人标记词`);
for (const [w, re] of [
  ['呼称小X', /小[\u4e00-\u9fa5]{1,2}/], ['谢谢', /谢谢/], ['对不起/抱歉', /对不起|抱歉/],
  ['为什么', /为什么/], ['一辈子/永远', /一辈子|永远/], ['不知道/不懂', /不知道|不懂|不明白/],
  ['没问题/交给我', /没问题|交给我|包在我/], ['请求句「请」', /拜托|请/],
]) {
  const n = speech.filter(o => re.test(o.t)).length;
  if (n) L.push(`- ${w}: ${n}/${speech.length} = ${(n / speech.length * 100).toFixed(1)}%`);
}

L.push(`\n## 与重点对象相关的高光句（按对象聚合，前 3 句/对象）`);
const talks = s => speech.filter(o => o.t.includes(s)).slice(0, 3).map(o => `  · [${o.sec}] ${head(o.t)}`).join('\n');
for (const name of ['灯', '爱音', '立希', '爽世', '乐奈', '祥子', '初华', '睦', '海铃', '若麦', '小祥', 'Tomorin', 'Doloris']) {
  const t = talks(name);
  if (t) { L.push(`- 「${name}」:`); L.push(t); }
}

console.log(L.join('\n'));