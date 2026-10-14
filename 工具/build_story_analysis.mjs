#!/usr/bin/env node
/**
 * build_story_analysis.mjs —— 剧情分析生成器（「分析」模式，非创作模式）
 *
 * 定位：把游戏原文 + 情绪注释（cmd21）当底本，**提炼**跨话剧情结构，装进
 *       剧情分析/ 目录。产出全部可回溯到 advId，不做任何原创改写。
 *
 * 分工（重要）：
 *   - 情绪曲线：本脚本从 资料库/_emotion_lines.jsonl 现算 → 写 _data/emotion_curves.json
 *   - 因果链 / 伏笔 / 角色弧光：属语义判断，人工（或子代理）写进 _data/*.json，
 *     本脚本**只读不写**，重跑不会覆盖分析结论。
 *
 * 用法：
 *   node 工具/build_story_analysis.mjs              全量（算曲线 + 生成 md）
 *   node 工具/build_story_analysis.mjs --only 曲线   只算情绪曲线，不生成 md
 *   node 工具/build_story_analysis.mjs --dry         只打印，不写盘
 *   node 工具/build_story_analysis.mjs --force       强制重写（仍保留 USER 块）
 *   node 工具/build_story_analysis.mjs --check       校验：json 结构 + md 数字是否注入
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '剧情分析');
const DATA = join(OUT, '_data');
/* 官方章节标题（四语），由 工具/build_chapter_titles.mjs 生成 */
const TITLES = join(ROOT, '资料库', '_chapter_titles.json');

const ARGV = process.argv.slice(2);
const DRY = ARGV.includes('--dry');
const FORCE = ARGV.includes('--force');
const CHECK = ARGV.includes('--check');
const ONLY = (() => { const i = ARGV.indexOf('--only'); return i >= 0 ? ARGV[i + 1] : null; })();

/* ------------------------------------------------------------------ *
 * 0. 作用域：全部 5 条主线（109 话），按 advId 排序
 *    ⚠ advId 顺序 ≠ 剧情顺序（见 角色模型/主线/主线总览.md）：
 *      MyGO 10015-10102 与 Ave Mujica 10020-10039 在时间上互相穿插。
 *      所以转折点是「同 band 内按 advId 相邻」比较，跨 band 不作时序推断。
 * ------------------------------------------------------------------ */
const BANDS = [
  { dir: 'MyGO', label: 'MyGO!!!!!' },
  { dir: 'Ave Mujica', label: 'Ave Mujica' },
  { dir: '梦限大MewType', label: '梦限大MewType' },
  { dir: 'millsage', label: 'millsage' },
  { dir: '一家Dumb Rock', label: '一家Dumb Rock' },
];

/* 篇章判定：官方剧本名 adv_script_{bandkey}_{编号}_[exstory_]{章}_{话序}
   带 exstory 的是番外（advId 101xx 段），不是本篇延续 —— 见 话层分析/篇章结构.md */
function partOf(dir, file) {
  try {
    const head = readFileSync(join(dir, file), 'utf8').split('\n').slice(0, 8).join('\n');
    const m = head.match(/`adv_script_[a-z]+_\d+_(exstory_)?\d+_\d+`/);
    return m && m[1] ? '番外' : '本篇';
  } catch {
    return '本篇';
  }
}

function loadScope() {
  const eps = [];
  /* 官方标题表：文件名里的标题是官方简中，补回日文原文 */
  let titles = {};
  try { titles = JSON.parse(readFileSync(TITLES, 'utf8')).titles ?? {}; } catch { /* 缺则只显示中文 */ }
  for (const b of BANDS) {
    const d = join(ROOT, '素材全量', '按话', 'ja', '主线', b.dir);
    if (!existsSync(d)) { console.warn(`⚠ 缺少目录：${d}`); continue; }
    for (const f of readdirSync(d)) {
      const m = f.match(/^(\d+)_(.+)\.md$/);
      if (m) eps.push({
        advId: Number(m[1]), title: m[2], band: b.label, part: partOf(d, f),
        titleJa: titles[m[1]]?.ja ?? '',
      });
    }
  }
  eps.sort((x, y) => x.advId - y.advId);
  return eps;
}

/* ------------------------------------------------------------------ *
 * 1. 角色名归一：上游 model 名 → kb id / 中文短名
 *    与 工具/情绪标签.mjs 的 MODEL_ALIAS 保持一致（那份未导出，此处复刻）
 * ------------------------------------------------------------------ */
const MODEL_ALIAS = {
  raikagrandmother: 'baachan', mikumother: 'mikumom', bota: 'pota', bell: 'belle',
  kiyotsugu: 'seikoku', hotaru_child: 'kohotaru', mutsumi_maybe: 'mutsumi',
  hatsune_maybe: 'hatsune', grandma: 'baachan',
  tomori_maybe: 'tomori', hatsune2: 'hatsune',   // 本项目补：这两个是同角色的模型拼写变体
};

/**
 * 情绪是【演出层】数据，不按叙事身份归并：
 *   mortis（286 句）在上游是与 mutsumi 并列的独立演出模型，情绪特征与睦差别极大，
 *   若按 kb.stage 并进本体，Ave Mujica 最核心的反差就被抹平了。
 * 因此 key 一律用原始 model 名；kb 只用来取中文名，舞台名以「本体/舞台名」标注。
 */
function loadKb() {
  const kb = JSON.parse(readFileSync(join(ROOT, '资料库', 'kb.json'), 'utf8'));
  const byId = new Map();
  const byStage = new Map();
  for (const c of kb.characters ?? []) {
    byId.set(String(c.id).toLowerCase(), c);
    if (c.stage) byStage.set(String(c.stage).toLowerCase(), c);
  }
  const idOf = (m) => {
    const s = String(m ?? '').toLowerCase();
    if (!s || s === 'null') return null;
    if (byId.has(s)) return s;
    const al = MODEL_ALIAS[s];
    if (al && byId.has(al)) return al;
    return null;
  };
  const zhOf = (m) => {
    const s = String(m ?? '');
    const low = s.toLowerCase();
    const hit = byId.get(idOf(low) ?? '') ?? byStage.get(low);
    if (!hit) return s;
    const short = hit.name_short || hit.name || s;
    return hit.stage && hit.stage.toLowerCase() === low ? `${short}/${s}` : short;
  };
  return { kb, byId, idOf, zhOf };
}

/* ------------------------------------------------------------------ *
 * 2. 情绪曲线：完全由数据算出，不许手抄
 * ------------------------------------------------------------------ */
function buildEmotionCurves(eps) {
  const pol = JSON.parse(readFileSync(join(DATA, 'emotion_polarity.json'), 'utf8')).polarity;
  const { idOf, zhOf } = loadKb();
  const lines = readFileSync(join(ROOT, '资料库', '_emotion_lines.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((s) => JSON.parse(s));

  const scopeIds = new Set(eps.map((e) => e.advId));
  const inScope = lines.filter((l) => scopeIds.has(Number(l.advId)));

  const unmatched = new Map();
  const per = new Map();
  for (const e of eps) per.set(e.advId, { ...e, spoken: 0, tagged: 0, vs: [], ars: [], exps: new Map(), chars: new Map() });

  for (const l of inScope) {
    const rec = per.get(Number(l.advId));
    if (!rec) continue;
    rec.spoken += 1;
    const base = typeof l.exp === 'string' ? l.exp.replace(/^exp_/, '').replace(/\d+$/, '') : null;
    if (!base) continue;
    const p = pol[base];
    if (!p) { unmatched.set(base, (unmatched.get(base) || 0) + 1); continue; }
    rec.tagged += 1;
    rec.vs.push(p.valence);
    rec.ars.push(p.arousal);
    rec.exps.set(base, (rec.exps.get(base) || 0) + 1);
    const key = idOf(l.model) ?? String(l.model ?? '?');
    if (!rec.chars.has(key)) rec.chars.set(key, { id: key, zh: zhOf(l.model), n: 0, vs: [], ars: [] });
    const cr = rec.chars.get(key);
    cr.n += 1; cr.vs.push(p.valence); cr.ars.push(p.arousal);
  }

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const r2 = (x) => Math.round(x * 100) / 100;

  const episodes = [...per.values()].map((r) => ({
    advId: r.advId,
    title: r.title,
    titleJa: r.titleJa ?? '',
    band: r.band,
    part: r.part,
    spoken: r.spoken,
    tagged: r.tagged,
    coverage: r.spoken ? Math.round((r.tagged / r.spoken) * 1000) / 1000 : 0,
    meanValence: r2(mean(r.vs)),
    meanArousal: r2(mean(r.ars)),
    negRatio: r.vs.length ? Math.round((r.vs.filter((v) => v <= -0.4).length / r.vs.length) * 1000) / 1000 : 0,
    posRatio: r.vs.length ? Math.round((r.vs.filter((v) => v >= 0.4).length / r.vs.length) * 1000) / 1000 : 0,
    topExps: [...r.exps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([b, n]) => ({ base: b, zh: pol[b]?.zh ?? b, n })),
    chars: [...r.chars.values()].sort((a, b) => b.n - a.n)
      .map((c) => ({ id: c.id, zh: c.zh, n: c.n, meanValence: r2(mean(c.vs)), meanArousal: r2(mean(c.ars)) })),
  }));

  // 转折点：同一 band 内按 advId 顺序，相邻话平均效价跳变超过阈值
  const TURN = 0.2;
  const turningPoints = [];
  for (const b of BANDS) {
    /* 只在同一篇章内相邻比较：本篇↔番外之间不作时序推断 */
    for (const part of ['本篇', '番外']) {
      const seq = episodes.filter((e) => e.band === b.label && e.part === part);
      for (let i = 1; i < seq.length; i += 1) {
        const d = seq[i].meanValence - seq[i - 1].meanValence;
        if (Math.abs(d) >= TURN) {
          turningPoints.push({
            band: b.label, part, from: seq[i - 1].advId, to: seq[i].advId,
            delta: r2(d), direction: d > 0 ? '转好' : '转坏',
            fromValence: seq[i - 1].meanValence, toValence: seq[i].meanValence,
          });
        }
      }
    }
  }

  const withV = episodes.filter((e) => e.tagged > 0);
  const lowest = withV.reduce((a, b) => (b.meanValence < a.meanValence ? b : a), withV[0]);
  const highest = withV.reduce((a, b) => (b.meanValence > a.meanValence ? b : a), withV[0]);
  const hottest = withV.reduce((a, b) => (b.meanArousal > a.meanArousal ? b : a), withV[0]);

  // 角色维度：跨全 scope 聚合
  const charAgg = new Map();
  for (const e of episodes) {
    for (const c of e.chars) {
      if (!charAgg.has(c.id)) charAgg.set(c.id, { id: c.id, zh: c.zh, n: 0, vs: [], ars: [], eps: new Set() });
      const a = charAgg.get(c.id);
      a.n += c.n; a.eps.add(e.advId);
      for (let i = 0; i < c.n; i += 1) { a.vs.push(c.meanValence); a.ars.push(c.meanArousal); }
    }
  }
  const characters = [...charAgg.values()]
    .map((c) => ({ id: c.id, zh: c.zh, lines: c.n, episodes: c.eps.size, meanValence: r2(mean(c.vs)), meanArousal: r2(mean(c.ars)) }))
    .sort((a, b) => b.lines - a.lines);

  return {
    _generated: new Date().toISOString().slice(0, 10),
    _note: '逐话情绪指标，全部由 资料库/_emotion_lines.jsonl × _data/emotion_polarity.json 现算。valence/arousal 的【判定】是人工的，词根与计数是上游客观的。',
    _scope: {
      bands: BANDS.map((b) => b.label), episodes: eps.length,
      本篇: eps.filter((e) => e.part === '本篇').length,
      番外: eps.filter((e) => e.part === '番外').length,
    },
    _scale: {
      linesInScope: inScope.length,
      taggedInScope: episodes.reduce((s, e) => s + e.tagged, 0),
      meanCoverage: r2(mean(episodes.map((e) => e.coverage))),
      unmatchedExps: [...unmatched.entries()].sort((a, b) => b[1] - a[1]),
    },
    turningPoints,
    extremes: {
      lowest: { advId: lowest.advId, title: lowest.title, titleJa: lowest.titleJa ?? '', meanValence: lowest.meanValence },
      highest: { advId: highest.advId, title: highest.title, titleJa: highest.titleJa ?? '', meanValence: highest.meanValence },
      hottest: { advId: hottest.advId, title: hottest.title, titleJa: hottest.titleJa ?? '', meanArousal: hottest.meanArousal },
    },
    episodes,
    characters,
  };
}

/* ------------------------------------------------------------------ *
 * 3. 写盘：USER 块保留 + 幂等
 * ------------------------------------------------------------------ */
function extractUserBlocks(text) {
  const out = new Map();
  const re = /<!-- USER:START (.+?) -->([\s\S]*?)<!-- USER:END -->/g;
  let m;
  while ((m = re.exec(text))) out.set(m[1], m[2]);
  return out;
}

function applyUserBlocks(content, blocks) {
  let out = content;
  for (const [name, body] of blocks) {
    const re = new RegExp(`<!-- USER:START ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -->([\\s\\S]*?)<!-- USER:END -->`);
    out = out.replace(re, `<!-- USER:START ${name} -->${body}<!-- USER:END -->`);
  }
  return out;
}

/** 比较时剥掉「生成于」时间戳行，否则每次重跑都误判为有变化 */
const stripTs = (s) => s.replace(/^>?\s*生成于：.*$/gm, '').replace(/^_generated.*$/gm, '');

function writeFile(rel, content) {
  const abs = join(OUT, rel);
  const existed = existsSync(abs);
  let out = content;
  if (existed) out = applyUserBlocks(content, extractUserBlocks(readFileSync(abs, 'utf8')));
  const changed = !existed || stripTs(readFileSync(abs, 'utf8')) !== stripTs(out);
  if (changed || FORCE) {
    if (!DRY) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, out, 'utf8'); }
    console.log(`  ${existed ? '~ 更新' : '+ 新建'}  剧情分析/${rel}`);
  } else {
    console.log(`  = 跳过  剧情分析/${rel}`);
  }
  return changed;
}

/* ------------------------------------------------------------------ *
 * 4. md 渲染
 * ------------------------------------------------------------------ */
function bar(v, width = 24) {
  const mid = Math.floor(width / 2);
  const a = new Array(width).fill('·');
  const len = Math.min(mid, Math.round(Math.abs(v) * mid));
  if (v >= 0) for (let i = 0; i < len; i += 1) a[mid + i] = '█';
  else for (let i = 0; i < len; i += 1) a[mid - 1 - i] = '█';
  return a.join('');
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

function readJson(rel, fallback) {
  const abs = join(DATA, rel);
  if (!existsSync(abs)) { console.warn(`  ⚠ 缺少 _data/${rel}（语义层待填）`); return fallback; }
  return JSON.parse(readFileSync(abs, 'utf8'));
}

function renderReadme(cur, causal, fore, arcs) {
  const L = [];
  L.push('# 剧情分析 · 索引');
  L.push('');
  L.push('> 生成于：' + cur._generated);
  L.push('> **本目录是「分析」产物，不是创作产物。** 底本为游戏原文 + cmd21 演出指令（情绪注释），每条结论可回溯到 advId。');
  L.push('');
  L.push('## 这是什么');
  L.push('');
  L.push('把游戏逐话文本当作小说正文来读，再**跨话**提炼出四层结构：');
  L.push('');
  L.push('| 层 | 文件 | 回答的问题 | 性质 |');
  L.push('|---|---|---|---|');
  L.push('| 情绪曲线 | [`情绪曲线.md`](情绪曲线.md) | 每话的情感强度与正负走向如何变化 | **脚本现算**（客观计数） |');
  L.push('| 因果链 | [`因果链.md`](因果链.md) | 剧情为什么这么走 | 语义提炼（可回溯） |');
  L.push('| 伏笔与回收 | [`伏笔与回收.md`](伏笔与回收.md) | 什么被埋下、什么被收回、什么还悬着 | 语义提炼（可回溯） |');
  L.push('| 角色弧光 | [`角色弧光.md`](角色弧光.md) | 谁在哪一话因什么而改变 | 语义提炼（可回溯） |');
  L.push('');
  L.push('## 范围与口径');
  L.push('');
  L.push(`- 对象：**${cur._scope.bands.join(' / ')}**，共 **${cur._scope.episodes}** 话（本篇 **${cur._scope.本篇}** + 番外 **${cur._scope.番外}**，游戏目前连载到的全部主线）。`);
  L.push('- 排列：按 advId（游戏内打开顺序）。⚠ **advId 顺序 ≠ 剧情顺序**，有两个独立原因：');
  L.push('  1. 各乐队主线在时间上互相穿插（MyGO 10015–10102 与 Ave Mujica 10020–10039）；');
  L.push('  2. **advId 10100–10108 是番外（`exstory`）**，属后日谈，不是本篇第 21 话起。');
  L.push('  因此跨乐队、跨篇章都不可据 advId 推断先后 —— 见 [话层分析/篇章结构.md](../话层分析/篇章结构.md)。');
  L.push(`- 语料：范围内台词 **${cur._scale.linesInScope}** 行，其中带表情标签 **${cur._scale.taggedInScope}** 行，平均覆盖率 **${pct(cur._scale.meanCoverage)}**。`);
  L.push(`- 因果链条 **${(causal.chains ?? []).length}** 条 / 伏笔 **${(fore.items ?? []).length}** 项 / 角色弧光 **${Object.keys(arcs.arcs ?? {}).length}** 人。`);
  L.push('');
  L.push('## 数据来源');
  L.push('');
  L.push('| 源 | 路径 | 提供 |');
  L.push('|---|---|---|');
  L.push('| 逐话底本 | `素材全量/按话/{ja,zh-Hans}/主线/` | 原文与说话人 |');
  L.push('| 情绪注释 | `资料库/_emotion_lines.jsonl` | 逐句 `exp_*` / `mtn_*`（上游 cmd21，客观） |');
  L.push('| 极性判定 | `剧情分析/_data/emotion_polarity.json` | 词根 → 效价/唤醒（**人工判定，可修订**） |');
  L.push('| 逐话摘要 | `角色模型/主线/主线梳理_*.md` | 语义提炼的输入底本 |');
  L.push('| 关键事件 | `资料库/kb.json` 的 `events` | 跨话事件与参与者 |');
  L.push('');
  /* 番外牵涉的既有条目：这些引用落在 exstory 而非本篇，读法不同 */
  const exIds = new Set((cur.episodes ?? []).filter((e) => e.part === '番外').map((e) => e.advId));
  const hit = { causal: [], fore: [], arcs: [] };
  for (const ch of causal.chains ?? []) for (const l of ch.links ?? []) if (exIds.has(l.advId)) hit.causal.push(`${ch.id} @ ${l.advId}`);
  for (const f of fore.items ?? []) for (const p of [...(f.planted ?? []), ...(f.paidOff ?? [])]) if (exIds.has(p.advId)) hit.fore.push(`${f.motif} @ ${p.advId}`);
  for (const [k, v] of Object.entries(arcs.arcs ?? {})) for (const s of v.stages ?? []) if (exIds.has(s.advId)) hit.arcs.push(`${v.name ?? k} @ ${s.advId}`);
  const hitTotal = hit.causal.length + hit.fore.length + hit.arcs.length;
  if (hitTotal) {
    L.push('## ⚠ 番外牵涉的条目');
    L.push('');
    L.push(`以下 **${hitTotal}** 处引用落在**番外**（exstory，advId 10100–10108）而不是本篇：`);
    L.push('');
    L.push('| 层 | 条目 |');
    L.push('|---|---|');
    for (const x of hit.causal) L.push(`| 因果链 | ${x} |`);
    for (const x of hit.fore) L.push(`| 伏笔 | ${x} |`);
    for (const x of hit.arcs) L.push(`| 角色弧光 | ${x} |`);
    L.push('');
    L.push('番外篇幅不到本篇一半、情绪由负转正，是后日谈性质 —— **这些条目要按番外的权重读**，不要当成本篇主线的一环。');
    const openEx = (fore.items ?? []).filter((f) => f.status === 'open' && (f.planted ?? []).some((p) => exIds.has(p.advId)));
    if (openEx.length) {
      L.push('');
      L.push(`其中未回收伏笔 **${openEx.map((f) => `「${f.motif}」`).join('、')}** 是在番外里埋下的 ——`);
      L.push('这是后日谈的开放式收尾，与「本篇悬而未决」不是一回事。');
    }
    L.push('');
  }

  L.push('## 可信度分级');
  L.push('');
  L.push('- **客观**：advId / 话数 / 台词行数 / 表情标签计数 —— 上游数据，不含主观判断。');
  L.push('- **半客观**：情绪曲线的**数值**由客观计数 × 人工极性判定算出。**改 `emotion_polarity.json` 就会改曲线**，判定不是上游数据。');
  L.push('- **主观**：因果链的因果方向、伏笔的埋收配对、弧光的转折点 —— 提炼者的解读，每条附 advId 供你复核。');
  L.push('');
  L.push('<!-- USER:START 索引补充 -->');
  L.push('<!-- 写在这里：你想补充的说明、口径修正、待办。重跑生成不会丢失。 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  return L.join('\n');
}

function renderEmotion(cur) {
  const L = [];
  L.push('# 情绪曲线');
  L.push('');
  L.push('> 生成于：' + cur._generated);
  L.push(`> 范围内台词 **${cur._scale.linesInScope}** 行 / 带表情标签 **${cur._scale.taggedInScope}** 行 / 平均覆盖率 **${pct(cur._scale.meanCoverage)}**。`);
  L.push('> 数值 = 客观标签计数 × [`_data/emotion_polarity.json`](_data/emotion_polarity.json) 的人工极性判定。改那份表就会改这张表。');
  L.push('');
  L.push('## 术语：效价与唤醒');
  L.push('');
  L.push('两个指标取自情绪心理学的环形模型（Russell circumplex），互相正交，不要混读。');
  L.push('');
  L.push('| 指标 | 含义 | 量纲 | 读法 |');
  L.push('|---|---|---|---|');
  L.push('| **效价 valence** | 情绪的**正负方向**：愉悦↔痛苦、积极↔消极 | −1.0 ~ +1.0，0 = 中性 | 越负越压抑，越正越明朗 |');
  L.push('| **唤醒 arousal** | 情绪的**激活强度**，与正负无关 | 0（平静）~ 3（剧烈） | 越大越激烈，不管方向 |');
  L.push('');
  L.push('举例区分：`哭泣`（效价 −0.9 / 唤醒 3）与 `欢呼`（效价 +0.8 / 唤醒 3）——唤醒相同，效价相反；');
  L.push('`平静`（0 / 0）与 `苍白`（−0.6 / 3）——都是低活动，但一个无事发生、一个濒临崩溃。');
  L.push('');
  L.push('**均效价** = 该范围内全部带表情标签的台词，逐句取表情词根的效价值后求算术平均（**按句等权**，不按角色、不按句长加权）。');
  L.push('单句层面效价跨度是 −0.9 ~ +0.8，但一话之内 `平静`/`严肃` 这类中性表情往往占大头，会把均值拉向 0。');
  L.push('');
  const vv = [...cur.episodes].map((e) => e.meanValence).sort((a, b) => a - b);
  const qq = (p) => vv[Math.min(vv.length - 1, Math.floor(vv.length * p))];
  const sd = Math.sqrt(vv.reduce((s, x) => s + (x - vv.reduce((a, b) => a + b, 0) / vv.length) ** 2, 0) / vv.length);
  L.push(`所以**逐话均效价的实际分布区间很窄**：本范围 ${vv.length} 话落在 ${vv[0].toFixed(2)} ~ ${vv[vv.length - 1].toFixed(2)}，`);
  L.push(`中位数 ${qq(0.5).toFixed(2)}、标准差 ${sd.toFixed(2)}，四分位 p25 ${qq(0.25).toFixed(2)} / p75 ${qq(0.75).toFixed(2)}。`);
  L.push('在这个尺度上，**0.2 的差距已经是显著落差**，不要拿 ±1 的直觉去衡量——对照上表的四分位读更准。');
  L.push('');
  L.push('## 逐话指标');
  L.push('');
  L.push('条形图以中心为零点：向左为负向，向右为正向。');
  L.push('');
  L.push('| advId | 篇章 | 话标题 | 台词 | 带标签 | 覆盖 | 平均效价 | 效价条 | 平均唤醒 | 负向占比 | 正向占比 | 主要表情 |');
  L.push('|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|');
  let lastBand = null;
  for (const e of cur.episodes) {
    if (lastBand && lastBand !== e.band) {
      L.push(`| — | **▸ ${e.band}** | | | | | | | | | |`);
    }
    lastBand = e.band;
    const exps = e.topExps.map((x) => `${x.zh}×${x.n}`).join('、') || '—';
    L.push(`| ${e.advId} | ${e.part} | ${e.title}${e.titleJa ? `<br><sub>${e.titleJa}</sub>` : ''} | ${e.spoken} | ${e.tagged} | ${pct(e.coverage)} | ${e.meanValence.toFixed(2)} | \`${bar(e.meanValence)}\` | ${e.meanArousal.toFixed(2)} | ${pct(e.negRatio)} | ${pct(e.posRatio)} | ${exps} |`);
  }
  L.push('');
  L.push('## 峰值与谷值');
  L.push('');
  const jaOf = (x) => (x.titleJa ? `「${x.titleJa}」` : '');
  L.push(`- **最负向**：${cur.extremes.lowest.advId} ${cur.extremes.lowest.title}${jaOf(cur.extremes.lowest)}（平均效价 ${cur.extremes.lowest.meanValence.toFixed(2)}）`);
  L.push(`- **最正向**：${cur.extremes.highest.advId} ${cur.extremes.highest.title}${jaOf(cur.extremes.highest)}（平均效价 ${cur.extremes.highest.meanValence.toFixed(2)}）`);
  L.push(`- **最激烈**：${cur.extremes.hottest.advId} ${cur.extremes.hottest.title}${jaOf(cur.extremes.hottest)}（平均唤醒 ${cur.extremes.hottest.meanArousal.toFixed(2)}）`);
  L.push('');
  L.push('## 转折点');
  L.push('');
  L.push(`相邻话平均效价跳变 ≥ 0.20 即计入，共 **${cur.turningPoints.length}** 处。`);
  L.push('');
  L.push('> ⚠ 只在**同一乐队的同一篇章内**按 advId 相邻比较。');
  L.push(`> 本篇 ${cur._scope.本篇} 话与番外 ${cur._scope.番外} 话**互不比较** —— 官方剧本名里番外是 `);
  L.push('> `exstory`（advId 101xx 段），属后日谈，不是本篇第 21 话起。详见 [话层分析/篇章结构.md](../话层分析/篇章结构.md)。');
  L.push('');
  if (!cur.turningPoints.length) {
    L.push('（无）');
  } else {
    L.push('| 乐队 | 篇章 | 从 | 到 | 效价变化 | 方向 |');
    L.push('|---|---|---:|---:|---:|---|');
    for (const t of cur.turningPoints) {
      L.push(`| ${t.band} | ${t.part} | ${t.from}（${t.fromValence.toFixed(2)}） | ${t.to}（${t.toValence.toFixed(2)}） | ${t.delta > 0 ? '+' : ''}${t.delta.toFixed(2)} | ${t.direction} |`);
    }
  }
  L.push('');
  L.push('## 角色维度');
  L.push('');
  L.push(`范围内有情绪标签的角色 **${cur.characters.length}** 人，按带标签句数排序（取前 30）。`);
  L.push('');
  L.push('| 角色 | id | 带标签句数 | 登场话数 | 平均效价 | 平均唤醒 |');
  L.push('|---|:---:|---:|---:|---:|---:|');
  for (const c of cur.characters.slice(0, 30)) {
    L.push(`| ${c.zh} | \`${c.id}\` | ${c.lines} | ${c.episodes} | ${c.meanValence.toFixed(2)} | ${c.meanArousal.toFixed(2)} |`);
  }
  L.push('');
  const un = cur._scale.unmatchedExps ?? [];
  if (un.length) {
    L.push(`> ⚠ 未登记的 exp 词根 ${un.length} 种：${un.map(([b, n]) => `${b}×${n}`).join('、')} —— 已按中性处理，请补进极性表。`);
    L.push('');
  }
  L.push('<!-- USER:START 情绪曲线解读 -->');
  L.push('<!-- 写在这里：你对曲线形态的解读、与剧情事件的对位观察。重跑生成不会丢失。 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  return L.join('\n');
}

function renderCausal(causal) {
  const L = [];
  const chains = causal.chains ?? [];
  L.push('# 因果链');
  L.push('');
  L.push(`> ${causal._note ?? '跨话因果关系提炼。方向判断属解读，每条附 advId 可复核。'}`);
  if (causal._updated) L.push(`> 语义层更新于：${causal._updated}`);
  L.push('');
  L.push(`共 **${chains.length}** 条链条。`);
  L.push('');
  if (!chains.length) {
    L.push('（待填 —— 见 `_data/causal_chain.json`）');
    L.push('');
    return L.join('\n');
  }
  for (const c of chains) {
    L.push(`## ${c.id} · ${c.title}`);
    L.push('');
    L.push(`- 乐队：${c.band ?? '—'}　主题：${c.theme ?? '—'}`);
    L.push('');
    L.push('| 序 | advId | 事件 | 角色 |');
    L.push('|---:|---|---|---|');
    (c.links ?? []).forEach((lk, i) => {
      L.push(`| ${i + 1} | ${lk.advId} | ${lk.event} | ${lk.role ?? '—'} |`);
    });
    L.push('');
    if (c.mechanism) L.push(`**机制**：${c.mechanism}`);
    L.push('');
  }
  L.push('<!-- USER:START 因果链补充 -->');
  L.push('<!-- 写在这里：你发现的额外因果、对上述机制的异议。重跑生成不会丢失。 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  return L.join('\n');
}

function renderForeshadow(fore) {
  const L = [];
  const items = fore.items ?? [];
  const paid = items.filter((x) => x.status === 'paid').length;
  const open = items.filter((x) => x.status === 'open').length;
  const partial = items.length - paid - open;
  L.push('# 伏笔与回收');
  L.push('');
  L.push(`> ${fore._note ?? '意象 / 台词 / 道具的埋设点与回收点对照。配对关系属解读，每条附 advId 可复核。'}`);
  if (fore._updated) L.push(`> 语义层更新于：${fore._updated}`);
  L.push('>');
  L.push('> ⚠️ **本表是原作的伏笔**（底本事实，36 项）。**本作新埋的伏笔填在 `NovelProject/Foreshadows.md`** ——');
  L.push('> 那张表是空白的创作工具。两张表同名不同用，**别把原作这 36 项抄进本作那张** ——');
  L.push('> 抄进去就分不清哪些是原作给的、哪些是你自己设的。');
  L.push('');
  L.push(`共 **${items.length}** 项：已回收 **${paid}** / 未回收 **${open}** / 部分回收 **${partial}**。`);
  L.push('');
  if (!items.length) {
    L.push('（待填 —— 见 `_data/foreshadows.json`）');
    L.push('');
    return L.join('\n');
  }
  L.push('| # | 意象 | 埋设 | 回收 | 状态 | 涉及角色 |');
  L.push('|---:|---|---|---|---|---|');
  items.forEach((f, i) => {
    const pl = (f.planted ?? []).map((p) => `${p.advId}：${p.note}`).join('<br>') || '—';
    const pf = (f.paidOff ?? []).map((p) => `${p.advId}：${p.note}`).join('<br>') || '—';
    const mark = f.status === 'paid' ? '✅ 已回收' : f.status === 'open' ? '⏳ 未回收' : '◐ 部分';
    L.push(`| ${i + 1} | **${f.motif}** | ${pl} | ${pf} | ${mark} | ${(f.characters ?? []).join('、') || '—'} |`);
  });
  L.push('');
  L.push('## 逐项展开');
  L.push('');
  for (const f of items) {
    L.push(`### ${f.motif}`);
    L.push('');
    if (f.meaning) L.push(`${f.meaning}`);
    L.push('');
    for (const p of f.planted ?? []) L.push(`- 埋 ${p.advId} — ${p.note}${p.quote ? `　> ${p.quote}` : ''}`);
    for (const p of f.paidOff ?? []) L.push(`- 收 ${p.advId} — ${p.note}${p.quote ? `　> ${p.quote}` : ''}`);
    L.push('');
  }
  L.push('<!-- USER:START 伏笔补充 -->');
  L.push('<!-- 写在这里：新发现的伏笔、对上述配对的异议。重跑生成不会丢失。 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  return L.join('\n');
}

function renderArcs(arcs) {
  const L = [];
  const map = arcs.arcs ?? {};
  const keys = Object.keys(map);
  L.push('# 角色弧光');
  L.push('');
  L.push(`> ${arcs._note ?? '角色跨话的状态变化序列。转折点判断属解读，每条附 advId 可复核。'}`);
  if (arcs._updated) L.push(`> 语义层更新于：${arcs._updated}`);
  L.push('');
  L.push(`共 **${keys.length}** 人。`);
  L.push('');
  if (!keys.length) {
    L.push('（待填 —— 见 `_data/character_arcs.json`）');
    L.push('');
    return L.join('\n');
  }
  L.push('| 角色 | 阶段数 | 起点 | 终点 | 弧线概括 |');
  L.push('|---|---:|---|---|---|');
  for (const k of keys) {
    const a = map[k];
    const st = a.stages ?? [];
    L.push(`| [${a.name ?? k}](#${k})（\`${k}\`） | ${st.length} | ${st[0]?.state ?? '—'} | ${st[st.length - 1]?.state ?? '—'} | ${a.arcSummary ?? '—'} |`);
  }
  L.push('');
  for (const k of keys) {
    const a = map[k];
    L.push(`## ${a.name ?? k}`);
    L.push('');
    L.push(`- id：\`${k}\`　乐队：${a.band ?? '—'}`);
    if (a.arcSummary) L.push(`- **弧线**：${a.arcSummary}`);
    L.push('');
    L.push('| advId | 状态 | 触发 |');
    L.push('|---:|---|---|');
    for (const s of a.stages ?? []) {
      L.push(`| ${s.advId} | ${s.state} | ${s.trigger ?? '—'} |`);
    }
    L.push('');
    if (a.turningPoints?.length) {
      L.push('**转折点**：');
      for (const t of a.turningPoints) L.push(`- ${t.advId} — ${t.what}${t.why ? `（因：${t.why}）` : ''}`);
      L.push('');
    }
  }
  L.push('<!-- USER:START 弧光补充 -->');
  L.push('<!-- 写在这里：补充阶段、对上述转折点的异议。重跑生成不会丢失。 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  return L.join('\n');
}

/* ------------------------------------------------------------------ *
 * 5. 校验（--check）
 * ------------------------------------------------------------------ */
function check(cur, causal, fore, arcs) {
  const problems = [];
  if (!cur.episodes.length) problems.push('情绪曲线无话');
  if (!cur._scale.taggedInScope) problems.push('无带标签台词');
  if ((cur._scale.unmatchedExps ?? []).length) problems.push(`有未登记 exp 词根：${cur._scale.unmatchedExps.map(([b]) => b).join(',')}`);
  for (const e of cur.episodes) {
    if (e.tagged === 0) problems.push(`advId ${e.advId} 无情绪标签`);
    if (e.meanValence < -1 || e.meanValence > 1) problems.push(`advId ${e.advId} 效价越界`);
  }
  for (const [nm, obj, key] of [['因果链', causal, 'chains'], ['伏笔', fore, 'items'], ['角色弧光', arcs, 'arcs']]) {
    const v = obj?.[key];
    if (!v || (Array.isArray(v) ? !v.length : !Object.keys(v).length)) problems.push(`${nm} 未填（_data 缺失或为空）`);
  }
  if (existsSync(join(OUT, '情绪曲线.md'))) {
    const md = readFileSync(join(OUT, '情绪曲线.md'), 'utf8');
    if (!md.includes(String(cur._scale.linesInScope))) problems.push('情绪曲线.md 未含范围内台词总数（数字未注入？）');
    if (!md.includes(String(cur._scope.episodes))) problems.push('情绪曲线.md 未含话数');
  }
  if (problems.length) {
    console.log('✗ 剧情分析自检未过：');
    for (const p of problems) console.log('  - ' + p);
    process.exitCode = 1;
  } else {
    console.log(`✓ 剧情分析自检通过：${cur._scope.episodes} 话 / 台词 ${cur._scale.linesInScope} / 带标签 ${cur._scale.taggedInScope}（${pct(cur._scale.meanCoverage)}）/ 转折点 ${cur.turningPoints.length} / 链条 ${(causal.chains ?? []).length} / 伏笔 ${(fore.items ?? []).length} / 弧光 ${Object.keys(arcs.arcs ?? {}).length} 人`);
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
const eps = loadScope();
console.log(`作用域：${eps.length} 话（${BANDS.map((b) => b.label).join(' / ')}）`);

mkdirSync(DATA, { recursive: true });
const cur = buildEmotionCurves(eps);

if (!DRY) {
  const abs = join(DATA, 'emotion_curves.json');
  const before = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  const after = JSON.stringify(cur, null, 2);
  if (stripTs(before) !== stripTs(after)) {
    writeFileSync(abs, after, 'utf8');
    console.log('  ~ 更新  剧情分析/_data/emotion_curves.json');
  } else {
    console.log('  = 跳过  剧情分析/_data/emotion_curves.json');
  }
}
console.log(`情绪曲线：${cur._scale.taggedInScope}/${cur._scale.linesInScope} 带标签（${pct(cur._scale.meanCoverage)}），转折点 ${cur.turningPoints.length} 处`);

const causal = readJson('causal_chain.json', { chains: [] });
const fore = readJson('foreshadows.json', { items: [] });
const arcs = readJson('character_arcs.json', { arcs: {} });

if (CHECK) {
  check(cur, causal, fore, arcs);
} else if (ONLY && ONLY.includes('曲线')) {
  console.log(`（--only ${ONLY}：只算情绪曲线，跳过 md 生成）`);
} else {
  writeFile('README.md', renderReadme(cur, causal, fore, arcs));
  writeFile('情绪曲线.md', renderEmotion(cur));
  writeFile('因果链.md', renderCausal(causal));
  writeFile('伏笔与回收.md', renderForeshadow(fore));
  writeFile('角色弧光.md', renderArcs(arcs));
  console.log(DRY ? '（--dry：未写盘）' : '完成。');
}
