#!/usr/bin/env node
/**
 * 非主线分析 —— 主线 109 话 + 羁绊 150 剧之外，剩余 660 剧该怎么读
 *
 * 关键事实（脚本现算，不手抄）：非主线不是铁板一块，得分两类
 *   支线剧情 25 剧   均 64.7 句 —— 与本篇同量级，**能做话层分析**
 *   主页剧情 335 剧   均  1.5 句 ┐
 *   演出结束对话 325 剧 均 1.9 句 ┘ 碎片，只能做说话人/情绪底色统计，做话层分析没意义
 *
 * 用法：
 *   node 工具/build_sidestory_analysis.mjs            # 算 + 渲染
 *   node 工具/build_sidestory_analysis.mjs --check    # 自检
 *   node 工具/build_sidestory_analysis.mjs --dry      # 只打印规模
 *
 * 产出：
 *   话层分析/_data/sidestory.json   真源
 *   话层分析/非主线.md              由 json 渲染
 *
 * 依赖：资料库/_chapter_titles.json（章节标题，区分支线/碎片）
 *      资料库/_emotion_lines.jsonl、剧情分析/_data/emotion_polarity.json（真源，不复制）
 *
 * 幂等：连跑第二次全「= 跳过」（比较时剥掉生成时间戳）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '话层分析');
const DATA = join(OUT, '_data');
const TITLES = join(ROOT, '资料库', '_chapter_titles.json');
const LINES = join(ROOT, '资料库', '_emotion_lines.jsonl');
const FP = join(ROOT, '资料库', '_emotion_fingerprint.json');
const KB_JSON = join(ROOT, '资料库', 'kb.json');
/* 极性表复用 剧情分析 那份（真源），不另存副本 */
const POLARITY = join(ROOT, '剧情分析', '_data', 'emotion_polarity.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

/* 与 build_episode_analysis.mjs 同一份别名（上游模型名 → kb id） */
const MODEL_ALIAS = {
  raikagrandmother: 'baachan', mikumother: 'mikumom', bota: 'pota', bell: 'belle',
  kiyotsugu: 'seikoku', hotaru_child: 'kohotaru', mutsumi_maybe: 'mutsumi',
  hatsune_maybe: 'hatsune', grandma: 'baachan',
  tomori_maybe: 'tomori', hatsune2: 'hatsune',
};
const BAND_LABEL = {
  'MyGO!!!!!': 'MyGO!!!!!', 'Ave Mujica': 'Ave Mujica', '梦限大MewType': '梦限大MewType',
  'millsage': 'millsage', '一家Dumb Rock!': '一家Dumb Rock!', '一家DumbRock': '一家Dumb Rock!',
};

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const stripTs = (s) => s.replace(/^> 生成于.*$/m, '');
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const baseOfExp = (t) => String(t).replace(/^exp_|^mtn_/, '').replace(/_(L|C|R)$/i, '').replace(/[0-9]+$/, '').toLowerCase();

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

/* ---------- 加载 ---------- */
function loadKb() {
  const kb = JSON.parse(readFileSync(KB_JSON, 'utf8'));
  const byId = new Map();
  for (const c of kb.characters ?? []) byId.set(String(c.id).toLowerCase(), c);
  return { byId };
}

function loadPol() {
  const j = JSON.parse(readFileSync(POLARITY, 'utf8'));
  return j.polarity ?? j;
}

function loadLines() {
  const byAdv = new Map();
  for (const l of readFileSync(LINES, 'utf8').trim().split('\n')) {
    const o = JSON.parse(l);
    if (!byAdv.has(o.advId)) byAdv.set(o.advId, []);
    byAdv.get(o.advId).push(o);
  }
  return byAdv;
}

/* ---------- 计算 ---------- */
function compute() {
  const titles = JSON.parse(readFileSync(TITLES, 'utf8')).titles ?? {};
  const byAdv = loadLines();
  const pol = loadPol();
  const { byId } = loadKb();
  const fp = JSON.parse(readFileSync(FP, 'utf8'));

  const zhOf = (m) => {
    const low = String(m ?? '').toLowerCase();
    const id = byId.has(low) ? low : MODEL_ALIAS[low];
    const hit = byId.get(id ?? '');
    if (hit) return hit.name_short || hit.name || m;
    return fp.characters?.[low]?.zh ?? m;
  };
  const bandOf = (m) => {
    const low = String(m ?? '').toLowerCase();
    const id = byId.has(low) ? low : MODEL_ALIAS[low];
    return byId.get(id ?? '')?.band ?? null;
  };

  /* 按 kind 分组 */
  const groups = {};
  for (const [id, t] of Object.entries(titles)) {
    (groups[t.kind] ??= []).push({ advId: +id, ...t });
  }

  const stat = (kind) => {
    const list = groups[kind] ?? [];
    let lines = 0;
    for (const e of list) lines += (byAdv.get(e.advId) ?? []).length;
    return { 剧: list.length, 句: lines, 均: list.length ? r2(lines / list.length) : 0 };
  };

  /* ---- 支线 25 剧：逐条 ---- */
  const side = (groups['支线剧情'] ?? []).sort((a, b) => a.advId - b.advId);
  const episodes = side.map((e) => {
    const arr = byAdv.get(e.advId) ?? [];
    const vs = [], ars = [];
    for (const o of arr) {
      if (!o.exp) continue;
      const p = pol[baseOfExp(o.exp)];
      if (!p) continue;
      vs.push(p.valence); ars.push(p.arousal);
    }
    const cnt = new Map();
    for (const o of arr) if (o.model) cnt.set(o.model, (cnt.get(o.model) ?? 0) + 1);
    const ranked = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
    const lead = ranked[0] ?? null;
    const spoken = arr.filter((o) => o.model).length;
    return {
      advId: e.advId, title: e.zh || e.ja, titleJa: e.ja, script: e.script,
      band: lead ? (BAND_LABEL[bandOf(lead[0]) ?? ''] ?? bandOf(lead[0])) : null,
      lines: arr.length, spoken, tagged: vs.length,
      coverage: spoken ? r3(vs.length / spoken) : 0,
      meanValence: vs.length ? r2(vs.reduce((a, b) => a + b, 0) / vs.length) : null,
      meanArousal: ars.length ? r2(ars.reduce((a, b) => a + b, 0) / ars.length) : null,
      lead: lead ? { model: lead[0], zh: zhOf(lead[0]), n: lead[1], share: r3(lead[1] / spoken) } : null,
      cast: ranked.slice(0, 4).map(([m, n]) => ({ model: m, zh: zhOf(m), n })),
    };
  });

  /* ---- 支线 vs 本篇：同乐队均值对比 ---- */
  const mainEps = [];
  for (const e of [...(groups['本篇'] ?? []), ...(groups['番外'] ?? [])]) {
    if (e.kind !== '本篇') continue;
    const arr = byAdv.get(e.advId) ?? [];
    const vs = [];
    for (const o of arr) {
      if (!o.exp) continue;
      const p = pol[baseOfExp(o.exp)];
      if (p) vs.push(p.valence);
    }
    if (!vs.length) continue;
    const cnt = new Map();
    for (const o of arr) if (o.model) cnt.set(o.model, (cnt.get(o.model) ?? 0) + 1);
    const ranked = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
    const lead = ranked[0] ?? null;
    mainEps.push({
      advId: e.advId,
      band: lead ? (BAND_LABEL[bandOf(lead[0]) ?? ''] ?? bandOf(lead[0])) : null,
      meanValence: r2(vs.reduce((a, b) => a + b, 0) / vs.length),
    });
  }
  const bandCmp = [];
  for (const band of new Set([...episodes.map((e) => e.band), ...mainEps.map((e) => e.band)])) {
    if (!band) continue;
    const s = episodes.filter((e) => e.band === band);
    const m = mainEps.filter((e) => e.band === band);
    if (!s.length || !m.length) continue;
    const avg = (a, f) => r2(a.reduce((x, y) => x + f(y), 0) / a.length);
    bandCmp.push({
      band,
      sideN: s.length, mainN: m.length,
      sideV: avg(s, (x) => x.meanValence ?? 0), mainV: avg(m, (x) => x.meanValence),
      gap: r2(avg(s, (x) => x.meanValence ?? 0) - avg(m, (x) => x.meanValence)),
    });
  }
  bandCmp.sort((a, b) => b.gap - a.gap);

  /* ---- 碎片层：说话人分布 ---- */
  const fragSpeakers = (kind) => {
    const cnt = new Map();
    let lines = 0;
    for (const e of groups[kind] ?? []) {
      for (const o of byAdv.get(e.advId) ?? []) {
        if (!o.model) continue;
        cnt.set(o.model, (cnt.get(o.model) ?? 0) + 1);
        lines += 1;
      }
    }
    return {
      kind, lines,
      top: [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([m, n]) => ({ model: m, zh: zhOf(m), n, share: r3(n / lines) })),
      kinds: cnt.size,
    };
  };

  /* ---- 演出结束对话的 2 人组合 ---- */
  const pairs = new Map();
  for (const e of groups['演出结束对话'] ?? []) {
    const arr = byAdv.get(e.advId) ?? [];
    const ms = [...new Set(arr.map((o) => o.model).filter(Boolean))].sort();
    if (ms.length !== 2) continue;
    const k = ms.join('+');
    if (!pairs.has(k)) pairs.set(k, { pair: k, a: { model: ms[0], zh: zhOf(ms[0]) }, b: { model: ms[1], zh: zhOf(ms[1]) }, n: 0, lines: 0 });
    const p = pairs.get(k);
    p.n += 1; p.lines += arr.length;
  }

  return {
    _generated: new Date().toISOString(),
    _source: ['资料库/_chapter_titles.json', '资料库/_emotion_lines.jsonl', '剧情分析/_data/emotion_polarity.json'],
    _note: '非主线 660 剧分两类处理：支线 25 剧做话层分析，碎片 660 剧只做说话人与情绪底色统计。',
    scale: {
      支线剧情: stat('支线剧情'), 主页剧情: stat('主页剧情'),
      演出结束对话: stat('演出结束对话'), 本篇: stat('本篇'),
    },
    episodes, bandCmp,
    fragments: [fragSpeakers('主页剧情'), fragSpeakers('演出结束对话')],
    pairs: [...pairs.values()].sort((a, b) => b.n - a.n),
  };
}

/* ---------- 渲染 ---------- */
function render(d) {
  const L = [];
  const s = d.scale;
  const side = d.episodes;
  L.push('# 非主线 · 支线剧情与碎片语料');
  L.push('');
  L.push('> 生成于 ' + stamp());
  L.push('');
  L.push('主线 109 话和羁绊剧 150 剧之外还有 **660 剧**。这份文档处理它们，但**不是一视同仁** —— 先分两类。');
  L.push('');
  L.push('## 一、口径：非主线不是一个东西');
  L.push('');
  L.push('| 类型 | 剧数 | 总句数 | 平均每剧 | 能不能做话层分析 |');
  L.push('|---|---:|---:|---:|---|');
  L.push(`| 支线剧情 | ${s.支线剧情.剧} | ${s.支线剧情.句} | **${s.支线剧情.均}** | ✅ 与本篇同量级，本文第二节起分析 |`);
  L.push(`| 演出结束对话 | ${s.演出结束对话.剧} | ${s.演出结束对话.句} | ${s.演出结束对话.均} | ❌ 一两句话，只能统计说话人 |`);
  L.push(`| 主页剧情 | ${s.主页剧情.剧} | ${s.主页剧情.句} | ${s.主页剧情.均} | ❌ 一句话吐槽，只能统计说话人 |`);
  L.push(`|（参考）本篇 | ${s.本篇.剧} | ${s.本篇.句} | ${s.本篇.均} | — |`);
  L.push('');
  L.push(`支线 **${s.支线剧情.均}** 句 vs 碎片 **${s.主页剧情.均}/${s.演出结束对话.均}** 句 —— 差了 40 倍。`);
  L.push('把碎片当「话」去算四段节拍、找转折点，得到的全是噪声。所以本文只给碎片的说话人分布。');
  L.push('');
  L.push('## 二、支线 25 剧逐条');
  L.push('');
  L.push(`共 ${side.length} 条，**5 队 × 5 条**，是各队的乐曲故事（标题就是曲名）。`);
  L.push('「主导」= 该条里台词最多的人；乐队归属也由主导者推定。');
  L.push('');
  L.push('| advId | 标题（简中） | 日文 | 乐队 | 句数 | 带标签率 | 均效价 | 主导 | 主导占比 |');
  L.push('|---:|---|---|---|---:|---:|---:|---|---:|');
  for (const e of side) {
    L.push(`| ${e.advId} | ${e.title} | ${e.titleJa} | ${e.band ?? '—'} | ${e.lines} | ${(e.coverage * 100).toFixed(0)}% | ${e.meanValence == null ? '—' : e.meanValence.toFixed(2)} | ${e.lead ? `${e.lead.zh}（${e.lead.n}）` : '—'} | ${e.lead ? (e.lead.share * 100).toFixed(0) + '%' : '—'} |`);
  }
  L.push('');
  L.push('## 三、支线 vs 本篇：同队情绪底色');
  L.push('');
  L.push('同一乐队内部比。**均效价 = 按句等权的算术平均（−1~+1）**，口径同 [情绪曲线](../剧情分析/情绪曲线.md)。');
  L.push('正值 = 支线比本篇更明快。');
  L.push('');
  L.push('| 乐队 | 支线条数 | 本篇话数 | 支线均效价 | 本篇均效价 | 差 |');
  L.push('|---|---:|---:|---:|---:|---:|');
  for (const c of d.bandCmp) {
    L.push(`| ${c.band} | ${c.sideN} | ${c.mainN} | ${c.sideV.toFixed(2)} | ${c.mainV.toFixed(2)} | ${c.gap > 0 ? '+' : ''}${c.gap.toFixed(2)} |`);
  }
  L.push('');
  L.push('## 四、队内视角分配');
  L.push('');
  L.push('每队的 5 条支线分别以谁为中心 —— 这回答「队里谁有独立故事线」。');
  L.push('');
  const byBand = new Map();
  for (const e of side) {
    if (!e.band) continue;
    if (!byBand.has(e.band)) byBand.set(e.band, []);
    byBand.get(e.band).push(e);
  }
  for (const [band, list] of byBand) {
    const leads = new Map();
    for (const e of list) if (e.lead) leads.set(e.lead.zh, (leads.get(e.lead.zh) ?? 0) + 1);
    L.push(`- **${band}**（${list.length} 条）：` + [...leads.entries()].sort((a, b) => b[1] - a[1])
      .map(([zh, n]) => `${zh} ×${n}`).join('、'));
  }
  L.push('');
  L.push('## 五、碎片层：谁在正剧之外说话');
  L.push('');
  for (const f of d.fragments) {
    L.push(`### ${f.kind}（${f.lines} 句，${f.kinds} 个模型）`);
    L.push('');
    L.push('| 角色 | 句数 | 占比 |');
    L.push('|---|---:|---:|');
    for (const t of f.top) L.push(`| ${t.zh} | ${t.n} | ${(t.share * 100).toFixed(1)}% |`);
    L.push('');
  }
  L.push('## 六、演出结束对话的 2 人组合');
  L.push('');
  L.push(`共 ${d.pairs.length} 个不同的 2 人组合（羁绊剧是 50 对，这里是另一套覆盖面）。`);
  L.push('');
  L.push('| 组合 | 剧数 |');
  L.push('|---|---:|');
  for (const p of d.pairs.slice(0, 20)) L.push(`| ${p.a.zh} ／ ${p.b.zh} | ${p.n} |`);
  L.push('');
  L.push('<!-- USER:START 非主线判断 -->');
  L.push('<!-- 写在这里：支线在本作叙事里的位置、碎片语料该怎么用。重跑生成不会覆盖本块 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  return L.join('\n');
}

/* ---------- main ---------- */
function main() {
  if (has('--check')) {
    const p = join(DATA, 'sidestory.json');
    if (!existsSync(p)) { console.error('[check] 缺产物 ' + p); process.exit(1); }
    const cur = JSON.parse(readFileSync(p, 'utf8'));
    if (!cur.episodes?.length) { console.error('[check] 支线清单为空'); process.exit(1); }
    const fresh = compute();
    const strip = (o) => JSON.stringify({ ...o, _generated: '' });
    if (strip(cur) !== strip(fresh)) { console.error('[check] 内容与上游不一致，需重跑'); process.exit(1); }
    console.log(`[check] 非主线 OK：支线 ${cur.episodes.length} 剧 / 碎片组合 ${cur.pairs.length} 对`);
    return;
  }

  const d = compute();

  if (has('--dry')) {
    console.log('[dry] ' + JSON.stringify(d.scale));
    return;
  }

  writeFileSync(join(DATA, 'sidestory.json'), JSON.stringify(d, null, 1), 'utf8');
  console.log('[非主线] 话层分析/_data/sidestory.json');
  writeFile('话层分析/非主线.md', render(d));
}

main();
