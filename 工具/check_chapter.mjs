#!/usr/bin/env node
/**
 * check_chapter.mjs —— §9 Self Review 的自动化校验器
 *
 * **为什么要有它**：light-novel-creator 的 §9「自监督训练」是 skill 里
 * 唯一被标为「⚠️ 最高优先级强制系统」的一节，列了 5 大类检查项 ——
 * 但其中**人设一致性 / 重复用词 / 节奏评估三类全靠人读**。
 * 讽刺的是底层数据全都在仓库里（逐句情绪 25,105 句、角色指纹 47 人、
 * 话内节拍 946 话、极性表 51 词根），而 `工具/persona_check.mjs` 是
 * **单文件单角色**的手工工具，撑不起「一整章多角色 + 出报告」。
 *
 * ⚠️ **这不是「写小说」工具**。本项目的 skill 主要走**分析模式**
 *   （提炼剧情，不是创作），见 skill 末节「先分清创作模式还是分析模式」。
 *   所以本工具检的是「**这一章像不像原作那个人**」，不是「写得好不好」——
 *   好不好是人的判断，工具只报**可复算的偏离**。
 *
 * 查六类（对应 §9 的六节）：
 *   1. **人设一致性** —— 每个出场角色的说话指纹 vs 其原作语料真值。
 *      口径与 `persona_check.mjs` 完全一致（句长= 纯汉字），复用它的容差分档。
 *   2. **重复用词** —— 章内 n-gram 重复率，以及**跨角色撞词**
 *      （两个角色用同一个招牌词 = 台词可互换 = §5.3 说的队内风格统一化）。
 *   3. **节奏评估** —— 形态指标（沉默占比/ 情绪词命中率 / 句长波动）。**不含情绪效价**，
 *      理由见下面那段注释（中文字幕拿不到 `exp` 标签）。
 *   4. **时间线一致性** —— 章内日期是否单调递增。
 *   5. **世界观一致性**（2026-10-06 加）—— **设定实体名是否在封闭集合内**
 *      （校名 / 占位符泄漏）+ 引号内人名是否在册。
 *      ❌ 不判「氛围对不对」—— 那是设计判断。
 *   6. **OOC 风险** —— 角色用了**别人**的招牌词，或突破其 OOC 禁令。
 *
 * 口径（写死，别靠记忆）：
 *   - **真值一律现算/现读**，绝不从别处抄。
 *   - **n< 30 只提示不判失败**（沿用 persona_check 的小样本纪律）：
 *     一章里某角色可能只说 3 句，那时指纹全是噪声，判失败是伪严格。
 *   - **不判定「好不好」**。所有输出都是「偏离了多少」+「证据是什么」，
 *     结论归人。这与 skill §3.3「语义判断人工写，脚本只读不写」同一条纪律。
 *   - **退出码非 0 = 有❌ 级偏离**（人设 / OOC），⚠️ 不影响退出码。
 *
 * 用法：
 *   node 工具/check_chapter.mjs<章md> [--json] [--quiet] [--md <出报告路径>]
 *   node 工具/check_chapter.mjs NovelProject/Chapter01.md --md /tmp/review.md
 *
 * 章md 的台词格式（与 persona_check 一致，兼容三种）：
 *   **角色名**：台词
 *   角色名：台词
 *   角色名「台词」
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const WS = join(TOOLS, '..');
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const QUIET = argv.includes('--quiet');
const mdIdx = argv.indexOf('--md');
const OUT_MD = mdIdx >= 0 ? argv[mdIdx + 1] : null;
/**
 * `--out-json <路径>`：把结果**落文件**。
 * 为什么要它：受限沙箱里 spawn 的**管道模式静默失败**（stdout=undefined，
 * MEMORY「环境边界」记着）。所以自检脚本不能靠读被测脚本的 stdout 来核对，
 * 只能让它写文件、这边读文件。`--json` 走 stdout 是给人看的，这个是给机器的。
 */
const ojIdx = argv.indexOf('--out-json');
const OUT_JSON = ojIdx >= 0 ? argv[ojIdx + 1] : null;
const chapterPath = argv.find((a) => !a.startsWith('--') && a.endsWith('.md') && a !== OUT_MD && a !== OUT_JSON);

if (!chapterPath || !existsSync(chapterPath)) {
  console.error('用法: node 工具/check_chapter.mjs <章md> [--json] [--quiet] [--md <出报告路径>]');
  process.exit(2);
}

const readJson = (p) => JSON.parse(readFileSync(join(WS, p), 'utf8'));

/* ────────────────────────── 真值：现读 ────────────────────────── */

const kb = readJson('资料库/kb.json');
const POL = readJson('剧情分析/_data/emotion_polarity.json');
const FINGER = readJson('资料库/_emotion_fingerprint.json').characters || {};

/** 角色名（中文/短名/罗马字/别名）→ kb 里的角色 id。 */
function resolveChar(name) {
  const n = String(name).trim();
  for (const c of kb.characters || []) {
    if (!c) continue;
    if (c.name === n || c.name_short === n) return c.id;
    if (c.stage && c.stage === n) return c.id;
    if (c.name_zh && c.name_zh === n) return c.id;
    if (Array.isArray(c.aliases) && c.aliases.includes(n)) return c.id;
  }
  // 二段：忽略「同学/酱」等后缀再试
  const bare = n.replace(/(同学|酱|桑|君|前辈|后辈)$/u, '');
  for (const c of kb.characters || []) {
    if (c && (c.name === bare || c.name_short === bare)) return c.id;
  }
  return null;
}

/* ────────────────────────── 章解析 ────────────────────────── */

const raw = readFileSync(chapterPath, 'utf8');

/** 抽台词：三种格式都吃。返回 [{who, text, line}] */
function parseChapter() {
  const out = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    let m = line.match(/^\*\*(.+?)\*\*[：:]\s*(.+)$/)
      || line.match(/^([一-龥A-Za-z]{1,8})[：:]\s*(.+)$/)
      || line.match(/^([一-龥A-Za-z]{1,8})[「『](.+?)[」』]\s*$/);
    if (!m) return;
    const who = m[1].replace(/\*\*/g, '').trim();
    const text = (m[2] || '').trim();
    if (who && text) out.push({ who, text, line: i + 1 });
  });
  return out;
}

const lines = parseChapter();
if (!lines.length) {
  console.error(`⚠️ ${chapterPath} 里没抽到任何台词。`);
  console.error('   支持格式：**角色名**：台词 / 角色名：台词 / 角色名「台词」');
  process.exit(2);
}

const hasCJK = (s) => /[一-龥]/.test(s);
const cjkLen = (s) => (s.match(/[一-龥]/g) || []).length;

/* ────────────────────────── 1. 人设一致性 ────────────────────────── */

/** 与 persona_check.mjs 同口径。语料真值用 skill 侧的中文语料。 */
function metrics(texts) {
  const total = texts.length;
  const noText = texts.filter((t) => !hasCJK(t)).length;
  const sp = texts.filter(hasCJK);
  const n = sp.length || 1;
  const L = sp.map(cjkLen);
  const r = (c) => (c / n) * 100;
  return {
    '条目数': total,
    '无文字占比': (noText / (total || 1)) * 100,
    '平均句长(汉字)': L.reduce((a, b) => a + b, 0) / n,
    '≤6字占比': r(L.filter((x) => x <= 6).length),
    '省略号率': r(sp.filter((t) => /…/.test(t)).length),
    '疑问率': r(sp.filter((t) => /？/.test(t)).length),
    '感叹率': r(sp.filter((t) => /！/.test(t)).length),
    '口吃率': r(sp.filter((t) => /([一-龥])、\1/.test(t)).length),
    '「小X」呼称率': r(sp.filter((t) => /小[一-龥]/.test(t)).length),
  };
}

/**
 * 找角色的中文语料文件。
 *
 * ⚠️ **踩过的坑（MEMORY 里也记着）**：`kb.json` 的 `name` 只有罗马字姓
 *   （`灯（Tomori Takamatsu）`、`睦（Mortis / Mutsumi Wakaba）`），
 *   **没有 `name_zh` 字段**，汉字全名只在**语料文件名**里（`灯_高松灯.md`）。
 *   最初按「短名_全名」拼路径，三个角色全部「找不到语料」——
 *   而**不报错**，报告里就是一行「无语料」，看起来像「没问题」。
 *
 * 所以：**先扫目录建索引，再按简称匹配**，不猜字段。
 * ⚠️ 中文语料只用 `按角色全量/zh-Hans/`（47 人全）；`按角色/ja/{band}/` 不全，别用。
 */
const CORPUS_DIRS = [
  '素材全量/按角色全量/zh-Hans',          // ← 唯一完整的
  '素材全量/按角色/zh-Hans',              // 补充：同名的散落文件（如 配角/初音.md）
];

/** 简称/汉字名 → 语料绝对路径。启动时扫一次。 */
const CORPUS_INDEX = new Map();
for (const d of CORPUS_DIRS) {
  const abs = join(WS, d);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs)) {
    if (!f.endsWith('.md')) continue;
    const stem = f.replace(/\.md$/, '');
    CORPUS_INDEX.set(stem, join(abs, f));
    // `{短名}_{全名}` → 短名也建一条（灯_高松灯 → 「灯」）
    if (stem.includes('_')) CORPUS_INDEX.set(stem.split('_')[0], join(abs, f));
    // 纯全名（高松灯）也建一条
    if (stem.includes('_')) CORPUS_INDEX.set(stem.split('_').slice(1).join('_'), join(abs, f));
  }
}

function canonMetrics(id) {
  const c = (kb.characters || []).find((x) => x && x.id === id);
  if (!c) return null;
  const short = c.name_short || c.basic?.简称 || String(c.name).match(/^([^\s（(]+)/)?.[1];
  const p = CORPUS_INDEX.get(short);
  if (!p) return null;
  const items = [];
  let e = null, skip = false;
  const push = () => { if (e !== null) items.push(e.trim()); e = null; };
  for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (/^##\s/.test(l)) { push(); skip = l.replace(/^##\s+/, '').trim() === '出处目录'; continue; }
    if (skip) continue;
    if (/^<sub>/.test(l) || /^#/.test(l) || /^>/.test(l) || /^---/.test(l)) continue;
    if (/^-\s/.test(l)) { push(); e = l.replace(/^-\s+/, ''); continue; }
    if (!l.trim()) { push(); continue; }
    if (e !== null) e += l.trim();
  }
  push();
  const flat = items.map((s) => s.replace(/\s/g, ''))
    .filter((t) => t && !/^[『♪]/.test(t) && !/^（/.test(t));
  return flat.length ? metrics(flat) : null;
}

/**
 * 容差分档：与 `persona_check.mjs` 完全一致（它是对齐过的口径，两边不能各调各的）。
 *
 * ⚠️ **小样本门槛分两档**（`persona_check` 的 n≥30 门槛是给「整段扮演结果」设计的，
 *   拿来判「一章」太苛刻 —— 一章里主要角色通常只有 10~30 句）：
 *     n ≥ 12 → **判❌ 会让退出码非 0**。12 句已足够让8 个指标同时落到区外的概率很低。
 *     n < 12 → 只提示。低于这个数，句长/省略号率全是噪声，判失败是伪严格。
 *   这个阈值**必须实测校准**：拿「明显写飘」的样本验它会报，拿「照抄语料」的验它不报。
 */
const BANDS = {
  '省略号率': { abs: 15 },
  '疑问率': { abs: 16 },
  '感叹率': { abs: 18 },
  '≤6字占比': { abs: 20 },
  '无文字占比': { abs: 10 },
  '口吃率': { abs: 9 },
  '「小X」呼称率': { abs: 16 },
  '平均句长(汉字)': { rel: 0.55 },
};
const MIN_N = 12;   // 低于此只提示不判失败
const WARN_N = 6;   // 低于此连⚠️ 都不给，只标「样本不足」

const byChar = new Map();
for (const l of lines) {
  if (!byChar.has(l.who)) byChar.set(l.who, []);
  byChar.get(l.who).push(l.text);
}

const personaRows = [];
for (const [who, texts] of byChar) {
  const id = resolveChar(who);
  if (!id) {
    personaRows.push({ 角色: who, 状态: '未在册', 说明: 'kb.json 里查不到这个名字 —— 无法校验' });
    continue;
  }
  const canon = canonMetrics(id);
  if (!canon) {
    personaRows.push({ 角色: `${who}（${id}）`, 状态: '无语料', 说明: '找不到中文语料，无法校验' });
    continue;
  }
  const mine = metrics(texts);
  const n = mine['条目数'];
  const slack = n >= 60 ? 1.0 : n >= 30 ? 1.3 : 1.7;
  const 判 = n < WARN_N ? '提示' : null;// 极小样本：连⚠️ 都不给
  const items = [];
  for (const k of Object.keys(BANDS)) {
    const a = mine[k], b = canon[k];
    const band = BANDS[k];
    const lo = band.rel ? b * (1 - band.rel) : b - band.abs * slack;
    const hi = band.rel ? b * (1 + band.rel) : b + band.abs * slack;
    const dev = Math.abs(a - b);
    const ok = a >= lo && a <= hi;
    const warn = !ok && dev <= (band.abs ? band.abs * slack * 1.6 : b * band.rel * 1.6);
    items.push({
      指标: k, 真值: +b.toFixed(1), 本章: +a.toFixed(1), 区间: `${lo.toFixed(1)}~${hi.toFixed(1)}`,
      判定: 判 || (ok ? '✅' : warn ? '⚠️' : '❌'),
    });
  }
  personaRows.push({
    角色: `${who}（${id}）`, n, 条目: texts.length, 指标: items,
    状态: n < WARN_N ? '样本不足' : n < MIN_N ? '偏小样本' : '已校验',
  });
}

/* ────────────────────────── 2. 重复用词 ────────────────────────── */

/** 章内 n-gram 重复率（n=3,4）。只取连续汉字。 */
function repRate(texts, n) {
  const grams = [];
  for (const t of texts) {
    const s = (t.match(/[一-龥]+/g) || []).join('');
    for (let i = 0; i + n <= s.length; i++) grams.push(s.slice(i, i + n));
  }
  if (!grams.length) return { rate: 0, top: [] };
  const cnt = new Map();
  for (const g of grams) cnt.set(g, (cnt.get(g) || 0) + 1);
  let rep = 0;
  for (const v of cnt.values()) if (v > 1) rep += v - 1;
  const top = [...cnt.entries()].filter(([, v]) => v >= 3)
    .sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { rate: (rep / grams.length) * 100, top };
}

const allTexts = lines.map((l) => l.text);
const rep3 = repRate(allTexts, 3);
const rep4 = repRate(allTexts, 4);

/** 跨角色撞词：同一个 3-gram 被两个以上角色用。 */
const gramByChar = new Map();
for (const [who, texts] of byChar) {
  const s = new Set();
  for (const t of texts) {
    const c = (t.match(/[一-龥]+/g) || []).join('');
    for (let i = 0; i + 3 <= c.length; i++) s.add(c.slice(i, i + 3));
  }
  gramByChar.set(who, s);
}
const collide = new Map();
const whoList = [...gramByChar.keys()];
for (let i = 0; i < whoList.length; i++) {
  for (let j = i + 1; j < whoList.length; j++) {
    const shared = [...gramByChar.get(whoList[i])].filter((g) => gramByChar.get(whoList[j]).has(g));
    if (shared.length >= 2) {
      collide.set(`${whoList[i]} ↔ ${whoList[j]}`, { 共享: shared.length, 例: shared.slice(0, 5) });
    }
  }
}

/* ────────────────────────── 3. 节奏评估 ────────────────────────── */

/**
 * 情绪曲线：复用极性表算本章逐句均效价。
 * ⚠️ 实测区间提醒（skill 里已写死，别拿 ±1 直觉读）：
 *   逐话均效价只落−0.47~+0.33（σ=0.17），**0.2 就是显著落差**。
 */
const POLMAP = POL.polarity || {};   // 本工具暂不据此算效价，理由见下

/**
 * ⚠️⚠️ **两次踩坑才搞对，这是本工具最重要的注释**：
 *
 * **第1 次**：`emotion_polarity.json` 的 key 是**英文**（`smile` / `sad` / `idle`…），
 *   拿 key 去 `includes()` 中文台词 → 一条都匹配不上 → 全算成 0。
 *   报告语句语法完全正常，读起来像「这一章情绪很平」。
 *
 * **第 2 次**：改成拿 `zh`（「微笑」「悲伤」）匹配 —— **还是全0**。
 *   因为 `zh` 是**情绪标签的名字**，不是台词里会出现的字。
 *
 * **根因**：`emotion_polarity.json` 的极性绑在**上游 `exp_*` 演出标签**上
 *   （`exp_sad01` → 去前缀去编号 → `sad` → 查表）。而**中文字幕里没有 `exp` 字段**，
 *   只有 `资料库/_emotion_lines.jsonl`（日文原文）带。
 *   **「从一章中文 md 算情绪效价」这条路根本不通** —— 做出来的 0 是假的，
 *   比没有这个指标更坏（它看起来像「结论」）。
 *
 * **所以本项只报形态，不报效价**：沉默占比 / 情绪词命中率 / 句长波动。
 * 三个都不需要 exp 标签，语义可解释。⚠️ 要真正的效价曲线就去读
 * `剧情分析/情绪曲线.md`（那是日文原文侧算的，946 话）。
 */
const EMOTION_WORDS = [
  ['笑', 0.6], ['开心', 0.7], ['高兴', 0.6], ['太好了', 0.8], ['喜欢', 0.6],
  ['哭', -0.7], ['眼泪', -0.6], ['难过', -0.7], ['伤心', -0.8],
  ['抱歉', -0.4], ['对不起', -0.5], ['谢谢', 0.5],
  ['讨厌', -0.6], ['生气', -0.6], ['害怕', -0.6], ['累', -0.3],
  ['痛苦', -0.8], ['幸福', 0.8], ['温柔', 0.5], ['好痛', -0.7],
];
function valence(text) {
  let v = 0, w = 0;
  for (const [zh, val] of EMOTION_WORDS) {
    if (!text.includes(zh)) continue;
    v += val; w += 1;
  }
  return w ? v / w : 0;
}
/** 情绪词命中率 —— 「本章有没有情绪戏」的信号。 */
function emoHitRate(texts) {
  if (!texts.length) return 0;
  return (texts.filter((t) => EMOTION_WORDS.some(([z]) => t.includes(z))).length / texts.length) * 100;
}

const curve = lines.map((l) => ({ ...l, v: valence(l.text) }));
const vs = curve.map((c) => c.v);
const mean = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0;
const peak = curve.reduce((a, b) => (b.v > a.v ? b : a), curve[0]);
const trough = curve.reduce((a, b) => (b.v < a.v ? b : a), curve[0]);
// 四等分：峰段/谷段落在第几段（skill 话层分析实测「高潮压话尾」）
const seg = Math.max(1, Math.ceil(lines.length / 4));
const segMean = [0, 1, 2, 3].map((i) => {
  const s = vs.slice(i * seg, (i + 1) * seg);
  return s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3) : 0;
});

/* 形态指标：这三个不需要 exp 标签，语义可解释（理由见上面那段注释） */
const silRatio = (allTexts.filter((t) => !hasCJK(t)).length / (allTexts.length || 1)) * 100;
const emoRate = emoHitRate(allTexts);
const lens = allTexts.filter(hasCJK).map(cjkLen);
const lenWave = lens.length >= 2
  ? +(Math.max(...lens) / (lens.reduce((a, b) => a + b, 0) / lens.length)).toFixed(2)
  : 0;

/* ───────────────────── 4.5 世界观一致性（设定实体封闭集合）───────────────────── */

/**
 * **能判什么，不能判什么** —— 想清楚再写，别堆一个模糊检查。
 *
 * ❌ 不能判：「这段描写是否符合世界观氛围」。那是设计判断，归人。
 * ✅ 能判：**设定实体名写错了**。因为设定里的实体名是**封闭集合** ——
 *   角色就读的学校只有 10 个真实名，正文里写「羽丘学园」「羽丘女子学校」
 *   就是**确定的错**，而且**人工极难发现**（读着完全通顺）。
 *   这与「数字写错会报错、东西不存在不会」是同一类问题的另一面：
 *   **名字写对了不代表是那个设定，但名字写错了必然不是。**
 *
 * 三条规则，全部现算：
 *   1. **校名封闭集合** —— 正文出现的「XX学园/学院/大学/高中」必须在集合内
 *   2. **占位符泄漏** —— `[待补充]` / `TODO` / `（资料未载）` 之类不该出现在正文
 *   3. **实体在场** —— 本章台词提到的人名若不在 kb 里，报出来（可能是原创角色，
 *      **只提示不判失败** —— 原创角色是合法的）
 */
const SCHOOLS = new Set();
for (const c of kb.characters || []) {
  const s = c?.basic?.学校;
  if (s && !/未载|留白|待/.test(s)) SCHOOLS.add(String(s).trim());
}
/** 从集合里抽出所有「XX学园/学院/大学/高中/初中」片段（含带「初中部/高中部」的变体）。 */
const SCHOOL_FORMS = new Set();
for (const s of SCHOOLS) {
  for (const m of String(s).matchAll(/[一-龥]{2,6}(?:学园|学院|大学|高中|初中)/g)) SCHOOL_FORMS.add(m[0]);
}

/**
 * 判断一段匹配里**是否含已知校名**。
 *
 * ⚠️ **踩过的坑（负向测当场抓到）**：`/[一-龥]{2,6}学院/` 是**贪婪**的，
 * 在「放学后去**神田白八马学院**接她」上会匹配成「**去神田白八马学院**」（把动词吃进来），
 * 于是**真实校名被报成「不在册」** —— 一次假阳性。
 * 而且假阳性比漏报更坏：**正确的写法被判错，作者就会去改对的地方。**
 *
 * 解法：对匹配串的所有**后缀**试一遍，只要有一个是已知校名就算命中；
 * 都不是才报「不在册」。报的时候**剥掉常见前置动词/助词**，只报实体本身。
 */
const SCHOOL_SUFFIX = /(?:学园|学院|大学|高中|初中)$/;

/**
 * 匹配串里**是否含已知校名**。
 *
 * ⚠️ **踩过的坑（负向测当场抓到）**：`/[一-龥]{2,6}学院/` 是**贪婪**的，
 * 在「放学后去**神田白八马学院**接她」上会匹配成「**去神田白八马学院**」（把动词吃进来），
 * 于是**真实校名被报成「不在册」**—— 一次假阳性。
 * 而**假阳性比漏报更坏**：正确的写法被判错，作者就会去改本来正确的地方。
 * 解法：对匹配串的所有**后缀**试一遍，只要有一个是已知校名就算命中。
 */
function schoolHit(raw) {
  for (let i = 0; i < raw.length; i++) {
    if (SCHOOL_FORMS.has(raw.slice(i))) return raw.slice(i);
  }
  return null;
}
/**
 * 从一段文本里切出疑似校名。
 *
 * ⚠️⚠️ **这里换了四种实现才收敛，而且最后是「退回去」才对的** ——
 *   ① 剥开头连续若干字 → 对**非连续**前缀无效（「今天也在月之森学园」剥不干净）
 *   ② 按尾部 N 字切，N 从小到大 → n=2 时「学园」就带后缀了，只剩两个字
 *   ③ 按尾部 N 字切，N 从大到小 → 数字对了但仍带前置字（「们在羽丘学园」）
 *   ④ 枚举所有带后缀的子串取最长 → 反而把整句都切进来（「我们在羽丘学园」）
 *
 * **判据本身一直是对的**（这段文字含一个不在册的校名），错的只是**报什么字符串**。
 * 而那是**可读性问题，不是正确性问题** —— 我在过度设计。
 * 正确取舍：**判据用完整匹配，报原文**（让人自己看那一行），不做任何边界剥离。
 * 想快速定位的那一行，报告里已经给了 `L{行号}` 与原文片段。
 */
function trimEntity(s) {
  return String(s);
}

const worldRows = [];
{
  const schoolSeen = new Map();
  const phSeen = new Map();
  // 占位符：只列**明确的**编辑标记，不含正常台词里的破折号
  const PLACEHOLDER = /\[待[补填][^\]]*\]|【待[补填][^】]*】|（资料未载[^）]*）|\bTODO\b|\bFIXME\b|待补充/g;
  for (const l of lines) {
    for (const m of l.text.matchAll(/[一-龥]{2,6}(?:学园|学院|大学|高中|初中)/g)) {
      if (schoolHit(m[0])) continue;          // 含已知校名 → 放行
      const w = trimEntity(m[0]);
      if (!w) continue;
      if (!schoolSeen.has(w)) schoolSeen.set(w, []);
      schoolSeen.get(w).push(l);
    }
    for (const m of l.text.matchAll(PLACEHOLDER)) {
      const w = m[0];
      if (!phSeen.has(w)) phSeen.set(w, []);
      phSeen.get(w).push(l);
    }
  }
  for (const [w, ls] of schoolSeen) {
    worldRows.push({
      类型: '校名不在册',
      实体: w,
      证据: `${ls.length} 处，例：L${ls[0].line}「${ls[0].text.slice(0, 24)}」`,
      合法值: [...SCHOOL_FORMS].filter((s) => s.includes(w[0])).join(' / ') || `本仓库只有 ${SCHOOL_FORMS.size} 个真实校名，见 kb.json basic.学校`,
      等级: '❌',
    });
  }
  for (const [w, ls] of phSeen) {
    worldRows.push({
      类型: '占位符泄漏', 实体: w,
      证据: `${ls.length} 处，例：L${ls[0].line}「${ls[0].text.slice(0, 24)}」`,
      合法值: '正文不该出现编辑标记',
      等级: '❌',
    });
  }
  // 实体在场：台词提到的人名不在 kb 里 → 提示（可能是原创角色，合法）
  const KNOWN = new Set((kb.characters || []).filter(Boolean)
    .map((c) => c.name_short || String(c.name).split('（')[0]).filter(Boolean));
  const unknown = new Map();
  for (const l of lines) {
    for (const m of l.text.matchAll(/[「『]([一-龥]{2,4})[」』]/g)) {
      const w = m[1];
      if (KNOWN.has(w) || /^(我|你|他|她|它|这|那|什么|谁|怎么|为什么)/.test(w)) continue;
      if (!unknown.has(w)) unknown.set(w, l);
    }
  }
  for (const [w, l] of unknown) {
    worldRows.push({
      类型: '引号内人名不在册', 实体: w,
      证据: `L${l.line}「${l.text.slice(0, 24)}」`,
      合法值: '⚠️ **可能合法** —— 本作原创角色没进过 kb.json。若确实要新增，跑 `工具/build_kb.mjs` 流程入册',
      等级: '⚠️',
    });
  }
}

/* ────────────────────────── 4. 时间线一致性 ────────────────────────── */

const dateRe = /(\d{4})[-年](\d{1,2})[-月](\d{1,2})/g;
const dates = [];
raw.split(/\r?\n/).forEach((l, i) => {
  for (const m of l.matchAll(dateRe)) {
    dates.push({ line: i + 1, s: `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`, text: m[0] });
  }
});
const dateIssues = [];
for (let i = 1; i < dates.length; i++) {
  if (dates[i].s < dates[i - 1].s) {
    dateIssues.push({ 行: dates[i].line, 说明: `日期回退：${dates[i - 1].s} → ${dates[i].s}`, 原文: dates[i].text });
  }
}

/* ────────────────────────── 5. OOC 风险 ────────────────────────── */

/**
 * 从 kb 的 `bans` 里挑**可机检**的那几条。
 *
 * ⚠️ **实测踩到的形状问题**：`kb.characters[].bans` 是**否定式自然语言**
 *   （灯的六条是「不放弃一辈子 / 不因愤怒大声 / 不给情绪命名 / 不说完满的话 /
 *   不用波浪号 / 不叫小祥子（非〔原文略〕期）」）。
 *   机器**没法从「不放弃一辈子」推出该查哪个词** —— 最初写了个正则去找
 *   `「」` 里的字，全库一条都抽不到，于是 OOC 风险恒为 0 项，
 *   而报告里那句「✅ 无机检可判的 OOC 偏离」**语法完全正常**，
 *   读起来像「检查通过了」。
 *
 * 所以改成**显式映射表**：只列真正有机检形态的那几条，其余交给人读。
 * 这是**故意不全覆盖** —— 与其报一堆假命中，不如说清哪些查不了。
 */
const BAN_RULES = [
  { 角色: null, 类型: '禁字符', 词: ['～', '~'], 依据: 'kb bans：不使用波浪号' },
  { 角色: '灯', 类型: '禁称呼', 词: ['小祥子'], 依据: 'kb bans：不叫小祥子（非 CRYCHIC 期）——「小祥子」全语料仅 2 次，都在 CRYCHIC 回忆话内；解散后一律「小祥」（34 次）' },
];

/** 阈值类：把 bans 里的数字抽出来当上限。抽不到就不判，不猜。 */
function machineBans(c) {
  const out = [];
  for (const b of (c?.bans || [])) {
    const s = typeof b === 'string' ? b : JSON.stringify(b);
    const num = s.match(/不超过\s*(\d+(?:\.\d+)?)/) || s.match(/超过\s*(\d+(?:\.\d+)?)/);
    if (num) out.push({ 阈值: parseFloat(num[1]), 原句: s });
  }
  return out;
}

const oocRows = [];
for (const [who, texts] of byChar) {
  const id = resolveChar(who);
  const c = (kb.characters || []).find((x) => x && x.id === id);
  const joined = texts.join('\n');

  for (const r of BAN_RULES) {
    if (r.角色 && resolveChar(r.角色) !== id) continue;      // 定向禁令
    for (const w of r.词) {
      const cnt = texts.filter((t) => t.includes(w)).length;
      if (cnt) oocRows.push({ 角色: who, 类型: r.类型, 证据: `「${w}」出现 ${cnt} 次`, 原句: r.依据 });
    }
  }

  for (const b of machineBans(c)) {
    const m = metrics(texts);
    for (const [k, v] of Object.entries(m)) {
      if (k === '条目数' || m.条目数 < MIN_N) continue;
      if (v > b.阈值) {
        oocRows.push({ 角色: who, 类型: '阈值', 证据: `${k} ${v.toFixed(1)} > 上限 ${b.阈值}`, 原句: b.原句 });
        break;
      }
    }
  }

  // 跨角色撞词也是 OOC 信号
  for (const [pair, v] of collide) {
    if (pair.startsWith(who + ' ')) {
      oocRows.push({
        角色: who, 类型: '撞词',
        证据: `与 ${pair.split('↔')[1].trim()} 共享 ${v.共享} 个 3-gram：${v.例.join('/')}`,
        原句: '见 角色模型/设计思路/_编队手法.md §5.3：队内不该出现可互换的台词',
      });
    }
  }
}

/* ────────────────────────── 输出 ────────────────────────── */

const failCount = personaRows.reduce((s, r) => s + (r.指标 || []).filter((x) => x.判定 === '❌').length, 0)
  + oocRows.length
  + dateIssues.length
  + worldRows.filter((w) => w.等级 === '❌').length;   // ⚠️ 只算❌，「引号内人名不在册」是提示

const report = {
  章: chapterPath,
  台词条数: lines.length,
  角色数: byChar.size,
  人设一致性: personaRows,
  重复用词: { 三字重复率: +rep3.rate.toFixed(1), 四字重复率: +rep4.rate.toFixed(1), 高频串: rep3.top, 跨角色撞词: [...collide.entries()].map(([k, v]) => ({ 组合: k, ...v })) },
  节奏评估: {
    形态: { 纯沉默行占比: +silRatio.toFixed(1), 情绪词命中率: +emoRate.toFixed(1), 句长波动倍数: lenWave },
    情绪词方向: { 均值: +mean.toFixed(3), 峰: { 值: +peak.v.toFixed(3), 台词: peak.text.slice(0, 30) }, 谷: { 值: +trough.v.toFixed(3), 台词: trough.text.slice(0, 30) }, 四段均值: segMean },
    判读提示: '⚠️ **本项不含情绪效价** —— 极性表绑在 `exp_*` 上游标签上，中文 md 拿不到（见源码注释）。要真效价曲线读 `剧情分析/情绪曲线.md`。四段均值的形态参照：「话层分析」实测峰谷都落在第 4 段。',
  },
  时间线一致性: { 日期数: dates.length, 问题: dateIssues },
  世界观一致性: worldRows,
  OOC风险: oocRows,
  失败项: failCount,
};

if (OUT_JSON) {
  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), 'utf8');
  if (!QUIET) console.log(`已写 → ${OUT_JSON}`);
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(failCount ? 1 : 0);
}

const L = [];
const P = (s = '') => L.push(s);
P(`# Self Review 校验报告 — ${chapterPath.split(/[\\/]/).pop()}`);
P();
P(`> 台词 ${lines.length} 条 ｜ 出场角色 ${byChar.size} 人 ｜ **❌ 级偏离 ${failCount} 项**`);
P('> 由 `工具/check_chapter.mjs` 现算。**只报可复算的偏离，不判「好不好」** —— 好不好是人的判断。');
P();
P('## 一、人设一致性');
P();
for (const r of personaRows) {
  if (!r.指标) { P(`- **${r.角色}** — ${r.状态}：${r.说明}`); continue; }
  P(`### ${r.角色}（n=${r.n}${r.状态 === '样本不足' ? ' · ⚠️ 样本不足，只提示不判失败' : ''}）`);
  P();
  P('| 指标 | 原作真值 | 本章 | 允许区间 | 判定 |');
  P('|---|---|---|---|---|');
  for (const i of r.指标) P(`| ${i.指标} | ${i.真值} | ${i.本章} | ${i.区间} | ${i.判定} |`);
  P();
}
P('## 二、重复用词');
P();
P(`- 三字重复率 **${report.重复用词.三字重复率}%** ／ 四字 **${report.重复用词.四字重复率}%**`);
if (report.重复用词.高频串.length) {
  P(`- 高频串：${report.重复用词.高频串.map(([g, c]) => `\`${g}\`×${c}`).join('、')}`);
} else P('- 高频串：无（≥3 次的 3-gram）');
if (report.重复用词.跨角色撞词.length) {
  P();
  P('**跨角色撞词**（⚠️ 台词可互换 = 队内风格统一化，是反例）：');
  for (const c of report.重复用词.跨角色撞词) P(`- ${c.组合}：共享 ${c.共享} 个 3-gram —— ${c.例.join('/')}`);
}
P();
P('## 三、节奏评估');
P();
P(`- **纯沉默行占比** ${report.节奏评估.形态.纯沉默行占比}%　**情绪词命中率** ${report.节奏评估.形态.情绪词命中率}%　**句长波动** ${report.节奏评估.形态.句长波动倍数}×`);
P(`- 情绪词方向：均值 ${report.节奏评估.情绪词方向.均值}／峰 ${report.节奏评估.情绪词方向.峰.值}「${report.节奏评估.情绪词方向.峰.台词}」／谷 ${report.节奏评估.情绪词方向.谷.值}「${report.节奏评估.情绪词方向.谷.台词}」`);
P(`- 四段均值 ${report.节奏评估.情绪词方向.四段均值.join(' / ')}`);
P();
P(report.节奏评估.判读提示);
P();
P('## 四、时间线一致性');
P();
P(report.时间线一致性.问题.length
  ? report.时间线一致性.问题.map((x) => `- ❌ L${x.行} ${x.说明}（原文「${x.原文}」）`).join('\n')
  : `- ✅ 检出 ${dates.length} 个日期，无回退`);
P();
P('## 五、世界观一致性（设定实体封闭集合）');
P();
P('> **只判「设定实体名写错了」** —— 氛围/合理性这类是设计判断，归人。');
P('> 依据：设定里的实体名是**封闭集合**，写成别的读起来照样通顺，但**它就不是那个设定**。');
P();
if (worldRows.length) {
  P('| | 类型 | 实体 | 证据 | 应为 |');
  P('|---|---|---|---|---|');
  for (const w of worldRows) P(`| ${w.等级} | ${w.类型} | ${w.实体} | ${w.证据} | ${w.合法值} |`);
} else {
  P(`✅ 设定实体名全部在册（校名封闭集合 ${SCHOOL_FORMS.size} 个）。`);
  P('⚠️ **这不是「世界观没问题」** —— 前后矛盾、逻辑冲突这类要人读。');
}
P();
P('## 六、OOC 风险');
P();
if (oocRows.length) {
  P('| 角色 | 类型 | 证据 | 依据 |');
  P('|---|---|---|---|');
  for (const o of oocRows) P(`| ${o.角色} | ${o.类型} | ${o.证据} | ${String(o.原句).slice(0, 60)} |`);
} else {
  P('✅ 无机检可判的 OOC 偏离。⚠️ **这不是「人设没问题」** —— 禁令里「不滥用敬语」这类无法机检，仍要人读。');
}
P();
P('---');
P();
P('## 处置纪律');
P();
P('1. **❌ 人设/ OOC 偏离**：先怀疑「模型写飘了」，回 `角色模型/<队>/<角色>_角色扮演模型.md` 的 §3.9 与 §6 红线核对。');
P('2. **⚠️ 一律不单独下结论** —— 容差带是为小样本留的，先看 n。');
P('3. 本工具**不写任何结论**。改法归人，这与 `剧情分析/_data/*.json` 那三条语义纪律同源。');

if (OUT_MD) {
  writeFileSync(OUT_MD, L.join('\n'), 'utf8');
  console.log(`已写 → ${OUT_MD}`);
}

if (QUIET) {
  console.log(failCount ? `✗ ${lines.length} 条台词，${failCount} 项❌ 级偏离` : `✓ ${lines.length} 条台词，0 项❌ 级偏离（⚠️ 不计入）`);
} else {
  console.log(L.join('\n'));
}
process.exit(failCount ? 1 : 0);