#!/usr/bin/env node
/**
 * check_doc_totals.mjs —— 规模类数字台账审计（README §4 / 介绍.md / 写手看这个.md）
 *
 * 为什么要有它（这是「口径漂移」系列的第 6 个入口，前 5 个都没堵住）：
 *   `check_doc_numbers.mjs` 管的是**角色指纹指标**（均长/疑问率/…），
 *   管不到**规模类数字** —— 「2,582 个 md」「30 名角色」「3,842 个文件」「12 个脚本」
 *   这类。这批数字的漂移路径完全不同：资产一增长，它们就在原地腐烂，而且
 *   **不会引起任何报错**（文档不会因为自己写错而失败）。
 *   实测漂移幅度：README §4.0 写 3,842 个文件，实况 5,892（差 51%）；
 *   §4.4 断言 `.cache/`「零文件」，实况 1,892 个 / 103 MB（结论完全相反）；
 *   介绍.md 通篇写「30 名角色」，kb.json 里已是 47。
 *
 * 口径（写死，别靠记忆）：
 *   - **真值一律现算**，绝不从别处抄。目录体量 =递归文件数（`find | wc -l` 的口径，
 *     不排除任何子目录，但排除 `.git` 本身）。
 *   - **一个声明值只认一种写法**，抽不出就算「无声明」而不是「对」——
 *     宁可漏报也不误报（误报会被忽略，漏报只是暂时放过）。
 *   - **MB 取整到 1 位小数**后再比。文档里写「3.7 MB」而实况 3.68 MB 不算错；
 *     写「51 MB」而实况 165 MB 才算错。
 *   - 文档里的数字**不自动改**，只报告。要改就照抄报告里的真值改——
 *     自动改文档 = 复制粘贴语料进md，正是数字漂移的根。
 *
 * 用法：
 *   node 工具/check_doc_totals.mjs           # 对账，有差异退出码 1
 *   node 工具/check_doc_totals.mjs --json    # 机器可读
 *   node 工具/check_doc_totals.mjs --write   # ⚠ 不提供。数字必须人读人改，见上方口径。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WS = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');

if (argv.includes('--write')) {
  console.error('本脚本刻意不提供 --write：文档数字要人读人改。理由见文件头「口径」。');
  process.exit(2);
}

/* ────────────────────────── 真值：现算 ────────────────────────── */

/**
 * 运行态目录：**每跑一次自检/打包就变一次**，不该进台账。
 *
 * ⚠️ 这不是「放宽口径掩盖漂移」，是把两类东西分开：
 *   台账要回答「这个项目**有多少资产**」，而 `_派发/_selftest/`（40+ 个文件）
 *   和 `_打包/`、`_缓存/` 是**每次运行的产物**。算进去等于把「跑了几次自检」
 *   记成项目体量 —— 实测归档 71 个文件里 40+ 个是 selftest 产物，
 *   数字跟着运行次数漂，台账就变成永动红灯（真数字写错时反而被忽略）。
 *
 * 与`.gitignore` 是同一批路径，但这里**显式列举**而不是读 .gitignore：
 *   gitignore 是打包规则（还有凭据排除），这里是体量口径，两者会分叉。
 */
const RUNTIME_DIRS = new Set([
  join('归档', '_派发', '_selftest'),
  // ⚠️ 这一条也是运行态（实测漏了它）：`回测_扮演.mjs --selftest` 会往
  // `归档/_派发/扮演回测/` 写订单文件。之前只排了 `_selftest/`，
  // 于是**跑一次自检就多1 个文件**，规模台账在全套跑时必红、
  // 单独跑却绿 —— 表现为「时序问题」，实为口径漏了一项。
  join('归档', '_派发', '扮演回测'),
  join('归档', '_打包'),
  join('归档', '_缓存'),
  join('归档', '_probe'),
  // ⚠️ **IDE / 工具自己写的缓存**（2026-10-06 实测发现，此前完全没进过台账）：
  //   `.dsh-acl-recovery` 4 个、`.qoder-credits` 2 个、`.qoder` 1 个 = 7 个。
  //   它们是 IDE 会话状态与额度记录，**不是项目资产**，且会随我用工具而变。
  //   口径判据与上面一致：**能不能重抓 / 有没有孤本** —— 这三样都能重生成。
  join('.dsh-acl-recovery'),
  join('.qoder-credits'),
  join('.qoder'),
  // ⚠️ **Agent 的工作记忆**（2026-10-06 实测踩到）：每写一条日志 +1 个文件
  //   （`YYYY-MM-DD.md` 按日新建），于是**每做一次工作台账就红一次**。
  //   `.workbuddy/` 已在 `.gitignore` 里只放行 `skills/`，它不是项目资产 ——
  //   `skills/` 那部分是**被放行的项目资产**，要计入，所以只排memory 子目录。
  join('.workbuddy', 'memory'),
]);

/** 该路径是不是运行态产物目录（相对工作区根）。 */
function isRuntime(rel) {
  const norm = rel.split('\\').join('/');
  for (const d of RUNTIME_DIRS) if (norm === d.split('\\').join('/')) return true;
  return false;
}

/** 递归文件数（排除 .git 与运行态目录；.gitignore 不算 —— 台账要的是磁盘实况）
 *  ⚠️ `base` 恒为工作区根，不随调用目录变 —— 否则算 `归档/` 时相对路径是
 *  `_派发/_selftest`，与 RUNTIME_DIRS 里的 `归档/_派发/_selftest` 对不上，
 *  运行态目录会漏排（实测归档 71 个文件里 40+ 个是 selftest 产物）。 */
function countFiles(dir, base = WS) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory() && isRuntime(relative(base, p))) continue;
    n += e.isDirectory() ? countFiles(p, base) : 1;
  }
  return n;
}

/**
 * 递归字节数 → **KB**（一位小数）。
 * ⚠️ 别拿 MB 当中间单位再换算：单个 43KB 的文件过一遍 MB 四舍五入就成了 0，
 * 于是「实况 0KB vs 声明 43KB」—— 自己造出一个假不一致。直接算 KB。
 */
function sizeKB(dir, base = WS) {
  let b = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory() && isRuntime(relative(base, p))) continue;
    b += e.isDirectory() ? sizeBytes(p, base) : statSync(p).size;
  }
  return Math.round((b / 1024) * 10) / 10;
}
function sizeBytes(p, base = WS) {
  let b = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const q = join(p, e.name);
    if (e.isDirectory() && isRuntime(relative(base, q))) continue;
    b += e.isDirectory() ? sizeBytes(q, base) : statSync(q).size;
  }
  return b;
}

const T = {
  totalFiles: countFiles(WS),
  totalKB: sizeKB(WS),
  dirs: {},
  mjs: null,
  cacheFiles: existsSync(join(WS, '.cache/script/ja'))
    ? countFiles(join(WS, '.cache/script/ja')) : 0,
  cacheMB: existsSync(join(WS, '.cache/script'))
    ? Math.round(sizeKB(join(WS, '.cache/script')) / 1024) : 0,
  cacheLangs: existsSync(join(WS, '.cache/script'))
    ? readdirSync(join(WS, '.cache/script')).sort() : [],
};
for (const d of ['素材全量', '分享', '归档', '角色模型', 'masterdata', '人设skill', '工具',
                 '角色卡', 'mcp-canon', '跑道', 'links', '资料库', '世界书',
                 '叙事方式', '话层分析', '剧情分析', '风格档案', '模式原型', 'NovelProject']) {
  if (existsSync(join(WS, d))) T.dirs[d] = { n: countFiles(join(WS, d)), kb: sizeKB(join(WS, d)) };
}
T.mjs = (function walk(d) {
  let n = 0;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(d, e.name);
    n += e.isDirectory() ? walk(p) : (e.name.endsWith('.mjs') ? 1 : 0);
  }
  return n;
})(WS);
T.toolTopMjs = readdirSync(join(WS, '工具')).filter((f) => f.endsWith('.mjs')).length;

/* kb.json 规模（介绍.md 的「N 名角色」就是拿它对账的） */
const kb = JSON.parse(readFileSync(join(WS, '资料库/kb.json'), 'utf8'));
const worldbook = JSON.parse(readFileSync(join(WS, '世界书/mygo_ave_世界书.json'), 'utf8'));

/* ────────────────────────── 声明值抽取 ────────────────────────── */

/**
 * 每条规则 = 一个文档 + 一个正则 + 一个取真值方式 + 一句「这条数指的是什么」。
 * 正则只抓**第一处**（各文档里这个数字只该出现一次；出现两次本身就是另一类问题）。
 * `tol`：允许误差（绝对值）。文件数容 0，体积容 0.1（在统一后的单位上）。
 * `conv`：可选，把抽到的声明值换算到真值的单位（单位混写时用）。
 */
function firstMatch(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}

const RULES = [];
/** 单位换算表：声明值 → 真值单位。文档里大小单位混着写，统一后再比。 */
const TO_KB = { KB: 1, MB: 1024 };
const rule = (doc, label, re, actual, tol, unit, conv) => RULES.push({ doc, label, re, actual, tol, unit, conv });

const readme = readFileSync(join(WS, 'README.md'), 'utf8');
const intro = readFileSync(join(WS, '介绍.md'), 'utf8');
const writer = readFileSync(join(WS, '写手看这个.md'), 'utf8');

/* ---- README §4.0 总量表 ---- */
rule('README.md', '工作区总文件数',
  /bangdream-our-notes-canon\/\s+([\d,]+)\s+个文件/,
  () => T.totalFiles, 0, '个');
rule('README.md', '工作区总体积',
  /bangdream-our-notes-canon\/\s+[\d,]+\s+个文件\s+([\d.]+)\s+(MB|KB)/,
  () => T.totalKB, 0.1, 'KB', (n, u) => n * (TO_KB[u] ?? 1));
for (const d of Object.keys(T.dirs)) {
  const esc = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  rule('README.md', `${d}/ 文件数`,
    new RegExp(`├──\\s*${esc}/\\s+([\\d,]+)\\s+个`),
    () => T.dirs[d].n, 0, '个');
  rule('README.md', `${d}/ 体积`,
    // ⚠️ 数字类要写全`[\d,.]+`：**千分位逗号和小数点都要**。
    // 实测踩过：`1,197.8 KB`（工具目录体积）抽不到 → 那一条变成「无声明（不判）」
    // → **掩盖了真实的体积漂移**，看起来像「工具目录没体积数据」。
    new RegExp(`├──\\s*${esc}/\\s+[\\d,]+\\s+个\\s+([\\d,.]+)\\s+(MB|KB)`),
    // 真值以 **KB** 给出：文档里大小单位混着写（12 MB / 600 KB / 43 KB），
    // 统一到 KB 再比，否则 600 KB 会被当成 600 MB 比，差出天文数字。
    () => T.dirs[d].kb, 0.1, 'KB', (n, u) => n * (TO_KB[u] ?? 1));
}
rule('README.md', '全项目 .mjs 总数',
  /全项目 \*\.mjs\s+共\s+([\d,]+)\s+个/,
  () => T.mjs, 0, '个');

/* ---- README §4.4 .cache 事实 ---- */
// 这是**双向**断言，不是单向检查。
// 单向（「只要说丢了就报错」）漏一半：哪天 .cache 真被清空，文档还写着
// 「现有 1,892 个」照样是错的 —— 而那正好会让人以为不用重抓。
// 事实是二元的：磁盘上有 N 个文件，文档就必须说N（或明确说"已重建/已丢失"并对上）。
RULES.push({
  doc: 'README.md', label: '.cache 文件数声明', unit: '个',
  re: /现\s*([\d,]+)\s*个\s*\n?[^\n]{0,40}?的?剧本|([\d,]+)\s*个[^\n]{0,30}?946\s*话/,
  actual: () => T.cacheFiles,
  tol: 0,
  multiGroup: true,
});
RULES.push({
  doc: 'README.md', label: '.cache 状态与实况一致', unit: '',
  // 有文件却写「已丢失」→ 错；没文件却写「现有 N 个」→ 也错；个数不对 → 也错。
  re: null,   // 手工判定，见下方 checkCacheClaims()
  actual: () => `磁盘 ${T.cacheFiles} 个 / ${T.cacheMB} MB / 语种 ${T.cacheLangs.join(',') || '无'}`,
  tol: 0,
  cacheClaimCheck: true,
});

function checkCacheClaims(text) {
  const has = T.cacheFiles > 0;
  // 只取 §4.4 的**标题行**当锚点，不要扩到正文/表格/侧注 ——
  // 标题是「现状一句话」，正文是展开。扩出去会因为下���还写着「历史上写的是已丢失」
  // 而永远判定为「说对了」，断言就废了（这正是负向测试抓不到的那次）。
  const head = text.match(/### 4\.4\s+([^\n]*)/)?.[1] ?? '';
  const saysLost = /(已丢失|零文件|已删除|已不在本机|是空目录)/.test(head);
  const saysHas = /(重建|现有|实有)/.test(head);
  if (has && saysLost && !saysHas) return '磁盘上有文件，§4.4 标题却称已丢失';
  if (has && saysLost && saysHas) return `§4.4 标题同时出现「丢失」与「重建」，自相矛盾：${head.slice(0, 40)}`;
  if (!has && saysHas) return '磁盘上没有文件，§4.4 标题却称已重建';
  const n = head.match(/([\d,]+)\s*个/);
  if (has && n && Math.abs(+n[1].replace(/,/g, '') - T.cacheFiles) > 0) {
    return `§4.4 标题写 ${n[1]} 个，实况 ${T.cacheFiles} 个`;
  }
  return null;
}

/* ---- README §五 工具清单 ---- */
// ⚠️口径陷阱：§五 标题里那个「N 个 Node 脚本」数的是 **`工具/素材提取/` 那一批**
//（表里 12 行全是它），**不是 `工具/` 顶层**（顶层 40 个，含全部生成器）。
// 一开始把这条对到顶层上，误报了 28 个 —— 台账类审计最容易栽在这种「数字对但对象错」。
const extractMjs = readdirSync(join(WS, '工具/素材提取')).filter((f) => f.endsWith('.mjs')).length;
rule('README.md', '§五 工具清单（素材提取/ 一批）',
  /## 五、工具清单（([\d]+)\s*个 Node 脚本/,
  () => extractMjs, 0, '个');

/* ---- 介绍.md 规模 ---- */
const k = (arr, obj) => (Array.isArray(arr) ? arr.length : Object.keys(obj || {}).length);
rule('介绍.md', 'kb.json 在册角色数',
  /把《BanG Dream! Our Notes》的[^]*?（[^）]*?）做成一个/,
  () => `（含 ${k(kb.characters)} 名角色）`, 0, '');
RULES.push({
  doc: '介绍.md', label: '「N 名角色」声明', unit: '名',
  re: /(\d+)\s*名角色/,
  actual: () => k(kb.characters),
  tol: 0,
});
RULES.push({
  doc: '介绍.md', label: '素材 md 总数声明', unit: '个',
  re: /共\s*([\d,]+)\s*个\s*Markdown/,
  actual: () => T.dirs['素材全量'].n,
  tol: 0,
});
RULES.push({
  doc: '介绍.md', label: '世界书条目数声明', unit: '条',
  re: /(\d+)\s*条世界书/,
  actual: () => k(worldbook.entries, worldbook.entries),
  tol: 0,
});
RULES.push({
  doc: '介绍.md', label: '角色卡张数声明', unit: '张',
  re: /(\d+)\s*张\s*SillyTavern/,
  actual: () => T.dirs['角色卡'].n - 1,   // 减 _cards_extra.json（不是卡）
  tol: 0,
});

/* ---- 写手看这个.md 规模 ---- */
RULES.push({
  doc: '写手看这个.md', label: '角色数声明', unit: '名',
  re: /([\d]+)\s*名角色/,
  actual: () => k(kb.characters),
  tol: 0,
});

/* ────────────────────────── 对账 ────────────────────────── */

const rows = [];
for (const r of RULES) {
  const text = readFileSync(join(WS, r.doc), 'utf8');
  if (r.cacheClaimCheck) {
    const why = checkCacheClaims(text);
    // actual 必须**在这里求值**再存进 row：存函数的话打印出来是`() => ...` 源码，
    // 调试时会以为断言逻辑跑飞了。
    rows.push({ ...r, actual: r.actual(), claimed: why || '与实况一致', status: why ? 'bad' : 'ok' });
    continue;
  }
  const m = text.match(r.re);
  if (!m) { rows.push({ ...r, claimed: null, status: '无声明' }); continue; }
  const actual = r.actual();
  const raw = parseFloat(String(r.multiGroup ? (m[1] ?? m[2]) : m[1]).replace(/,/g, ''));
  const claimed = r.conv ? r.conv(raw, m[2]) : raw;   // 单位换算后才是可比值
  const diff = Math.abs(claimed - actual);
  // 容差分两类，别混：
  //   **计数**（个/名/条/张）容 0 —— 「2,582 vs 2,599」差 17 个就是错，
  //     任何相对容差都会把它放过（3% = 78 个 > 17）。计数要么对要么错。
  //   **体积**给「绝对 tol」与「真值 3%」里较大的：文档写「9.3 MB」还是「9.3 MB」
  //     都算对（本来就没那个精度），但差 10% 必须报出来。
  const tol = r.unit === 'KB' ? Math.max(r.tol, actual * 0.03) : r.tol;
  rows.push({ ...r, claimed, raw: m[1], actual, diff, tol, status: diff <= tol ? 'ok' : 'bad' });
}

const bad = rows.filter((r) => r.status === 'bad');
const none = rows.filter((r) => r.status === '无声明');

if (JSON_OUT) {
  console.log(JSON.stringify({
    truth: {
      totalFiles: T.totalFiles, totalKB: T.totalKB, mjs: T.mjs, toolTopMjs: T.toolTopMjs,
      extractMjs,
      kbChars: k(kb.characters), cache: { files: T.cacheFiles, mb: T.cacheMB, langs: T.cacheLangs },
      dirs: T.dirs,
    },
    rows: rows.map(({ re, tol, actual, ...r }) => r),
    badCount: bad.length,
  }, null, 2));
  process.exit(bad.length ? 1 : 0);
}

console.log('\n规模类数字台账审计 —— 真值现算，文档声明逐条比对\n');
const w = Math.max(...rows.map((r) => r.label.length)) + 2;
for (const r of rows) {
  const mark = r.status === 'ok' ? '✓' : r.status === 'bad' ? '✗' : '·';
  const line = r.status === '无声明'
    ? `${mark} ${r.doc.padEnd(16)} ${r.label.padEnd(w)} 无声明（不判）`
    : `${mark} ${r.doc.padEnd(16)} ${r.label.padEnd(w)} 声明 ${String(r.claimed).padStart(9)}｜实况 ${String(r.actual).padStart(9)}${r.unit}` +
      (r.status === 'bad' && r.diff !== undefined ? `  ← 差 ${(+r.diff.toFixed(2))}${r.unit}（容差 ${(+r.tol.toFixed(2))}）` : '');
  console.log(line);
}
console.log('');
if (bad.length) {
  console.error(`[✗] ${bad.length}/${rows.length} 条对不上。真值在「实况」列，照抄进文档即可。`);
  console.error('     改完重跑；数字改错的话这条会继续报错。\n');
  process.exit(1);
}
console.log(`✓ ${rows.length - none.length}/${rows.length} 条对得上（另有 ${none.length} 条文档未声明，不判）\n`);