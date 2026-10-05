#!/usr/bin/env node
/**
 * verify_skill_lines.mjs —— 人设 skill 的 ⭐ 真台词主张对账（阶段 5 验收项「逐字可命中」的本地侧）
 *
 * 主张：`人设skill/<id>/references/lines.md` 里以 `- ⭐` 开头的每一行，都应能在**该角色自己的语料**里逐字定位。
 * 判据沿用 工具/verify_quotes.mjs 的规范化（只留汉字后做包含匹配），不另起一把尺子；
 * 但为防短句误命中，本脚本把匹配范围收紧到「同一说话单元内」，并把跨条粘连单独报数。
 *
 * 用法：node 工具/verify_skill_lines.mjs [--char <短名|skill目录名>] [--json] [--write] [--宽]
 *   --char 只看一人；--json 出机器可读；--write 才写 人设skill/_lines对账报告.md（默认只打印）；--宽 打印全部命中明细
 *
 * 只读：人设skill/ 与 素材全量/ 与 资料库/kb.json、工具/素材提取/aliases.json。绝不改写被检文件。
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { WS } from './_root.mjs';
import { CHARS, EXTRA_CHARS, corpusOf } from './角色表.mjs';

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const optVal = n => { const i = argv.findIndex(a => a === `--${n}`); return i >= 0 ? argv[i + 1] : null; };
const JSON_OUT = flag('json');
const WRITE = flag('write');
const VERBOSE = flag('宽');
const ONLY = optVal('char');

/* ---------------- 规范化与相似度（判据集中在此） ---------------- */

const NFKC = s => String(s).normalize('NFKC');
// 判据 A 用的「结构合并」：只去掉 markdown 列表符/软换行/首尾空白，不改任何一个正字字符
const structural = s => NFKC(s).replace(/[＊*＿_`]/g, '').replace(/\s+/g, '').trim();
// 判据 B 主口径：与 verify_quotes.mjs 的 norm 同一条尺子（NFKC 后仅保留汉字）
const normCJK = s => NFKC(s).replace(/[^\u4e00-\u9fa5]/g, '');
// 判据 B 的对照组：保留拉丁与数字，只删标点/空白/省略号——用来暴露「靠删拉丁命中」的量
const normKeepLatin = s => NFKC(s).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fa5]/g, '');

function bigrams(s) { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; }
function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const [k, v] of A) { const w = B.get(k); if (w) inter += Math.min(v, w); }
  return (2 * inter) / (a.length + b.length - 2 || 1);
}
function lcsLen(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1), cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev]; cur.fill(0);
  }
  return prev[b.length];
}
const simOf = (a, b) => dice(a, b) * 0.5 + (lcsLen(a, b) / Math.max(a.length, b.length)) * 0.5;
// 最长公共**连续**子串：用来把「整行不命中但行里有成块的原文」判成②改动而非①查无
function longestCommonSubstring(a, b) {
  if (!a.length || !b.length) return { len: 0, i: 0, j: 0 };
  let prev = new Uint16Array(b.length + 1), cur = new Uint16Array(b.length + 1);
  let best = 0, bi = 0, bj = 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
      if (cur[j] > best) { best = cur[j]; bi = i - best; bj = j - best; }
    }
    [prev, cur] = [cur, prev]; cur.fill(0);
  }
  return { len: best, i: bi, j: bj, str: a.slice(bi, bi + best) };
}
// 逐字符 diff（LCS 回溯），用汉字串对比，够人工判「抄错 or 非原句」
function diffChars(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, out = '';
  while (i < n && j < m) {
    if (a[i] === b[j]) { out += a[i]; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out += `【删${a[i]}】`; i++; }
    else { out += `【增${b[j]}】`; j++; }
  }
  while (i < n) { out += `【删${a[i++]}】`; }
  while (j < m) { out += `【增${b[j++]}】`; }
  return out;
}
// 候选单元远长于该行时，在成块原文附近取等长窗口，只跟这一段比（否则整串 diff 会被无关字淹没）
function bestWindow(cn, ln_, center) {
  let best = null;
  const L0 = ln_.length;
  for (let L = Math.max(2, L0 - 3); L <= Math.min(cn.length, L0 + 3); L++) {
    const from = Math.max(0, center - 4), to = Math.max(from, Math.min(cn.length - L, center + 4));
    for (let k = from; k <= to; k++) {
      const w = cn.slice(k, k + L);
      const s = simOf(ln_, w);
      if (!best || s > best.sim) best = { w, sim: s };
    }
  }
  return best;
}

/* ---------------- 语料：按「说话单元」切分 ---------------- */

const SKIP_SEC = /出处目录/;
function parseUnits(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let section = '', cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], ln = i + 1;
    if (/^#{1,6}\s/.test(raw)) { flush(); section = raw.replace(/^#+\s*/, ''); continue; }
    if (SKIP_SEC.test(section)) continue;
    if (/^\s*$/.test(raw)) { flush(); continue; }
    if (/^\s*<sub>/i.test(raw)) continue;
    if (/^>\s*\*\*[^*]+\*\*\s*｜/.test(raw)) continue;
    let body = raw.replace(/^\s*[-*+]\s+/, '').replace(/^\s*>\s*/, '');
    const sp = body.match(/^\*\*([^*]{1,14})\*\*(?:〔[^〕]*〕)?\s*[:：]?\s*/);
    const isUnitStart = /(^|\s)([-*+]\s|>\s)/.test(raw) || sp;
    if (isUnitStart) {
      flush();
      let speaker = null;
      if (sp) { speaker = sp[1]; body = body.slice(sp[0].length); }
      cur = { text: body.trim(), speaker, line: ln, sec: section };
      continue;
    }
    // 软换行续行与上一条同属一个说话单元（语料按 markdown 折行，不是两条台词）
    if (cur) cur.text += body.trim();
  }
  flush();
  return out.filter(u => u.text.length);
}

const TABLE = [...CHARS, ...EXTRA_CHARS];
const byShort = new Map(TABLE.map(c => [c.k, c]));

function surfacesFor(ch) {
  const base = `${ch.k}_${ch.full}.md`;
  const cand = [
    ['按角色', ch.corpus ? join(WS, ch.corpus) : corpusOf(ch)],
    ['按角色全量', join(WS, '素材全量', '按角色全量', 'zh-Hans', base)],
    ['角色台词补充', join(WS, '素材全量', '角色台词补充', 'zh-Hans', '按角色', base)],
  ];
  const seen = new Set(), out = [];
  for (const [tag, p] of cand) {
    if (!existsSync(p) || seen.has(p)) continue;
    seen.add(p);
    const text = readFileSync(p, 'utf8');
    const units = parseUnits(text).map(u => ({ ...u, st: structural(u.text), nu: normCJK(u.text), ku: normKeepLatin(u.text) }));
    // 同节内相邻单元拼成一个串：命中它 = 作者把同一场景的连续两句并成了一句（不是单条原句）
    const bySec = new Map();
    for (const u of units) {
      const k = u.sec || '';
      if (!bySec.has(k)) bySec.set(k, { first: u.line, s: '', n: '' });
      const g = bySec.get(k);
      g.s += structural(u.text);
      g.n += normCJK(u.text);
    }
    out.push({
      tag, p, rel: relative(WS, p).replace(/\\/g, '/'), text, units,
      phys: text.split(/\r?\n/),
      glued: [...bySec.values()],
    });
  }
  return out;
}

/* ---------------- 全树（仅诊断用：判「③搜索面不足 / ④跨人命中」） ---------------- */

const ALIAS = JSON.parse(readFileSync(join(WS, '工具', '素材提取', 'aliases.json'), 'utf8'));
const KB = JSON.parse(readFileSync(join(WS, '资料库', 'kb.json'), 'utf8'));
const keyNorm = s => NFKC(String(s ?? '')).replace(/[『』「」（）()［］\[\]]/g, '').replace(/[\s\u3000]/g, '').replace(/[？?！!。．.]+$/, '');
const spKey = new Map();
for (const c of KB.characters) {
  if (!byShort.has(c.name_short)) continue;
  for (const k of [c.name_short, c.name, ...(c.aliases || []), ...(c.stage ? [c.stage] : [])]) {
    const n = keyNorm(k); if (n && !spKey.has(n)) spKey.set(n, c.name_short);
  }
}
for (const a of ALIAS.characters || []) {
  if (!byShort.has(a.short)) continue;
  for (const k of [a.short, a.shortJa, a.real, a.realJa, a.stageName, a.stageNameJa]) {
    const n = keyNorm(k); if (n && !spKey.has(n)) spKey.set(n, a.short);
  }
}
const stageMap = new Map(Object.entries(ALIAS.stageNameToShort || {}).map(([k, v]) => [keyNorm(k), v]));
for (const [k, v] of stageMap) if (!spKey.has(k)) spKey.set(k, v);

let TREE = null;
function loadTree() {
  if (TREE) return TREE;
  const root = join(WS, '素材全量', '按话', 'zh-Hans');
  const units = [];
  const walk = d => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) { walk(p); continue; }
      if (!f.name.endsWith('.md')) continue;
      const rel = relative(WS, p).replace(/\\/g, '/');
      for (const u of parseUnits(readFileSync(p, 'utf8'))) {
        if (!u.speaker) continue;
        units.push({ sp: u.speaker, who: spKey.get(keyNorm(u.speaker)) || null, text: u.text, norm: normCJK(u.text), ref: `${rel}:${u.line}` });
      }
    }
  };
  walk(root);
  TREE = units;
  return TREE;
}

/* ---------------- lines.md 抽取 ---------------- */

function extractLines(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const title = (lines.find(l => /^#\s/.test(l)) || '').replace(/^#\s*/, '').replace(/台词语料库.*$/, '').trim();
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!/^- /.test(raw)) continue;
    const ln = i + 1;
    const body = raw.slice(2).trim();
    if (/^\[.*\]\(#/.test(body)) continue;                    // 目录锚点
    let starred = false, text = body;
    const sm = body.match(/^⭐\s*(.*)$/u);
    if (sm) { starred = true; text = sm[1].trim(); }
    if (!text) { items.push({ ln, starred, kind: '空⭐', text: '' }); continue; }
    let kind = starred ? 'plain' : 'plain';
    const feed = !starred && text.match(/^(\S{1,6})：(.+)$/su);
    if (feed) { kind = 'feed'; }
    if (/^\*[（(].*\)[＊*]?$/u.test(text) || /^（.*）$/u.test(text)) kind = 'aside';
    items.push({ ln, starred, kind, text, feedText: feed ? feed[2].trim() : null, section: '' });
  }
  let sec = '(前言)', si = 0;
  const heads = [];
  for (let i = 0; i < lines.length; i++) if (/^##\s/.test(lines[i])) heads.push({ ln: i + 1, t: lines[i].replace(/^##\s*/, '') });
  for (const it of items) { while (si < heads.length && heads[si].ln < it.ln) { sec = heads[si].t; si++; } it.section = sec; }
  return { title, items };
}

/* ---------------- 判定 ---------------- */

function judge(text, surfaces, noSim) {
  const sText = structural(text);
  const nText = normCJK(text);
  const kText = normKeepLatin(text);
  const hasLatin = /[0-9a-zA-Z]/.test(NFKC(text));
  const res = { verbatimRaw: null, verbatimJoin: null, normalized: null, latinOnly: null, glue: null, glueNorm: null, best: null };
  for (const s of surfaces) {
    // A1：某条**物理行**原样包含（连软换行都不用并）
    const li = s.phys.findIndex(l => l.includes(text));
    if (li >= 0) res.verbatimRaw ||= { where: `${s.rel}:${li + 1}`, tag: s.tag, unit: s.phys[li].trim(), full: s.phys[li].replace(/^\s*[-*+>\s]+/, '') };
    for (const u of s.units) {
      const st = u.st, nu = u.nu, ku = u.ku;
      const ref = `${s.rel}:${u.line}`, tag = s.tag;
      if (sText.length && st.includes(sText)) res.verbatimJoin ||= { where: ref, tag, unit: u.text, full: u.text };
      if (nText.length >= 4 ? nu.includes(nText) : (nu === nText && nText.length > 0)) {
        if (hasLatin && !ku.includes(kText)) res.latinOnly ||= { where: ref, tag, unit: u.text, full: u.text };
        else res.normalized ||= { where: ref, tag, unit: u.text, full: u.text };
      }
      if (!noSim) {
        const sim = (nText.length && nu.length) ? simOf(nText, nu) : 0;
        if (sim > (res.best?.sim || 0)) res.best = { sim, where: ref, tag, unit: u.text };
      }
    }
    for (const g of s.glued) {
      if (sText.length >= 6 && g.s.includes(sText)) res.glue ||= { where: `${s.rel}（自 L${g.first} 的相邻单元）`, tag: s.tag };
      if (nText.length >= 6 && g.n.includes(nText)) res.glueNorm ||= { where: `${s.rel}（自 L${g.first} 的相邻单元）`, tag: s.tag };
    }
  }
  return res;
}

// 只在未命中时才算：语料里到底有没有成块的原文（>=6 汉字）——用于区分「②改写过」与「①查无」
function surfaceChunk(needle, surfaces) {
  const n = normCJK(needle);
  if (n.length < 4) return null;
  const grams = new Set();
  for (let i = 0; i + 3 <= n.length; i++) grams.add(n.slice(i, i + 3));
  if (!grams.size) grams.add(n);
  let best = null;
  for (const s of surfaces) {
    for (const u of s.units) {
      const nu = u.nu;
      if (nu.length < 4) continue;
      let shares = false;
      for (let i = 0; i + 3 <= nu.length; i++) if (grams.has(nu.slice(i, i + 3))) { shares = true; break; }
      if (!shares) continue;
      const q = longestCommonSubstring(n, nu);
      if (q.len < 6) continue;
      if (q.len > (best?.len || 0)) best = { ...q, where: `${s.rel}:${u.line}`, tag: s.tag, unit: u.text };
    }
  }
  return best;
}

function treeDiagnose(text, selfShort) {
  const n = normCJK(text);
  if (n.length < 3) return null;
  const tree = loadTree();
  const g = n.length >= 4 ? 3 : 2;
  const grams = new Set();
  for (let i = 0; i + g <= n.length; i++) grams.add(n.slice(i, i + g));
  if (!grams.size) grams.add(n);
  let exactAny = null, chunkSelf = null, chunkOther = null;
  for (const u of tree) {
    if (n.length >= 4 ? u.norm.includes(n) : u.norm === n) exactAny ||= u;
    if (n.length < 4 || u.norm.length < 4) continue;
    let shares = false;                                    // 三元组预筛，避免对全树跑 DP
    for (let i = 0; i + g <= u.norm.length; i++) if (grams.has(u.norm.slice(i, i + g))) { shares = true; break; }
    if (!shares) continue;
    const q = longestCommonSubstring(n, u.norm);
    if (q.len < 6) continue;
    if (u.who === selfShort) { if (q.len > (chunkSelf?.len || 0)) chunkSelf = { ...q, ref: u.ref, text: u.text }; }
    else if (u.who) { if (q.len > (chunkOther?.len || 0)) chunkOther = { ...q, ref: u.ref, text: u.text, who: u.who, sp: u.sp }; }
  }
  return { exactAny, chunkSelf, chunkOther };
}

/* ---------------- 主流程 ---------------- */

const SKILL_ROOT = join(WS, '人设skill');
const skillDirs = readdirSync(SKILL_ROOT).filter(d => existsSync(join(SKILL_ROOT, d, 'references', 'lines.md')));
const report = { generatedBy: '工具/verify_skill_lines.mjs', chars: [], totals: {} };
const problems = [];

for (const dir of skillDirs.sort()) {
  const file = join(SKILL_ROOT, dir, 'references', 'lines.md');
  const { title, items } = extractLines(file);
  const ch = byShort.get(title);
  if (!ch) { problems.push(`skill ${dir}：标题「${title}」在 角色表 里查无此人，跳过`); continue; }
  if (ONLY && ONLY !== dir && ONLY !== ch.k) continue;
  const surfaces = surfacesFor(ch);
  if (!surfaces.length) { problems.push(`${ch.k}：无任何语料文件`); continue; }
  const unitCount = surfaces.reduce((a, s) => a + s.units.length, 0);

  const starred = items.filter(i => i.starred);
  const unstarred = items.filter(i => !i.starred && i.kind !== 'aside');
  const asides = items.filter(i => i.kind === 'aside');
  const feeds = items.filter(i => !i.starred && i.kind === 'feed');

  const rows = [];
  const seen = new Set();
  for (const it of starred) {
    const raw = it.text;
    // 变体：原样 / 去外裹「」『』 / 去行尾作者括注（括注含拉丁或元话语词才算）
    const unwrapped = raw.replace(/^「(.*)」$/s, '$1').replace(/^『(.*)』$/s, '$1');
    const annM = raw.match(/^(.*\S)\s*（([^（）]*)）$/u);
    const annotated = !!(annM && (/[A-Za-z]/.test(annM[2]) || /tagline|占位|示例|自拟|登场|必备|待补|改写/.test(annM[2])));
    const variants = [{ t: raw, kind: 'raw' }];
    if (unwrapped !== raw) variants.push({ t: unwrapped, kind: 'wrap' });
    if (annotated) variants.push({ t: annM[1], kind: 'anno', anno: annM[2] });
    const segs = [...raw.matchAll(/[「『]([^」』]+)[」』]/g)].map(m => m[1]).filter(s => s.length >= 4);
    const multiSeg = raw.includes('」「') && segs.length >= 2;

    let pick = null;
    for (const v of variants) {
      const jj = judge(v.t, surfaces);
      if (jj.verbatimRaw || jj.verbatimJoin || jj.normalized || jj.latinOnly) { pick = { v, j: jj }; break; }
    }
    const j = pick?.j || judge(raw, surfaces);
    const hitRef = pick ? (j.verbatimRaw || j.verbatimJoin || j.normalized || j.latinOnly) : null;
    const tier = pick ? (j.verbatimRaw ? 'A1' : j.verbatimJoin ? 'A2' : j.normalized ? 'B' : 'B2') : 'M';
    let sub = null, note = '';
    const glueHit = !!(j.glue || j.glueNorm);
    const frag = (() => {
      if (tier === 'M') return 0;
      const e = structural(hitRef.full || '').length - structural(pick.v.t).length;
      return e >= 6 ? e : 0;
    })();

    if (tier !== 'M') {
      note = hitRef.where;
      if (frag) note += ` [截取自更长原句：语料该条多 ${frag} 字]`;
      if (pick.v.kind === 'wrap') note += ' [仅外裹「」差异]';
      if (pick.v.kind === 'anno') note += ` [⭐行内含作者括注「${pick.v.anno}」，去注后才逐字]`;
    } else if (multiSeg) {
      const seg = segs.map(sg => { const q = judge(sg, surfaces); const t = q.verbatimRaw ? 'A1' : q.verbatimJoin ? 'A2' : q.normalized ? 'B' : q.latinOnly ? 'B2' : null; return { sg, t, w: t ? (q.verbatimRaw || q.verbatimJoin || q.normalized || q.latinOnly).where : null }; });
      const detail = seg.map(x => `「${x.sg}」${x.t ? `[${x.t}] ${x.w}` : '[✗ 语料无对应原句]'}`).join(' ｜ ');
      if (seg.every(x => x.t)) { sub = '⑤'; note = `⑤分段并句引用：${seg.length} 段各自都能命中，但整行不是语料里的连续原句\n      ${detail}`; }
      else { sub = '①'; note = `①分段并句引用，且其中有段查无\n      ${detail}`; }
    } else if (j.glue || j.glueNorm) {
      sub = '⑤';
      note = `⑤跨条拼接：${j.glue ? '逐字' : '规范化'}口径下、与同节相邻单元拼起来才连续 —— 出处 ${(j.glue || j.glueNorm).where}；语料里本是**两条**，被并成一行`;
    } else {
      const dg = treeDiagnose(raw, ch.k);
      const sc = surfaceChunk(raw, surfaces);
      const bestChunk = [sc, dg?.chunkSelf && { ...dg.chunkSelf, where: dg.chunkSelf.ref, src: '按话树', unit: dg.chunkSelf.text }]
        .filter(Boolean).sort((a, b) => b.len - a.len)[0] || null;
      if (dg?.exactAny && dg.exactAny.who === ch.k) { sub = '③'; note = `③主搜面漏了（须扩面，属脚本/语料面问题）：按话归属本人命中 ${dg.exactAny.ref}「${dg.exactAny.text}」`; }
      else if (dg?.exactAny && dg.exactAny.who && dg.exactAny.who !== ch.k) { sub = '④'; note = `④整段命中在**别人**的台词里：说话人「${dg.exactAny.sp}」→ ${dg.exactAny.who}（${dg.exactAny.ref}）「${dg.exactAny.text}」——OOC 事故`; }
      else if (bestChunk && bestChunk.len >= Math.max(6, Math.round(normCJK(raw).length * 0.4))) {
        sub = '②';
        const cand = bestChunk.unit || '';
        const cn = normCJK(cand), ln_ = normCJK(raw);
        const comparable = Math.abs(cn.length - ln_.length) <= Math.max(8, ln_.length * 0.6);
        const excerpt = bestChunk.len >= cn.length - 2 ? cand : `…${cand.slice(Math.max(0, bestChunk.j - 10), bestChunk.j + bestChunk.len + 10)}…`;
        note = `②语料里有同一句但被改动（成块原文 ${bestChunk.len} 字「${bestChunk.str}」，出自${bestChunk.src || bestChunk.tag} ${bestChunk.where}）\n      候选单元：「${excerpt}」`;
        const outside = (ln_.slice(0, bestChunk.i) + ln_.slice(bestChunk.i + bestChunk.len)).replace(/^[、，。]+|[、，。]+$/g, '');
        note += `\n      该行里不属于这段原文的部分（汉字层）：${outside ? '「' + outside + '」' : '（无——整行只差标点）'}`;
        if (comparable) note += `\n      diff（汉字层；删=lines.md 多写的字，增=lines.md 漏掉的字）：${diffChars(ln_, cn)}`;
        else {
          const w = bestWindow(cn, ln_, bestChunk.j);
          note += `\n      （候选单元比该行长很多，属从长段里摘句改写；只与该段最接近的窗口比：「${w.w}」，相似度 ${(w.sim * 100).toFixed(0)}%）\n      diff（汉字层；删=lines.md 多写的字，增=lines.md 漏掉的字）：${diffChars(ln_, w.w)}`;
        }
        if (dg?.chunkOther && dg.chunkOther.len > bestChunk.len + 4) note += `\n      跨人提示：更长的成块原文在 ${dg.chunkOther.who} 的台词里（${dg.chunkOther.ref}）`;
      } else {
        sub = '①';
        note = `①语料里查无此句${bestChunk ? `（最长成块原文仅 ${bestChunk.len} 字「${bestChunk.str}」，见 ${bestChunk.where}）` : '（无任何 ≥6 字的成块原文）'}` +
          (j.best ? `\n      最近候选（相似度 ${(j.best.sim * 100).toFixed(0)}%）${j.best.tag} ${j.best.where}「${j.best.unit}」` : '');
        if (dg?.chunkOther) note += `\n      跨人提示：${dg.chunkOther.len} 字成块原文出现在 ${dg.chunkOther.who} 的台词里（${dg.chunkOther.ref}「${dg.chunkOther.text}」）`;
      }
    }
    rows.push({ text: raw, ln: it.ln, section: it.section, tier, sub, note, dup: seen.has(raw), loose: tier !== 'M' || glueHit, frag,
      wrapped: unwrapped !== raw,
      corpus: (tier === 'B' || tier === 'B2' || frag) ? hitRef.unit : null });
    seen.add(raw);
  }

  const missRows = rows.filter(r => r.tier === 'M');
  const unstarCheck = [];
  for (const it of unstarred) {
    const t = it.kind === 'feed' ? it.feedText : it.text;
    if (!t || t.length < 4) continue;
    const j = judge(t, surfaces);
    const tier = j.verbatimRaw ? 'A1' : j.verbatimJoin ? 'A2' : j.normalized ? 'B' : j.latinOnly ? 'B2' : null;
    if (tier) unstarCheck.push({ text: t, ln: it.ln, tier, kind: it.kind, short: normCJK(t).length < 6, where: (j.verbatimRaw || j.verbatimJoin || j.normalized || j.latinOnly).where });
  }

  const cnt = { A1: 0, A2: 0, B: 0, B2: 0, M: 0 };
  for (const r of rows) cnt[r.tier]++;
  report.chars.push({
    skill: dir, short: ch.k, full: ch.full, band: ch.band, file: relative(WS, file).replace(/\\/g, '/'),
    surfaces: surfaces.map(s => ({ tag: s.tag, rel: s.rel, units: s.units.length })), unitCount,
    starredTotal: rows.length, uniqueStarred: rows.filter(r => !r.dup).length,
    dupStarred: rows.filter(r => r.dup).length,
    unstarredTotal: unstarred.length, asideTotal: asides.length, feedTotal: feeds.length,
    rows,
    wrappedStar: rows.filter(r => r.wrapped).length,
    wrapOnlyStar: rows.filter(r => /仅外裹「」差异/.test(r.note)).length,
    annoStar: rows.filter(r => /作者括注/.test(r.note)).length,
    fragStar: rows.filter(r => r.frag).length,
    looseStar: rows.filter(r => r.loose).length,
    latinOnly: cnt.B2,
    subs: rows.reduce((a, r) => { if (r.sub) a[r.sub] = (a[r.sub] || 0) + 1; return a; }, {}),
    tiers: cnt, hitRate: rows.length ? (rows.length - cnt.M) / rows.length : 0,
    miss: missRows, unstarredHits: unstarCheck,
  });
}

/* 判据自证：把每人的 ⭐ 行拿去问「同队语料最多的另一个人」——命中应接近 0，否则说明匹配太松 */
const control = { tested: 0, hits: [], partnerOf: {} };
const byBand = {};
for (const c of report.chars) (byBand[c.band] ||= []).push(c);
for (const c of report.chars) {
  const grp = (byBand[c.band] || []).filter(x => x.short !== c.short).sort((a, b) => b.unitCount - a.unitCount);
  const partner = grp[0] || report.chars.find(x => x.short !== c.short);
  if (!partner) continue;
  control.partnerOf[c.short] = partner.short;
  const ps = surfacesFor(byShort.get(partner.short));
  for (const r of c.rows) {
    control.tested++;
    const q = judge(r.text, ps, true);
    const t = q.verbatimRaw ? 'A1' : q.verbatimJoin ? 'A2' : q.normalized ? 'B' : null;
    if (t) control.hits.push({ who: c.short, partner: partner.short, text: r.text, tier: t });
  }
}
report.control = control;

report.totals = report.chars.reduce((a, c) => {  for (const k of ['A1', 'A2', 'B', 'B2', 'M']) a[k] += c.tiers[k];
  a.star += c.starredTotal; a.unstar += c.unstarredTotal; a.aside += c.asideTotal; a.dup += c.dupStarred;
  a.unstarHits += c.unstarredHits.length; a.wrap += c.wrapOnlyStar; a.wrapForm += c.wrappedStar; a.anno += c.annoStar;
  a.frag += c.fragStar; a.loose += c.looseStar;
  for (const [k, v] of Object.entries(c.subs)) a['sub_' + k] = (a['sub_' + k] || 0) + v;
  a.units += c.unitCount;
  return a;
}, { A1: 0, A2: 0, B: 0, B2: 0, M: 0, star: 0, unstar: 0, aside: 0, dup: 0, unstarHits: 0, wrap: 0, wrapForm: 0, anno: 0, frag: 0, loose: 0, units: 0 });

/* ---------------- 输出 ---------------- */

function render() {
  const T = report.totals;
  const L = [];
  L.push('# 人设 skill ⭐ 台词逐字对账报告', '');
  L.push(`生成：\`node 工具/verify_skill_lines.mjs --write\` ｜ 检出 skill ${report.chars.length} 份 ｜ ⭐ 行合计 **${T.star}**（其中 ${T.dup} 行是同文件重复引用，按出现次数计）。`, '');
  L.push('## 判据（事先写死，三档分别计数）', '');
  L.push('搜索面（**只在该角色自己的语料文件里找，不跨人**；路径全部由 `工具/角色表.mjs` 派生，不手拼）：', '');
  L.push('- `素材全量/按角色/zh-Hans/<乐队>/<短名>_<全名>.md`（真奈按 `EXTRA_CHARS` 走 `按角色全量`）', '- `素材全量/按角色全量/zh-Hans/<短名>_<全名>.md`', '- `素材全量/角色台词补充/zh-Hans/按角色/<短名>_<全名>.md`', '');
  L.push([
    '**A1 逐字命中**：去掉 `- ⭐ ` 标记后的整行，是语料某条**物理行**的连续子串——零字符差异。',
    '**A2 逐字命中（需并软换行）**：语料按 markdown 折行（行尾两空格），把同一说话单元的续行拼接后才连续。字符仍零差异，只是换行位置不同（那是抽取物的排版，不是改写）。',
    '**B 规范化后命中**：两侧先 NFKC（全角→半角），再删除所有非汉字字符（标点、省略号各形式 `……`／`…`／`...`／`～`／`~`、空格、括号、引号 `「」『』`、拉丁字母、数字、`♪`），然后在**同一说话单元内**做包含匹配；汉字数 <4 的短句要求整单元相等（防「早」命中任意位置）。规范化尺子与 `工具/verify_quotes.mjs` 的 `norm`（只留汉字）同一条，不另起；但匹配范围从「整文件拼接」收紧为「单条说话单元」——这是**变严**，不是变松。',
    '**B2 仅靠删拉丁命中**：行内含拉丁/数字、删掉拉丁才命中（对照组「保留拉丁与数字、只删标点空白」不命中）。单列报数，不与 B 混。',
    '**M 未命中**：A1/A2/B/B2 皆不成立，再按证据分五小类——① 语料里根本没有（疑似作者编写）；② 语料里有同一句但被改动（给成块原文位置 + 汉字层 diff）；③ 语料里有、主搜面未覆盖（**脚本 bug，必须为 0**）；④ 整段命中在别人的台词里（OOC 事故）；⑤ 跨条拼接／分段并句：字都在语料里，但语料本是相邻两条（或散在几行），被并成一行——不算逐字，单独成类。',
    '**只作对照、不入任何命中档**：`verify_quotes.mjs` 的实际口径是整文件拼接后 `includes`（本报告的「同节拼接」是它的收紧版）。它会跨两条不同台词粘连成一句话，所以拿它当主判据就会把并句当成原句。',
  ].map(x => `- ${x}`).join('\n'), '');
  L.push('## 汇总（26 人 × 三档）', '');
  L.push('| skill | 角色 | 语料面 | 单元数 | ⭐行 | A1逐字 | A2并换行 | B规范化 | B2仅删拉丁 | M未命中 | 命中率 | 未命中小类 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of report.chars.slice().sort((a, b) => a.hitRate - b.hitRate || a.short.localeCompare(b.short, 'zh'))) {
    const sb = Object.entries(c.subs).map(([k, v]) => `${k}${v}`).join(' ');
    L.push(`| \`${c.skill}\` | ${c.short}（${c.full}） | ${c.surfaces.map(s => s.tag).join('+')} | ${c.unitCount} | ${c.starredTotal} | ${c.tiers.A1} | ${c.tiers.A2} | ${c.tiers.B} | ${c.tiers.B2} | ${c.tiers.M} | ${(c.hitRate * 100).toFixed(1)}% | ${sb || '—'} |`);
  }
  L.push(`| **合计** | | | ${T.units} | **${T.star}** | **${T.A1}** | **${T.A2}** | **${T.B}** | **${T.B2}** | **${T.M}** | **${((T.star - T.M) / T.star * 100).toFixed(1)}%** | ${['①', '②', '③', '④', '⑤'].map(k => `${k}${T['sub_' + k] || 0}`).join(' ')} |`, '');
  L.push(`命中率 =（A1+A2+B+B2）/ ⭐行数。其中 A1+A2 = **${T.A1 + T.A2} / ${T.star} = ${((T.A1 + T.A2) / T.star * 100).toFixed(1)}%** 是零字符差异的逐字命中。`, '');
  L.push('## 未命中明细（逐条附证据）', '');
  const kinds = { '①': [], '②': [], '③': [], '④': [], '⑤': [] };
  for (const c of report.chars) for (const m of c.miss) {
    const kk = m.sub || '①';
    (kinds[kk] ||= []).push({ ...m, who: c.short, skill: c.skill, file: c.file });
  }
  L.push(`计：①语料无 ${kinds['①'].length} ｜ ②有但被改 ${kinds['②'].length} ｜ ③主搜面漏 ${kinds['③'].length} ｜ ④跨人命中 ${kinds['④'].length} ｜ ⑤拼接并句 ${kinds['⑤'].length}`, '');
  const titles = {
    '①': '语料里根本没有（疑似作者编写）',
    '②': '语料里有同一句但被改动过（附 diff）',
    '③': '语料里有、主搜面未覆盖（脚本须扩面，不接受）',
    '④': '命中他人台词（OOC 事故）',
    '⑤': '跨条拼接 / 分段并句（字都在语料，但不是语料里的一条原句）',
  };
  for (const [kk, arr] of Object.entries(kinds)) {
    if (!arr.length) continue;
    L.push(`### ${kk} ${titles[kk]}（${arr.length} 条）`, '');
    for (const m of arr) L.push(`- \`${m.file}:${m.ln}\`【${m.who}｜${m.section}】${m.text}\n  ${m.note}`);
    L.push('');
  }
  L.push('## 规范化档（B/B2）逐条对照——供复核判据有没有放宽过头', '');
  const bRows = [];
  for (const c of report.chars) for (const r of c.rows) if (r.tier === 'B' || r.tier === 'B2') bRows.push({ ...r, who: c.short });
  if (!bRows.length) L.push('（本批 0 条）');
  for (const r of bRows) {
    const d = diffChars(normCJK(r.text), normCJK(r.corpus));
    L.push(`- **${r.who}** L${r.ln}［${r.tier}］\n  - lines.md：${r.text}\n  - 语料（${r.note}）：${r.corpus}\n  - 汉字层差异：${d.startsWith('【') || d.includes('【') ? d : '（无，纯标点/空白/全半角之差）'}`);
  }
  L.push('', `## 命中但是「半句截取」的（语料该条更长 ≥6 字）：${T.frag} 条`, '');
  const fRows = [];
  for (const c of report.chars) for (const r of c.rows) if (r.frag) fRows.push({ ...r, who: c.short });
  for (const r of fRows) L.push(`- **${r.who}** L${r.ln}（多 ${r.frag} 字）lines.md：${r.text}\n  语料：${r.corpus}`);
  L.push('## 反向对账：未标 ⭐ 的行里其实是原句的（漏标）', '');
  const perChar = report.chars.filter(c => c.unstarredHits.length).sort((a, b) => b.unstarredHits.length - a.unstarredHits.length);
  const nShort = perChar.reduce((a, c) => a + c.unstarredHits.filter(h => h.short).length, 0);
  L.push(`未标 ⭐ 的候选行 ${T.unstar} 条（另 ${T.aside} 条斜体旁白不判），其中能命中自己语料的 **${T.unstarHits}** 条；扣掉 ≤5 汉字的短句（命中不稀缺、参考价值低）${nShort} 条，剩 **${T.unstarHits - nShort}** 条是像样的漏标：`, '');
  if (!perChar.length) L.push('（无）');
  for (const c of perChar) L.push(`- **${c.short}**（${c.unstarredHits.length} 条）：\n` + c.unstarredHits.map(h => `  - L${h.ln} [${h.tier}｜${h.kind}]${h.short ? '（≤5字短句）' : ''} ${h.text}`).join('\n'));
  L.push('', '## 判据自证：串人对照（证明这把尺子不是太松）', '');
  const CT = report.control;
  L.push(`把每人的 ⭐ 行拿去问**同队另一个人**（语料最多的那位）的语料，同一套 A1/A2/B 判据：命中 **${CT.hits.length}/${CT.tested}**。`);
  L.push(CT.hits.length <= CT.tested * 0.1
    ? `→ 串人命中率 ${(CT.hits.length / CT.tested * 100).toFixed(1)}%，说明这套判据**有区分度**：换成别人的语料就基本不命中，本报告的命中不是「随便都能撞上」的松匹配。`
    : `→ 串人命中率 ${(CT.hits.length / CT.tested * 100).toFixed(1)}% **偏高，判据可能过松**，下面的命中数要打折看。`);
  if (CT.hits.length) {
    L.push('', '串人命中明细（多为通用短句，列出供你判）：');
    for (const h of CT.hits) L.push(`- ${h.who} 的行「${h.text}」在 ${h.partner} 的语料里 [${h.tier}] 也命中`);
  }
  L.push('', '对照伙伴：', Object.entries(CT.partnerOf).map(([k, v]) => `${k}↔${v}`).join('、'));
  L.push('', '## 其它形式统计（只上报不判）', '');
  L.push(`- ⭐ 行整体被「」/『』裹着的：${T.wrapForm} 条（判定时先去壳再判，壳本身就是标点差异）；其中**只有去壳才命中**的：${T.wrap} 条——其余带壳行按原样就已命中（语料那行同样带壳，或规范化档把壳连同标点一起抹掉）。`);
  L.push(`- ⭐ 行里**掺了作者括注**（行尾（……）含拉丁或元话语）：${T.anno} 条（去注后才逐字命中；这类行应把注移到行外）`);
  L.push(`- 命中但**是从更长原句里截出来的**（语料该条比该行多 ≥6 字）：${T.frag} 条 —— 逐字没问题，但它引用的是半句`);
  L.push(`- 对照：若按 \`verify_quotes.mjs\` 的原始口径（整文件拼接后 includes，允许跨条粘连），命中会是 **${T.loose}/${T.star} = ${(T.loose / T.star * 100).toFixed(1)}%**，比本报告的 ${((T.star - T.M) / T.star * 100).toFixed(1)}% 高 ${((T.loose - (T.star - T.M)) / T.star * 100).toFixed(1)} 个点 —— 差额就是被并成「一句」的多条台词。本报告用严口径。`);
  L.push(`- 同文件重复出现的 ⭐ 行：${T.dup} 条（重复引用，按出现次数计）`);
  L.push(`- 「- 🍫 名：台词」带 emoji 标签的行（全部未标 ⭐）：${report.chars.reduce((a, c) => a + c.feedTotal, 0)} 条`);
  L.push('', '## 结论（数据由脚本算，判语按下面的阈值规则生成）', '');
  const strict = (T.A1 + T.A2) / T.star, all = (T.star - T.M) / T.star;
  const worst = report.chars.filter(c => c.tiers.M > 0).sort((a, b) => a.hitRate - b.hitRate);
  L.push(`- 逐字（零字符差异）命中 **${strict * 100 > 85 ? '站得住' : '不站得住'}**：${T.A1 + T.A2}/${T.star} = ${(strict * 100).toFixed(1)}%；放宽到规范化档后 ${(all * 100).toFixed(1)}%（${T.star - T.M}/${T.star}）。`, '');
  const n3 = T['sub_③'] || 0, n4 = T['sub_④'] || 0, n1 = T['sub_①'] || 0, n2 = T['sub_②'] || 0, n5 = T['sub_⑤'] || 0;
  const verdict = n3 > 0 ? '**先别用**：还有 ③ 类（搜索面漏检），说明是脚本 bug 没修完'
    : all >= 0.9 ? '整体**可信**' : all >= 0.8 ? '整体**勉强可信**（缺口集中在少数人）' : '整体**不可信**，需按角色重做';
  L.push(`- **一句结论**：这批 ⭐ 标记${verdict}——${(all * 100).toFixed(1)}% 能回校到本人语料，③（搜索面漏检）${n3} 条、④（跨人命中/OOC）${n4} 条；但**不是全绿**：${T.M} 条回校不上（①编写 ${n1}／②改动 ${n2}／⑤并句 ${n5}），另有 ${T.frag} 条（占 ${(T.frag / T.star * 100).toFixed(0)}%）是从更长原句里截出来的半句。拿去当**腔调范本**用没问题；当**逐字引用**（尤其出盲测题）必须先清掉上面这些。`, '');
  if (worst.length) {
    L.push('', `### 需要返工的（按命中率从低到高）：${worst.length} 人`, '');
    for (const c of worst) L.push(`- **${c.short}**（命中率 ${(c.hitRate * 100).toFixed(1)}%，未命中 ${c.tiers.M}：${Object.entries(c.subs).map(([k, v]) => `${k}${v}`).join(' ')}）`);
  }
  const thin = report.chars.filter(c => c.unitCount < 200);
  L.push('', '## 口径局限（不确定处如实列出）', '');
  L.push('- **只搜 zh-Hans 面**：skill 里的 ⭐ 行是中文，`素材全量/按角色/ja` 与日文原文不构成逐字对照关系，故意不搜。若某行的中文其实译自日文台词，本脚本会判它 ①/②，而这属于「抽取面的语种缺口」，不是编写问题——需要时另配 ja→zh 对照。');
  L.push('- **简繁规则未触发**：规范化只做到 NFKC + 删除非汉字，两侧语料与 skill 均为简体（zh-Hans），实测无一体两形；将来引入繁体面时必须补简繁转换，否则这套尺子会漏判。');
  L.push(`- **短句命中不稀缺**：≤5 汉字的行按判据要求「整单元相等」，但像「……嗯。」「我知道了。」这种谁都会撞上，所以反向对账里的 ${nShort} 条短句只作参考，不当漏标缺陷；反之，⭐ 行里的短句命中也不等于高质量引用。`);
  if (thin.length) L.push(`- **语料面偏薄者命中率虚高**：${thin.map(c => `${c.short}（本人语料仅 ${c.unitCount} 条说话单元、⭐ ${c.starredTotal} 行、其中重复 ${c.dupStarred} 行）`).join('；')}——在这种面上「逐字可命中」几乎不可能失败，不能与其它人同栏比较。`);
  L.push(`- **B2（仅靠删拉丁才命中）= ${T.B2} 条**：说明没有出现「靠丢掉英文名/数字才蒙上」的灰色行；规范化档 ${T.B} 条全部是纯标点/空白/全半角之差（见上文逐条对照），汉字层零差异。`);
  L.push('- **本报告不判「该不该引用」**：⭐ 只声明「出自真实台词库」，脚本只验字面来源。语义是否贴人设、有无 OOC，属阶段 5 的盲测与人工审读范围。', '');
  L.push('', '## 建议处置（只列不改，等你拍板）', '');
  const act = [];
  for (const c of report.chars) for (const r of c.rows) {
    if (r.tier === 'M' && (r.sub === '①' || r.sub === '④')) act.push([`**摘除或去 ⭐**（语料里查无此句${r.sub === '④' ? '，且整段属于别人' : ''}）`, `${c.file}:${r.ln}`, r.text]);
    if (r.tier === 'M' && r.sub === '②') act.push(['**改回语料原句**（或降为不带 ⭐ 的仿写）', `${c.file}:${r.ln}`, r.text]);
    if (r.tier === 'M' && r.sub === '⑤') act.push(['**拆回两条**（语料里本是相邻两句）或去 ⭐', `${c.file}:${r.ln}`, r.text]);
    if (r.tier === 'M' && r.sub === '③') act.push(['**先修脚本/扩面**（不许记为失败）', `${c.file}:${r.ln}`, r.text]);
    if (r.tier !== 'M' && /作者括注/.test(r.note)) act.push(['**把作者括注移到行外**（现写法让该行不再是逐字原句）', `${c.file}:${r.ln}`, r.text]);
  }
  for (const c of report.chars) for (const h of c.unstarredHits) act.push(['**补标 ⭐**（未标 ⭐ 却能命中本人语料）', `${c.file}:${h.ln}`, h.text]);
  if (!act.length) L.push('（无）');
  else {
    L.push('| 处置 | 位置 | 行内容 |');
    L.push('|---|---|---|');
    for (const [a, p, t] of act) L.push(`| ${a} | \`${p}\` | ${t.replace(/\|/g, '\\|')} |`);
  }
  if (problems.length) { L.push('## 脚本自检告警', ''); for (const p of problems) L.push(`- ${p}`); }
  if (VERBOSE) {
    L.push('', '## 全部 ⭐ 行明细（--宽）');
    for (const c of report.chars) { L.push(`### ${c.short}`); for (const r of c.rows) L.push(`- [${r.tier}] L${r.ln} ${r.text}  ← ${r.note}`); }
  }
  return L.join('\n');
}

if (JSON_OUT) {
  const slim = JSON.parse(JSON.stringify({ ...report, chars: report.chars.map(c => ({ ...c, surfaces: c.surfaces.map(s => ({ tag: s.tag, rel: s.rel, units: s.units.length })) })) }));
  console.log(JSON.stringify(slim, null, 1));
} else {
  const md = render();
  console.log(md);
  if (WRITE) {
    const out = join(SKILL_ROOT, '_lines对账报告.md');
    writeFileSync(out, md.endsWith('\n') ? md : md + '\n', 'utf8');
    console.error(`已写：${relative(WS, out)}`);
  }
}
if (!JSON_OUT) {
  const T = report.totals;
  console.error(`\n[口径核对] ⭐ ${T.star} 行 = A1 ${T.A1} + A2 ${T.A2} + B ${T.B} + B2 ${T.B2} + M ${T.M} ｜ 命中率 ${((T.star - T.M) / T.star * 100).toFixed(1)}%`);
}
