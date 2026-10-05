#!/usr/bin/env node
/**
 * 语域分档.mjs —— 把「一人一套全局指纹」拆成「指纹指标 × 语域档」矩阵（阶段 4 正式资产）
 *
 * 为什么：`归档/_临时诊断/条件风格分析.mjs` 证明换语域（剧情类别）比换对话对象的影响大一个量级，
 * 而 `角色模型/指纹/` 只有全局均值——拿主线均值去演日常，处处差一点。本脚本把诊断变成可引用、可复算的资产。
 *
 * 数据源：`素材全量/按角色全量/zh-Hans/*.md`（即 fingerprint_full.mjs 的 DENSE_DIR，与 `角色模型/指纹/` 同源；
 *   只有同源才能保证「各档加权回全局 = 指纹报告登记值」这条自检成立）。人名/短名一律取 `工具/角色表.mjs`。
 * 口径：**行级**（一句 = 语料里的一行 `- ` 台词），与 `--口径=行` 的 fingerprint_full 一致；
 *   不按「…」断句——本语料 36~48% 的行含省略号，它是停顿标记不是句末。
 * 指标集：与 fingerprint_full 对比表同一套（均长 / ≤6字 / ≥25字 / 省略号 / 疑问 / 感叹 / 口吃 / 小X / 沉默占比）。
 *
 * 用法：
 *   node 工具/语域分档.mjs            # 生成 角色模型/语域/{短名}_{全名}_语域分档.md × N + 汇总 + JSON
 *   node 工具/语域分档.mjs --check    # 不写文件，只校验现有资产与语料/指纹是否漂移（漂移退非 0）
 *   node 工具/语域分档.mjs --dry      # 不写文件，只打印验收结果
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { WS, CHARS, EXTRA_CHARS, corpusOf, fpOf } from './角色表.mjs';

const CHECK = process.argv.includes('--check');
const DRY = process.argv.includes('--dry');
const OUT_DIR = join(WS, '角色模型', '语域');
const DENSE_DIR = join(WS, '素材全量', '按角色全量', 'zh-Hans');

/* ── 门槛（写进产物，供引用方判断哪一格能用）──
 * 40 行：二项比例最坏情形（p=0.5）的 95% 置信半宽 = 1.96·√(0.25/40) = 9.8 点 < 本项目「≥10 点才算差异」验收线。
 * 15 行：最坏半宽 25.3 点，任何数值都解释不了 —— 禁引地板。 */
const 可引用最小n = 40;
const 禁引最小n = 15;

/* ── 解析（逐行对齐 fingerprint_full.mjs 的 parseDense 行级口径）── */
const isLyric = (s) => /^『[\s\S]*』$/.test(s.trim()) || /^[『♪♪]/.test(s.trim());
const isSilent = (s) => /^[…\s]*$/.test(s) && /…/.test(s);
const isSilentP = (s) => /^[…\s、，。？！?！]*$/.test(s) && /…/.test(s) && !isSilent(s);
const isThought = (s) => /^（[\s\S]*）$/.test(s.trim());
const lenCJK = (s) => (s.match(/[\u4e00-\u9fa5]/g) || []).length;

function parseDenseLines(text) {
  const out = [];
  let cat = '', advId = '', skip = false, ln = 0;
  for (const line of text.split(/\r?\n/)) {
    ln++;
    if (/^##\s/.test(line)) {
      const title = line.replace(/^##\s+/, '').trim();
      skip = title === '出处目录';
      cat = ''; advId = '';
      continue;
    }
    if (skip) continue;
    if (/^<sub>/.test(line)) {
      const m = line.match(/^<sub>\s*(.+?)\s*｜\s*advId\s*(\d+)/);
      if (m) { cat = m[1].trim(); advId = m[2]; }
      continue;
    }
    if (/^#\s/.test(line) || /^>/.test(line) || /^---/.test(line) || /^\*\*/.test(line)) continue;
    if (/^-\s/.test(line)) {
      const t = line.replace(/^-\s+/, '').trim();
      const kind = isLyric(t) ? 'lyric' : isThought(t) ? 'thought' : isSilent(t) ? 'silent' : isSilentP(t) ? 'silentp' : 'speech';
      out.push({ cat: cat || '未标注', advId, ln, kind, text: t });
    }
  }
  return out;
}

/* ── 语域档：先看语料里实际存在什么类别标签，再归并（规格里的五档是目标，不是硬套）── */
const 未归名 = new Set();
function 档名(cat) {
  if (cat.startsWith('主线/')) return '主线';
  if (cat === '其它剧情' || cat === '教程') return '其它';
  if (cat === '羁绊剧情' || cat === '演出结束对话' || cat === '主页剧情') return cat;
  未归名.add(cat);
  return cat;
}
const 档序 = ['主线', '羁绊剧情', '演出结束对话', '主页剧情', '其它'];

/* ── 指标（与 fingerprint_full 的 PATTERNS / 句长表同一套正则、同一分母）── */
const RE = {
  省略号率: /…/,
  疑问率: /？/,
  感叹率: /！/,
  口吃率: /([\u4e00-\u9fa5])、\1/,
  小X率: /小[\u4e00-\u9fa5]{1,2}/,
};
const 率指标 = ['省略号率', '疑问率', '感叹率', '口吃率', '小X率'];
const 指标序 = ['均长', '≤6字占比', '≥25字占比', ...率指标, '沉默占比'];
const 单位 = { 均长: '字', '≤6字占比': '%', '≥25字占比': '%', 省略号率: '%', 疑问率: '%', 感叹率: '%', 口吃率: '%', 小X率: '%', 沉默占比: '%' };

function 新格() { return { 台词: 0, 条目: 0, 含汉字: 0, 长度和: 0, 长度平方和: 0, '≤6字占比': 0, '≥25字占比': 0, 省略号率: 0, 疑问率: 0, 感叹率: 0, 口吃率: 0, 小X率: 0, 沉默: 0 }; }
function 累加(g, it) {
  g.条目++;
  if (it.kind === 'silent') g.沉默++;
  if (it.kind !== 'speech') return;
  g.台词++;
  const L = lenCJK(it.text);
  if (L > 0) {
    g.含汉字++; g.长度和 += L; g.长度平方和 += L * L;
    if (L <= 6) g['≤6字占比']++;
    if (L >= 25) g['≥25字占比']++;
  }
  for (const k of 率指标) if (RE[k].test(it.text)) g[k]++;
}
/** 指标值 + 命中/分母 + 95% 置信半宽（比率用二项，均长用正态近似） */
function 值(g, k) {
  let hit, den;
  if (k === '均长') { hit = g.长度和; den = g.含汉字; }
  else if (k === '≤6字占比' || k === '≥25字占比') { hit = g[k]; den = g.含汉字; }
  else if (k === '沉默占比') { hit = g.沉默; den = g.条目; }
  else { hit = g[k]; den = g.台词; }
  if (!den) return { 值: null, 命中: hit, 分母: 0, 半宽: null };
  if (k === '均长') {
    const m = hit / den;
    const varr = Math.max(g.长度平方和 / den - m * m, 0);
    return { 值: m, 命中: hit, 分母: den, 半宽: 1.96 * Math.sqrt(varr / den) };
  }
  const p = hit / den;
  return { 值: 100 * p, 命中: hit, 分母: den, 半宽: 1.96 * 100 * Math.sqrt(p * (1 - p) / den) };
}
const f1 = (v) => (v == null ? '—' : v.toFixed(1));
function 判定(台词n) {
  return 台词n >= 可引用最小n ? '可引用' : 台词n >= 禁引最小n ? '谨慎' : '禁引';
}

/* ── 逐人计算 ── */
const 名册 = [...CHARS, ...EXTRA_CHARS].map((c) => ({
  ...c,
  corpus: c.corpus ? join(WS, c.corpus) : join(DENSE_DIR, basename(corpusOf(c))),
  fp: fpOf(c),
}));
const 标签映射 = {};
const 人物 = [];
const 缺语料 = [];
for (const c of 名册) {
  if (!existsSync(c.corpus)) { 缺语料.push(c.k); continue; }
  const items = parseDenseLines(readFileSync(c.corpus, 'utf8'));
  const 全局 = 新格();
  const 档集 = new Map();
  const 档标签 = {};
  for (const it of items) {
    累加(全局, it);
    const tier = 档名(it.cat);
    (标签映射[tier] ||= new Set()).add(it.cat);
    (档标签[tier] ||= new Set()).add(it.cat);
    if (!档集.has(tier)) 档集.set(tier, { 格: 新格(), 剧本: new Set(), 项: [] });
    累加(档集.get(tier).格, it);
    档集.get(tier).剧本.add(it.advId);
    档集.get(tier).项.push(it);
  }
  const 档列表 = [...档序.filter((t) => 档集.has(t)), ...[...档集.keys()].filter((t) => !档序.includes(t)).sort()]
    .map((t) => {
      const d = 档集.get(t);
      const 指标 = {};
      for (const k of 指标序) 指标[k] = 值(d.格, k);
      const 差 = {};
      for (const k of 指标序) {
        const g = 值(全局, k), v = 指标[k];
        const Δ = (g.值 == null || v.值 == null) ? null : v.值 - g.值;
        const 倍率 = k === '均长' && g.值 && v.值 != null ? v.值 / g.值 : null;
        const 带宽 = v.半宽 == null || g.半宽 == null ? null : v.半宽 + g.半宽;
        const 差项 = {
          Δ, 倍率, 带宽,
          强度: 带宽 ? Math.abs(Δ) / 带宽 : null,
          显著: Δ != null && 带宽 != null ? Math.abs(Δ) > 带宽 : null,
          幅度: k === '均长' ? (倍率 != null && (倍率 >= 1.3 || 倍率 <= 1 / 1.3)) : Δ != null && Math.abs(Δ) >= 10,
        };
        差项.超出噪声 = Δ != null && 差项.幅度 && 带宽 != null && Math.abs(Δ) > 带宽;
        差[k] = 差项;
      }
      return { 档: t, 样本: d.格.台词, 条目: d.格.条目, 剧本数: d.剧本.size, advId: [...d.剧本].sort((a, b) => a - b), 标签: [...档标签[t]].sort(), 指标, 差, 项: d.项 };
    });
  const 指标全局 = {};
  for (const k of 指标序) 指标全局[k] = 值(全局, k);
  /* 加权回全局：Σ命中 / Σ分母（档必须覆盖全部条目，否则这里就会露馅） */
  const 回加 = {};
  for (const k of 指标序) {
    let hit = 0, den = 0;
    for (const t of 档列表) { hit += t.指标[k].命中; den += t.指标[k].分母; }
    回加[k] = { 加权: den ? (k === '均长' ? hit / den : 100 * hit / den) : null, 全局命中: 指标全局[k].命中, 全局分母: 指标全局[k].分母, 档合计分母: den };
  }
  const 全部标签 = [...new Set(items.map((i) => i.cat))];
  const 剧本总数 = new Set(items.map((i) => i.advId)).size;
  人物.push({ 短名: c.k, 全名: c.full, 乐队码: c.g, dir: c.dir, band: c.band, 语料: c.corpus.slice(WS.length + 1).replace(/\\/g, '/'), 指纹报告: c.fp.slice(WS.length + 1).replace(/\\/g, '/'), 条目: 全局.条目, 台词: 全局.台词, 剧本数: 剧本总数, 标签: 全部标签.sort(), 指标: 指标全局, 档: 档列表, 回加 });
}

/* ── 校验：分档必须无遗漏、无重复覆盖 ── */
for (const p of 人物) {
  const s = p.档.reduce((a, t) => a + t.样本, 0), e = p.档.reduce((a, t) => a + t.条目, 0);
  if (s !== p.台词 || e !== p.条目) { console.log(`✗ ${p.短名} 档覆盖不全（台词 ${s}/${p.台词}，条目 ${e}/${p.条目}）`); process.exit(1); }
}

/* ── 与 `角色模型/指纹/` 登记值对账 ── */
function 读指纹登记(path) {
  if (!existsSync(path)) return null;
  const t = readFileSync(path, 'utf8');
  const 头 = t.match(/本角色 \*\*(\d+) 条\*\*（台词 (\d+)）/);
  const 句 = t.match(/^\| ([\d.]+)（[\d.]+） \| \d+ \| \d+ \| ([\d.]+)% \| ([\d.]+)% \|$/m);
  const 沉 = t.match(/- \*\*纯省略号（只含…）\*\*：(\d+)\/(\d+) = ([\d.]+)%/);
  const 标 = (name) => { const m = t.match(new RegExp(`^\\| ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| (\\d+)/(\\d+) = ([\\d.]+)%`, 'm')); return m ? Number(m[3]) : null; };
  return {
    条目: 头 ? +头[1] : null, 台词: 头 ? +头[2] : null,
    均长: 句 ? +句[1] : null, '≤6字占比': 句 ? +句[2] : null, '≥25字占比': 句 ? +句[3] : null,
    沉默占比: 沉 ? +沉[3] : null,
    省略号率: 标('含省略号…'), 疑问率: 标('疑问率'), 感叹率: 标('感叹率'),
    口吃率: 标('单字重复口吃(小、小)'), 小X率: 标('呼称「小X」'),
  };
}
const 自检 = [];
for (const p of 人物) {
  const reg = 读指纹登记(join(WS, p.指纹报告));
  const 项 = { 短名: p.短名, 登记在案: !!reg, 差: {} };
  for (const k of 指标序) {
    const mine = p.回加[k].加权;
    项.差[k] = { 我的加权: mine, 报告登记: reg ? reg[k] : null, 差: (reg && reg[k] != null && mine != null) ? +(mine - reg[k]).toFixed(2) : null };
  }
  自检.push(项);
}
const 自检超差 = [];
for (const s of 自检) {
  if (!s.登记在案) { 自检超差.push(`${s.短名}：指纹报告缺失`); continue; }
  for (const k of 指标序) {
    const d = s.差[k].差;
    if (d != null && Math.abs(d) > 0.05) 自检超差.push(`${s.短名} ${k}：加权 ${f1(s.差[k].我的加权)} ≠ 登记 ${f1(s.差[k].报告登记)}（差 ${d}）`);
  }
}

/* ── 验收：某档 vs 全局 差 ≥10 点（且超出噪声、非禁引格） ── */
const 达标 = [];
for (const p of 人物) {
  const 命中档 = [];
  for (const t of p.档) {
    if (t.样本 < 禁引最小n) continue;
    const 指标命中 = 指标序.filter((k) => t.差[k].超出噪声);
    if (指标命中.length) 命中档.push({ 档: t.档, 样本: t.样本, 判定: 判定(t.样本), 指标数: 指标命中.length, 指标: 指标命中.map((k) => `${k} ${f1(t.指标[k].值)}（全局 ${f1(p.指标[k].值)}，Δ${t.差[k].Δ > 0 ? '+' : ''}${f1(t.差[k].Δ)}${t.差[k].倍率 ? '，' + t.差[k].倍率.toFixed(2) + '×' : ''}）`) });
  }
  if (命中档.length) 达标.push({ 短名: p.短名, 档数: 命中档.length, 格数: 命中档.reduce((a, x) => a + x.指标数, 0), 明细: 命中档 });
}

/* ── 渲染：每人一份 ── */
const 表头 = ['语域档', 'n台词', 'n条目', '均长', '≤6字%', '≥25字%', '省略号率', '疑问率', '感叹率', '口吃率', '小X率', '沉默占比', '样本判定'];
function 行(名, 指标对象, g, n判) {
  const c = (k) => f1(指标对象[k].值);
  return `| ${名} | ${n判} | ${g} | ${c('均长')} | ${c('≤6字占比')} | ${c('≥25字占比')} | ${c('省略号率')} | ${c('疑问率')} | ${c('感叹率')} | ${c('口吃率')} | ${c('小X率')} | ${c('沉默占比')} | ${判定(n判)} |`;
}
function render人物(p) {
  const L = [];
  L.push(`# ${p.短名}_${p.全名}_语域分档.md — 指纹指标 × 语域档`, '');
  L.push(`> 由 \`工具/语域分档.mjs\` 生成（**纯本地算术**，零模型调用）｜数据源 \`${p.语料}\`（与 \`角色模型/指纹/\` 同源）｜口径＝**行级**（一句 = 一行台词）`);
  L.push(`> 本角色 条目 ${p.条目} ｜ 台词 ${p.台词} ｜ 出自 ${p.剧本数} 个剧本 ｜ 语料内类别标签：${p.标签.join('、')}`, '');
  L.push('> **样本门槛**：n台词 ≥ 40 可引用（最坏情形 95% 置信半宽 9.8 点 < 本项目「差异 ≥10 点」验收线）；15–39 谨慎（只可引方向）；< 15 **禁引**（最坏半宽 25.3 点）。');
  L.push('> **差异口径**：比率类指标以 |Δ| ≥ 10 点为「换档就换人」；均长以倍率 ≥1.3× / ≤0.77× 为界（单位是字，不适用「点」）。两者都还要 |Δ| 超出「档 + 全局」的 95% 置信半宽才记 ★。', '');
  L.push('## 一、矩阵', '');
  L.push('| ' + 表头.join(' | ') + ' |');
  L.push('|' + 表头.map(() => '---').join('|') + '|');
  L.push(行('**全局（对照）**', p.指标, p.条目, p.台词));
  for (const t of p.档) L.push(行(t.档, t.指标, t.条目, t.样本));
  L.push('', '> 分母：均长/≤6字/≥25字 = 该档**含汉字**台词行；各率 = 该档台词行；沉默占比 = 该档全部条目（含纯省略号）。', '');
  L.push('## 二、该档 vs 全局（按 |Δ| 降序；★＝幅度达标［比率 |Δ|≥10 点 / 均长倍率 ≥1.3× 或 ≤0.77×］且 |Δ| 大于「档＋全局」的 95% 置信半宽之和；○＝仅超出噪声带；强度＝Δ÷噪声带）', '');
  const 差行 = [];
  for (const t of p.档) for (const k of 指标序) if (t.差[k].Δ != null) 差行.push({ 档: t.档, 指标: k, Δ: t.差[k].Δ, 倍率: t.差[k].倍率, 强度: t.差[k].强度, 档值: t.指标[k].值, 全局: p.指标[k].值, 噪声: t.差[k].超出噪声, 显著: t.差[k].显著, 样本: t.样本, 判定: 判定(t.样本) });
  差行.sort((a, b) => Math.abs(b.Δ) - Math.abs(a.Δ) || a.档.localeCompare(b.档, 'zh') || a.指标.localeCompare(b.指标, 'zh'));
  L.push('| 语域档 | 指标 | n台词 | 该档 | 全局 | Δ | 倍率 | 强度(Δ/噪声带) | 判读 | 样本判定 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const d of 差行.slice(0, 22)) L.push(`| ${d.档} | ${d.指标} | ${d.样本} | ${f1(d.档值)} | ${f1(d.全局)} | ${d.Δ > 0 ? '+' : ''}${f1(d.Δ)} | ${d.倍率 == null ? '—' : d.倍率.toFixed(2) + '×'} | ${d.强度 == null ? '—' : d.强度.toFixed(1)} | ${d.噪声 ? '★ 换档就换人' : d.显著 ? '○ 超出噪声' : '— 噪声内'} | ${d.判定} |`);
  const 最 = 差行.filter((d) => d.噪声 && d.判定 !== '禁引').sort((a, b) => (b.强度 ?? 0) - (a.强度 ?? 0));
  L.push('', `**最该注意**：${最.length ? 最.slice(0, 3).map((d) => `${d.档}的${d.指标}（${f1(d.档值)}${单位[d.指标]}，全局 ${f1(d.全局)}${单位[d.指标]}，Δ${d.Δ > 0 ? '+' : ''}${f1(d.Δ)}，n=${d.样本}，${d.判定}）`).join('；') : '无（本角色各档与全局的差异都不超过噪声带）'}`, '');
  L.push('## 三、溯源（命中计数 / 剧本）', '');
  L.push('| 语域档 | 归并自标签 | 剧本数 | advId | 命中计数（省略/疑问/感叹/口吃/小X/沉默/含汉字） |');
  L.push('|---|---|---|---|---|');
  const 全局计数 = 率指标.map((k) => `${k.replace('率', '')} ${p.指标[k].命中}`).concat([`沉默 ${p.指标['沉默占比'].命中}`, `含汉字 ${p.指标['均长'].分母}`]).join(' / ');
  L.push(`| **全局** | ${p.标签.join(' + ')} | ${p.剧本数} | 全量 | ${全局计数} |`);
  for (const t of p.档) {
    const ids = t.advId;
    const 串 = ids.length <= 10 ? ids.join(' ') : `${ids.slice(0, 10).join(' ')} …共 ${ids.length} 个`;
    const 计 = 率指标.map((k) => `${k.replace('率', '')} ${t.指标[k].命中}`).concat([`沉默 ${t.指标['沉默占比'].命中}`, `含汉字 ${t.指标['均长'].分母}`]).join(' / ');
    L.push(`| ${t.档} | ${t.标签.join(' + ')} | ${t.剧本数} | ${串} | ${计} |`);
  }
  L.push('', '## 四、禁引 / 谨慎清单', '');
  const 弱 = p.档.filter((t) => t.样本 < 可引用最小n);
  if (!弱.length) L.push('- 无：本角色每档台词行均 ≥ ' + 可引用最小n);
  for (const t of 弱) L.push(`- ${t.档}：n台词 ${t.样本} → **${判定(t.样本)}**（禁止把本档数值写进人设规则${t.样本 < 禁引最小n ? '；样本过小，连方向都不成立' : '；只可作升降方向提示，引用须带 n'}）`);
  L.push('', '## 五、自检：各档按样本量加权回全局', '');
  L.push('| 指标 | 分档加权 | 直接全局 | 指纹报告登记 | 差 |');
  L.push('|---|---|---|---|---|');
  const reg = 读指纹登记(join(WS, p.指纹报告));
  for (const k of 指标序) {
    const w = p.回加[k].加权;
    L.push(`| ${k} | ${f1(w)} | ${f1(p.指标[k].值)} | ${reg && reg[k] != null ? f1(reg[k]) : '—'} | ${reg && reg[k] != null && w != null ? (w - reg[k]).toFixed(2) : '—'} |`);
  }
  L.push('', '> 加权式：Σ(档命中) / Σ(档分母)。各档分母之和必须等于全局分母（脚本启动即断言，覆盖不全直接退出）。', '');
  L.push('## 六、★ 格的行级样例（每格 3 条，供逐字回校；出处＝advId + 语料文件行号）', '');
  const 命中 = (k, it) => {
    if (k === '沉默占比') return it.kind === 'silent';
    if (it.kind !== 'speech') return false;
    if (RE[k]) return RE[k].test(it.text);
    const L2 = lenCJK(it.text);
    if (k === '≤6字占比') return L2 > 0 && L2 <= 6;
    if (k === '≥25字占比') return L2 >= 25;
    return true;
  };
  const 样例格 = 最.slice(0, 5);
  if (!样例格.length) L.push('- 本角色没有 ★ 格，无需样例。');
  for (const d of 样例格) {
    const t = p.档.find((x) => x.档 === d.档);
    let 候选 = t.项.filter((it) => 命中(d.指标, it));
    if (d.指标 === '均长') {
      const 全局均 = p.指标['均长'].值;
      候选 = [...候选].sort((a, b) => Math.abs(lenCJK(b.text) - 全局均) - Math.abs(lenCJK(a.text) - 全局均));
    } else 候选 = [...候选].sort((a, b) => a.advId - b.advId || a.ln - b.ln);
    L.push(`- **${d.档} · ${d.指标}**（该档 ${f1(d.档值)}${单位[d.指标]}，全局 ${f1(d.全局)}${单位[d.指标]}，Δ${d.Δ > 0 ? '+' : ''}${f1(d.Δ)}，n=${d.样本}，${d.判定}）：`);
    if (!候选.length) L.push(`  - 该档命中 **0/${t.指标[d.指标].分母}** 行——「一句都没有」本身就是证据（对照：全局命中 ${p.指标[d.指标].命中}/${p.指标[d.指标].分母}）；无样例可引。`);
    for (const it of 候选.slice(0, 3)) L.push(`  - advId ${it.advId}｜第 ${it.ln} 行｜${it.text}`);
  }
  L.push('');
  return L.join('\n');
}

/* ── 渲染：汇总 ── */
function render汇总() {
  const L = [];
  L.push('# 语域分档汇总 — 全员 × 语域档', '');
  L.push('> 由 \`工具/语域分档.mjs\` 生成（纯本地算术，零模型调用）｜口径＝行级｜数据源 \`素材全量/按角色全量/zh-Hans\`（与 \`角色模型/指纹/\` 同源）');
  L.push(`> 覆盖 ${人物.length} 人（${CHARS.length} 名乐队角色 ＋ ${人物.filter((p) => p.乐队码 === 'Sumi').length} 名附加角色）｜档：${档序.join(' / ')}${未归名.size ? ` ＋ 未归并标签：${[...未归名].join('、')}` : ''}`);
  L.push('> **样本门槛**：n台词 ≥ 40 可引用；15–39 谨慎（只可引方向）；< 15 禁引。理由见各人文件文内「样本门槛」。');
  L.push('> **差异口径**：比率类以 |Δ| ≥ 10 点为「换档就换人」；均长以倍率 ≥1.3×／≤0.77× 为界。两者都还要求 |Δ| 超出「档＋全局」的 95% 置信半宽（记 ★）。', '');
  L.push('## 一、语料实际类别标签 → 档的归并', '');
  L.push('| 档 | 归并自语料标签 | 覆盖人数 |');
  L.push('|---|---|---|');
  for (const t of 档序) {
    const 标签 = [...(标签映射[t] || [])].sort();
    L.push(`| ${t} | ${标签.join('、') || '—'} | ${人物.filter((p) => p.档.some((x) => x.档 === t)).length} |`);
  }
  for (const t of [...new Set(人物.flatMap((p) => p.档.map((x) => x.档)))].filter((t) => !档序.includes(t)).sort()) {
    L.push(`| ${t}（未归并） | ${[...(标签映射[t] || [])].sort().join('、')} | ${人物.filter((p) => p.档.some((x) => x.档 === t)).length} |`);
  }
  L.push('', '## 二、全员矩阵（每指标一张；括号＝n台词；n<15 的格标 ‼，15–39 标 ·）', '');
  const 星 = (t) => (t.样本 < 禁引最小n ? '‼' : t.样本 < 可引用最小n ? '·' : '');
  const 档列 = 档序.filter((t) => 人物.some((p) => p.档.some((x) => x.档 === t)));
  for (const k of ['均长', '疑问率', '省略号率', '感叹率', '≤6字占比', '口吃率', '沉默占比']) {
    L.push(`### ${k}${单位[k] === '%' ? '（%）' : '（字）'}`, '');
    L.push('| 角色 | 全局 | ' + 档列.join(' | ') + ' | 档间极差 |');
    L.push('|---|---|' + 档列.map(() => '---').join('|') + '|---|');
    const rows = 人物.map((p) => {
      const vs = 档列.map((t) => p.档.find((x) => x.档 === t));
      const nums = vs.map((t) => (t ? t.指标[k].值 : null)).filter((v) => v != null);
      const spread = nums.length >= 2 ? Math.max(...nums) - Math.min(...nums) : null;
      return { p, vs, spread };
    }).sort((a, b) => (b.spread ?? -1) - (a.spread ?? -1) || a.p.短名.localeCompare(b.p.短名, 'zh'));
    for (const r of rows) L.push(`| ${r.p.短名} | ${f1(r.p.指标[k].值)} | ` + r.vs.map((t) => (t ? `${f1(t.指标[k].值)}${星(t)}(${t.样本})` : '—')).join(' | ') + ` | ${r.spread == null ? '—' : f1(r.spread)} |`);
    L.push('');
  }
  L.push('## 三、「换档就换人」清单（★＝幅度达标［比率 Δ≥10 点 / 均长倍率 ≥1.3× 或 ≤0.77×］且 Δ 超出噪声带且 n≥15；按「强度＝Δ÷噪声带」排序）', '');
  L.push('| 角色 | 达标格数 | 最强一档 | 指标 | Δ | 倍率 | 强度 | n | 判定 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  const 强 = 人物.map((p) => {
    let best = null;
    for (const t of p.档) {
      if (t.样本 < 禁引最小n) continue;
      for (const k of 指标序) if (t.差[k].超出噪声 && (!best || (t.差[k].强度 ?? 0) > best.强度)) best = { 档: t.档, 指标: k, Δ: t.差[k].Δ, 倍率: t.差[k].倍率, 强度: t.差[k].强度 ?? 0, n: t.样本, 判定: 判定(t.样本) };
    }
    return { p, best };
  }).filter((x) => x.best).sort((a, b) => b.best.强度 - a.best.强度 || a.p.短名.localeCompare(b.p.短名, 'zh'));
  for (const x of 强) L.push(`| ${x.p.短名} | ${达标.find((d) => d.短名 === x.p.短名)?.格数 ?? 0} | ${x.best.档} | ${x.best.指标} | ${x.best.Δ > 0 ? '+' : ''}${f1(x.best.Δ)} | ${x.best.倍率 == null ? '—' : x.best.倍率.toFixed(2) + '×'} | ${x.best.强度.toFixed(1)} | ${x.best.n} | ${x.best.判定} |`);
  L.push(`\n达标（至少一档 Δ≥10 点［或均长倍率越界］且超出噪声带）：**${达标.length}/${人物.length} 人**（验收线 ≥10 人）。`);
  const 档分布 = {};
  for (const x of 强) 档分布[x.best.档] = (档分布[x.best.档] || 0) + 1;
  L.push(`最强一档落在哪档：${Object.entries(档分布).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).map(([k, v]) => `${k} ${v} 人`).join(' ｜ ')}`, '');
  L.push('## 四、演出结束对话档：逐人倍率（均长 ÷ 主线均长）', '');
  L.push('| 角色 | 主线均长 | 演出结束均长 | 倍率 | n | 判定 |');
  L.push('|---|---|---|---|---|---|');
  const 倍 = 人物.map((p) => {
    const a = p.档.find((x) => x.档 === '主线'), b = p.档.find((x) => x.档 === '演出结束对话');
    if (!a || !b || !a.指标['均长'].值 || !b.指标['均长'].值) return null;
    return { 短名: p.短名, 主线: a.指标['均长'].值, 演出: b.指标['均长'].值, 倍: b.指标['均长'].值 / a.指标['均长'].值, n: b.样本, 判定: 判定(b.样本) };
  }).filter(Boolean).sort((x, y) => y.倍 - x.倍 || x.短名.localeCompare(y.短名, 'zh'));
  for (const x of 倍) L.push(`| ${x.短名} | ${f1(x.主线)} | ${f1(x.演出)} | ${x.倍.toFixed(2)}× | ${x.n} | ${x.判定} |`);
  L.push(`\n倍率 ≥1.3 的人数：${倍.filter((x) => x.倍 >= 1.3).length}/${倍.length}｜中位倍率 ${(倍.length ? 倍.map((x) => x.倍).sort((a, b) => a - b)[Math.floor(倍.length / 2)] : 0).toFixed(2)}×`, '');
  L.push('## 五、自检表：各档加权回全局 vs `角色模型/指纹/` 登记值', '');
  L.push('| 角色 | ' + 指标序.join(' | ') + ' |');
  L.push('|---|' + 指标序.map(() => '---').join('|') + '|');
  for (const s of 自检) L.push(`| ${s.短名} | ` + 指标序.map((k) => (s.差[k].差 == null ? '缺' : (s.差[k].差 === 0 ? '0' : s.差[k].差.toFixed(2)))).join(' | ') + ' |');
  L.push('', `逐人逐指标共 ${自检.length * 指标序.length} 格，超 0.05 的 ${自检超差.length} 格${自检超差.length ? '：' + 自检超差.join('；') : '（加权回全局与指纹报告完全对账）'}。`, '');
  L.push('## 六、疑问率的档间分布（对照回测「疑问率是最高频病根」）', '');
  L.push('| 角色 | 全局 | 主线 | 羁绊剧情 | 演出结束对话 | 主页剧情 | 其它 | 最大档 | Δ(最大−全局) | 最小档 Δ | 档间极差(n≥15) | 可引用档跨度(n≥40) |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  const 疑 = 人物.map((p) => {
    const 有 = p.档.filter((t) => t.指标['疑问率'].值 != null && t.样本 >= 禁引最小n);
    if (!有.length) return null;
    const 可 = p.档.filter((t) => t.指标['疑问率'].值 != null && t.样本 >= 可引用最小n).map((t) => t.指标['疑问率'].值);
    const mx = 有.reduce((a, b) => (b.指标['疑问率'].值 > a.指标['疑问率'].值 ? b : a));
    const mn = 有.reduce((a, b) => (b.指标['疑问率'].值 < a.指标['疑问率'].值 ? b : a));
    return { p, mx, mn, 极差: mx.指标['疑问率'].值 - mn.指标['疑问率'].值, 可跨度: 可.length >= 2 ? Math.max(...可) - Math.min(...可) : null };
  }).filter(Boolean).sort((a, b) => b.极差 - a.极差 || a.p.短名.localeCompare(b.p.短名, 'zh'));
  for (const x of 疑) {
    const cell = (t) => { const v = x.p.档.find((y) => y.档 === t); return v && v.样本 >= 禁引最小n ? `${f1(v.指标['疑问率'].值)}(${v.样本})` : '—'; };
    L.push(`| ${x.p.短名} | ${f1(x.p.指标['疑问率'].值)} | ${cell('主线')} | ${cell('羁绊剧情')} | ${cell('演出结束对话')} | ${cell('主页剧情')} | ${cell('其它')} | ${x.mx.档} ${f1(x.mx.指标['疑问率'].值)} | ${x.mx.差['疑问率'].Δ > 0 ? '+' : ''}${f1(x.mx.差['疑问率'].Δ)}${x.mx.差['疑问率'].超出噪声 ? ' ★' : ''} | ${x.mn.差['疑问率'].Δ > 0 ? '+' : ''}${f1(x.mn.差['疑问率'].Δ)} | ${f1(x.极差)} | ${x.可跨度 == null ? '—' : f1(x.可跨度)} |`);
  }
  L.push('', `疑问率档间极差（n≥15 档）中位 ${f1(疑.length ? 疑.map((x) => x.极差).sort((a, b) => a - b)[Math.floor(疑.length / 2)] : null)} 点｜可引用档跨度（n≥40）中位 ${f1((() => { const v = 疑.map((x) => x.可跨度).filter((y) => y != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; })())} 点`, '');
  L.push('> 本表只计 n台词 ≥ 15 的档（括号内为 n）。最后一列＝只取 n≥40 的档后的跨度，是「语域能解释多少疑问率偏差」的**上界**。', '');
  L.push('> 对照：`交接.md` §五 记回的 A/B 回测疑问率偏差（**引用值，非本脚本所算**）——蓬咲 54.4、蕾叶 58.9、阿拉蕾 41.0 点。逐人到本表查其「可引用档跨度」即可判断语域是否是这三处偏差的成因。', '');
  L.push('');
  return L.join('\n');
}

/* ── 伴生数据（阶段 6 直接取数填表，不必解析 markdown）── */
const 数据 = {
  生成器: '工具/语域分档.mjs',
  口径: { 句: '行级（一句 = 语料里的一行台词）', 不按省略号断句: '本语料 36~48% 的行含「…」，它是停顿标记不是句末', 分母: { 均长与长短句占比: '该档含汉字台词行数', 各标记率: '该档台词行数', 沉默占比: '该档全部条目数（含歌词/心声/纯省略号）' } },
  门槛: { 可引用最小n, 禁引最小n, 理由: 'n=40 时二项比例最坏情形 95% 置信半宽 9.8 点，低于本项目「Δ≥10 点」验收线；n<15 最坏半宽 25.3 点，连方向都不成立' },
  数据源: '素材全量/按角色全量/zh-Hans（与 角色模型/指纹/ 同源）',
  语域档: 档序,
  标签映射: Object.fromEntries(Object.entries(标签映射).map(([k, v]) => [k, [...v].sort()])),
  未归并标签: [...未归名].sort(),
  指标: 指标序,
  角色: 人物.map((p) => ({
    短名: p.短名, 全名: p.全名, 乐队: p.band, 乐队码: p.乐队码, 模型目录: p.dir,
    语料: p.语料, 指纹报告: p.指纹报告, 条目: p.条目, 台词: p.台词, 剧本数: p.剧本数, 类别标签: p.标签,
    全局: Object.fromEntries(指标序.map((k) => [k, { 值: p.指标[k].值 == null ? null : +p.指标[k].值.toFixed(2), 命中: p.指标[k].命中, 分母: p.指标[k].分母, 半宽: p.指标[k].半宽 == null ? null : +p.指标[k].半宽.toFixed(2) }])),
    档: p.档.map((t) => ({
      档: t.档, 样本: t.样本, 条目: t.条目, 剧本数: t.剧本数, advId: t.advId, 标签: t.标签, 判定: 判定(t.样本),
      指标: Object.fromEntries(指标序.map((k) => [k, { 值: t.指标[k].值 == null ? null : +t.指标[k].值.toFixed(2), 命中: t.指标[k].命中, 分母: t.指标[k].分母, 半宽: t.指标[k].半宽 == null ? null : +t.指标[k].半宽.toFixed(2), Δ: t.差[k].Δ == null ? null : +t.差[k].Δ.toFixed(2), 倍率: t.差[k].倍率 == null ? null : +t.差[k].倍率.toFixed(3), 带宽: t.差[k].带宽 == null ? null : +t.差[k].带宽.toFixed(2), 强度: t.差[k].强度 == null ? null : +t.差[k].强度.toFixed(2), 显著: !!t.差[k].显著, 幅度: !!t.差[k].幅度, 超出噪声: !!t.差[k].超出噪声 }])),
    })),
    加权回全局: Object.fromEntries(指标序.map((k) => [k, { 加权: p.回加[k].加权 == null ? null : +p.回加[k].加权.toFixed(2), 直接全局: p.指标[k].值 == null ? null : +p.指标[k].值.toFixed(2), 报告登记: 自检.find((s) => s.短名 === p.短名).差[k].报告登记, 差: 自检.find((s) => s.短名 === p.短名).差[k].差 }])),
  })),
  自检超差,
  验收: { 达标人数: 达标.length, 覆盖人数: 人物.length, 达标名单: 达标.map((d) => ({ 角色: d.短名, 达标档数: d.档数, 达标格数: d.格数, 明细: d.明细 })) },
};
const 文件清单 = [];
for (const p of 人物) 文件清单.push({ path: join(OUT_DIR, `${p.短名}_${p.全名}_语域分档.md`), body: render人物(p) });
文件清单.push({ path: join(OUT_DIR, '_语域分档汇总.md'), body: render汇总() });
文件清单.push({ path: join(OUT_DIR, '_分档数据.json'), body: JSON.stringify(数据, null, 1) });

/* ── 主流程 ── */
if (CHECK) {
  let 错 = 0;
  if (!existsSync(OUT_DIR)) { console.log(`✗ 目录不存在：${OUT_DIR}`); process.exit(1); }
  for (const f of 文件清单) {
    if (!existsSync(f.path)) { console.log(`✗ 缺产物：${f.path.slice(WS.length + 1)}`); 错++; continue; }
    const 现 = readFileSync(f.path, 'utf8');
    if (现 !== f.body) {
      错++;
      const 行号 = 现.split('\n').findIndex((l, i) => l !== f.body.split('\n')[i]);
      console.log(`✗ 漂移：${f.path.slice(WS.length + 1)}（首个不同行 ${行号 + 1}）`);
      if (行号 >= 0) console.log(`   现有：${现.split('\n')[行号].slice(0, 110)}\n   应得：${f.body.split('\n')[行号].slice(0, 110)}`);
    }
  }
  if (自检超差.length) { console.log(`✗ 加权回全局与指纹登记值不一致 ${自检超差.length} 处：`); for (const x of 自检超差.slice(0, 10)) console.log('   · ' + x); 错 += 自检超差.length; }
  const 多 = readdirSync(OUT_DIR).filter((f) => f.endsWith('.md') && !f.startsWith('_') && !人物.some((p) => f === `${p.短名}_${p.全名}_语域分档.md`));
  if (多.length) { console.log(`✗ ${OUT_DIR.slice(WS.length + 1)} 有 ${多.length} 个未登记的 md：${多.join('、')}`); 错 += 多.length; }
  console.log(错 ? `✗ 语域分档校验不通过（${错} 处）` : `✓ 语域分档 ${文件清单.length} 份产物与语料/指纹逐字一致（${人物.length} 人；加权回全局零超差）`);
  process.exit(错 ? 1 : 0);
}

if (!DRY && !CHECK) mkdirSync(OUT_DIR, { recursive: true });
let written = 0;
for (const f of 文件清单) { if (DRY || CHECK) continue; writeFileSync(f.path, f.body, 'utf8'); written++; }

console.log(`语域分档：${人物.length} 人 ｜ 档：${档序.join('/ ')}${未归名.size ? ` ｜ 未归并标签 ${[...未归名].join('、')}` : ''}｜ 缺语料 ${缺语料.length}${缺语料.length ? '：' + 缺语料.join('、') : ''}`);
console.log(DRY ? '[dry] 未写文件' : `已写 ${written} 份 → 角色模型/语域/`);
console.log(`验收（某档 vs 全局：比率差 ≥10 点，或均长倍率 ≥1.3×/≤0.77×；且超出档+全局 95% 置信半宽、n≥${禁引最小n}）：${达标.length}/${人物.length} 人达标${达标.length >= 10 ? ' ✓' : ' ✗ 不足 10 人'}`);
for (const d of 达标) console.log(`   ${d.短名}：${d.档数} 档 —— ${d.明细.map((x) => `${x.档}[${x.指标.slice(0, 3).join('、')}]`).join(' ')}`);
const 低 = 人物.filter((p) => p.档.some((t) => t.样本 < 禁引最小n)).map((p) => `${p.短名}(${p.档.filter((t) => t.样本 < 禁引最小n).map((t) => `${t.档}:${t.样本}`).join('，')})`);
console.log(`禁引档：${低.length ? 低.join(' ｜ ') : '无'}`);
console.log(`自检：加权回全局超差 ${自检超差.length} 处${自检超差.length ? ' —— ' + 自检超差.slice(0, 6).join('；') : '（逐人逐指标 0，与 角色模型/指纹/ 对账一致）'}`);
