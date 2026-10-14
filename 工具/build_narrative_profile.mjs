#!/usr/bin/env node
/**
 * build_narrative_profile.mjs —— 乐队「叙事方式」生成器
 * （light-novel-creator §1 Step2 的后半 + §8 样本监督学习的离线实现）
 *
 * 与既有资产的分工：
 *   风格档案/      = 说话层面（句长 / 语气词 / 省略号 / 效价）——「角色怎么说话」
 *   话层分析/      = 单话层面（节拍 / 共演 / 钩子）——「一话内部怎么排」
 *   剧情分析/      = 跨话层面（情绪曲线 / 因果 / 伏笔 / 弧光）——「故事讲了什么」
 *   ★ 叙事方式/    = 技法层面（POV / 群像度 / 篇幅编排 / 转折密度 / 收尾套路）——
 *                    「作者是怎么把这个故事讲出来的」，即可模仿、可迁移的那一层
 *
 * 输入（全本地、零网络）：
 *   话层分析/_data/episode_structure.json   官方篇章分话
 *   话层分析/_data/episode_beats.json       话内四段节拍 + 收尾钩子
 *   话层分析/_data/episode_cast.json        主导者 / 共演
 *   剧情分析/_data/emotion_curves.json      逐话情绪 + 转折点 + 每话角色分布
 *   剧情分析/_data/causal_chain.json        因果链（人工语义，只读）
 *   剧情分析/_data/foreshadows.json         伏笔埋收（人工语义，只读）
 *   剧情分析/_data/character_arcs.json      角色弧光（人工语义，只读）
 *
 * 产出：叙事方式/{README.md, <5 队>.md, 可迁移技法.md} + 叙事方式/_data/narrative_profile.json
 *
 * 硬规矩：所有数字运行时现算注入，不手抄；幂等；USER 块保留。
 *
 * 用法：
 *   node 工具/build_narrative_profile.mjs            # 生成全部
 *   node 工具/build_narrative_profile.mjs --dry      # 只打印统计，不落盘
 *   node 工具/build_narrative_profile.mjs --force    # 忽略时间戳强制重写
 *   node 工具/build_narrative_profile.mjs --check    # 自检
 *   node 工具/build_narrative_profile.mjs --json     # 只落 json（不渲染 md）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '叙事方式');
const DATA_DIR = join(OUT_DIR, '_data');
const JSON_OUT = join(DATA_DIR, 'narrative_profile.json');

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const CHECK = process.argv.includes('--check');
const JSON_ONLY = process.argv.includes('--json');

const CK = join(ROOT, '话层分析', '_data');
const PJ = join(ROOT, '剧情分析', '_data');

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const r2 = (x) => Math.round(x * 100) / 100;
const r1 = (x) => Math.round(x * 10) / 10;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sum = (a) => a.reduce((x, y) => x + y, 0);

function median(arr) {
  const a = [...arr].filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 归一化香农熵：H / ln(k)，1 = 完全平均，0 = 一人独占 */
function entropyNorm(counts) {
  const k = counts.length;
  if (k <= 1) return 0;
  const tot = sum(counts);
  if (!tot) return 0;
  const h = -sum(counts.map((c) => (c > 0 ? (c / tot) * Math.log(c / tot) : 0)));
  return h / Math.log(k);
}

function gini(counts) {
  const a = [...counts].filter((x) => x > 0).sort((x, y) => x - y);
  const n = a.length;
  if (n <= 1) return 0;
  const tot = sum(a);
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (i + 1) * a[i];
  return (2 * acc) / (n * tot) - (n + 1) / n;
}

/** 条形图：25 格 */
function bar(ratio, width = 25) {
  const n = Math.max(0, Math.min(width, Math.round((ratio || 0) * width)));
  return '`' + '█'.repeat(n) + '·'.repeat(width - n) + '`';
}

function topN(obj, n = 5) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
}

/**
 * 乐队名归一化。
 * ⚠ 踩过：语义 json（因果链/弧光）里写的是「〔原文略〕」（无感叹号），
 *   而 篇章结构里是「〔原文略〕」（有感触号）—— 直接 === 会把整队静默匹配成 0。
 *   另外「〔原文略〕」（无空格）这种写法也存在于 kb 里，一并归一。
 */
const normBand = (s) => String(s ?? '').replace(/[!！]/g, '').replace(/[\s　]+/g, '').trim();

/** JOIN 计数表 */
function tally(arr) {
  const c = {};
  for (const x of arr) c[x] = (c[x] || 0) + 1;
  return c;
}

/* ------------------------------------------------------------------ *
 * 加载数据（只读，绝不写回语义 json）
 * ------------------------------------------------------------------ */
function load(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

const STRUCT = load('话层分析/_data/episode_structure.json');
const BEATS = load('话层分析/_data/episode_beats.json');
const CAST = load('话层分析/_data/episode_cast.json');
const CURVES = load('剧情分析/_data/emotion_curves.json');
const CHAINS = load('剧情分析/_data/causal_chain.json');
const FORES = load('剧情分析/_data/foreshadows.json');
const ARCS = load('剧情分析/_data/character_arcs.json');

const MISSING = [
  ['话层分析/_data/episode_structure.json', STRUCT],
  ['话层分析/_data/episode_beats.json', BEATS],
  ['话层分析/_data/episode_cast.json', CAST],
  ['剧情分析/_data/emotion_curves.json', CURVES],
  ['剧情分析/_data/causal_chain.json', CHAINS],
  ['剧情分析/_data/foreshadows.json', FORES],
  ['剧情分析/_data/character_arcs.json', ARCS],
].filter(([, v]) => !v).map(([k]) => k);

if (MISSING.length) {
  console.error('缺少依赖产物，先跑上游生成器：');
  for (const m of MISSING) console.error('  - ' + m);
  console.error('\n顺序：node 工具/情绪标签.mjs → node 工具/build_story_analysis.mjs → node 工具/build_episode_analysis.mjs');
  process.exit(1);
}

const BANDS = STRUCT.bands; // [{ bandNo, bandKey, band, label, 本篇, 番外, range }]
const EP_STRUCT = STRUCT.episodes;
const LABELS = BANDS.map((b) => b.label);

const EP_BY_ID = new Map(EP_STRUCT.map((e) => [e.advId, e]));
const BEAT_BY_ID = new Map(BEATS.episodes.map((e) => [e.advId, e]));
const LEAD_BY_ID = new Map(CAST.lead.map((l) => [l.advId, l]));
const CURVE_BY_ID = new Map(CURVES.episodes.map((e) => [e.advId, e]));

/* ------------------------------------------------------------------ *
 * 按乐队切分
 * ------------------------------------------------------------------ */
function epsOf(label) {
  const own = EP_STRUCT.filter((e) => e.label === label);
  // 本篇按 seq 排；番外跟在后面，也按 seq 排
  return [...own].sort((a, b) => (a.part === b.part ? a.seq - b.seq : a.part === '本篇' ? -1 : 1));
}

/* ------------------------------------------------------------------ *
 * 指标计算
 * ------------------------------------------------------------------ */

/** §1 叙事主体（POV）：谁在带这一话 */
function povProfile(label, eps) {
  const leads = eps.map((e) => LEAD_BY_ID.get(e.advId)).filter(Boolean);
  const rate = leads.map((l) => l.rate);
  const names = leads.map((l) => l.zh);
  const cnt = tally(names);
  const sorted = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
  const n = eps.length;
  // 轮换：相邻话主导者不同的比例
  let switches = 0;
  for (let i = 1; i < names.length; i++) if (names[i] !== names[i - 1]) switches++;
  const top1 = sorted[0]?.[1] ?? 0;
  const top2 = sorted[1]?.[1] ?? 0;
  return {
    eps: n,
    leaders: sorted.length,
    leaders_rate: sorted.length / n,
    mean_lead_rate: r2(mean(rate)),
    min_lead_rate: r2(Math.min(...rate)),
    max_lead_rate: r2(Math.max(...rate)),
    switch_rate: n > 1 ? r2(switches / (n - 1)) : 0,
    top1: sorted[0]?.[0] ?? null,
    top1_eps: top1,
    top1_share: r2(top1 / n),
    top2: sorted[1]?.[0] ?? null,
    top2_eps: top2,
    distribution: sorted,
  };
}

/** §2 群像度：台词在说话人之间的分散程度 */
function ensembleProfile(eps) {
  const perEp = eps.map((e) => {
    const c = CURVE_BY_ID.get(e.advId);
    const cs = (c?.chars ?? []).map((x) => x.n).filter((x) => x > 0);
    return cs.length ? { k: cs.length, top1: Math.max(...cs) / sum(cs), h: entropyNorm(cs), g: gini(cs) } : null;
  }).filter(Boolean);
  const speakers = eps.map((e) => BEAT_BY_ID.get(e.advId)?.speakers).filter((x) => Number.isFinite(x));
  return {
    mean_speakers: r1(mean(speakers)),
    max_speakers: speakers.length ? Math.max(...speakers) : 0,
    mean_top1_share: r2(mean(perEp.map((x) => x.top1))),
    mean_entropy: r2(mean(perEp.map((x) => x.h))),
    mean_gini: r2(mean(perEp.map((x) => x.g))),
    mean_cast: r2(mean(perEp.map((x) => x.k))),
  };
}

/** §3 章回编排：篇幅（台词行）怎么分布在 20 话上 */
function lengthProfile(eps) {
  const main = eps.filter((e) => e.part === '本篇');
  const lines = (main.length ? main : eps).map((e) => e.lines ?? 0);
  const n = lines.length;
  const third = Math.max(1, Math.floor(n / 3));
  const seg = [0, 1, 2].map((i) => mean(lines.slice(i * third, i === 2 ? n : (i + 1) * third)));
  const peakIdx = lines.indexOf(Math.max(...lines));
  return {
    n,
    total: sum(lines),
    mean_lines: Math.round(mean(lines)),
    median_lines: Math.round(median(lines)),
    min_lines: Math.min(...lines),
    max_lines: Math.max(...lines),
    sd_lines: Math.round(Math.sqrt(mean(lines.map((x) => (x - mean(lines)) ** 2)))),
    third_mean: seg.map((x) => Math.round(x)),
    peak_ep: peakIdx + 1,
    peak_pos: r2((peakIdx + 1) / n),
    shape: shapeWord(seg),
  };

  function shapeWord([a, b, c]) {
    const t = Math.max(a, b, c) * 0.12; // 12% 容差
    if (Math.abs(a - b) < t && Math.abs(b - c) < t) return '平台型（三段均衡）';
    if (c > b && b > a) return '渐强型（越往后越密）';
    if (a > b && b > c) return '渐弱型（开头最密）';
    if (b > a && b > c) return '拱型（中段最密）';
    if (b < a && b < c) return 'U型（中段留白）';
    return '起伏型';
  }
}

/** §4 话内节拍模板：高潮落在第几段、开端到收尾的落差 */
function beatProfile(eps) {
  const bs = eps.map((e) => BEAT_BY_ID.get(e.advId)).filter(Boolean);
  const peak = tally(bs.map((b) => b.peakSeg));
  const low = tally(bs.map((b) => b.lowSeg));
  const delta = bs.map((b) => (b.endValence ?? 0) - (b.openValence ?? 0));
  const up = delta.filter((d) => d > 0.2).length;
  const down = delta.filter((d) => d < -0.2).length;
  const flat = delta.length - up - down;
  return {
    n: bs.length,
    peak_dist: [1, 2, 3, 4].map((i) => peak[i] || 0),
    peak_mode: Number(topN(peak, 1)[0]?.[0] ?? 0),
    low_dist: [1, 2, 3, 4].map((i) => low[i] || 0),
    mean_delta: r2(mean(delta)),
    up_eps: up,
    down_eps: down,
    flat_eps: flat,
    mean_open: r2(mean(bs.map((b) => b.openValence ?? 0))),
    mean_end: r2(mean(bs.map((b) => b.endValence ?? 0))),
  };
}

/** §5 收尾钩子：一话怎么断 */
function hookProfile(eps) {
  const bs = eps.map((e) => BEAT_BY_ID.get(e.advId)).filter(Boolean);
  const closers = bs.map((b) => b.closer).filter(Boolean);
  const hook = tally(closers.map((c) => c.hook || '未分类'));
  const q = closers.filter((c) => c.question).length;
  const el = closers.filter((c) => c.ellipsis).length;
  const si = closers.filter((c) => c.silence).length;
  // 收尾的人是不是这一话的主导者
  let own = 0;
  for (const b of bs) {
    const l = LEAD_BY_ID.get(b.advId);
    if (l && b.closer && l.model === b.closer.model) own++;
  }
  return {
    n: closers.length,
    hook_dist: topN(hook, 6),
    question_rate: closers.length ? r2(q / closers.length) : 0,
    ellipsis_rate: closers.length ? r2(el / closers.length) : 0,
    silence_rate: closers.length ? r2(si / closers.length) : 0,
    closer_is_lead_rate: bs.length ? r2(own / bs.length) : 0,
    mean_conf: r2(mean(closers.map((c) => c.conf ?? 0))),
  };
}

/** §6 转折密度：情绪拐点多少、多大、落在哪 */
function turnProfile(label, eps) {
  const own = new Set(eps.map((e) => e.advId));
  const tps = (CURVES.turningPoints ?? []).filter((t) => own.has(t.from) && own.has(t.to));
  const order = eps.map((e) => e.advId);
  const idx = tps.map((t) => order.indexOf(t.to) + 1).filter((x) => x > 0);
  const abs = tps.map((t) => Math.abs(t.delta));
  const worst = tps.reduce((best, t) => (Math.abs(t.delta) > Math.abs(best?.delta ?? 0) ? t : best), null);
  return {
    n_turns: tps.length,
    per_ep: r2(tps.length / eps.length),
    mean_abs_delta: r2(mean(abs)),
    max_abs_delta: abs.length ? r2(Math.max(...abs)) : 0,
    mean_pos: idx.length ? r2(mean(idx)) : 0,
    pos_ratio: idx.length ? r2(mean(idx) / eps.length) : 0,
    worst: worst && { from: worst.from, to: worst.to, delta: r2(worst.delta), direction: worst.direction,
      to_title: EP_BY_ID.get(worst.to)?.title ?? '' },
    detail: tps.map((t) => ({ from: t.from, to: t.to, delta: r2(t.delta), direction: t.direction })),
  };
}

/** §7 伏笔经济学：埋到收要走多少话 */
function foreshadowProfile(label, eps) {
  const own = new Set(eps.map((e) => e.advId));
  const order = eps.map((e) => e.advId);
  const items = (FORES.items ?? []).filter((it) => {
    const all = [...(it.planted ?? []), ...(it.paidOff ?? [])].map((x) => x.advId);
    return all.some((a) => own.has(a));
  });
  const spans = [];
  const status = tally(items.map((it) => it.status));
  let pending = [];
  for (const it of items) {
    const pl = (it.planted ?? []).map((x) => x.advId).filter((a) => own.has(a));
    const pf = (it.paidOff ?? []).map((x) => x.advId).filter((a) => own.has(a));
    if (!pl.length || !pf.length) { if (it.status !== 'paid') pending.push(it.motif); continue; }
    spans.push(order.indexOf(Math.min(...pf)) - order.indexOf(Math.min(...pl)));
  }
  return {
    n: items.length,
    status_dist: Object.entries(status).map(([k, v]) => [k, v]),
    pending_motifs: pending,
    mean_span: spans.length ? r2(mean(spans)) : null,
    median_span: spans.length ? median(spans) : null,
    max_span: spans.length ? Math.max(...spans) : null,
    min_span: spans.length ? Math.min(...spans) : null,
    n_spanned: spans.length,
  };
}

/** §8 因果链密度：一条因果用几话说完 */
function chainProfile(label, eps) {
  const own = new Set(eps.map((e) => e.advId));
  const order = eps.map((e) => e.advId);
  const ownLabel = normBand(label);
  const chains = (CHAINS.chains ?? []).filter((c) => normBand(c.band) === ownLabel);
  const lens = chains.map((c) => c.links.length);
  const spans = chains.map((c) => {
    const ids = c.links.map((l) => l.advId).filter((a) => own.has(a));
    if (!ids.length) return 0;
    return Math.max(...ids.map((a) => order.indexOf(a))) - Math.min(...ids.map((a) => order.indexOf(a))) + 1;
  });
  return {
    n: chains.length,
    mean_links: r2(mean(lens)),
    max_links: lens.length ? Math.max(...lens) : 0,
    mean_span_eps: spans.length ? r2(mean(spans)) : 0,
    max_span_eps: spans.length ? Math.max(...spans) : 0,
    themes: chains.map((c) => ({ id: c.id, theme: c.theme, links: c.links.length })),
  };
}

/** §9 弧光粒度：一个人被切成几段来写 */
function arcProfile(label, eps) {
  const own = new Set(eps.map((e) => e.advId));
  const order = eps.map((e) => e.advId);
  const arcs = Object.values(ARCS.arcs ?? {}).filter((a) => normBand(a.band) === normBand(label));
  const stages = arcs.map((a) => (a.stages ?? []).length);
  const spans = arcs.map((a) => {
    const ids = (a.stages ?? []).map((s) => s.advId).filter((x) => own.has(x));
    if (!ids.length) return 0;
    return Math.max(...ids.map((x) => order.indexOf(x))) - Math.min(...ids.map((x) => order.indexOf(x))) + 1;
  });
  return {
    n: arcs.length,
    mean_stages: r2(mean(stages)),
    max_stages: stages.length ? Math.max(...stages) : 0,
    mean_span_eps: spans.length ? r2(mean(spans)) : 0,
    top: arcs.map((a) => ({ name: a.name, stages: (a.stages ?? []).length }))
      .sort((x, y) => y.stages - x.stages).slice(0, 6),
  };
}

/** §10 标题命名法：官方怎么写话标题 */
function titleProfile(eps) {
  const main = eps.filter((e) => e.part === '本篇');
  const use = main.length ? main : eps;
  const ja = use.map((e) => e.titleJa ?? '');
  const zh = use.map((e) => e.title ?? '');
  return {
    n: use.length,
    ja_mean_len: r2(mean(ja.map((s) => [...s].length))),
    zh_mean_len: r2(mean(zh.map((s) => [...s].length))),
    ja_question: r2(ja.filter((s) => /[？?]/.test(s)).length / use.length),
    ja_exclaim: r2(ja.filter((s) => /[！!]/.test(s)).length / use.length),
    ja_ellipsis: r2(ja.filter((s) => /…|\.\.\./.test(s)).length / use.length),
    ja_long_vowel: r2(ja.filter((s) => /[ー]/.test(s)).length / use.length),
    ja_latin: r2(ja.filter((s) => /[A-Za-z]/.test(s)).length / use.length),
    first: { advId: use[0]?.advId, ja: use[0]?.titleJa, zh: use[0]?.title },
    last: { advId: use.at(-1)?.advId, ja: use.at(-1)?.titleJa, zh: use.at(-1)?.title },
    samples: use.slice(0, 5).map((e) => ({ advId: e.advId, ja: e.titleJa, zh: e.title })),
  };
}

/** §0 范围与篇幅 */
function scopeProfile(label, eps) {
  const main = eps.filter((e) => e.part === '本篇');
  const ex = eps.filter((e) => e.part === '番外');
  const cs = (CURVES.episodes ?? []).filter((e) => eps.some((x) => x.advId === e.advId));
  return {
    eps: eps.length,
    main: main.length,
    extra: ex.length,
    spoken: sum(cs.map((e) => e.spoken ?? 0)),
    tagged: sum(cs.map((e) => e.tagged ?? 0)),
    coverage: cs.length ? r2(mean(cs.map((e) => e.coverage ?? 0))) : 0,
    mean_valence: r2(mean(cs.map((e) => e.meanValence ?? 0))),
    mean_arousal: r2(mean(cs.map((e) => e.meanArousal ?? 0))),
  };
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */
function buildBand(b) {
  const eps = epsOf(b.label);
  return {
    band: b.band,
    label: b.label,
    bandKey: b.bandKey,
    scope: scopeProfile(b.label, eps),
    pov: povProfile(b.label, eps),
    ensemble: ensembleProfile(eps),
    length: lengthProfile(eps),
    beat: beatProfile(eps),
    hook: hookProfile(eps),
    turn: turnProfile(b.label, eps),
    foreshadow: foreshadowProfile(b.label, eps),
    chain: chainProfile(b.label, eps),
    arc: arcProfile(b.label, eps),
    title: titleProfile(eps),
  };
}

function buildAll() {
  const bands = BANDS.map(buildBand);
  // 全局口径（给「摘要」与「对照总表」用的分布区间）
  const allMain = EP_STRUCT.filter((e) => e.part === '本篇');
  const cs = CURVES.episodes ?? [];
  const mainCs = cs.filter((e) => EP_BY_ID.get(e.advId)?.part === '本篇');
  return {
    _note: '叙事方式 = 「作者怎么讲」，区别于 风格档案（怎么说）、话层分析（一话怎么排）、剧情分析（讲了什么）。全部数字由 工具/build_narrative_profile.mjs 现算注入。',
    _src: {
      structure: '话层分析/_data/episode_structure.json',
      beats: '话层分析/_data/episode_beats.json',
      cast: '话层分析/_data/episode_cast.json',
      curves: '剧情分析/_data/emotion_curves.json',
      causal: '剧情分析/_data/causal_chain.json',
      foreshadow: '剧情分析/_data/foreshadows.json',
      arcs: '剧情分析/_data/character_arcs.json',
    },
    _caution: [
      '因果链 / 伏笔 / 弧光三份 json 是**人工语义提炼**，不是上游数据 —— 本脚本只读不写，改那三份即改这里全部数字。',
      '钩子类型是规则初判（beats json 的 hook/conf），可比但不能当权威分类。',
      'advId 顺序 ≠ 剧情顺序（跨队穿插 + 101xx 是番外），所有「第几话」都是**本队本篇章内**的序号。',
    ],
    scale: {
      bands: LABELS.length,
      eps: EP_STRUCT.length,
      main: allMain.length,
      extra: EP_STRUCT.length - allMain.length,
      lines: sum(mainCs.map((e) => e.spoken ?? 0)),
      valence_range: [Math.min(...mainCs.map((e) => e.meanValence ?? 0)), Math.max(...mainCs.map((e) => e.meanValence ?? 0))].map(r2),
      valence_sd: r2(Math.sqrt(mean(mainCs.map((e) => ((e.meanValence ?? 0) - mean(mainCs.map((x) => x.meanValence ?? 0))) ** 2)))),
    },
    bands,
    crossline: {
      _note: '不属于任何一队的条目：因果链里的「跨线」、弧光里的非主线组合。不进单队档案，但读总表时要知道它们的存在。',
      chains: (CHAINS.chains ?? [])
        .filter((c) => !BANDS.some((b) => normBand(b.label) === normBand(c.band)))
        .map((c) => ({ id: c.id, band: c.band, theme: c.theme, links: c.links.length })),
      arcs: [...new Set(
        Object.values(ARCS.arcs ?? {})
          .filter((a) => !BANDS.some((b) => normBand(b.label) === normBand(a.band)))
          .map((a) => a.band)
      )],
      foreshadows: (FORES.items ?? [])
        .filter((it) => {
          const ids = [...(it.planted ?? []), ...(it.paidOff ?? [])].map((x) => x.advId);
          return !ids.some((a) => EP_BY_ID.has(a));
        })
        .map((it) => it.motif),
    },
  };
}

/* ------------------------------------------------------------------ *
 * USER 块保留 + 幂等落盘
 * ------------------------------------------------------------------ */
function pickUserBlocks(text) {
  const blocks = new Map();
  const re = /<!-- USER:START ([^>]+?) -->([\s\S]*?)<!-- USER:END -->/g;
  let m;
  while ((m = re.exec(text))) blocks.set(m[1].trim(), m[2]);
  return blocks;
}

function applyUserBlocks(text, blocks) {
  return text.replace(
    /<!-- USER:START ([^>]+?) -->([\s\S]*?)<!-- USER:END -->/g,
    (all, name) => (blocks.has(name.trim()) ? `<!-- USER:START ${name.trim()} -->${blocks.get(name.trim())}<!-- USER:END -->` : all)
  );
}

const stripTs = (s) => s.replace(/^> 生成于：.*$/m, '');

let CHANGED = 0;
function writeOut(rel, content) {
  const p = join(ROOT, rel);
  const old = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const merged = old ? applyUserBlocks(content, pickUserBlocks(old)) : content;
  if (!FORCE && old && stripTs(old) === stripTs(merged)) return false;
  mkdirSync(dirname(p), { recursive: true });
  if (!DRY) writeFileSync(p, merged, 'utf8');
  CHANGED++;
  return true;
}

/* ------------------------------------------------------------------ *
 * 渲染：五队对照总表
 * ------------------------------------------------------------------ */
function mdLink(name) {
  return `[${name}](${encodeURIComponent(name)}.md)`;
}

function renderReadme(d) {
  const L = [];
  L.push('# 叙事方式 — 五队对照总表');
  L.push('');
  L.push('> 生成于：' + new Date().toISOString().slice(0, 19).replace('T', ' '));
  L.push('> `工具/build_narrative_profile.mjs` 现算注入。逐队口径见各队档案第 0 节。');
  L.push('');
  L.push('## 这是什么');
  L.push('');
  L.push('「叙事方式」回答的不是**角色怎么说话**（那是 [`风格档案/`](../风格档案/README.md)），');
  L.push('也不是**一话内部怎么排**（那是 [`话层分析/`](../话层分析/README.md)）或**故事讲了什么**');
  L.push('（那是 [`剧情分析/`](../剧情分析/README.md)），而是 ——');
  L.push('');
  L.push('> **作者是怎么把这个故事讲出来的。** 视角给谁、篇幅怎么分、转折多密、钩子怎么断。');
  L.push('> 这一层是**可以直接迁移到自己的写作里**的那一层。');
  L.push('');
  L.push('| 层 | 目录 | 回答的问题 |');
  L.push('|---|---|---|');
  L.push('| 说话指纹 | [风格档案/](../风格档案/README.md) | 角色怎么说话 |');
  L.push('| 单话构造 | [话层分析/](../话层分析/README.md) | 一话里面前半后半怎么排 |');
  L.push('| 跨话结构 | [剧情分析/](../剧情分析/README.md) | 情绪怎么走、因果怎么连 |');
  L.push('| **叙事技法** | **本目录** | **这套活儿是怎么干的（可模仿）** |');
  L.push('');
  L.push('## 五队总览');
  L.push('');
  L.push('| 乐队 | 话数 | 台词行 | 主导者数 | 首导占比 | 平均主导率 | 群像熵 | 每话均行 | 篇幅形状 | 转折（数/密度） | 收尾首钩 |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---|');
  for (const b of d.bands) {
    L.push('| ' + [
      mdLink(b.label), b.scope.eps, b.scope.spoken, b.pov.leaders, pct(b.pov.top1_share),
      b.pov.mean_lead_rate, b.ensemble.mean_entropy, b.length.mean_lines, b.length.shape,
      `${b.turn.n_turns}处/${b.turn.per_ep}`, b.hook.hook_dist[0]?.[0] ?? '—',
    ].join(' | ') + ' |');
  }
  L.push('');
  L.push('> 群像熵 = 每话台词在说话人间的归一化香农熵均值；1 = 人人均等，越接近 0 = 一人独占。');
  L.push('> 首导占比 = 主导话数最多的那个角色，占了百分之几的话。');
  L.push('');
  L.push('## 五队速写');
  L.push('');
  for (const b of d.bands) {
    const povWord = b.pov.top1_share >= 0.5 ? '强单核' : b.pov.top1_share >= 0.35 ? '主辅核' : '轮换群像';
    L.push(`### ${b.label}`);
    L.push('');
    L.push(`主导 **${b.pov.top1}**（${b.pov.top1_eps}/${b.pov.eps} 话，${pct(b.pov.top1_share)}）· **${povWord}** ｜ ` +
      `每话 ${b.ensemble.mean_speakers} 人开口 · 群像熵 ${b.ensemble.mean_entropy} ｜ ` +
      `每话 ${b.length.mean_lines} 行 · **${b.length.shape}** ｜ ` +
      `转折 ${b.turn.n_turns} 处（${b.turn.per_ep}/话）｜ 高潮常在第 **${b.beat.peak_mode}** 段`);
    L.push('');
    const hooks = b.hook.hook_dist.slice(0, 3).map(([k, v]) => `${k} ${v}次`).join(' · ');
    L.push(`收尾钩子：${hooks}`);
    L.push('');
    const thesis = b.chain.themes.slice(0, 3).map((t) => t.theme).filter(Boolean);
    if (thesis.length) L.push(`命题：${thesis.join(' ／ ')}`);
    L.push('');
  }
  L.push('## 横向三条硬结论');
  L.push('');
  const sortedByEntropy = [...d.bands].sort((a, b) => b.ensemble.mean_entropy - a.ensemble.mean_entropy);
  const sortedByTop1 = [...d.bands].sort((a, b) => b.pov.top1_share - a.pov.top1_share);
  const sortedByTurn = [...d.bands].sort((a, b) => b.turn.per_ep - a.turn.per_ep);
  L.push(`1. **群像度跨度很大**：${sortedByEntropy[0].label} 最平均（熵 ${sortedByEntropy[0].ensemble.mean_entropy}），` +
    `${sortedByEntropy.at(-1).label} 最集中（熵 ${sortedByEntropy.at(-1).ensemble.mean_entropy}）。` +
    `差别 ${r2(sortedByEntropy[0].ensemble.mean_entropy - sortedByEntropy.at(-1).ensemble.mean_entropy)}，` +
    '在同一个「全员乐队群像剧」的框架里，这是刻意的分工而不是噪声。');
  L.push(`2. **每队都有一个「定盘星」视角人物**：${sortedByTop1.map((b) => `${b.label}→${b.pov.top1}（${pct(b.pov.top1_share)}）`).join('、')}。` +
    '写群像不等于平均分配镜头，而是**一个稳定的视点 + 若干轮换**。');
  L.push(`3. **转折密度差异明显**：${sortedByTurn.map((b) => `${b.label} ${b.turn.per_ep}`).join(' > ')}。` +
    '转折密的不一定更「燃」，也可能是靠连续的情绪落差推进；稀的通常是靠累积而不是反转。');
  L.push('');
  L.push('## 口径');
  L.push('');
  if (d.crossline.chains.length || d.crossline.arcs.length) {
    L.push(`> **不属于任何一队的条目**（不进单队档案，读总表时要知道）：` +
      `因果链 ${d.crossline.chains.length} 条` +
      (d.crossline.chains.length ? `（${d.crossline.chains.map((c) => `${c.id} ${c.band}`).join('、')}）` : '') +
      `；弧光所属的非主线组合 ${d.crossline.arcs.length} 个` +
      (d.crossline.arcs.length ? `（${d.crossline.arcs.join('、')}）` : '') +
      `；完全落在主线 advId 之外的伏笔 ${d.crossline.foreshadows.length} 项。`);
    L.push('');
  }
  L.push(`- 范围：五队主线 **${d.scale.eps}** 话 = 本篇 **${d.scale.main}** + 番外 **${d.scale.extra}**；本篇台词 **${d.scale.lines}** 行。`);
  L.push(`- 逐话均效价实测区间 **${d.scale.valence_range[0]} ~ ${d.scale.valence_range[1]}**（σ=${d.scale.valence_sd}）。` +
    '这不是 ±1 的量表，**0.2 就是显著落差**，读下面的 delta 别拿 ±1 的直觉。');
  L.push('- 「第几话」一律是**本队本篇章内**的序号 —— ⚠ **advId 顺序 ≠ 剧情顺序**' +
    '（各队主线时间上互相穿插，且 advId 10100–10108 是番外）。跨队不可据 advId 推断先后。');
  L.push('- **因果链 / 伏笔 / 弧光是人工语义提炼**（`剧情分析/_data/*.json`），本生成器只读不写。' +
    '改那三份 json，本目录全部数字跟着变。');
  L.push('- 收尾钩子是**规则初判**（`episode_beats.json` 的 `hook` / `conf`），可比但可修订。');
  L.push('');
  L.push('<!-- USER:START 总表补充 -->');
  L.push('<!-- 写在这里：你对五队对照的补充观察。重跑生成不会覆盖本块 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  return L.join('\n');
}

/* ------------------------------------------------------------------ *
 * 渲染：单队档案
 * ------------------------------------------------------------------ */
function renderBand(b, d) {
  const L = [];
  const p = (x) => (x === 0 ? '0' : String(x));
  L.push(`# 叙事方式: ${b.label}`);
  L.push('');
  L.push('> 生成于：' + new Date().toISOString().slice(0, 19).replace('T', ' '));
  L.push(`> 本篇 **${b.scope.main}** 话 + 番外 **${b.scope.extra}** 话 ｜ 台词 **${b.scope.spoken}** 行 ｜ ` +
    `情绪标签覆盖 **${pct(b.scope.coverage)}** ｜ 均效价 **${b.scope.mean_valence}** ／ 均唤醒 **${b.scope.mean_arousal}**`);
  L.push('> 全部数字由 `工具/build_narrative_profile.mjs` 现算注入，不手抄。');
  L.push('');
  L.push('## 0. 口径');
  L.push('');
  L.push('| 来源 | 性质 |');
  L.push('|---|---|');
  L.push('| 话数 / 台词行 / advId / 主导者 | **客观**（上游数据，可一直复算到原文） |');
  L.push('| 群像熵 / 转折 delta / 篇幅形状 | **半客观**（客观计数 × 本脚本的阈值与公式） |');
  L.push('| 因果链 / 伏笔 / 弧光的条目本身 | **主观**（`剧情分析/_data/*.json` 人工语义提炼，附 advId 可复核） |');
  L.push('');
  L.push('效价 / 唤醒口径同 [`剧情分析/情绪曲线.md`](../剧情分析/情绪曲线.md)。');
  L.push(`全 ${d.scale.main} 篇范围的逐话均效价实测只落在 **${d.scale.valence_range[0]} ~ ${d.scale.valence_range[1]}**（σ=${d.scale.valence_sd}），` +
    '**0.2 已是显著落差**。');
  L.push('');
  L.push('---');
  L.push('');

  L.push('## 1. 叙事主体（POV）：镜头给谁');
  L.push('');
  const pt = b.pov;
  L.push(`- 主导者：**${pt.leaders}** 人瓜分 ${pt.eps} 话（人均 ${r2(pt.leaders / pt.eps)} 话/人）`);
  L.push(`- 首导：**${pt.top1}** —— ${pt.top1_eps} 话，占 ${pct(pt.top1_share)}` +
    (pt.top2 ? `；次席 **${pt.top2}** ${pt.top2_eps} 话` : ''));
  L.push(`- 平均主导率（主导者占本话台词比）：**${pct(pt.mean_lead_rate)}**（最低 ${pct(pt.min_lead_rate)} ／ 最高 ${pct(pt.max_lead_rate)}）`);
  L.push(`- 视角轮换率（相邻话换人）：**${pct(pt.switch_rate)}**`);
  L.push('');
  L.push('| 主导者 | 话数 | 占比 |');
  L.push('|---|---:|---:|');
  for (const [name, n] of pt.distribution) {
    L.push(`| ${name} | ${n} | ${pct(n / pt.eps)} |`);
  }
  L.push('');
  const povWord = pt.top1_share >= 0.5 ? '**强单核**：一个人说了算，其他人只在自己的话里主视角'
    : pt.top1_share >= 0.35 ? '**主辅核**：一个稳定视点带一个轮换副视点'
    : '**轮换群像**：镜头平摊，没有固定主角';
  L.push(`判读：${povWord}。视角轮换率 ${pct(pt.switch_rate)}` +
    (pt.switch_rate >= 0.6 ? ' 偏高 —— 几乎每话换人，靠视角差制造层次。'
      : pt.switch_rate >= 0.4 ? ' 中等 —— 有连任也有轮换，主副视点交替。'
      : ' 偏低 —— 同一个人连续带好几话，是「追着一个人写」的结构。'));
  L.push('');

  L.push('## 2. 群像度：台词分得多不均');
  L.push('');
  const en = b.ensemble;
  L.push(`- 每话开口人数：**${en.mean_speakers}** 人（最多 ${en.max_speakers} 人）`);
  L.push(`- 每话台词最多者占比：**${pct(en.mean_top1_share)}**`);
  L.push(`- 群像熵（归一化）：**${en.mean_entropy}**`);
  L.push(`- 台词分配基尼系数：**${en.mean_gini}**`);
  L.push('');
  L.push('| 指标 | 值 | 条形 |');
  L.push('|---|---:|---|');
  L.push(`| 群像熵（1=完全平均） | ${en.mean_entropy} | ${bar(en.mean_entropy)} |`);
  L.push(`| 首名台词占比 | ${pct(en.mean_top1_share)} | ${bar(1 - en.mean_top1_share)} |`);
  L.push(`| 每话开口人数 / ${en.max_speakers} | ${en.mean_speakers} | ${bar(en.mean_speakers / en.max_speakers)} |`);
  L.push('');

  L.push('## 3. 章回编排：篇幅怎么铺');
  L.push('');
  const ln = b.length;
  L.push(`- 每话台词行：均 **${ln.mean_lines}** ／ 中位 **${ln.median_lines}** ／ 最短 **${ln.min_lines}** ／ 最长 **${ln.max_lines}**（σ=${ln.sd_lines}）`);
  L.push(`- 三等分均值：**${ln.third_mean.join(' → ')}** 行`);
  L.push(`- 峰值话：第 **${ln.peak_ep}** 话（位置 ${pct(ln.peak_pos)}）`);
  L.push(`- 形状：**${ln.shape}**`);
  L.push('');
  L.push('| 段 | 均行数 | 相对 |');
  L.push('|---|---:|---:|');
  const mx = Math.max(...ln.third_mean) || 1;
  ln.third_mean.forEach((v, i) => {
    L.push(`| 第 ${i + 1}/3 | ${v} | ${bar(v / mx, 20)} |`);
  });
  L.push('');

  L.push('## 4. 话内节拍：高潮落在第几段');
  L.push('');
  const bt = b.beat;
  L.push('| 段 | 作为峰段的话数 | 作为谷段的话数 |');
  L.push('|---|---:|---:|');
  bt.peak_dist.forEach((v, i) => {
    L.push(`| 第 ${i + 1} 段 | ${v} | ${bt.low_dist[i]} |`);
  });
  L.push('');
  L.push(`- 峰段众数：**第 ${bt.peak_mode} 段**`);
  L.push(`- 开场均效价 **${bt.mean_open}** → 收尾均效价 **${bt.mean_end}**`);
  L.push(`- 单话open→end落差：回升 ${bt.up_eps} 话 ／ 走低 ${bt.down_eps} 话 ／ 持平 ${bt.flat_eps} 话（阈值 ±0.2）`);
  L.push('');
  L.push(`判读：${bt.peak_mode === 4 ? '高潮压在话尾 —— 每话都在最后一段推上顶点再断掉，标准的追更钩子结构。'
    : bt.peak_mode === 1 ? '开场即高点 —— 先给冲击再往下走，靠落差的余韵推进。'
    : `高潮在第 ${bt.peak_mode} 段 —— 拱形结构，话尾留的是余韵而不是顶点。`}` +
    ` 收尾相对开场平均 ${bt.mean_delta >= 0 ? '回升' : '走低'} ${Math.abs(bt.mean_delta)}` +
    (Math.abs(bt.mean_delta) < 0.2 ? '（不足 0.2，视为持平）。' : '。'));
  L.push('');

  L.push('## 5. 收尾钩子：一话怎么断');
  L.push('');
  const hk = b.hook;
  L.push('| 钩子类型 | 次数 | 占比 |');
  L.push('|---|---:|---:|');
  for (const [k, v] of hk.hook_dist) {
    L.push(`| ${k} | ${v} | ${pct(v / hk.n)} |`);
  }
  L.push('');
  L.push(`- 结尾句是疑问句：**${pct(hk.question_rate)}** ／ 省略号：**${pct(hk.ellipsis_rate)}** ／ 纯沉默收：**${pct(hk.silence_rate)}**`);
  L.push(`- 收尾的人就是本话主导者：**${pct(hk.closer_is_lead_rate)}**`);
  L.push(`- 钩子判定平均置信度：**${hk.mean_conf}**（规则初判，可在 \`话层分析/_data/episode_beats.json\` 修订）`);
  L.push('');

  L.push('## 6. 转折密度：多久拐一次');
  L.push('');
  const tn = b.turn;
  L.push(`- 转折点：**${tn.n_turns}** 处，密度 **${tn.per_ep}** /话`);
  L.push(`- 平均落差 |Δ|：**${tn.mean_abs_delta}** ／ 最大 **${tn.max_abs_delta}**`);
  L.push(`- 平均落点：第 **${r2(tn.mean_pos)}** 话（${pct(tn.pos_ratio)} 处）`);
  if (tn.worst) {
    L.push(`- 最大落差：${tn.worst.from} → ${tn.worst.to}（${EP_BY_ID.get(tn.worst.to)?.title ?? ''}）Δ${tn.worst.delta}・${tn.worst.direction}`);
  }
  L.push('');
  if (tn.detail.length) {
    L.push('| 转折 | Δ效价 | 方向 |');
    L.push('|---|---:|---|');
    for (const t of tn.detail) {
      L.push(`| ${t.from} → ${t.to}（${EP_BY_ID.get(t.to)?.title ?? ''}） | ${t.delta} | ${t.direction} |`);
    }
    L.push('');
  }
  L.push(`判读：${tn.per_ep >= 0.35 ? '高转折密度 —— 情绪几乎每两话就换一次方向，靠连续落差推进而不是靠累积。'
    : tn.per_ep >= 0.2 ? '中转折密度 —— 大约四五话一个拐点，有起伏也有平台。'
    : '低转折密度 —— 长坡一路到底，转折少但每一处都很重。'}`);
  L.push('');

  L.push('## 7. 伏笔经济学：埋到收要走多少话');
  L.push('');
  const fs = b.foreshadow;
  L.push(`- 牵涉本队的伏笔：**${fs.n}** 项（${fs.status_dist.map(([k, v]) => `${k} ${v}`).join(' · ')}）`);
  if (fs.n_spanned) {
    L.push(`- 埋→收跨距：均 **${fs.mean_span}** 话 ／ 中位 **${fs.median_span}** ／ 最短 **${fs.min_span}** ／ 最长 **${fs.max_span}** 话`);
  }
  if (fs.pending_motifs.length) {
    L.push(`- 未回收（含跨队的）：${fs.pending_motifs.map((m) => `「${m}」`).join('、')}`);
  }
  L.push('');
  L.push(`判读：${!fs.n ? '本队没有登记的伏笔条目。'
    : fs.mean_span === null ? '没有构成「埋—收」配对的条目（只埋或只收）。'
    : fs.mean_span <= 4 ? '短线伏笔 —— 埋下去三四话就收，属于章内呼应而不是长线布局。'
    : fs.mean_span <= 10 ? '中线伏笔 —— 半程埋、后半程收，是全篇结构的一部分。'
    : '长线伏笔 —— 跨大半本书，读者要忍很久才等到回收。'}`);
  L.push('');

  L.push('## 8. 因果链密度：一件事用几话说完');
  L.push('');
  const ch = b.chain;
  L.push(`- 因果链：**${ch.n}** 条`);
  L.push(`- 每条环节数：均 **${ch.mean_links}** ／ 最长 **${ch.max_links}**`);
  L.push(`- 平均跨 **${ch.mean_span_eps}** 话（最长 ${ch.max_span_eps} 话）`);
  L.push('');
  if (ch.themes.length) {
    L.push('| 链 | 命题 | 环节 |');
    L.push('|---|---|---:|');
    for (const t of ch.themes) {
      L.push(`| ${t.id} | ${t.theme ?? '—'} | ${t.links} |`);
    }
    L.push('');
  }
  L.push(`判读：${ch.mean_links >= 6 ? '一件事摊成六七个环节慢慢走 —— 因果是逐级推进的，不是一步到位。'
    : ch.mean_links >= 4 ? '四五个环节讲完一件事 —— 起、承、转、落各占一格。'
    : '环节精简 —— 因果短促直接，靠事件本身而不是层层铺垫。'}`);
  L.push('');

  L.push('## 9. 弧光粒度：一个人被切成几段写');
  L.push('');
  const ac = b.arc;
  L.push(`- 有弧光的角色：**${ac.n}** 人`);
  L.push(`- 人均阶段数：**${ac.mean_stages}** ／ 最多 **${ac.max_stages}**`);
  L.push(`- 平均跨 **${ac.mean_span_eps}** 话`);
  L.push('');
  if (ac.top.length) {
    L.push('| 角色 | 阶段数 |');
    L.push('|---|---:|');
    for (const t of ac.top) L.push(`| ${t.name} | ${t.stages} |`);
    L.push('');
  }

  L.push('## 10. 标题命名法：官方怎么起话名');
  L.push('');
  const ti = b.title;
  L.push(`- 日文原标题均长 **${ti.ja_mean_len}** 字符 ／ 简中 **${ti.zh_mean_len}** 字`);
  L.push(`- 疑问句：**${pct(ti.ja_question)}** ／ 感叹号：**${pct(ti.ja_exclaim)}** ／ 省略号：**${pct(ti.ja_ellipsis)}**`);
  L.push(`- 带长音符「ー」：**${pct(ti.ja_long_vowel)}** ／ 含拉丁字母：**${pct(ti.ja_latin)}**`);
  if (ti.first) L.push(`- 第一话：**${ti.first.zh}**（${ti.first.ja}）`);
  if (ti.last) L.push(`- 最终话：**${ti.last.zh}**（${ti.last.ja}）`);
  L.push('');
  L.push('| 前几话标题 | 简中 | 日文 |');
  L.push('|---|---|---|');
  for (const s of ti.samples) {
    L.push(`| ${s.advId} | ${s.zh} | ${s.ja} |`);
  }
  L.push('');
  L.push(`判读：${ti.ja_latin >= 0.5 ? `标题整本用**拉丁文**（占比 ${pct(ti.ja_latin)}）—— 用另一套语言把日常拉开距离，` +
      '读者每点开一话先过一道「翻译关」，仪式感由此而来；代价是标题本身不再承担信息量。'
    : ti.ja_question >= 0.25 ? '**悬念式** —— 直接把问题抛给读者，正文是他的解答时间。'
    : ti.ja_ellipsis >= 0.2 ? '**留白式** —— 话说一半，等正文把后半句补上。'
    : '**陈述式** —— 名词短语直接命名本话的核心物件或状态，信息量全压在正文里。'}`);
  L.push('');

  L.push('---');
  L.push('');
  L.push('<!-- USER:START 模仿要点 -->');
  L.push('<!-- 写在这里：你要从这一队借走的具体写法。重跑生成不会覆盖本块 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  return L.join('\n');
}

/* ------------------------------------------------------------------ *
 * 渲染：可迁移技法（§8 样本监督学习记录）
 * ------------------------------------------------------------------ */
function renderTransfer(d) {
  const L = [];
  L.push('# 可迁移技法 — 从五队原作能借走什么');
  L.push('');
  L.push('> 生成于：' + new Date().toISOString().slice(0, 19).replace('T', ' '));
  L.push('> light-novel-creator §8「样本监督学习」的学习记录格式：来源 → 学习要点 → 可迁移技巧 → 注意事项。');
  L.push('> 每节前 4 行是脚本现算的实测数字；「迁移写法」与例外由人工补，写在 USER 块里不会被覆盖。');
  L.push('');
  L.push('> ⚠️ **禁止把原作大段正文搬进自己的产出。** 素材只用于归纳技法，不用于复制文本。');
  L.push('');

  L.push('## 0. 这份记录怎么用');
  L.push('');
  L.push('每一节对应一个**独立的技法旋钮**。写东西的时候不必全套照搬 —— 通常是选 1~2 个旋钮拧到某队的档位。');
  L.push('');
  L.push('| 旋钮 | 调到低 | 调到高 |');
  L.push('|---|---|---|');
  L.push('| 单核集中度 | 轮换群像、人人有镜头 | 一人视角贯穿全书 |');
  L.push('| 群像熵 | 台词集中在少数人嘴里 | 台词均匀铺开 |');
  L.push('| 篇幅形状 | 开头密集 / 中段留白 | 越往后越密、尾段爆量 |');
  L.push('| 峰段位置 | 开场即高点 | 高潮压话尾 |');
  L.push('| 转折密度 | 长坡直下 | 两三话一拐 |');
  L.push('| 伏笔跨距 | 三四话短线呼应 | 跨半部长线 |');
  L.push('');
  L.push('---');
  L.push('');

  const sections = [
    ['来源 · 谁给了什么档位', renderSrc],
    ['技法一 · 镜头给谁（单核 vs 群像）', renderTechPov],
    ['技法二 · 篇幅怎么铺', renderTechLength],
    ['技法三 · 高潮放在哪一段', renderTechBeat],
    ['技法四 · 一话怎么断', renderTechHook],
    ['技法五 · 多久拐一次弯', renderTechTurn],
    ['技法六 · 伏笔埋多远', renderTechForeshadow],
    ['技法七 · 一件事分几步说完', renderTechChain],
    ['技法八 · 标题怎么起', renderTechTitle],
    ['注意事项（踩过的坑）', renderCaveats],
  ];
  for (const [title, fn] of sections) {
    L.push(`## ${title}`);
    L.push('');
    L.push(fn(d));
  }

  L.push('---');
  L.push('');
  L.push('<!-- USER:START 迁移写法 -->');
  L.push('<!-- 写在这里：你自己验证过有效的迁移写法。重跑生成不会覆盖本块 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  L.push('<!-- USER:START 例外与注意 -->');
  L.push('<!-- 写在这里：哪些技法不适合你的题材、踩过什么坑。重跑生成不会覆盖本块 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  return L.join('\n');

  /* ---------- 各节渲染 ---------- */
  function renderSrc(d) {
    const L = [];
    L.push('### 来源');
    L.push('');
    L.push(`- 底本：本仓库 ` +
      `[\`素材全量/按话/\`](../素材全量/) 逐话原文 + [\`话层分析/\`](../话层分析/README.md) + [\`剧情分析/\`](../剧情分析/README.md)`);
    L.push(`- 规模：五队主线 **${d.scale.eps}** 话（本篇 ${d.scale.main} + 番外 ${d.scale.extra}），本篇台词 **${d.scale.lines}** 行。`);
    L.push('- **全部本地、断网取得** —— 这是 light-novel-creator §0 规定的离线学习路径，没有联网检索。');
    L.push('');
    L.push('### 学习要点');
    L.push('');
    L.push('五队是同一个开发方、同一个框架下的产物，「同题异构」—— 同样的「五人组乐队群像剧」，');
    L.push('却摆出了明显不同的叙事参数。这比对比不同作者的作品更干净：**差异是刻意的，不是噪声**。');
    L.push('');
    L.push('| 队 | ' + d.bands.map((b) => b.label).join(' | ') + ' |');
    L.push('|' + '---|'.repeat(d.bands.length + 1));
    const rows = [
      ['首导（占比）', (b) => `${b.pov.top1} ${pct(b.pov.top1_share)}`],
      ['主导者人数', (b) => String(b.pov.leaders)],
      ['群像熵', (b) => String(b.ensemble.mean_entropy)],
      ['每话开口人数', (b) => String(b.ensemble.mean_speakers)],
      ['每话行数', (b) => String(b.length.mean_lines)],
      ['篇幅形状', (b) => b.length.shape],
      ['峰段众数', (b) => `第 ${b.beat.peak_mode} 段`],
      ['转折密度', (b) => String(b.turn.per_ep)],
      ['伏笔平均跨距', (b) => (b.foreshadow.mean_span === null ? '—' : `${b.foreshadow.mean_span} 话`)],
      ['因果环节均值', (b) => String(b.chain.mean_links)],
      ['标题疑问率', (b) => pct(b.title.ja_question)],
    ];
    for (const [name, fn] of rows) {
      L.push(`| ${name} | ` + d.bands.map(fn).join(' | ') + ' |');
    }
    L.push('');
    return L.join('\n');
  }

  function renderTechPov(d) {
    const L = [];
    L.push('### 实测');
    L.push('');
    const sorted = [...d.bands].sort((a, b) => b.pov.top1_share - a.pov.top1_share);
    for (const b of sorted) {
      L.push(`- **${b.label}**：${b.pov.top1} 带 ${b.pov.top1_eps}/${b.pov.eps} 话（${pct(b.pov.top1_share)}），` +
        `轮换率 ${pct(b.pov.switch_rate)}，平均主导率 ${pct(b.pov.mean_lead_rate)}，群像熵 ${b.ensemble.mean_entropy}`);
    }
    L.push('');
    L.push('### 可迁移技巧');
    L.push('');
    L.push(`- **写一个角色 = 给他 35%~60% 的话语权，而不是全部。** 最高的 ${sorted[0].label} 也只到 ${pct(sorted[0].pov.top1_share)}，` +
      `最平均的 ${sorted.at(-1).label} 是 ${pct(sorted.at(-1).pov.top1_share)} —— 这个区间是五队共同的做法。`);
    L.push('- **轮换率别拉到 100%。** 五队的视角轮换率都在 30%~70% 之间，说明「连续几话让同一个人带」是必要的 —— ' +
      '读者的代入需要一个稳定的落脚点，纯轮换会散。');
    L.push('- **群像不等于平均。** 判断镜头是否平均要看**群像熵**而不是人数：' +
      `${Math.max(...d.bands.map((b) => b.ensemble.mean_speakers))} 人同场也可以是独角戏（某一人吃掉大半台词）。`);
    L.push('');
    return L.join('\n');
  }

  function renderTechLength(d) {
    const L = [];
    L.push('### 实测');
    L.push('');
    for (const b of d.bands) {
      L.push(`- **${b.label}**：${b.length.third_mean.join(' → ')} 行（${b.length.shape}），峰值在第 ${b.length.peak_ep} 话，σ=${b.length.sd_lines}`);
    }
    L.push('');
    L.push('### 可迁移技巧');
    L.push('');
    const inc = d.bands.filter((b) => b.length.shape.startsWith('渐强'));
    const dec = d.bands.filter((b) => b.length.shape.startsWith('渐弱'));
    const arch = d.bands.filter((b) => b.length.shape.startsWith('拱'));
    L.push(`- 五队里 **${inc.length ? inc.map((b) => b.label).join('、') : '（无）'}** 走渐强 —— 越往后每话量越大，是「收束期加速」的做法。`);
    L.push(`- **${dec.length ? dec.map((b) => b.label).join('、') : '（无）'}** 走渐弱 —— 开场给足量，后面靠推进而非加量。`);
    L.push(`- **${arch.length ? arch.map((b) => b.label).join('、') : '（无）'}** 走拱型 —— 中段是信息量最大的地方。`);
    L.push('- **σ 本身就是信息**：标准差大的队是靠「轻重交替」做呼吸，标准差小的队是靠匀速推进。' +
      `五队 σ 从 ${Math.min(...d.bands.map((b) => b.length.sd_lines))} 到 ${Math.max(...d.bands.map((b) => b.length.sd_lines))} 行。`);
    L.push('');
    return L.join('\n');
  }

  function renderTechBeat(d) {
    const L = [];
    L.push('### 实测');
    L.push('');
    for (const b of d.bands) {
      L.push(`- **${b.label}**：峰段众数第 ${b.beat.peak_mode} 段（分布 ${b.beat.peak_dist.join('/')}），` +
        `open→end 落差 ${b.beat.mean_delta}（升 ${b.beat.up_eps} / 降 ${b.beat.down_eps} / 平 ${b.beat.flat_eps}）`);
    }
    L.push('');
    L.push('### 可迁移技巧');
    L.push('');
    const tail = d.bands.filter((b) => b.beat.peak_mode === 4);
    L.push(`- **五队里有 ${tail.length} 队把高潮压在第 4 段** —— [话层分析/话内节拍.md](../话层分析/话内节拍.md) 已有同样结论：` +
      '每话都在最后四分之一推到顶点再断掉。这是追更媒体的通用解法，可以直接借。');
    L.push('- **但「开场低 → 收尾高」不是常态。** 看上面的升/降/平分布，多数队的落差绝对值不足 0.2 —— ' +
      '真正压住读者的是**那一话的最后一句说什么**，不是整话的情绪抬升。');
    L.push('- 反过来用：**谷段落在第 4 段同样有效**。想让读者带着不安翻页，就把最难受的那句放最后一句。');
    L.push('');
    return L.join('\n');
  }

  function renderTechHook(d) {
    const L = [];
    L.push('### 实测');
    L.push('');
    for (const b of d.bands) {
      L.push(`- **${b.label}**：${b.hook.hook_dist.slice(0, 3).map(([k, v]) => `${k} ${v}`).join(' · ')}；` +
        `收尾疑问 ${pct(b.hook.question_rate)} / 省略号 ${pct(b.hook.ellipsis_rate)} / 沉默 ${pct(b.hook.silence_rate)}；` +
        `收尾者即主导者 ${pct(b.hook.closer_is_lead_rate)}`);
    }
    L.push('');
    L.push('### 可迁移技巧');
    L.push('');
    const maxSil = [...d.bands].sort((a, b) => b.hook.silence_rate - a.hook.silence_rate)[0];
    const maxLead = [...d.bands].sort((a, b) => b.hook.closer_is_lead_rate - a.hook.closer_is_lead_rate)[0];
    L.push(`- **最后一句要给出去还是留着？** 五队差异很大：${maxSil.label} 的沉默收尾率 ${pct(maxSil.hook.silence_rate)}，` +
      '说明「什么都不说」也是一种收尾 —— 连载的最小单位不是章，是「下一次点击」。');
    L.push(`- **收尾权给谁**：${maxLead.label} 有 ${pct(maxLead.hook.closer_is_lead_rate)} 的话是由本话主导者收的尾 —— ` +
      '让主导者把话说到最后，视角才是完整的；反过来，让配角收尾往往是为了在这一话末尾埋一颗钉子。');
    L.push('- 疑问句收尾 = 把球踢回给读者，逼他往下翻；省略号收尾 = 话没说完，等下一话。两者不要连用太多话，会疲。');
    L.push('');
    return L.join('\n');
  }

  function renderTechTurn(d) {
    const L = [];
    L.push('### 实测');
    L.push('');
    const sorted = [...d.bands].sort((a, b) => b.turn.per_ep - a.turn.per_ep);
    for (const b of sorted) {
      L.push(`- **${b.label}**：${b.turn.n_turns} 处（${b.turn.per_ep}/话），平均 |Δ| ${b.turn.mean_abs_delta}，` +
        `最大 ${b.turn.max_abs_delta}${b.turn.worst ? ` @ ${b.turn.worst.to}「${b.turn.worst.to_title}」` : ''}`);
    }
    L.push('');
    L.push('### 可迁移技巧');
    L.push('');
    L.push(`- 密度从 ${sorted.at(-1).turn.per_ep} 到 ${sorted[0].turn.per_ep} /话 —— **差了 ${r2(sorted[0].turn.per_ep / Math.max(0.01, sorted.at(-1).turn.per_ep))} 倍**，` +
      '两种写法都能成立：高密度靠连续落差，低密度靠长坡累积。');
    L.push('- **落差是相对刻度，不是绝对刻度。** 逐话均效价全篇只落在 ' +
      `${d.scale.valence_range[0]} ~ ${d.scale.valence_range[1]}（σ=${d.scale.valence_sd}），` +
      '上面那些 Δ 看着只有零点几，已经是「这写完读者要愣一下」的量级。');
    L.push('- 转折点太密会**钝化**读者。想让某一次转折真正砸下来，前面要给它几话的平台 —— 这是低密度队的做法。');
    L.push('');
    return L.join('\n');
  }

  function renderTechForeshadow(d) {
    const L = [];
    L.push('### 实测');
    L.push('');
    for (const b of d.bands) {
      const f = b.foreshadow;
      L.push(`- **${b.label}**：${f.n} 项（${f.status_dist.map(([k, v]) => `${k} ${v}`).join(' · ')}），` +
        (f.n_spanned ? `跨距 均 ${f.mean_span} / 中位 ${f.median_span} / ${f.min_span}~${f.max_span} 话` : '无埋—收配对'));
    }
    L.push('');
    L.push('### 可迁移技巧');
    L.push('');
    const spanned = d.bands.filter((b) => b.foreshadow.mean_span !== null);
    if (spanned.length) {
      const s = [...spanned].sort((a, b) => a.foreshadow.mean_span - b.foreshadow.mean_span);
      L.push(`- 跨距最短的是 **${s[0].label}**（${s[0].foreshadow.mean_span} 话），最长的是 **${s.at(-1).label}**（${s.at(-1).foreshadow.mean_span} 话）。` +
        '**短线呼应（≤4 话）和长线布局（≥10 话）要混用** —— 只用短线显得碎，只用长线读者会忘。');
    }
    L.push('- **伏笔的回收要有仪式感。** 看 [`剧情分析/伏笔与回收.md`](../剧情分析/伏笔与回收.md)：回收点几乎都配了原句对照 —— ' +
      '把当初的原话摆回来，比让角色"想起来了"有力得多。');
    L.push('- ⚠ 注意：本节的伏笔条目是**人工语义提炼**，不是上游标注。「这两处构成埋—收关系」是解读，可复核（`foreshadows.json` 里有 advId）。');
    L.push('');
    return L.join('\n');
  }

  function renderTechChain(d) {
    const L = [];
    L.push('### 实测');
    L.push('');
    for (const b of d.bands) {
      L.push(`- **${b.label}**：${b.chain.n} 条因果，均 ${b.chain.mean_links} 环节（最长 ${b.chain.max_links}），平均跨 ${b.chain.mean_span_eps} 话`);
    }
    L.push('');
    L.push('### 可迁移技巧');
    L.push('');
    L.push('- **一条因果链摊成 4~7 个环节**是五队的共同做法：源头 → 内化 → 显形 → 松动 → 破局 → 落地。');
    L.push('  这六格可以直接当写作模板用 —— 尤其「**松动**」这一格最容易漏：' +
      '很多故事从「显形」直接跳到「破局」，缺了中间那次失败或半解的尝试，转折就会显得廉价。');
    L.push('- ⚠️ 因果链的**机制**（为什么 A 导致 B）是提炼者的解读，advId 与事件才是底本事实。' +
      '借这层的时候读 [`剧情分析/因果链.md`](../剧情分析/因果链.md) 的 mechanism 字段，别只抄环节数。');
    L.push('');
    return L.join('\n');
  }

  function renderTechTitle(d) {
    const L = [];
    L.push('### 实测');
    L.push('');
    for (const b of d.bands) {
      L.push(`- **${b.label}**：日 ${b.title.ja_mean_len} 字符 / 中 ${b.title.zh_mean_len} 字；` +
        `疑问 ${pct(b.title.ja_question)}，省略号 ${pct(b.title.ja_ellipsis)}，长音符 ${pct(b.title.ja_long_vowel)}，拉丁字 ${pct(b.title.ja_latin)}`);
    }
    L.push('');
    L.push('### 可迁移技巧');
    L.push('');
    L.push('- **短。** 五队的日文原标题均值都在个位数到十几字符之间。标题不是摘要，是标签 —— ' +
      '取本话最能代表的那一个词、一个物件，或一个问句。');
    const maxQ = [...d.bands].sort((a, b) => b.title.ja_question - a.title.ja_question)[0];
    L.push(`- **疑问句是一把好用的钩子**：${maxQ.label} 有 ${pct(maxQ.title.ja_question)} 的标题是问句。` +
      '问句标题等于先给读者一个问题，正文是他的解答时间。');
    L.push('- **三个「不要」：不要剧透、不要概括全话、不要用抽象名词（如「觉悟」「羁绊」）。** ' +
      '看上面的样例，五队几乎没人起抽象词标题，全是具体物件、动作、或直接引语。');
    L.push('');
    return L.join('\n');
  }

  function renderCaveats(d) {
    const L = [];
    L.push('### 注意事项');
    L.push('');
    L.push('1. **数字会变。** 本文件所有实测值由 `node 工具/build_narrative_profile.mjs` 现算。' +
      '上游（话层分析 / 剧情分析）重跑之后本文件也变了，不要手抄数字到别处 —— 需要引用就指回来。');
    L.push('2. **advId 顺序 ≠ 剧情顺序。** 各队主线时间上互相穿插，且 advId 10100–10108 是番外（后日谈）。' +
      '跨队、跨篇章都不能据 advId 推断先后（详见 [`话层分析/篇章结构.md`](../话层分析/篇章结构.md)）。');
    L.push('3. **演出层数据按上游 model 名统计** —— `mortis` 与 `mutsumi` 不合并且分别计入。' +
      '归并会抹掉 Ave Mujica 最核心的反差。');
    L.push('4. **因果链 / 伏笔 / 弧光是人工提炼。** 三份 json 在 `剧情分析/_data/`，本生成器**只读不写** —— ' +
      '改它们等于改这里全部结论。要修订就改 json 再重跑，不要改 md。');
    L.push('5. **钩子类型是规则初判**（`episode_beats.json` 的 `hook` / `conf`），不是权威分类。' +
      '需要精确口径时回去改那一份 json。');
    L.push('6. **别把「群像」当成一个模子。** 本文件度量的是「五人乐队群像剧」这一特定框架；' +
      '换题材（单人独白、双线并进、单元剧）必须重跑并重新校准 —— 尤其是单核占比与群像熵这两个旋钮。');
    L.push('');
    return L.join('\n');
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
const DATA = buildAll();

if (CHECK) {
  const errs = [];
  const files = ['README.md', '可迁移技法.md', ...LABELS.map((l) => `${l}.md`)];
  for (const f of files) {
    if (!existsSync(join(OUT_DIR, f))) errs.push(`缺少 ${f}`);
  }
  if (!existsSync(JSON_OUT)) errs.push('缺少 _data/narrative_profile.json');
  if (existsSync(JSON_OUT)) {
    const j = JSON.parse(readFileSync(JSON_OUT, 'utf8'));
    if (j.bands?.length !== 5) errs.push(`json 里不是 5 队（实际 ${j.bands?.length}）`);
    for (const b of j.bands ?? []) {
      if (!b.pov?.top1) errs.push(`${b.label}: 算不出首导`);
      if (!b.length?.n) errs.push(`${b.label}: 没有本篇话`);
      if (!Number.isFinite(b.ensemble?.mean_entropy)) errs.push(`${b.label}: 群像熵算不出来`);
      if (!Number.isFinite(b.turn?.per_ep)) errs.push(`${b.label}: 转折密度算不出来`);
    }
  }
  if (errs.length) {
    console.error('[叙事方式] 自检失败：');
    for (const e of errs) console.error('  ✗ ' + e);
    console.error('\n先跑：node 工具/build_narrative_profile.mjs');
    process.exit(1);
  }
  console.log(`[叙事方式] OK —— 5 队档案 + 总表 + 可迁移技法 + json 全部就位` +
    `（${DATA.scale.eps} 话 / ${DATA.scale.lines} 行本篇台词）`);
  process.exit(0);
}

console.log('=== 叙事方式·实测 ===');
for (const b of DATA.bands) {
  console.log(
    `${b.label.padEnd(16, ' ')} 首导 ${String(b.pov.top1).padEnd(6, '　')} ${pct(b.pov.top1_share).padStart(6)} ｜ ` +
    `熵 ${b.ensemble.mean_entropy} ｜ 行 ${String(b.length.mean_lines).padStart(4)} ｜ ` +
    `${b.length.shape.padEnd(12, '　')} ｜ 峰第${b.beat.peak_mode}段 ｜ 转折 ${b.turn.per_ep} ｜ ` +
    `伏笔跨 ${b.foreshadow.mean_span ?? '—'} ｜ 因果 ${b.chain.mean_links} 环节`
  );
}

if (DRY) {
  console.log('\n(--dry 只打印，不落盘)');
  process.exit(0);
}

mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(JSON_OUT, JSON.stringify(DATA, null, 2) + '\n', 'utf8');
console.log(`\n→ ${JSON_OUT.replace(ROOT + '\\', '')}`);

if (!JSON_ONLY) {
  for (const [rel, content] of [
    ['叙事方式/README.md', renderReadme(DATA)],
    ['叙事方式/可迁移技法.md', renderTransfer(DATA)],
    ...DATA.bands.map((b) => [`叙事方式/${b.label}.md`, renderBand(b, DATA)]),
  ]) {
    writeOut(rel, content);
    console.log(`→ ${rel}`);
  }
  console.log(`\n改了 ${CHANGED} 个文件（未变的跳过；再跑一次应全「跳过」= 幂等）`);
}

process.exit(0);
