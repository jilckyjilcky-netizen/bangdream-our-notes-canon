#!/usr/bin/env node
/**
 * 自检.mjs —— 全项目唯一验收入口
 *
 * 为什么要有这个脚本：
 *   此前"验收全绿"这件事散在 11 个入口、记在 3 份文档里（README / 交接.md / 交接计划）。
 *   人记不住跑哪几条，于是每次改动只跑记得住的那几条 —— 这是本项目文档数字反复漂移的
 *   直接成因之一（口径已修 5 轮仍在漂）。现在收成一个入口，退出码非 0 即失败。
 *
 * 硬约束（别改）：
 *   - 子进程一律 `stdio: 'inherit'`。本沙箱里 spawnSync 的**管道模式会静默失败**
 *     （status 恒为 null、stdout undefined，且不报错）——`check_doc_numbers.mjs` 就是撞的这个。
 *     代价：拿不到子进程 stdout 做二次断言，只取退出码。够用，且更诚实。
 *   - 只取**退出码**判定成败，不解析输出文本（文本断言各脚本自己做）。
 *   - 只读。本脚本不写任何文件。
 *
 * 用法：
 *   node 工具/自检.mjs              默认套件（12 项，全是快校验）
 *   node 工具/自检.mjs --all        追加 2 项（台词逐字对账报告 / 文档数字审计）
 *   node 工具/自检.mjs --only 词层  只跑名字含「词层」的那条
 *   node 工具/自检.mjs --list       只列清单不跑
 *   node 工具/自检.mjs --quiet      子脚本输出照常，只在最后打汇总
 *
 * 退出码：任一「必过」项非 0 → 1；全部通过 → 0。
 */

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = join(HERE, '..');

/**
 * kind:
 *   'must' 必过 —— 失败即整体验收失败
 *   'info' 报告类 —— 只跑不判（输出是给人看的报告，脚本本身不以退出码表达成败）
 */
const SUITES = [
  { name: '资料库完整性',   kind: 'must', args: ['工具/check_kb.mjs'] },
  { name: '资产缺口审计',   kind: 'must', args: ['工具/audit_models.mjs'] },
  { name: '词层清单',       kind: 'must', args: ['工具/lexicon.mjs', '--check'] },
  { name: '语域分档',       kind: 'must', args: ['工具/语域分档.mjs', '--check'] },
  { name: '波浪号基线',     kind: 'must', args: ['工具/build_wave_baseline.mjs', '--check'] },
  { name: '文件清单台账',   kind: 'must', args: ['工具/生成文件清单.mjs', '--check'] },
  // 规模类数字台账：README §4.0 总量表 / §4.4 .cache 状态 / 介绍.md 的角色数·世界书·角色卡…
  // 为什么单列一条：原有的 check_doc_numbers.mjs 只管**角色指纹指标**（均长/疑问率），
  // 管不到**规模数字**。这批数字的漂移路径完全不同 —— 资产一涨就在原地腐烂，
  // 而且**不会让任何东西报错**（文档不会因为自己写错而失败）。实测漂过：总量差 51%，
  // .cache 结论完全相反（有 1892 个却写着「已丢失」），介绍.md 通篇停在「30 名角色」（实际 47）。
  // 真值一律现算，只读；退出码非 0 即文档有数字对不上，照「实况」列改。
  { name: '规模数字台账',   kind: 'must', args: ['工具/check_doc_totals.mjs'] },
  // 声称 vs 实况（**文档链接与台账存在性**）：查的是「东西在不在」，不是「数字对不对」。
  // 为什么单列：前 7 项全在查数字与产物对齐上游，**没人问过「你声称存在的文件是不是真存在」**。
  // 实测事故（2026-10-05 深夜）：设计思路层 README §5「已完成」列 4 份单体，磁盘只有 2 份 ——
  // 初华.md / 祥子.md 从未存在，而另外 3 份文档共 8 处拿它们当论据引用，读者点进去是 404。
  // **自检 23 项全过**，因为文档不会因为自己写错而失败 —— 与规模数字漂移同源。
  // 覆盖三件事：相对链接可达 / README 台账声称项存在 / 本层裸 §x.y 章节引用不断链。
  { name: '声称与实况',     kind: 'must', args: ['工具/check_design_links.mjs'],
    note: '章节引用检查刻意只限本层（--only 可收窄）；全库下 §1.2 歧义太大，噪声会淹没真错' },
  { name: 'MCP 工具断言',   kind: 'must', args: ['mcp-canon/_test-tools.mjs'] },
  { name: 'MCP 名字索引',   kind: 'must', args: ['mcp-canon/_test-names.mjs'] },
  { name: 'MCP HTTP 传输',  kind: 'must', args: ['mcp-canon/_test-http.mjs'] },
  { name: '闸门复算',       kind: 'must', args: ['跑道/_闸门核对.mjs', '2'] },
  // 情绪标签（Live2D 演出层）：纯本地校验，读已有产物对账，不联网。
  // 产物缺失时先跑一次 `node 工具/情绪标签.mjs`（全量，会联网抓 946 剧本并缓存）。
  { name: '情绪标签',       kind: 'must', args: ['工具/情绪标签.mjs', '--check'],
    note: '产物缺失则先跑 node 工具/情绪标签.mjs（联网全量）' },
  // 剧情分析（跨话结构层）：纯本地，读 _emotion_lines.jsonl + 剧情分析/_data/*.json 对账。
  // 三个语义 json（因果链/伏笔/弧光）是人工写的，脚本只读不写；缺任一份会判失败，属预期。
  { name: '剧情分析',       kind: 'must', args: ['工具/build_story_analysis.mjs', '--check'],
    note: '需 剧情分析/_data/{causal_chain,foreshadows,character_arcs}.json 已填；只重算曲线用 --only 曲线' },
  // 乐队风格档案（light-novel-creator §1 的离线实现）：5 队 × 34 人，读 kb + 中文语料 + 情绪标签现算。
  { name: '乐队风格档案',   kind: 'must', args: ['工具/build_style_profile.mjs', '--check'],
    note: '依赖 情绪标签 产物；缺则本项失败，先跑 node 工具/情绪标签.mjs' },
  // 话层分析（以「话」为单元）：篇章结构（官方 exstory 拆分）+ 话内节拍 + 主导共演 + 羁绊阶梯。
  // 极性表复用 剧情分析/_data/emotion_polarity.json（真源），不另存一份。
  { name: '话层分析',       kind: 'must', args: ['工具/build_episode_analysis.mjs', '--check'],
    note: '依赖 情绪标签 与 剧情分析 的极性表；缺则先跑前两项' },
  // 章节标题：MasterAdv._titleTextId → MasterText 四语，946 条零缺失。
  // md 里的 # 标题已经是官方简中，本项只保证「日文原标题」这份上游数据不丢。
  { name: '章节标题',       kind: 'must', args: ['工具/build_chapter_titles.mjs', '--check'],
    note: '读 masterdata 现算；话层/剧情分析的 md 靠它补日文原标题' },
  // 非主线 660 剧：支线 25（均 64.7 句，做话层分析）+ 碎片 660（均 1.5/1.9 句，只统计说话人）。
  // 依赖 章节标题（区分类型），所以排在它后面。
  { name: '非主线',         kind: 'must', args: ['工具/build_sidestory_analysis.mjs', '--check'],
    note: '依赖 章节标题 与 情绪标签；碎片不做话层分析是有意的，见文档第一节' },
  // 动作指纹：演出层「动作（mtn_*）」这一半。既有 _演出指纹.md 只做到动作总榜前 20，
  // 角色级没有动作，且原始标签粒度太细（各 2~3%）看不出人 —— 这里按词根聚合算富集度。
  // 数据一直在 _emotion_lines.jsonl 的 mot 字段里（注意字段名是 mot 不是 mtn），纯本地算。
  { name: '动作指纹',       kind: 'must', args: ['工具/build_motion_profile.mjs', '--check'],
    note: '依赖 情绪标签 产物；调样本门槛用 --min <句数>，看明细用 --show' },
  // 羁绊态度：羁绊剧不是亲密度刻度，是「X 怎么看 Y」——50 对拆 100 个方向。
  // 称呼是统计挖的（句首/句末候选 + 下一句由对方接话 + 独占性过滤），没有词典；
  // 所以「挖到多少方向」受阈值影响，自检只卡结构性事实（100 方向 / 150 剧 / 至少挖到称呼）。
  { name: '羁绊态度',       kind: 'must', args: ['工具/build_bond_attitude.mjs', '--check'],
    note: '依赖 情绪标签 的逐句产物；称呼挖掘调参用 --show / --dbg <X>Y' },
  // 语气×感情交叉：把「怎么说话」和「什么情绪」两张此前互不引用的表接起来。
  // 依赖 情绪标签 的逐句产物，在**日文原文**上算语气指标（不是中文翻译），
  // 并一律用「相对该角色自己基线的 Δ」表达 —— 这样天然排除「她天生话少」的混淆。
  // 本体与舞台态（mutsumi / mortis）会写进同一份角色模型 md，所以注入按文件合并后落盘。
  { name: '语气感情交叉',   kind: 'must', args: ['工具/build_emotion_tone_cross.mjs', '--check'],
    note: '依赖 情绪标签；会幂等回写 28 份角色扮演模型 §3.9，看明细用 --show <角色名>' },
  // 叙事方式：「怎么讲」那一层（POV / 群像熵 / 篇幅形状 / 转折密度 / 收尾钩子 / 伏笔跨距）。
  // 介于说话指纹（怎么说）与剧情结构（讲了什么）之间，是唯一能直接迁移到自己写作的一层。
  // 依赖 话层分析 与 剧情分析 的全部产物 —— 两项缺产物会整队静默算成 0，所以排在它们后面。
  { name: '叙事方式',       kind: 'must', args: ['工具/build_narrative_profile.mjs', '--check'],
    note: '依赖 话层分析 + 剧情分析；看实测表用 --dry，重跑用 --force' },
  // 日中平行语料对照（light-novel-creator §2 的离线实现）：五队 · 109 话 · 逐块对齐。
  // 为什么单列：前四层**全部只跑 zh-Hans**（实测 grep "'ja'" build_style_profile.mjs 返回 0），
  // 而 素材全量/按话/ja/ 有 946 篇从未进过管线 —— 此前所有结论描述的是「译本」而非「原作」。
  // 本层负向测过两条：改 md 数字 / 移走队档案，两种都必须报错（实测均已验证）。
  // ⚠️ 已知坑：期望值必须用**渲染同一个函数**（r2）取。曾用 r2().toFixed(2) 比对，
  //    渲染得 "0.8" 而断言找 "0.80"，md 明明正确却报假红灯 —— 与假绿灯同样让闸门作废。
  { name: '双语对照',       kind: 'must', args: ['工具/build_bilingual_profile.mjs', '--check'],
    note: '看五队实测用 --dry；某队角色级明细用 --show <队目录名>' },
  // 已知边界（2026-10-05 实测）：这两条 selftest 内部要起本地 HTTP stub / 再 spawn 子进程，
  // 在**受限沙箱**里会失败（曾观察到 1/15、20 项失败），放开沙箱的同一命令 15/15、20/20 全过。
  // 所以这里失败时先看 note，别急着判回归 —— 换一个放开沙箱的会话复跑一次再下结论。
  { name: '派发器自检',     kind: 'must', args: ['工具/派发器.mjs', '--selftest'],
    note: '受限沙箱内可能因内部 stub server 失败，属环境边界，复跑确认' },
  { name: '回测打分自检',   kind: 'must', args: ['工具/回测_扮演.mjs', '--selftest'],
    note: '受限沙箱内可能因内部 spawn 失败，属环境边界，复跑确认' },

  // §9 Self Review 闸门：**负向测自己**，不是校验某一章。
  // 为什么必须双向：check_chapter 判❌ 的判据是「说话指纹偏离原作」——
  //   若判据写反了，它会对**照抄原作**的章报一堆偏离，看着像闸门很严，
  //   实际是废的。所以这里拿 4 份固定样本当基准：
  //     01混合（n 太小，只该给「样本不足」）→ 期望 0 项 ❌
  //     02 写飘（灯突然阳光活泼）→ 期望 **恰好 3 项** ❌
  //     03 照抄原作 30 句 → 期望 **0 项** ❌（防误报，这条最关键）
  //     04 禁令（插波浪号 + 非 CRYCHIC 期叫「小祥子」）→ 期望 **2 项** OOC
  // 任何一项对不上就说明判据漂了 —— 比「某章写得好不好」重要得多。
  { name: 'SelfReview闸门', kind: 'must', args: ['工具/_selftest/_跑负向测.mjs'],
    note: '验的是 check_chapter.mjs 的判据本身；样本在 工具/_selftest/' },

  // ---- 以下 --all 才跑 ----
  { name: 'skill 台词逐字对账', kind: 'info', all: true, args: ['工具/verify_skill_lines.mjs'],
    note: '输出是给人看的报告（当前 96.9%），脚本不以退出码表达成败' },
  { name: '文档数字口径审计', kind: 'info', all: true, args: ['工具/check_doc_numbers.mjs'],
    note: '本沙箱内 spawn 子进程必撞 EBUSY，预期失败；需人工绕开或改进程内调用' },
];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

let list = SUITES.filter((s) => has('--all') ? true : !s.all);
const only = val('--only');
if (only) {
  const hit = SUITES.filter((s) => s.name.includes(only));
  if (!hit.length) { console.error(`--only "${only}" 无匹配，可用：${SUITES.map(s => s.name).join(' / ')}`); process.exit(2); }
  list = hit;
}

if (has('--list')) {
  console.log('\n自检清单：');
  for (const s of SUITES) {
    console.log(`  [${s.kind === 'must' ? '必过' : '报告'}]${s.all ? '[--all]' : '      '} ${s.name.padEnd(18, '　')} node ${s.args.join(' ')}`);
  }
  process.exit(0);
}

const results = [];
console.log(`\n=== 自检 ${list.length} 项 ===\n`);

for (const s of list) {
  const t0 = Date.now();
  if (!has('--quiet')) console.log(`───── ${s.name} ｜ node ${s.args.join(' ')}`);
  let r;
  try {
    r = spawnSync(process.execPath, s.args, { cwd: WS, stdio: 'inherit' });
  } catch (e) {
    results.push({ ...s, status: 'THROW', ms: Date.now() - t0 });
    console.log(`\n[异常] ${s.name}: ${e.code || e.message}`);
    continue;
  }
  const ms = Date.now() - t0;
  // 沙箱边界：管道模式会静默失败（status null）。inherit 正常，但不排除将来回归，故显式识别。
  if (r.status === null) {
    results.push({ ...s, status: 'NULL(管道静默失败)', ms });
    console.log(`\n[异常] ${s.name}: 子进程 status=null —— 撞上本沙箱的 spawn 管道限制，请确认 stdio:'inherit' 未被改动`);
    continue;
  }
  results.push({ ...s, status: r.status, ms });
  if (!has('--quiet')) console.log('');
}

// 中文按 2 列宽算，否则汇总表对不齐
const dispW = (s) => [...String(s)].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dispW(s)));

console.log('\n═════ 汇总 ═════');
let failed = 0;
for (const r of results) {
  const ok = r.status === 0;
  if (!ok && r.kind === 'must') failed++;
  const mark = ok ? '✓' : (r.kind === 'must' ? '✗' : '·');
  console.log(`${mark} ${pad(r.name, 20)} ${pad(r.status, 6)} ${(r.ms / 1000).toFixed(1)}s${r.note && !ok ? '  ← ' + r.note : ''}`);
}

const mustTotal = results.filter((r) => r.kind === 'must').length;
console.log(`\n必过 ${mustTotal - failed}/${mustTotal} 通过${failed ? `，${failed} 项失败` : ''}`);
if (failed) {
  console.log('失败项：' + results.filter((r) => r.kind === 'must' && r.status !== 0).map((r) => r.name).join(' / '));
}
process.exit(failed ? 1 : 0);
