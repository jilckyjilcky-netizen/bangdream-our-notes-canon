#!/usr/bin/env node
/**
 * lexicon.mjs —— 词层清单（交接计划 阶段 3）：每人一份「说什么词」的正式资产
 *
 * 输入：工具/角色表.mjs 给出的 26 份按角色语料（**行级口径**：一行 = 一条台词，与 fingerprint_full 的 --口径=行 同尺）
 * 产出：角色模型/词层/{短名}_{全名}_词层清单.md × 26，含且只含三节：
 *   1. 专属高频 2~3 字串（频次 ≥ 全员中位 且 相对全库倍数 ≥ 2.5；剔除派生人名/称呼串与全库通用词；
 *      ★ 强信号档与「未达绝对门槛」档分列，通用词但她用量占大头的另入口头禅表）
 *   2. 语尾语气词分布（分角色 × 分语域，语域取语料现成 <sub> 类别标签）
 *   3. 自称 / 第一人称 / 对他人称呼 + 与 kb.json 关系数据的对齐检查（只报告，不改任何一边）
 *
 * 纯本地算术、零 token、不联网；报告里所有数字由运行时算出，每条附 advId·行号 出处。
 * 用法：node 工具/lexicon.mjs [--check] [--dry]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { WS, CHARS, EXTRA_CHARS, corpusOf } from './角色表.mjs';

const CHECK = process.argv.includes('--check');
const DRY = process.argv.includes('--dry');
const WRITE = !CHECK && !DRY;
const OUT_DIR = join(WS, '角色模型', '词层');
const KB = JSON.parse(readFileSync(join(WS, '资料库', 'kb.json'), 'utf8'));

const ALL = [...CHARS, ...EXTRA_CHARS];

/* ══ 名池：人名/角色名剔除用（必须派生，不能手写名单）══════════════
 * 上一轮硬编码了 ['若麦','爱音','爽世'] 三个人名，漏掉其余 22 人 → 剔除形同虚设。
 * 这里从 角色表.mjs（简称+全名）、kb.json（name_short/aliases/stage/name）、
 * 以及 按话语料的 `**说话人**：` 标签三处派生。 */
const CJKruns = (s) => String(s || '').match(/[\u4e00-\u9fa5]{2,}/g) || [];
const 名池 = new Map();
function addName(s, who) {
  const t = String(s || '').trim();
  if (!/^[\u4e00-\u9fa5]{2,6}$/.test(t)) return;
  if (!名池.has(t)) 名池.set(t, who);
}
for (const c of ALL) { addName(c.k, c.k); addName(c.full, c.k); }
for (const ch of KB.characters) {
  addName(ch.name_short, ch.name_short);
  for (const s of CJKruns(ch.name)) addName(s, ch.name_short);
  for (const s of CJKruns(ch.stage)) addName(s, ch.name_short);
  for (const s of CJKruns((ch.aliases || []).join(' '))) addName(s, ch.name_short);
}

/* 按话语料只扫一遍，供「说话人标签派生」与「诊断口径对账」共用 */
function 遍历目录(dir, 前缀 = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...遍历目录(p, 前缀 ? `${前缀}/${e.name}` : e.name));
    else if (e.name.endsWith('.md')) out.push({ file: p, cat: 前缀 });
  }
  return out;
}
const 按话行 = new Map();
for (const f of 遍历目录(join(WS, '素材全量', '按话', 'zh-Hans'))) {
  for (const l of readFileSync(f.file, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\*\*(.+?)\*\*[：:](.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    if (!按话行.has(k)) 按话行.set(k, []);
    按话行.get(k).push(m[2].trim());
  }
}
const labelCores = new Map();
for (const [label, arr] of 按话行) {
  if (arr.length < 40) continue;
  const core = label.replace(/^(幼年|少年|老年)/, '').split('的')[0].replace(/[A-Za-z？?。、\s]/g, '');
  if (!/^[\u4e00-\u9fa5]{2,3}$/.test(core)) continue;
  if (名池.has(core)) continue;
  labelCores.set(core, (labelCores.get(core) || 0) + arr.length);
}

/* 称呼框架：命中即归第三节，不作为「专属词」计入第一节 */
const 称呼后缀 = ['同学', '学姐', '学长', '前辈', '后辈', '老师', '大人', '殿下', '桑', '小姐', '妹妹', '弟弟'];
const RE小X = /小[\u4e00-\u9fa5]{1,2}/g;
const RE后称 = new RegExp('([\\u4e00-\\u9fa5]{1,3})(' + 称呼后缀.join('|') + ')', 'g');

/* ══ 语料解析（行级）══════════════════════════════════════════════ */
const isLyric = (s) => /^『[\s\S]*』$/.test(s.trim()) || /^[『♪]/.test(s.trim());
const isSilent = (s) => /^[…\s]*$/.test(s) && /…/.test(s);
const isSilentP = (s) => /^[…\s、，。？！?！]*$/.test(s) && /…/.test(s) && !isSilent(s);
const isThought = (s) => /^（[\s\S]*）$/.test(s.trim());
const 归语域 = (c) => (!c ? '未标注' : c.startsWith('主线') ? '主线' : c);
/* 「（聊天）」是聊天界面的行首载体标记（全库 131 行），不是台词内容；只从抽词的汉字串里剥掉，
 * 语尾统计不动它（诊断脚本按原文判行尾，动了就对不上 12.2/36.4）。 */
const 剥聊天 = (s) => s.replace(/^（聊天）/, '');
const 语域序 = ['主线', '羁绊剧情', '演出结束对话', '主页剧情', '其它剧情', '教程', '未标注'];

function 读语料(p) {
  const out = [];
  let cur = null, skip = false, ln = 0;
  for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) {
    ln++;
    if (/^##\s/.test(l)) { const t = l.replace(/^##\s+/, '').trim(); skip = t === '出处目录'; cur = skip ? null : { title: t, cat: '', advId: '' }; continue; }
    if (skip) continue;
    if (/^<sub>/.test(l)) { const m = l.match(/^<sub>\s*(.+?)\s*｜\s*advId\s*(\d+)/); if (m && cur) { cur.cat = m[1].trim(); cur.advId = m[2]; } continue; }
    if (!/^- /.test(l) || !cur) continue;
    const text = l.replace(/^-\s+/, '').trim();
    const kind = isLyric(text) ? 'lyric' : isThought(text) ? 'thought' : isSilent(text) ? 'silent' : isSilentP(text) ? 'silentp' : 'speech';
    out.push({ text, han: 剥聊天(text).replace(/[^\u4e00-\u9fa5]/g, ''), kind, cat: 归语域(cur.cat), advId: cur.advId || '—', sec: cur.title, ln });
  }
  return out;
}

const roster = ALL.map((c) => ({ k: c.k, full: c.full, band: c.band, extra: EXTRA_CHARS.some((e) => e.k === c.k), path: c.corpus ? join(WS, c.corpus) : corpusOf(c) }));
const 语料 = new Map(roster.map((r) => [r.k, 读语料(r.path)]));
/* kb.addresses 的行数是在 `素材全量/按角色全量` 版式上统计的（见 `工具/角色表.mjs` 头注）。
 * 本清单主口径仍是 corpusOf（按角色），所以行数对不上时先跟全量变体核一遍，再判是不是真不一致。 */
const 全量语料 = new Map(roster.map((r) => {
  const p = join(WS, '素材全量', '按角色全量', 'zh-Hans', `${r.k}_${r.full}.md`);
  return [r.k, existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => /^- /.test(l)).map((l) => l.replace(/^-\s+/, '').replace(/[^\u4e00-\u9fa5]/g, '')) : null];
}));
const 全库行数 = [...语料.values()].reduce((a, b) => a + b.length, 0);
const 人数线 = Math.ceil(roster.length * 0.6);

/* kb 未收录的说话人标签是否算「人名」，用数据判：只在 <60% 角色口中出现 → 是专名（奏多/薇欧拉/蓓儿…）；
 * 全员都在用的（大家/少女…）是通用词，不进人名剔除集。 */
for (const [core, n] of labelCores) {
  const 用人数 = roster.filter((r) => 语料.get(r.k).some((i) => i.text.includes(core))).length;
  if (用人数 < 人数线) addName(core, '说话人');
}

/* 剔除集：正式名（角色表简称/全名 + kb name_short/stage）与说话人标签的 2~3 字子串。
 * kb 别名里的普通名词（乐奈「野猫」、海铃「海子」、祥子「小祥」）**不剔**——
 * 它们恰是「只有她会这么说」的词层信号，硬剔会抹掉诊断已确认的立希「野猫×38」。 */
const 正式名 = new Set([...ALL.flatMap((c) => [c.k, c.full]), ...KB.characters.flatMap((c) => [c.name_short, c.stage].filter(Boolean))]);
const 剔除gram = new Set();
for (const [s, who] of 名池) {
  if (!正式名.has(s) && who !== '说话人') continue;
  for (let k = 2; k <= 3; k++) for (let i = 0; i + k <= s.length; i++) 剔除gram.add(s.slice(i, i + k));
}
const 名串列表 = [...名池.keys()].filter((s) => 正式名.has(s) || 名池.get(s) === '说话人').sort((a, b) => b.length - a.length);

/* ══ 全库 2~3 字 gram ═════════════════════════════════════════════ */
function 称呼覆盖(han) {
  const cov = new Uint8Array(han.length);
  for (const re of [new RegExp(RE小X.source, 'g'), new RegExp(RE后称.source, 'g')]) {
    let m; while ((m = re.exec(han))) for (let i = m.index; i < m.index + m[0].length; i++) cov[i] = 1;
  }
  for (const nm of 名串列表) { let i = han.indexOf(nm); while (i >= 0) { for (let x = i; x < i + nm.length; x++) cov[x] = 1; i = han.indexOf(nm, i + nm.length); } }
  return cov;
}
const 个人 = new Map();
const 全库 = new Map(), 全库人 = new Map();
for (const r of roster) {
  const g = new Map(), free = new Map();
  for (const it of 语料.get(r.k)) {
    const cov = it.han.length >= 2 ? 称呼覆盖(it.han) : null;
    for (let k = 2; k <= 3; k++) for (let x = 0; x + k <= it.han.length; x++) {
      const s = it.han.slice(x, x + k);
      g.set(s, (g.get(s) || 0) + 1);
      if (cov && !cov[x] && !cov[x + k - 1]) free.set(s, (free.get(s) || 0) + 1);
      全库.set(s, (全库.get(s) || 0) + 1);
    }
  }
  个人.set(r.k, { g, free });
  for (const s of g.keys()) { if (!全库人.has(s)) 全库人.set(s, new Set()); 全库人.get(s).add(r.k); }
}
const 中位 = (freqs) => { const v = [...freqs].sort((a, b) => a - b), m = v.length / 2; return v.length % 2 ? v[Math.floor(m)] : (v[m - 1] + v[m]) / 2; };
const 全员中位 = new Map();
for (const s of 全库.keys()) 全员中位.set(s, 中位(roster.map((r) => 个人.get(r.k).g.get(s) || 0)));
const 诊断门槛 = (N) => Math.max(8, Math.ceil(N * 0.01));

/* ══ 语尾语气词（词表与剥标点规则同 归档/_临时诊断/词层与语尾分析.mjs，逐字对齐才能复现 12.2/36.4）══ */
const 语尾 = /(吗|呢|吧|啊|呀|嘛|啦|哦|喔|哟|咯|诶|欸|哈|嘿|哼|喂|嗯)$/;
const 剥尾 = (s) => s.replace(/[。！？…～~、，,.!?]+$/, '').trim();
function 语尾统计(lines) {
  const byReg = new Map(), byPart = new Map();
  let hit = 0;
  for (const it of lines) {
    const r = byReg.get(it.cat) || { tot: 0, hit: 0, part: new Map() };
    byReg.set(it.cat, r); r.tot++;
    const m = 语尾.exec(剥尾(it.text));
    if (!m) continue;
    hit++; r.hit++;
    r.part.set(m[1], (r.part.get(m[1]) || 0) + 1);
    byPart.set(m[1], (byPart.get(m[1]) || 0) + 1);
  }
  return { hit, byReg, byPart };
}
function 按话对账(k) {
  const arr = 按话行.get(k);
  if (!arr || !arr.length) return null;
  const hit = arr.filter((t) => 语尾.test(剥尾(t))).length;
  return { n: arr.length, hit, 率: (100 * hit / arr.length).toFixed(1) };
}

/* ══ 归属：称呼串核心 → 在册角色 ══════════════════════════════════ */
const 名字按人 = new Map(roster.map((r) => [r.k, [...名池].filter(([, w]) => w === r.k).map(([s]) => s)]));
function 归属(core) {
  let best = null, bl = 0;
  for (const [k, names] of 名字按人) {
    for (const nm of names) {
      if (!nm || !core) continue;
      if (nm === core || nm.endsWith(core) || nm.startsWith(core)) { if (core.length > bl) { bl = core.length; best = k; } }
    }
  }
  if (!best) for (const [k, names] of 名字按人) { if (names.some((nm) => nm.length >= 2 && core && nm.slice(-2).includes(core)) && core.length >= 2) { best = k; break; } }
  return best;
}

const pct1 = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0') + '%';
const esc = (s) => String(s).replace(/\|/g, '／').replace(/\s+/g, ' ').trim();
const 处 = (it, n = 18) => `${it.advId}·L${it.ln}「${esc(it.text).slice(0, n)}」`;

/* ══ 单份清单 ═══════════════════════════════════════════════════ */
function build(r) {
  const lines = 语料.get(r.k), N = lines.length;
  const kindN = (kk) => lines.filter((i) => i.kind === kk).length;
  const scripts = new Set(lines.map((i) => i.advId).filter((x) => x !== '—')).size;
  const { g, free } = 个人.get(r.k);

  /* §1 专属高频（本人名字自称例外保留：千樱梨「千樱梨×220」这类自称是词层事实，不是「提到别人」）
   * 自称例外只认 `角色表.mjs` 的简称/全名：kb 别名（如真奈「小初的搭档」）的子串不是本人名字，
   * 让「小初」当自称会把她对初华的称呼误标成第一人称。 */
  const ownGrams = new Set();
  for (const s of [r.k, r.full]) for (let k = 2; k <= 3; k++) for (let i = 0; i + k <= s.length; i++) ownGrams.add(s.slice(i, i + k));
  const cand = [], 通用 = [], 剔名 = [];
  for (const [s, v] of g) {
    if (v < 2) continue;
    const own = ownGrams.has(s);
    if (剔除gram.has(s) && !own) { if (v >= 5 && 剔名.length < 60) 剔名.push({ s, v }); continue; }
    if (v < (全员中位.get(s) || 0)) continue;
    const ratio = (v / N) / Math.max((全库.get(s) || 0) / 全库行数, 1e-9);
    if (ratio < 2.5) continue;
    if ((free.get(s) || 0) === 0 && !own) continue;
    const hits = lines.filter((i) => i.han.includes(s));
    const users = (全库人.get(s) || new Set()).size;
    const item = { s, v, free: free.get(s) || 0, ratio: +ratio.toFixed(1), med: 全员中位.get(s) || 0, own, users, 占比: v / Math.max(全库.get(s) || 1, 1), star: v >= 诊断门槛(N) ? '★' : '', hits };
    if (users >= 人数线 && !own) { 通用.push(item); continue; }   // 全库 ≥60% 的人都在说 → 不算「专属」，另表看她是否说得多
    cand.push(item);
  }
  cand.sort((a, b) => (b.ratio * b.v - a.ratio * a.v) || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  /* 同址片段合并：命中行完全相同的串是同一条证据（「联盟头」「盟头号」都只出现在同一批行里），
   * 留最长的那个；再按片段规则剔掉大半次数只是更长串一部分的 2 字串（那家/家伙 ⊂ 那家伙）。
   * 覆盖率 < 50% 不算片段（立希「野猫×38」远多于「只野猫×4」，前者是诊断已确认的专属词，必须留）。*/
  const 址 = (c) => c.hits.map((h) => h.ln).join(',');
  const 组 = new Map();
  for (const c of cand) { const k = 址(c); const p = 组.get(k); if (!p || c.s.length > p.s.length) 组.set(k, c); }
  const uniq = [...组.values()].sort((a, b) => (b.ratio * b.v - a.ratio * a.v) || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  const byS = new Map(uniq.map((c) => [c.s, c]));
  const 片段 = new Set();
  for (const c of uniq) {
    if (c.s.length !== 3) continue;
    for (const sub of [c.s.slice(0, 2), c.s.slice(1, 3)]) {
      const p = byS.get(sub);
      if (p && !片段.has(sub) && c.hits.length >= 0.5 * p.hits.length) 片段.add(sub);
    }
  }
  const pool = uniq.filter((c) => !片段.has(c.s));
  const byScore = (a, b) => (b.ratio * b.v - a.ratio * a.v) || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0);
  /* 分两档呈现：★ = 达诊断脚本绝对门槛 max(8, 1%行数) 的可信信号；
   * 未达门槛的 2~4 次碎片不作废也不当真，单列「需人工复核」，免得把跨词边界的片段混进招牌词。*/
  const top = pool.filter((c) => c.star).sort(byScore).slice(0, 12);
  const low = pool.filter((c) => !c.star).sort((a, b) => (b.v - a.v) || byScore(a, b)).slice(0, 8);
  通用.sort((a, b) => (b.占比 - a.占比) || (b.v - a.v) || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  const 口头禅 = 通用.filter((c) => c.star && c.占比 >= 0.15).slice(0, 8);

  /* §2 语尾 */
  const 语 = 语尾统计(lines);
  const regs = [...语.byReg.entries()].sort((a, b) => ((语域序.indexOf(a[0]) + 1 || 99) - (语域序.indexOf(b[0]) + 1 || 99)) || (a[0] < b[0] ? -1 : 1));
  const 对账 = 按话对账(r.k);

  /* §3 人称 + 称呼 */
  const 人称项 = [['我', /我/], ['我们', /我们/], ['咱/咱们', /咱[们]?/], ['人家', /人家/], ['本人', /本人/], ['自己', /自己/], ['你', /你/], ['你们', /你们/], ['大家', /大家/]];
  const 人称表 = 人称项.map(([nm, re]) => {
    const rows = lines.filter((i) => re.test(i.text));
    let times = 0; for (const i of rows) times += (i.text.match(new RegExp(re.source, 'g')) || []).length;
    const ex = rows.find((i) => i.kind === 'speech') || rows[0];
    return { nm, 行: rows.length, 次: times, ex };
  });
  const own = (名字按人.get(r.k) || []).filter((s) => s.length >= 2);
  const 自称名行 = lines.filter((i) => own.some((s) => i.text.includes(s)));
  let 自称名次 = 0; for (const i of 自称名行) 自称名次 += own.filter((s) => i.text.includes(s)).length;

  const 称呼map = new Map();
  const push = (token, target, it) => {
    if (!target || target === r.k) return;
    const a = 称呼map.get(token) || { token, target, 次: 0, 行: 0, 行集: new Set(), ex: [] };
    a.次 += it.text.split(token).length - 1;
    if (!a.行集.has(it.ln)) { a.行集.add(it.ln); a.行++; if (a.ex.length < 2) a.ex.push(it); }
    称呼map.set(token, a);
  };
  for (const it of lines) {
    let m;
    RE小X.lastIndex = 0; while ((m = RE小X.exec(it.han))) push(m[0], 归属(m[0].slice(1)), it);
    RE后称.lastIndex = 0;
    while ((m = RE后称.exec(it.han))) push(m[0], 归属(m[1]), it);
    for (const nm of 名串列表) { let i = it.han.indexOf(nm); while (i >= 0) { push(nm, 名池.get(nm), it); i = it.han.indexOf(nm, i + nm.length); } }
  }
  const 称呼表 = [...称呼map.values()].sort((a, b) => (b.次 - a.次) || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));

  const kbSelf = KB.characters.find((c) => c.name_short === r.k);
  const rel = (kbSelf && kbSelf.relations) || [];
  const addrKb = (kbSelf && kbSelf.addresses) || {};
  /* 对齐检查一律以「语料行内含该串的行数」为尺，不用上面称呼抽取器的结果：
   * 抽取器是贪婪匹配（小爱音 会吞掉 小爱），拿它比 kb.addresses 的行数会造出假不一致。 */
  const 行含 = (s) => lines.reduce((a, i) => a + (i.han.includes(s) ? 1 : 0), 0);
  const 全量 = 全量语料.get(r.k);
  const 全量含 = (s) => (全量 ? 全量.reduce((a, h) => a + (h.includes(s) ? 1 : 0), 0) : -1);
  const 实测 = new Map(); for (const a of 称呼表) if (!实测.has(a.target)) 实测.set(a.target, a);
  const 不一致 = [], 口径说明 = [];
  for (const [t, cnt] of Object.entries(addrKb)) {
    const n = 行含(t), n全 = 全量含(t);
    if (n === cnt) continue;
    if (n全 === cnt) 口径说明.push(`kb.addresses \`${t}\` 登记 ${cnt} 行＝\`按角色全量\` 变体实测 ${n全} 行；本清单主口径（\`按角色\`）为 ${n} 行，差 ${cnt - n} 行是语料变体不同，不是数据错误`);
    else 不一致.push(`kb.addresses \`${t}\` 登记 ${cnt} 行 → 实测 按角色 ${n} 行／按角色全量 ${n全} 行，两个变体都对不上`);
  }
  const relTargets = new Set();
  for (const x of rel) {
    const tt = 归属(x.with) || x.with;
    relTargets.add(tt);
    const 登记 = String(x.call || '').replace(/（[^）]*）/g, '').split(/[\/、,，;；\s→\-—…]+/).filter((s) => /^[\u4e00-\u9fa5A-Za-z]{2,6}$/.test(s));
    for (const d of 登记) { const n = 行含(d), n全 = 全量含(d); if (n === 0 && n全 === 0) 不一致.push(`rel(${r.k}→${tt}) 登记 \`${d}\` → 两个语料变体里都 0 行（该对象语料实测 ${(实测.get(tt) || { token: '—', 次: 0 }).token}×${(实测.get(tt) || { 次: 0 }).次 || 0}）`); else if (n === 0) 口径说明.push(`rel(${r.k}→${tt}) 登记 \`${d}\` → 本清单主口径 0 行，\`按角色全量\` 变体 ${n全} 行`); }
  }
  const NPC对象 = 称呼表.filter((a) => a.target === '说话人');
  for (const a of 称呼表.slice(0, 10)) if (!relTargets.has(a.target) && a.target !== '说话人' && a.次 >= 3) 不一致.push(`语料称呼「${a.token}」→${a.target} ×${a.次} → rel 无该对象条目`);
  for (const a of NPC对象.slice(0, 3)) 不一致.push(`语料称呼「${a.token}」×${a.次} 属语料说话人（kb 未收录角色），rel 无从对齐`);

  /* ── 文本 ── */
  const L = [];
  L.push(`# ${r.k}_${r.full}_词层清单.md — 词层清单（说什么词）`, '');
  L.push(`> 语料：\`${relative(WS, r.path).replace(/\\/g, '/')}\`（路径来自 \`工具/角色表.mjs\`）｜ **行级口径**：一行 = 一条台词，跨行包裹不计（同 \`工具/fingerprint_full.mjs\` 的 \`--口径=行\`）`);
  L.push(`> 本角色 **${N} 条**（台词 ${kindN('speech')} / 心声 ${kindN('thought')} / 歌词 ${kindN('lyric')} / 纯省略号 ${kindN('silent')} / 省略号加标点 ${kindN('silentp')}）｜ 出自 **${scripts}** 个剧本 ｜ 全库 26 人共 ${全库行数} 行（倍数分母）`);
  L.push(`> 生成 \`工具/lexicon.mjs\`（纯本地算术、零 token、不联网）｜ 门槛：频次 ≥ 全员中位 且 相对全库倍数 ≥ 2.5，且全库使用人数 < ${人数线}/26（通用线）；★ = 频次达诊断脚本绝对门槛 max(8, 1%行数)。人名/称呼串的剔除名单从 \`工具/角色表.mjs\`+\`资料库/kb.json\`+语料说话人标签派生，非手写。`, '');

  L.push('## 一、专属高频 2~3 字串', '');
  L.push(`> 下表为 **★ 强信号档**：频次 ≥ 诊断脚本绝对门槛 max(8, 1%行数)（门槛行数 ${诊断门槛(N)}）。`, '');
  L.push('| 词串 | 次数 | 非称呼位次数 | 相对全库倍数 | 全员中位 | 全库使用人数 | 强信号 | 出处（advId·行号） |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const c of top) L.push(`| ${c.s} | ${c.v} | ${c.free} | ×${c.ratio} | ${c.med} | ${c.users}/26 | ${c.star || ''}${c.own ? ' 自称' : ''} | ${c.hits.slice(0, 2).map((h) => 处(h, 16)).join(' ')} |`);
  if (!top.length) L.push(`| —（本角色无达 ★ 绝对门槛的候选；门槛行数 ${诊断门槛(N)}，最大专属候选见下档） | | | | | | | |`);
  L.push('');
  L.push(`> 门槛（交接计划 §五）：频次 ≥ 全员中位 且 相对全库倍数 ≥ 2.5 且 非称呼位有次数 且 全库使用人数 < ${人数线}/26；派生名单剔名见下。达门槛候选 **${cand.length}** 个 → 同址片段合并 ${cand.length - uniq.length} 个 → 片段（2 字串大半只是 3 字串的一部分）再剔 ${uniq.length - pool.length} 个 → 剩 **${pool.length}** 个（★ ${pool.filter((c) => c.star).length} 个 / 未达门槛 ${pool.filter((c) => !c.star).length} 个），表内取 Top ${top.length}（按 倍数×频次 降序）。被剔出的高频 正式名/说话人名 子串（前 8）：${剔名.sort((a, b) => b.v - a.v || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0)).slice(0, 8).map((x) => `${x.s}×${x.v}`).join(' ') || '无'}（这类串属第三节称呼层，不重复计入词层专属词）。`);
  if (low.length) {
    L.push('');
    L.push(`### 未达 ★ 绝对门槛的候选（次数 < ${诊断门槛(N)}，多为跨词边界片段，需人工复核，不作招牌词）`, '');
    L.push('| 词串 | 次数 | 相对全库倍数 | 全库使用人数 | 出处（advId·行号） |');
    L.push('|---|---|---|---|---|');
    for (const c of low) L.push(`| ${c.s} | ${c.v} | ×${c.ratio} | ${c.users}/26 | ${c.hits.slice(0, 2).map((h) => 处(h, 16)).join(' ')} |`);
  }
  if (口头禅.length) {
    L.push('');
    L.push('### 通用词里的 她的口头禅（全库使用人数 ≥ ' + 人数线 + '/26，故不入上表）', '');
    L.push('| 词串 | 她的次数 | 相对全库倍数 | 她占全库该词用量 | 全库使用人数 | 出处（advId·行号） |');
    L.push('|---|---|---|---|---|---|');
    for (const c of 口头禅) L.push(`| ${c.s} | ${c.v} | ×${c.ratio} | ${pct1(c.占比 * 100, 100)} | ${c.users}/26 | ${c.hits.slice(0, 2).map((h) => 处(h, 16)).join(' ')} |`);
    L.push(`> 判据：词本身 26 人通用（≥${人数线} 人在用），但她一人的用量占全库该词 ≥15% 且达 ★ 绝对门槛——这是谁在说、而不是说不说的证据，与 \`归档/_临时诊断/词层与语尾分析.mjs\` 报的朋花 哎呀/呵呵 同源于此。`);
  }
  L.push('');

  L.push('## 二、语尾语气词分布（分语域）', '');
  L.push(`> 词表与剥标点规则逐字同 \`归档/_临时诊断/词层与语尾分析.mjs\`：吗/呢/吧/啊/呀/嘛/啦/哦/喔/哟/咯/诶/欸/哈/嘿/哼/喂/嗯，行尾判定前先剥 \`。！？…～~、，,.!?\`。`);
  L.push(`> 本角色总率 **${语.hit}/${N} = ${pct1(语.hit, N)}**｜分语气词：${[...语.byPart].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([p, n]) => `${p}×${n}`).join(' ') || '（无）'}`, '');
  L.push('| 语域 | 行数 | 语尾行 | 率 | 主要语气词 | 样本量 |');
  L.push('|---|---|---|---|---|---|');
  for (const [cat, v] of regs) L.push(`| ${cat} | ${v.tot} | ${v.hit} | ${pct1(v.hit, v.tot)} | ${[...v.part].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6).map(([p, n]) => `${p}×${n}`).join(' ') || '—'} | ${v.tot < 20 ? `n=${v.tot} 偏少，仅供参考` : `n=${v.tot}`} |`);
  L.push('');
  L.push(对账
    ? `> **对账**：同一张语气词表，按 \`素材全量/按话\` 的**精确说话人行**（诊断脚本所读语料）实测 ${对账.hit}/${对账.n} = **${对账.率}%**；本清单（按角色语料：另含联句双方计入 ${N - 对账.n} 行与补充聊天行）为 ${pct1(语.hit, N)}。两者都是行级口径，差异只在语料范围。`
    : `> **对账**：按话语料无 ${r.k} 这一精确说话人标签（该角色语料由归属工具按别名/联句归入），故无诊断侧对账值。`, '');

  L.push('## 三、自称 / 第一人称 / 对他人称呼', '');
  L.push('| 形式 | 出现次数 | 命中行数 | 行占比 | 出处（advId·行号） |');
  L.push('|---|---|---|---|---|');
  for (const p of 人称表) L.push(`| ${p.nm} | ${p.次} | ${p.行} | ${pct1(p.行, N)} | ${p.ex ? 处(p.ex, 16) : '—'} |`);
  L.push(`| 以本人名字自称 | ${自称名次} | ${自称名行.length} | ${pct1(自称名行.length, N)} | ${自称名行[0] ? 处(自称名行[0], 16) : '—'} |`, '');
  L.push('### 对他人称呼', '');
  L.push('| 称呼串 | 归属对象 | 次数 | 行数 | 出处（advId·行号） |');
  L.push('|---|---|---|---|---|');
  for (const a of 称呼表.slice(0, 14)) L.push(`| ${a.token} | ${a.target} | ${a.次} | ${a.行} | ${a.ex.map((h) => `${h.advId}·L${h.ln}`).join(' ')} |`);
  if (!称呼表.length) L.push('| —（语料未抽到可归属的称呼串） | | | | |');
  L.push('');
  L.push('### 与 `rel` 数据（kb.json 的 relations / addresses）对齐检查', '');
  L.push('> 只报告不一致，**不改动任何一边的数据**（本次运行不写 kb.json）。实测口径 = 本角色语料里**行内含该串的行数**（行级）；kb.addresses 的行数是在 `素材全量/按角色全量` 版式上统计的，故对不上的先与全量变体核一遍，只有两个变体都对不上才算不一致。称呼抽取器是贪婪匹配（小爱音 会吞掉 小爱），不用它做行数比对。');
  if (!不一致.length) L.push(`- ✓ 未发现不一致：rel 登记对象 ${rel.length} 个｜本清单称呼串 ${称呼表.length} 个｜kb.addresses ${Object.keys(addrKb).length} 个`);
  else for (const x of 不一致) L.push(`- ⚠ ${x}`);
  if (口径说明.length) L.push(`- ℹ 口径差（不是不一致）${口径说明.length} 条：${口径说明.slice(0, 5).join('；')}${口径说明.length > 5 ? `；其余 ${口径说明.length - 5} 条同因（全量变体对得上登记值）` : ''}`);
  L.push('');
  return { md: L.join('\n'), 条目: { s1: top.length + low.length, s2: regs.length, s3: 称呼表.length + 人称表.length }, 星: top.length, 口头禅: 口头禅.length, 不一致数: 不一致.length, 口径差: 口径说明.length };
}

/* ══ 主流程 ═════════════════════════════════════════════════════ */
if (WRITE) mkdirSync(OUT_DIR, { recursive: true });
const rows = [];
let drift = 0, emptySec = 0;
for (const r of roster) {
  const { md, 条目, 星, 口头禅, 不一致数, 口径差 } = build(r);
  const file = join(OUT_DIR, `${r.k}_${r.full}_词层清单.md`);
  const lines = 语料.get(r.k);
  const 语 = 语尾统计(lines);
  if (!条目.s1 || !条目.s2 || !条目.s3) { emptySec++; console.log(`✗ ${r.k}：空节 → §1=${条目.s1} §2=${条目.s2} §3=${条目.s3}`); }
  rows.push({ k: r.k, full: r.full, n: lines.length, extra: r.extra, ...条目, 星, 口头禅, 不一致数, 口径差, 率: pct1(语.hit, lines.length), 对账: 按话对账(r.k) });
  if (CHECK) {
    if (!existsSync(file)) { console.log(`✗ ${r.k}：产物缺失 → ${relative(WS, file)}`); drift++; }
    else if (readFileSync(file, 'utf8') !== md) { console.log(`✗ ${r.k}：产物与当前语料不一致（语料漂移或脚本改动）`); drift++; }
  } else if (WRITE) writeFileSync(file, md, 'utf8');
}

if (CHECK) {
  console.log(drift || emptySec ? `✗ 词层清单校验未通过：${drift} 份漂移、${emptySec} 份有空节` : `✓ 词层清单 ${rows.length} 份与语料逐字一致，三节全非空`);
  process.exit(drift || emptySec ? 1 : 0);
}
console.log(`${WRITE ? '已写' : '[dry] 可写'} ${rows.length} 份 → 角色模型/词层/`);
console.log('角色      行数  语尾率(本清单)  对账(按话诊断口径)  §1★/§1低/口头禅 / §2语域 / §3称呼+人称');
for (const x of [...rows].sort((a, b) => b.n - a.n)) {
  console.log(`${x.k.padEnd(6, '　')}${String(x.n).padStart(5)}   ${x.率.padStart(7)}        ${(x.对账 ? x.对账.率 + '%' : '—').padStart(7)}      ${x.星}/${x.s1 - x.星}/${x.口头禅} / ${x.s2} / ${x.s3}`);
}
const 可账 = rows.filter((x) => x.对账);
const 正编 = 可账.filter((x) => !x.extra);
const 低者 = [...正编].sort((a, b) => a.对账.率 - b.对账.率)[0], 高者 = [...正编].sort((a, b) => b.对账.率 - a.对账.率)[0];
console.log(`语尾率极差（按话诊断口径，25 名正编角色，运行时算）：${低者.k} ${低者.对账.率}% ↔ ${高者.k} ${高者.对账.率}%＝${(高者.对账.率 - 低者.对账.率).toFixed(1)} 个点（对照 交接计划 §五 记的 24 个点）`);
/* 附加角色不在 25 人正编极差里（那是「正编内部」的对照口径），但**理由不能一律写成样本过小**——
 * 真奈 n=15 确实够不上统计，薇欧拉 n=367 已经比多数正编角色还厚，写「样本过小」是错的。
 * 故按行数分说：n < 40 才判样本过小，否则如实写「样本充足，只是非正编、不进该极差」。 */
for (const x of 可账.filter((y) => y.extra)) {
  const n = x.对账.n;
  const why = n < 40 ? '样本过小（n<40），不计入极差' : `样本充足（n=${n}），但非 25 人正编，不进该极差`;
  console.log(`附加角色 ${x.k}：n=${n} 行，语尾率 ${x.对账.率}%，${why}`);
}
console.log(`§1 合计：★ 强信号 ${rows.reduce((a, x) => a + x.星, 0)} 条｜口头禅（通用词集中） ${rows.reduce((a, x) => a + x.口头禅, 0)} 条｜§3 rel 不一致 ${rows.reduce((a, x) => a + x.不一致数, 0)} 条（各份第三节列明）｜口径差 ${rows.reduce((a, x) => a + x.口径差, 0)} 条`);
