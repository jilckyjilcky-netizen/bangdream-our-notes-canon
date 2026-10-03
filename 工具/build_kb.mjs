#!/usr/bin/env node
/**
 * build_kb.mjs —— 生成结构化资料库 资料库/kb.json
 *
 * 三层合并：
 *  1) 自动抽取：角色简介（事实表）、10人指纹报告（语言指标）、模型文档（台词弹药库）
 *  2) 手工策展：_kb_curated.mjs（性格内核/关系/事件/场所/物件/关键词）
 *  3) 扁平索引：每个实体一条可全文检索的 searchText
 *
 * 用法：node build_kb.mjs   （零依赖，输出 资料库/kb.json）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { curated } from './_kb_curated.mjs';
import { WS } from './_root.mjs';

const ROOT = WS;
mkdirSync(join(ROOT, '资料库'), { recursive: true });
const U = (...p) => join(ROOT, ...p);
const read = p => existsSync(p) ? readFileSync(p, 'utf8') : null;

/* ---------- 角色文件映射 ---------- */
const CHARS = [
  ['tomori', '灯_高松灯', 'MyGO!!!!!'], ['anon', '爱音_千早爱音', 'MyGO!!!!!'], ['taki', '立希_椎名立希', 'MyGO!!!!!'],
  ['soyo', '爽世_长崎爽世', 'MyGO!!!!!'], ['rana', '乐奈_要乐奈', 'MyGO!!!!!'],
  ['sakiko', '祥子_丰川祥子', 'Ave Mujica'], ['uika', '初华_三角初华', 'Ave Mujica'],
  ['mutsumi', '睦_若叶睦', 'Ave Mujica'], ['umiri', '海铃_八幡海铃', 'Ave Mujica'], ['nyamu', '若麦_祐天寺若麦', 'Ave Mujica'],
];

/* ── 增量：后补 15 人（模型与指纹已与 10 人合并，见 角色模型/ 下各乐队目录）──
 * 来源 资料库/_curated_extra.json（由 订单队列/收集_补齐产物.mjs 写）。
 * 该文件不存在时，本脚本行为与从前完全一致（只出 10 人）。 */
const EXTRA = join(ROOT, '资料库', '_curated_extra.json');
let extra = { chars: {}, worldbook: [] };
try {
  if (existsSync(EXTRA)) extra = JSON.parse(readFileSync(EXTRA, 'utf8'));
} catch (e) { console.error('⚠ _curated_extra.json 读取失败，只生成 10 人：' + e.message); }

/* ── 全量语料台词库（工具/corpus_attribute.mjs 产物）──
 * 存在时**优先于**《角色扮演模型》里手挑的引文：模型文档引文是人工精选，
 * 薄样本角色因此失真（爽世仅 9 条）。全量归属后每角色可达上限 30 条真实台词。 */
let QUOTES_FULL = null;
try {
  const qf = read(U('资料库', '_quotes_full.json'));
  if (qf) QUOTES_FULL = JSON.parse(qf).quotes || null;
} catch (e) { console.error('⚠ _quotes_full.json 读取失败，回退模型文档引文：' + e.message); }

/** 统一成 { id, base, band, fpRel, docDirRel } —— 路径一律用正斜杠（跨平台且可直接写进文档）
 *  2026-09-26 合并后：模型文档按乐队分目录，指纹统一在 角色模型/指纹/ */
const BAND_DIR = {
  // 注意：本文件的 CHARS 里 MyGO 写的是 'MyGO!!!!!'（带感叹号），
  // 而 订单队列/角色表.mjs 里写的是 'MyGO'——两种都收，免得再踩。
  'MyGO': 'MyGO', 'MyGO!!!!!': 'MyGO', 'Ave Mujica': 'AveMujica',
  '梦限大MewType': '梦限大MewType', 'millsage': 'millsage', '一家Dumb Rock': '一家DumbRock',
};
const dirOf = e => BAND_DIR[e._band] || BAND_DIR[CHARS.find(x => x[0] === e.id)?.[2]] || String(e._band || '').replace(/ /g, '');

const ROSTER = [
  ...CHARS.map(([id, base, band]) => ({ id, base, band, fpRel: '角色模型/指纹', docDirRel: '角色模型/' + BAND_DIR[band] })),
  ...Object.entries(extra.chars || {}).map(([id, e]) => ({
    id, base: `${e._short}_${e._full}`, band: e._band || '',
    fpRel: '角色模型/指纹',
    docDirRel: '角色模型/' + dirOf(e),
  })),
];

/* ---------- 解析：角色简介事实表 ---------- */
function parseProfile(file) {
  const t = read(file); if (!t) return null;
  const rows = {}; let bio = '', tagline = '', band = '', role = '';
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/);
    if (m) rows[m[1].trim()] = m[2].trim();
    const h = line.match(/^>\s*(.+?)\s*｜\s*(.+?)\s*｜/);
    if (h) { band = h[1].trim(); role = h[2].trim(); }
    const b = line.match(/^\*\*角色简介\*\*[：:]\s*(.+)$/);
    if (b) bio = b[1].trim();
    const t2 = line.match(/^\*\*宣传语\*\*[：:]\s*(.+)$/);
    if (t2) tagline = t2[1].trim();
  }
  return { band, role, rows, bio, tagline };
}

/* ---------- 解析：语言指纹报告 ---------- */
function parseFingerprint(file) {
  const t = read(file); if (!t) return null;
  const fp = { metrics: {}, calls: {}, addrs: {} };
  const lines = t.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = l.match(/^\|\s*(\d+(?:\.\d+)?)[（(]/);
    if (m) {
      const row = l.split('|').map(x => x.trim());
      fp.metrics['句长均值(汉字)'] = row[1];
      if (row[2] !== undefined && /^\d+$/.test(row[2])) fp.metrics['句长中位数'] = row[2];
      if (row[3] !== undefined && /^\d+$/.test(row[3])) fp.metrics['最长句'] = row[3];
      if (row[4] !== undefined) fp.metrics['≤6字占比'] = row[4];
    }
    m = l.match(/^\|\s*含省略号…\s*\|\s*([\d/]+ = [\d.]+%)/); if (m) fp.metrics['省略号率'] = m[1];
    m = l.match(/^\|\s*以…结尾\s*\|\s*([\d/]+ = [\d.]+%)/); if (m) fp.metrics['以…结尾'] = m[1];
    m = l.match(/^\|\s*以？结尾\s*\|\s*([\d/]+ = [\d.]+%)/); if (m) fp.metrics['以?结尾'] = m[1];
    m = l.match(/^\|\s*以！结尾\s*\|\s*([\d/]+ = [\d.]+%)/); if (m) fp.metrics['以!结尾'] = m[1];
    m = l.match(/^\|\s*疑问率\s*\|\s*([\d/]+ = [\d.]+%)/); if (m) fp.metrics['疑问率'] = m[1];
    m = l.match(/^\|\s*感叹率\s*\|\s*([\d/]+ = [\d.]+%)/); if (m) fp.metrics['感叹率'] = m[1];
    m = l.match(/^\|\s*单字重复口吃[^|]*\|\s*([\d/]+ = [\d.]+%)/); if (m) fp.metrics['口吃率'] = m[1];
    m = l.match(/^\|\s*呼称「小X」[^|]*\|\s*([\d/]+ = [\d.]+%)/); if (m) fp.metrics['小X呼称率'] = m[1];
    m = l.match(/^\|\s*含「我」\s*\|\s*([\d/]+ = [\d.]+%)/); if (m) fp.metrics['含我率'] = m[1];
    m = l.match(/- \*\*纯省略号（只含…）\*\*：([\d/]+ = [\d.]+%)/); if (m) fp.metrics['纯沉默占比'] = m[1];
    m = l.match(/- 条数 \d+ ｜ 均长 ([\d.]+|—) ｜ 最长 \d+ ｜ 省略号率 ([\d.]+%) ｜ 疑问率 ([\d.]+%)/);
    if (m) fp.metrics['歌词均长'] = m[1], fp.metrics['歌词省略号率'] = m[2], fp.metrics['歌词疑问率'] = m[3];
    const c = l.match(/^-\s*((?:小|大)[\u4e00-\u9fa5]{1,3}|Tomorin|[A-Za-z]+)\s*×\s*(\d+)/);
    if (c) fp.addrs[c[1]] = +c[2];
  }
  // 呼称表（| 对象 | 称呼 |...）跳过；呼称以 addrs 为主
  return fp;
}

/* ---------- 解析：全角色指纹对比表（疑问率/感叹率来源） ----------
 * 指纹报告里没有「| 疑问率 |」这一行（写的是「含疑问「吗/呢/吧」」），
 * 主角色报告也没有「| 感叹率 |」行（只有配角报告有），
 * 所以这两项改从 角色模型/_全角色指纹对比.md 取——该表有独立「疑问率」「感叹率」列
 * （疑问率口径与回测一致：行内含「？」的比率，已在交接 §五 复核）。
 * 返回 { 疑问率: 全名→值, 感叹率: 全名→值 }（表内原样数值字符串，如 '34.2'）。 */
function parseCompareTable(file) {
  const t = read(file); if (!t) return {};
  const out = { 疑问率: {}, 感叹率: {} };
  let header = null;
  for (const line of t.split(/\r?\n/)) {
    const cells = line.split('|').map(x => x.trim());
    if (cells.length < 7) continue;
    if (!header && cells[1] === '角色' && cells.includes('疑问率')) { header = cells; continue; }
    if (!header) continue;
    if (!/^[\u4e00-\u9fa5]{2,6}$/.test(cells[1] || '')) continue;
    for (const metric of ['疑问率', '感叹率']) {
      const idx = header.indexOf(metric);
      if (idx > 0 && cells[idx] && /^\d+(\.\d+)?$/.test(cells[idx])) out[metric][cells[1]] = cells[idx];
    }
  }
  return out;
}

/* ---------- 解析：模型文档台词弹药库（> 「…」行） ---------- */
function parseQuotes(doc) {
  const t = read(doc); if (!t) return [];
  const out = [];
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^>\s*「([^」]+)」/);
    if (m && m[1].replace(/[「」…\s]/g, '').length >= 2) out.push(m[1]);
  }
  // 去重、取最长前 30
  const uniq = [...new Set(out)];
  return uniq.sort((a, b) => b.length - a.length).slice(0, 30);
}

/* ---------- 组装 ---------- */
const compareT = parseCompareTable(U('角色模型', '_全角色指纹对比.md'));
const characters = [];
for (const { id, base, band: dfltBand, fpRel, docDirRel } of ROSTER) {
  const cur = curated.chars[id] || extra.chars[id] || {};
  const prof = parseProfile(U('素材全量', '角色简介', 'zh-Hans', base + '.md'));
  const fp = parseFingerprint(U(fpRel, base + '_语言指纹报告.md'));
  if (fp) {
    // 疑问率/感叹率：从全角色对比表补（口径与回测一致）。全名先试 cur._full（后补 15 人），
    // base 一律是「短名_全名」，下划线后半段兜底。表内 25 人全有行。
    const full = cur._full || base.split('_')[1];
    if (full) {
      for (const metric of ['疑问率', '感叹率']) {
        if (compareT[metric][full] !== undefined) fp.metrics[metric] = compareT[metric][full];
      }
    }
  }
  const quotes = QUOTES_FULL?.[id] || parseQuotes(U(docDirRel, base + '_角色扮演模型.md'));
  characters.push({
    id, name: prof?.rows['简称'] + '（' + (prof?.rows['英文名'] || cur.en || '') + '）' || base.split('_')[0],
    name_short: prof?.rows['简称'] || base.split('_')[0],
    en: cur.en, aliases: cur.aliases, stage: cur.stage,
    band: prof?.band || dfltBand, role: prof?.role || prof?.rows['担当'] || '',
    basic: prof?.rows || {},
    bio: prof?.bio || '', tagline: prof?.tagline || '',
    personality: { core: cur.core, desire: cur.desire, fear: cur.fear, defense: cur.defense, arc: cur.arc },
    likes_interests: [prof?.rows['喜欢的东西'], prof?.rows['兴趣']].filter(Boolean),
    speech: fp?.metrics || {}, addresses: fp?.addrs || {},
    quote_bank: quotes,
    states: cur.states, relations: cur.relations, bans: cur.bans, keywords: cur.keywords,
    events: curated.events.filter(e => e.participants?.some(p => p.includes(cur.name_short) || cur.aliases?.includes(p))).map(e => e.id),
    doc: docDirRel + '/' + base + '_角色扮演模型.md'
  });
}

/* ---------- 扁平索引 ---------- */
function flat(obj) { return Object.values(obj).join(' '); }
const index = {};
for (const c of characters) index[c.id] = [c.name_short, c.en, (c.aliases||[]).join(' '), c.band, c.role, c.bio, c.personality.core, c.personality.arc, (c.keywords||[]).join(' '), (c.relations||[]).map(r=>r.with+' '+r.tone).join(' '), (c.states||[]).map(s=>s.name+' '+s.keys.join(' ')).join(' ')].join(' ');
for (const e of curated.events) index[e.id] = [e.name, (e.participants||[]).join(' '), e.summary, (e.keywords||[]).join(' '), (e.episodes||[]).join(' ')].join(' ');
for (const p of curated.places) index[p.id] = [p.name, p.summary, (p.keywords||[]).join(' ')].join(' ');
for (const it of curated.items) index[it.id] = [it.name, it.kind, it.summary, (it.keywords||[]).join(' ')].join(' ');

const kb = {
  meta: {
    title: 'BanG Dream! Our Notes 资料库（MyGO!!!!! / Ave Mujica / 梦限大MewType / millsage / 一家Dumb Rock）',
    data_version: 'e36a8be5d83e',
    generated: new Date().toISOString(),
    toolchain: ['工具/corpus_attribute.mjs', '工具/fingerprint_full.mjs', '工具/persona_stats.mjs', '工具/persona_compare.mjs', '工具/build_kb.mjs'],
    schema: { characters: String(characters.length), events: curated.events.length, places: curated.places.length, items: curated.items.length }
  },
  characters, events: curated.events, places: curated.places, items: curated.items,
  index
};

const file = join(ROOT, '资料库', 'kb.json');
writeFileSync(file, JSON.stringify(kb, null, 2), 'utf8');
console.log('已生成 ' + file);
console.log(`角色 ${characters.length} ｜ 事件 ${curated.events.length} ｜ 场所 ${curated.places.length} ｜ 物件 ${curated.items.length} ｜ 台词 ${characters.reduce((a,c)=>a+c.quote_bank.length,0)} 条`);