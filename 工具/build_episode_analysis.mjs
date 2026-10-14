#!/usr/bin/env node
/**
 * 话层分析生成器 —— 以「话（episode）」为分析单元
 *
 * 四层产出（json 是真源，md 由本脚本渲染）：
 *   A 篇章结构   episode_structure.json  官方剧本名 -> 本篇 100 + 番外 9
 *   B 话内节拍   episode_beats.json      每话四段情绪、峰值位置、结尾句与钩子
 *   C 主导与共演 episode_cast.json       主导者、登场跨度、共演矩阵
 *   D 羁绊阶梯   bond_ladder.json        50 对 × 3 级的关系递进模板
 *
 * 用法：
 *   node 工具/build_episode_analysis.mjs              # 算 + 渲染
 *   node 工具/build_episode_analysis.mjs --only 数据  # 只算 json
 *   node 工具/build_episode_analysis.mjs --check      # 自检
 *   node 工具/build_episode_analysis.mjs --dry        # 不落盘
 *   node 工具/build_episode_analysis.mjs --force      # 忽略时间戳强制重写
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '话层分析');
const DATA = join(OUT, '_data');
const EP_DIR = join(ROOT, '素材全量', '按话', 'ja');
const EMOTION = join(ROOT, '资料库', '_emotion_lines.jsonl');
/* 极性表复用 剧情分析 的那份（真源），不复制一份以免两处维护 */
const POLARITY = join(ROOT, '剧情分析', '_data', 'emotion_polarity.json');
/* 官方章节标题（四语）：md 里已有的 # 标题是官方简中，这里补日文原文与英文 */
const TITLES = join(ROOT, '资料库', '_chapter_titles.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const FORCE = argv.includes('--force');
const CHECK = argv.includes('--check');
const oi = argv.indexOf('--only');
const ONLY = oi >= 0 ? (argv[oi + 1] ?? '') : '';

/* ------------------------------------------------------------------ *
 * 公共：USER 块保留 / 幂等写入（同 build_novel_env.mjs 的做法）
 * ------------------------------------------------------------------ */
const USER_RE = /<!-- USER:START ([^>]+?) -->\n([\s\S]*?)<!-- USER:END -->/g;
function extractUserBlocks(text) {
  const m = new Map();
  for (const mt of text.matchAll(USER_RE)) m.set(mt[1], mt[2]);
  return m;
}
function applyUserBlocks(content, blocks) {
  if (!blocks || !blocks.size) return content;
  return content.replace(USER_RE, (full, name) =>
    blocks.has(name) ? `<!-- USER:START ${name} -->\n${blocks.get(name)}<!-- USER:END -->` : full
  );
}
const stripTs = (s) => s.replace(/^> 生成于.*$/m, '');
const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

let created = 0, updated = 0, skipped = 0;
function writeFile(rel, content) {
  const abs = join(OUT, rel);
  let out = content;
  if (existsSync(abs)) {
    out = applyUserBlocks(content, extractUserBlocks(readFileSync(abs, 'utf8')));
  }
  const changed = !existsSync(abs) || FORCE || stripTs(readFileSync(abs, 'utf8')) !== stripTs(out);
  if (DRY) { console.log(`  ${changed ? '~' : '='} ${rel}${changed ? '（将写入）' : ''}`); return; }
  if (!changed) { skipped++; console.log(`  = 跳过  ${rel}`); return; }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, out, 'utf8');
  existsSync(abs) && (created += 0);
  updated++;
  console.log(`  ${existsSync(abs) ? '✎' : '+'} ${changed ? '更新' : '新建'}  ${rel}`);
}

/* ------------------------------------------------------------------ *
 * 公共：角色归一（复用 kb.json，key 用原始 model 名以保留舞台人格差异）
 * ------------------------------------------------------------------ */
const MODEL_ALIAS = {
  raikagrandmother: 'baachan', mikumother: 'mikumom', bota: 'pota', bell: 'belle',
  kiyotsugu: 'seikoku', hotaru_child: 'kohotaru', mutsumi_maybe: 'mutsumi',
  hatsune_maybe: 'hatsune', grandma: 'baachan',
  tomori_maybe: 'tomori', hatsune2: 'hatsune',
};
let KB = null;
function loadKb() {
  if (KB) return KB;
  const kb = JSON.parse(readFileSync(join(ROOT, '资料库', 'kb.json'), 'utf8'));
  const byId = new Map(), byStage = new Map();
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
  KB = { kb, byId, idOf, zhOf };
  return KB;
}

/* 表情词根：先剥 _L|_C|_R 再剥末尾编号（顺序反了会查不到词根） */
function baseOf(tag) {
  if (!tag) return null;
  let s = String(tag).replace(/_(L|C|R)$/i, '');
  s = s.replace(/\d+$/, '');
  return s.replace(/^(exp|mtn)_/, '');
}

/* ------------------------------------------------------------------ *
 * A. 篇章结构 —— 官方剧本名即权威分章
 *    adv_script_{bandkey}_{编号}_1_{话序}          -> 本篇
 *    adv_script_{bandkey}_{编号}_exstory_1_{话序}  -> 番外
 * ------------------------------------------------------------------ */
const BAND_LABEL = {
  mygo: 'MyGO!!!!!', mujica: 'Ave Mujica', yumemita: '梦限大MewType',
  millsage: 'millsage', kadan: '一家Dumb Rock!',
};
const SCRIPT_RE = /^([a-z]+)_(\d+)_(exstory_)?(\d+)_(\d+)$/;

/** 官方标题表：advId -> { ja, zh, en, kind }。缺文件则回退（标题仍取 md 的中文） */
function loadTitles() {
  try {
    const j = JSON.parse(readFileSync(TITLES, 'utf8'));
    return j.titles ?? {};
  } catch {
    return {};
  }
}

function scanEpisodes() {
  const rows = [];
  const titles = loadTitles();
  const base = join(EP_DIR, '主线');
  for (const band of readdirSync(base)) {
    const bd = join(base, band);
    if (!statSync(bd).isDirectory()) continue;
    for (const f of readdirSync(bd)) {
      if (!f.endsWith('.md')) continue;
      const head = readFileSync(join(bd, f), 'utf8').split('\n').slice(0, 8).join('\n');
      const adv = head.match(/advId\*\* (\d+)/);
      const sc = head.match(/`adv_script_([^`]+)`/);
      const ti = head.match(/^# (.+)$/m);
      const ln = head.match(/(\d+) 行/);
      if (!adv) continue;
      const raw = sc ? sc[1] : null;
      const m = raw ? raw.match(SCRIPT_RE) : null;
      rows.push({
        advId: +adv[1],
        band: band,
        bandKey: m ? m[1] : null,
        bandNo: m ? +m[2] : null,
        part: m && m[3] ? '番外' : '本篇',
        chapter: m ? +m[4] : null,
        seq: m ? +m[5] : null,
        script: raw,
        title: ti ? ti[1].trim() : f.replace(/^\d+_/, '').replace(/\.md$/, ''),
        /* 日文原文：md 只有官方简中，这里补回编剧写的原标题 */
        titleJa: titles[adv[1]]?.ja ?? '',
        titleEn: titles[adv[1]]?.en ?? '',
        lines: ln ? +ln[1] : null,
      });
    }
  }
  rows.sort((a, b) => (a.bandNo ?? 99) - (b.bandNo ?? 99) || (a.part === b.part ? (a.seq ?? 0) - (b.seq ?? 0) : a.part === '本篇' ? -1 : 1));
  return rows;
}

/* ------------------------------------------------------------------ *
 * B/C. 逐句数据：按 advId 分组
 * ------------------------------------------------------------------ */
function loadLines() {
  const txt = readFileSync(EMOTION, 'utf8');
  const byAdv = new Map();
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (!byAdv.has(o.advId)) byAdv.set(o.advId, []);
    byAdv.get(o.advId).push(o);
  }
  for (const arr of byAdv.values()) arr.sort((a, b) => a.seq - b.seq);
  return byAdv;
}
function loadPol() {
  const p = JSON.parse(readFileSync(POLARITY, 'utf8'));
  return p.polarity ?? p;
}

/* 结尾句特征 -> 钩子类型（规则初判，人工可改 json 修订） */
function hookOf(text, valence) {
  const t = String(text ?? '').trim();
  if (!t) return { hook: '静默收束', conf: 0.6 };
  if (/^[…．.]+$/.test(t.replace(/\s/g, ''))) return { hook: '静默收束', conf: 0.6 };
  if (/[？?]/.test(t)) return { hook: '疑问悬置', conf: 0.5 };
  if (/[…]|…$|\.\.\.$/.test(t)) return { hook: '言语未尽', conf: 0.5 };
  if (valence <= -0.5) return { hook: '压抑收尾', conf: 0.5 };
  if (valence >= 0.5) return { hook: '明朗收尾', conf: 0.5 };
  return { hook: '平收', conf: 0.4 };
}
const isQuestion = (t) => /[？?]/.test(String(t ?? ''));
const isEllipsis = (t) => /…|\.\.\./.test(String(t ?? ''));
const isSilence = (t) => /^[…．.・\s]*$/.test(String(t ?? '').replace(/[　\s]/g, ''));

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
function main() {
  const t0 = Date.now();
  console.log('话层分析生成器');

  /* ---- A 篇章结构 ---- */
  const eps = scanEpisodes();
  const parsed = eps.filter((e) => e.script);
  const byPart = { 本篇: parsed.filter((e) => e.part === '本篇'), 番外: parsed.filter((e) => e.part === '番外') };
  const bands = [];
  for (const e of parsed) {
    if (!bands.find((b) => b.bandNo === e.bandNo)) {
      bands.push({
        bandNo: e.bandNo, bandKey: e.bandKey, band: e.band,
        label: BAND_LABEL[e.bandKey] ?? e.band,
        本篇: parsed.filter((x) => x.bandNo === e.bandNo && x.part === '本篇').length,
        番外: parsed.filter((x) => x.bandNo === e.bandNo && x.part === '番外').length,
        range: (() => {
          const g = parsed.filter((x) => x.bandNo === e.bandNo);
          const ids = g.map((x) => x.advId).sort((a, b) => a - b);
          return [ids[0], ids[ids.length - 1]];
        })(),
      });
    }
  }
  bands.sort((a, b) => a.bandNo - b.bandNo);
  const structure = {
    _note: '官方剧本名 adv_script_{bandkey}_{编号}_1_{话序}；带 exstory 段的是番外。advId 的 101xx 段 = 番外，不是本篇延续。',
    total: parsed.length,
    本篇: byPart.本篇.length,
    番外: byPart.番外.length,
    bands,
    episodes: parsed.map((e) => ({
      advId: e.advId, title: e.title, titleJa: e.titleJa, titleEn: e.titleEn,
      band: e.band, label: BAND_LABEL[e.bandKey] ?? e.band,
      part: e.part, seq: e.seq, script: e.script, lines: e.lines,
    })),
  };

  /* ---- B/C 逐句 ---- */
  const byAdv = loadLines();
  const pol = loadPol();
  const { zhOf, idOf } = loadKb();

  const beats = [];
  const castMap = new Map();   // model -> {id, zh, lines, eps:Set, first, last}
  const cooc = new Map();      // "a|b" -> n
  const leadOf = new Map();    // advId -> {model, n, rate}

  for (const e of parsed) {
    const lines = (byAdv.get(e.advId) ?? []).filter((x) => x.exp);
    const spoken = (byAdv.get(e.advId) ?? []).length;
    const all = byAdv.get(e.advId) ?? [];
    const rec = {
      advId: e.advId, title: e.title, titleJa: e.titleJa, band: e.band, part: e.part, seq: e.seq,
      spoken, tagged: lines.length, speakers: new Set(all.map((x) => x.model)).size,
    };
    if (!lines.length) { beats.push(rec); continue; }

    /* 四等分节拍 */
    const segs = [[], [], [], []];
    lines.forEach((x, i) => segs[Math.min(3, Math.floor((i * 4) / lines.length))].push(x));
    rec.segments = segs.map((s, i) => {
      const vs = s.map((x) => pol[baseOf(x.exp)]?.valence).filter((v) => typeof v === 'number');
      const ars = s.map((x) => pol[baseOf(x.exp)]?.arousal).filter((v) => typeof v === 'number');
      return {
        i: i + 1, n: s.length,
        valence: vs.length ? +(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(3) : null,
        arousal: ars.length ? +(ars.reduce((a, b) => a + b, 0) / ars.length).toFixed(2) : null,
      };
    });
    const vseq = rec.segments.map((s) => s.valence).filter((v) => v !== null);
    rec.meanValence = +(vseq.reduce((a, b) => a + b, 0) / vseq.length).toFixed(3);
    const peak = rec.segments.reduce((a, b) => (Math.abs(b.valence ?? 0) > Math.abs(a.valence ?? 0) ? b : a), rec.segments[0]);
    rec.peakSeg = peak.i;
    rec.peakValence = peak.valence;
    const low = rec.segments.reduce((a, b) => ((b.valence ?? 0) < (a.valence ?? 0) ? b : a), rec.segments[0]);
    rec.lowSeg = low.i;
    rec.lowValence = low.valence;

    /* 开场三句 / 结尾三句 */
    const head3 = lines.slice(0, 3), tail3 = lines.slice(-3);
    const vOf = (arr) => {
      const vs = arr.map((x) => pol[baseOf(x.exp)]?.valence).filter((v) => typeof v === 'number');
      return vs.length ? +(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(3) : null;
    };
    rec.openValence = vOf(head3);
    rec.endValence = vOf(tail3);
    const last = lines[lines.length - 1];
    const lv = pol[baseOf(last.exp)]?.valence ?? null;
    rec.closer = {
      model: last.model, zh: zhOf(last.model), exp: baseOf(last.exp),
      valence: lv, text: String(last.text ?? '').replace(/\n/g, ' ').slice(0, 60),
      question: isQuestion(last.text), ellipsis: isEllipsis(last.text), silence: isSilence(last.text),
      ...hookOf(last.text, lv ?? 0),
    };
    beats.push(rec);

    /* 主导与共演 */
    const cnt = new Map();
    for (const x of byAdv.get(e.advId) ?? []) cnt.set(x.model, (cnt.get(x.model) ?? 0) + 1);
    const sorted = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length) {
      leadOf.set(e.advId, { model: sorted[0][0], zh: zhOf(sorted[0][0]), n: sorted[0][1], rate: +(sorted[0][1] / (byAdv.get(e.advId)?.length || 1)).toFixed(3), speakers: sorted.length });
    }
    for (const [m, n] of sorted) {
      if (!castMap.has(m)) castMap.set(m, { id: m, zh: zhOf(m), kbId: idOf(m), lines: 0, eps: new Set(), first: e.advId, last: e.advId, leads: 0 });
      const c = castMap.get(m);
      c.lines += n; c.eps.add(e.advId);
      c.first = Math.min(c.first, e.advId); c.last = Math.max(c.last, e.advId);
    }
    const ms = [...cnt.keys()];
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const k = [ms[i], ms[j]].sort().join('|');
        cooc.set(k, (cooc.get(k) ?? 0) + 1);
      }
    }
    if (sorted.length) {
      const lc = castMap.get(sorted[0][0]);
      if (lc) lc.leads++;
    }
  }

  /* 相邻话接钩：本话结尾效价 -> 下一话开场效价（同 band 同 part 内） */
  for (const b of bands) {
    const g = beats.filter((x) => x.label === b.label).sort((a, b2) => (a.part === b2.part ? a.seq - b2.seq : a.part === '本篇' ? -1 : 1));
    for (let i = 0; i < g.length - 1; i++) {
      const cur = g[i], nxt = g[i + 1];
      if (cur.endValence == null || nxt.openValence == null || cur.part !== nxt.part) continue;
      cur.handoff = { next: nxt.advId, delta: +(nxt.openValence - cur.endValence).toFixed(3) };
    }
  }

  const cast = [...castMap.values()]
    .map((c) => ({ id: c.id, zh: c.zh, kbId: c.kbId, lines: c.lines, episodes: c.eps.size, first: c.first, last: c.last, leads: c.leads }))
    .sort((a, b) => b.lines - a.lines);
  const coPairs = [...cooc.entries()].map(([k, n]) => {
    const [a, b] = k.split('|');
    return { a, aZh: zhOf(a), aKb: !!idOf(a), b, bZh: zhOf(b), bKb: !!idOf(b), n };
  }).sort((x, y) => y.n - x.n);

  /* ---- D 羁绊阶梯 ---- */
  const bondDir = join(EP_DIR, '羁绊剧情');
  const bondRows = [];
  if (existsSync(bondDir)) {
    for (const f of readdirSync(bondDir)) {
      const m = f.match(/^(\d+)_(.+)_(\d)\.md$/);
      if (!m) continue;
      const advId = +m[1], pair = m[2], lv = +m[3];
      const head = readFileSync(join(bondDir, f), 'utf8').split('\n').slice(0, 8).join('\n');
      const ti = head.match(/^# (.+)$/m);
      const lines = (byAdv.get(advId) ?? []).filter((x) => x.exp);
      const vs = lines.map((x) => pol[baseOf(x.exp)]?.valence).filter((v) => typeof v === 'number');
      const ars = lines.map((x) => pol[baseOf(x.exp)]?.arousal).filter((v) => typeof v === 'number');
      bondRows.push({
        advId, pair, level: lv, title: ti ? ti[1].trim() : pair,
        spoken: (byAdv.get(advId) ?? []).length, tagged: lines.length,
        valence: vs.length ? +(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(3) : null,
        arousal: ars.length ? +(ars.reduce((a, b) => a + b, 0) / ars.length).toFixed(2) : null,
      });
    }
  }
  bondRows.sort((a, b) => a.pair.localeCompare(b.pair, 'ja') || a.level - b.level);
  const byLevel = {};
  for (const r of bondRows) {
    (byLevel[r.level] = byLevel[r.level] ?? []).push(r);
  }
  const ladder = Object.keys(byLevel).sort().map((lv) => {
    const g = byLevel[lv];
    const avg = (f) => {
      const v = g.map(f).filter((x) => x != null);
      return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null;
    };
    const vs = g.map((x) => x.valence).filter((x) => x != null);
    const m = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0;
    const sd = vs.length ? Math.sqrt(vs.reduce((s, x) => s + (x - m) ** 2, 0) / vs.length) : 0;
    return {
      level: +lv, pairs: g.length,
      meanSpoken: Math.round(avg((x) => x.spoken) ?? 0),
      meanValence: avg((x) => x.valence),
      sdValence: +sd.toFixed(3),
      minValence: vs.length ? +Math.min(...vs).toFixed(2) : null,
      maxValence: vs.length ? +Math.max(...vs).toFixed(2) : null,
      meanArousal: avg((x) => x.arousal),
      _members: g.map((x) => x.advId),
    };
  });

  /* Lv1 -> Lv3 的效价变化：不是统一升温，而是分流 */
  const pairV = {};
  for (const r of bondRows) (pairV[r.pair] = pairV[r.pair] ?? {})[r.level] = r.valence;
  const deltas = Object.entries(pairV)
    .map(([pair, g]) => ({ pair, from: g[1] ?? null, to: g[3] ?? null, delta: +(((g[3] ?? 0) - (g[1] ?? 0))).toFixed(3) }))
    .filter((x) => x.from != null && x.to != null)
    .sort((a, b) => a.delta - b.delta);
  const trend = {
    _note: '阈值 ±0.05。升温 = 关系确认/更亲密；降温 = 深入后暴露裂痕或沉重真相。',
    升温: deltas.filter((x) => x.delta > 0.05).length,
    持平: deltas.filter((x) => Math.abs(x.delta) <= 0.05).length,
    降温: deltas.filter((x) => x.delta < -0.05).length,
    deltas,
  };

  const data = {
    episode_structure: structure,
    episode_beats: { _note: '节拍按话内带标签台词四等分；钩子为规则初判（conf），可在 json 修订。', episodes: beats },
    episode_cast: { _note: 'key 用上游 model 名，保留舞台人格差异。', cast, cooc: coPairs, lead: [...leadOf.entries()].map(([advId, v]) => ({ advId, ...v })) },
    bond_ladder: { _note: '羁绊剧 50 对 × 3 级。', ladder, trend, rows: bondRows },
  };

  if (DRY || ONLY === '数据') {
    console.log(`\n[数据] 主线 ${structure.total} 话（本篇 ${structure.本篇} / 番外 ${structure.番外}）`);
    console.log(`[数据] 节拍 ${beats.length} 话 ｜ 角色 ${cast.length} ｜ 共演对 ${coPairs.length} ｜ 羁绊 ${bondRows.length} 剧 / ${new Set(bondRows.map((r) => r.pair)).size} 对`);
    for (const l of ladder) console.log(`  Lv${l.level}: ${l.pairs} 对  均台词 ${l.meanSpoken}  均效价 ${l.meanValence}  均唤醒 ${l.meanArousal}`);
  }

  if (ONLY === '数据') {
    for (const [k, v] of Object.entries(data)) {
      const p = join(DATA, `${k}.json`);
      if (!DRY) { mkdirSync(DATA, { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 1), 'utf8'); }
      console.log(`  → _data/${k}.json`);
    }
    console.log(`\n完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    return;
  }

  /* ---- 渲染 md ---- */
  console.log('\n[渲染]');
  renderReadme(data);
  renderStructure(data);
  renderBeats(data);
  renderCast(data);
  renderBond(data);

  for (const [k, v] of Object.entries(data)) {
    if (!DRY) { mkdirSync(DATA, { recursive: true }); writeFileSync(join(DATA, `${k}.json`), JSON.stringify(v, null, 1), 'utf8'); }
  }
  console.log(`\n完成（${((Date.now() - t0) / 1000).toFixed(1)}s）新建/更新 ${updated}，跳过 ${skipped}`);
}

/* ---------------- 渲染：README ---------------- */
function renderReadme(d) {
  const s = d.episode_structure;
  const L = [];
  L.push('# 话层分析');
  L.push('');
  L.push('> 生成于 ' + stamp() + ' ｜ 生成器 `工具/build_episode_analysis.mjs`');
  L.push('');
  L.push('以「话（episode）」为分析单元的四层产出。范围：**主线 109 话 + 羁绊剧情 150 话**。');
  L.push('');
  L.push('| 层 | 文件 | 说明 |');
  L.push('|---|---|---|');
  L.push('| 篇章结构 | [篇章结构.md](篇章结构.md) | 官方剧本名还原的分章：本篇 100 + 番外 9 |');
  L.push('| 话内节拍 | [话内节拍.md](话内节拍.md) | 每话四段情绪、峰值位置、结尾句与钩子 |');
  L.push('| 主导与共演 | [主导与共演.md](主导与共演.md) | 谁主导这一话、登场跨度、共演矩阵 |');
  L.push('| 羁绊阶梯 | [羁绊阶梯.md](羁绊阶梯.md) | 50 对 × 3 级的关系递进模板 |');
  L.push('| 羁绊态度 | [羁绊态度.md](羁绊态度.md) | 羁绊剧拆成 100 个**方向**：X 怎么看 Y（称呼/关注率/情绪偏移） |');
  L.push('| 非主线 | [非主线.md](非主线.md) | 支线 25 剧（乐曲故事）+ 碎片 660 剧：前者逐条分析，后者只统计说话人 |');
  L.push('');
  L.push('另有 [角色模型/_动作指纹.md](../角色模型/_动作指纹.md) —— 演出层「动作（mtn\_\*）」这一半，按词根算富集度。');
  L.push('');
  L.push('## 口径');
  L.push('');
  L.push(`- 主线 **${s.total}** 话 = 本篇 **${s.本篇}** 话 + 番外 **${s.番外}** 话。`);
  L.push('- 效价／唤醒的定义见 [剧情分析/情绪曲线.md](../剧情分析/情绪曲线.md) 的术语节；极性表在 `_data/emotion_polarity.json`（人工判定，改表即改结论）。');
  L.push('- 角色 key 一律用上游 model 名，**不按叙事身份归并** —— `mortis` 与 `mutsumi` 分开统计。');
  L.push('- 钩子类型是**规则初判**，json 里带 `conf`，可人工修订。');
  L.push('');
  L.push('<!-- USER:START 总体判断 -->');
  L.push('<!-- 写在这里：读完四层后，你对"这一话是怎么构成的"的整体结论。重跑生成不会覆盖本块 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  writeFile('README.md', L.join('\n'));
}

/* ---------------- 渲染：篇章结构 ---------------- */
function renderStructure(d) {
  const s = d.episode_structure;
  const L = [];
  L.push('# 篇章结构');
  L.push('');
  L.push('> 生成于 ' + stamp());
  L.push('');
  L.push('## 为什么这一层要单独做');
  L.push('');
  L.push('官方剧本名自带篇章信息，格式 `adv_script_{bandkey}_{编号}_1_{话序}`，带 `exstory` 段的是番外：');
  L.push('');
  L.push('```');
  L.push('adv_script_mygo_001_1_01        -> MyGO 本篇 第 1 话   (advId 10000)');
  L.push('adv_script_mygo_001_exstory_1_01 -> MyGO 番外 第 1 话  (advId 10100)');
  L.push('```');
  L.push('');
  L.push(`主线共 **${s.total}** 话，按官方分章是 **本篇 ${s.本篇} + 番外 ${s.番外}**，不是 109 话一条直线。`);
  L.push('');
  L.push('这解释了此前记录的一条警告 —— 「advId 顺序 ≠ 剧情顺序」：');
  L.push('真因不是 MyGO 与 Ave 时间上穿插，而是 **advId 的 101xx 段（10100–10108）是番外**，压根不是本篇的延续。');
  L.push('');
  L.push('## 五队分章');
  L.push('');
  L.push('| 乐队 | 编号 | bandKey | 本篇 | 番外 | advId 区间 |');
  L.push('|---|---:|---|---:|---:|---|');
  for (const b of s.bands) {
    L.push(`| ${b.label} | ${String(b.bandNo).padStart(3, '0')} | \`${b.bandKey}\` | ${b.本篇} | ${b.番外 || '—'} | ${b.range[0]}–${b.range[1]} |`);
  }
  L.push('');
  const noEx = s.bands.filter((b) => !b.番外);
  if (noEx.length) {
    L.push(`⚠️ **${noEx.map((b) => b.label).join(' 与 ')} 没有番外** —— 只有 MyGO / Ave Mujica / 梦限大MewType 三条线有 exstory。`);
    L.push('');
  }
  L.push('## 番外与本篇不是同一种东西');
  L.push('');
  L.push('| 指标 | 本篇 100 话 | 番外 9 话 |');
  L.push('|---|---:|---:|');
  const b = d.episode_beats.episodes;
  const grp = (p) => b.filter((x) => x.part === p && x.meanValence != null);
  const avg = (a, f) => a.length ? +(a.reduce((s, x) => s + f(x), 0) / a.length).toFixed(3) : null;
  const g1 = grp('本篇'), g2 = grp('番外');
  L.push(`| 均效价 | ${avg(g1, (x) => x.meanValence)} | ${avg(g2, (x) => x.meanValence)} |`);
  L.push(`| 平均台词量 | ${Math.round(avg(g1, (x) => x.spoken))} | ${Math.round(avg(g2, (x) => x.spoken))} |`);
  L.push(`| 平均说话人数 | ${avg(g1, (x) => x.speakers ?? 0) ?? '—'} | ${avg(g2, (x) => x.speakers ?? 0) ?? '—'} |`);
  L.push('');
  L.push('> 篇幅不到一半、情绪由负转正 —— 番外是后日谈性质，**不能和本篇混在同一条曲线上比转折点**。');
  L.push('');
  L.push('## 逐话清单');
  L.push('');
  L.push('| advId | 乐队 | 篇章 | 话序 | 标题（官方简中） | 日文原标题 | 剧本名 |');
  L.push('|---:|---|---|---:|---|---|---|');
  for (const e of s.episodes) {
    L.push(`| ${e.advId} | ${e.label} | ${e.part} | ${e.seq} | ${e.title} | ${e.titleJa || '—'} | \`${e.script}\` |`);
  }
  L.push('');
  L.push('<!-- USER:START 篇章判断 -->');
  L.push('<!-- 写在这里：番外与本篇的读法差异，以及这对既有剧情分析意味着什么。重跑生成不会覆盖本块 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  writeFile('篇章结构.md', L.join('\n'));
}

/* ---------------- 渲染：话内节拍 ---------------- */
function renderBeats(d) {
  const eps = d.episode_beats.episodes.filter((x) => x.segments);
  const L = [];
  L.push('# 话内节拍与钩子');
  L.push('');
  L.push('> 生成于 ' + stamp());
  L.push('');
  L.push(`把每话的带标签台词按句序**四等分**，分别算效价与唤醒 —— 得到这一话的「开场 / 推进 / 转折 / 收束」四段。`);
  L.push(`共 **${eps.length}** 话参与（无标签话已排除）。`);
  L.push('');
  L.push('## 峰值落在哪一段');
  L.push('');
  L.push('峰段 = 四段中 |效价| 最大的一段；谷段 = 效价最低的一段。这直接反映**一话的高潮位置**。');
  L.push('');
  const cnt = { peak: {}, low: {} };
  for (const e of eps) {
    cnt.peak[e.peakSeg] = (cnt.peak[e.peakSeg] ?? 0) + 1;
    cnt.low[e.lowSeg] = (cnt.low[e.lowSeg] ?? 0) + 1;
  }
  L.push('| 段 | 作为峰段的话数 | 作为谷段的话数 |');
  L.push('|---:|---:|---:|');
  for (let i = 1; i <= 4; i++) {
    L.push(`| 第 ${i} 段 | ${cnt.peak[i] ?? 0} | ${cnt.low[i] ?? 0} |`);
  }
  L.push('');
  const peakSeg = Object.entries(cnt.peak).sort((a, b) => b[1] - a[1])[0];
  const lowSeg = Object.entries(cnt.low).sort((a, b) => b[1] - a[1])[0];
  L.push(`峰段最常落在**第 ${peakSeg[0]} 段**（${peakSeg[1]} 话），谷段最常落在**第 ${lowSeg[0]} 段**（${lowSeg[1]} 话）。`);
  L.push('');
  L.push('## 结尾句与钩子类型');
  L.push('');
  L.push('钩子按结尾句特征规则初判（`conf` 见 json，可修订）：静默收束 / 疑问悬置 / 言语未尽 / 压抑收尾 / 明朗收尾 / 平收。');
  L.push('');
  const hk = {};
  for (const e of eps) if (e.closer) hk[e.closer.hook] = (hk[e.closer.hook] ?? 0) + 1;
  L.push('| 钩子类型 | 话数 | 占比 |');
  L.push('|---|---:|---:|');
  for (const [k, v] of Object.entries(hk).sort((a, b) => b[1] - a[1])) {
    L.push(`| ${k} | ${v} | ${((v / eps.length) * 100).toFixed(1)}% |`);
  }
  L.push('');
  L.push('## 接钩：本话结尾 → 下一话开场');
  L.push('');
  L.push('同一乐队同一篇章内，下一话开场效价减去本话结尾效价。负得多 = 断崖式切换，接近 0 = 平滑延续。');
  L.push('');
  const h = eps.filter((x) => x.handoff).sort((a, b) => a.handoff.delta - b.handoff.delta);
  L.push('| advId | 标题 | 结尾效价 | 下一话 | 开场效价 | 落差 |');
  L.push('|---:|---|---:|---:|---:|---:|');
  for (const e of h.slice(0, 8)) {
    L.push(`| ${e.advId} | ${e.title}${e.titleJa ? `<br><sub>${e.titleJa}</sub>` : ''} | ${e.endValence} | ${e.handoff.next} | — | ${e.handoff.delta} |`);
  }
  L.push('');
  L.push('## 逐话节拍');
  L.push('');
  L.push('| advId | 篇章 | 标题 | 一段 | 二段 | 三段 | 四段 | 峰段 | 结尾效价 | 收尾人 | 钩子 |');
  L.push('|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|');
  for (const e of eps) {
    const s = e.segments.map((x) => x.valence ?? '—');
    L.push(`| ${e.advId} | ${e.part} | ${e.title}${e.titleJa ? `<br><sub>${e.titleJa}</sub>` : ''} | ${s[0]} | ${s[1]} | ${s[2]} | ${s[3]} | ${e.peakSeg} | ${e.endValence ?? '—'} | ${e.closer?.zh ?? '—'} | ${e.closer?.hook ?? '—'} |`);
  }
  L.push('');
  L.push('<!-- USER:START 节拍判断 -->');
  L.push('<!-- 写在这里：这一话的"配方"是什么 —— 开场怎么起、高潮在哪、怎么收。重跑生成不会覆盖本块 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  writeFile('话内节拍.md', L.join('\n'));
}

/* ---------------- 渲染：主导与共演 ---------------- */
function renderCast(d) {
  const c = d.episode_cast;
  const L = [];
  L.push('# 主导度与共演矩阵');
  L.push('');
  L.push('> 生成于 ' + stamp());
  L.push('');
  const inBook = c.cast.filter((x) => x.kbId);
  const npc = c.cast.filter((x) => !x.kbId);
  L.push(`主线共 **${c.cast.length}** 个演出模型参与：在册角色 **${inBook.length}**，其余 ${npc.length} 个是一次性 NPC`);
  L.push(`（其中 ${npc.filter((x) => x.episodes === 1).length} 个只在一话出现）。下表只列在册角色与台词 ≥ 20 句的 NPC。`);
  L.push('');
  L.push('## 谁主导这一话');
  L.push('');
  L.push('主导者 = 该话台词最多的模型。按主导次数排序。');
  L.push('');
  L.push('> ⚠ 「首次 / 最后」是 **advId 的最小值与最大值**，只表示出场范围。');
  L.push('> 跨乐队登场的角色（如祥子 10000–10105）跨度大，不代表剧情时序 —— advId 顺序 ≠ 剧情顺序。');
  L.push('');
  const lead = [...c.cast].sort((a, b) => b.leads - a.leads).filter((x) => x.leads > 0);
  L.push('| 角色 | 主导话数 | 总台词 | 登场话数 | 首次 | 最后 |');
  L.push('|---|---:|---:|---:|---:|---:|');
  for (const x of lead.slice(0, 25)) {
    L.push(`| ${x.zh}（\`${x.id}\`） | ${x.leads} | ${x.lines} | ${x.episodes} | ${x.first} | ${x.last} |`);
  }
  L.push('');
  L.push('## 在册角色台词量');
  L.push('');
  L.push('| 角色 | 总台词 | 登场话数 | 首次 | 最后 |');
  L.push('|---|---:|---:|---:|---:|');
  for (const x of inBook) {
    L.push(`| ${x.zh}（\`${x.id}\`） | ${x.lines} | ${x.episodes} | ${x.first} | ${x.last} |`);
  }
  L.push('');
  const bigNpc = npc.filter((x) => x.lines >= 20).sort((a, b) => b.lines - a.lines);
  if (bigNpc.length) {
    L.push('## 戏份较重的 NPC');
    L.push('');
    L.push(`台词 ≥ 20 句的 NPC 共 ${bigNpc.length} 个（其余 ${npc.length - bigNpc.length} 个戏份零星）。`);
    L.push('');
    L.push('| 模型名 | 总台词 | 登场话数 | 首次 | 最后 |');
    L.push('|---|---:|---:|---:|---:|');
    for (const x of bigNpc) {
      L.push(`| \`${x.id}\` | ${x.lines} | ${x.episodes} | ${x.first} | ${x.last} |`);
    }
    L.push('');
  }
  L.push('## 共演最多的组合');
  L.push('');
  const kbp = c.cooc.filter((p) => p.aKb && p.bKb);
  L.push(`在册角色之间共 **${kbp.length}** 对同台过（含 NPC 的组合共 ${c.cooc.length} 对）。取前 30。`);
  L.push('');
  L.push('| A | B | 同台话数 |');
  L.push('|---|---|---:|');
  for (const p of kbp.slice(0, 30)) {
    L.push(`| ${p.aZh}（\`${p.a}\`） | ${p.bZh}（\`${p.b}\`） | ${p.n} |`);
  }
  L.push('');
  L.push('<!-- USER:START 共演判断 -->');
  L.push('<!-- 写在这里：谁和谁从没同台、谁的组合被刻意错开。重跑生成不会覆盖本块 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  writeFile('主导与共演.md', L.join('\n'));
}

/* ---------------- 渲染：羁绊阶梯 ---------------- */
function renderBond(d) {
  const bd = d.bond_ladder;
  const L = [];
  L.push('# 羁绊剧：好感度阶梯');
  L.push('');
  L.push('> 生成于 ' + stamp());
  L.push('');
  const pairs = new Set(bd.rows.map((r) => r.pair));
  L.push(`羁绊剧情是**结构最规整**的一类剧：**${pairs.size} 对角色 × 3 级 = ${bd.rows.length} 话**，剧本名 `);
  L.push('`adv_script_{A}_{B}_linkstory_{1,2,3}`。它正对 light-novel-creator §3 的 Galgame 好感度模式 —— ');
  L.push('每一级就是一级好感度台阶。');
  L.push('');
  L.push('> ⚠ **定位修正**：羁绊剧记的不是「亲密度刻度」，而是**态度信息** —— 同一对里，');
  L.push('> A 怎么看 B 和 B 怎么看 A 常常不是一回事。本文件只讲**关系的走向**（升温/持平/降温），');
  L.push('> 分方向的态度（称呼、关注率、提到对方时的情绪偏移）见 [羁绊态度.md](羁绊态度.md)。');
  L.push('');
  L.push('## 三级台阶的情绪走向');
  L.push('');
  L.push('| 级别 | 对数 | 平均台词 | 均效价 | 标准差 | 最负 | 最正 | 均唤醒 |');
  L.push('|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const l of bd.ladder) {
    L.push(`| Lv${l.level} | ${l.pairs} | ${l.meanSpoken} | ${l.meanValence} | ${l.sdValence} | ${l.minValence} | ${l.maxValence} | ${l.meanArousal} |`);
  }
  L.push('');
  const t = bd.trend;
  if (t) {
    L.push(`**三级均值几乎不动**（${bd.ladder.map((l) => l.meanValence).join(' / ')}），但**逐对走向是分流的**：`);
    L.push('');
    L.push('| Lv1 → Lv3 效价变化 | 对数 |');
    L.push('|---|---:|');
    L.push(`| 升温（> +0.05） | ${t.升温} |`);
    L.push(`| 持平（±0.05 内） | ${t.持平} |`);
    L.push(`| 降温（< −0.05） | ${t.降温} |`);
    L.push('');
    L.push('> 升温与降温几乎各占一半 —— **羁绊升级不是「感情变好」，而是「关系变真」**：');
    L.push('> 一半的组合在 Lv3 确认了关系，另一半在深入后暴露裂痕或沉重真相。');
    L.push('> 这与 Galgame 好感度单调升温的直觉相反，是本作羁绊剧的实际写法。');
    L.push('');
    L.push('### 降温最多 / 升温最多');
    L.push('');
    L.push('| 组合 | Lv1 | Lv3 | 变化 |');
    L.push('|---|---:|---:|---:|');
    for (const x of t.deltas.slice(0, 6)) L.push(`| ${x.pair} | ${x.from} | ${x.to} | ${x.delta} |`);
    L.push('| … | | | |');
    for (const x of t.deltas.slice(-6).reverse()) L.push(`| ${x.pair} | ${x.from} | ${x.to} | +${x.delta} |`);
    L.push('');
  }
  L.push('## 逐对明细');
  L.push('');
  L.push('| 组合 | Lv1 效价 | Lv2 效价 | Lv3 效价 | Lv1 台词 | Lv3 台词 | 走向 |');
  L.push('|---|---:|---:|---:|---:|---:|---|');
  const byPair = {};
  for (const r of bd.rows) (byPair[r.pair] = byPair[r.pair] ?? {})[r.level] = r;
  for (const [pair, g] of Object.entries(byPair).sort((a, b) => a[0].localeCompare(b[0], 'ja'))) {
    const v = (lv) => g[lv]?.valence ?? '—';
    const s = (lv) => g[lv]?.spoken ?? '—';
    const nums = [1, 2, 3].map((lv) => g[lv]?.valence).filter((x) => x != null);
    let trend = '—';
    if (nums.length === 3) trend = nums[2] > nums[0] + 0.05 ? '升温' : nums[2] < nums[0] - 0.05 ? '降温' : '持平';
    L.push(`| ${pair} | ${v(1)} | ${v(2)} | ${v(3)} | ${s(1)} | ${s(3)} | ${trend} |`);
  }
  L.push('');
  L.push('<!-- USER:START 阶梯判断 -->');
  L.push('<!-- 写在这里：Lv1/2/3 各自承担什么叙事功能 —— 破冰、冲突还是确认。重跑生成不会覆盖本块 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  writeFile('羁绊阶梯.md', L.join('\n'));
}

/* ---------------- 自检 ---------------- */
if (CHECK) {
  let ok = true;
  const need = ['episode_structure.json', 'episode_beats.json', 'episode_cast.json', 'bond_ladder.json'];
  for (const f of need) {
    const p = join(DATA, f);
    if (!existsSync(p)) { console.log(`✗ 缺 _data/${f}`); ok = false; continue; }
    JSON.parse(readFileSync(p, 'utf8'));
  }
  for (const f of ['README.md', '篇章结构.md', '话内节拍.md', '主导与共演.md', '羁绊阶梯.md']) {
    if (!existsSync(join(OUT, f))) { console.log(`✗ 缺 ${f}`); ok = false; }
  }
  const st = JSON.parse(readFileSync(join(DATA, 'episode_structure.json'), 'utf8'));
  if (st.本篇 !== 100 || st.番外 !== 9) { console.log(`✗ 篇章数不对：本篇 ${st.本篇} / 番外 ${st.番外}`); ok = false; }
  const bl = JSON.parse(readFileSync(join(DATA, 'bond_ladder.json'), 'utf8'));
  if (bl.rows.length !== 150) { console.log(`✗ 羁绊剧数 ${bl.rows.length} ≠ 150`); ok = false; }
  console.log(ok ? '✓ 话层分析自检通过' : '✗ 话层分析自检失败');
  process.exit(ok ? 0 : 1);
}

main();
