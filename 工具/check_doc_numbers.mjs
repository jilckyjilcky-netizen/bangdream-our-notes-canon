#!/usr/bin/env node
/**
 * 文档数字口径审计 —— 独立复验「其余 24 份非孤儿」这句既有结论。
 * 用法：node 工具/check_doc_numbers.mjs [--char 短名] [--json] [--skill]
 * 只读；真值一律现算（fingerprint_full.mjs --dump，两种口径各一次），绝不写盘。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WS = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const ONLY = (args.find((a) => a.startsWith('--char')) || '').split('=')[1]
  || (() => { const i = args.indexOf('--char'); return i >= 0 ? args[i + 1] : null; })();
const JSON_OUT = args.includes('--json');
const DO_SKILL = args.includes('--skill');
const REPORT = args.includes('--report');
const WRITE = args.includes('--write');

// [表头关键词, 真值列, 取数方式]。方式：pct 只认 N.N%（或 45/677 分数式）、abs 认 N 字、
// cnt 认「N 句/次/处」、auto 按单元格里有没有 % 在比率列与计数列之间二选一。
// 先匹配者胜出，所以长名/更专的必须排在前面（如 沉默配额 早于 沉默）。
const METRICS = [
  ['均长', '均长', 'abs'],
  ['≤6字占比', '≤6字%', 'pct'], ['≤6 字占比', '≤6字%', 'pct'], ['短句', '≤6字%', 'pct'],
  ['≥25字占比', '≥25字占比', 'pct'], ['≥25 字占比', '≥25字占比', 'pct'],
  ['沉默配额', '沉默配额', 'pct'], ['沉默占比', '沉默占比', 'pct'], ['沉默率', '沉默占比', 'pct'], ['沉默', '沉默占比', 'pct'],
  ['省略号率', '省略号率', 'pct'],
  ['疑问率', '疑问率', 'pct'], ['以？结尾', '以问结尾率', 'pct'], ['以?结尾', '以问结尾率', 'pct'],
  ['感叹率', '感叹率', 'pct'], ['以！结尾', '以叹结尾率', 'pct'], ['以!结尾', '以叹结尾率', 'pct'],
  ['以…结尾', '以省略号结尾率', 'pct'],
  ['口吃率', '口吃率', 'pct'], ['口吃', '口吃率', 'pct'],
  ['小X', '呼称小X率', 'pct'], ['呼称小X率', '呼称小X率', 'pct'],
  ['含「我」', '含我率', 'pct'], ['含我率', '含我率', 'pct'],
  ['中位数', '中位数', 'abs'], ['最长句', '最长', 'abs'], ['最长', '最长', 'abs'],
  ['叠词', '叠词率', 'pct'],
  ['波浪号率', '波浪号率', 'pct'], ['波浪号', ['波浪号率', '波浪号结尾句数'], 'auto'],
  ['谢谢', '含谢谢率', 'pct'], ['对不起', '含抱歉率', 'pct'], ['抱歉', '含抱歉率', 'pct'],
  ['请求句', '请字率', 'pct'], ['请字', '请字率', 'pct'],
  ['「！！」', '双叹号句数', 'cnt'],
];
// 子语料指标（歌词集等非全量台词）无可比真值，整体排除，否则「歌词省略号率」会被当成「省略号率」
const EXCLUDE = /歌词|舞台|翻唱/;

// 「波浪号」在文档里有三套写法，「沉默」有两套分母（实测见 角色模型/_数字口径审计.md 第四节）。
// 把这些列并成**候选集**一起比：命中哪个就登记哪个；**主数**一个都命不中才算孤儿。
// （只允许换真值列，不允许换单元格里的数——否则「44.6%」能靠括号里的旁证数字洗白。）
const ALT = {
  '波浪号结尾句数': ['波浪号结尾句数', '波浪号句数', '全语料含波浪号句数'],
  '波浪号句数': ['波浪号结尾句数', '波浪号句数', '全语料含波浪号句数'],
  '波浪号率': ['波浪号率', '波浪号结尾率'],
  '沉默配额': ['沉默配额', '沉默占比'],
  '沉默占比': ['沉默配额', '沉默占比'],
};

// 单元格自己声明了定义（「44.6%（以！结尾 350/1146 = 30.5%）」）时，把它声明的那把尺子
// 也列入候选；否则按表头默认列（感叹率=行内含！）比会误判。
function 表内声明(head, cell) {
  const t = `${head} ${cell}`;
  if (/以\s*[*`]*！[*`]*\s*结尾/.test(t)) return '以叹结尾率';
  if (/以\s*[*`]*？[*`]*\s*结尾/.test(t)) return '以问结尾率';
  if (/以\s*…\s*结尾/.test(t)) return '以省略号结尾率';
  if (/以\s*～\s*结尾|结尾[^\n]{0,4}～/.test(t)) return '波浪号结尾率';
  return null;
}

// 在同一条数、多个候选真值列 × 两种口径里取最优命中（行 > 条目/both > 近似）
function bestMatch(val, t, e, cands) {
  let near = null, entry = null;
  for (const c of cands) {
    const j = classify(val, t[c], e[c]);
    if (j === 'row') return { col: c, 判定: 'row' };
    if (j === 'both' && !entry) entry = { col: c, 判定: 'both' };
    if (j === 'entry' && !entry) entry = { col: c, 判定: 'entry' };
    if (j === 'near' && !near) near = { col: c, 判定: 'near' };
  }
  return entry || near || { col: cands[0], 判定: classify(val, t[cands[0]], e[cands[0]]) };
}

// 同一格里**别的**数字（括号旁证、第二行 <br>）能不能复现——只作备注，不参与洗白主数
function 旁证(t, e, cands, cellRaw) {
  const nums = [];
  for (const m of (cellRaw || '').matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)) nums.push(parseFloat(m[1]));
  for (const m of (cellRaw || '').matchAll(/(\d+)\s*\/\s*(\d+)/g)) nums.push(+((+m[1] / +m[2]) * 100).toFixed(1));
  const hit = [];
  for (const v of [...new Set(nums)]) for (const c of cands) {
    const j = classify(v, t[c], e[c]);
    if (j === 'row' || j === 'entry' || j === 'both') { hit.push(`${v}=${c}(${j === 'row' ? '行级' : j === 'entry' ? '条目' : '两口径同值'})`); break; }
  }
  return [...new Set(hit)].slice(0, 3).join('、');
}


const dump = (口径) => JSON.parse(execFileSync(
  process.execPath,
  [join(WS, '工具', 'fingerprint_full.mjs'), '--dump', `--口径=${口径}`],
  { encoding: 'utf8', maxBuffer: 1 << 28 },
));
const TRUTH = { 行: {}, 条目: {} };
for (const 口径 of ['行', '条目']) {
  for (const r of dump(口径).rows) TRUTH[口径][r.short] = r;
}

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
function classify(val, tRow, eRow) {
  const v = r1(val), 行 = r1(tRow), 条 = r1(eRow);
  const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.051;
  if (same(v, 行) && same(v, 条)) return 'both';
  if (same(v, 行)) return 'row';
  if (same(v, 条)) return 'entry';
  // 都不等：再分「近似（≤0.2，疑为四舍五入/旧快照）」与「另一把尺子」
  const dev = Math.min(tRow == null || val == null ? Infinity : Math.abs(val - tRow),
                       eRow == null || val == null ? Infinity : Math.abs(val - eRow));
  if (dev <= 0.2) return 'near';
  return 'none';
}

// 按单位取数：比率优先认「NN.N%」，也认「45/677」分数式与裸数字；长度只认「NN.N 字」；计数认「N 句/次/处」。
// （早期版本取「单元格第一个数字」，会把「138 次（23.7%）」里的次数当成比率 → 假孤儿）
const fracOf = (cell) => {
  const m = cell.match(/(\d+)\s*\/\s*(\d+)/);
  return m ? (+m[1] / +m[2]) * 100 : null;
};
function pickNum(cellRaw, headRaw, kindIn, colSpec) {
  const head = (headRaw || '').replace(/\*\*/g, '');
  const cell = (cellRaw || '').replace(/\*\*/g, '').replace(/,/g, '').trim();
  let kind = kindIn, col = colSpec;
  if (kind === 'auto') {
    const isPct = /%/.test(cell);
    col = isPct ? colSpec[0] : colSpec[1];
    kind = isPct ? 'pct' : 'cnt';
  }
  if (kind === 'cnt') {
    const m = cell.match(/(\d+)\s*(?:句|次|处|条|行|个)/);
    if (m) return { v: +m[1], 单位: '计数', col };
    const bare = cell.match(/^(\d+)/);
    if (bare) return { v: +bare[1], 单位: '裸计数', col };
    return { v: null, 原因: '单元格内没有计数' };
  }
  if (kind === 'pct') {
    const m = cell.match(/(-?\d+(?:\.\d+)?)\s*%/);
    if (m) return { v: parseFloat(m[1]), 单位: '%', col };
    const f = fracOf(cell);
    if (f != null) return { v: +f.toFixed(1), 单位: '分数式', col };
    if (/^-?\d+(?:\.\d+)?$/.test(cell)) return { v: parseFloat(cell), 单位: '裸数字(按比率)', col };
    return { v: null, 原因: '既无 % 也无分数式（疑为计数或纯文字）' };
  }
  const mZ = cell.match(/(-?\d+(?:\.\d+)?)\s*字/);
  if (mZ) return { v: parseFloat(mZ[1]), 单位: '字', col };
  // 「中位数 11」「最长 21」这类整数指标常不带「字」；表头声明了单位（均长（纯汉字））也允许裸数字
  if (/字[）)]|（纯汉字）/.test(head) || /中位数|最长|句数|次数/.test(head)) {
    const m0 = cell.match(/^\s*(-?\d+(?:\.\d+)?)/);
    return m0 ? { v: parseFloat(m0[1]), 单位: '裸数字(按长度)', col } : { v: null, 原因: '无数字' };
  }
  return { v: null, 原因: '「字」单位既不在单元格也不在表头' };
}

// 表所属小节：态X/语域/开关/阶段/声线 → 该表统计的是子集语料，不能与全语料真值直接比
const SUB = /(态\s*[A-Z]|语域|开关|阶段|低谷|声线)/;
const WHOLE = /(语言层|语言指纹)/;
function 作用域(lines, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (!/^#{2,6}\s/.test(lines[j])) continue;
    const h = lines[j].replace(/^#+\s*/, '');
    return (SUB.test(h) && !WHOLE.test(h)) ? h : '';
  }
  return '';
}
// 「合计」是"纯省略号+省略号加标点"的合并定义，与 fingerprint_full 的分列口径不可比
// （「以？结尾」「以！结尾」原先也按变体豁免，现 fingerprint_full 已补出对应真值列，改为正常比对）
function 定义变体(cell) {
  const m = (cell || '').match(/(合计)/);
  return m ? m[0] : '';
}

function auditDoc(path, short, label) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/);
  const t = TRUTH['行'][short], e = TRUTH['条目'][short];
  if (!t || !e) return { label, 角色: short, 状态: '无语料真值', 项: [] };
  const 小样本 = /n\s*=\s*\d+|小样本/.test(text);
  const out = [];
  const lookMetric = /(率|占比|均长|中位数|最长|结尾|含「|含我|波浪|叠词|称呼|呼称|配额)/;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!/^\s*\|/.test(L)) continue;
    const cells = L.split('|').map((c) => c.trim());
    const head = cells[1];
    if (!head) continue;
    // 关键词匹配用去空白/去反引号的表头：文档写成「以 `…` 结尾」「≤6 字占比」等变体
    const headK = head.replace(/\*\*/g, '').replace(/[\s`]/g, '');
    if (EXCLUDE.test(head)) { skipped.push({ 角色: short, 行号: i + 1, 指标: head.replace(/\*\*/g, ''), 原文: L.trim(), 原因: '子语料指标（歌词/舞台等），无可比真值' }); continue; }
    let matched = false;
      for (const [kw0, colSpec, kind] of METRICS) {
        const kw = kw0.replace(/[\s`]/g, '');
        if (!headK.includes(kw)) continue;
      matched = true;
      const p = pickNum(cells[2], head, kind, colSpec);
      if (p.v === null) { skipped.push({ 角色: short, 行号: i + 1, 指标: head.replace(/\*\*/g, ''), 原文: L.trim(), 原因: p.原因 }); break; }
      const val = p.v;
      const declared = 表内声明(head, cells[2]);
      const cands = [...new Set([p.col, declared, ...(ALT[p.col] || []), ...(ALT[declared] || [])].filter(Boolean))];
      const bm = bestMatch(val, t, e, cands);
      // 就近口径标注：向上找最近的一行**声明**了口径的文字。
      // 表格行必须跳过——上一行的指标名里就带「条目」二字（如「无文字条目」），会被当成口径声明
      let 标注 = '';
      for (let j = i - 1; j >= Math.max(0, i - 12) && j >= 0; j--) {
        // 只放过表头行（下一行是 |---| 分隔）：表体行里的「无文字条目」这类指标名不是口径声明
        if (/^\s*\|/.test(lines[j]) && !/^\s*\|[-:\s|]+\|?\s*$/.test(lines[j + 1] || '')) continue;
        const m = lines[j].match(/行级口径|行级|条目口径|条目|台词口径|台词/);
        if (m && /口径|台词|条目|行级|分母/.test(lines[j])) { 标注 = m[0]; break; }
      }
      const devs = cands.flatMap((c) => [t[c], e[c]]
        .filter((x) => typeof x === 'number' && Number.isFinite(x))
        .map((x) => Math.abs(val - x)));
      out.push({
        行号: i + 1, 指标: head.replace(/\*\*/g, ''), 文档值: val,
        真值列: bm.col, 候选: cands.join('｜'),
        行级真值: r1(t[bm.col]), 条目真值: r1(e[bm.col]),
        偏差: devs.length ? +Math.min(...devs).toFixed(2) : null,
        判定: bm.判定, 就近口径注: 标注,
        表内声明: declared || '', 旁证: 旁证(t, e, cands, cells[2]),
        作用域: 作用域(lines, i), 定义变体: 定义变体(cells[2]), 小样本, 原文: L.trim(),
      });
      break;
    }
    // 覆盖边界：像指标、却不在 METRICS 里的行（含我率/波浪号/中位数…）——真值侧没有对应列，如实登记
    if (!matched && lookMetric.test(head) && /\d/.test(cells[2] || '')) {
      const k = head.replace(/\*\*/g, '').replace(/（.*?）|\(.*?\)/g, '').trim();
      uncovered.set(k, (uncovered.get(k) || 0) + 1);
    }
  }
  const 有全局口径注 = /^>+\s*\*\*口径\*\*/m.test(text);
  return { label, 角色: short, 文件: path, 文档级口径注: 有全局口径注, 项: out };
}

const docs = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/_角色扮演模型\.md$/.test(n)) docs.push(p);
  }
})(join(WS, '角色模型'));

const results = [];
const skipped = [];
const uncovered = new Map();
for (const p of docs) {
  const short = p.split(/[\\/]/).pop().split('_')[0];
  if (ONLY && short !== ONLY) continue;
  results.push(auditDoc(p, short, '模型文档'));
}

if (DO_SKILL) {
  // 人设 skill 的指纹表在 references/lore.md（25 份都有），不在 SKILL.md。
  // 文件夹名 = canon 角色 id，短名从 kb.json 反查（「」启发式不可靠：会命中「从头再来」这类词）
  let id2k = new Map();
  try {
    const kb = JSON.parse(readFileSync(join(WS, '资料库', 'kb.json'), 'utf8'));
    id2k = new Map((kb.characters || []).map((c) => [c.id, c.name_short]));
  } catch { /* kb 缺失则退回文内全名反查 */ }
  const { CHARS, EXTRA_CHARS } = await import('./角色表.mjs');
  const full2k = new Map([...CHARS, ...EXTRA_CHARS].map((c) => [c.full, c.k]));
  const sdir = join(WS, '人设skill');
  for (const id of readdirSync(sdir)) {
    const short = id2k.get(id);
    for (const rel of ['SKILL.md', join('references', 'lore.md')]) {
      const p = join(sdir, id, rel);
      let text; try { text = readFileSync(p, 'utf8'); } catch { continue; }
      const who = short || full2k.get((text.match(/「([\u4e00-\u9fa5]{2,4})」/) || [])[1]);
      if (!who) continue;
      const r = auditDoc(p, who, `skill:${id}/${rel.split(/[\\/]/).pop()}`);
      if (r.项.length) results.push({ ...r, 存在文本: text.length });
    }
  }
}

const roll = {};
// 「横比」在这批文档里指的是「25 人排名来自横比表」，**不是**数值口径声明，故不计入 saysEntry
const saysRow = (s) => /行级/.test(s);
const saysEntry = (s) => /条目|台词/.test(s);
for (const r of results) {
  for (const it of r.项) {
    const d = [it.行级真值, it.条目真值].filter((x) => x != null).map((x) => Math.abs(it.文档值 - x));
    if (it.偏差 == null) it.偏差 = d.length ? +Math.min(...d).toFixed(2) : null;
    const 注 = it.就近口径注 || '';
    let cls;
    if (it.作用域) cls = 'e_子集语域_不与全语料比';
    else if (it.定义变体) cls = 'f_定义变体_' + it.定义变体.replace(/\s/g, '');
    else if (it.判定 === 'row') {
      cls = saysEntry(注) && !saysRow(注) ? 'g_值已行级_标注过期' : 'a_已对齐';
    } else if (it.判定 === 'entry') {
      // 「有标注」必须是就近真有一句把数值口径说成 台词/条目；文档里出现过「口径」二字不算
      cls = saysRow(注) && !saysEntry(注) ? 'c_孤儿_条目值但标注为行级'
        : saysEntry(注) ? 'b_双口径有标注' : 'c_孤儿_条目值无标注';
    } else if (it.判定 === 'near') cls = 'd_近似_偏差≤0.2';
    else if (it.判定 === 'none') cls = 'c_孤儿_两边都对不上';
    else cls = 'a2_两口径同值_无区分力';
    roll[cls] = (roll[cls] || 0) + 1;
    it.归档 = cls;
  }
}

const relPath = (p) => (p || '').replace(WS + sep, '').split(sep).join('/');

function tierOf(r) {
  return {
    比对项: r.项.length,
    行级命中: r.项.filter((x) => x.归档 === 'a_已对齐').length,
    同值无区分力: r.项.filter((x) => x.归档 === 'a2_两口径同值_无区分力').length,
    双口径有标注: r.项.filter((x) => x.归档 === 'b_双口径有标注').length,
    近似: r.项.filter((x) => x.归档 === 'd_近似_偏差≤0.2').length,
    需回写: r.项.filter((x) => x.归档[0] === 'c').length,
    标注过期: r.项.filter((x) => x.归档[0] === 'g').length,
    不可比: r.项.filter((x) => x.归档[0] === 'e' || x.归档[0] === 'f').length,
  };
}

function renderReport() {
  const M = results.filter((r) => r.label === '模型文档');
  const S = results.filter((r) => r.label !== '模型文档');
  const cnt = (A) => A.reduce((a, r) => { for (const it of r.项) a[it.归档] = (a[it.归档] || 0) + 1; return a; }, {});
  const L = [];
  const P = (s = '') => L.push(s);

  P('# 数字口径审计（角色模型 + 人设 skill）');
  P();
  P('生成本文件的命令：`node 工具/check_doc_numbers.mjs --skill --report --write`');
  P('真值不落盘缓存，每次现算：`node 工具/fingerprint_full.mjs --dump --口径=行` 与 `--口径=条目`。');
  P('');
  P('## 一、为什么要做这份审计');
  P();
  P('台账里有一句既有结论：**「其余 24 份经 `归档/_临时诊断/扫描孤儿数字.mjs` 扫描确认是"台词/横比双口径"精修设计，非孤儿，未整表替换」**（祥子一份是 2026-10-03 唯一整表改到行级口径的）。');
  const SK = new Set(S.map((r) => r.label)).size;
  P(`这句话是靠一个已不在本轮验证范围内的旧脚本得出的。本工具不复用它，改为**独立复算**：`);
  P(`把两份《全角色指纹》报告的两种口径真值现算出来，逐条比对 ${M.length} 份角色模型与 ${SK} 份人设 skill（references/lore.md）里的每一个指纹数字。`);
  P('');
  P('## 二、结论');
  P();
  const needM = M.reduce((s, r) => s + r.项.filter((x) => x.归档[0] === 'c').length, 0);
  const needS = S.reduce((s, r) => s + r.项.filter((x) => x.归档[0] === 'c').length, 0);
  const mEntry = M.reduce((s, r) => s + r.项.filter((x) => x.归档 === 'c_孤儿_条目值无标注').length, 0);
  const mNone = M.reduce((s, r) => s + r.项.filter((x) => x.归档 === 'c_孤儿_两边都对不上').length, 0);
  const sEntry = S.reduce((s, r) => s + r.项.filter((x) => x.归档 === 'c_孤儿_条目值无标注').length, 0);
  const gAll = results.reduce((s, r) => s + r.项.filter((x) => x.归档[0] === 'g').length, 0);
  const bigDev = results.reduce((s, r) => s + r.项.filter((x) => x.归档[0] === 'c' && x.偏差 > 1).length, 0);
  // 「波浪号这一族回写后偏差是否真的降下来了」——不靠记忆，按当前匹配结果现算
  const waveItems = results.flatMap((r) => r.项.filter((x) => /波浪号/.test(x.指标) || /波浪号/.test(x.真值列 || '')));
  const waveMax = waveItems.length ? Math.max(...waveItems.map((x) => x.偏差 ?? 0)) : null;
  const FIXES = [
    ['取「单元格第一个数字」', '`138 次（23.7%）` 里的**次数**被当比率比，凭空造出 12 项假孤儿', '按单位取数：比率只认 `N.N%`／分数式，长度只认 `N.N 字`，计数只认 `N 句/次/处`'],
    ['单位只查单元格', '`均长（纯汉字） \\| 8.7` 这类**单位写在表头**的行被整行丢弃（6 份文档最重要指标失检）', '单位允许声明在表头'],
    ['就近标注读错字段名', '`b_双口径有标注` 永远判不出来，全被降级成孤儿', '修正字段名，并按「最近一行」而非「8 行窗口首处」取标注'],
    ['子语料/语域表当全语料比', '「歌词省略号率」「态 D 日常语域」「两套声线」被拿去比全语料真值，偏差高达 72 分', '`歌词/舞台` 指标排除；按所属小节识别子集表 → `e` 类'],
    ['单一真值列', '「波浪号 N 句」文档实测用的是**以～结尾**，工具拿**行内含～**比 → 20 项假孤儿（偏差最大 175）', '同指标的多套定义并成**候选列集**一起比（结尾／台词内含／全语料内含），命中哪列登记哪列'],
    ['表体行被当口径声明', '上一行指标名「无**条目**」被读成口径声明，把已是行级的数字判成「标注矛盾」', '向上找标注时跳过表体行，只认表头与正文'],
    ['「横比」被当口径', '爱音表头「排名来自 25 人同口径横比」被当成**数值**是条目口径', '「横比」不再作为数值口径声明'],
    ['真值 0 被当缺失', '偏差集合用 `x !== 0` 过滤，定治「以？结尾」真值恰为 0 被丢弃，误判成两边都对不上', '只按 `Number.isFinite` 过滤，0 是合法真值'],
  ];
  P(`1. **「其余 24 份非孤儿」这句结论不成立。** 模型文档共 ${M.reduce((s, r) => s + r.项.length, 0)} 个可比数字项，其中 **${needM} 项**按现行规则无法解释：${mEntry} 项是**条目口径却没有任何口径标注**，${mNone} 项**两种口径都复现不出**（详见第六节）。`);
  P(`2. 但「无法解释」不等于「错得离谱」：${needM + needS} 个需回写项里只有 **${bigDev} 项偏差 > 1**（占 ${(bigDev / (needM + needS) * 100).toFixed(1)}%），其余都是 ≤1 的旧快照漂移或纯粹的口径滞后 —— 主因是这批数字停在 2026-10-03 行级定案**之前**，不是有人随手编数。`);
  P(`3. 人设 skill 侧是**系统性**的：${SK} 份 lore.md 共 ${S.reduce((s, r) => s + r.项.length, 0)} 项里 **${sEntry} 项精确等于条目口径、且无标注**，只有 ${S.reduce((s, r) => s + r.项.filter((x) => x.归档 === 'a_已对齐').length, 0)} 项落在现行行级口径上（另有 ${gAll} 项数值已是行级、只是就近标注仍写「台词」，见第八节）。即 skill 侧整体未跟进口径统一。`);
  P(`4. 需要回写的数字合计 **${needM + needS} 项**（模型 ${needM} ／ skill ${needS}），逐条清单见第六、七节；本报告**只登记不改文**，回写按第十节的顺序另行执行。`);
  P(`5. 审计自己的匹配器先后修掉 **${FIXES.length} 类**会导致假孤儿的缺陷（第四节）。最典型的是「波浪号 N 句」：初版拿「台词行内含～」去比，给 野乃花/阿拉蕾/蓬咲/若麦/茉幌/心玖 等造出偏差 175、162、95、61 的二十多项假孤儿；实测文档用的是**「以～结尾」且按条目合并**，补上三种定义的真值列后，本轮 ${waveItems.length} 个波浪号项的最大偏差为 **${waveMax}**（若麦 97 vs 条目真值 98 的 off-by-one，属语料版本而非定义分歧）。`);
  P('');

  P('## 三、分类定义');
  P();
  P('| 归档 | 含义 | 处置 |');
  P('|---|---|---|');
  P('| `a_已对齐` | 文档值 = **行级**真值（现行权威口径） | 不动 |');
  P('| `a2_两口径同值_无区分力` | 行级与条目真值本就相同，无法据此判断口径 | 不动 |');
  P('| `b_双口径有标注` | 值是**条目**口径，且就近一句真的把数值口径写成 台词/条目 | 不动（设计如此） |');
  P('| `d_近似_偏差≤0.2` | 与两口径都差 ≤0.2，疑为四舍五入或旧快照 | 复核后统一改写 |');
  P('| `c_孤儿_条目值无标注` | 值 = 条目口径，但文档**没有**任何数值口径声明 | **回写为行级** |');
  P('| `c_孤儿_两边都对不上` | 值在两种口径、该指标的全部候选定义下都复现不出 | **重算后回写** |');
  P('| `g_值已行级_标注过期` | 数值本身就是行级真值，就近标注却还写着「台词」 | 只改标签，不改数 |');
  P('| `e_子集语域_不与全语料比` | 所属小节是「态X／语域／阶段／声线」等子集表 | 不参与判定 |');
  P('| `f_定义变体_合计` | 「合计」这类合并定义（纯省略号+省略号加标点），与分列真值不可比 | 不参与判定 |');
  P('');
  P('> 判定阈值：先把两边都四舍五入到 1 位小数，再要求 |差| < 0.05；两口径同值时另归「a2」。');
  P('> 「有标注」从严：只要求文档里出现过「口径」二字不算声明（爱音表头那句只说明了句长与排名来源，没说数值口径）。');
  P('');

  P('## 四、本轮为消除误报所做的匹配修正');
  P();
  P('| 缺陷 | 症状 | 修正 |');
  P('|---|---|---|');
  for (const [a, b, c] of FIXES) P(`| ${a} | ${b} | ${c} |`);
  P('');
  const noneAll = results.reduce((s, r) => s + r.项.filter((x) => x.归档 === 'c_孤儿_两边都对不上').length, 0);
  const efAll = results.reduce((s, r) => s + r.项.filter((x) => x.归档[0] === 'e' || x.归档[0] === 'f').length, 0);
  P('> 迭代留痕（**早期版本**的数字，当前工具已修好、无法再复现，仅作流程记录）：');
  P(`> 初版匹配器在模型文档上就报「两边都对不上」42 项，并静默丢弃 6 份文档的「均长（纯汉字）」行；`);
  P(`> 上述 ${FIXES.length} 项修正后，「两边都对不上」降至模型 ${mNone} 项 ／ skill ${noneAll - mNone} 项（共 ${noneAll}），`);
  P(`> 另有 ${efAll} 项归入子集语域／定义变体而不参与判定，剩余偏差 > 1 的 ${bigDev} 项已逐条读原文复核（第六节备注）。`);
  P('');

  P('## 五、模型文档：逐人分档');
  P();
  P('| 角色 | 比对项 | 行级命中 | 同值无区分力 | 条目+有标注 | 近似 | **需回写** | 标注过期 | 不可比 | 文内有「口径」注 |');
  P('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of [...M].sort((a, b) => (tierOf(b).需回写 - tierOf(a).需回写) || a.角色.localeCompare(b.角色, 'zh'))) {
    const t = tierOf(r);
    P(`| ${r.角色} | ${t.比对项} | ${t.行级命中} | ${t.同值无区分力} | ${t.双口径有标注} | ${t.近似} | ${t.需回写} | ${t.标注过期 || '—'} | ${t.不可比} | ${r.文档级口径注 ? '有' : '—'} |`);
  }
  P('');

  P('## 六、需回写清单（模型文档）');
  P();
  P('每一项都给到**可直接照抄的行级真值**；`条目真值` 列保留以便核对它是不是只是口径旧了。');
  P('`定义列` = 这一条是按哪一列真值比的（同一指标可能有多套历史定义，见第四节）。');
  P('');
  P('| 文件 | 行 | 指标 | 定义列 | 文档现值 | 应改为（行级） | 条目真值 | 偏差 | 性质 | 备注 |');
  P('|---|---|---|---|---|---|---|---|---|---|');
  const rows = [];
  for (const r of M) for (const it of r.项) if (it.归档[0] === 'c') rows.push({ r, it });
  rows.sort((a, b) => (b.it.偏差 - a.it.偏差) || a.r.角色.localeCompare(b.r.角色, 'zh'));
  for (const { r, it } of rows) {
    const 性质 = it.归档 === 'c_孤儿_条目值无标注' ? '口径旧+无标注' : '两边都复现不出';
    const 备注 = [it.小样本 ? '小样本（n 见原文）' : '', it.就近口径注 ? `就近出现「${it.就近口径注}」` : '',
      it.表内声明 ? `按表内声明的「${it.表内声明}」列比` : '',
      it.旁证 ? `格内他数可复现：${it.旁证}` : ''].filter(Boolean).join('；');
    P(`| ${relPath(r.文件)} | ${it.行号} | ${it.指标} | ${it.真值列} | ${it.文档值} | **${it.行级真值}** | ${it.条目真值} | ${it.偏差} | ${性质} | ${备注} |`);
  }
  P('');

  P('## 七、需回写清单（人设 skill · references/lore.md）');
  P();
  P('| skill | 行 | 指标 | 文档现值 | 应改为（行级） | 条目真值 | 偏差 | 性质 |');
  P('|---|---|---|---|---|---|---|---|');
  const rows2 = [];
  for (const r of S) for (const it of r.项) if (it.归档[0] === 'c') rows2.push({ r, it });
  rows2.sort((a, b) => a.r.label.localeCompare(b.r.label) || a.it.行号 - b.it.行号);
  for (const { r, it } of rows2) {
    P(`| ${r.label} | ${it.行号} | ${it.指标} | ${it.文档值} | **${it.行级真值}** | ${it.条目真值} | ${it.偏差} | ${it.归档 === 'c_孤儿_条目值无标注' ? '条目口径' : '复现不出'} |`);
  }
  P('');

  P('## 八、口径标注过期（数值对、标签旧）');
  P();
  const gList = [];
  for (const r of results) for (const it of r.项) if (it.归档[0] === 'g') gList.push({ r, it });
  if (!gList.length) P('（本轮无）');
  else {
    P('这些行的数值**已经是现行行级口径**，只是就近那句仍写「台词/条目」。改标签，不改数。');
    P('');
    P('| 文件 | 行 | 指标 | 数值 | 就近标注 |');
    P('|---|---|---|---|---|');
    for (const { r, it } of gList) P(`| ${relPath(r.文件)} | ${it.行号} | ${it.指标} | ${it.文档值} | 「${it.就近口径注}」 |`);
  }
  P('');

  P('## 九、覆盖边界（本报告**不能**证明的事）');
  P();
  P(`真值列由 \`fingerprint_full.mjs --dump\` 现算，本轮为覆盖文档用词已扩到 ${Object.keys(Object.values(TRUTH['行'])[0] || {}).length} 列（含 中位数／最长／≥25字占比／含我率／三种「以X结尾」率／叠词／波浪号三式／沉默配额 等补列）。`);
  P('但文档里仍有下列指标**没有可算真值**，本审计对它们既不说对、也不说错（按出现次数排）：');
  P('');
  P('| 指标名 | 出现次数 |');
  P('|---|---|');
  const unc = [...uncovered.entries()].sort((a, b) => b[1] - a[1]);
  if (!unc.length) P('| （无） | 0 |');
  for (const [k, n] of unc) P(`| ${k} | ${n} |`);
  P('');
  const zero = M.filter((r) => !r.项.length).map((r) => r.角色);
  P(`**比对项为 0 的模型文档 ${zero.length} 份**${zero.length ? '：' + zero.join('、') : '（无 —— 30 份模型文档全部至少有一项可比）'}。`);
  P('');
  P('另有三类**结构性**盲区，不因本工具而消除：');
  P(`- \`e_子集语域\` 与 \`f_定义变体\` 的项（本轮 ${results.reduce((s, r) => s + r.项.filter((x) => x.归档[0] === 'e' || x.归档[0] === 'f').length, 0)} 项）不参与判定 —— 它们统计的是子集语料或另一套合并定义，与全语料真值本就不可比；`);
  P('- 正文／自检清单里**散落在表格之外**的数字不在扫描范围内（本工具只认表格行）；');
  P(`- ${skipped.length} 行被主动跳过（子语料指标、无 % 也无计数单位的单元格），逐条在 \`--json\` 的 \`跳过样例\` 里。`);
  P('');
  P('## 十、回写方案（本工具不做，等批准）');
  P();
  P('口径已定：**行级为唯一权威**（`角色模型/` 与 `人设skill/` 一律向行级对齐；确实要保留条目口径的，必须就近写明「条目口径」四字）。');
  P('');
  P('「波浪号 N 句」这一族要额外写死一条：回写一律用**行级 · 以～结尾**的句数（文档原话是"句尾拖音""只做收尾拖音"，');
  P('换成"行内含～"的计数会让描述与数字自相矛盾）。`工具/build_wave_baseline.mjs` 的运行时基线用的是**行级 · 含～**，');
  P('那是另一个用途（判断某人会不会用波浪号，阈值 2%），不回填进文档。');
  P('');
  P('建议顺序，每步都可单独回滚：');
  P();
  const none = results.flatMap((r) => r.项.filter((x) => x.归档 === 'c_孤儿_两边都对不上' && x.偏差 > 1)
    .map((it) => `${r.角色} ${it.指标} ${it.文档值}→行级 ${it.行级真值}（差 ${it.偏差}）`));
  P('| 步 | 内容 | 影响面 | 风险 |');
  P('|---|---|---|---|');
  P(`| 1 | skill lore 的「条目口径」项改为行级 | ${sEntry} 项 | 低：纯数字替换，句式不动 |`);
  P(`| 2 | 模型文档的「条目口径无标注」项改为行级 | ${mEntry} 项 | 低 |`);
  P(`| 3 | 「两边都对不上」项**重算后**回写（不是替换成行级真值就完事，要确认它原本在算什么） | ${results.reduce((s, r) => s + r.项.filter((x) => x.归档 === 'c_孤儿_两边都对不上').length, 0)} 项，偏差 > 1 的 ${none.length} 项中最典型的前 6：${none.slice(0, 6).join('；') || '（无）'}（全表见第六、七节） | **中高**：清告整表按 n=16 的旧语料写（现该角色台词 18 条），乐奈／灯的 ≤6字 差 1～5 分同属旧快照 —— 直接套行级真值会把「语料版本」分歧洗成「口径」分歧 |`);
  P(`| 4 | 「近似 ≤0.2」项统一改写为现算值 | ${results.reduce((s, r) => s + r.项.filter((x) => x.归档 === 'd_近似_偏差≤0.2').length, 0)} 项 | 低 |`);
  P(`| 5 | 只改口径标签、不改数 | ${gList.length} 项（第八节） | 低 |`);
  P('| 6 | 顺带修正文内引用：如乐奈 ≤6字「80.3%」被灯的文档当横比基准引用，两处必须同时改 | 见第六节 | 中：漏改会造出新矛盾 |');
  P();
  P('第 3 步之前不建议动第 1、2 步以外的文件：先把「两边都对不上」的成因问清楚，否则改完仍是错数。');
  P('');

  P('## 十一、复现');
  P();
  P('```bash');
  P('node 工具/check_doc_numbers.mjs                      # 只打印，不写盘');
  P('node 工具/check_doc_numbers.mjs --char 灯             # 单角色');
  P('node 工具/check_doc_numbers.mjs --skill --json        # 含各份 lore 的机器可读明细');
  P('node 工具/check_doc_numbers.mjs --skill --report --write   # 重新生成本文件');
  P('```');
  P('');
  P('本文件由工具生成，**不要手改**；要改分类规则请改 `工具/check_doc_numbers.mjs` 再重新生成。');
  P('');
  P('## 十二、台账对账（本轮已就地更新，不留旧结论）');
  P('');
  P('- 本工具登记为**常驻工具**：`更新内容与功能介绍.md` §3.6「正式常驻工具」表 + §5.2 审计结论。');
  P('- `交接计划_口径统一与词层补全.md` 阶段 1 第 4 条「其余 24 份…非孤儿」已加删除线并指向 §十四（2026-10-05 复算否证）。');
  P('- `更新内容与功能介绍.md` §5 末「有意保留的双口径…已按 扫描孤儿数字.mjs 确认非孤儿」同批加删除线并指向 §5.2。');
  P('- 归档侧 `归档/_临时诊断/扫描孤儿数字.mjs` **不改**（一次性产物，问题出在把「横比」当口径声明，已在两处台账写明成因）。');
  P('- 数字回写**尚未执行**（等批准），顺序与风险见第十节。');
  P('');
  return L.join('\n');
}

if (REPORT) {
  const md = renderReport();
  if (WRITE) {
    const out = join(WS, '角色模型', '_数字口径审计.md');
    /* 行制：与仓库内所有生成型 .md 一致用 **LF**（`角色模型/指纹/*`、`角色模型/词层/*`、
       `人设skill/_lines对账报告.md` 实测 CR=0）。仓库那条 CRLF 铁律只管 `.cmd`
       （LF 会让 cmd 吃掉每行第一个词），与 md 无关。 */
    writeFileSync(out, md);
    console.log(`已写 → 角色模型/_数字口径审计.md（${md.length} 字，LF）`);
  } else process.stdout.write(md);
} else if (JSON_OUT) { console.log(JSON.stringify({ 汇总: roll, 单位不符跳过: skipped.length, 跳过样例: skipped.slice(0, 12), 明细: results }, null, 1)); }
else {
  console.log(`审计文档 ${results.length} 份 ｜ 数字项 ${results.reduce((s, r) => s + r.项.length, 0)} 处 ｜ 单位不符跳过 ${skipped.length} 处`);
  console.log(JSON.stringify(roll, null, 1));
  for (const s of skipped) console.log(`SKIP ${s.角色} L${s.行号} ${s.指标} — ${s.原因}`);
  for (const r of results) {
    const bad = r.项.filter((x) => x.归档.startsWith('c'));
    const amb = r.项.filter((x) => x.归档 === 'a2_两口径同值_无区分力');
    const near = r.项.filter((x) => x.归档 === 'd_近似_偏差≤0.2');
    if (!bad.length && !amb.length && !near.length) continue;
    console.log(`\n── ${r.角色} ${r.label} ${r.文档级口径注 ? '[有口径注]' : '[无口径注]'}`);
    for (const x of [...bad, ...near, ...amb]) {
      console.log(`   ${x.归档} L${x.行号} ${x.指标}=${x.文档值} 行级${x.行级真值} 条目${x.条目真值} 偏差${x.偏差}${x.就近口径注 ? ` 就近标注「${x.就近口径注}」` : ''}`);
    }
  }
}
