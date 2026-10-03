#!/usr/bin/env node
/**
 * canon.mjs —— 《BanG Dream! Our Notes》资料库 · 调度/搜索 CLI
 *
 * 作品：BanG Dream! Our Notes（MyGO!!!!! / Ave Mujica / 梦限大MewType / millsage / 一家Dumb Rock，25 人）
 * 数据：资料库/kb.json（由 build_kb.mjs 生成）+ 角色卡/ + 世界书/ + 角色模型/
 * 与 MCP 的关系：本 CLI 是 mcp-canon/ 那套工具的命令行外壳，名字一一对应（MCP 工具 `char` ↔ `canon.mjs char`）。
 *
 * 用法：
 *   node canon.mjs search <词> [--json]     全库全文检索（角色/事件/场所/物件/台词/关系）
 *   node canon.mjs char  <名字> [--json]    角色档案
 *   node canon.mjs rel   <角色A> <角色B>     双向关系查询
 *   node canon.mjs event <词> [--json]      事件检索
 *   node canon.mjs quote <词> [--json]      台词检索（含归属）
 *   node canon.mjs who   <台词…>            「这句是谁说的」——语言指纹打分（可多句）
 *   node canon.mjs speech <角色|指标>       语言指纹明细 / 全库排名
 *   node canon.mjs state <角色|关键词>      状态机
 *   node canon.mjs card  <名字>             SillyTavern V2 角色卡全文
 *   node canon.mjs worldbook [词]           世界书词条（目录 / 检索）
 *   node canon.mjs doc   <名字> [prompt]    完整《角色扮演模型》或系统提示词
 *   node canon.mjs list  [角色|事件|场所|物件]
 *   node canon.mjs help
 *
 * 全部命令支持 --json 输出，供程序调度。
 * who / speech / state / card / worldbook / doc 直接复用 mcp-canon/canon-tools.mjs 的同一份实现（MCP 与 CLI 不再各写一套）。
 * 语义检索走本地 Ollama（可选）：不装也能用，检索自动降级为纯词汇。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WS } from './_root.mjs';
import { whoGuess, tools as kbTools, pickChar } from '../mcp-canon/canon-tools.mjs';

const KB = JSON.parse(readFileSync(join(WS, '资料库', 'kb.json'), 'utf8'));
const [,, cmd, ...rest] = process.argv;
const asJson = rest.includes('--json');
const args = rest.filter(a => a !== '--json');

const hit = (hay, q) => hay.toLowerCase().includes(q.toLowerCase());
const show = (o) => { if (asJson) console.log(JSON.stringify(o, null, 2)); return o; };

/* ---- 实体定位：委托给 mcp-canon 的中日姓名索引 ----
 * 以前这里只认 id/简称/别名精确，于是「三角初华」「豊川祥子」「ドロリス」都查不到；
 * 现在与 MCP 工具共用同一套索引（全名/姓/名/舞台名/罗马音/简繁与和制汉字）。
 */
function resolveChar(name) {
  const p = pickChar(name);
  return p.err ? null : p.char;
}

/* ---- char：角色档案 ---- */
function cmdChar(name) {
  const c = resolveChar(name);
  if (!c) { const p = pickChar(name); console.log(p.err.error + (p.err.candidates ? `（最像的：${p.err.candidates.join('、')}）` : '') + (p.err.提示 ? `\n${p.err.提示}` : '')); return; }
  if (asJson) { show(c); return; }
  const L = [];
  L.push(`\n◆ ${c.name_short}（${c.en}）${c.stage ? ' · 舞台名 ' + c.stage : ''} ｜ ${c.band} ${c.role}`);
  L.push(`别名：${(c.aliases || []).join('、')}`);
  L.push(`宣传语：${c.tagline || '—'}`);
  L.push(`\n【基本】${c.basic['生日'] ? '生日 ' + c.basic['生日'] : ''}${c.basic['身高'] ? ' · ' + c.basic['身高'] : ''}${c.basic['学校'] ? ' · ' + c.basic['学校'] : ''}${c.basic['班级'] ? ' ' + c.basic['班级'] : ''}${c.basic['声优'] ? ' · CV ' + c.basic['声优'].replace(/^CV\.\s*/i, '') : ''}`);
  if (c.likes_interests.length) L.push(`喜欢/兴趣：${c.likes_interests.join(' ｜ ')}`);
  if (c.bio) L.push(`\n【简介】${c.bio}`);
  L.push(`\n【性格内核】\n· 核心：${c.personality.core}\n· 欲望：${c.personality.desire}\n· 恐惧：${c.personality.fear}\n· 防御：${c.personality.defense}\n· 弧光：${c.personality.arc}`);
  const fp = c.speech;
  L.push(`\n【语言指纹】`);
  for (const [k, v] of Object.entries(fp).filter(([k]) => ['省略号率','纯沉默占比','句长均值(汉字)','句长中位数','≤6字占比','疑问率','感叹率','口吃率','小X呼称率'].includes(k))) L.push(`· ${k}：${v}`);
  L.push(`\n【状态机】`);
  for (const s of c.states || []) L.push(`· ${s.name}：${(s.keys||[]).join(' / ')}（${s.speech||''}）`);
  L.push(`\n【关系】`);
  for (const r of c.relations || []) L.push(`· ${r.with}：称「${r.call}」—— ${r.tone}`);
  L.push(`\n【OOC红线】${(c.bans||[]).map(b=>'· '+b).join('\n')}`);
  if (c.quote_bank?.length) { L.push(`\n【代表性台词】`); for (const q of c.quote_bank.slice(0, 10)) L.push(`· 「${q}」`); }
  L.push(`\n【关联事件】${(c.events||[]).map(id=>KB.events.find(e=>e.id===id)?.name).filter(Boolean).join('、') || '—'}`);
  L.push(`\n完整模型：${c.doc}`);
  console.log(L.join('\n'));
}

/* ---- rel：双向关系 ---- */
function cmdRel(a, b) {
  const ca = resolveChar(a), cb = resolveChar(b);
  if (!ca || !cb) { console.log(`角色未找到：${!ca ? a : ''} ${!cb ? b : ''}`.trim()); return; }
  const ra = (ca.relations||[]).find(r => r.with.includes(cb.name_short) || cb.aliases?.includes(r.with) || cb.name_short.includes(r.with.replace('（','')));
  const rb = (cb.relations||[]).find(r => r.with.includes(ca.name_short) || ca.aliases?.includes(r.with) || ca.name_short.includes(r.with.replace('（','')));
  const out = {
    A: `${ca.name_short} → ${cb.name_short}`,
    A_call: ra ? ra.call : '语料无直接互动',
    A_tone: ra ? ra.tone : '—',
    B: `${cb.name_short} → ${ca.name_short}`,
    B_call: rb ? rb.call : '语料无直接互动',
    B_tone: rb ? rb.tone : '—'
  };
  if (asJson) { show(out); return; }
  console.log(`\n◆ 关系：${ca.name_short} × ${cb.name_short}`);
  console.log(`${ca.name_short}称呼${cb.name_short}：${out.A_call}`);
  console.log(`  → ${out.A_tone}`);
  console.log(`${cb.name_short}称呼${ca.name_short}：${out.B_call}`);
  console.log(`  → ${out.B_tone}`);
}

/* ---- search：全库检索 ---- */
function cmdSearch(q) {
  const ql = q.toLowerCase();
  const res = { characters: [], events: [], places: [], items: [], quotes: [] };
  for (const c of KB.characters) if (hit(KB.index[c.id], q)) res.characters.push({ id: c.id, name: c.name_short, band: c.band, role: c.role });
  for (const e of KB.events) if (hit(KB.index[e.id], q)) res.events.push({ id: e.id, name: e.name, episodes: e.episodes, summary: e.summary });
  for (const p of KB.places) if (hit(KB.index[p.id], q)) res.places.push({ id: p.id, name: p.name });
  for (const it of KB.items) if (hit(KB.index[it.id], q)) res.items.push({ id: it.id, name: it.name, kind: it.kind });
  for (const c of KB.characters) for (const qt of (c.quote_bank || [])) if (hit(qt, q)) res.quotes.push({ by: c.name_short, text: qt });
  if (asJson) { show(res); return; }
  const sec = (t, arr) => arr.length ? `\n【${t}】\n` + arr.map(x => Object.values(x).join(' · ')).join('\n') : '';
  console.log(sec('角色', res.characters) + sec('事件', res.events) + sec('场所', res.places) + sec('物件', res.items) + sec('台词', res.quotes));
  if (!res.characters.length && !res.events.length && !res.places.length && !res.items.length && !res.quotes.length) console.log(`无结果：「${q}」`);
}

/* ---- event / quote / list ---- */
const cmdEvent = (q) => {
  const r = KB.events.filter(e => hit(KB.index[e.id], q));
  if (asJson) { show(r); return; }
  for (const e of r) console.log(`\n◆ ${e.name}（${e.episodes.join('、')}）\n参与者：${e.participants.join('、')}\n${e.summary}\n关键词：${e.keywords.join('、')}`);
  if (!r.length) console.log(`无结果：「${q}」`);
};
const cmdQuote = (q) => {
  const r = [];
  for (const c of KB.characters) for (const qt of (c.quote_bank || [])) if (hit(qt, q)) r.push({ by: c.name_short, text: qt });
  if (asJson) { show(r); return; }
  for (const x of r) console.log(`· ${x.by}：「${x.text}」`);
  if (!r.length) console.log(`无结果：「${q}」`);
};
const cmdList = (t) => {
  const out = { 角色: KB.characters.map(c => `${c.name_short}（${c.band} ${c.role}）`), 事件: KB.events.map(e => e.name), 场所: KB.places.map(p => p.name), 物件: KB.items.map(i => `${i.name}（${i.kind}）`) };
  if (t && out[t]) { console.log(out[t].join('\n')); return; }
  for (const [k, v] of Object.entries(out)) console.log(`【${k}】\n${v.join('、')}\n`);
};

/* ---- who：按语言指纹猜说话人（v1.1 起直接复用 mcp-canon 工具层，避免两套实现漂移） ---- */
function cmdWho(text) {
  const r = whoGuess(text, { topK: 3 });
  if (r.error) { console.log(r.error + (r.提示 ? `\n${r.提示}` : '')); return; }
  if (asJson) { show(r); return; }
  const fp = r.fingerprint;
  console.log(`\n输入（${r.句数} 句）：${text.replace(/\n/g, ' / ')}`);
  console.log(`指纹：均长${fp.均长}字 ｜ ≤6字${fp['≤6字占比']}% ｜ 省略号${fp.省略号率}% ｜ 疑问${fp.疑问率}% ｜ 感叹结尾${fp['以!结尾']}% ｜ 小X${fp['小X呼称率']}%`);
  r.guesses.forEach((g, i) => console.log(`  ${i + 1}. ${g.name}（偏差分 ${g.score} ｜ 其中 ${g.votes} 句判给它）`));
  if (r.句数 > 1 && r.per_sentence) {
    console.log('\n逐句判断：');
    for (const p of r.per_sentence) console.log(`  · ${p.best}（${p.score}）← 「${p.text}」`);
  }
  console.log(`（${r.caveat}）`);
}

/* ---- speech：语言指纹明细 / 全库排名 ---- */
async function cmdSpeech(a) {
  const byChar = resolveChar(a);
  const r = await kbTools.speech.run(byChar ? { name: a } : { metric: a, top_k: 10 });
  if (asJson) { show(r); return; }
  if (r.error) { console.log(r.error); if (r.candidates) console.log('可选：' + r.candidates.join('、')); return; }
  if (r.ranking) {
    console.log(`\n◆ ${r.metric}（${r.order === 'asc' ? '从低到高' : '从高到低'}，有效 ${r.有效人数} 人）`);
    r.ranking.forEach((x, i) => console.log(`  ${String(i + 1).padStart(2)}. ${x.name.padEnd(4, '　')} ${x.raw}`));
    return;
  }
  for (const c of r.角色) {
    console.log(`\n◆ ${c.name}（${c.band} ${c.role}）语言指纹`);
    for (const [k, v] of Object.entries(r.speech[c.name] || {})) console.log(`  ${k}：${v}`);
    if (r.缺失指标[c.name]?.length) console.log(`  ⚠ 缺失指标：${r.缺失指标[c.name].join('、')}`);
  }
}

/* ---- state：状态机 ---- */
async function cmdState(a) {
  const r = await kbTools.state.run(resolveChar(a) ? { name: a } : { q: a });
  if (asJson) { show(r); return; }
  if (r.error) { console.log(r.error); if (r.全部状态名) console.log('全部状态名：' + r.全部状态名.join('、')); return; }
  if (r.hits) {
    console.log(`\n◆ 含「${r.q}」的状态（${r.命中} 条）`);
    for (const h of r.hits) console.log(`  · ${h.character}｜${h.state}：${(h.keys || []).join(' / ')}—— ${h.speech || ''}`);
    return;
  }
  console.log(`\n◆ ${r.name} 的状态机`);
  if (!r.states.length) { console.log('  （语料未登记状态机）'); return; }
  for (const s of r.states) console.log(`  · ${s.name}：${(s.keys || []).join(' / ')}—— ${s.speech || ''}`);
}

/* ---- card / worldbook / doc：同样是复用 MCP 工具层 ---- */
async function cmdCard(name) {
  const r = await kbTools.card.run({ name, max_chars: 4000 });
  if (asJson) { show(r); return; }
  if (r.error) { console.log(r.error); if (r.candidates) console.log('候选：' + r.candidates.join('、')); return; }
  console.log(`\n◆ ${r.name} 角色卡（${r.spec} ${r.spec_version}｜${r.file}）`);
  for (const k of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes']) {
    if (r[k]) console.log(`\n【${k}】\n${r[k]}`);
  }
  if (r.tags?.length) console.log(`\n标签：${r.tags.join('、')}`);
  console.log(`\n（${r.说明}）`);
}

async function cmdWorldbook(q) {
  const r = await kbTools.worldbook.run(q ? { q, top_k: 5 } : {});
  if (asJson) { show(r); return; }
  if (!q) {
    console.log(`\n◆ 世界书 ${r.文件}｜${r.词条数} 词条`);
    for (const e of r.词条) console.log(`  · ${e.标题}${e.关键词.length ? '（' + e.关键词.join('、') + '）' : ''} ${e.长度}字`);
    console.log('\n（给关键词取正文：canon.mjs worldbook <词>）');
    return;
  }
  if (!r.命中) { console.log(`无结果：「${q}」`); return; }
  for (const e of r.词条) console.log(`\n◆ ${e.标题}${e.关键词.length ? '（' + e.关键词.join('、') + '）' : ''}\n${e.内容}`);
}

async function cmdDoc(name, kindArg) {
  const kind = kindArg === 'prompt' ? 'prompt' : 'model';
  const r = await kbTools.doc.run({ name, kind, max_chars: 60000 });
  if (asJson) { show(r); return; }
  if (r.error) { console.log(r.error); return; }
  console.log(`\n◆ ${r.name} ${kind === 'prompt' ? '系统提示词' : '角色扮演模型'}｜${r.file}（${r.总字数} 字${r.truncated ? `，仅显示前 ${r.返回字数}` : ''}）\n`);
  console.log(r.content);
}

/* ---- help ---- */
const help = `《BanG Dream! Our Notes》资料库 CLI
  search <词>   全文检索（角色/事件/场所/物件/台词）
  char <名字>   角色档案     rel <A> <B> 双向关系
  event <词>    事件检索     quote <词>  台词检索
  who <台词…>   按语言指纹猜说话人（可多句：换行或分句，句数越多越稳）
  speech <角色|指标>  语言指纹明细 / 全库排名（如 speech 疑问率）
  state <角色|关键词> 状态机（如 state 初华 / state 暗面）
  card <名字>          SillyTavern V2 角色卡全文
  worldbook [词]       世界书词条（不带词=目录）
  doc <名字> [prompt]  完整《角色扮演模型》/ 系统提示词
  list [类型]   清单（角色/事件/场所/物件）
  所有命令可加 --json 输出`;

switch (cmd) {
  case 'search': cmdSearch(args[0] || ''); break;
  case 'char': cmdChar(args[0]); break;
  case 'rel': cmdRel(args[0], args[1]); break;
  case 'event': cmdEvent(args[0] || ''); break;
  case 'quote': cmdQuote(args[0] || ''); break;
  case 'who': cmdWho(args.join(' ') || ''); break;
  case 'speech': await cmdSpeech(args[0]); break;
  case 'state': await cmdState(args[0]); break;
  case 'card': await cmdCard(args[0]); break;
  case 'worldbook': await cmdWorldbook(args[0]); break;
  case 'doc': await cmdDoc(args[0], args[1]); break;
  case 'list': cmdList(args[0]); break;
  default: console.log(help);
}