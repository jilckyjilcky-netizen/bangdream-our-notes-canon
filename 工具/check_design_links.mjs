#!/usr/bin/env node
/**
 * check_design_links.mjs —— 文档「声称」与「实况」的一致性闸门
 *
 * 为什么要有它（这是「口径漂移」系列的第 7 个入口，形态完全不同）：
 *   前6 个闸门查的都是「**数字**对不对」。这一条查的是「**东西在不在**」。
 *
 *   实测事故（2026-10-05深夜）：`角色模型/设计思路/README.md` §5「已完成」表列了
 *   **4 份单体文档**，磁盘上只有**2 份** —— `初华.md` / `祥子.md` 从未存在过。
 *   而另外 3 份文档（初音 / 编队手法 / 灯）共 **8 处**把「初华 §2」「初华的赎罪机制」
 *   当论据引用，读者点进去是 404。
 *   **自检 23 项全过**，因为它们全都在查「产物是否对齐上游数据」，
 *   没人问过「你声称存在的文件，是不是真的存在」。
 *
 * 与规模数字漂移同源：**文档不会因为自己写错而失败。**
 *
 * 查三件事（只读，不写）：
 *   1. **相对链接可达** —— 全库 md 里的 `[x](../y)` 目标必须真的在磁盘上。
 *      为什么单独有这一项：设计层从`角色模型/` 根挪进子目录后，
 *      `../指纹/` 这类路径集体错位一层，链接**照样渲染**只是指向错处。
 *   2. **README 台账声称项存在** —— 「已完成」类表格里链到的文件必须在。
 *   3. **跨文件章节引用不断链** —— `见 <文件名> §x.y` 指向的章节标题必须存在。
 *
 * 口径：
 *   - **只查相对链接**。http(s):// 与 `#锚点` 跳过 —— 前者不归本工具管，
 *     后者要靠全文匹配误报太多（`§5.1` 和 `§5.10` 前缀相同）。
 *   - **路径按`posix` 归一**。Windows 上markdown 里写的是 `/`，反斜杠不算分隔符。
 *   - **不自动改文档**。链接错位要人判断该改显示文字还是该改路径 ——
 *     实测中两者都改过，脚本猜不出来。
 *   - 退出码非 0 即有问题；`--json` 给机器可读；`--quiet` 只出结论。
 *
 * 用法：
 *   node 工具/check_design_links.mjs
 *   node 工具/check_design_links.mjs --json
 *   node 工具/check_design_links.mjs --only 角色模型/设计思路
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const WS = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const QUIET = argv.includes('--quiet');

/** 只查某些子树（`--only <子路径>` 可给多个；不给就是全库）。 */
const ONLY = argv.reduce((a, v, i) => (v === '--only' ? [...a, argv[i + 1]] : a), []);

/** 链接目标里的锚点/`#` 后面那段不参与路径解析。 */
const stripAnchor = (p) => p.split('#')[0].trim();

/** 递归列出 md 文件，跳过不该进台账的目录。 */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.cache', '归档/_打包', '分享',
  '素材全量', 'masterdata',           // 素材与上游数据，不是「我们写的文档」
]);
/** 整目录跳过（相对工作区根）。`.workbuddy/` 是工具自身的配置与外部 skill，不是本库产物。 */
const SKIP_ROOTS = new Set(['.workbuddy']);

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(WS, p).split('\\').join('/');
    if (e.isDirectory()) {
      if (SKIP_ROOTS.has(rel) || SKIP_ROOTS.has(e.name) && rel.split('/').length === 1) continue;
      if (SKIP_DIRS.has(rel) || SKIP_DIRS.has(e.name) && rel.split('/').length === 1) continue;
      walk(p, acc);
    } else if (e.name.endsWith('.md')) {
      acc.push(p);
    }
  }
  return acc;
}

/** 把 markdown 里的路径写法归一成磁盘可判的绝对路径。 */
function resolveTarget(docPath, raw) {
  const rel = raw.split('\\').join('/');
  return resolve(dirname(docPath), rel);
}

/* ────────────────────────── 真值：现算 ────────────────────────── */

// ── 1. 相对链接可达 ──
function checkLinks(files) {
  const rows = [];
  for (const f of files) {
    const md = readFileSync(f, 'utf8');
    const dir = dirname(f);
    for (const m of md.matchAll(/\[([^\]\n]*)\]\(([^)\s]+)\)/g)) {
      const target = stripAnchor(m[2]);
      if (!target) continue;
      if (/^(https?:|mailto:|data:)/i.test(target)) continue;   // 外链不归本工具管
      if (!target.startsWith('.')) continue;                  // 裸路径（写作素材名/命令）不是链接
      const abs = resolveTarget(f, target);
      rows.push({
        doc: relative(WS, f).split('\\').join('/'),
        text: m[1].trim().slice(0, 40),
        target: target,
        exists: existsSync(abs),
      });
    }
  }
  return rows;
}

// ── 2. README「已完成」台账声称项存在 ──
//
// 为什么不是「所有 md 链接」而是这个形状：台账表声称的完成度和磁盘实况必须一致。
// 查法是「文档内链到的同级/子级 md，若它自称是台账行，就必须在」——
// 实际上更稳的等价形式：**任何 md 链到另一个 md，而那个 md 被列在目录里却没有文件**，
// 这一项就靠上面的 checkLinks 兜住了。所以这一项专门查另一件事：
// 目录里**存在**的 md，有没有在本层 README 的台账里被漏掉（孤儿反向）。
function checkLedger(files) {
  const rows = [];
  const readme = join(WS, '角色模型/设计思路/README.md');
  if (!existsSync(readme)) return rows;

  // 抽 §5 已完成表里的角色名与目标路径
  const md = readFileSync(readme, 'utf8');
  const sec5 = md.split('## 5. 已完成')[1]?.split('\n## ')[0] ?? '';
  for (const m of sec5.matchAll(/\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|/g)) {
    const abs = resolveTarget(readme, m[2]);
    rows.push({
      doc: '角色模型/设计思路/README.md §5',
      text: m[1],
      target: m[2],
      exists: existsSync(abs),
    });
  }
  return rows;
}

// ── 3. 跨文件章节引用不断链 ──
//
// **实测踩过的坑（两次）**：
//   ① 最初只匹配「反引号里带 `.md` 文件名」的形式，结果**一项都没报** ——
//      因为设计层内部引用从不写文件名，只写 `§4.3`。负向测才暴露（塞 `§9.9` 无反应）。
//   ② 改宽之后，`§2.6`（指向上游`初华_三角初华_角色扮演模型.md`）被误报 ——
//      那些章节真实存在，只是不在本层。**合法外部引用被当成断链，噪声会让人忽略闸门。**
//
// 所以判据是：**紧跟在 `§` 之前、同一句里出现过 `.md` 文件名的，跳过**
//（那是外部引用，本工具不解析外部文件）；裸 `§x.y` 才参与本层检查。
//
// ⚠️ 本层范围是有意的：全库下 `§1.2` 这类裸编号歧义太大（每个文件都有 §1）。
// 宁可漏报外层，也不让噪声淹没真错 —— 与 check_doc_totals 的口径一致。
function checkSectionRefs(files) {
  const heads = files.map((f) => ({
    f,
    set: new Set(
      [...readFileSync(f, 'utf8').matchAll(/^#{1,4}\s*§?\s*([0-9]+(?:\.[0-9]+)*)/gm)]
        .map((m) => m[1]),
    ),
  }));

  const rows = [];
  for (const f of files) {
    const md = readFileSync(f, 'utf8');
    for (const m of md.matchAll(/§\s*([0-9]+(?:\.[0-9]+)*)/g)) {
      const want = m[1];
      // **外部引用豁免**：往前看 120 个字符，**同一句**内出现 `.md` 文件名 → 不查。
      // ⚠️ 分界必须是**句读**（。！？；\n），不能是「同一行」——
      // 实测：表格单元格里`（依据 [...初华模型.md](../…) §2.6） |` 换行到下一格时，
      // 用「同一行」判会漏掉句号前的内容；用行判会在长表格里跨格误豁免。
      const back = md.slice(Math.max(0, m.index - 120), m.index);
      const lastStop = Math.max(
        back.lastIndexOf('。'), back.lastIndexOf('！'), back.lastIndexOf('？'),
        back.lastIndexOf('；'), back.lastIndexOf('\n'),
      );
      const sentence = back.slice(lastStop + 1);
      if (/\.md/.test(sentence)) continue;

      const hit = heads.some((h) =>
        [...h.set].some((t) => t === want || t.startsWith(want + '.')),
      );
      if (hit) continue;
      rows.push({
        doc: relative(WS, f).split('\\').join('/'),
        text: `§${want}`,
        target: `§${want}`,
        exists: false,
      });
    }
  }
  return rows;
}

// ── 4. skill 里的数量声明（只查可机检的那几条）──
//
// 为什么单独有这一项：`.workbuddy/skills/light-novel-creator/SKILL.md` 有 20+ 处
// 数量声明（47 人 / 32 份 / 42 个…），是**纯文本**、**没人核**，而它又是
// agent 的行为依据 —— 数字错了 agent 会照着错数字干活。
// 实测漂过：「五种可迁移手法」实存四种、「工具/ 下 29 个脚本」实况 42、
// 「已完成灯初音编队手法」漏了实存限制。
//
// ⚠️ **只查能定位到唯一真源的那几条**。全查会淹在噪声里：
//「15 人同场」这种句子里 15 是行文不是台账，硬判必然误报。
// 判据是「**有唯一可算真源的资产**」—— 下面每条都写死了取数方式。
const SKILL_MD = join(WS, '.workbuddy/skills/light-novel-creator/SKILL.md');
function checkSkillClaims() {
  if (!existsSync(SKILL_MD)) return [];
  const md = readFileSync(SKILL_MD, 'utf8');
  const out = [];

  // ⚠️⚠️ **这里踩过一个「假闸门」，必须记住**：
  //   最初把期望值**硬编码**在工具里（`{声明: 42}`），skill 文本另写一份。
  //   于是负向测时我改坏 skill 里的数字（42→29），闸门却报「全过」——
  //   因为它比的是「工具里记的42」vs「磁盘实况 42」，**skill 文本压根没参与**。
  //   断言查的不是文档写的数，是工具自己记的数，**等于没查**。
  //
  // 正确做法：**从 skill 文本里抽声明值**，再与实况比。抽不到才报「没声明」。
  // 每条claims 写死「一段能唯一定位的上下文」+ 一个抽取正则。
  const claims = [
    { 名: '工具/ 顶层 .mjs 个数', 实况: () => readdirSync(join(WS, '工具')).filter((f) => f.endsWith('.mjs')).length,
      抽: (t) => t.match(/`工具\/`\s*下\s*(\d+)\s*个/) },
    { 名: '人设skill/ 套数', 实况: () => readdirSync(join(WS, '人设skill')).filter((f) => {
      try { return statSync(join(WS, '人设skill', f)).isDirectory(); } catch { return false; }
    }).length, 抽: (t) => t.match(/`人设skill\/`（(\d+)\s*份）/) },
    { 名: '角色卡/ 张数', 实况: () => readdirSync(join(WS, '角色卡')).filter((f) => f.endsWith('.json')).length - 1,
      抽: (t) => t.match(/`角色卡\/`（(\d+)\s*份）/) },
    // ⚠️ 这条**真的漂过**：skill §0 写「按角色全量 48」，实况 47（2026-10-06 顺手修的）。
    //   正则要认得**表格里那半句**的写法（`按角色全量 47`），不是括号式。
    { 名: '中文全量语料人数', 实况: () => readdirSync(join(WS, '素材全量/按角色全量/zh-Hans')).filter((f) => f.endsWith('.md')).length,
      抽: (t) => t.match(/按角色全量\s*(\d+)/) },
  ];

  for (const c of claims) {
    const m = c.抽(md);
    if (!m) {
      // 抽不到 = skill 没写这个数。**这本身要报**（该补声明），但不判失败——
      // 因为「没声明」和「声明错了」是两件事，混在一起会让人忽略后者。
      out.push({
        doc: '.workbuddy/skills/light-novel-creator/SKILL.md',
        text: c.名, target: `⚠️ skill 里抽不到这个数（实况 ${c.实况()}）`, exists: true, extra: true,
      });
      continue;
    }
    const 声明 = parseInt(m[1], 10);
    const real = c.实况();
    out.push({
      doc: '.workbuddy/skills/light-novel-creator/SKILL.md',
      text: c.名, target: `声明 ${声明} ｜ 实况 ${real}`, exists: real === 声明,
    });
  }
  return out;
}

/* ────────────────────────── 跑 ────────────────────────── */

const roots = ONLY.length ? ONLY.map((r) => join(WS, r)) : [WS];
const files = roots.flatMap((r) => (statSafe(r)?.isDirectory() ? walk(r) : []));

function statSafe(p) { try { return statSync(p); } catch { return null; } }

const linkRows = checkLinks(files);
const ledgerRows = checkLedger(files);
const secRows = checkSectionRefs(files);
const skillRows = checkSkillClaims();
const all = [
  ...linkRows.map(r => ({ ...r, kind: '链接' })),
  ...ledgerRows.map(r => ({ ...r, kind: '台账' })),
  ...secRows.map(r => ({ ...r, kind: '章节' })),
  ...skillRows.map(r => ({ ...r, kind: 'skill声明' })),
];

const bad = all.filter(r => !r.exists);
const scope = ONLY.length ? ONLY.join(' ') : '全库（已排素材/上游/分享）';

if (JSON_OUT) {
  console.log(JSON.stringify({
    scope, files: files.length,
    total: all.length, bad: bad.length,
    badRows: bad,
  }, null, 2));
  process.exit(bad.length ? 1 : 0);
}

if (QUIET) {
  console.log(bad.length ? `✗ ${scope}：${bad.length} 处声称与实况不符` : `✓ ${scope}：${all.length} 处声称全部属实`);
  process.exit(bad.length ? 1 : 0);
}

console.log(`声称 vs 实况·  范围：${scope}`);
console.log(`扫 ${files.length} 份 md ｜ 检查 ${all.length} 处声称 ｜ 失效 ${bad.length} 处\n`);

for (const r of bad) {
  console.log(`  ✗ [${r.kind}] ${r.doc}`);
  console.log(`      ${r.text|| ''}${r.text ? ' → ' : ''}${r.target}`);
  console.log('');
}

if (bad.length) {
  console.log('修法：链接错位要人判断该改「显示文字」还是「路径层级」—— 实测两者都错过，脚本不猜。');
  console.log('台账声称不存在的文件：要么写那份文档，要么从台账里去掉。**不要留着空链接。**');
} else {
  console.log('✓ 所有声称的文件与章节都真实存在。');
}
process.exit(bad.length ? 1 : 0);