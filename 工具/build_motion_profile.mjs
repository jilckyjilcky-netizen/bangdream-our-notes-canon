#!/usr/bin/env node
/**
 * 动作指纹 —— 演出层「动作（mtn_*）」这一半的分析
 *
 * 既有 角色模型/_演出指纹.md 只做到「动作总榜前 20」，角色级没有动作，
 * 而原始标签粒度太细（mtn_nod01_L / mtn_nod02_C 各 2~3%，看不出人）。
 * 本脚本按**词根**聚合后算**富集度**，回答「谁的标志性动作是什么」。
 *
 * 用法：
 *   node 工具/build_motion_profile.mjs            # 算 + 渲染
 *   node 工具/build_motion_profile.mjs --check    # 自检
 *   node 工具/build_motion_profile.mjs --dry      # 只打印不落盘
 *   node 工具/build_motion_profile.mjs --show     # 打印角色富集度明细
 *
 * 产出：
 *   资料库/_motion_profile.json   真源
 *   角色模型/_动作指纹.md          由 json 渲染
 *
 * 口径：
 *   词根 baseOf()：剥 mtn_ 前缀 → 剥 _L/_C/_R 朝向 → 剥尾部编号（顺序不能反）
 *   富集度 lift = 该角色某词根占比 ÷ 全局同词根占比。lift 2.0 = 两倍于平均水平。
 *   最小样本 MIN_LINES（默认 80 句），低于此不进角色榜，避免小样本造出假指纹。
 *
 * 幂等：连跑第二次全「= 跳过」（比较时剥掉生成时间戳）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LINES = join(ROOT, '资料库', '_emotion_lines.jsonl');
const VOCAB = join(ROOT, '资料库', '_emotion_vocab.json');
const FP = join(ROOT, '资料库', '_emotion_fingerprint.json');
const OUT_JSON = join(ROOT, '资料库', '_motion_profile.json');
const OUT_MD = join(ROOT, '角色模型', '_动作指纹.md');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const oi = argv.indexOf('--min');
const MIN_LINES = oi >= 0 ? Number(argv[oi + 1]) : 80;
/** 进榜最低次数：一个词根在该角色身上出现过几次才谈得上「标志性」 */
const MIN_HITS = 10;

/* baseOf 与 工具/情绪标签.mjs 保持一致：先剥朝向再剥编号 */
const baseOf = (t) => String(t)
  .replace(/^exp_|^mtn_/, '')
  .replace(/_(L|C|R)$/i, '')
  .replace(/[0-9]+$/, '')
  .toLowerCase();

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const stripTs = (s) => s.replace(/^> 生成于.*$/m, '');

/* ---------- USER 块保留 ---------- */
const USER_RE = /<!-- USER:START ([^>]+?) -->\n([\s\S]*?)<!-- USER:END -->/g;
function extractUserBlocks(text) {
  const m = new Map();
  for (const x of text.matchAll(USER_RE)) m.set(x[1], x[2]);
  return m;
}
function applyUserBlocks(content, blocks) {
  return content.replace(USER_RE, (all, name) => {
    const old = blocks.get(name);
    return old == null ? all : `<!-- USER:START ${name} -->\n${old.replace(/\n+$/, '')}\n<!-- USER:END -->`;
  });
}
function writeFile(rel, content) {
  const p = join(ROOT, rel);
  let blocks = new Map();
  if (existsSync(p)) blocks = extractUserBlocks(readFileSync(p, 'utf8'));
  const next = applyUserBlocks(content, blocks);
  const prev = existsSync(p) ? readFileSync(p, 'utf8') : null;
  if (prev !== null && stripTs(prev) === stripTs(next)) { console.log(`  = 跳过  ${rel}`); return; }
  if (!has('--dry')) writeFileSync(p, next, 'utf8');
  console.log(`  ${prev === null ? '✚ 新建' : '✎ 更新'}  ${rel}`);
}

/* ---------- 数据 ---------- */
function load() {
  const lines = readFileSync(LINES, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const vocab = JSON.parse(readFileSync(VOCAB, 'utf8'));
  const fp = JSON.parse(readFileSync(FP, 'utf8'));
  return { lines, vocab, fp };
}

/* 词根 → 中文释义：从 vocab 的 mtn 表按 base 聚合（取频次最高的那条） */
function buildZh(vocab) {
  const zh = new Map();
  const pos = new Map();
  for (const [k, v] of Object.entries(vocab.mtn ?? {})) {
    const b = v.base ?? baseOf(k);
    const cur = zh.get(b);
    if (!cur || v.n > cur.n) { zh.set(b, v.zh ?? b); pos.set(b, v.pos ?? null); }
  }
  return { zh, pos };
}

function compute() {
  const { lines, vocab, fp } = load();
  const { zh } = buildZh(vocab);

  /* 全局词根分布 */
  const global = new Map();
  let gTotal = 0;
  for (const o of lines) {
    if (!o.mot) continue;
    const b = baseOf(o.mot);
    global.set(b, (global.get(b) ?? 0) + 1);
    gTotal += 1;
  }

  /* 角色级（按上游 model 名，不按叙事身份归并 —— 与情绪层同一条纪律） */
  const per = new Map();
  for (const o of lines) {
    if (!o.mot || !o.model) continue;
    let r = per.get(o.model);
    if (!r) { r = { n: 0, m: new Map(), dirs: new Map(), exps: new Map() }; per.set(o.model, r); }
    const b = baseOf(o.mot);
    r.n += 1;
    r.m.set(b, (r.m.get(b) ?? 0) + 1);
    const d = (o.mot.match(/_(L|C|R)$/i) ?? [''])[0].replace('_', '') || 'C';
    r.dirs.set(d, (r.dirs.get(d) ?? 0) + 1);
    if (o.exp) {
      const key = `${baseOf(o.exp)}×${b}`;
      r.exps.set(key, (r.exps.get(key) ?? 0) + 1);
    }
  }

  /* 富集度 */
  const chars = [];
  for (const [key, r] of per) {
    const meta = fp.characters?.[key] ?? {};
    const lifts = [];
    for (const [b, n] of r.m) {
      if (n < MIN_HITS) continue;
      const share = n / r.n;
      const gShare = (global.get(b) ?? 0) / gTotal;
      lifts.push({ base: b, zh: zh.get(b) ?? b, n, share: Math.round(share * 1000) / 1000, lift: Math.round((share / gShare) * 100) / 100 });
    }
    lifts.sort((a, b) => b.lift - a.lift);
    const topPairs = [...r.exps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, n]) => ({ pair: k, n }));
    const dirs = {};
    for (const [d, n] of r.dirs) dirs[d] = Math.round((n / r.n) * 1000) / 1000;
    chars.push({
      key, zh: meta.zh ?? null, short: meta.short ?? null, lines: r.n,
      motKinds: r.m.size,
      enough: r.n >= MIN_LINES,
      top: lifts.slice(0, 3),
      lifts: lifts,
      dirs,
      topPairs,
    });
  }
  chars.sort((a, b) => (b.zh ? 1 : 0) - (a.zh ? 1 : 0) || b.lines - a.lines);

  /* 表情 × 动作 搭配（全局） */
  const pairs = new Map();
  for (const o of lines) {
    if (!o.mot || !o.exp) continue;
    const k = `${baseOf(o.exp)}×${baseOf(o.mot)}`;
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  const pairTop = [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([k, n]) => ({ pair: k, n, share: Math.round((n / pairs.size * 0 + n / [...pairs.values()].reduce((s, x) => s + x, 0)) * 1000) / 1000 }));

  /* 朝向分布（全局） */
  const dirTotal = { L: 0, C: 0, R: 0 };
  let dSum = 0;
  for (const o of lines) {
    if (!o.mot) continue;
    const d = (o.mot.match(/_(L|C|R)$/i) ?? [''])[0].replace('_', '') || 'C';
    if (dirTotal[d] == null) dirTotal[d] = 0;
    dirTotal[d] += 1; dSum += 1;
  }

  return {
    _generated: new Date().toISOString(),
    _source: ['资料库/_emotion_lines.jsonl', '资料库/_emotion_vocab.json', '资料库/_emotion_fingerprint.json'],
    _note: '动作层分析。词根聚合 + 富集度（lift）。最小样本 ' + MIN_LINES + ' 句，进榜最低 ' + MIN_HITS + ' 次。',
    scale: {
      lines: lines.length,
      withMot: gTotal,
      motRate: Math.round((gTotal / lines.length) * 1000) / 1000,
      baseKinds: global.size,
      rawKinds: Object.keys(vocab.mtn ?? {}).length,
      minLines: MIN_LINES,
      minHits: MIN_HITS,
    },
    global: [...global.entries()].sort((a, b) => b[1] - a[1])
      .map(([b, n]) => ({ base: b, zh: zh.get(b) ?? b, n, share: Math.round((n / gTotal) * 1000) / 1000 })),
    characters: chars,
    pairs: pairTop,
    dirs: dirTotal,
    dirSum: dSum,
  };
}

/* ---------- 渲染 ---------- */
function render(d) {
  const L = [];
  const s = d.scale;
  L.push('# 动作指纹 · 演出层「动作」这一半');
  L.push('');
  L.push('> 生成于 ' + stamp());
  L.push('');
  L.push('与 [演出指纹](_演出指纹.md) 是同一批数据的两半：那份讲**表情（exp\_\*）**，这份讲**动作（mtn\_\*）**。');
  L.push('');
  L.push('## 一、口径（先看这个，否则数字会被误读）');
  L.push('');
  L.push('- 原始动作标签 **' + s.rawKinds + '** 种（`mtn_smile01_L` 这种，含编号与朝向），粒度太细：');
  L.push('  最高的也只占 3.5%，直接排榜看不出人。所以本文件按**词根**聚合成 **' + s.baseKinds + '** 类（`smile` / `nod`）。');
  L.push(`- 词根算法：剥 \`mtn_\` → 剥尾部 \`_L/_C/_R\` 朝向 → 剥末尾编号。**顺序不能反**，反了 \`mtn_check01_L\` 会变成 \`check01\`。`);
  L.push(`- **富集度 lift = 该角色某词根占比 ÷ 全局同词根占比**。lift 2.0 = 他做这个动作的频率是平均值的两倍。`);
  L.push('  lift 是相对值，不是「好坏」—— 一个角色 lift 高只说明**这个动作属于他**。');
  L.push(`- 样本门槛：台词 **≥ ${s.minLines} 句** 才进角色榜，且该动作在他身上出现 **≥ ${s.minHits} 次**。`);
  L.push('  低于门槛的不排 —— 小样本统计会造出假指纹。');
  L.push(`- 覆盖：台词行 **${s.lines}**，带动作标签 **${s.withMot}**（**${(s.motRate * 100).toFixed(1)}%**）。`);
  L.push('');
  L.push('## 二、动作词根总榜');
  L.push('');
  L.push('| 词根 | 中文 | 次数 | 占比 |');
  L.push('|---|---|---:|---:|');
  for (const g of d.global) {
    L.push(`| \`${g.base}\` | ${g.zh} | ${g.n} | ${(g.share * 100).toFixed(1)}% |`);
  }
  L.push('');
  L.push('## 三、谁的标志性动作是什么（富集度榜）');
  L.push('');
  L.push(`只列样本足够的角色（≥ ${s.minLines} 句带动作台词）。「前三」按 lift 排，不是按次数排。`);
  L.push('');
  L.push('| 角色 | 带动作台词 | 动作种类 | 标志性动作① | ② | ③ |');
  L.push('|---|---:|---:|---|---|---|');
  let n = 0;
  for (const c of d.characters) {
    if (!c.enough || !c.zh) continue;
    const t = [0, 1, 2].map((i) => (c.top[i] ? `\`${c.top[i].base}\`·${c.top[i].zh} ×${c.top[i].lift.toFixed(1)}` : '—'));
    L.push(`| ${c.zh} | ${c.lines} | ${c.motKinds} | ${t.join(' | ')} |`);
    n += 1;
  }
  L.push('');
  L.push(`（共 ${n} 人达标）`);
  L.push('');
  L.push('## 四、几个反直觉的读数');
  L.push('');
  const hot = d.characters.filter((c) => c.enough && c.zh && c.top.length)
    /* 注意：t.zh 是动作释义，会覆盖角色名 c.zh —— 必须改名带过来 */
    .flatMap((c) => c.top.slice(0, 1).map((t) => ({ who: c.zh, base: t.base, motZh: t.zh, lift: t.lift, n: t.n })))
    .sort((a, b) => b.lift - a.lift).slice(0, 8);
  L.push('| 角色 | 最强标志性动作 | lift | 次数 |');
  L.push('|---|---|---:|---:|');
  for (const h of hot) {
    L.push(`| ${h.who} | \`${h.base}\`·${h.motZh} | ×${h.lift.toFixed(1)} | ${h.n} |`);
  }
  L.push('');
  L.push('## 五、表情 × 动作 搭配（全局 Top 20）');
  L.push('');
  L.push('同一句里同时出现表情与动作的组合。高频组合 = 这套演出的「定式」。');
  L.push('');
  L.push('| 表情 × 动作 | 次数 |');
  L.push('|---|---:|');
  for (const p of d.pairs) L.push(`| \`${p.pair}\` | ${p.n} |`);
  L.push('');
  L.push('## 六、朝向分布');
  L.push('');
  L.push('动作标签带 \_L / \_C / \_R 后缀，是角色面向镜头的方向，不是情绪。');
  L.push('');
  L.push('| 朝向 | 次数 | 占比 |');
  L.push('|---|---:|---:|');
  for (const [k, v] of Object.entries(d.dirs).sort((a, b) => b[1] - a[1])) {
    L.push(`| ${k} | ${v} | ${((v / d.dirSum) * 100).toFixed(1)}% |`);
  }
  L.push('');
  L.push('## 七、逐角色明细（含未达标者）');
  L.push('');
  L.push('| 角色 | 模型名 | 带动作台词 | 动作种类 | 是否达标 |');
  L.push('|---|---|---:|---:|---|');
  for (const c of d.characters) {
    if (!c.zh) continue;
    L.push(`| ${c.zh} | \`${c.key}\` | ${c.lines} | ${c.motKinds} | ${c.enough ? '✅' : '样本不足'} |`);
  }
  L.push('');
  L.push('<!-- USER:START 动作判断 -->');
  L.push('<!-- 写在这里：哪些标志性动作与角色人设吻合/冲突，以及这对 Live2D 演出意味着什么。重跑生成不会覆盖本块 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  return L.join('\n');
}

/* ---------- main ---------- */
function main() {
  if (has('--check')) {
    if (!existsSync(OUT_JSON)) { console.error('[check] 缺产物 ' + OUT_JSON); process.exit(1); }
    const cur = JSON.parse(readFileSync(OUT_JSON, 'utf8'));
    if (!cur.scale || cur.scale.withMot < 20000) { console.error('[check] 带动作句数异常 ' + cur.scale?.withMot); process.exit(1); }
    if (!cur.global?.length) { console.error('[check] 词根榜为空'); process.exit(1); }
    const fresh = compute();
    const strip = (o) => JSON.stringify({ ...o, _generated: '' });
    if (strip(cur) !== strip(fresh)) { console.error('[check] 内容与上游不一致，需重跑'); process.exit(1); }
    const ok = cur.characters.filter((c) => c.enough && c.zh).length;
    console.log(`[check] 动作指纹 OK：词根 ${cur.scale.baseKinds} 类 / 带动作 ${cur.scale.withMot} 句 / 达标角色 ${ok} 人`);
    return;
  }

  const d = compute();

  if (has('--show')) {
    for (const c of d.characters.filter((x) => x.enough && x.zh)) {
      console.log(`${c.zh}(${c.lines}) → ` + c.top.map((t) => `${t.base}×${t.lift.toFixed(1)}`).join('  '));
    }
    return;
  }

  if (has('--dry')) {
    console.log('[dry] 带动作 ' + d.scale.withMot + ' / 词根 ' + d.scale.baseKinds + ' / 达标角色 ' +
      d.characters.filter((c) => c.enough && c.zh).length);
    return;
  }

  writeFileSync(OUT_JSON, JSON.stringify(d, null, 1), 'utf8');
  console.log('[动作指纹] 资料库/_motion_profile.json');
  writeFile('角色模型/_动作指纹.md', render(d));
}

main();
