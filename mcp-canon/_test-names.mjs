#!/usr/bin/env node
/**
 * _test-names.mjs —— 中日姓名解析回归测试（v1.3 新增）
 *
 * 起因：`char{name:"三角初华"}` 返回「未找到角色」——库里主键是简称，全名/姓/日文名/舞台名
 * 全都不在索引里。本文件把「一个名字家族能写出的所有形态」钉成断言，防止再退化。
 *
 * 用法：node mcp-canon/_test-names.mjs     （不需要 Ollama，纯离线）
 */
import { createCharResolver, MANUAL_FOLD, MANUAL_ALIASES, deriveFoldPairs, makeNormalizer } from './name-index.mjs';
import { tools, resolveName, nameIndexStats, kb } from './canon-tools.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ALIASES_PATH } from './name-index.mjs';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail++; console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };

const R = createCharResolver({ characters: kb.characters });
const shortOf = (s) => { const r = R.resolve(s); return r && r.char ? r.char.name_short : (r?.ambiguous ? '歧义:' + r.ambiguous.map(x => x.char.name_short).join('/') : null); };

/* ── 1. 同一角色的「名字家族」全部形态 ─────────────────────────── */
const CASES = [
  /* 初华：简称 / 全名 / 姓 / 日文 / 舞台名 / 罗马音 / 官方串 / 带括注 */
  ['初华', '初华'], ['三角初华', '初华'], ['三角 初华', '初华'], ['三 角 初 华', '初华'],
  ['三角初華', '初华'], ['三角 初華', '初华'], ['三角', '初华'],
  ['Doloris', '初华'], ['doloris', '初华'], ['ドロリス', '初华'],
  ['Uika Misumi', '初华'], ['Misumi Uika', '初华'], ['uika', '初华'], ['Misumi', '初华'],
  ['初华（Doloris / Uika Misumi）', '初华'], ['Doloris / 三角初华', '初华'], ['初音', '初华'],
  /* 祥子：和制汉字 豊 → 丰 */
  ['祥子', '祥子'], ['丰川祥子', '祥子'], ['豊川祥子', '祥子'], ['豊川 祥子', '祥子'], ['丰川', '祥子'], ['小祥', '祥子'],
  ['Oblivionis', '祥子'], ['オブリビオニス', '祥子'], ['Sakiko Togawa', '祥子'],
  /* 睦：若葉 → 若叶 */
  ['睦', '睦'], ['若叶睦', '睦'], ['若葉睦', '睦'], ['若叶', '睦'], ['Mortis', '睦'], ['Mutsumi Wakaba', '睦'],
  /* 海铃 / 若麦：假名名（realJa 含假名，长度不等，靠别名行兜住） */
  ['八幡海铃', '海铃'], ['八幡海鈴', '海铃'], ['Timoris', '海铃'],
  ['祐天寺若麦', '若麦'], ['祐天寺にゃむ', '若麦'], ['にゃむ', '若麦'], ['Amoris', '若麦'],
  /* 爽世：realJa 是「長崎 そよ」——含假名的全名 */
  ['长崎爽世', '爽世'], ['長崎爽世', '爽世'], ['長崎そよ', '爽世'], ['長崎 そよ', '爽世'], ['そよ', '爽世'],
  /* 灯 / 乐奈 / 爱音 / 立希 */
  ['高松灯', '灯'], ['高松燈', '灯'], ['高松', '灯'], ['Tomori Takamatsu', '灯'], ['Takamatsu Tomori', '灯'], ['燈', '灯'],
  ['要乐奈', '乐奈'], ['要楽奈', '乐奈'], ['楽奈', '乐奈'],
  ['千早爱音', '爱音'], ['千早愛音', '爱音'], ['愛音', '爱音'],
  ['椎名立希', '立希'],
  /* millsage：手写字对 沢→泽、浜→滨 才能真正命中（推导因长度不等拿不到） */
  ['伊泽枣', '枣'], ['伊沢枣', '枣'], ['伊沢棗', '枣'],
  ['滨崎茉幌', '茉幌'], ['浜崎茉幌', '茉幌'], ['浜崎 まほろ', '茉幌'],
  ['汐见萤', '萤'], ['汐見蛍', '萤'],
  ['仲町阿拉蕾', '阿拉蕾'], ['仲町 あられ', '阿拉蕾'], ['あられ', '阿拉蕾'],
  ['峰月律', '律'], ['藤都子', '都子'], ['藤', '都子'], ['千石由乃', '由乃'], ['ユノ', '由乃'],
  ['琴平凪', '凪'], ['和泉朋花', '朋花'],
  /* 一家Dumb Rock! */
  ['须贺蕾叶', '蕾叶'], ['須賀蕾叶', '蕾叶'], ['马桥心玖', '心玖'], ['馬橋心玖', '心玖'],
  ['矢仓蓬咲', '蓬咲'], ['矢倉蓬咲', '蓬咲'], ['梅里千樱梨', '千樱梨'], ['梅里 ちえり', '千樱梨'], ['ちえり', '千樱梨'],
  ['四宫宁月', '宁月'], ['四宮寧月', '宁月'], ['四宮 寧月', '宁月'],
  /* 梦限大MewType 其余 */
  ['宫永野乃花', '野乃花'], ['宮永野乃花', '野乃花'], ['宮永 ののか', '野乃花'], ['ののか', '野乃花'],
];

for (const [input, want] of CASES) {
  const got = shortOf(input);
  ok(got === want, `「${input}」→ ${want}${got === want ? '' : `（实得 ${got}）`}`);
}

/* ── 2. 全 25 人的「中文全名 / 日文全名 / 姓」都能命中自己 ── */
const aliasDoc = JSON.parse(readFileSync(DEFAULT_ALIASES_PATH, 'utf8'));
let missFull = [], missJa = [], missFam = [];
for (const row of aliasDoc.characters) {
  if (shortOf(row.real) !== row.short) missFull.push(row.real);
  if (shortOf(row.realJa) !== row.short) missJa.push(row.realJa);
  const fam = row.real.endsWith(row.short) ? row.real.slice(0, row.real.length - row.short.length) : null;
  if (fam && shortOf(fam) !== row.short) missFam.push(fam);
}
ok(missFull.length === 0, `25 人中文全名全部命中（漏: ${missFull.join('、') || '无'}）`);
ok(missJa.length === 0, `25 人日文全名全部命中（漏: ${missJa.join('、') || '无'}）`);
ok(missFam.length === 0, `25 人「只写姓」全部命中（漏: ${missFam.join('、') || '无'}）`);

/* ── 3. 歧义 / 未命中：如实回报，不猜 ── */
const amb = resolveName('叶');
ok(!!amb?.ambiguous && amb.ambiguous.length > 1, `「叶」跨角色（若叶 / 蕾叶）→ 报歧义 ${amb?.ambiguous?.map(x => x.char.name_short).join('/')}`);
const unk = resolveName('不存在的角色');
ok(unk === null, '「不存在的角色」→ null（不瞎匹配）');
const sub = resolveName('祥');
ok(sub?.char?.name_short === '祥子' && sub.tier === 3, '「祥」→ 唯一子串命中 祥子（tier 3）');
const viaFam = resolveName('三角');
ok(viaFam?.via?.includes('姓') && viaFam.tier === 2, `「三角」命中路径标注为「${viaFam?.via}」`);
const viaStage = resolveName('Doloris'), viaStageJa = resolveName('ドロリス');
ok(viaStage.tier === 0 && viaStage.via === '别名', `「Doloris」命中 kb.aliases（tier 0 · ${viaStage.via}）——库里已有更权威的源就用它`);
ok(viaStageJa.via.includes('舞台名'), `「ドロリス」命中路径标注为「${viaStageJa.via}」（kb.aliases 没有片假名，靠 aliases.json 补）`);
ok(resolveName('三角初雪') === null, '「三角初雪」→ null：姓是弱证据，不做子串猜测（避免把别人认成初华）');

/* ── 4. 归一化细节 ── */
const derived = deriveFoldPairs(aliasDoc);
ok(derived['華'] === '华' && derived['豊'] === '丰' && derived['葉'] === '叶' && derived['蛍'] === '萤' && derived['鈴'] === '铃',
  `字对从 zh/ja 对照自动推导（華豊葉蛍鈴：${['華', '豊', '葉', '蛍', '鈴'].map(c => derived[c]).join('')}）`);
ok(!('そ' in derived) && !('に' in derived) && !('ゃ' in derived), '假名位置不产字对（そ/に/ゃ 未被误当成汉字映射）');
ok(MANUAL_FOLD['沢'] === '泽' && MANUAL_FOLD['浜'] === '滨', '手写补充只补推导拿不到的（沢→泽、浜→滨）');
ok(Object.keys(MANUAL_ALIASES).length <= 5, `手写昵称保持极小（${Object.keys(MANUAL_ALIASES).join('、')}）`);
ok(makeNormalizer(MANUAL_FOLD)('Ｓａｋｉｋｏ Ｔōｇａｗａ') === 'sakikotogawa', '全角与长音符被归一化（Ｓａｋｉｋｏ Ｔōｇａｗａ → sakikotogawa）');

/* ── 5. 工具层端到端：全名直接可用（这些以前全部 400） ── */
const asrt = (cond, msg) => ok(cond, msg);
const charFull = await tools.char.run({ name: '三角初华' });
asrt(charFull.id === 'uika' && charFull.name === '初华', `char{三角初华} → ${charFull.name}（命中路径 ${charFull._命中}）`);
asrt((await tools.char.run({ name: '豊川祥子' })).id === 'sakiko', 'char{豊川祥子} → 祥子');
asrt((await tools.state.run({ name: '三角初华' })).name === '初华', 'state{三角初华} → 初华');
asrt((await tools.sample.run({ name: '三角初华', n: 2 })).quotes.length === 2, 'sample{三角初华} → 取到 2 句');
asrt((await tools.speech.run({ names: ['三角初华', '豊川祥子'] })).角色.length === 2, 'speech{names:[三角初华,豊川祥子]} → 并排 2 人');
asrt((await tools.doc.run({ name: '三角初华', max_chars: 500 })).name === '初华', 'doc{三角初华} → 初华');
asrt((await tools.card.run({ name: '三角初华', max_chars: 200 })).file.includes('初华'), 'card{三角初华} → 找到角色卡文件');
asrt(!!(await tools.stats.run({ name: '三角初华' })).characters, 'stats{三角初华} → 单人报告');
const rel = await tools.rel.run({ a: '三角初华', b: '豊川祥子' });
asrt('初华_call_祥子' in rel, `rel{三角初华 × 豊川祥子} → ${JSON.stringify(rel).slice(0, 120)}`);
asrt((await tools.quote.run({ by: 'Doloris', top_k: 2 })).by === '初华', 'quote{by:Doloris} → 初华台词');
asrt((await tools.sample.run({ name: 'ドロリス', n: 1 })).name === '初华', 'sample{ドロリス} → 初华');

/* ── 6. 错误回执：给近似候选 + 乐队名提示，不再倒 25 个人名 ── */
const e1 = await tools.char.run({ name: '三角初雪' });
asrt(!!e1.error && e1.candidates.includes('初华'), `未知名回执给近似候选（${JSON.stringify(e1.candidates)}）`);
const e2 = await tools.char.run({ name: 'Ave Mujica' });
asrt(/乐队名/.test(e2.提示 || ''), `乐队名给成员名单（${e2.提示}）`);
const e3 = await tools.char.run({ name: '叶' });
asrt(/歧义/.test(e3.error) && e3.candidates.length > 1, `歧义回执（${e3.error}：${e3.candidates.join('、')}）`);
asrt(!e1.candidates || e1.candidates.length <= 6, 'candidates 是"最像的几个"而不是全部 25 人');

console.log(`\n── 名字索引 ──`);
console.log(JSON.stringify(nameIndexStats(), null, 2));
console.log(`\n${fail ? `✗ ${fail} 项断言失败` : `✓ 全部断言通过（${CASES.length} 条名字形态 + 25 人全量 + 工具端到端）`}`);
process.exit(fail ? 1 : 0);
