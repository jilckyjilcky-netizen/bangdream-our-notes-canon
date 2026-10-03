#!/usr/bin/env node
/**
 * canon-tools.mjs —— 《BanG Dream! Our Notes》资料库 · MCP 工具逻辑（纯函数层，可 import 直接测试）
 * 被 canon-mcp-server.mjs 引用；也可被其他脚本 import 复用（工具/canon.mjs 就是这么用的）。
 *
 * 服务对象：BanG Dream! Our Notes（MyGO!!!!! / Ave Mujica / 梦限大MewType / millsage / 一家Dumb Rock 共 25 人，加 sumimi 真奈与 4 名 NPC，在册 30 人）可检索文本层。
 *
 * v1.2（2026-09-27）改名 + 接管其余文本资产：
 *   · 更名：kb_* 工具名去掉前缀（现在由 MCP 命名空间 mcp__canon__ 承担品牌）
 *   · 新增 card（SillyTavern V2 角色卡全文）、worldbook（世界书 50 词条）、doc（完整《角色扮演模型》/ 系统提示词）
 *   · stats 增加「检索后端」与「文本资产」自述——Ollama 没起时当场告诉你怎么恢复
 *
 * v1.1（2026-09-27）功能更新：
 *   · 新增 speech（语言指纹：明细 / 全库排名 / 多角色并排）
 *   · 新增 state（状态机）、stats（资料库体检）、world（场所物件）、sample（抽台词）
 *   · who 升级：支持多句/多行输入，按「语料级特征估计 vs 角色指纹」聚合打分；
 *     波浪号预期不再硬编码名单，v1.1 从 quote_bank 派生、**v1.3 改为全量语料波浪号率 ≥2%**（见 WAVE_CORPUS_RATE）
 *   · search 支持 type 过滤；quote 支持 by 限定 + 词汇兜底
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createCharResolver } from './name-index.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const WS = resolve(HERE, '..');
export const KB_PATH = resolve(process.env.KB_PATH || join(HERE, '..', '资料库', 'kb.json'));
export const OLLAMA = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
export const EMBED_MODEL = process.env.EMBED_MODEL || 'qwen3-embedding:0.6b';
export const RERANK_MODEL = process.env.RERANK_MODEL || '';

export const kb = JSON.parse(readFileSync(KB_PATH, 'utf8'));

/* ================= 工作区其余"文本资产"索引（v1.2） =================
 * 这些东西以前只能按路径去翻文件，MCP 拿不到；现在都接进来了：
 *   角色卡/          30 张 SillyTavern V2 卡（chara_card_v2）
 *   世界书/          1 份世界书（50 词条）
 *   角色模型/系统提示词/  26 份可直接粘贴的 system prompt
 *   （《角色扮演模型》长文由 kb.json 的 doc 字段指向，见 doc 工具）
 */
const lsDir = (rel, filter = () => true) => { try { return readdirSync(resolve(WS, rel)).filter(filter); } catch { return []; } };
export const CARD_FILES = lsDir('角色卡', f => f.endsWith('_character_card.json'));
export const PROMPT_FILES = lsDir(join('角色模型', '系统提示词'), f => f.endsWith('.md'));
export const WORLDBOOK_FILE = lsDir('世界书', f => f.endsWith('.json'))[0] || null;
export const WORLDBOOK = WORLDBOOK_FILE ? JSON.parse(readFileSync(join(WS, '世界书', WORLDBOOK_FILE), 'utf8')) : { entries: {} };

/* ================= 通用小工具 ================= */
const CJK = /[\u4e00-\u9fa5]/g;
export const cjkCount = (s) => (String(s).match(CJK) || []).length;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * numOf —— 统一解析 kb.json 里"半结构化"的指标值。
 * 语料里的写法很杂：`41/683 = 6.0%` · `33.4%` · `11.8（14.6）` · `10` · `25.0`
 * 口径：**优先取带 % 的数**（真值），否则取第一个数（如 `11.8（14.6）` → 11.8）。
 */
export function numOf(v) {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  const s = String(v);
  const p = s.match(/([\d.]+)\s*%/);
  if (p) return parseFloat(p[1]);
  const n = s.match(/-?\d+(?:\.\d+)?/);
  return n ? parseFloat(n[0]) : NaN;
}

/* ================= 检索语料块 ================= */
export function buildChunks() {
  const out = [];
  for (const c of kb.characters) {
    const parts = [
      `角色 ${c.name_short}（${c.en}）${c.stage ? '舞台名' + c.stage : ''} ${c.band} ${c.role}`,
      c.bio, c.personality.core, `欲望:${c.personality.desire} 恐惧:${c.personality.fear} 防御:${c.personality.defense}`, c.personality.arc,
      ...(c.keywords || []), ...(c.states || []).map(s => `${s.name} ${s.keys.join(' ')}`),
      ...(c.relations || []).map(r => `与${r.with}关系:${r.tone}`),
    ];
    out.push({ type: '角色', id: c.id, name: c.name_short, text: parts.filter(Boolean).join('。') });
  }
  for (const e of kb.events) out.push({ type: '事件', id: e.id, name: e.name, text: `${e.name}。${e.summary}。参与者:${e.participants.join('、')}。关键词:${e.keywords.join('、')}` });
  for (const p of kb.places) out.push({ type: '场所', id: p.id, name: p.name, text: `${p.name}。${p.summary}` });
  for (const it of kb.items) out.push({ type: '物件', id: it.id, name: it.name, text: `${it.name}（${it.kind}）。${it.summary}` });
  for (const c of kb.characters) for (const q of (c.quote_bank || [])) out.push({ type: '台词', id: c.id, name: c.name_short, text: `${c.name_short}说:「${q}」` });
  return out;
}
export const CHUNKS = buildChunks();

/* ================= Ollama ================= */
async function ollama(path, body, timeoutMs = 120000, method = 'POST') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(OLLAMA + path, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`ollama ${path} HTTP ${r.status}: ${await r.text()}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
let ollamaUp = null;
export async function checkOllama() {
  if (ollamaUp !== null) return ollamaUp;
  try { await ollama('/api/tags', undefined, 4000, 'GET'); ollamaUp = true; } catch { ollamaUp = false; }
  return ollamaUp;
}

/**
 * 检索后端自述：把「推荐用本地 Ollama 做向量检索」这件事直接放进工具输出，
 * 而不只是写在 README 里——Ollama 没装/没起时，调用方当场能看到该怎么恢复。
 */
export async function backendInfo() {
  const up = await checkOllama();
  return up
    ? { 模式: '混合检索（本地语义 + 词汇）', 嵌入模型: EMBED_MODEL, 精排模型: RERANK_MODEL || null, ollama: OLLAMA, 说明: '本地 Ollama 向量检索已就绪：数据不出本机、无 API 费用；rerank=true 时走精排模型' }
    : { 模式: '仅词汇（语义已降级）', 嵌入模型: null, ollama: OLLAMA, 说明: `Ollama 不可达，语义检索已禁用（词汇检索仍可用）。恢复：装好 ollama 后执行  ollama pull ${EMBED_MODEL}` };
}

/* ================= 嵌入缓存 + 计算 ================= */
const CACHE_FILE = join(HERE, '..', '资料库', '.kb-embeddings.json');
const hash = (s) => { let h = 5381; for (const ch of s) h = ((h << 5) + h + ch.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
const chunksHash = hash(CHUNKS.map(c => c.type + c.id + c.text).join('\x01'));
let vectors = null, embedErr = null;

export async function loadVectors() {
  if (vectors) return vectors;
  if (existsSync(CACHE_FILE)) {
    try {
      const c = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
      if (c.hash === chunksHash && c.model === EMBED_MODEL) { vectors = c.vectors; return vectors; }
    } catch {}
  }
  if (!(await checkOllama())) { embedErr = 'ollama 不可达，语义检索禁用（词汇检索仍可用）'; return null; }
  try {
    const all = [];
    for (let i = 0; i < CHUNKS.length; i += 16) {
      const batch = CHUNKS.slice(i, i + 16).map(c => c.text);
      const r = await ollama('/api/embed', { model: EMBED_MODEL, input: batch });
      all.push(...(r.embeddings || []));
    }
    if (all.length !== CHUNKS.length) throw new Error(`嵌入数量不符 ${all.length}/${CHUNKS.length}`);
    vectors = all;
    writeFileSync(CACHE_FILE, JSON.stringify({ model: EMBED_MODEL, hash: chunksHash, vectors }), 'utf8');
  } catch (e) { embedErr = '嵌入失败: ' + e.message; vectors = null; }
  return vectors;
}
const cos = (a, b) => { let dot = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1); };
async function embedOne(text) {
  const r = await ollama('/api/embed', { model: EMBED_MODEL, input: [text] });
  return (r.embeddings || [])[0];
}

/* ================= 检索核心 ================= */
function lexicalHits(q, limit = 8) {
  const ql = q.toLowerCase();
  const scored = [];
  for (const c of CHUNKS) {
    const t = c.text.toLowerCase();
    let s = 0;
    if (t.includes(ql)) s += 3;
    else { for (const w of ql.split(/[\s，。？！、"]+/).filter(x => x.length >= 2)) if (t.includes(w)) s += 1; }
    if (s > 0) scored.push({ ...c, score: s });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
async function semanticHits(q, limit = 8) {
  const V = await loadVectors();
  if (!V) return { hits: [], note: embedErr };
  const qv = await embedOne(q);
  const scored = CHUNKS.map((c, i) => ({ ...c, score: cos(qv, V[i]) }));
  return { hits: scored.sort((a, b) => b.score - a.score).slice(0, limit), note: null };
}
export async function hybrid(q, topK = 6, useRerank = false) {
  const lex = lexicalHits(q, 8);
  const sem = await semanticHits(q, 8);
  const map = new Map();
  for (const h of lex) map.set(h.type + h.id + h.text, { ...h, _lex: h.score, _sem: 0 });
  for (const h of sem.hits) { const k = h.type + h.id + h.text; const cur = map.get(k); if (cur) cur._sem = h.score; else map.set(k, { ...h, _lex: 0, _sem: h.score }); }
  let list = [...map.values()].map(h => ({ ...h, score: h._lex + Math.max(0, h._sem) * 4 })).sort((a, b) => b.score - a.score);
  if (useRerank && RERANK_MODEL) {
    try {
      const r = await ollama('/api/rerank', { model: RERANK_MODEL, query: q, documents: list.slice(0, 8).map(c => c.text) }, 60000);
      const hits = (r.results || []).sort((a, b) => b.score - a.score).slice(0, 5).map(x => ({ ...list[x.index], score: x.score }));
      return { hits, note: sem.note };
    } catch (e) { return { hits: list.slice(0, topK), note: 'rerank 失败: ' + e.message }; }
  }
  return { hits: list.slice(0, topK), note: sem.note };
}

/* ================= 实体定位（v1.3：中日姓名索引） =================
 * v1.2 只认「简称精确 + 拼接串包含」，于是中文/日文语境下的**全名**查不到：
 *   char{name:"三角初华"} → 未找到角色（只有 name:"初华" 才行）
 * 现在解析委托给 name-index.mjs：全名 / 姓 / 名 / 舞台名(拉丁+片假名) / 罗马音 /
 * 简繁与和制汉字变体 全部落键；同级多命中时如实报歧义，不猜。
 */
const RESOLVER = createCharResolver({ characters: kb.characters });

/** 原始解析结果：{char,tier,via} | {ambiguous:[…]} | null（调试/自检用）。 */
export const resolveName = (n) => RESOLVER.resolve(n);
export const nameIndexStats = () => RESOLVER.stats();

/** 兼容旧签名：只取字符对象，取不到返回 null。 */
export const resolveChar = (n) => { const r = RESOLVER.resolve(n); return r && r.char ? r.char : null; };

const charNames = () => kb.characters.map(c => c.name_short);

/**
 * 统一的「找不到角色」回执。
 * 不再把 25 个人名整份倒出来（那等于没给信息），改为：近似候选 + 可用写法 + 乐队名提示。
 */
export function notFound(raw) {
  const near = RESOLVER.suggest(raw);
  const band = RESOLVER.bandHint(raw);
  return {
    error: `未找到角色「${raw}」`,
    ...(near.length ? { candidates: near } : {}),
    ...(band ? { 提示: `「${band.band}」是乐队名，不是角色；成员：${band.members.join('、')}` } : {}),
    可用写法: '简称 初华 ｜ 全名 三角初华 ｜ 姓 三角 ｜ 日文 三角 初華 ｜ 舞台名 Doloris / ドロリス ｜ 罗马音 Uika Misumi / Misumi Uika',
    全部角色: charNames(),
  };
}

/** 一步到位：{char,via,tier} 或 {err: 可直接 return 的回执}。命中/歧义/未命中三态分清。 */
export function pickChar(raw) {
  const r = RESOLVER.resolve(raw);
  if (!r) return { err: notFound(raw) };
  if (r.ambiguous) {
    return { err: {
      error: `角色名「${raw}」有歧义`,
      candidates: r.ambiguous.map(x => x.char.name_short),
      提示: '换更具体的写法：全名 / 舞台名 / 罗马音',
    } };
  }
  return { char: r.char, via: r.via, tier: r.tier };
}
const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/* ================= 语言指纹：指标解析 / 特征估计 / 打分 ================= */
export const SPEECH_METRICS = [
  '句长均值(汉字)', '句长中位数', '最长句', '≤6字占比', '纯沉默占比',
  '省略号率', '以…结尾', '以?结尾', '以!结尾',
  '疑问率', '口吃率', '小X呼称率', '含我率',
  '歌词均长', '歌词省略号率', '歌词疑问率',
];

/** 指标名解析：精确优先 → 包含匹配；歧义时列出候选，不猜。 */
export function resolveMetric(m) {
  if (!m) return { error: '缺少 metric（指标名）', candidates: SPEECH_METRICS };
  const raw = String(m).trim();
  if (SPEECH_METRICS.includes(raw)) return { key: raw };
  const cands = SPEECH_METRICS.filter(k => k.includes(raw) || raw.includes(k));
  if (cands.length === 1) return { key: cands[0] };
  if (cands.length > 1) return { error: `指标名「${raw}」有歧义`, candidates: cands };
  return { error: `未知指标「${raw}」`, candidates: SPEECH_METRICS };
}

const stripQuote = (l) => String(l).trim().replace(/^[「『"“]+/, '').replace(/[」』"”]+$/, '').trim();
const LINE_TESTS = {
  ellipsis: (l) => /…/.test(l),
  endEllipsis: (l) => /…$/.test(l),
  question: (l) => /？/.test(l),
  endBang: (l) => /！$/.test(l),
  stutter: (l) => /([\u4e00-\u9fa5])、\1/.test(l),
  xcall: (l) => /小[\u4e00-\u9fa5]{1,2}/.test(l),
  me: (l) => /我/.test(l),
  wave: (l) => /[～~]/.test(l),
};

/** 把输入拆成可分析的句子：先按行，再按句末标点；不足 2 个汉字的丢掉。
 *  注意：**不**在「…」处断句——本语料 36~48% 的行含省略号，它是停顿标记而非句末，
 *  在「…」处断句会把「今天……谢谢你们。」切成两句残句（实测踩过）。 */
export function splitSentences(text) {
  const lines = Array.isArray(text) ? text : String(text ?? '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = stripQuote(line);
    if (cjkCount(t) < 2) continue;
    const parts = t.split(/(?<=[。！？])/).map(s => s.trim()).filter(s => cjkCount(s) >= 2);
    out.push(...(parts.length ? parts : [t]));
    if (out.length >= 200) break;
  }
  return out.slice(0, 200);
}

/**
 * fingerprintOf —— 由 n 句输入估计"语料级"语言特征。
 * 这是多句投票能成立的关键：单句时各比重只能是 0/100，n 句时才逼近真实占比。
 */
export function fingerprintOf(lines) {
  const valid = lines.map(stripQuote).filter(l => cjkCount(l) >= 2);
  const n = valid.length;
  const pct = (f) => (n ? +(100 * valid.filter(f).length / n).toFixed(1) : 0);
  const chars = valid.map(cjkCount);
  const fp = {
    句数: n,
    均长: n ? +(chars.reduce((a, b) => a + b, 0) / n).toFixed(1) : 0,
    '≤6字占比': pct(l => cjkCount(l) <= 6),
    省略号率: pct(LINE_TESTS.ellipsis),
    '以…结尾': pct(LINE_TESTS.endEllipsis),
    疑问率: pct(LINE_TESTS.question),
    '以!结尾': pct(LINE_TESTS.endBang),
    口吃率: pct(LINE_TESTS.stutter),
    '小X呼称率': pct(LINE_TESTS.xcall),
    含我率: pct(LINE_TESTS.me),
    波浪号率: pct(LINE_TESTS.wave),
  };
  if (n === 1) fp.flags = { 省略号: LINE_TESTS.ellipsis(valid[0]), 疑问: LINE_TESTS.question(valid[0]), 感叹: LINE_TESTS.endBang(valid[0]), 口吃: LINE_TESTS.stutter(valid[0]), 小X: LINE_TESTS.xcall(valid[0]), 波浪号: LINE_TESTS.wave(valid[0]) };
  return fp;
}

/**
 * 波浪号基线：各角色在**全量语料按行**里的波浪号率（%，2026-10-03 实测）。
 *
 * 为什么不再从 quote_bank 派生（v1.1 的做法）：
 *   quote_bank 是人工挑的 ~30 条"有戏"句子，**挑中 1 条带「～」就判该角色用波浪号**。
 *   祥子就是这样被误判的——她 quote_bank 30 条里仅 1 条带「～」（还是别人的台词
 *   「〔原文略〕！ 加油哦～！」），而她全量语料 1314 条里波浪号 **0 次**。
 *   后果很硬：她不拖音 ⇒ 波浪号维恒定吃 +1 偏差 ⇒ 同一段台词从第 5 名掉到第 16 名
 *   （复现：`归档/_临时诊断/闸门对照_祥子.mjs`；全库清点：`波浪号真相.mjs`；
 *   体检报告：`归档/_临时诊断/祥子_口径体检报告.md` §四）。
 *
 * 判定规则：语料率 ≥ WAVE_EXPECT_MIN_RATE(2%) 才算"这个角色会用波浪号"。
 *   该阈值来自数据本身的断层：真实在用的 14 人最低 2.40%（由乃），
 *   其余 16 人最高 1.89%（初华）——阈值落在断层里，初华是唯一的边界个案。
 * 改语料后请重跑：`node 工具/build_wave_baseline.mjs --check`（不一致即退出码 1；`--js` 出常量片段）。
 * `工具/check_kb.mjs` 也会在语料与常量漂移时给出提醒。
 */
export const WAVE_EXPECT_MIN_RATE = 2;
export const WAVE_CORPUS_RATE = {
  爱音: 14.69, 灯: 0, 立希: 0.1, 爽世: 3.25, 乐奈: 1.21,
  祥子: 0, 初华: 1.89, 睦: 0.18, 海铃: 0.17, 若麦: 20.71,
  阿拉蕾: 16.13, 野乃花: 35.34, 律: 0.99, 都子: 1.7, 由乃: 2.4,
  萤: 0.55, 枣: 0.62, 凪: 2.02, 茉幌: 8.08, 朋花: 0.65,
  蕾叶: 21.18, 心玖: 8.56, 蓬咲: 20.39, 千樱梨: 5.21, 宁月: 0,
  真奈: 13.33, 诗船: 0, 凛凛子: 21.95, 清告: 0, 定治: 0,
};
export const WAVE_EXPECT = new Map(kb.characters.map(c => {
  const 率 = WAVE_CORPUS_RATE[c.name_short];
  return [c.name_short, { 语料率: 率 ?? null, expect: 率 != null && 率 >= WAVE_EXPECT_MIN_RATE }];
}));
export const WAVE_CHARS = [...WAVE_EXPECT.entries()].filter(([, v]) => v.expect).map(([k]) => k);

const SCORE_DIMS = [
  { metric: '句长均值(汉字)', est: (f) => f.均长, kind: 'rel' },
  { metric: '≤6字占比', est: (f) => f['≤6字占比'], kind: 'pct' },
  { metric: '省略号率', est: (f) => f.省略号率, kind: 'pct' },
  { metric: '以…结尾', est: (f) => f['以…结尾'], kind: 'pct' },
  { metric: '疑问率', est: (f) => f.疑问率, kind: 'pct' },
  { metric: '以!结尾', est: (f) => f['以!结尾'], kind: 'pct' },
  { metric: '含我率', est: (f) => f.含我率, kind: 'pct' },
  { metric: '口吃率', est: (f) => f.口吃率, kind: 'pct' },
  { metric: '小X呼称率', est: (f) => f['小X呼称率'], kind: 'pct' },
];
const WAVE_DIM = { metric: '波浪号', est: (f) => f.波浪号率, kind: 'pct', expectOf: (name) => (WAVE_EXPECT.get(name)?.expect ? 100 : 0) };

/* 每个维度在 25 人里的分布（用于 z 打分）与排序（用于 rank 打分），只算一次 */
const DIM_CANON = new Map();
function dimCanon(dim) {
  if (!DIM_CANON.has(dim.metric)) {
    const values = kb.characters.map(c => (dim.expectOf ? dim.expectOf(c.name_short) : numOf(c.speech?.[dim.metric]))).filter(v => !isNaN(v));
    const mu = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mu) ** 2, 0) / values.length);
    DIM_CANON.set(dim.metric, { n: values.length, sorted: [...values].sort((a, b) => a - b), mu, sd });
  }
  return DIM_CANON.get(dim.metric);
}
/** 1-based 秩：命中同值时取平均秩，未命中时取插入位。 */
function rankOf(sorted, v) {
  const n = sorted.length;
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
  let last = lo; while (last < n && sorted[last] === v) last++;
  return last > lo ? (lo + 1 + last) / 2 : lo + 1;
}

/**
 * 偏差分：越低越像。返回全部角色，升序。
 * mode：三种口径在 399 句回测上**互相区分不出来**（见 _bench-who.mjs 的表），
 *       故取最简单的 raw 作默认，不在这份**有偏样本**上调参（那是过拟合）。
 *   'raw'（默认）——各维度绝对差（长度用相对差）直接平均。单句 11.0% / 3 句 14.0% / 5 句 15.8%
 *   'rank' ——各维度先化成"在 25 人里的位置"再比位置差。单句 10.0% / 3 句 14.9% / 5 句 14.0%
 *   'z'    ——按 25 人标准差归一化。单句 9.5% / 3 句 13.2% / 5 句 17.5%（n=57，噪声 ±5pp）
 */
export function scoreCharacters(fp, { includeWave = true, mode = 'raw', drop = [], topDetail = 3 } = {}) {
  const dims = (includeWave ? [...SCORE_DIMS, WAVE_DIM] : SCORE_DIMS).filter(d => !drop.includes(d.metric));
  return kb.characters.map((c) => {
    let d = 0, used = 0;
    const parts = [];
    for (const dim of dims) {
      const canon = dim.expectOf ? dim.expectOf(c.name_short) : numOf(c.speech?.[dim.metric]);
      if (isNaN(canon)) continue;
      const est = dim.est(fp);
      if (isNaN(est)) continue;
      let dev;
      if (mode === 'rank') {
        const st = dimCanon(dim);
        dev = Math.abs(rankOf(st.sorted, canon) - rankOf(st.sorted, est)) / st.n;
      } else if (mode === 'z') {
        const st = dimCanon(dim);
        dev = Math.min(Math.abs(canon - est) / Math.max(st.sd, 1), 3);
      } else {
        dev = dim.kind === 'rel' ? Math.abs(canon - est) / Math.max(canon, 1) : Math.abs(canon - est) / 100;
      }
      d += dev; used++;
      parts.push([dim.metric, +dev.toFixed(3)]);
    }
    return { name: c.name_short, score: +(d / Math.max(used, 1)).toFixed(3), dims_used: used, worst: parts.sort((a, b) => b[1] - a[1]).slice(0, topDetail).map(([k, v]) => `${k}+${v}`) };
  }).sort((a, b) => a.score - b.score);
}

/**
 * v1.0 打分器复刻 —— 只给 _bench-who.mjs 做 A/B 基准，不在 MCP 暴露。
 * 差异：只用 句长均值 + 5 个占比（感叹率在语料里根本不存在，实际被静默跳过）+ 硬编码波浪号名单。
 */
export function scoreLegacy(text) {
  const sp = String(text).replace(/\s/g, '');
  const len = cjkCount(sp);
  const flags = { 省略号: LINE_TESTS.ellipsis(sp), 感叹: /！/.test(sp), 疑问: LINE_TESTS.question(sp), 口吃: LINE_TESTS.stutter(sp), 小X: LINE_TESTS.xcall(sp), 波浪号: LINE_TESTS.wave(sp) };
  const list = kb.characters.map(c => {
    const f = c.speech; let d = 0, used = 0;
    const canonLen = numOf(f['句长均值(汉字)']);
    if (!isNaN(canonLen)) { d += Math.abs(canonLen - len) / Math.max(canonLen, 1); used++; }
    for (const [kf, flag] of [['省略号率', '省略号'], ['疑问率', '疑问'], ['感叹率', '感叹'], ['口吃率', '口吃'], ['小X呼称率', '小X']]) {
      const a2 = numOf(f[kf]);
      if (!isNaN(a2)) { d += Math.abs(a2 - (flags[flag] ? 100 : 0)) / 100; used++; }
    }
    if (flags.波浪号) d += ['若麦', '爱音', '爽世'].includes(c.name_short) ? -0.5 : 0.8;
    else d += ['若麦', '爱音', '爽世'].includes(c.name_short) ? 0.35 : 0;
    return { name: c.name_short, score: +(d / Math.max(used, 1)).toFixed(3) };
  }).sort((a, b) => a.score - b.score);
  return { input: text, fingerprint: { 均长: len, ...flags }, guesses: list.slice(0, 3) };
}

/**
 * whoGuess —— 多句聚合打分（v1.1 默认）。
 * method='aggregate'：用 n 句的语料级特征估计打分（低 n 时更稳）
 * method='vote'     ：逐句各自排名，多数票
 */
export function whoGuess(text, { topK = 3, method = 'aggregate', mode = 'raw', includeWave = true, detail = false } = {}) {
  const sentences = splitSentences(text);
  if (!sentences.length) {
    const raw = Array.isArray(text) ? text.join('') : String(text ?? '');
    const kana = /[\u3040-\u30ff]/.test(raw);
    return {
      error: kana
        ? '输入里只有假名（或不足 2 个汉字）：本资料库的语言指纹基于**中文剧本**统计，日文句无法评估'
        : '没有可分析的有效句子（每句需至少 2 个汉字）',
      提示: kana ? '请给中文台词；要按日文评估得先另建日文语料指纹' : '检查输入是否为空、或只有标点/符号',
    };
  }
  const fp = fingerprintOf(sentences);
  const ranked = scoreCharacters(fp, { includeWave, mode });
  const perSentence = [];
  const votes = new Map();
  for (const s of sentences) {
    const r = scoreCharacters(fingerprintOf([s]), { includeWave, mode });
    votes.set(r[0].name, (votes.get(r[0].name) || 0) + 1);
    perSentence.push({ text: s, best: r[0].name, score: r[0].score, top3: r.slice(0, 3).map(x => x.name) });
  }
  const byVote = [...votes.entries()].sort((a, b) => b[1] - a[1] || ranked.findIndex(x => x.name === a[0]) - ranked.findIndex(x => x.name === b[0]));
  const leader = method === 'vote' && byVote.length ? byVote[0][0] : ranked[0].name;
  const order = method === 'vote' && byVote.length
    ? [...ranked].sort((a, b) => (votes.get(b.name) || 0) - (votes.get(a.name) || 0) || a.score - b.score)
    : ranked;
  const out = {
    句数: sentences.length,
    fingerprint: fp,
    leader,
    guesses: order.slice(0, topK).map(g => ({ name: g.name, score: g.score, votes: votes.get(g.name) || 0, worst: g.worst })),
    caveat: sentences.length === 1
      ? '单句不可当真：实测（_bench-who.mjs，399 句同源回测）单句 top1 约 11%、3 句约 14%、5 句约 16%（随机基线 4%）——多给几句会明显更稳'
      : '偏差分越低越像。实测（同上）特征聚合优于逐句多数票；句数越多估计越稳',
  };
  if (detail || sentences.length > 1) out.per_sentence = perSentence;
  // 聚合冠军可能一句都没被逐句判中（聚合≠多数票），把投票领先者单列，免得 votes:0 被误读
  if (sentences.length > 1) out.votes_top = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, v]) => ({ name, votes: v }));
  if (LINE_TESTS.wave(sentences.join(''))) out.wave_hint = { 输入含波浪号: true, 语料中用过波浪号的角色: WAVE_CHARS, 说明: '按全量语料波浪号率 ≥2% 判定的角色（不是"只属于这些人"，仅作弱信号）；v1.1 用的精选台词库口径已废弃——它会把 0 次使用的角色误判为"该用波浪号"' };
  return out;
}

/* ================= 抽台词（可复现） ================= */const seedInt = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
export function seededSample(arr, n, seed) {
  const rnd = mulberry32(seedInt(seed));
  const pool = [...arr];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, clamp(n, 1, pool.length));
}

/* ================= 台词库抽样偏差体检 ================= */
/**
 * sampleBias —— 比对「quote_bank 实测的标记分布」与「speech 里登记的语料指标」。
 *
 * 为什么需要它：quote_bank 是从语料里**人工精选**的台词，不是随机抽样。
 * 实测发现两者会系统性打架（例：爱音 疑问率 登记 38.6% / 台词库只有 12.5%；
 * 立希 登记 29.9% / 台词库 1.8%）。后果有两个：
 *   ① 用 quote_bank 当"风格范本"或出扮演测试题，会继承这个偏移；
 *   ② who 在 quote_bank 上评测时，疑问率维度会被带偏（回测里"去掉疑问率"在 3 句档略升）。
 * 它是**体检项而非错误**——精选台词本来就会偏向"有戏"的句子。
 */
export function sampleBias() {
  const CMP = [
    { metric: '疑问率', kind: 'pct' },
    { metric: '省略号率', kind: 'pct' },
    { metric: '≤6字占比', kind: 'pct' },
    { metric: '句长均值(汉字)', kind: 'len' },
  ];
  return kb.characters.map((c) => {
    const sents = splitSentences(c.quote_bank || []);
    if (!sents.length) return { name: c.name_short, 台词库句数: 0, 偏差: [] };
    const fp = fingerprintOf(sents);
    const est = { 疑问率: fp.疑问率, 省略号率: fp.省略号率, '≤6字占比': fp['≤6字占比'], '句长均值(汉字)': fp.均长 };
    const rows = CMP.map(({ metric, kind }) => {
      const canon = numOf(c.speech?.[metric]), lib = est[metric];
      if (isNaN(canon) || isNaN(lib)) return null;
      const diff = +(lib - canon).toFixed(1);
      const big = kind === 'len' ? Math.abs(diff) / Math.max(canon, 1) >= 0.25 : Math.abs(diff) >= 15;
      return { 指标: metric, 语料登记: canon, 台词库实测: lib, 差: diff, 明显: big };
    }).filter(Boolean);
    return { name: c.name_short, 台词库句数: sents.length, 偏差: rows, 最大偏差: rows.filter(r => r.明显).sort((a, b) => Math.abs(b.差) - Math.abs(a.差)).slice(0, 2) };
  });
}

/* ================= 工具 ================= */
export const tools = {
  list: { run: async (a) => {
    const t = a?.type;
    const out = { 角色: kb.characters.map(c => `${c.name_short}（${c.band} ${c.role}）`), 事件: kb.events.map(e => e.name), 场所: kb.places.map(p => p.name), 物件: kb.items.map(i => `${i.name}（${i.kind}）`) };
    return t && out[t] ? { [t]: out[t] } : out;
  }},
  char: { run: async (a) => {
    const p = pickChar(a?.name || '');
    if (p.err) return p.err;
    const c = p.char;
    return { id: c.id, name: c.name_short, en: c.en, aliases: c.aliases, stage: c.stage, band: c.band, role: c.role, basic: c.basic, bio: c.bio, tagline: c.tagline, personality: c.personality, likes_interests: c.likes_interests, speech: c.speech, states: c.states, relations: c.relations, bans: c.bans, keywords: c.keywords, quote_bank: (c.quote_bank || []).slice(0, 10), events: (c.events || []).map(id => kb.events.find(e => e.id === id)?.name), doc: c.doc, _命中: p.via };
  }},
  rel: { run: async (a) => {
    const pa = pickChar(a?.a || ''), pb = pickChar(a?.b || '');
    if (pa.err || pb.err) return pa.err || pb.err;
    const ca = pa.char, cb = pb.char;
    const ra = (ca.relations || []).find(r => r.with.includes(cb.name_short) || (cb.aliases || []).includes(r.with));
    const rb = (cb.relations || []).find(r => r.with.includes(ca.name_short) || (ca.aliases || []).includes(r.with));
    return {
      [`${ca.name_short}_call_${cb.name_short}`]: ra ? ra.call : '语料无直接互动',
      [`${ca.name_short}_to_${cb.name_short}`]: ra ? ra.tone : '—',
      [`${cb.name_short}_call_${ca.name_short}`]: rb ? rb.call : '语料无直接互动',
      [`${cb.name_short}_to_${ca.name_short}`]: rb ? rb.tone : '—',
    };
  }},
  event: { run: async (a) => {
    const r = await hybrid(a?.q || '', a?.top_k || 3);
    return { events: r.hits.filter(h => h.type === '事件').map(h => kb.events.find(e => e.id === h.id)).filter(Boolean), related_chunks: r.hits.filter(h => h.type !== '事件').map(h => ({ type: h.type, name: h.name })), note: r.note };
  }},
  quote: { run: async (a) => {
    const pby = a?.by ? pickChar(a.by) : null;
    if (pby?.err) return pby.err;
    const by = pby?.char || null;
    const q = a?.q || '';
    const topK = a?.top_k || 5;
    if (!q) {
      if (!by) return { error: '需要 q（检索词）或 by（限定角色）' };
      return { by: by.name_short, total: (by.quote_bank || []).length, quotes: (by.quote_bank || []).slice(0, clamp(topK, 1, 20)), note: '未给 q：返回该角色台词库前若干条（要随机抽样用 sample）' };
    }
    const r = await hybrid(q, Math.max(topK * 2, 8));
    let hits = r.hits.filter(h => h.type === '台词');
    if (by) hits = hits.filter(h => h.name === by.name_short);
    let quotes = hits.map(h => ({ by: h.name, text: h.text.replace(/^.+说[:：]/, '').replace(/^「|」$/g, '') }));
    let note = r.note;
    if (!quotes.length && by) {
      quotes = (by.quote_bank || []).filter(t => t.includes(q) || q.split(/\s+/).some(w => w.length >= 2 && t.includes(w))).slice(0, topK).map(t => ({ by: by.name_short, text: t }));
      note = [note, '语义未命中台词，已回退为该角色台词库内的词汇匹配'].filter(Boolean).join('；');
    }
    return { quotes: quotes.slice(0, topK), note };
  }},
  search: { run: async (a) => {
    const type = a?.type;
    const want = type ? String(type).replace(/[〝〞"']/g, '') : '';
    const r = await hybrid(a?.q || '', want ? Math.max((a?.top_k || 6) * 3, 12) : (a?.top_k || 6), !!a?.rerank);
    let hits = r.hits;
    if (want) {
      const hit = hits.filter(h => h.type === want);
      if (!hit.length) return { results: [], note: r.note, hint: `本次检索未命中「${want}」类；可用 type: 角色|事件|场所|物件|台词，或去掉 type 看全部` };
      hits = hit.slice(0, a?.top_k || 6);
    }
    return { results: hits.map(h => ({ type: h.type, name: h.name, id: h.id, score: h.score, text: h.text })), note: r.note };
  }},
  who: { run: async (a) => whoGuess(a?.text ?? a?.lines ?? '', { topK: a?.top_k || 3, method: a?.method || 'aggregate' }) },

  /* ---------- v1.1 新增 ---------- */
  speech: { run: async (a) => {
    const metric = a?.metric;
    if (metric) {
      const m = resolveMetric(metric);
      if (m.error) return m;
      const order = a?.order === 'asc' ? 'asc' : 'desc';
      const rows = kb.characters.map(c => ({ name: c.name_short, band: c.band, value: numOf(c.speech?.[m.key]), raw: c.speech?.[m.key] }))
        .filter(r => !isNaN(r.value))
        .sort((x, y) => (order === 'asc' ? x.value - y.value : y.value - x.value));
      return { metric: m.key, order, 有效人数: rows.length, ranking: rows.slice(0, clamp(a?.top_k || 10, 1, 25)) };
    }
    const names = toArr(a?.names ?? a?.name);
    if (!names.length) return { error: '需要 name（角色）或 metric（指标名）', metrics: SPEECH_METRICS, 用法: 'name=爽世 看明细；metric=疑问率 看 25 人排名；names=[a,b] 并排对比' };
    const chars = [];
    for (const n of names) { const p = pickChar(n); if (p.err) return p.err; chars.push(p.char); }
    const table = {};
    for (const k of SPEECH_METRICS) table[k] = chars.map(c => ({ name: c.name_short, raw: c.speech?.[k] ?? null, value: numOf(c.speech?.[k]) }));
    const out = {
      角色: chars.map(c => ({ name: c.name_short, band: c.band, role: c.role })),
      speech: Object.fromEntries(chars.map(c => [c.name_short, c.speech])),
      缺失指标: Object.fromEntries(chars.map(c => [c.name_short, SPEECH_METRICS.filter(k => isNaN(numOf(c.speech?.[k])))])),
    };
    if (chars.length > 1) {
      out.差异最大 = SPEECH_METRICS.map(k => {
        const vals = table[k].map(x => x.value).filter(v => !isNaN(v));
        return vals.length > 1 ? { metric: k, 极差: +(Math.max(...vals) - Math.min(...vals)).toFixed(1), 值: table[k].map(x => `${x.name}:${isNaN(x.value) ? '—' : x.value}`).join(' | ') } : null;
      }).filter(Boolean).sort((x, y) => y.极差 - x.极差).slice(0, 5);
    }
    return out;
  }},
  state: { run: async (a) => {
    const q = a?.q;
    if (a?.name) {
      const p = pickChar(a.name);
      if (p.err) return p.err;
      const c = p.char;
      return { name: c.name_short, band: c.band, states: c.states || [], 说明: 'keys 是该状态的触发条件/语境标签；speech 是该状态下的说话方式' };
    }
    if (q) {
      const hits = [];
      for (const c of kb.characters) for (const s of c.states || []) {
        if ([s.name, s.speech, ...(s.keys || [])].join(' ').includes(q)) hits.push({ character: c.name_short, state: s.name, keys: s.keys, speech: s.speech });
      }
      return { q, 命中: hits.length, hits, note: hits.length ? undefined : '换个词试试，或用 state 不带参数看全部状态名' };
    }
    return { error: '需要 name（角色）或 q（关键词）', 全部状态名: [...new Set(kb.characters.flatMap(c => (c.states || []).map(s => s.name)))] };
  }},
  stats: { run: async (a) => {
    const p = a?.name ? pickChar(a.name) : null;
    if (p?.err) return p.err;
    const one = p?.char || null;
    const chars = one ? [one] : kb.characters;
    const per = chars.map(c => {
      const missing = SPEECH_METRICS.filter(k => isNaN(numOf(c.speech?.[k])));
      const docPath = c.doc ? resolve(WS, c.doc) : null;
      return {
        name: c.name_short, band: c.band,
        台词: (c.quote_bank || []).length, 事件: (c.events || []).length, 关系: (c.relations || []).length, 状态: (c.states || []).length,
        指标: `${SPEECH_METRICS.length - missing.length}/${SPEECH_METRICS.length}`, 缺失指标: missing,
        doc: c.doc, doc存在: docPath ? existsSync(docPath) : false,
      };
    });
    const bias = one ? sampleBias().filter(b => b.name === one.name_short) : sampleBias();
    const flagged = bias.flatMap(b => (b.最大偏差 || []).map(d => `${b.name}·${d.指标}：语料 ${d.语料登记} vs 台词库 ${d.台词库实测}（差 ${d.差}）`));
    return {
      meta: kb.meta,
      检索后端: await backendInfo(),
      名字索引: nameIndexStats(),
      totals: { 角色: kb.characters.length, 事件: kb.events.length, 场所: kb.places.length, 物件: kb.items.length, 台词: kb.characters.reduce((s, c) => s + (c.quote_bank || []).length, 0), 检索块: CHUNKS.length },
      文本资产: { 角色卡: CARD_FILES.length, 世界书词条: Object.keys(WORLDBOOK.entries || {}).length, 系统提示词: PROMPT_FILES.length, 模型文档: kb.characters.filter(c => c.doc).length },
      characters: per,
      缺口: {
        缺指标的角色: per.filter(p => p.缺失指标.length).map(p => `${p.name}(${p.缺失指标.join('/')})`),
        模型文档不存在: per.filter(p => !p.doc存在).map(p => p.name),
        台词偏少: per.filter(p => p.台词 < 10).map(p => `${p.name}:${p.台词}`),
      },
      台词库抽样偏差: {
        说明: 'quote_bank 是人工精选台词，不是随机抽样——它的标记分布与语料登记的 speech 指标可能系统性不一致。用它当风格范本 / 出扮演测试题会继承该偏移。',
        明显偏差: flagged,
        全部: bias,
      },
    };
  }},
  world: { run: async (a) => {
    const kind = a?.kind === '场所' || a?.kind === '物件' ? a.kind : '';
    const q = (a?.q || '').trim();
    const topK = clamp(a?.top_k || 8, 1, 20);
    if (!q) {
      const places = kind === '物件' ? [] : kb.places;
      const items = kind === '场所' ? [] : kb.items;
      return { 场所: places.map(p => ({ type: '场所', ...p })), 物件: items.map(i => ({ type: '物件', ...i })), note: '未给 q：返回全部（可用 kind 限定 场所/物件）' };
    }
    const r = await hybrid(q, Math.max(topK * 3, 12));
    const picked = r.hits.filter(h => h.type === '场所' || h.type === '物件').filter(h => !kind || h.type === kind).slice(0, topK);
    return {
      results: picked.map(h => ({ type: h.type, score: h.score, ...(h.type === '场所' ? kb.places.find(p => p.id === h.id) : kb.items.find(i => i.id === h.id)) })),
      note: r.note,
    };
  }},
  sample: { run: async (a) => {
    const p = pickChar(a?.name ?? '');
    if (p.err) return p.err;
    const c = p.char;
    const qb = c.quote_bank || [];
    if (!qb.length) return { error: `${c.name_short} 的台词库为空` };
    const n = clamp(a?.n || 5, 1, 30);
    const seed = a?.seed != null ? String(a.seed) : c.id;
    return {
      name: c.name_short, 取样: Math.min(n, qb.length), 总数: qb.length, seed,
      quotes: seededSample(qb, n, seed),
      note: '取自该角色真实台词库（quote_bank），用于扮演测试 / 盲测出题；同 name+seed 结果可复现。注意：quote_bank 是精选样本，其标记分布与语料登记指标可能不一致（stats 的「台词库抽样偏差」有逐人数据）——当风格范本用之前先看一眼。',
    };
  }},

  /* ---------- v1.2：把工作区里其余"文本资产"也接进 MCP ---------- */
  card: { run: async (a) => {
    const p = pickChar(a?.name ?? '');
    if (p.err) return { ...p.err, 说明: '角色卡是 SillyTavern V2 卡（角色卡/*.json）' };
    const c = p.char;
    const file = CARD_FILES.find(f => f.includes(c.name_short)) || CARD_FILES.find(f => resolveChar(f.replace(/_character_card\.json$/, ''))?.id === c.id);
    if (!file) return { error: `${c.name_short} 没有角色卡文件`, 现有: CARD_FILES };
    const j = JSON.parse(readFileSync(join(WS, '角色卡', file), 'utf8'));
    const d = j.data || j;
    const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `…（共 ${s.length} 字，需要全文用 max_chars）` : s);
    const cap = clamp(a?.max_chars || 1200, 200, 20000);
    return {
      name: d.name, spec: j.spec, spec_version: j.spec_version, file,
      description: cut(d.description, cap), personality: cut(d.personality, cap), scenario: cut(d.scenario, cap),
      first_mes: cut(d.first_mes, cap), mes_example: cut(d.mes_example, cap), system_prompt: cut(d.system_prompt, cap),
      post_history_instructions: cut(d.post_history_instructions, cap),
      alternate_greetings: d.alternate_greetings, tags: d.tags, creator: d.creator, creator_notes: d.creator_notes, character_version: d.character_version,
      说明: 'SillyTavern / 兼容前端可直接导入的原卡字段；要完整长文传 max_chars（如 20000）',
    };
  }},
  worldbook: { run: async (a) => {
    const q = (a?.q || '').trim();
    const entries = WORLDBOOK.entries || {};
    const list = Object.entries(entries).map(([uid, e]) => ({
      uid, 关键词: e.keys || [], 标题: (e.comment || '').trim() || (e.keys || [])[0] || `#${uid}`,
      内容: e.content || '', enabled: e.enabled !== false, 长度: (e.content || '').length,
    }));
    if (!q) {
      return {
        文件: WORLDBOOK_FILE, 词条数: list.length, 元数据: WORLDBOOK.metadata,
        词条: list.map(({ 内容, ...rest }) => rest).slice(0, clamp(a?.top_k || 60, 1, 200)),
        note: '未给 q：只回目录（标题/关键词/长度）。给 q 或 uid 取正文。',
      };
    }
    const byUid = list.find(x => x.uid === q);
    if (byUid) return { 命中: [byUid] };
    const hits = list.filter(x => [x.标题, ...x.关键词, x.内容].join(' ').includes(q));
    return { q, 命中: hits.length, 词条: hits.slice(0, clamp(a?.top_k || 5, 1, 20)), note: hits.length ? undefined : '换个关键词试试；不带 q 可看全部词条目录' };
  }},
  doc: { run: async (a) => {
    const p = pickChar(a?.name ?? '');
    if (p.err) return p.err;
    const c = p.char;
    const kind = a?.kind === 'prompt' ? 'prompt' : 'model';
    let rel;
    if (kind === 'model') {
      rel = c.doc;
      if (!rel) return { error: `${c.name_short} 未登记模型文档路径` };
    } else {
      const hit = PROMPT_FILES.find(f => f.startsWith(c.name_short + '_'));
      if (!hit) return { error: `${c.name_short} 没有系统提示词文件`, 现有: PROMPT_FILES.map(f => f.replace(/_系统提示词\.md$/, '')) };
      rel = join('角色模型', '系统提示词', hit);
    }
    const abs = resolve(WS, rel);
    if (!existsSync(abs)) return { error: `文件不存在：${rel}`, 提示: '跑 audit_models.mjs 看资产缺口' };
    const text = readFileSync(abs, 'utf8');
    const cap = clamp(a?.max_chars || 6000, 500, 60000);
    const maxForKind = kind === 'model' ? 60000 : 20000;
    return {
      name: c.name_short, kind, file: rel, 总字数: text.length, 返回字数: Math.min(text.length, cap, maxForKind),
      truncated: text.length > Math.min(cap, maxForKind),
      content: text.slice(0, Math.min(cap, maxForKind)),
      说明: kind === 'model' ? '完整《角色扮演模型》（事实层+语言层+使用说明）；被截断时用 max_chars 续取（上限 60000）' : '可直接粘贴给模型的系统提示词（上限 20000 字）',
    };
  }},
  skills: { run: async (a) => {
    const root = resolve(WS, '人设skill');
    let dirs;
    try { dirs = readdirSync(root).filter(f => existsSync(join(root, f, 'SKILL.md'))); }
    catch { return { error: '人设skill/ 目录不存在或不可读', 提示: '该工具读取工作区根下 人设skill/，确认已并入并提交' }; }
    const byBand = a?.band;
    const out = [];
    for (const id of dirs.sort()) {
      const c = kb.characters.find(x => x.id === id);
      let mech = null;
      try { const md = readFileSync(join(root, id, 'SKILL.md'), 'utf8'); const m = md.match(/^##\s+(.+?)（招牌机制）/m); if (m) mech = m[1].trim(); } catch {}
      const band = c?.band || null;
      if (byBand && band !== byBand) continue;
      out.push({ id, 角色: c?.name_short || id, 乐队: band, 招牌机制: mech, 触发: `/${id}` });
    }
    return { 总数: out.length, skills: out, 说明: 'name 传 id 或角色名/别名给 skill 工具取正文；文件夹名 = canon 角色 id' };
  }},
  skill: { run: async (a) => {
    const name = a?.name || '';
    if (!name) return { error: '需要 name（角色名/别名/id，如 祥子/sakiko/小祥）' };
    const p = pickChar(name);
    const id = p.char ? p.char.id : name;
    const root = resolve(WS, '人设skill', id);
    if (!existsSync(root)) return { error: `没有人设skill：${name}`, 提示: '用 skills 工具看现有 id 列表' };
    const part = a?.part || 'skill';
    const cap = clamp(a?.max_chars || 8000, 500, 60000);
    const readRel = (rel) => { const abs = join(root, rel); if (!existsSync(abs)) return null; const t = readFileSync(abs, 'utf8'); return { file: `人设skill/${id}/${rel}`, 总字数: t.length, 返回字数: Math.min(t.length, cap), truncated: t.length > cap, content: t.slice(0, cap) }; };
    if (part === 'all') {
      return { id, 角色: p.char?.name_short || id, parts: { skill: readRel('SKILL.md'), lines: readRel(join('references', 'lines.md')), lore: readRel(join('references', 'lore.md')), yaml: readRel(join('agents', 'openai.yaml')) } };
    }
    const rel = part === 'lines' ? join('references', 'lines.md') : part === 'lore' ? join('references', 'lore.md') : part === 'yaml' ? join('agents', 'openai.yaml') : 'SKILL.md';
    const r = readRel(rel);
    if (!r) return { error: `文件不存在：人设skill/${id}/${rel}` };
    return { id, 角色: p.char?.name_short || id, part, ...r };
  }},
};
