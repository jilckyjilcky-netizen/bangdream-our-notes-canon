#!/usr/bin/env node
/**
 * audit_models.mjs —— 角色模型资产完整性审计
 *
 * 回答一个问题：25 名乐队角色 ＋ 1 名附加角色（Sumimi 真奈）的产物，到底哪些齐了、哪些没跟上。
 * 只读，不改任何东西。
 *
 * 用法：node audit_models.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WS, CHARS, EXTRA_CHARS, corpusOf, modelOf, fpOf, spOf } from './角色表.mjs';

const rd = (p, d = '') => { try { return readFileSync(p, 'utf8'); } catch { return d; } };
const norm = s => s.replace(/[^\u4e00-\u9fa5]/g, '');

/* 与 verify_quotes.mjs 完全相同的引文校验逻辑（口径照搬） */
function quoteCheck(docPath, corpusPaths) {
  const corpus = corpusPaths.filter(existsSync).map(p => norm(rd(p))).join('\n');
  if (!corpus) return null;
  const doc = rd(docPath);
  const quotes = [...doc.matchAll(/「([^」\n]+)」/g)]
    .map(m => m[1].trim())
    .filter(q => norm(q).length >= 4)
    .filter((q, i, a) => a.indexOf(q) === i);
  let ok = 0; const miss = [];
  for (const q of quotes) {
    const segs = q.split(/[^\u4e00-\u9fa5]+/).filter(s => s.length >= 4);
    const target = segs.length ? segs.sort((a, b) => b.length - a.length)[0] : norm(q);
    if (corpus.includes(target)) ok++; else miss.push(q);
  }
  return { total: quotes.length, ok, miss };
}

/* 语料：主语料 + 台词补充（有则加）
 * 附加角色（真奈）的语料在「按角色全量」版式里，故用 c.corpus 覆盖默认路径。 */
const corpusPathsOf = c => [
  c.corpus ? join(WS, c.corpus) : corpusOf(c),
  join(WS, '素材全量', '角色台词补充', 'zh-Hans', '按角色', `${c.k}_${c.full}.md`),
];
const extractOf = c => join(WS, '角色模型', '提取', `${c.k}_${c.full}_签名时刻.md`);
const cardOf = c => join(WS, '角色卡', `${c.full}_character_card.json`);
const kb = JSON.parse(rd(join(WS, '资料库', 'kb.json'), '{}'));
const kbKeys = new Set(Object.keys(kb.characters || {}));
const kbBlob = JSON.stringify(kb.characters || {});
const wb = JSON.parse(rd(join(WS, '世界书', 'mygo_ave_世界书.json'), '{}'));
const wbKeys = new Set();
for (const e of Object.values(wb.entries || {})) for (const k of (e.keys || [])) wbKeys.add(k);

const W = (s, w) => { let n = 0, o = ''; for (const ch of String(s)) { const c = ch.codePointAt(0) > 0x2000 ? 2 : 1; if (n + c > w) break; n += c; o += ch; } return o + ' '.repeat(Math.max(0, w - n)); };
const Y = b => b ? '✓' : '✗';

const ALL = [...CHARS, ...EXTRA_CHARS];
console.log(`\n角色模型资产审计 · ${CHARS.length} 名乐队角色 ＋ ${EXTRA_CHARS.length} 名附加角色（${EXTRA_CHARS.map(c => c.full).join('、')}）\n`);
console.log(W('角色', 9) + W('代', 4) + W('模型', 6) + W('指纹', 6) + W('提取', 6) + W('提示词', 7) + W('角色卡', 7) + W('资料库', 7) + W('世界书', 7) + '引文校验');
console.log('-'.repeat(82));

const gaps = { model: [], fp: [], extract: [], sp: [], card: [], kb: [], wb: [], quote: [] };
for (const c of ALL) {
  const model = modelOf(c), fp = fpOf(c);
  const extract = extractOf(c);
  const has = { model: existsSync(model), fp: existsSync(fp), extract: existsSync(extract), sp: existsSync(spOf(c)), card: existsSync(cardOf(c)) };
  const inKb = kbKeys.has(c.k) || kbBlob.includes(c.full);
  const inWb = [...wbKeys].some(k => k === c.full || k === c.k);
  const q = has.model ? quoteCheck(model, corpusPathsOf(c)) : null;
  const qStr = q ? (q.miss.length ? `${q.ok}/${q.total} ⚠ ${q.miss.length} 未命中` : `${q.ok}/${q.total} 100%`) : '—';

  console.log(W(c.k, 9) + W(c.g, 4) + W(Y(has.model), 6) + W(Y(has.fp), 6) + W(Y(has.extract), 6) +
    W(Y(has.sp), 7) + W(Y(has.card), 7) + W(Y(inKb), 7) + W(Y(inWb), 7) + qStr);

  if (!has.model) gaps.model.push(c.k);
  if (!has.fp) gaps.fp.push(c.k);
  if (!has.extract) gaps.extract.push(c.k);
  if (!has.sp) gaps.sp.push(c.k);
  if (!has.card) gaps.card.push(c.k);
  if (!inKb) gaps.kb.push(c.k);
  if (!inWb) gaps.wb.push(c.k);
  if (q && q.miss.length) gaps.quote.push(`${c.k}(${q.miss.length})`);
}

console.log('-'.repeat(82));
const fmt = a => a.length ? `${a.length} 人：${a.join('、')}` : '无缺口';
console.log(`\n缺口清单`);
for (const [name, arr] of [['模型文档', gaps.model], ['语言指纹', gaps.fp], ['签名提取', gaps.extract],
  ['系统提示词', gaps.sp], ['SillyTavern 角色卡', gaps.card], ['资料库 kb.json', gaps.kb],
  ['世界书词条', gaps.wb], ['引文未命中', gaps.quote]]) {
  console.log(`  ${W(name, 22)} ${fmt(arr)}`);
}
console.log(`\n资料库总览：角色 ${Object.keys(kb.characters || {}).length} ｜ 事件 ${(kb.events || []).length} ｜ 场所 ${(kb.places || []).length} ｜ 物件 ${(kb.items || []).length}`);
console.log(`世界书词条 ${Object.keys(wb.entries || {}).length} 条`);
