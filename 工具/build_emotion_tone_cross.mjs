#!/usr/bin/env node
/**
 * 语气 × 感情 交叉层 —— 把「怎么说话」和「什么情绪」两张表接起来
 *
 * 缺口背景：
 *   角色模型/指纹/   47 份 —— 角色怎么说话（句长/省略号/疑问/感叹…）
 *   角色模型/_演出指纹.md —— 每句话的官方表情标签
 *   这两条线此前互不引用，问「灯难过时会怎么说话」答不出来。本脚本补这一层。
 *
 * 用法：
 *   node 工具/build_emotion_tone_cross.mjs            # 算 + 渲染 + 注入角色模型
 *   node 工具/build_emotion_tone_cross.mjs --check    # 自检（比对上游）
 *   node 工具/build_emotion_tone_cross.mjs --dry      # 只打印不落盘
 *   node 工具/build_emotion_tone_cross.mjs --show 灯   # 打印某角色的交叉明细
 *   node 工具/build_emotion_tone_cross.mjs --no-inject # 不回写角色扮演模型
 *
 * 产出：
 *   资料库/_emotion_tone_cross.json     真源
 *   角色模型/_语气感情交叉.md            汇总报告（数字全注入）
 *   角色模型/<队>/<短名>_<全名>_角色扮演模型.md  → §3 末尾追加 AUTO 块（幂等）
 *
 * 口径（改动前务必读完）：
 *   ① 语料是 _emotion_lines.jsonl 的**日文原文**，不是中文翻译。
 *      句长 = 去空白后的日文字面字符数 —— 与 角色模型/指纹/ 的「纯汉字数」**不可直接比较**。
 *      本表的正确用法是**组内自比**（同一角色组内 某情绪 vs 该角色自己的基线），
 *      不是拿绝对数字去和中文指纹表对齐。
 *   ② **Δ = 该角色在某情绪下的指标 − 该角色自己的全局基线**。
 *      这样天然排除「她天生话少 / 天生省略号多」的混淆，读出来的是**这一刻的变化**。
 *   ③ 情绪按 voca.base 词根聚合（sad / idle / smile…），原始标签带编号粒度太细。
 *   ④ 最小样本：角色带标签 ≥ MIN_CHAR(80) 句，且该情绪在他身上 ≥ MIN_EXP(10) 句才出一行。
 *   ⑤ ⚠ Δ 是**描述性统计，不是显著性检验**。多数格子只有 10~80 句，
 *      一次篮球社的感叹就能左右它。结论要回 json 看 n 再下判断。
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
const KB = join(ROOT, '资料库', 'kb.json');
const OUT_JSON = join(ROOT, '资料库', '_emotion_tone_cross.json');
const OUT_MD = join(ROOT, '角色模型', '_语气感情交叉.md');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f, dflt) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) : dflt; };
const MIN_CHAR = argOf('--min', 80);
const MIN_EXP = argOf('--minexp', 10);

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const stripTs = (s) => s.replace(/^> 生成于.*$/m, '');

/* ---------- USER 块保留（与 build_novel_env / build_motion_profile 同纪律） ---------- */
const USER_RE = /<!-- USER:START ([^>]+?) -->\n([\s\S]*?)<!-- USER:END -->/g;
const AUTO_RE = /<!-- AUTO:START ([^>]+?) -->[\s\S]*?<!-- AUTO:END -->/g;
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

/* ---------- 语气指标（日文原文口径，六项） ---------- */
const RE_ELL = /…/;
const RE_ELLEND = /…$/;
const RE_Q = /[?？]/;
const RE_EX = /[!！]/;
const RE_SILENT = /^[…\s、，。？！?★♪]*$/;

/** 纯沉默：整句剔掉标点后没有实质内容，且确实含 …（与 fingerprint_full.isSilent 同精神） */
const isSilent = (s) => RE_SILENT.test(s) && RE_ELL.test(s);
const clean = (s) => s.replace(/[\s\u3000]/g, '');

function measure(list) {
  const texts = list.map((o) => o.text ?? '');
  const n = texts.length;
  if (!n) return null;
  const lens = texts.map((t) => clean(t).length).filter((x) => x > 0);
  const c = (re) => texts.filter((t) => re.test(t)).length;
  const sil = texts.filter(isSilent).length;
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  return {
    n,
    withText: lens.length,
    len: Math.round(mean * 100) / 100,
    ell: Math.round((c(RE_ELL) / n) * 1000) / 10,
    ellEnd: Math.round((c(RE_ELLEND) / n) * 1000) / 10,
    q: Math.round((c(RE_Q) / n) * 1000) / 10,
    ex: Math.round((c(RE_EX) / n) * 1000) / 10,
    silent: Math.round((sil / n) * 1000) / 10,
  };
}

/** 两组作差：只用切换号的六级差集 */
const METRICS = [
  ['len', '均长'],
  ['ell', '省略号率'],
  ['ellEnd', '…结尾率'],
  ['q', '疑问率'],
  ['ex', '感叹率'],
  ['silent', '纯沉默率'],
];
const delta = (m, base) => {
  if (!m || !base) return null;
  const d = {};
  for (const [k] of METRICS) d[k] = Math.round((m[k] - base[k]) * 100) / 100;
  return d;
};

/* ---------- 数据 ---------- */
function load() {
  const lines = readFileSync(LINES, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const vocab = JSON.parse(readFileSync(VOCAB, 'utf8'));
  const fp = JSON.parse(readFileSync(FP, 'utf8'));
  const kb = JSON.parse(readFileSync(KB, 'utf8'));
  return { lines, vocab, fp, kb };
}

/* base → 中文释义：取该词根频次最高那条，与 build_motion_profile.buildZh 同法 */
function expZh(vocab) {
  const zh = new Map();
  const best = new Map();
  for (const [k, v] of Object.entries(vocab.exp ?? {})) {
    const b = v.base ?? String(k).replace(/^exp_/, '').replace(/[0-9]+$/, '');
    if (!best.has(b) || v.n > best.get(b).n) { best.set(b, v.n); zh.set(b, v.zh ?? b); }
  }
  return zh;
}

function compute() {
  const { lines, vocab, fp, kb } = load();
  const zhMap = expZh(vocab);

  const tagged = lines.filter((o) => o.model && o.exp && typeof o.text === 'string');
  const base = measure(tagged);

  /* 全局：情绪 × 语气 */
  const gGroups = new Map();
  for (const o of tagged) {
    const b = vocab.exp?.[o.exp]?.base ?? String(o.exp).replace(/^exp_/, '').replace(/[0-9]+$/, '');
    if (!gGroups.has(b)) gGroups.set(b, []);
    gGroups.get(b).push(o);
  }
  const global = [];
  for (const [b, list] of gGroups) {
    const m = measure(list);
    if (list.length < MIN_EXP) continue;
    global.push({
      base: b, zh: zhMap.get(b) ?? b, ...m,
      d: delta(m, base),
    });
  }
  global.sort((a, b) => b.n - a.n);

  /* 角色级（按上游 model 名，不按叙事身份归并 —— 演出层同一条纪律） */
  const perModel = new Map();
  for (const o of tagged) {
    if (!perModel.has(o.model)) perModel.set(o.model, { all: [], byExp: new Map() });
    const r = perModel.get(o.model);
    r.all.push(o);
    const b = vocab.exp?.[o.exp]?.base ?? String(o.exp).replace(/^exp_/, '').replace(/[0-9]+$/, '');
    if (!r.byExp.has(b)) r.byExp.set(b, []);
    r.byExp.get(b).push(o);
  }

  /* model → kb 角色（用于找中文名与模型 md 路径） */
  const docByKey = new Map();
  for (const c of kb.characters ?? []) if (c.doc) docByKey.set(c.id, c.doc);

  /* model（上游原始名）→ 所属角色。
     ⚠ 纪律：演出层按**上游 model 名**统计，不按叙事身份归并 —— fp.characters 会把
     mortis 并进 mutsumi、oblivionis 并进 sakiko，直接把这个 promote 掉就抹掉了
     「本体 vs 舞台名」的核心反差。所以这里**只借 meta，不并合»数据行»**，
     mortis 与 mutsumi 各自成一行，只是最后都写进同一份角色扮演模型文档。 */
  const modelMeta = new Map();
  for (const [key, v] of Object.entries(fp.characters ?? {})) {
    if (!v.zh) continue;
    for (const m of v.models ?? [key]) if (!modelMeta.has(m)) modelMeta.set(m, { ...v, __key: key });
  }

  const characters = [];
  for (const [key, r] of perModel) {
    const meta = modelMeta.get(key) ?? null;
    if (r.all.length < MIN_CHAR) continue;
    const own = measure(r.all);
    const rows = [];
    for (const [b, list] of r.byExp) {
      if (list.length < MIN_EXP) continue;
      const m = measure(list);
      const d = delta(m, own);
      if (!d) continue;
      /* 找出最偏离自己基线的那一项，作为「这一幕的特征」 */
      let sig = null;
      for (const [k, label] of METRICS) {
        const scale = k === 'len' ? own.len : 100;
        const rel = Math.abs(d[k]) / Math.max(scale, 0.01);
        if (!sig || rel > sig.rel) sig = { key: k, label, rel: Math.round(rel * 100) / 100 };
      }
      rows.push({ base: b, zh: zhMap.get(b) ?? b, ...m, d, sig });
    }
    rows.sort((a, b) => b.n - a.n);
    characters.push({
      key,
      zh: meta?.zh ?? null,
      short: meta?.short ?? null,
      /* 舞台名标记：游离 model 名 ≠ 该角色的主 key（mortis / oblivionis / amoris / doloris / timoris） */
      isStage: Boolean(meta) && meta.__key !== key,
      ownerKey: meta?.__key ?? key,
      isMain: Boolean(meta?.zh),
      n: r.all.length,
      base: own,
      rows,
    });
  }
  characters.sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) || b.n - a.n);

  return {
    _generated: new Date().toISOString(),
    _source: [LINES, VOCAB, FP, KB],
    _note: `语气×感情交叉。日文原文口径，组内自比 Δ。角色样本 ≥${MIN_CHAR}、情绪样本 ≥${MIN_EXP}。`,
    _warning: 'Δ 为描述性统计，非显著性检验。多数格子 only 10~80 句，下结论前请回 json 看 n。',
    metrics: METRICS.map(([k, label]) => ({ key: k, label })),
    scale: {
      lines: lines.length,
      tagged: tagged.length,
      withText: base.withText,
      expBases: gGroups.size,
      expRows: global.length,
      charRows: characters.filter((c) => c.isMain).length,
    },
    baseline: base,
    global,
    characters,
  };
}

/* ---------- 渲染 ---------- */
const bar = (v, max, width = 18) => {
  const k = Math.max(0, Math.min(width, Math.round((Math.abs(v) / max) * width)));
  const sign = v >= 0 ? '▓' : '░';
  return sign.repeat(Math.max(k, v === 0 ? 0 : 1)) + '·'.repeat(Math.max(width - Math.max(k, v === 0 ? 0 : 1), 0));
};
const sign = (v, unit = '') => (v > 0 ? '+' : '') + v + unit;
const cls = (v, thr) => (v >= thr ? '**' + sign(v) + '**' : String(sign(v)));

function render(d) {
  const L = [];
  L.push('# 语气 × 感情 交叉档案', '');
  L.push('> 本文件由 `node 工具/build_emotion_tone_cross.mjs` **自动生成**，所有数字均为脚本注入，请勿手改。');
  L.push('> 改数据请改上游或改脚本后重跑；情绪中文释义属人工补录，置信度见 `_emotion_vocab.json` 的 `conf`。');
  L.push('');
  L.push(`> 生成于：${stamp()}`, '');

  L.push('## 一、口径（先看这个，否则数字会被误读）', '');
  L.push(`- 语料是 **日文原文**（\`_emotion_lines.jsonl\` 的 \`text\`），共 ${d.scale.lines} 句台词、${d.scale.tagged} 句带表情标签。`);
  L.push(`- **句长 = 去空白后的日文字面字符数**，与 \`角色模型/指纹/\` 的「纯汉字数」**不是同一个口径，不要对着比**。`);
  L.push('  - 正确的用法是**组内自比**：同一角色自己的「悲伤句」 vs 自己的总体基线。');
  L.push('- **Δ = 该角色在某情绪下的指标 − 该角色自己的全局基线**。');
  L.push('  - 这样天然排除了「她天生话少 / 天生省略号多」的混淆，读出来的是**这一刻的变化量**。');
  L.push(`- 情绪按词根聚合（\`sad\` / \`idle\` / \`smile\`…），原始标签带编号粒度太细看不出人。共 ${d.scale.expBases} 个词根。`);
  L.push(`- 最小样本：角色带标签 ≥ **${MIN_CHAR}** 句，且该情绪在他身上 ≥ **${MIN_EXP}** 句，才出一行。`);
  L.push('');
  L.push('> ⚠️ **Δ 是描述性统计，不是显著性检验。** 多数格子只有 10~80 句，一次篮球社的感叹就能左右它。');
  L.push('> 下结论前请回 `资料库/_emotion_tone_cross.json` 看该格的 `n`。', '');
  L.push(`**全局基线**（全体 ${d.scale.tagged} 句带标签台词）：`);
  L.push(`均长 **${d.baseline.len}** ｜ 省略号 **${d.baseline.ell}%** ｜ …结尾 **${d.baseline.ellEnd}%** ｜ 疑问 **${d.baseline.q}%** ｜ 感叹 **${d.baseline.ex}%** ｜ 纯沉默 **${d.baseline.silent}%**`, '');
  L.push('---', '');

  L.push('## 二、全局：什么情绪配什么语气', '');
  L.push('Δ 相对全局基线。这张表回答：**在这个企划里，悲伤句和平静句的写法到底差在哪。**', '');
  L.push('| 情绪 | 句数 | 均长 Δ | 省略号 Δ | …结尾 Δ | 疑问 Δ | 感叹 Δ | 沉默 Δ |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const g of d.global) {
    L.push(`| ${g.zh} \`${g.base}\` | ${g.n} | ${sign(g.d.len)} | ${sign(g.d.ell)} | ${sign(g.d.ellEnd)} | ${sign(g.d.q)} | ${sign(g.d.ex)} | ${sign(g.d.silent)} |`);
  }
  L.push('');

  /* 挑出最鲜明的几个读数 */
  const topDeleg = [...d.global].filter((g) => g.n >= 200).sort((a, b) => b.d.len - a.d.len);
  const shortest = topDeleg[topDeleg.length - 1];
  const longest = topDeleg[0];
  const loudest = [...d.global].filter((g) => g.n >= 200).sort((a, b) => b.d.ex - a.d.ex)[0];
  const quietest = [...d.global].filter((g) => g.n >= 200).sort((a, b) => b.d.silent - a.d.silent)[0];
  L.push('**三个最鲜明的读数**：', '');
  if (longest) L.push(`- 最长的情绪是 **${longest.zh}**（均长 ${longest.len}，比基线 ${sign(longest.d.len)}）；最短的是 **${shortest.zh}**（${shortest.len}，${sign(shortest.d.len)}）。`);
  if (loudest) L.push(`- 感叹号最猛的是 **${loudest.zh}**（${loudest.ex}%，Δ ${sign(loudest.d.ex)}）。`);
  if (quietest) L.push(`- 最容易整句不说话的是 **${quietest.zh}**（纯沉默 ${quietest.silent}%，Δ ${sign(quietest.d.silent)}）。`);
  L.push('');
  L.push('---', '');

  L.push('## 三、逐角色：他的某种情绪会把话说成什么样', '');
  L.push('每张表第一行是他的**全局基线**，后面每行是一种情绪相对他自己基线的变化量。');
  L.push('只看 Δ，不要和别的角色比绝对值。', '');

  const mains = d.characters.filter((c) => c.isMain && c.rows.length);
  for (const c of mains) {
    const tag = c.isStage ? `（舞台态，本体 \`${c.ownerKey}\`）` : '';
    L.push(`### ${c.zh} \`${c.key}\`${tag} —— ${c.n} 句带标签台词`, '');
    L.push(`基线：均长 ${c.base.len} ｜ 省略号 ${c.base.ell}% ｜ …结尾 ${c.base.ellEnd}% ｜ 疑问 ${c.base.q}% ｜ 感叹 ${c.base.ex}% ｜ 沉默 ${c.base.silent}%`, '');
    L.push('');
    L.push('| 情绪 | 句数 | 均长 | 省略号 | …结尾 | 疑问 | 感叹 | 沉默 | 最显著变化 |');
    L.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const r of c.rows.slice(0, 8)) {
      L.push(`| ${r.zh} | ${r.n} | ${r.len} (${sign(r.d.len)}) | ${r.ell}% (${sign(r.d.ell)}) | ${r.ellEnd}% (${sign(r.d.ellEnd)}) | ${r.q}% (${sign(r.d.q)}) | ${r.ex}% (${sign(r.d.ex)}) | ${r.silent}% (${sign(r.d.silent)}) | ${r.sig?.label ?? '—'} ${r.sig ? sign(r.d[r.sig.key]) : ''} |`);
    }
    L.push('');
  }

  L.push('---', '');
  L.push('<!-- USER:START 交叉解读 -->');
  L.push('<!-- 写在这里：哪些「某情绪 → 语气突变」与你对角色的印象吻合或冲突。重跑生成不会覆盖本块。 -->');
  L.push('<!-- USER:END -->');
  return L.join('\n');
}

/* ---------- 回写角色扮演模型：§3 末尾追加 AUTO 块 ----------
   注意：本体与舞台态（mutsumi / mortis）会写进**同一份** md，
   必须按文件合并后一次性落盘，逐个注入会让后者覆盖前者。 */
function renderAutoBody(c) {
  const L = [];
  const who = c.isStage ? `${c.zh} · **舞台态 \`${c.key}\`**` : `**${c.zh}**`;
  L.push(`#### ${who}（${c.n} 句带标签台词）`);
  L.push('');
  L.push(`基线：均长 ${c.base.len} ｜ 省略号 ${c.base.ell}% ｜ 感叹 ${c.base.ex}% ｜ 纯沉默 ${c.base.silent}%`);
  L.push('');
  L.push('| 情绪 | 句数 | 均长 Δ | 省略号 Δ | 感叹 Δ | 沉默 Δ |');
  L.push('|---|---:|---:|---:|---:|---:|');
  for (const r of c.rows.slice(0, 6)) {
    L.push(`| ${r.zh} \`${r.base}\` | ${r.n} | ${sign(r.d.len)} | ${sign(r.d.ell)} | ${sign(r.d.ex)} | ${sign(r.d.silent)} |`);
  }
  L.push('');
  const strongest = [...c.rows].filter((r) => r.n >= 15).sort((a, b) => (b.sig?.rel ?? 0) - (a.sig?.rel ?? 0))[0];
  if (strongest) {
    /* 性别中性：角色档案里有男性 NPC，别写死「她」 */
    const who2 = c.isStage ? `该舞台态` : `${c.zh}`;
    L.push('');
    L.push(`> **最显著的一条**：处于「${strongest.zh}」时，${who2}的 **${strongest.sig.label}** 偏离自身基线 ${sign(strongest.d[strongest.sig.key])}${strongest.sig.key === 'len' ? ' 字' : ' 个百分点'}（n=${strongest.n}）。`);
  }
  L.push('');
  return L.join('\n');
}

function buildAutoBlock(list) {
  const L = [];
  L.push('<!-- AUTO:START 情绪交叉 -->');
  L.push('> 本块由 `node 工具/build_emotion_tone_cross.mjs` 自动注入，每次重跑幂等覆盖。');
  L.push('> 手写内容请写到 `<!-- USER:START -->` 块里。**Δ = 相对该角色（态）自己基线的变化**，日文原文口径。');
  L.push('');
  L.push('### 3.9 情绪对语气的影响（实证交叉）');
  L.push('');
  /* 本体排前、舞台态排后；同档按句数降序 */
  const sorted = [...list].sort((a, b) => (a.isStage ? 1 : 0) - (b.isStage ? 1 : 0) || b.n - a.n);
  for (const c of sorted) L.push(renderAutoBody(c));
  L.push('> ⚠️ Δ 是描述性统计，多数格子 n 只有 10~80 句，别当成硬性规则去卡生成。');
  L.push('<!-- AUTO:END -->');
  return L.join('\n');
}

function inject(kb) {
  const { characters } = kb;
  /* model key → kb 角色 doc 路径。_emotion_fingerprint 的 key 用的是上游 model 名，
     kb 的角色 id 与之多数同名（tomori / anon…），舞台名另行归一。 */
  const byKey = new Map();
  for (const c of characters ?? []) {
    byKey.set(c.id, c);
    for (const a of c.aliases ?? []) if (!byKey.has(a)) byKey.set(a, c);
  }
  let n = 0;
  const miss = [];

  /* 先按目标文件分组：mutsumi 与 mortis 同属一份 md，必须合并成一次写入 */
  const groups = new Map();
  for (const ch of crossData.characters) {
    if (!ch.isMain) continue;
    /* 先按 model 名查（hatsune / sakiko…），查不到再退回它的主人 key
       （mortis → mutsumi、oblivionis → sakiko），保证舞台行也落到正确的文档里 */
    const target = byKey.get(ch.key) ?? byKey.get(ch.ownerKey);
    if (!target?.doc) { miss.push(ch.key); continue; }
    const p = join(ROOT, target.doc);
    if (!existsSync(p)) { miss.push(`${ch.key}(缺文件)`); continue; }
    if (!groups.has(p)) groups.set(p, { doc: target.doc, list: [] });
    groups.get(p).list.push(ch);
  }

  for (const [p, { doc, list }] of groups) {
    const text = readFileSync(p, 'utf8');
    const block = buildAutoBlock(list);
    /* 检测用不带 g 的实例：带 g 的正则 .test() 会记住 lastIndex，连续调用结果会漂 */
    const hasBlock = /* @__PURE__ */ new RegExp(AUTO_RE.source).test(text);
    let next;
    if (hasBlock) {
      /* 已注入过：幂等替换同一个块（整段替换，块内可能含本体+舞台态两节） */
      next = text.replace(AUTO_RE, (all, name) => (name === '情绪交叉' ? block : all));
    } else {
      /* 未注入：插到 §4 之前（即 §3 语言层末尾）；找不到就追加到文末 */
      const anchor = text.search(/\n## 4\. /);
      next = anchor > 0
        ? `${text.slice(0, anchor)}\n${block}\n${text.slice(anchor)}`
        : `${text.replace(/\n+$/, '')}\n\n${block}\n`;
    }
    if (text === next) { console.log(`  = 跳过  ${doc}`); continue; }
    if (!has('--dry')) writeFileSync(p, next, 'utf8');
    console.log(`  ✎ 注入  ${doc}${list.length > 1 ? `（${list.map((x) => x.key).join(' + ')}）` : ''}`);
    n++;
  }
  if (miss.length) console.log(`  ⚠ 未找到模型文档的 key（${miss.length}）：${miss.slice(0, 12).join(' / ')}`);
  return n;
}

/* ---------- main ---------- */
let crossData = null;

function main() {
  if (has('--check')) {
    if (!existsSync(OUT_JSON)) { console.error('[check] 缺产物，请先重跑'); process.exit(1); }
    const cur = JSON.parse(readFileSync(OUT_JSON, 'utf8'));
    if (!cur.global?.length) { console.error('[check] 全局表为空'); process.exit(1); }
    if (cur.scale?.tagged < 20000) { console.error('[check] 带标签句数异常 ' + cur.scale?.tagged); process.exit(1); }
    const fresh = compute();
    const strip = (o) => JSON.stringify({ ...o, _generated: '' });
    if (strip(cur) !== strip(fresh)) { console.error('[check] 内容与上游不一致，需重跑'); process.exit(1); }
    console.log(`[check] 语气×感情交叉 OK：情绪 ${cur.scale.expRows} 类 / 角色 ${cur.scale.charRows} 人 / 带标签 ${cur.scale.tagged} 句`);
    return;
  }

  const d = compute();
  crossData = d;

  if (has('--show')) {
    const want = argv[argv.indexOf('--show') + 1];
    for (const c of d.characters.filter((x) => x.isMain)) {
      if (want && !(c.zh === want || c.key === want)) continue;
      console.log(`\n${c.zh}(${c.key}) n=${c.n}  基线 均长${c.base.len} 省略${c.base.ell}% 感叹${c.base.ex}% 沉默${c.base.silent}%`);
      for (const r of c.rows.slice(0, 8)) {
        console.log(`  ${String(r.zh).padEnd(16)} n=${String(r.n).padStart(3)}  均长${String(r.len).padStart(6)}(${sign(r.d.len)})  省略${String(r.ell).padStart(5)}%(${sign(r.d.ell)})  感叹${String(r.ex).padStart(5)}%(${sign(r.d.ex)})  沉默${String(r.silent).padStart(5)}%(${sign(r.d.silent)})`);
      }
    }
    return;
  }

  if (has('--dry')) {
    console.log(`[dry] 带标签 ${d.scale.tagged} / 情绪 ${d.scale.expRows} 类 / 达标角色 ${d.scale.charRows} 人`);
    if (!has('--no-inject')) inject(JSON.parse(readFileSync(KB, 'utf8')));
    return;
  }

  writeFileSync(OUT_JSON, JSON.stringify(d, null, 1), 'utf8');
  console.log('[语气×感情] 资料库/_emotion_tone_cross.json');
  writeFile('角色模型/_语气感情交叉.md', render(d));
  if (!has('--no-inject')) {
    const kb = JSON.parse(readFileSync(KB, 'utf8'));
    console.log(`[语气×感情] 回写角色扮演模型：`);
    inject(kb);
  }
}

main();
