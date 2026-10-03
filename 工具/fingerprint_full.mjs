#!/usr/bin/env node
/**
 * fingerprint_full.mjs —— 由**全量归属语料**重算 30 人语言指纹，并重建横向对比表
 *
 * 输入：素材全量/按角色全量/zh-Hans/{短名}_{全名}.md（工具/corpus_attribute.mjs 的产物）
 * 产出：
 *   角色模型/指纹/{短名}_{全名}_语言指纹报告.md   × 30（口径与 persona_stats.mjs 一致，追加显式 疑问率/感叹率 行）
 *   角色模型/_全角色指纹对比.md                    30 人横向对比（persona_compare 旧表只有 25 人）
 *
 * 与 persona_stats.mjs 的关系：解析与统计口径**逐行对齐**（句长=纯汉字、标记率分母=台词条目数），
 * 差异只有三点：① 语料是全量归属产物；② 显式输出 疑问率/感叹率（build_kb.parseFingerprint 直接取值）；
 * ③ 呼称表扩为 30 人「小X」全集（不影响 who 打分维度）。
 *
 * 用法：node 工具/fingerprint_full.mjs [--dry]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WS } from './_root.mjs';

const DRY = process.argv.includes('--dry');
const DENSE_DIR = join(WS, '素材全量', '按角色全量', 'zh-Hans');
const FP_DIR = join(WS, '角色模型', '指纹');
const KB = JSON.parse(readFileSync(join(WS, '资料库', 'kb.json'), 'utf8'));

const roster = KB.characters.map((c) => {
  const m = String(c.doc || '').match(/([^/\\]+)_角色扮演模型\.md$/);
  const base = m ? m[1] : `${c.name_short}_${c.name_short}`;
  const parts = base.split('_');
  return { id: c.id, short: c.name_short, full: parts.slice(1).join('_') || c.name_short, base };
});

/* ---------- 解析（与 persona_stats.mjs 同口径） ---------- */
/* 口径开关：'条目' = 清单项合并换行（旧口径，kb/文档曾用）；
 *           '行'   = 一个物理行算一条（新口径，与 who 打分器、模型生成单位同尺）。
 * 2026-10-03 定案：默认'行'。改回旧口径用 --口径=条目。
 */
const DENSE_MODE = (process.argv.find((a) => a.startsWith('--口径=')) || '').split('=')[1] === '条目' ? '条目' : '行';

function parseDense(text) {
  const raw = text.split(/\r?\n/);
  const sections = [];
  let cur = null, entry = null, skip = false;
  const closeEntry = () => { if (entry && cur) cur.lines.push(entry.trim()); entry = null; };
  const closeSection = () => { closeEntry(); if (cur) sections.push(cur); cur = null; };
  for (const line of raw) {
    if (/^##\s/.test(line)) {
      closeSection();
      const title = line.replace(/^##\s+/, '').trim();
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
    if (/^-\s/.test(line)) {
      /* 条目模式：`- ` 起新条目；行模式：`- ` 只是该行内容前缀 */
      if (DENSE_MODE === '条目') { closeEntry(); entry = line.replace(/^-\s+/, ''); }
      else { closeEntry(); if (cur) cur.lines.push(line.replace(/^-\s+/, '').trim()); }
      continue;
    }
    if (line.trim() === '') { closeEntry(); continue; }
    if (entry !== null) entry += '\n' + line.replace(/\s+$/, '');
  }
  closeSection();
  return sections;
}

const isLyric = (s) => /^『[\s\S]*』$/.test(s.trim()) || /^[『♪♪]/.test(s.trim());
const isSilent = (s) => /^[…\s]*$/.test(s) && /…/.test(s);
const isSilentP = (s) => /^[…\s、，。？！?！]*$/.test(s) && /…/.test(s) && !isSilent(s);
const isThought = (s) => /^（[\s\S]*）$/.test(s.trim());

const count = (arr, re) => arr.filter((x) => re.test(x.text)).length;
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '0%');
const lenCJK = (s) => (s.match(/[\u4e00-\u9fa5]/g) || []).length;
const lenOf = (s) => s.replace(/[\s\u3000]/g, '').length;

const PATTERNS = {
  '含省略号…': /…/,
  '以…结尾': /…$/,
  '纯省略号行': /^[…\s]*$/,
  '含？！': /[？！]/,
  '以？结尾': /？$/,
  '以！结尾': /！$/,
  '疑问率': /？/,
  '感叹率': /！/,
  '单字重复口吃(小、小)': /([\u4e00-\u9fa5])、\1/,
  '叠词(好难受，好难受)': /([\u4e00-\u9fa5]{2,4})[，,]\1/,
  '呼称「小X」': /小[\u4e00-\u9fa5]{1,2}/,
  '含「我」': /我/,
  '含「大家」': /大家/,
  '含「一辈子」': /一辈子/,
  '含「乐队」': /乐队/,
  '含「歌」': /歌/,
  '含「对不起/抱歉」': /对不起|抱歉/,
  '含「谢谢」': /谢谢/,
  '含「不知道/不懂」': /不知道|不懂|不明白/,
  '含疑问「吗/呢/吧」': /[吗呢吧][？?]?$/,
  '假设/让步「要是/如果/就算/即使」': /要是|如果|就算|即使|哪怕/,
  '因果自陈「因为」': /因为/,
  '含具体生物名(企鹅/西瓜虫/…': /企鹅|西瓜虫|石头|星星|创可贴|橡果|独角仙|花|树叶/,
};

const STOP = new Set('我也是的了不啊嗯诶那个什么这样那样这里那里但是因为所以真的可以没有还是就是一起大家一个如果要是'.split(''));
/** 指标串 → 数值（'11.9（14.6）' 取 11.9）。 */
const num = (s) => Number(String(s).match(/-?\d+(?:\.\d+)?/)?.[0] ?? 0);
/** 标记率串（'416/887 = 46.9%'）→ **百分比**，不是计数。 */
const pctOf = (s) => Number(String(s).match(/([\d.]+)\s*%/)?.[1] ?? 0);

function computeStats(file, ch) {
  const sections = parseDense(readFileSync(file, 'utf8'));
  const items = [];
  for (const sec of sections) for (const s of sec.lines) {
    const t = s.replace(/\n/g, '');
    const kind = isLyric(t) ? 'lyric' : isThought(t) ? 'thought'
      : isSilent(t) ? 'silent' : isSilentP(t) ? 'silentp' : 'speech';
    items.push({ sec: sec.title, cat: sec.cat, kind, text: t });
  }
  const speech = items.filter((i) => i.kind === 'speech');
  const lyrics = items.filter((i) => i.kind === 'lyric');
  const silent = items.filter((i) => i.kind === 'silent');
  const silentP = items.filter((i) => i.kind === 'silentp');
  const thought = items.filter((i) => i.kind === 'thought');

  const lens = speech.map((i) => lenCJK(i.text)).filter((x) => x > 0).sort((a, b) => a - b);
  const lensP = speech.map((i) => lenOf(i.text)).filter((x) => x > 0).sort((a, b) => a - b);
  const N = speech.length;
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  const 标记率 = Object.fromEntries(Object.entries(PATTERNS).map(([k, re]) => [k, `${count(speech, re)}/${N} = ${pct(count(speech, re), N)}`]));

  /* 呼称：persona_stats 原表 + 30 人「小X」全集（不影响 who 维度） */
  const addrNames = [...new Set(['小爱音', '小爱', '小立希', '小爽世', '小乐奈', '小祥子', '小祥', '小睦', '小乐', '祥子', ...roster.map((r) => `小${r.short}`)])];
  const 呼称 = {};
  for (const a of addrNames) {
    const n = items.filter((i) => i.text.includes(a)).length;
    if (n) 呼称[a] = n;
  }

  /* 分关系：剧本标题形如「灯&爱音 1」 */
  const byRel = new Map();
  for (const it of items) {
    if (it.kind === 'silent') continue;
    const m = String(it.sec).match(/^(.+?)&(.+?)(?:\s*\d+)?$/);
    if (!m) continue;
    const [a, b] = [m[1].trim(), m[2].trim()];
    const mine = [a, b].find((x) => x === ch.short || x === ch.full);
    if (!mine) continue;
    const partner = mine === a ? b : a;
    if (!byRel.has(partner)) byRel.set(partner, []);
    byRel.get(partner).push(it);
  }
  const 分关系 = {};
  for (const [p, list] of byRel) {
    const sp = list.filter((i) => i.kind !== 'lyric');
    if (!sp.length) continue;
    const L = sp.map((i) => lenCJK(i.text));
    分关系[p] = {
      条数: list.length,
      均长: avg(L).toFixed(1),
      省略号率: pct(count(sp, /…/), sp.length),
      疑问率: pct(count(sp, /？/), sp.length),
      感叹率: pct(count(sp, /！/), sp.length),
    };
  }

  /* 分类别 */
  const cats = [...new Set(items.map((i) => i.cat).filter(Boolean))];
  const 分类别 = {};
  for (const c of cats) {
    const all = items.filter((i) => i.cat === c);
    const sp = all.filter((i) => i.kind === 'speech');
    const L = sp.map((i) => lenCJK(i.text));
    const sil = all.filter((i) => i.kind === 'silent' || i.kind === 'silentp').length;
    分类别[c] = {
      总数: all.length, 台词: sp.length, 无文字条目: sil,
      沉默占比: pct(sil, all.length),
      均长: L.length ? avg(L).toFixed(1) : '—',
      省略号率: pct(count(sp, /…/), sp.length),
      疑问率: pct(count(sp, /？/), sp.length),
    };
  }

  /* 歌词层 */
  const LL = lyrics.map((i) => lenCJK(i.text));
  const 歌词层 = {
    条数: lyrics.length,
    均长: LL.length ? avg(LL).toFixed(1) : '—',
    最长: LL.length ? Math.max(...LL) : 0,
    省略号率: pct(count(lyrics, /…/), lyrics.length),
    疑问率: pct(count(lyrics, /？/), lyrics.length),
    含我: pct(count(lyrics, /我/), lyrics.length),
    含人类: pct(count(lyrics, /人类/), lyrics.length),
  };

  /* 高频 2-3 字串 */
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

  const scripts = new Set(sections.map((s) => s.advId).filter(Boolean));
  return {
    items, speech, lyrics, silent, silentP, thought, N,
    句长: {
      均值: `${avg(lens).toFixed(1)}（${avg(lensP).toFixed(1)}）`,
      中位数: lens[Math.floor(lens.length / 2)] ?? 0,
      最长: lens.length ? lens[lens.length - 1] : 0,
      '≤6字占比': pct(lens.filter((x) => x <= 6).length, lens.length),
      '≥25字占比': pct(lens.filter((x) => x >= 25).length, lens.length),
    },
    标记率, 呼称, 分关系, 分类别, 歌词层, gTop,
    scripts: scripts.size,
    沉默率: (100 * silent.length / Math.max(items.length, 1)),
  };
}

function renderReport(ch, st) {
  const L = [];
  L.push(`# ${ch.base}_语言指纹报告.md — 语言指纹统计`, '');
  L.push(`> 语料：\`素材全量/按话/zh-Hans\` 全量归属（946 话）｜ 本角色 **${st.items.length} 条**（台词 ${st.N}）｜ 出自 **${st.scripts}** 个剧本`);
  L.push('> 归属口径：简称/全名/别名/舞台名**精确匹配**，联句计入双方；初音（独立人物）、小萤（keepSeparate）不并入。生成 `工具/fingerprint_full.mjs`', '');
  L.push(`- 条目总数 **${st.items.length}**：（台词 ${st.N} / 歌词 ${st.lyrics.length} / 心声 ${st.thought.length} / 纯省略号 ${st.silent.length} / 省略号加标点 ${st.silentP.length}）`, '');
  L.push('## 沉默分层', '');
  L.push(`- **纯省略号（只含…）**：${st.silent.length}/${st.items.length} = ${pct(st.silent.length, st.items.length)}`);
  L.push(`- **省略号加标点（如……？）**：${st.silentP.length}/${st.items.length} = ${pct(st.silentP.length, st.items.length)}`);
  L.push(`- **合计无文字条目**：${st.silent.length + st.silentP.length}/${st.items.length} = ${pct(st.silent.length + st.silentP.length, st.items.length)}`, '');
  L.push(`## 句长（仅台词，n=${st.N}；口径 纯汉字（括号内为含标点口径））`, '');
  L.push('| 均值 | 中位数 | 最长 | ≤6字 | ≥25字 |');
  L.push('|---|---|---|---|---|');
  L.push(`| ${st.句长.均值} | ${st.句长.中位数} | ${st.句长.最长} | ${st.句长['≤6字占比']} | ${st.句长['≥25字占比']} |`, '');
  L.push('## 标记率', '');
  L.push('| 标记 | 计数 |');
  L.push('|---|---|');
  for (const [k, v] of Object.entries(st.标记率)) L.push(`| ${k} | ${v} |`);
  L.push('', '## 呼称', '');
  L.push(Object.entries(st.呼称).map(([k, v]) => `- ${k} × ${v}`).join('\n') || '-（无）');
  L.push('', '## 分关系（羁绊剧情内对比）', '');
  L.push('| 对象 | 条数 | 均长 | 省略号率 | 疑问率 | 感叹率 |');
  L.push('|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(st.分关系)) L.push(`| ${k} | ${v.条数} | ${v.均长} | ${v.省略号率} | ${v.疑问率} | ${v.感叹率} |`);
  L.push('', '## 分类别（避免把文本类型差异误读为阶段差异）', '');
  L.push('| 分类 | 条目 | 台词 | 无文字 | 沉默占比 | 均长 | 省略号率 | 疑问率 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(st.分类别)) L.push(`| ${k} | ${v.总数} | ${v.台词} | ${v.无文字条目} | ${v.沉默占比} | ${v.均长} | ${v.省略号率} | ${v.疑问率} |`);
  L.push('', '## 歌词层（另一语域）', '');
  L.push(`- 条数 ${st.歌词层.条数} ｜ 均长 ${st.歌词层.均长} ｜ 最长 ${st.歌词层.最长} ｜ 省略号率 ${st.歌词层.省略号率} ｜ 疑问率 ${st.歌词层.疑问率} ｜ 含「我」${st.歌词层.含我} ｜ 含「人类」${st.歌词层.含人类}`);
  L.push('', '## 高频 2-3 字串（≥5 次，前 45）', '');
  L.push(st.gTop.map(([g, v]) => `${g}(${v})`).join(' · ') || '（小样本，未达 ≥5 阈值，从略）');
  L.push('');
  return L.join('\n');
}

/* ---------- 主流程 ---------- */
const rows = [];
const skipped = [];
if (!DRY) mkdirSync(FP_DIR, { recursive: true });

for (const ch of roster) {
  const file = join(DENSE_DIR, `${ch.base}.md`);
  if (!existsSync(file)) { skipped.push({ ...ch, reason: '无语料（保持原报告）' }); continue; }
  const st = computeStats(file, ch);
  if (!st.items.length || !st.N) { skipped.push({ ...ch, reason: '条目/台词为 0（保持原报告）' }); continue; }
  rows.push({
    id: ch.id, short: ch.short, full: ch.full, base: ch.base,
    '角色': ch.short,
    条数: st.items.length, 台词: st.N,
    沉默占比: st.沉默率, 均长: num(st.句长.均值),
    '≤6字%': pctOf(st.句长['≤6字占比']),
    省略号率: pctOf(st.标记率['含省略号…']),
    疑问率: pctOf(st.标记率['疑问率']),
    感叹率: pctOf(st.标记率['感叹率']),
    口吃率: pctOf(st.标记率['单字重复口吃(小、小)']),
    呼称小X率: pctOf(st.标记率['呼称「小X」']),
  });
  if (!DRY) writeFileSync(join(FP_DIR, `${ch.base}_语言指纹报告.md`), renderReport(ch, st), 'utf8');
}

/* ---------- 对比表 ---------- */
const fmt = (v) => (typeof v === 'number' ? v.toFixed(1) : v);
const cols = ['角色', '台词', '沉默占比', '均长', '≤6字%', '省略号率', '疑问率', '感叹率', '口吃率', '呼称小X率'];
const sorted = [...rows].sort((a, b) => b.台词 - a.台词);
const T = [];
T.push('# 全角色语言指纹横向对比', '');
T.push(`> 由 \`工具/fingerprint_full.mjs\` 生成 ｜ 数据源 \`素材全量/按话/zh-Hans\` 全量归属（946 话）｜ 共 ${sorted.length} 名角色`);
T.push('> **口径**：分母为「台词条目数」；句长=纯汉字；疑问率/感叹率=行内含「？」/「！」的比率。旧表由 `persona_compare.mjs` 生成、只覆盖 25 人——本表覆盖全部有语料的角色。', '');
T.push('| ' + cols.join(' | ') + ' |');
T.push('|' + cols.map(() => '---').join('|') + '|');
for (const r of sorted) T.push('| ' + cols.map((c) => fmt(r[c])).join(' | ') + ' |');
T.push('', '## 关键读法', '');
const rank = (k, asc = false) => [...sorted].sort((a, b) => (asc ? a[k] - b[k] : b[k] - a[k]));
const show = (k, label, unit = '') => {
  T.push(`- **${label}**：最高 ${rank(k).slice(0, 3).map((r) => `${r.short} ${fmt(r[k])}${unit}`).join(' · ')} ｜ 最低 ${rank(k).slice(-3).map((r) => `${r.short} ${fmt(r[k])}${unit}`).join(' · ')}`);
};
show('省略号率', '省略号率', '%');
show('沉默占比', '纯沉默占比', '%');
show('均长', '平均句长', ' 字');
show('口吃率', '首字口吃率', '%');
show('呼称小X率', '「小X」呼称率', '%');
show('感叹率', '感叹号率', '%');
const median = (k) => { const v = sorted.map((r) => r[k]).sort((a, b) => a - b); const m = v.length / 2; return v.length % 2 ? v[Math.floor(m)] : (v[m - 1] + v[m]) / 2; };
const MEDS = {};
for (const k of ['省略号率', '沉默占比', '均长', '≤6字%', '疑问率', '感叹率', '口吃率', '呼称小X率']) MEDS[k] = median(k);
T.push('', '## 每人语言签名（相对中位数的偏离）', '');
T.push('> 某指标超过中位数 1.4 倍或不足 0.7 倍即视为语言签名。', '');
T.push('| 角色 | 语言签名（显著向上 ↑ / 显著向下 ↓） |');
T.push('|---|---|');
for (const r of sorted) {
  const sig = [];
  for (const [k, tag] of [['省略号率', '省略号'], ['沉默占比', '沉默'], ['均长', '句长'], ['感叹率', '感叹'], ['疑问率', '疑问'], ['口吃率', '口吃'], ['呼称小X率', '小X呼称'], ['≤6字%', '短句']]) {
    if (!MEDS[k]) continue;
    const ratio = r[k] / MEDS[k];
    if (k === '均长' || k === '≤6字%') { if (ratio <= 0.67) sig.push(`${tag}↓(${fmt(r[k])})`); }
    else if (ratio >= 1.4) sig.push(`${tag}↑(${fmt(r[k])})`);
  }
  T.push(`| ${r.short} | ${sig.length ? sig.join(' ') : '—（接近默认腔）'} |`);
}
T.push('');
if (!DRY) writeFileSync(join(WS, '角色模型', '_全角色指纹对比.md'), T.join('\n'), 'utf8');

if (DRY) {
  console.log(`[dry] 可重算角色 ${rows.length}/30 ｜ 跳过 ${skipped.length}`);
  console.log('id | 短名 | 条数 | 台词 | 均长 | 省略号率 | 疑问率 | 感叹率 | 沉默占比');
  for (const r of rows) console.log([r.id, r.short, r.条数, r.台词, fmt(r.均长), fmt(r.省略号率), fmt(r.疑问率), fmt(r.感叹率), fmt(r.沉默占比)].join(' | '));
  for (const s of skipped) console.log(`SKIP ${s.id} ${s.short} — ${s.reason}`);
} else {
  console.log(`已重写 ${rows.length} 份指纹报告 → 角色模型/指纹/`);
  console.log(`已重建对比表（${rows.length} 人）→ 角色模型/_全角色指纹对比.md`);
  for (const s of skipped) console.log(`跳过 ${s.short}：${s.reason}`);
}
