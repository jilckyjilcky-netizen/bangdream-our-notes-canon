#!/usr/bin/env node
/**
 * corpus_attribute.mjs —— 素材全量/按话/zh-Hans（946 话）按说话人**全量归属**
 *
 * 为什么需要：kb 的语言指纹此前取自「按角色」抽取物，《角色扮演模型》里手挑的引文只有
 * 数条到数十条（爽世 quote_bank 仅 9 条），薄样本角色的指纹与台词库因此失真。
 * 本脚本把全量说话人行按说话人归属，落一份 dense 语料（空间换时间），供
 * fingerprint_full.mjs / build_kb.mjs 直接消费，不必每次重解析 946 个文件。
 *
 * 产出：
 *   素材全量/按角色全量/zh-Hans/{短名}_{全名}.md   每角色归属后的完整台词合集（persona_stats 兼容版式）
 *   素材全量/按角色全量/_未归属.md                 未归属说话人审计
 *   资料库/_corpus_index.json                      每角色条数/剧本数/口径
 *   资料库/_quotes_full.json                       每角色台词库（真实语料，id 为种子的可复现抽样，上限 30 条）
 *
 * 归属口径（严格**精确匹配**，不做子串猜测——避免「祥子的声音」被算成祥子）：
 *   · 键 = kb 简称/全名/别名 + aliases.json 官方 real/日文短名/舞台名；归一化后精确命中
 *   · 联句「灯・爽世」按 ・ 拆开，**计入双方**
 *   · 排除 NO_MERGE：初音（独立人物「三角初音」，见主线 10037/10038）、小萤（aliases.json keepSeparate）
 *   · 排除 genericRoles（经纪人/店员/旁白…）与未命中标签 → 记入 _未归属.md
 *
 * 用法：node 工具/corpus_attribute.mjs [--dry]     （--dry 只打印普查结果，不写任何文件）
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { WS } from './_root.mjs';

const DRY = process.argv.includes('--dry');
const SRC = join(WS, '素材全量', '按话', 'zh-Hans');
const OUT_ROOT = join(WS, '素材全量', '按角色全量');
const OUT_DIR = join(OUT_ROOT, 'zh-Hans');
const LIB = join(WS, '资料库');
const KB = JSON.parse(readFileSync(join(LIB, 'kb.json'), 'utf8'));
const ALIAS = JSON.parse(readFileSync(join(WS, '工具', '素材提取', 'aliases.json'), 'utf8'));
const SEP = ALIAS.speakerSeparator || '・';

const norm = (s) => String(s ?? '')
  .normalize('NFKC')
  .replace(/[『』「」（）()［］\[\]]/g, '')
  .replace(/[\s\u3000]/g, '')
  .replace(/[？?！!。．.]+$/, '');

const NO_MERGE = new Set(['初音', ...(ALIAS.keepSeparate || [])].map(norm));
const GENERIC = new Set((ALIAS.genericRoles || ['旁白']).map(norm));

/* ---------- 花名册：kb 30 人（base = 角色模型文件名去掉后缀） ---------- */
const roster = KB.characters.map((c) => {
  const m = String(c.doc || '').match(/([^/\\]+)_角色扮演模型\.md$/);
  const base = m ? m[1] : `${c.name_short}_${c.name_short}`;
  const parts = base.split('_');
  return {
    id: c.id, short: c.name_short, full: parts.slice(1).join('_') || c.name_short, base,
    aliases: c.aliases || [], items: [], scripts: new Set(),
  };
});

/* ---------- 说话人键表 ---------- */
const byKey = new Map();
function addKey(key, ch) {
  const k = norm(key);
  if (!k || NO_MERGE.has(k) || GENERIC.has(k)) return;
  if (!byKey.has(k)) byKey.set(k, ch);
}
for (const ch of roster) {
  addKey(ch.short, ch);
  addKey(ch.full, ch);
  for (const a of ch.aliases) addKey(a, ch);
}
for (const a of ALIAS.characters || []) {
  const ch = roster.find((r) => r.short === a.short);
  if (!ch) continue;
  addKey(a.real, ch);
  addKey(a.shortJa, ch);
  addKey(a.stageName, ch);
}
for (const [stage, short] of Object.entries(ALIAS.stageNameToShort || {})) {
  const ch = roster.find((r) => r.short === short);
  if (ch) addKey(stage, ch);
}

/* ---------- 按话文件解析 ---------- */
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.md')) out.push(p);
  }
  return out;
}

const RE_HEAD = /^>\s*\*\*advId\*\*/;
const RE_UTT = /^\*\*(.+?)\*\*[：:]([\s\S]*)$/;
const RE_CHAT = /^>\s*\*\*(.+?)\*\*(?:〔.*?〕)?[：:]([\s\S]*)$/;

function parseEpisode(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  let title = basename(path, '.md'), cat = '', advId = '';
  const items = [];
  let cur = null;
  const flush = () => { if (cur) { items.push(cur); cur = null; } };
  for (const line of lines) {
    if (/^#\s/.test(line)) { title = line.replace(/^#\s+/, '').trim(); continue; }
    if (RE_HEAD.test(line)) {
      const a = line.match(/\*\*advId\*\*\s*(\d+)/); if (a) advId = a[1];
      const c = line.match(/\*\*分类\*\*\s*([^｜|]+)/); if (c) cat = c[1].trim();
      flush(); continue;
    }
    if (/^\*〔/.test(line)) { flush(); continue; }          // telop：跳过
    if (/^>/.test(line)) {                                   // 聊天行（build.mjs 的 chat）
      const m = line.match(RE_CHAT);
      if (m) { flush(); cur = { who: m[1].trim(), text: m[2], advId }; } else flush();
      continue;
    }
    const u = line.match(RE_UTT);
    if (u) { flush(); cur = { who: u[1].trim(), text: u[2], advId }; continue; }
    if (line.trim() === '' || /^---/.test(line)) { flush(); continue; }
    if (cur) cur.text += '\n' + line.replace(/\s+$/, '');
  }
  flush();
  return { title, cat, advId, items };
}

/* ---------- 归属 ---------- */
const files = walk(SRC).sort();
const unmapped = new Map();
const skipped = new Map();
let totalUtt = 0, mappedUtt = 0, dupUtt = 0;

for (const f of files) {
  const ep = parseEpisode(f);
  for (const it of ep.items) {
    totalUtt++;
    const names = [...new Set(String(it.who).split(SEP).map((x) => x.trim()).filter(Boolean))];
    const hits = [];
    for (const n of names) {
      const ch = byKey.get(norm(n));
      if (ch) { if (!hits.includes(ch)) hits.push(ch); }
      else if (GENERIC.has(norm(n))) skipped.set(n, (skipped.get(n) || 0) + 1);
      else unmapped.set(n, (unmapped.get(n) || 0) + 1);
    }
    if (!hits.length) continue;
    if (hits.length > 1) dupUtt++;
    for (const ch of hits) {
      ch.items.push({ advId: Number(it.advId) || 0, title: ep.title, cat: ep.cat, text: it.text });
      ch.scripts.add(it.advId);
    }
    mappedUtt++;
  }
}

/* ---------- 条目分类 + 台词库 ---------- */
const flat = (s) => String(s).replace(/\n/g, '');
const isLyric = (s) => /^『[\s\S]*』$/.test(s.trim()) || /^[『♪♪]/.test(s.trim());
const isSilent = (s) => /^[…\s]*$/.test(s) && /…/.test(s);
const isSilentP = (s) => /^[…\s、，。？！?！]*$/.test(s) && /…/.test(s) && !isSilent(s);
const isThought = (s) => /^（[\s\S]*）$/.test(s.trim());
const kindOf = (s) => {
  const t = flat(s);
  return isLyric(t) ? 'lyric' : isThought(t) ? 'thought'
    : isSilent(t) ? 'silent' : isSilentP(t) ? 'silentp' : 'speech';
};

const quotes = {};
const index = [];

/* 抽样：与 canon-tools.mjs 的 seededSample 同算法 —— 同 id 结果可复现，且**无长度偏置**
 * （最早一版按「最长 30 条」选，把测试池/风格范本整体拉向长句，bench 因此掉了一半）。 */
const seedInt = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const seededSample = (arr, n, seed) => {
  const rnd = mulberry32(seedInt(seed));
  const p = [...arr];
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  return p.slice(0, Math.min(n, p.length));
};

for (const ch of roster) {
  ch.items.sort((a, b) => a.advId - b.advId);
  const speech = ch.items.filter((i) => kindOf(i.text) === 'speech');
  const uniq = [...new Set(speech.map((i) => flat(i.text)))];
  const pool = uniq.filter((t) => t.replace(/[「」…\s]/g, '').length >= 2).sort();
  const bank = seededSample(pool, 30, ch.id);
  quotes[ch.id] = bank;
  index.push({
    id: ch.id, short: ch.short, full: ch.full, base: ch.base,
    条数: ch.items.length, 台词: speech.length, 剧本: ch.scripts.size, quote_bank: bank.length,
  });
}

/* ---------- 写盘 ---------- */
function writeDense(ch) {
  if (!ch.items.length) return 0;
  const byScript = new Map();
  for (const it of ch.items) {
    if (!byScript.has(it.advId)) byScript.set(it.advId, { title: it.title, cat: it.cat, items: [] });
    byScript.get(it.advId).items.push(it.text);
  }
  const L = [];
  L.push(`# ${ch.full}（${ch.short}） — 台词合集（按话全量归属）`, '');
  L.push(`> **${ch.items.length} 条** ｜ 出自 **${byScript.size}** 个剧本 ｜ 语言 zh-Hans ｜ 来源 \`素材全量/按话/zh-Hans\` 全量 ｜ 归属 \`工具/corpus_attribute.mjs\``);
  L.push('> 口径：简称/全名/别名/舞台名**精确匹配**；联句「A・B」计入双方；初音（独立人物）、小萤（keepSeparate）不并入', '');
  L.push('## 出处目录', '');
  for (const [advId, g] of byScript) L.push(`- ${g.cat} · ${g.title}（advId ${advId}）— ${g.items.length} 条`);
  L.push('', '---', '');
  for (const [advId, g] of byScript) {
    L.push(`## ${g.title}  \n<sub>${g.cat} ｜ advId ${advId}</sub>`, '');
    for (const t of g.items) L.push(`- ${t.replace(/\n/g, '  \n')}`);
    L.push('');
  }
  writeFileSync(join(OUT_DIR, `${ch.base}.md`), L.join('\n'), 'utf8');
  return ch.items.length;
}

function writeAudit() {
  const L = [];
  L.push('# 按话全量归属 · 未归属说话人审计', '');
  L.push(`- 来源 \`素材全量/按话/zh-Hans\` ｜ 说话人行 **${totalUtt}** 条 ｜ 生成 ${new Date().toISOString()}`);
  L.push(`- 已归属 **${mappedUtt}** 条（${(100 * mappedUtt / Math.max(totalUtt, 1)).toFixed(1)}%）｜ 未归属 **${[...unmapped.values()].reduce((a, b) => a + b, 0)}** 条 ｜ 设计内跳过（genericRoles）**${[...skipped.values()].reduce((a, b) => a + b, 0)}** 条`);
  L.push(`- 联句（多人同说，计入各方）：${dupUtt} 条`, '');
  L.push('## 设计内跳过（genericRoles：配角/旁白等，不归属）', '');
  for (const [k, v] of [...skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) L.push(`- ${k} × ${v}`);
  L.push('', '## 未归属（疑似漏映射，按次数降序）', '');
  for (const [k, v] of [...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80)) L.push(`- ${k} × ${v}`);
  L.push('', '## 明确不合并（口径决定）', '');
  L.push('- **初音**：主线 `10037`/`10038` 中自陈「我父亲是丰川定治」，是**独立人物三角初音**，不并入初华；kb 里「初音」仅作查询别名保留。');
  L.push('- **小萤**：`素材提取/aliases.json` 的 `keepSeparate` 指定保持独立。');
  L.push('- **旁白 / 经纪人 / 店员 等**：`genericRoles`，非角色。');
  writeFileSync(join(OUT_ROOT, '_未归属.md'), L.join('\n'), 'utf8');
}

const totalMapped = index.reduce((a, b) => a + b.条数, 0);
if (DRY) {
  console.log(`[dry] 说话人行 ${totalUtt} ｜ 已归属 ${mappedUtt}（${(100 * mappedUtt / Math.max(totalUtt, 1)).toFixed(1)}%）｜ 未归属 ${[...unmapped.values()].reduce((a, b) => a + b, 0)} ｜ generic 跳过 ${[...skipped.values()].reduce((a, b) => a + b, 0)}`);
  console.log(`[dry] 归属条数合计 ${totalMapped}（含联句重复计入）｜ 有语料的角色 ${index.filter((x) => x.条数 > 0).length}/30`);
  console.log('id | 短名 | 条数 | 台词 | 剧本 | quote_bank');
  for (const r of [...index].sort((a, b) => b.条数 - a.条数)) {
    console.log([r.id, r.short, r.条数, r.台词, r.剧本, r.quote_bank].join(' | '));
  }
  console.log('--- 未归属 TOP20 ---');
  for (const [k, v] of [...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${k} × ${v}`);
  console.log('--- generic TOP10 ---');
  for (const [k, v] of [...skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${k} × ${v}`);
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
let written = 0;
for (const ch of roster) if (writeDense(ch)) written++;
writeAudit();
writeFileSync(join(LIB, '_corpus_index.json'), JSON.stringify({
  generated: new Date().toISOString(),
  source: '素材全量/按话/zh-Hans（946 话全量归属）',
  rule: '简称/全名/别名/舞台名精确匹配；联句计入双方；初音与小萤不并入',
  totals: { 说话人行: totalUtt, 已归属: mappedUtt, 未归属: [...unmapped.values()].reduce((a, b) => a + b, 0) },
  characters: index,
}, null, 2), 'utf8');
writeFileSync(join(LIB, '_quotes_full.json'), JSON.stringify({
  generated: new Date().toISOString(),
  source: '素材全量/按话/zh-Hans（全量归属）',
  rule: '仅台词条目 · 去重 · 去「」…空白后 ≥2 汉字 · 以角色 id 为种子的可复现随机抽样，上限 30 条（与 canon-tools.seededSample 同算法，无长度偏置）',
  quotes,
}, null, 2), 'utf8');

console.log(`已写出 ${written} 份按角色全量语料 → ${OUT_DIR}`);
console.log(`说话人行 ${totalUtt} ｜ 已归属 ${mappedUtt} ｜ 归属条数 ${totalMapped}`);
console.log(`台词库 _quotes_full.json（30 人 · 上限 30 条）｜ 审计 素材全量/按角色全量/_未归属.md`);
