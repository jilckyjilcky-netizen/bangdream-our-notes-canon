#!/usr/bin/env node
/**
 * _test-tools.mjs —— 直接 import 工具层冒烟测试（不走 spawn，规避管道 EPERM）
 * v1.1：覆盖全部 12 个工具 + 关键回归断言。
 * 用法：node mcp-canon/_test-tools.mjs        （语义检索部分需要 Ollama；不可达会自动降级）
 */
import { tools, checkOllama, WAVE_CHARS, WAVE_EXPECT, SPEECH_METRICS } from './canon-tools.mjs';

const whoWave = (name) => WAVE_EXPECT.get(name);

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail++; console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };

(async () => {
  const up = await checkOllama();
  console.log(`✓ ollama 可达: ${up} ｜ 语义模型 qwen3-embedding:0.6b`);

  const show = (label, o) => {
    console.log(`\n━━━ ${label}（${elapsed()}）━━━`);
    console.log(JSON.stringify(o, null, 2).slice(0, 1400));
  };

  /* ---------- 检索类（需要 Ollama，不可达时自动纯词汇降级） ---------- */
  show('search: 害怕失去乐队的人', await tools.search.run({ q: '害怕失去乐队的人', top_k: 3 }));
  show('search: 抹茶', await tools.search.run({ q: '抹茶', top_k: 3 }));
  show('search: type=台词 · 一起前进', await tools.search.run({ q: '一起前进', top_k: 3, type: '台词' }));
  show('quote: 想和别人一起前进', await tools.quote.run({ q: '想和别人一起前进', top_k: 3 }));
  show('quote: by=爽世（限定说话人）', await tools.quote.run({ by: '爽世', top_k: 3 }));
  show('event: 面具', await tools.event.run({ q: '面具', top_k: 2 }));

  /* ---------- 档案 / 关系 ---------- */
  show('char: 初华', await tools.char.run({ name: '初华' }));
  show('rel: 灯×祥子', await tools.rel.run({ a: '灯', b: '祥子' }));
  show('list', await tools.list.run({ type: '场所' }));

  /* ---------- v1.1 新增工具 ---------- */
  const speech1 = await tools.speech.run({ name: '爽世' });
  show('speech: 爽世（明细）', speech1);
  ok(speech1.speech?.爽世?.['疑问率'] != null, 'speech 能答出「爽世疑问率」——交接文档里的实际痛点');

  const rank = await tools.speech.run({ metric: '疑问率', top_k: 5 });
  show('speech: 疑问率排名', rank);
  ok(rank.ranking?.length === 5 && rank.ranking[0].value >= rank.ranking[4].value, '疑问率排名为降序且 5 条');

  const amb = await tools.speech.run({ metric: '疑问' });
  ok(!!amb.error && amb.candidates.length > 1, '歧义指标名如实返回候选，不瞎猜');

  const cmp = await tools.speech.run({ names: ['爽世', '爱音', '乐奈'] });
  show('speech: 三人并排', { 角色: cmp.角色, 差异最大: cmp.差异最大 });
  ok(cmp.差异最大?.length === 5, '并排对比给出差异最大的 5 个指标');

  show('state: 初华', await tools.state.run({ name: '初华' }));
  const st = await tools.state.run({ q: '暗面' });
  ok(st.命中 > 0, `kb_state 跨角色搜到「暗面」${st.命中} 条`);

  const stats = await tools.stats.run({});
  show('stats（截断）', { meta: stats.meta, totals: stats.totals, 缺口: stats.缺口, 抽样偏差说明: stats.台词库抽样偏差.说明, 明显偏差: stats.台词库抽样偏差.明显偏差.slice(0, 6) });
  ok(stats.totals.角色 === 30, 'stats 总数 30 人');
  ok(stats.缺口.模型文档不存在.length === 0, 'stats：25 人模型文档全部存在');

  show('world: 抹茶（检索）', await tools.world.run({ q: '抹茶', top_k: 3 }));
  show('world: 场所全列', await tools.world.run({ kind: '场所' }));

  const s1 = await tools.sample.run({ name: '灯', n: 3 });
  const s2 = await tools.sample.run({ name: '灯', n: 3 });
  show('sample: 灯 ×3', s1);
  ok(JSON.stringify(s1.quotes) === JSON.stringify(s2.quotes), 'sample 同 seed 可复现');
  ok((await tools.sample.run({ name: '灯', n: 3, seed: 'other' })).quotes.some(q => !s1.quotes.includes(q)), 'sample 换 seed 会换样本');

  /* ---------- kb_who：单句 vs 多句 ---------- */
  const single = await tools.who.run({ text: '……嗯。歌词，写了一点点……' });
  show('who: 单句', { 句数: single.句数, leader: single.leader, guesses: single.guesses, caveat: single.caveat });
  ok(single.句数 >= 1 && single.guesses.length === 3, 'who 单句返回 3 个候选');

  const multi = await tools.who.run({ text: ['今天……谢谢你们。', '我、我只是想和小祥在一起而已！', '……对不起，我先走了。', '这种事，为什么非要问我？'] });
  show('who: 多句（数组）', { 句数: multi.句数, leader: multi.leader, guesses: multi.guesses, per_sentence: multi.per_sentence });
  ok(multi.句数 === 4 && multi.per_sentence.length === 4, 'who 多句输入被拆成 4 句并逐句给结果');

  const multiLine = await tools.who.run({ text: '嗯，我知道了。\n小祥……你回来了。\n那就一起走吧！' });
  ok(multiLine.句数 === 3, 'who 多行文本同样按句处理');

  const empty = await tools.who.run({ text: '???' });
  ok(!!empty.error, 'who 无有效句子时如实报错');

  const kanaOnly = await tools.who.run({ text: 'あ、ごめん。いや…そういうことじゃなくて。' });
  ok(!!kanaOnly.error && /假名/.test(kanaOnly.error), 'who 对纯假名输入如实说明「指纹基于中文剧本」，不静默返回空结果');

  /* ---------- v1.2 新增：角色卡 / 世界书 / 长文 ---------- */
  const card = await tools.card.run({ name: '灯' });
  show('card: 灯（SillyTavern V2）', { spec: card.spec, spec_version: card.spec_version, file: card.file, name: card.name, tags: card.tags, first_mes: card.first_mes });
  ok(card.spec === 'chara_card_v2' && !!card.first_mes, 'card 返回 SillyTavern V2 卡字段（含 first_mes）');
  const cardNarrow = await tools.card.run({ name: '蓬咲', max_chars: 200 });
  const truncMark = /共 (\d+) 字/;
  const cutField = Object.entries(cardNarrow).find(([k, v]) => typeof v === 'string' && truncMark.test(v));
  ok(!!cutField, `card 超过 max_chars 时截断并标注总字数（本次被截字段：${cutField?.[0] ?? '无'}）`);
  const cardFull = await tools.card.run({ name: '蓬咲', max_chars: 20000 });
  const cutPrefix = cutField ? String(cutField[1]).replace(/…（共 \d+ 字，需要全文用 max_chars）$/, '') : '';
  ok(cutField && String(cardFull[cutField[0]]).startsWith(cutPrefix) && !truncMark.test(String(cardFull[cutField[0]])),
    'card max_chars=20000 时不再截断，且与截断版前缀一致');
  ok(!!(await tools.card.run({ name: '不存在的角色' })).error, 'card 对未知角色如实报错并列候选');

  const wbIndex = await tools.worldbook.run({});
  show('worldbook: 目录（截断）', { 文件: wbIndex.文件, 词条数: wbIndex.词条数, 前3条: wbIndex.词条.slice(0, 3) });
  ok(wbIndex.词条数 === 50, `worldbook 目录 ${wbIndex.词条数} 条`);
  const wbMana = await tools.worldbook.run({ q: '真奈' });
  ok(wbMana.命中 > 0 && !!wbMana.词条?.[0]?.内容, 'worldbook 能查到 真奈（2026-10-04 新增词条）');
  const wbHit = await tools.worldbook.run({ q: 'MyGO' });
  show('worldbook: q=MyGO', { 命中: wbHit.命中, 首条: wbHit.词条?.[0] && { 标题: wbHit.词条[0].标题, 关键词: wbHit.词条[0].关键词, 内容前80: String(wbHit.词条[0].内容).slice(0, 80) } });
  ok(wbHit.命中 > 0 && !!wbHit.词条[0].内容, 'worldbook 按关键词命中并返回正文');

  const doc = await tools.doc.run({ name: '初华', kind: 'model', max_chars: 1500 });
  show('doc: 初华 model（截断）', { file: doc.file, 总字数: doc.总字数, 返回字数: doc.返回字数, truncated: doc.truncated, 开头: String(doc.content).slice(0, 120) });
  ok(doc.返回字数 === 1500 && doc.truncated === true, 'doc 按 max_chars 截断并如实标注');
  const prompt = await tools.doc.run({ name: '初华', kind: 'prompt' });
  ok(prompt.kind === 'prompt' && prompt.总字数 > 1000 && !prompt.truncated, 'doc kind=prompt 取到系统提示词全文');
  ok(!!(await tools.doc.run({ name: '初华', kind: 'model' })).content, 'doc 默认上限内返回完整模型文档');

  const manaPrompt = await tools.doc.run({ name: '真奈', kind: 'prompt' });
  ok(manaPrompt.kind === 'prompt' && manaPrompt.总字数 > 500 && !manaPrompt.truncated, 'doc kind=prompt 取到 真奈 系统提示词全文');
  const manaSkill = await tools.skill.run({ name: '真奈', part: 'all' });
  ok(manaSkill.id === 'mana' && !!manaSkill.parts?.skill && !!manaSkill.parts?.lines && !!manaSkill.parts?.lore,
    'skill 取到 真奈 的 人设skill/mana/（SKILL.md + lines + lore）');

  const stats2 = await tools.stats.run({});
  show('stats: 检索后端 + 文本资产', { 检索后端: stats2.检索后端, 文本资产: stats2.文本资产 });
  ok(!!stats2.检索后端?.模式, 'stats 自述检索后端（Ollama 未起时会给出恢复命令）');
  ok(stats2.文本资产.角色卡 === 30 && stats2.文本资产.世界书词条 === 50, 'stats 盘点文本资产（30 卡 / 50 词条）');
  ok(stats2.文本资产.系统提示词 === 26, `stats 盘点系统提示词 ${stats2.文本资产.系统提示词} 份（含 真奈）`);

  /* ---------- 回归断言（v1.0 / v1.1 的 bug 不再复现） ---------- */
  ok(WAVE_CHARS.length > 3 && !WAVE_CHARS.every(n => ['若麦', '爱音', '爽世'].includes(n)),
    `波浪号预期从数据派生（${WAVE_CHARS.length} 人，不止硬编码那 3 人）`);
  /* v1.1 从 quote_bank 派生 ⇒ 祥子因精选库里 1 条带「～」被判"该用波浪号"，
   * 而全量语料 1314 条里她用了 0 次 ⇒ 她按原作说话反而恒定吃 +1 维偏差。
   * 回归见 归档/_临时诊断/祥子_口径体检报告.md §四。 */
  ok(!WAVE_CHARS.includes('祥子') && !WAVE_CHARS.includes('灯') && !WAVE_CHARS.includes('立希') && !WAVE_CHARS.includes('海铃'),
    `零波浪号角色不再被判"该用波浪号"（祥子/灯/立希/海铃 均不在 ${WAVE_CHARS.length} 人名单里）`);
  ok(whoWave('祥子')?.expect === false && whoWave('祥子')?.语料率 === 0,
    '祥子的波浪号语料率登记为 0% ⇒ expect=false（v1.1 的误判已修）');
  ok(SPEECH_METRICS.length === 16, `指标清单 16 项（含「疑问率」，v1.0 曾因正则匹配不到而缺失）`);
  /* 工具数：v1.2 是 15、v1.5 加 skill/skills → 17。断言写成"清单与实现一致"而不是死数字，
   * 免得每次加工具都要回来改测试（旧断言死在 15 上，见 git 30815ed）。 */
  const TOOL_NAMES = ['list', 'char', 'rel', 'event', 'quote', 'search', 'who', 'speech', 'state', 'stats', 'world', 'sample', 'card', 'worldbook', 'doc', 'skill', 'skills'];
  ok(Object.keys(tools).length === TOOL_NAMES.length && TOOL_NAMES.every(n => typeof tools[n]?.run === 'function'),
    `工具总数 ${Object.keys(tools).length}（每个都有 run：${Object.keys(tools).join(',')}）`);
  ok(!Object.keys(tools).some(k => k.startsWith('kb_')), '工具名已去掉 kb_ 前缀（品牌由 mcp__canon__ 命名空间承担）');

  console.log(`\n${fail ? `✗ ${fail} 项断言失败` : '✓ 全部断言通过'}（${elapsed()}）`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST FAIL:', e); process.exit(1); });
