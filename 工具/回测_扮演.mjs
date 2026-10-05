#!/usr/bin/env node
/**
 * 回测_扮演.mjs —— A/B 扮演回测打分（纯本地，不联网、零 token）
 *
 * 口径（与 工具/persona_check.mjs、工具/persona_compare.mjs / fingerprint_full.mjs 一致）：
 *   一句 = 语料里的一行台词（行级，交接计划 §三 已拍板）；句长 = 纯汉字；
 *   疑问率 / 感叹率 = **行内含「？」/「！」的比率**（persona_check.mjs L80 与对比表 PATTERNS 同一把尺）。
 * 真值默认取 角色模型/_全角色指纹对比.md 的行级登记值（= B 臂材料里那套数字），
 * 这样「回测量到的」与「文档写的」是同一口径；另可用 --truth=corpus 改回按语料现算，
 * 并始终打印两者漂移核对（旧条目口径的风险就露在这里）。
 *
 * 用法：
 *   node 工具/回测_扮演.mjs [--batch 扮演回测] [--one 单号] [--md] [--truth registered|corpus] [--剔除照抄 on|off]
 *   node 工具/回测_扮演.mjs --selftest          离线自测（造假批次 归档/_派发/_selftest/回测样例）
 * 读：归档/_派发/<batch>/out/<单号>/result.md   写：归档/_派发/<batch>/验证报告_扮演回测.md（--md）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { WS, CHARS, corpusOf } from './角色表.mjs';

const argv = process.argv.slice(2);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const BATCH = val('batch', '扮演回测');
const ONE = (() => { const i = argv.indexOf('--one'); return i < 0 ? null : argv[i + 1]; })();
const MD = argv.includes('--md');
const TRUTH = val('truth', 'registered');
const 剔除照抄 = val('剔除照抄', 'on') !== 'off';
const 批次目录 = join(WS, '归档', '_派发', BATCH);
const OUT = join(批次目录, 'out');

const rd = (p, d = '') => { try { return readFileSync(p, 'utf8'); } catch { return d; } };

/* ───────── 口径三件套（逐条对齐 persona_check.mjs） ───────── */
const hasCJK = (s) => /[\u4e00-\u9fa5]/.test(s);
const cjkLen = (s) => (s.match(/[\u4e00-\u9fa5]/g) || []).length;
const flat = (s) => s.replace(/\s/g, '');

function parseDialogue(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\*\*(.+?)\*\*[：:]\s*(.*)$/) || line.match(/^([\u4e00-\u9fa5]{1,6})[：:]\s*(.+)$/);
    if (m && m[2].trim()) out.push({ who: m[1].trim(), t: m[2].trim() });
  }
  return out;
}
/* 行级语料：一个物理行 = 一句；剔歌词（『♪）与心声（），保留纯省略号行 */
function parseCorpusLines(file) {
  const out = []; let skip = false;
  for (const l of rd(file).split(/\r?\n/)) {
    if (/^##\s/.test(l)) { skip = l.replace(/^##\s+/, '').trim() === '出处目录'; continue; }
    if (skip) continue;
    if (/^<sub>/.test(l) || /^#/.test(l) || /^>/.test(l) || /^---/.test(l) || /^\*\*/.test(l)) continue;
    if (/^-\s/.test(l)) { const t = flat(l.replace(/^-\s+/, '')); if (t && !/^[『♪]/.test(t) && !/^（/.test(t)) out.push(t); }
  }
  return out;
}
function metrics(lines) {
  const total = lines.length;
  const noText = lines.filter((t) => !hasCJK(t)).length;
  const sp = lines.filter(hasCJK);
  const n = sp.length || 1;
  const L = sp.map(cjkLen);
  const r = (c) => (c / n * 100);
  return {
    '无文字占比': noText / (total || 1) * 100,
    '平均句长(汉字)': L.reduce((a, b) => a + b, 0) / n,
    '≤6字占比': r(L.filter((x) => x <= 6).length),
    '省略号率': r(sp.filter((t) => /…/.test(t)).length),
    '疑问率': r(sp.filter((t) => /？/.test(t)).length),   // 行内含「？」——与对比表 PATTERNS['疑问率'] 同尺
    '感叹率': r(sp.filter((t) => /！/.test(t)).length),
    '口吃率': r(sp.filter((t) => /([\u4e00-\u9fa5])、\1/.test(t)).length),
    '「小X」呼称率': r(sp.filter((t) => /小[\u4e00-\u9fa5]/.test(t)).length),
  };
}
const KEYS = Object.keys(metrics(['测']));
const BANDS = {
  '省略号率': { abs: 15 }, '疑问率': { abs: 16 }, '感叹率': { abs: 18 }, '≤6字占比': { abs: 20 },
  '无文字占比': { abs: 10 }, '口吃率': { abs: 9 }, '「小X」呼称率': { abs: 16 }, '平均句长(汉字)': { rel: 0.55 },
};
const slackOf = (n) => (n >= 60 ? 1.0 : n >= 30 ? 1.3 : 1.7);
function judge(mine, canon, n) {
  const slack = slackOf(n);
  const rows = [];
  for (const k of KEYS) {
    const a = mine[k], b = canon[k], band = BANDS[k];
    let lo, hi, ok;
    if (band.rel) { lo = b * (1 - band.rel); hi = b * (1 + band.rel); ok = a >= lo && a <= hi; }
    else { lo = b - band.abs * slack; hi = b + band.abs * slack; ok = a >= lo && a <= hi; }
    const 判 = ok ? '达标' : (Math.abs(a - b) <= (band.abs ? band.abs * 1.6 * slack : b * band.rel * 1.6)) ? '警告' : '偏离';
    rows.push({ k, truth: b, gen: a, dev: Math.abs(a - b), lo, hi, 判 });
  }
  return { rows, slack };
}

/* ───────── 照抄检测：B 臂能拿到文档里的「台词弹药库」，照抄单的「达标」是假的 ───────── */
const norm = (s) => s.replace(/[\s。，、！？…~～—「」『』（）()]/g, '');
function copyStats(genLines, corpusLines) {
  const set = new Set(corpusLines.map(norm).filter((x) => x.length >= 4));
  const blob = corpusLines.map(norm).join('\n');
  let exact = 0, frag = 0; const hit = [];
  for (const g of genLines) {
    const x = norm(g);
    if (x.length < 4) continue;
    if (set.has(x)) { exact++; hit.push(g); }
    else if (blob.includes(x)) { frag++; hit.push(g); }
  }
  const n = genLines.filter((g) => norm(g).length >= 4).length || 1;
  return { exact: exact / n * 100, frag: frag / n * 100, total: (exact + frag) / n * 100, 命中: hit };
}

/* ───────── 真值：行级登记值（_全角色指纹对比.md） ───────── */
const 列映射 = { 均长: '平均句长(汉字)', '≤6字%': '≤6字占比', 沉默占比: '无文字占比', 呼称小X率: '「小X」呼称率', 省略号率: '省略号率', 疑问率: '疑问率', 感叹率: '感叹率', 口吃率: '口吃率' };
function 读登记表() {
  const md = rd(join(WS, '角色模型', '_全角色指纹对比.md'));
  if (!md) throw new Error('缺 角色模型/_全角色指纹对比.md（行级真值的权威源）');
  const map = {};
  let cols = null;
  for (const l of md.split(/\r?\n/)) {
    if (!/^\|/.test(l)) { cols = null; continue; }
    const cells = l.split('|').slice(1, -1).map((x) => x.trim());
    // 表与表之间以非 | 行断开；每张表的表头都重置 cols，避免后一张文本表按前一张列序错位取值
    if (cells[0] === '角色') { cols = cells; continue; }
    if (!cols || !cells[0] || /^-+$/.test(cells[0].replace(/:/g, ''))) continue;
    const row = {};
    cols.forEach((c, i) => {
      if (!列映射[c]) return;
      const v = Number(cells[i]);
      if (Number.isFinite(v)) row[列映射[c]] = v;
    });
    if (Object.keys(row).length === KEYS.length && !map[cells[0]]) map[cells[0]] = row;
  }
  return map;
}
const 登记表 = 读登记表();
const 角色们 = new Map(CHARS.map((c) => [c.k, c]));
const 语料缓存 = new Map();
const 语料行 = (k) => {
  if (!语料缓存.has(k)) {
    const c = 角色们.get(k);
    语料缓存.set(k, c ? parseCorpusLines(c.corpus ? join(WS, c.corpus) : corpusOf(c)) : []);
  }
  return 语料缓存.get(k);
};

/* ───────── 离线自测：造假批次（零网络、零 token），断言照抄剔除 / 行级口径 / 报告落盘 ───────── */
if (argv.includes('--selftest')) { selftest(); process.exit(process.exitCode || 0); }

function selftest() {
  const 断言 = [];
  const check = (name, cond, info = '') => 断言.push({ name, pass: !!cond, info: String(info) });
  const 目录 = join(WS, '归档', '_派发', '_selftest', '回测样例');
  rmSync(目录, { recursive: true, force: true });
  const 写单 = (id, lines) => {
    mkdirSync(join(目录, 'out', id), { recursive: true });
    writeFileSync(join(目录, 'out', id, 'result.md'), lines.map((l) => `**灯**：${l}`).join('\n') + '\n', 'utf8');
  };
  const A句 = ['今天的风，有点吵。', '……', '是我，太自我中心了。', '我要组乐队。', '……', '你，在看我吗？', '话说不出口。', '我的重量……', '不是，你的错。', '为什么，一定要长大呢？', '好痛。', '这里，可以坐吗？'];
  const B句 = ['……', '我，大概是害怕吧。', '你要去哪里呢？', '好吵。', '对不起。', '也是呢。', '那个，可以给我吗？', '我，会努力的。', '别管我了。', '痛。', '我们，还没有结束。', '为什么？'];
  写单('A01-灯', A句);
  写单('B01-灯', B句);
  const 真句 = 语料行('灯').filter((l) => norm(l).length >= 4).slice(0, 12);
  写单('B02-灯', 真句);
  写单('A02-灯', A句.slice(0, 3));

  const run = (extra = []) => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--batch', '_selftest/回测样例', ...extra], { encoding: 'utf8' });
    return { out: (r.stdout || '') + (r.stderr || ''), code: r.status };
  };
  const 主 = run([]);
  check('照抄单被识别并从结论剔除', /^B02-灯.*照抄单\(剔除\)/m.test(主.out) && /进结论 2 单/.test(主.out), (主.out.match(/^B02-灯.*$/m) || [''])[0].trim());
  check('照抄告警点名单号并说明原因', /照抄单 1 个：B02-灯/.test(主.out) && /台词弹药库/.test(主.out), (主.out.match(/照抄单 1 个：.*/) || [''])[0]);
  check('句数<4 只提示、不判失败（沿用 跑道 闸门）', /^A02-灯.*样本不足\(3\)/m.test(主.out) && /只提示不判失败/.test(主.out), (主.out.match(/^A02-灯.*$/m) || [''])[0].trim());
  check('逐指标 A/B 偏离表输出 8 个指标', /逐指标平均绝对偏离/.test(主.out) && /「小X」呼称率/.test(主.out) && /平均句长\(汉字\)/.test(主.out), `指标 ${KEYS.length} 项`);
  check('逐角色配对 B−A 成对并给出结论', /逐角色配对/.test(主.out) && /已配对 1 人 \/ 25/.test(主.out), (主.out.match(/有效 \d+ ｜ 有害 \d+.*/) || [''])[0]);
  check('照抄单与样本不足单不进总体（进结论 2 = A01+B01）', /单指标达标率：A 盲测 \d+\.\d% ｜ B 处方 \d+\.\d%/.test(主.out), (主.out.match(/单指标达标率：.*/) || [''])[0]);
  check('口径核对（登记值 vs 语料现算）随行打印', /口径核对（同一角色/.test(主.out), (主.out.match(/口径核对[^\n]*/) || [''])[0].slice(0, 90));

  const 一 = run(['--one', 'A01-灯']);
  const 自算行 = readFileSync(join(目录, 'out', 'A01-灯', 'result.md'), 'utf8').split(/\r?\n/)
    .map((l) => (l.match(/^\*\*灯\*\*[：:](.*)$/) || [])[1]).filter((x) => x != null).map((s) => s.trim()).filter(Boolean);
  const 自算有字 = 自算行.filter((l) => /[\u4e00-\u9fa5]/.test(l));
  const 期望疑问 = (自算有字.filter((l) => /？/.test(l)).length / 自算有字.length * 100).toFixed(1);
  const 疑问行 = (一.out.match(/^疑问率\s+\S+\s+(\S+)/m) || [])[1];
  check('口径一致：疑问率 = 行内含「？」的比率（同 persona_check.mjs）', 疑问行 === 期望疑问, `--one 报 ${疑问行}｜独立按行重算 ${期望疑问}｜n=${自算有字.length}`);
  check('--one 打印逐指标区间与台词', /允许区间/.test(一.out) && /今天的风，有点吵/.test(一.out), `明细 ${一.out.split(/\r?\n/).length} 行`);
  check('行级真值取自对比表登记（表格解析不吃第二张文本表）', Object.keys(登记表).length >= 25 && 登记表['灯']?.['疑问率'] === 19.9 && !/NaN/.test(一.out), `登记 ${Object.keys(登记表).length} 人｜灯 疑问率 ${登记表['灯']?.['疑问率']}`);

  const 抄 = run(['--one', 'B02-灯']);
  check('--one 显示照抄命中句并声明剔除', /判为照抄单/.test(抄.out) && /照抄命中句/.test(抄.out), (抄.out.match(/逐字照抄 [^\n]*/) || [''])[0]);

  check('--truth=corpus 可切到本地按行现算', /真值口径：语料现算\(行级\)/.test(run(['--truth', 'corpus']).out), '');
  check('--剔除照抄 off 时照抄单回结论（进结论 3）', /进结论 3 单/.test(run(['--剔除照抄', 'off']).out), '');

  const 官报路径 = join(WS, '归档', '_派发', '扮演回测', '验证报告_扮演回测.md');
  const 报 = run(['--md']);
  const 文件 = join(目录, '验证报告_扮演回测.md');
  const md = existsSync(文件) ? readFileSync(文件, 'utf8') : '';
  check('--md 写出报告且含结论纪律', /# 扮演回测验证报告/.test(md) && /## 结论纪律/.test(md) && /## 逐角色配对 B − A/.test(md), 文件);
  check('不污染正式目录（交接.md §五 引用的旧路径未被覆盖）', !existsSync(官报路径) && /报告已写/.test(报.out), 官报路径);

  const 失败 = 断言.filter((a) => !a.pass);
  console.log('回测_扮演 离线自测（假批次 归档/_派发/_selftest/回测样例 ｜ 零网络、零 token）');
  console.log('-'.repeat(72));
  for (const a of 断言) console.log(`${a.pass ? '✓' : '✗'} ${a.name}${a.info ? `  ｜ ${a.info}` : ''}`);
  console.log('-'.repeat(72));
  console.log(`${断言.length - 失败.length}/${断言.length} 通过${失败.length ? '  ✗ 失败：' + 失败.map((f) => f.name).join('；') : ''}`);
  process.exitCode = 失败.length ? 1 : 0;
}

/* ───────── 逐单打分 ───────── */
if (!existsSync(OUT)) {
  console.log(`✗ 没有产出目录：${OUT}\n  先跑：node 工具/生成订单_扮演回测.mjs && node 工具/派发器.mjs --in 归档/_派发/${BATCH}/订单.jsonl --out 归档/_派发/${BATCH}/`);
  process.exit(1);
}
const results = [];
for (const id of readdirSync(OUT).sort()) {
  const m = id.match(/^([AB])(\d+)-(.+)$/);
  if (!m) continue;
  const [, arm, , ch] = m;
  const resPath = join(OUT, id, 'result.md');
  if (!existsSync(resPath)) continue;
  const raw = rd(resPath);
  const parsed = parseDialogue(raw);
  const 台词 = parsed.filter((x) => x.who === ch).map((x) => x.t);
  const 杂行 = raw.split(/\r?\n/).filter((l) => l.trim() && !/^\*\*.+?\*\*[：:]/.test(l) && !/^[\u4e00-\u9fa5]{1,6}[：:]/.test(l));
  const corpus = 语料行(ch);
  const 现算 = corpus.length ? metrics(corpus) : null;
  const 登记 = 登记表[ch] || null;
  const truth = (TRUTH === 'corpus' ? 现算 : 登记) || 现算 || 登记;
  if (!台词.length || !truth) { results.push({ id, arm, ch, n: 台词.length, 不足: '无台词或无真值', rows: [], copy: { total: 0, exact: 0, frag: 0, 命中: [] }, 杂行: 杂行.length, 台词 }); continue; }
  const mine = metrics(台词);
  const { rows, slack } = judge(mine, truth, 台词.length);
  const copy = copyStats(台词, corpus);
  results.push({
    id, arm, ch, n: 台词.length, rows, slack, copy, 杂行: 杂行.length, 台词,
    truth: TRUTH === 'corpus' ? '语料现算(行级)' : '对比表登记(行级)',
    口径漂移: 现算 && 登记 ? Object.fromEntries(KEYS.map((k) => [k, +Math.abs(现算[k] - 登记[k]).toFixed(1)])) : null,
    ok: rows.filter((r) => r.判 === '达标').length,
    warn: rows.filter((r) => r.判 === '警告').length,
    bad: rows.filter((r) => r.判 === '偏离').length,
    平均偏离: rows.reduce((s, r) => s + r.dev, 0) / rows.length,
    样本不足: 台词.length < 4,
    照抄单: 剔除照抄 && copy.total >= 30,
  });
}
if (!results.length) { console.log('out/ 里还没有任何 result.md——先跑派发器。'); process.exit(0); }

const W = (s, w) => { let n = 0, o = ''; for (const c of String(s)) { const c2 = c.codePointAt(0) > 0x2000 ? 2 : 1; if (n + c2 > w) break; n += c2; o += c; } return o + ' '.repeat(Math.max(0, w - n)); };
const sgn = (v) => (v > 0 ? '+' : '') + v;
const worstOf = (r) => r.rows.reduce((m2, x) => (x.dev > m2.dev ? x : m2), r.rows[0]);

/* ───────── --one：逐指标明细 ───────── */
if (ONE) {
  const r = results.find((x) => x.id === ONE) || results.find((x) => x.id.startsWith(ONE));
  if (!r) { console.log(`找不到已完成且匹配「${ONE}」的单（现有 ${results.length} 单）`); process.exit(1); }
  console.log(`\n扮演校验：${r.ch}  单号 ${r.id}  样本 n=${r.n} 句  容差 ×${r.slack || '—'}  真值口径：${r.truth || '—'}`);
  if (r.rows.length) {
    console.log(W('指标', 20) + W('真值', 10) + W('本次生成', 10) + W('允许区间', 18) + '判定');
    console.log('-'.repeat(66));
    for (const x of r.rows) console.log(W(x.k, 20) + W(x.truth.toFixed(1), 10) + W(x.gen.toFixed(1), 10) + W(`${x.lo.toFixed(1)} ~ ${x.hi.toFixed(1)}`, 18) + x.判);
    console.log('-'.repeat(66));
  }
  console.log(`逐字照抄 ${r.copy.exact.toFixed(1)}%（含片段 ${r.copy.total.toFixed(1)}%）${r.照抄单 ? '  ⚠ 判为照抄单：本次结论剔除它' : ''}`);
  if (r.copy.命中?.length) console.log('照抄命中句：\n' + r.copy.命中.map((x) => '  · ' + x).join('\n'));
  console.log(`格式杂行 ${r.杂行} 句${r.杂行 ? '（不算台词，只提示）' : ''}`);
  if (r.样本不足) console.log(`⚠ 样本不足（n=${r.n} < 4）：who/达标率在此样本量落在噪声区，只提示、不判失败`);
  console.log('\n台词：');
  for (const l of r.台词) console.log('  ' + l);
  process.exit(0);
}

/* ───────── 汇总（照抄单与样本不足单不进结论） ───────── */
const 可用 = results.filter((r) => !r.照抄单 && !r.样本不足 && r.rows.length);
const 剔除 = results.filter((r) => r.照抄单);
const 噪声 = results.filter((r) => r.样本不足 && !r.照抄单);
const rate = (arm) => { const rs = 可用.filter((r) => r.arm === arm); return rs.length ? (rs.reduce((s, r) => s + r.ok, 0) / (rs.length * KEYS.length) * 100).toFixed(1) + '%' : '—'; };
const mdev = (arm) => { const rs = 可用.filter((r) => r.arm === arm); return rs.length ? rs.reduce((s, r) => s + r.平均偏离, 0) / rs.length : NaN; };

console.log(`\n扮演回测打分 · 批次 ${BATCH} ｜ 已产 ${results.length} 单 ｜ 进结论 ${可用.length} 单 ｜ 真值口径：${TRUTH === 'corpus' ? '语料现算(行级)' : '对比表登记(行级)'}`);
console.log(W('单号', 14) + W('角色', 8) + W('句数', 6) + W('达标', 6) + W('警告', 6) + W('偏离', 6) + W('平均偏离', 10) + W('照抄', 8) + '备注');
console.log('-'.repeat(80));
for (const r of results) {
  const 标 = r.照抄单 ? '⚠ 照抄单(剔除)' : r.样本不足 ? `· 样本不足(${r.n})` : '';
  console.log(W(r.id, 14) + W(r.ch, 8) + W(r.n, 6) + W(r.ok ?? '—', 6) + W(r.warn ?? '—', 6) + W(r.bad ?? '—', 6) +
    W(r.平均偏离 != null ? r.平均偏离.toFixed(1) : '—', 10) + W(r.copy.total.toFixed(0) + '%', 8) + 标 + (r.杂行 ? ` 杂行${r.杂行}` : ''));
}
console.log('-'.repeat(80));
console.log(`单指标达标率：A 盲测 ${rate('A')} ｜ B 处方 ${rate('B')} ｜ B−A ${(() => { const a = parseFloat(rate('A')), b = parseFloat(rate('B')); return isFinite(a) && isFinite(b) ? sgn(+(b - a).toFixed(1)) + ' 点' : '—'; })()}`);
console.log(`平均偏离：A ${mdev('A').toFixed(2)} ｜ B ${mdev('B').toFixed(2)} ｜ B−A ${sgn(+(mdev('B') - mdev('A')).toFixed(2))}（负 = B 更贴真值）`);
if (剔除.length) console.log(`\n⚠ 照抄单 ${剔除.length} 个：${剔除.map((r) => `${r.id}(${r.copy.total.toFixed(0)}%)`).join('、')}\n  B 臂能拿到文档里的「台词弹药库」，这类单的「达标」是抄来的，已从上面两行统计中剔除。`);
if (噪声.length) console.log(`· 样本不足（句数<4）：${噪声.map((r) => r.id).join('、')} —— 只提示不判失败（沿用 跑道 闸门规则）。`);

/* ───────── 逐指标 A/B 偏离 ───────── */
const 指标表 = KEYS.map((k) => {
  const per = (arm) => { const rs = 可用.filter((r) => r.arm === arm); return rs.length ? rs.reduce((s, r) => s + r.rows.find((x) => x.k === k).dev, 0) / rs.length : NaN; };
  const a = per('A'), b = per('B');
  return { k, a, b, 判: !isFinite(a) || !isFinite(b) ? '—' : (b < a - 0.05 ? 'B 更准' : b > a + 0.05 ? 'B 更差' : '≈ 持平') };
});
console.log(`\n逐指标平均绝对偏离（每格 = |生成 − 真值| 的均值，越小越准）\n`);
console.log(W('指标', 20) + W('A 盲测', 12) + W('B 处方', 12) + 'B−A' + '  '.repeat(4) + '结论');
console.log('-'.repeat(66));
for (const x of 指标表) console.log(W(x.k, 20) + W(isFinite(x.a) ? x.a.toFixed(1) : '—', 12) + W(isFinite(x.b) ? x.b.toFixed(1) : '—', 12) + W(isFinite(x.a) && isFinite(x.b) ? sgn(+(x.b - x.a).toFixed(1)) : '—', 10) + x.判);
console.log('-'.repeat(66));

/* ───────── 逐角色配对 B − A ───────── */
const pairs = [];
for (const ch of [...new Set(可用.map((r) => r.ch))]) {
  const a = 可用.find((r) => r.ch === ch && r.arm === 'A');
  const b = 可用.find((r) => r.ch === ch && r.arm === 'B');
  if (!a || !b) continue;
  const dOk = b.ok - a.ok, dDev = b.平均偏离 - a.平均偏离;
  pairs.push({
    ch, band: (角色们.get(ch) || {}).band || '?', a, b, dOk, dDev,
    verdict: dOk >= 1 ? '文档有效' : dOk <= -1 ? '文档有害' : dDev < -0.5 ? '略改善' : dDev > 0.5 ? '略变差' : '持平',
    worstB: worstOf(b), worstA: worstOf(a),
  });
}
pairs.sort((x, y) => (y.dOk - x.dOk) || (x.dDev - y.dDev));
if (pairs.length) {
  console.log(`\n逐角色配对（Δ达标 = B达标 − A达标；Δ平均偏离 = B − A，负 = 更贴真值）\n`);
  console.log(W('角色', 10) + W('乐队', 14) + W('A达标', 7) + W('B达标', 7) + W('Δ达标', 7) + W('Δ偏离', 9) + W('结论', 10) + 'B 臂最偏指标（= 该文档最该改处）');
  console.log('-'.repeat(84));
  for (const p of pairs) console.log(W(p.ch, 10) + W(p.band, 14) + W(p.a.ok, 7) + W(p.b.ok, 7) + W(sgn(p.dOk), 7) + W(sgn(+p.dDev.toFixed(1)), 9) + W(p.verdict, 10) + `${p.worstB.k} 偏 ${p.worstB.dev.toFixed(1)}`);
  console.log('-'.repeat(84));
  const cnt = (v) => pairs.filter((p) => p.verdict === v).length;
  console.log(`有效 ${cnt('文档有效')} ｜ 有害 ${cnt('文档有害')} ｜ 略改善 ${cnt('略改善')} ｜ 略变差 ${cnt('略变差')} ｜ 持平 ${cnt('持平')}   （已配对 ${pairs.length} 人 / 25）`);
  const 未配 = CHARS.map((c) => c.k).filter((k) => !pairs.some((p) => p.ch === k));
  if (未配.length) console.log(`未成对（缺臂/照抄/样本不足）：${未配.join('、')}`);
}

/* ───────── 口径核对：登记值 vs 语料现算（行级） ───────── */
const 漂移 = [];
for (const r of 可用) if (r.口径漂移) for (const k of ['疑问率', '感叹率', '省略号率', '平均句长(汉字)']) if (r.口径漂移[k] > 5) 漂移.push(`${r.ch}.${k} 差 ${r.口径漂移[k]}`);
console.log(`\n口径核对（同一角色：对比表登记值 vs 本地按行现算）：${漂移.length ? '⚠ 有 ' + 漂移.length + ' 项差 >5 点 → ' + 漂移.slice(0, 8).join('；') : '✓ 疑问率/感叹率/省略号率/句长 全部差 ≤5 点，两把尺子是同一把'}`);

/* ───────── --md 报告 ───────── */
if (MD) {
  const L = [];
  L.push(`# 扮演回测验证报告 · 批次 ${BATCH}`, '');
  L.push(`> 生成于 ${new Date().toLocaleString()} ｜ 已产 ${results.length} 单，进结论 ${可用.length} 单 ｜ 纯本地打分，零 token`, '');
  L.push('## 口径', '');
  L.push('- 一句 = 语料里的一行台词（行级，交接计划 §三 拍板）；句长 = 纯汉字。');
  L.push('- 疑问率 / 感叹率 = **行内含「？」/「！」的比率**（与 工具/persona_check.mjs、fingerprint_full.mjs 的 PATTERNS 同一把尺）。');
  L.push(`- 真值来源：${TRUTH === 'corpus' ? '本地按行现算' : '角色模型/_全角色指纹对比.md 的行级登记值（= B 臂材料里那套数字）'}。`);
  L.push('- 「以…结尾」不再计分：行级对比表未登记该项（旧 9 指标 → 现 8 指标）。');
  L.push('- 容差与判定沿用 persona_check.mjs 的 BANDS + 小样本 slack（n<30 ×1.7）。', '');
  L.push('## 两臂设计', '');
  L.push(`- **A 臂（盲测）**：只给该角色 150 句真实语料，不给任何指标 → 基线。`);
  L.push(`- **B 臂（处方）**：给该角色《角色扮演模型》＋《语言指纹报告》→ 测文档是否可执行。`);
  L.push('- 两臂的场景/任务/句数/格式由同一段常量拼装，生成时机器校验「剥掉材料块后逐字相同」。', '');
  L.push('## 逐单结果', '');
  L.push('| 单号 | 角色 | 句数 | 达标 | 警告 | 偏离 | 平均偏离 | 逐字照抄 | 备注 |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of results) L.push(`| ${r.id} | ${r.ch} | ${r.n} | ${r.ok ?? '—'} | ${r.warn ?? '—'} | ${r.bad ?? '—'} | ${r.平均偏离 != null ? r.平均偏离.toFixed(1) : '—'} | ${r.copy.total.toFixed(0)}% | ${r.照抄单 ? '照抄单(剔除)' : r.样本不足 ? `样本不足(${r.n})` : ''} |`);
  L.push('', '## 总体', '');
  L.push(`- 单指标达标率：A ${rate('A')} ｜ B ${rate('B')}`);
  L.push(`- 平均绝对偏离：A ${mdev('A').toFixed(2)} ｜ B ${mdev('B').toFixed(2)} ｜ B−A ${sgn(+(mdev('B') - mdev('A')).toFixed(2))}`);
  L.push(`- 照抄单（已从结论剔除）：${剔除.length ? 剔除.map((r) => `${r.id} ${r.copy.total.toFixed(0)}%`).join('、') : '无'}`);
  L.push(`- 样本不足（只提示）：${噪声.length ? 噪声.map((r) => r.id).join('、') : '无'}`, '');
  L.push('## 逐指标 A/B 平均绝对偏离', '', '| 指标 | A 盲测 | B 处方 | B−A | 结论 |', '|---|---|---|---|---|');
  for (const x of 指标表) L.push(`| ${x.k} | ${isFinite(x.a) ? x.a.toFixed(1) : '—'} | ${isFinite(x.b) ? x.b.toFixed(1) : '—'} | ${isFinite(x.a) && isFinite(x.b) ? sgn(+(x.b - x.a).toFixed(1)) : '—'} | ${x.判} |`);
  if (pairs.length) {
    L.push('', '## 逐角色配对 B − A', '');
    L.push('| 角色 | 乐队 | A达标 | B达标 | Δ达标 | Δ平均偏离 | 结论 | B 臂最偏指标 | A 臂最偏指标 |', '|---|---|---|---|---|---|---|---|---|');
    for (const p of pairs) L.push(`| ${p.ch} | ${p.band} | ${p.a.ok} | ${p.b.ok} | ${sgn(p.dOk)} | ${sgn(+p.dDev.toFixed(1))} | ${p.verdict} | ${p.worstB.k} 偏 ${p.worstB.dev.toFixed(1)} | ${p.worstA.k} 偏 ${p.worstA.dev.toFixed(1)} |`);
    const cnt = (v) => pairs.filter((p) => p.verdict === v).length;
    L.push('', `有效 ${cnt('文档有效')} ｜ 有害 ${cnt('文档有害')} ｜ 略改善 ${cnt('略改善')} ｜ 略变差 ${cnt('略变差')} ｜ 持平 ${cnt('持平')}（已配对 ${pairs.length} 人）`);
    const 未配 = CHARS.map((c) => c.k).filter((k) => !pairs.some((p) => p.ch === k));
    if (未配.length) L.push(`未成对：${未配.join('、')}`);
  }
  L.push('', '## 口径核对（登记值 vs 语料现算）', '');
  L.push(漂移.length ? `⚠ 差 >5 点：${漂移.join('；')}` : '✓ 疑问率/感叹率/省略号率/句长 全部差 ≤5 点：回测与文档引用的是同一把尺。');
  L.push('', '## 结论纪律', '');
  L.push('- 照抄单不进结论（B 臂可从文档「台词弹药库」直接抄原句）。');
  L.push('- 句数 <4 的单只提示不判失败（who/达标率在此样本量落在噪声区）。');
  L.push('- 本轮要回答的问题：5 份返工过的《角色扮演模型》（立希/爽世/初华/蕾叶/千樱梨）的 Δ达标 是否已转正。');
  const 文件 = join(批次目录, '验证报告_扮演回测.md');
  writeFileSync(文件, L.join('\n'), 'utf8');
  console.log(`\n→ 报告已写 ${文件}`);
}
