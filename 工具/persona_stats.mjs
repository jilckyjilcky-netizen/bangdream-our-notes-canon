#!/usr/bin/env node
/**
 * persona_stats.mjs —— 角色「语言指纹」统计器
 *
 * 输入：素材全量/按角色/{lang}/{band}/{简称}_{本名}.md（build.mjs 的产物）
 * 输出：该角色台词的可量化指纹（句长 / 标点 / 呼称 / 口癖 / 分关系差异 / 歌词分层）
 *
 * 用途：为「角色扮演模型」提供实证底座——所有关于"她怎么说话"的断言都要有计数支撑。
 *
 * 用法：node persona_stats.mjs <文件路径> [--json]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('用法: node persona_stats.mjs <角色台词md> [--json]'); process.exit(1); }
const asJson = process.argv.includes('--json');

const raw = readFileSync(file, 'utf8').split(/\r?\n/);

/* ---------- 解析：## 分节(剧本) + "- " 台词条目(可跨行) ---------- */
const sections = [];
let cur = null, entry = null, skip = false;

const closeEntry = () => { if (entry && cur) cur.lines.push(entry.trim()); entry = null; };
const closeSection = () => { closeEntry(); if (cur) sections.push(cur); cur = null; };

for (const line of raw) {
  if (/^##\s/.test(line)) {
    closeSection();
    const title = line.replace(/^##\s+/, '').trim();
    // 「出处目录」是索引不是台词，整节跳过
    cur = title === '出处目录' ? null : { title, cat: '', advId: '', lines: [] };
    skip = title === '出处目录';
    continue;
  }
  if (skip) continue;
  if (/^<sub>/.test(line)) {
    const m = line.match(/^<sub>\s*(.+?)\s*｜\s*advId\s*(\d+)/);
    if (m && cur) { cur.cat = m[1].trim(); cur.advId = m[2]; }
    continue;
  }
  if (/^#\s/.test(line) || /^>/.test(line) || /^---/.test(line) || /^\*\*/.test(line)) continue;
  if (/^-\s/.test(line)) { closeEntry(); entry = line.replace(/^-\s+/, ''); continue; }
  if (line.trim() === '') { closeEntry(); continue; }
  if (entry !== null) entry += '\n' + line.replace(/\s+$/, '');
}
closeSection();

/* ---------- 条目切分：台词 vs 歌词 vs 静默 vs 心声 ---------- */
const isLyric   = s => /^『[\s\S]*』$/.test(s.trim()) || /^[『♪♪]/.test(s.trim());
// 沉默分两级：纯省略号（只有 … 和空白）／省略号+标点（如「……？」「……！」）
const isSilent  = s => /^[…\s]*$/.test(s) && /…/.test(s);
const isSilentP = s => /^[…\s、，。？！?！]*$/.test(s) && /…/.test(s) && !isSilent(s);
const isThought = s => /^（[\s\S]*）$/.test(s.trim());

const items = [];
for (const sec of sections) for (const s of sec.lines) {
  const flat = s.replace(/\n/g, '');
  const kind = isLyric(flat) ? 'lyric' : isThought(flat) ? 'thought'
    : isSilent(flat) ? 'silent' : isSilentP(flat) ? 'silentp' : 'speech';
  items.push({ sec: sec.title, cat: sec.cat, kind, text: flat, raw: s });
}

const speech  = items.filter(i => i.kind === 'speech');
const lyrics  = items.filter(i => i.kind === 'lyric');
const silent  = items.filter(i => i.kind === 'silent');
const silentP = items.filter(i => i.kind === 'silentp');
const thought = items.filter(i => i.kind === 'thought');
const spoken  = items.filter(i => i.kind === 'speech' || i.kind === 'thought');

/* ---------- 统计工具 ---------- */
const count = (arr, re) => arr.filter(x => re.test(x.text ?? x)).length;
const pct = (n, d) => d ? (n / d * 100).toFixed(1) + '%' : '0%';
const lenOf = s => s.replace(/[\s\u3000]/g, '').length;          // 含标点
const lenCJK = s => s.replace(/[^\u4e00-\u9fa5]/g, '').length;   // 纯汉字（跨角色可比口径）

const stats = {};
stats.file = file;
stats.total = items.length;
stats.breakdown = {
  台词: speech.length, 歌词: lyrics.length, 心声: thought.length,
  纯省略号: silent.length, 省略号加标点: silentP.length,
};
stats.沉默 = {
  '纯省略号（只含…）': `${silent.length}/${items.length} = ${pct(silent.length, items.length)}`,
  '省略号加标点（如……？）': `${silentP.length}/${items.length} = ${pct(silentP.length, items.length)}`,
  '合计无文字条目': `${silent.length + silentP.length}/${items.length} = ${pct(silent.length + silentP.length, items.length)}`,
};

/* 句长分布（仅台词）：采用「纯汉字」口径，与 persona_compare.mjs 一致 */
const lens = speech.map(i => lenCJK(i.text)).filter(x => x > 0).sort((a, b) => a - b);
const lensP = speech.map(i => lenOf(i.text)).filter(x => x > 0).sort((a, b) => a - b);
stats.句长 = {
  口径: '纯汉字（括号内为含标点口径）',
  均值: `${(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1)}（${(lensP.reduce((a, b) => a + b, 0) / lensP.length).toFixed(1)}）`,
  中位数: lens[Math.floor(lens.length / 2)],
  最长: lens[lens.length - 1],
  '≤6字占比': `${pct(lens.filter(x => x <= 6).length, lens.length)}`,
  '≥25字占比': `${pct(lens.filter(x => x >= 25).length, lens.length)}`,
};

/* 标点 / 口癖 标记率（分母 = 台词条目数） */
const N = speech.length;
const patterns = {
  '含省略号…':        /…/,
  '以…结尾':          /…$/,
  '纯省略号行':       /^[………\s]*$/,
  '含？！':           /[？！]/,
  '以？结尾':         /？$/,
  '以！结尾':         /！$/,
  '单字重复口吃(小、小)': /([\u4e00-\u9fa5])、\1/,
  '叠词(好难受，好难受)': /([\u4e00-\u9fa5]{2,4})[，,]\1/,
  '呼称「小X」':      /小[\u4e00-\u9fa5]{1,2}/,
  '含「我」':         /我/,
  '含「大家」':       /大家/,
  '含「一辈子」':      /一辈子/,
  '含「乐队」':       /乐队/,
  '含「歌」':         /歌/,
  '含「对不起/抱歉」': /对不起|抱歉/,
  '含「谢谢」':       /谢谢/,
  '含「不知道/不懂」': /不知道|不懂|不明白/,
  '含疑问「吗/呢/吧」': /[吗呢吧][？?]?$/,
  '假设/让步「要是/如果/就算/即使」': /要是|如果|就算|即使|哪怕/,
  '因果自陈「因为」':  /因为/,
  '含具体生物名(企鹅/西瓜虫/…':  /企鹅|西瓜虫|石头|星星|创可贴|橡果|独角仙|花|树叶/,
};
stats.标记率 = Object.fromEntries(
  Object.entries(patterns).map(([k, re]) => [k, `${count(speech, re)}/${N} = ${pct(count(speech, re), N)}`])
);

/* 呼称统计（分对象） */
const addrNames = ['小爱音', '小爱', '小立希', '小爽世', '小乐奈', '小祥子', '小祥', '小睦', '小乐', '祥子'];
stats.呼称 = {};
for (const a of addrNames) {
  const n = count(items, new RegExp(a));
  if (n) stats.呼称[a] = n;
}

/* 高频词（2-4 字词，滑窗计数，去停用） */
const STOP = new Set('我也是的了不啊嗯诶那个什么这样那样这里那里但是因为所以真的可以没有还是就是一起大家一个如果要是'.split(''));
const grams = new Map();
for (const it of speech) {
  const t = it.text.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let n = 2; n <= 3; n++)
    for (let i = 0; i + n <= t.length; i++) {
      const g = t.slice(i, i + n);
      if (STOP.has(g)) continue;
      grams.set(g, (grams.get(g) || 0) + 1);
    }
}
const gTop = [...grams.entries()].filter(([, v]) => v >= 5).sort((a, b) => b[1] - a[1]).slice(0, 45);
stats.高频词 = gTop;

/* 分关系差异：按剧本标题里的「X&Y」分组 */
const byRel = new Map();
for (const it of items) {
  if (it.kind === 'silent') continue;
  const m = it.sec.match(/^灯&(爱音|乐奈|爽世|立希)\s*\d+$/);
  if (!m) continue;
  const partner = m[1];
  if (!byRel.has(partner)) byRel.set(partner, []);
  byRel.get(partner).push(it);
}
stats.分关系 = {};
for (const [p, list] of byRel) {
  const sp = list.filter(i => i.kind !== 'lyric');
  const L = sp.map(i => lenCJK(i.text));
  stats.分关系[p] = {
    条数: list.length,
    均长: (L.reduce((a, b) => a + b, 0) / L.length).toFixed(1),
    省略号率: pct(count(sp, /…/), sp.length),
    疑问率: pct(count(sp, /？/), sp.length),
    感叹率: pct(count(sp, /！/), sp.length),
  };
}

/* 分类别：直接按剧本分类，避免把"文本类型差异"误读成"阶段差异" */
const cats = [...new Set(items.map(i => i.cat).filter(Boolean))];
stats.分类别 = {};
for (const c of cats) {
  const all = items.filter(i => i.cat === c);
  const sp = all.filter(i => i.kind === 'speech');
  const L = sp.map(i => lenCJK(i.text));
  const sil = all.filter(i => i.kind === 'silent' || i.kind === 'silentp').length;
  stats.分类别[c] = {
    总数: all.length,
    台词: sp.length,
    无文字条目: sil,
    沉默占比: pct(sil, all.length),
    均长: L.length ? (L.reduce((a, b) => a + b, 0) / L.length).toFixed(1) : '—',
    省略号率: pct(count(sp, /…/), sp.length),
    疑问率: pct(count(sp, /？/), sp.length),
  };
}

/* 歌词层：她的另一个语域 */
const LL = lyrics.map(i => lenCJK(i.text));
stats.歌词层 = {
  条数: lyrics.length,
  均长: LL.length ? (LL.reduce((a, b) => a + b, 0) / LL.length).toFixed(1) : '—',
  最长: LL.length ? Math.max(...LL) : 0,
  省略号率: pct(count(lyrics, /…/), lyrics.length),
  疑问率: pct(count(lyrics, /？/), lyrics.length),
  含我: pct(count(lyrics, /我/), lyrics.length),
  含人类: pct(count(lyrics, /人类/), lyrics.length),
};

/* ---------- 输出 ---------- */
if (asJson) { console.log(JSON.stringify(stats, null, 2)); process.exit(0); }

const L = [];
const P = s => L.push(s);
P(`# ${file.split(/[\\/]/).pop()} — 语言指纹统计\n`);
P(`- 条目总数 **${stats.total}**：（${Object.entries(stats.breakdown).map(([k, v]) => `${k} ${v}`).join(' / ')}）\n`);
P(`## 沉默分层\n`);
for (const [k, v] of Object.entries(stats.沉默)) P(`- **${k}**：${v}`);
P(`\n## 句长（仅台词，n=${N}；口径 ${stats.句长.口径}）\n`);
P(`| 均值 | 中位数 | 最长 | ≤6字 | ≥25字 |`);
P(`|---|---|---|---|---|`);
P(`| ${stats.句长.均值} | ${stats.句长.中位数} | ${stats.句长.最长} | ${stats.句长['≤6字占比']} | ${stats.句长['≥25字占比']} |\n`);
P(`## 标记率\n`);
P(`| 标记 | 计数 |`);
P(`|---|---|`);
for (const [k, v] of Object.entries(stats.标记率)) P(`| ${k} | ${v} |`);
P(`\n## 呼称\n`);
P(Object.entries(stats.呼称).map(([k, v]) => `- ${k} × ${v}`).join('\n'));
P(`\n## 分关系（羁绊剧情内对比）\n`);
P(`| 对象 | 条数 | 均长 | 省略号率 | 疑问率 | 感叹率 |`);
P(`|---|---|---|---|---|---|`);
for (const [k, v] of Object.entries(stats.分关系)) P(`| ${k} | ${v.条数} | ${v.均长} | ${v.省略号率} | ${v.疑问率} | ${v.感叹率} |`);
P(`\n## 分类别（避免把文本类型差异误读为阶段差异）\n`);
P(`| 分类 | 条目 | 台词 | 无文字 | 沉默占比 | 均长 | 省略号率 | 疑问率 |`);
P(`|---|---|---|---|---|---|---|---|`);
for (const [k, v] of Object.entries(stats.分类别)) P(`| ${k} | ${v.总数} | ${v.台词} | ${v.无文字条目} | ${v.沉默占比} | ${v.均长} | ${v.省略号率} | ${v.疑问率} |`);
P(`\n## 歌词层（另一语域）\n`);
P(`- 条数 ${stats.歌词层.条数} ｜ 均长 ${stats.歌词层.均长} ｜ 最长 ${stats.歌词层.最长} ｜ 省略号率 ${stats.歌词层.省略号率} ｜ 疑问率 ${stats.歌词层.疑问率} ｜ 含「我」${stats.歌词层.含我} ｜ 含「人类」${stats.歌词层.含人类}`);
P(`\n## 高频 2-3 字串（≥5 次，前 45）\n`);
P(gTop.map(([g, v]) => `${g}(${v})`).join(' · '));
console.log(L.join('\n'));
