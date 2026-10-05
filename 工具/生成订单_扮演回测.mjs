#!/usr/bin/env node
/**
 * 生成订单_扮演回测.mjs —— A/B 两臂回测订单（25 人 × 2 = 50 单）
 *
 * 实验设计：两臂唯一变量是「给了什么材料」，场景/任务/句数/格式**逐字相同**；
 *   A 臂（盲测）= 只给该角色 150 句真实语料 → 基线（光看语料能模仿到什么程度）
 *   B 臂（处方）= 给该角色《角色扮演模型》＋《语言指纹报告》→ 测文档到底管不管用
 *   B − A 才是文档的增量价值；没有 A 臂，B 臂的数字无法解释。
 *
 * 口径：一句 = 语料里的一行台词（行级）。语料取样按行、不跨行合并；
 *       B 臂拿到的指纹报告由 工具/fingerprint_full.mjs 生成，已是行级值。
 *
 * 用法：
 *   node 工具/生成订单_扮演回测.mjs [--batch 扮演回测] [--all] [--句数 12] [--样本 150]
 *   产物：归档/_派发/<batch>/订单.jsonl（缺口动态算：该批次 out/ 里已有 result.md 的单不再下单）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WS, CHARS, corpusOf, modelOf, fpOf } from './角色表.mjs';

const argv = process.argv.slice(2);
const flagVal = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const BATCH = flagVal('batch', '扮演回测');
const ALL = argv.includes('--all');
const 样本句数 = Number(flagVal('样本', 150));
const 目标句数 = Number(flagVal('句数', 12));
const 批次目录 = join(WS, '归档', '_派发', BATCH);

/* 附加角色（真奈）不在乐队编制内：本批只做 25 名乐队角色（交接.md §二）。 */
const 名单 = [...CHARS].sort((a, b) => {
  const 序 = ['MyGO', 'Ave Mujica', '梦限大MewType', 'millsage', '一家Dumb Rock'];
  return (序.indexOf(a.band) - 序.indexOf(b.band)) || a.k.localeCompare(b.k, 'zh');
});

/* 路径一律走 工具/角色表.mjs（唯一源头）；附加角色的语料用 c.corpus 覆盖（同 audit_models 的约定）。 */
const 语料 = (c) => (c.corpus ? join(WS, c.corpus) : corpusOf(c));

/* ── 行级取样：一个物理行 = 一句台词（剔除歌词/心声，与 persona_check 同筛选） ── */
function 语料行(file) {
  const out = []; let skip = false;
  for (const l of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^##\s/.test(l)) { skip = l.replace(/^##\s+/, '').trim() === '出处目录'; continue; }
    if (skip) continue;
    if (/^<sub>/.test(l) || /^#/.test(l) || /^>/.test(l) || /^---/.test(l) || /^\*\*/.test(l)) continue;
    if (/^-\s/.test(l)) { const t = l.replace(/^-\s+/, '').replace(/\s/g, ''); if (t && !/^[『♪]/.test(t) && !/^（/.test(t)) out.push(t); }
  }
  return out;
}
function 等距抽样(lines, want) {
  if (lines.length <= want) return lines;
  const out = [], step = lines.length / want;
  for (let i = 0; i < want; i++) out.push(lines[Math.floor(i * step)]);
  return out;
}

/* ── 两臂共享的部分（必须逐字相同 ⇒ 只写一份常量） ── */
const 场景 = `【场景】
乐队练习结束后的傍晚。排练室沙发上只剩你一个人，队友都出去搬器材或买饮料了。
屋里很安静，只有空调运转的声音和远处传来的器材碰撞声。你在等他们回来。

【这次要你做的事】
写出「你」在这个场景里会说的话。要求：
· 是你独自一人时的自言自语、低声念叨，或者队友推门回来时你对他说的话；
· 必须**像你本人**——你的句长习惯、语气、口头禅、标点习惯都要对；
· 允许极短的应答、允许一整句只有「……」这类无文字停顿；
· 如果这个场景里你会喊某个队友，就用你平时称呼他的那个叫法，别改。`;

const 尾注 = (k) => `【注意】
· 上面【材料】只是给你找感觉用的，你要写的是**全新的台词**，不许照抄材料里的任何一句原话；
· 句长/各率一律按「一行台词」计；不要跨行合并，也不要自己数汉字；
· 不要复述材料，不要写解释，不要给你的台词加编号或标题。

【输出格式】严格遵守，除此之外**不要输出任何其它内容**（不要标题、不要编号、不要解释、不要总结）：
**${k}**：台词
每句一行，共 ${目标句数} 行。`;

function 材料A(c, lines) {
  return `【材料 · 你本人过去说过的台词（共 ${lines.length} 句，只给语感，不给任何指标）】
${lines.map((l) => '· ' + l).join('\n')}`;
}
function 材料B(c, model, fp) {
  return `【材料 · 你的《角色扮演模型》＋《语言指纹报告》（硬指标是真值，来自你全部语料的统计）】

=== 角色扮演模型 ===
${model}

=== 语言指纹报告 ===
${fp}`;
}
const 身份 = (c) => `【你是谁】你是《BanG Dream!》系列乐队「${c.band}」的成员，${c.full}（大家叫你「${c.k}」）。`;
const 拼装 = (c, material) => `${场景}\n\n${身份(c)}\n\n${material}\n\n${尾注(c.k)}`;

/* ── 生成 ── */
const 缺件 = [];
const 全部 = [];
const 跳过 = [];
let i = 0;
for (const c of 名单) {
  i++;
  const n = String(i).padStart(2, '0');
  const cp = 语料(c), mp = modelOf(c), fpp = fpOf(c);
  for (const [标签, p] of [['语料', cp], ['模型文档', mp], ['指纹报告', fpp]]) {
    if (!existsSync(p)) 缺件.push(`${c.k} 的${标签}：${p}`);
  }
  if (缺件.length) continue;
  const lines = 等距抽样(语料行(cp), 样本句数);
  const matA = 材料A(c, lines);
  const matB = 材料B(c, readFileSync(mp, 'utf8').trim(), readFileSync(fpp, 'utf8').trim());
  const promptA = 拼装(c, matA), promptB = 拼装(c, matB);

  /* 实验设计的机器校验：剥掉材料块后两臂必须逐字相同 */
  const 剥A = promptA.replace(matA, '§'), 剥B = promptB.replace(matB, '§');
  if (剥A !== 剥B) { 缺件.push(`${c.k}：两臂除材料外不逐字相同（实验设计被破坏）`); continue; }
  for (const [臂, p] of [['A', promptA], ['B', promptB]]) {
    全部.push({ id: `${臂}${n}-${c.k}`, tag: 臂 === 'A' ? 'A盲测' : 'B处方', arm: 臂, char: c.k, band: c.band, 温度: 0.85, prompt: p, priority: 'normal' });
  }
}
if (缺件.length) {
  console.error('✗ 生成中止：素材缺失或两臂不同构。先修好再生成：');
  for (const m of 缺件) console.error('   ' + m);
  process.exit(1);
}

/* prompt 纪律：不许出现"约 N 字"/"精确到 N 条"这类会诱发模型逐字验算的数字目标（交接.md §八.3）。
 * 数字只允许作为材料里的统计真值出现，不允许作为**任务要求**。 */
const 禁则 = [/约\s*\d+(?:\.\d+)?\s*字/, /\d+(?:\.\d+)?\s*[~－—-]\s*\d+(?:\.\d+)?\s*字(?:以内|以上)?/, /精确到\s*\d+/, /字数\s*[:：]/];
const 违例 = [];
for (const o of 全部) {
  const 任务段 = o.prompt.slice(0, 场景.length) + o.prompt.slice(o.prompt.length - 尾注(o.char).length);
  for (const re of 禁则) if (re.test(任务段)) 违例.push(`${o.id}：任务描述含数字目标 ${re}`);
}
if (违例.length) {
  console.error('✗ 生成中止：prompt 任务段出现精确数字目标（会诱发验算式思考）：');
  for (const v of 违例.slice(0, 10)) console.error('   ' + v);
  process.exit(1);
}

/* 缺口动态算：已经跑出 result.md 的单不再下单（跑过一遍的不该重复下单） */
const 已完成 = new Set();
if (!ALL) {
  for (const o of 全部) {
    const p = join(批次目录, 'out', o.id, 'result.md');
    try { if (readFileSync(p, 'utf8').trim()) 已完成.add(o.id); } catch {}
  }
}
const 订单 = 全部.filter(o => !已完成.has(o.id));

mkdirSync(批次目录, { recursive: true });
const 输出 = join(批次目录, '订单.jsonl');
writeFileSync(输出, 订单.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');

const A = 订单.filter(o => o.arm === 'A'), B = 订单.filter(o => o.arm === 'B');
const avg = (a) => (a.length ? a.reduce((s, o) => s + o.prompt.length, 0) / a.length : 0);
console.log(`✓ 生成 ${订单.length} 单 → ${输出}`);
console.log(`  A 臂（盲测，仅 ${样本句数} 句语料）  ${A.length} 单  平均 prompt ${avg(A).toFixed(0)} 字`);
console.log(`  B 臂（处方，模型+指纹）        ${B.length} 单  平均 prompt ${avg(B).toFixed(0)} 字`);
console.log(`  最大 prompt ${Math.max(...订单.map(o => o.prompt.length))} 字 ｜ 最小 ${Math.min(...订单.map(o => o.prompt.length))} 字`);
if (已完成.size) console.log(`  缺口动态算：跳过 ${已完成.size} 单（out/ 里已有 result.md）；--all 可强制全 ${全部.length} 单`);
console.log(`  每单要求：${目标句数} 行台词（两臂逐字相同的任务描述/句数/格式，唯一变量=材料）`);
console.log(`\n下一步： node 工具/派发器.mjs --in ${输出.replace(WS + '\\', '')} --out 归档/_派发/${BATCH}/ --dry`);
