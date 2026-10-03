#!/usr/bin/env node
/**
 * 跑道.mjs —— 「暗场」跑团终端 · 人类裁定版
 *
 * 三层分工（这个 demo 的全部主张）：
 *   推演   = 云端 qwen3.8:27b（思考与产出分离：reasoning 归后台，content 归裁定）
 *   取材/校验 = canon MCP 的**同一份实现**（mcp-canon/canon-tools.mjs，纯函数层，可 import）
 *   裁定   = 你（终端前的人类）：选一个走向 / 打回重推 / 同意后落地进 md
 *
 * 每回合的形状（对照"上下文只有台词与旁白"那条铁律）：
 *   读 md（世界/幕/时间线/手记）→ 装配工作台 → 推演出选项（丢弃）
 *   → 你选 → 演出 + 结算 → **delta 写回 md** → 下一回合再读
 *   模型不携带上一回合的思考；它的记忆就是那几个 md。
 *
 * 凭据只存一处（沿用 queue.mjs 的规矩）：环境变量优先，否则读 ../autodl-接入信息.md。
 *
 * 用法：
 *   node 跑道/跑道.mjs                       交互（输入操作文本 → 出选项 → 选/打回）
 *   node 跑道/跑道.mjs --脚本 跑道/_演示脚本.txt 脚本模式：逐行 await，可复现（推荐用来演示/回归）
 *   node 跑道/跑道.mjs --探端点               只测网关，不建台账
 *   node 跑道/跑道.mjs --初始化               从 开局.json 重建台账
 *   node 跑道/跑道.mjs --状态                 打印台账摘要
 *   node 跑道/跑道.mjs --档 幕                打印某份 md 全文
 *   node 跑道/跑道.mjs --装配                 只装配工作台（不调模型）
 *   node 跑道/跑道.mjs --act "操作文本"        单步：推演出选项（真身就是它，交互只是串起来）
 *   node 跑道/跑道.mjs --act "…" --pick 2     单步：选定 → 演出 → 闸门 → 落地
 *   node 跑道/跑道.mjs --act "…" --reject "理由"  单步：打回重推（进废案）
 *   node 跑道/跑道.mjs --工具 char '{"name":"祥子"}'   直接调 canon 工具（与 MCP 同源）
 *   node 跑道/跑道.mjs --json ...             机器可读
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { tools, pickChar, whoGuess, resolveName, kb } from '../mcp-canon/canon-tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(HERE, '..');
const 台账 = join(HERE, '台账');
const 回合档 = join(台账, '回合');
const 局档 = join(台账, '局.json');
const 开局 = join(HERE, '开局.json');

/**
 * 泛用配角白名单（来自 工具/素材提取/aliases.json 的 genericRoles）：这些角色可以没名字地出现。
 * 用途见 装配()：跑通第一局时模型自己造了一个不在 25 人里的「里美」（那是本作之外的角色），
 * 于是名册必须显式写进工作台——世界是闭的，不许新造人。
 */
const 泛用配角 = (() => {
  try { return JSON.parse(readFileSync(join(WS, '工具', '素材提取', 'aliases.json'), 'utf8')).genericRoles || []; }
  catch { return []; }
})();

/* ───────────────────────── 参数 / 展示 ───────────────────────── */
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const JSON_OUT = argv.includes('--json');
const TTY = process.stdout.isTTY && !JSON_OUT;
const paint = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const 灰 = paint('90'), 青 = paint('36'), 黄 = paint('33'), 绿 = paint('32'), 红 = paint('31'), 紫 = paint('35'), 粗 = paint('1');
const say = (...a) => { if (!JSON_OUT) console.log(...a); };
const rule = (t) => say(灰('─'.repeat(4) + ' ' + t + ' ' + '─'.repeat(Math.max(0, 62 - t.length * 2))));

/* ───────────────────────── 凭据（只存一处） ───────────────────────── */
function 网关() {
  let base = process.env.AUTODL_BASE_URL, key = process.env.AUTODL_API_KEY, model = process.env.AUTODL_MODEL;
  if (!base || !key) {
    const p = join(WS, 'autodl-接入信息.md');
    if (!existsSync(p)) throw new Error(`缺凭据：既没有 AUTODL_BASE_URL/AUTODL_API_KEY 环境变量，也找不到 ${p}`);
    const md = readFileSync(p, 'utf8');
    base = base || (md.match(/https:\/\/[^\s`|)]+\/v1/) || [])[0];
    key = key || (md.match(/sk-[A-Za-z0-9]{16,}/) || [])[0];
  }
  if (!base || !key) throw new Error('凭据解析失败：autodl-接入信息.md 里没找到 Base URL 或 API Key');
  return { base: base.replace(/\/$/, ''), key, model: model || 'qwen3.8:27b' };
}
/** 基础设施故障与"这次推演不合格"必须分开——端点挂了不是这局的问题（沿用队列的断路器思路）。 */
const 端点故障 = /HTTP (404|429|500|502|503|504)\b|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|UND_ERR/i;

/**
 * 问模型 —— 走 SSE 流式（本网关的规矩，沿用 订单队列/queue.mjs 的实测做法）。
 *
 * 为什么不是 stream:false：排障记录（跑道/_探流.mjs）显示这个网关对**长**非流式请求会
 * `fetch failed`（而 /v1/models 秒通）。队列一直走 SSE，是踩过的路。
 * 另外这张卡上 27B 的 decode 只有 ~20 tok/s，流式能边生成边报进度，
 * 不至于对着黑屏等三分钟还以为挂了（配合 autodl-接入信息.md 的「零并发」提醒：
 * 慢可能是排队——全局只有 1 个 slot）。
 * 思考与正文分开收：delta.reasoning 归后台（落盘前丢弃），delta.content 归裁定。
 */
async function 问模型(messages, { 温度 = 0.85, 超时 = 600000, json = true } = {}) {
  const GW = 网关();
  const t0 = Date.now();
  const H = { Authorization: `Bearer ${GW.key}`, 'Content-Type': 'application/json' };
  const 体 = (带json) => JSON.stringify({
    model: GW.model, messages, stream: true, temperature: 温度,
    ...(带json ? { response_format: { type: 'json_object' } } : {}),
  });
  const 秒 = () => +((Date.now() - t0) / 1000).toFixed(1);
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), 超时);
  let 正文 = '', 思考 = '', finish = null, usage = null, 进度计时 = null;
  try {
    let r = await fetch(`${GW.base}/chat/completions`, { method: 'POST', headers: H, body: 体(json), signal: ac.signal });
    /* 有些网关不接受 response_format + stream 的组合：只在这一种失败上降级重试一次。 */
    if (!r.ok && json && [400, 415, 422].includes(r.status)) {
      const t = await r.text().catch(() => '');
      if (/response_format|json_object/i.test(t)) {
        if (!JSON_OUT) process.stderr.write(`  · 网关不接受 response_format，去掉重试（${t.slice(0, 80)}）\n`);
        r = await fetch(`${GW.base}/chat/completions`, { method: 'POST', headers: H, body: 体(false), signal: ac.signal });
      } else throw new Error(`HTTP ${r.status}｜${t.slice(0, 300)}`);
    }
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`HTTP ${r.status}｜${t.slice(0, 300)}`); }
    if (!JSON_OUT) {
      进度计时 = setInterval(() => process.stderr.write(`  · 生成中 ${秒()}s｜思考 ${思考.length} 字｜正文 ${正文.length} 字\n`), 10000);
    }
    const rd = r.body.getReader();
    const dec = new TextDecoder();
    let sbuf = '';
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      sbuf += dec.decode(value, { stream: true });
      const lines = sbuf.split('\n'); sbuf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const p = t.slice(5).trim();
        if (p === '[DONE]') continue;
        let j; try { j = JSON.parse(p); } catch { continue; }
        const ch = j.choices?.[0]; if (!ch) continue;
        const d = ch.delta || {};
        const 思 = d.reasoning ?? d.reasoning_content ?? d.thinking ?? '';
        if (思) 思考 += 思;
        if (d.content) 正文 += d.content;
        if (ch.finish_reason) finish = ch.finish_reason;
        if (j.usage) usage = j.usage;
      }
    }
  } finally {
    clearTimeout(killer);
    if (进度计时) clearInterval(进度计时);
  }
  if (!正文.trim()) throw new Error(`正文为空（思考 ${思考.length} 字，finish=${finish}）——多半是被截断或排队超时，重试即可`);
  return { 正文, 思考, 用时: 秒(), 模型: GW.model, usage, finish };
}

/** 模型偶尔会把 JSON 包在 ```json 里或前后带话——这里做一次宽容解析，不做"猜内容"。 */
function 解析JSON(s) {
  const t = String(s || '').trim();
  try { return JSON.parse(t); } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
  return null;
}

/* ───────────────────────── 台账 IO ───────────────────────── */
const P = (n) => join(台账, n.endsWith('.md') || n.endsWith('.json') ? n : n + '.md');
const 读 = (p, d = '') => { try { return readFileSync(p, 'utf8'); } catch { return d; } };
const 读JSON = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };

function 初始化() {
  if (!existsSync(台账)) mkdirSync(回合档, { recursive: true });
  if (!existsSync(开局)) throw new Error(`缺 ${开局}`);
  const s = JSON.parse(readFileSync(开局, 'utf8'));
  const 世界 = [
    `# 世界 · 真相层（KP 全知）`, '',
    `> ${s.世界.注}`, '',
    `## 本局`, '',
    `- 主视角：${s.主视角}`,
    `- 开局：${s.时间}｜${s.地点}`,
    `- 在场：${s.在场.join('、')}`, '',
    `## 事实（角色自己知道，但从不主动说）`, '',
    ...s.世界.事实.map((x) => `- ${x}`), '',
    `## 未触发（碰到就会改变走向）`, '',
    ...s.世界.未触发.map((x) => `- ${x}`), '',
    `## 已触发`, '', '- （暂无）', '',
  ].join('\n');
  const 幕 = [`# 幕 · 第 0 回合（未开局）`, '', `- 地点：${s.地点}`, `- 时间：${s.时间}`, `- 在场：${s.在场.join('、')}`, `- 氛围：（待推演）`, `- 未解决：${s.悬念}`, ''].join('\n');
  const 时间线 = ['# 时间线（append-only：只追加，永不覆写）', '', '| 回合 | 发生了什么（不可逆） |', '|---|---|', `| 0 | 开局：${s.时间}｜${s.地点} |`, ''].join('\n');
  const 手记 = ['# 手记 · 玩家已知（允许是错的）', '', '> ✅ 事实 ｜ ❓ 玩家以为 ｜ ❌ 已被推翻', '', ...s.手记.map((x) => `- ${x}`), ''].join('\n');
  const 废案档 = ['# 废案 · 被否的推演（只有人类读这一份）', '', '> 打回不等于删除：被否的走向、理由、暗骰，全部留在这里。角色永远看不到它。', ''].join('\n');
  writeFileSync(P('世界'), 世界, 'utf8');
  writeFileSync(P('幕'), 幕, 'utf8');
  writeFileSync(P('时间线'), 时间线, 'utf8');
  writeFileSync(P('手记'), 手记, 'utf8');
  writeFileSync(P('废案'), 废案档, 'utf8');
  writeFileSync(局档, JSON.stringify({ 本局: s.本局, 回合: 0, 打回: 0, 开局时间: new Date().toISOString(), 历史: [] }, null, 2), 'utf8');
  return { 台账, 文件: ['世界.md', '幕.md', '时间线.md', '手记.md', '废案.md'] };
}
const 确保台账 = () => { if (!existsSync(局档)) 初始化(); return 读JSON(局档, { 回合: 0, 打回: 0, 历史: [] }); };
const 追加 = (p, text) => appendFileSync(p, text.replace(/\s*$/, '') + '\n', 'utf8');

/* ───────────────────────── 取材：canon（与 MCP 同一份实现） ───────────────────────── */
function 档案摘录(c) {
  const s = c.speech || {};
  const 关键 = ['句长均值(汉字)', '≤6字占比', '省略号率', '疑问率', '以?结尾', '小X呼称率', '纯沉默占比', '含我率'];
  return [
    `## 角色档案：${c.name_short}（${c.stage ? c.stage + ' / ' : ''}${c.en}）· ${c.band}`,
    `- 内核：${c.personality?.core || '—'}`,
    `- 想要：${c.personality?.desire || '—'}｜怕：${c.personality?.fear || '—'}｜防御：${c.personality?.defense || '—'}`,
    `- OOC 红线（违反即不合格）：${(c.bans || []).join('；')}`,
    `- 状态机：${(c.states || []).map((x) => `${x.name}（触发：${(x.keys || []).join('/')}）→ ${x.speech}`).join('｜')}`,
    `- 语言指纹（写台词必须贴这些数）：${关键.filter((k) => s[k] != null).map((k) => `${k} ${s[k]}`).join('｜')}`,
    `- 招牌台词（当味道参考，**不当范本**——它是精选样本，统计上与本人有偏差）：${(c.quote_bank || []).slice(0, 3).map((q) => `「${q}」`).join('')}`,
  ].join('\n');
}

/** 装配：读 md + canon 取材 → 交给模型的工作台（这一份就是"模型的全部上下文"）。 */
async function 装配(操作文本 = '') {
  const 局 = 确保台账();
  const 取材 = [];
  const md = {
    世界: 读(P('世界')), 幕: 读(P('幕')), 时间线: 读(P('时间线')), 手记: 读(P('手记')),
  };
  const 主 = 读JSON(开局, {}).主视角 || '祥子';
  const p = pickChar(主);
  if (p.err) throw new Error(`主视角解析失败：${p.err.error}`);
  const c = p.char;
  取材.push(`char ${主} ✓（${p.via}）`);

  const 在场 = (读JSON(开局, {}).在场 || []).filter((n) => n !== 主);
  const 关系 = [];
  for (const n of 在场) {
    const q = pickChar(n);
    if (q.err) continue;
    const r = await tools.rel.run({ a: 主, b: n });
    关系.push(JSON.stringify(r));
    取材.push(`rel ${主}×${n} ✓`);
  }
  const w = await tools.world.run({ q: (读JSON(开局, {}).地点 || '').slice(0, 12), top_k: 2 });
  取材.push(`world 「${(读JSON(开局, {}).地点 || '').slice(0, 12)}」 → ${(w.results || []).length} 条`);
  const hits = await tools.search.run({ q: 操作文本 || 读JSON(开局, {}).悬念 || '打工', top_k: 3 });
  取材.push(`search「${(操作文本 || '…').slice(0, 14)}」→ ${(hits.results || []).length} 条`);

  const 工作台 = [
    `### 台账：世界（KP 全知，玩家层看不到）`, md.世界.trim(),
    ``, `### 台账：幕（当前场景）`, md.幕.trim(),
    ``, `### 台账：时间线（不可逆事实）`, md.时间线.trim(),
    ``, `### 台账：手记（玩家已知，允许是错的）`, md.手记.trim(),
    ``, 档案摘录(c),
    关系.length ? `\n### 关系温度\n${关系.join('\n')}` : '',
    `\n### 世界只存在这些人（这条是硬边界）`,
    `- 在册角色（${kb.characters.length} 人，只能用这些名字）：${kb.characters.map((c) => c.name_short).join('、')}`,
    `- 泛用配角（可以出现但不给名字，或直接用这些称呼）：${泛用配角.join('、')}`,
    `- 不在上面两行的名字 = 新造人物，**禁止**。要陌生人就用泛用配角。`,
    `\n### canon 检索命中（供取材，未证实前不得当既成事实）`,
    ...(hits.results || []).map((h) => `- [${h.type}] ${h.name}：${String(h.text).slice(0, 120)}`),
    ...(w.results || []).map((h) => `- [${h.type}] ${h.name}：${String(h.summary || '').slice(0, 100)}`),
    `\n### 本回合回合数：第 ${局.回合 + 1} 回合`,
  ].filter(Boolean).join('\n');
  return { 工作台, 素材: { 角色: c, 关系, 命中: hits.results || [], 场所: w.results || [] }, 取材, 局, 主 };
}

/* ───────────────────────── 提示词 ───────────────────────── */
const KP提示词 = (工作台) => `你是《BanG Dream! Our Notes》世界的跑团 KP，主持一局单人视角的戏。
终端前的人类是**裁定者**：你只负责推演，不负责拍板。

工作台（读它，这是你的全部记忆；你上一回合的思考已经不存在了）：
${工作台}

铁律：
1. 你输出的是**候选走向**，不是结论：给 3 个互不相同的可行走向，各自写清「做法 / 判定 / 后果」。
2. 你有全知层（世界 md），但角色只知道角色能感知到的事。别让角色说出她不可能知道的东西。
3. 角色必须活在设定里：OOC 红线与语言指纹是硬约束，不是建议。
4. 人物只能从工作台的「在册角色」与「泛用配角」里取，**禁止新造人名**——世界是闭的。
5. 暗骰要给出一个明确的 1d100 结果，并说明它落在哪个区间（人类可以打回重掷）。
6. 只输出 JSON，不要任何解释文字。

输出 JSON：
{
  "推演": "两三句话：这一回合的张力在哪里、世界会怎么回应",
  "暗骰": { "表达": "1d100=63", "含义": "落在哪个区间 → 什么结果", "是否公开": false },
  "真相": ["只要人类同意就成立的、玩家层看不到的事实", "…"],
  "分诊": ["哪条写进世界/时间线/手记，哪条不许上台"],
  "选项": [
    { "编号": 1, "做法": "角色做什么", "判定": "世界怎么回", "后果": "代价或收益" },
    { "编号": 2, "做法": "…", "判定": "…", "后果": "…" },
    { "编号": 3, "做法": "…", "判定": "…", "后果": "…" }
  ]
}`;

const 演出提示词 = (工作台) => `你是这个世界（Our Notes）的跑团 KP，人类刚刚**选定**了一个走向。请把它演出来，并结算这一回合的世界变化。

工作台：
${工作台}

铁律：
1. 「演出」只能是台词与旁白，一行一句：旁白写「旁白：…」，角色说话写「祥子：「…」」。
2. 演出里**严禁**出现任何后台信息：不许出现判定、分数、选项、骰子、系统提示、心理分析。
3. 台词必须贴语言指纹（省略号频率、短句占比、疑问率），并守住 OOC 红线。
4. 「delta」是这一次世界真正发生的变化，要写得像台账而不是像小说：一行一件，可被下一回合直接使用。
5. 只输出 JSON，不要任何解释文字。

输出 JSON：
{
  "演出": ["旁白：…", "祥子：「…」"],
  "delta": {
    "幕": { "地点": "…", "时间": "…", "在场": ["…"], "氛围": "…", "未解决": ["…"] },
    "时间线": ["本回合不可逆地发生了什么（一行一件）"],
    "手记": ["✅ 事实：…", "❓ 玩家以为：…"],
    "世界已触发": ["若触发了世界 md 里的未触发项，写在这里"],
    "备注": "钱的增减、身体状态、物品等"
  }
}`;

/* ───────────────────────── 闸门（canon who + 三律） ───────────────────────── */
const 非数据禁词 = ['判定', '检定', '骰', '分数', '偏差', '选项', '系统', 'JSON', 'delta', '台账', 'KP', '语境', '上文'];
function 闸门(演出行, 主) {
  const 问题 = [], 提示 = [];
  for (const l of 演出行) {
    const m = String(l).match(/^([^：:]{1,8})[：:](.+)$/);
    if (!m) { 问题.push(`行格式不合规（须「说话人：内容」）：${l}`); continue; }
    const 内容 = m[2];
    const 撞 = 非数据禁词.filter((w) => 内容.includes(w));
    if (撞.length) 问题.push(`非数据律：${m[1]} 的一句里出现后台词形「${撞.join('、')}」——${l}`);
  }
  const 台词 = 演出行.filter((l) => String(l).startsWith(主 + '：') || String(l).startsWith(主 + ':')).map((l) => String(l).replace(/^[^：:]+[：:]/, '').replace(/^「|」$/g, ''));
  let 指纹 = null;
  if (台词.length) {
    /* topK 给满 25：只取前三的话，本人排到第 4 名就会被算成「第 0 名、偏差 undefined」——
     * 那不是"没问题"，是"报不出来"。闸门的结论必须可解释，还得说得出**差在哪一项**，
     * 否则人类裁定者拿不到打回的理由（打回时要写理由，这是这局的设计）。 */
    const r = whoGuess(台词, { topK: 25 });
    if (r && !r.error) {
      const 榜 = r.guesses || [];
      const i = 榜.findIndex((g) => g.name === 主);
      const mine = i >= 0 ? 榜[i] : null;
      const 前三 = 榜.slice(0, 3).map((g) => `${g.name} ${g.score}`);
      指纹 = {
        句数: r.句数, leader: r.leader,
        本人排名: i >= 0 ? i + 1 : null,
        本人偏差: mine?.score ?? null,
        本人失分项: mine?.worst || [],
        前三,
      };
      if (r.leader !== 主) {
        const 位次 = i >= 0 ? `第 ${i + 1} 名（偏差 ${mine.score}）` : '未参与打分';
        const 差在哪 = (mine?.worst || []).slice(0, 3).join('、') || '—';
        /* 样本量门槛（2026-10-03）：who 在句数不足时排名落在噪声区（实测 2 句时前三偏差挤在
         * 0.111/0.124/0.132，根本不是"谁更像"）。此时"判 leader 不是本人"不是失败，是噪声，
         * 只进提示、不判失败——人类裁定者靠偏差项判断，而不是被一个噪声结论误导。 */
        if (r.句数 < 4) {
          提示.push(`语言指纹样本不足（${r.句数} 句；who 建议 ≥3~5 句才稳）：who 判 leader 是「${r.leader}」而非「${主}」，但此排名落在噪声区间，**别据此打回**；${主} ${位次}，最大偏差项：${差在哪}`);
        } else {
          问题.push(`语言指纹：who 判 leader 是「${r.leader}」而不是「${主}」——${主} ${位次}；最大偏差项：${差在哪}`);
        }
      }
      /* 样本量警告：who 自己的说明是「句数越多估计越稳」。第 2 回合实测只有 2 句台词，
       * 前三名的偏差挤在 0.111 / 0.124 / 0.132 —— 这不是"谁更像"，是噪声。
       * 这类结论不该判失败，但必须让裁定者知道它有多可信。
       * 若 leader≠主 且句数<4，上面的分支已提示过，这里不再重复。 */
      if (r.句数 < 4 && r.leader === 主) 提示.push(`语言指纹样本不足（${r.句数} 句；who 建议 ≥3~5 句才稳）：本回合的排名与偏差落在噪声区间，别据此打回`);
      if (i >= 0 && r.leader !== 主 && Math.abs((mine?.score ?? 1) - (r.guesses?.[0]?.score ?? 0)) < 0.03) {
        提示.push(`${主} 与 leader 的偏差差 ${(Math.abs(mine.score - r.guesses[0].score)).toFixed(3)}（<0.03）：属并列边缘，别当成硬伤`);
      }
    }
  }
  return { 通过: 问题.length === 0, 问题, 提示, 指纹 };
}

/* ───────────────────────── 推演 / 演出 / 落地 ───────────────────────── */
async function 推演(操作文本, 打回理由 = '') {
  const 台 = await 装配(操作文本);
  const user = [
    `【本回合的操作声明（人类裁定者的输入）】`, 操作文本,
    打回理由 ? `\n【上一版被打回，理由】${打回理由}\n请换一批走向，不要重复上一版。` : '',
  ].filter(Boolean).join('\n');
  const r = await 问模型([{ role: 'system', content: KP提示词(台.工作台) }, { role: 'user', content: user }]);
  const j = 解析JSON(r.正文);
  return { ...台, 操作文本, 模型: r, 推演: j, 工作台字数: 台.工作台.length };
}

async function 演出(操作文本, 选中, 台) {
  const user = [
    `【本回合的操作声明】`, 操作文本,
    `\n【人类选定的走向（已裁定，照它演）】`, `做法：${选中.做法}\n判定：${选中.判定}\n后果：${选中.后果}`,
  ].join('\n');
  const r = await 问模型([{ role: 'system', content: 演出提示词(台.工作台) }, { role: 'user', content: user }], { 温度: 0.7 });
  const j = 解析JSON(r.正文);
  const 演出行 = (j?.演出 || []).filter(Boolean);
  const 门 = 闸门(演出行, 台.主);
  return { 模型: r, 结果: j, 演出行, 门 };
}

function 落地(台, 操作文本, 选中, 演, 推, 打回理由 = '') {
  const 局 = 读JSON(局档, { 回合: 0, 打回: 0, 历史: [] });
  const n = 局.回合 + 1;
  const d = 演.结果?.delta || {};
  /* 幕：唯一可覆写的文件 */
  const 幕 = d.幕 || {};
  writeFileSync(P('幕'), [
    `# 幕 · 第 ${n} 回合`, '',
    `- 地点：${幕.地点 || '—'}`,
    `- 时间：${幕.时间 || '—'}`,
    `- 在场：${(幕.在场 || []).join('、') || '—'}`,
    `- 氛围：${幕.氛围 || '—'}`,
    `- 未解决：${(幕.未解决 || []).join('；') || '—'}`, '',
  ].join('\n'), 'utf8');
  /* 其余一律 append-only */
  if (d.时间线?.length) 追加(P('时间线'), d.时间线.map((x) => `| ${n} | ${x} |`).join('\n'));
  if (d.手记?.length) 追加(P('手记'), d.手记.map((x) => `- ${x}`).join('\n'));
  if (d.世界已触发?.length) 追加(P('世界'), `\n> 第 ${n} 回合触发\n` + d.世界已触发.map((x) => `- ${x}`).join('\n'));
  /* 回合档：这一回合的全记录（含被丢弃的推演） */
  writeFileSync(join(回合档, `第${n}回合.md`), [
    `# 第 ${n} 回合`, '',
    `## 操作声明（人类输入）`, '', 操作文本, '',
    `## 推演（模型产出，裁定后即丢弃）`, '',
    `- 推演：${推.推演?.推演 || '—'}`,
    `- 暗骰：${推.推演?.暗骰?.表达 || '—'}（${推.推演?.暗骰?.含义 || '—'}）｜公开：${推.推演?.暗骰?.是否公开 ? '是' : '否'}`,
    `- 真相（玩家层看不到）：`, ...(推.推演?.真相 || []).map((x) => `  - ${x}`),
    `- 分诊：${(推.推演?.分诊 || []).join('；')}`, '',
    `## 候选走向`, '',
    ...(推.推演?.选项 || []).map((o) => `- ${o.编号}. ${o.做法}\n  - 判定：${o.判定}\n  - 后果：${o.后果}`), '',
    `## 人类裁定：选 ${选中.编号}`, '', `- ${选中.做法}`, '',
    `## 演出（上台；这一份才是进入上下文的文本）`, '', ...演.演出行.map((l) => `- ${l}`), '',
    `## 闸门（canon who + 投影三律）`, '',
    `- 结论：${演.门.通过 ? '通过' : '有问题（见下）'}`,
    ...(演.门.问题.length ? 演.门.问题.map((x) => `- ⚠ ${x}`) : ['- 无违规']),
    ...(演.门.提示?.length ? 演.门.提示.map((x) => `- · ${x}`) : []),
    演.门.指纹 ? `- 指纹：句数 ${演.门.指纹.句数}｜leader ${演.门.指纹.leader}｜${台.主} 排名第 ${演.门.指纹.本人排名}（偏差 ${演.门.指纹.本人偏差}）｜${台.主} 失分项 ${(演.门.指纹.本人失分项 || []).join('、') || '—'}｜前三 ${演.门.指纹.前三.join(' / ')}` : '- 指纹：本回合无台词',
    '',
    `## 上下文体检`, '',
    `- 工作台（读入）：${推.工作台字数} 字`,
    /* 丢弃的账要算全：演出那一次的思考流往往比推演还长（第 2 回合实测 12724 字），
     * 漏掉它会让"思考不入流"这个主张看起来比实际漂亮。 */
    (() => {
      const 丢弃 = { 推演思考: (推.模型.思考 || '').length, 推演正文: (推.模型.正文 || '').length, 演出思考: (演.模型.思考 || '').length, 演出正文: (演.模型.正文 || '').length };
      const 总 = Object.values(丢弃).reduce((a, b) => a + b, 0);
      const 上台 = 演.演出行.join('').length;
      return [
        `- 本回合丢弃：推演思考 ${丢弃.推演思考} + 推演正文 ${丢弃.推演正文} + 演出思考 ${丢弃.演出思考} + 演出正文 ${丢弃.演出正文} = **${总} 字**（全部不进上下文）`,
        `- 本回合上台（写进 md 的演出）：${上台} 字`,
        `- 丢弃 : 上台 = ${上台 ? (总 / 上台).toFixed(1) : '—'} : 1`,
      ].join('\n');
    })(),
    '',
  ].join('\n'), 'utf8');
  /* 废案：打回记录 */
  if (打回理由) 追加(P('废案'), [`## 第 ${n} 回合 · 打回`, '', `理由：${打回理由}`, '', `被打回的走向：`, ...(推.推演?.选项 || []).map((o) => `- ${o.编号}. ${o.做法}（${o.后果}）`), '', `暗骰：${推.推演?.暗骰?.表达 || '—'}`, `真相：${(推.推演?.真相 || []).join('；') || '—'}`, ''].join('\n'));
  局.回合 = n;
  局.历史 = [...(局.历史 || []), { 回合: n, 操作: 操作文本.slice(0, 60), 选: `${选中.编号}. ${选中.做法}`.slice(0, 60), 闸门: 演.门.通过 ? 'pass' : '⚠', 打回: 打回理由 || null }];
  writeFileSync(局档, JSON.stringify(局, null, 2), 'utf8');
  return { n, 写入: ['幕.md（覆写）', '时间线.md（追加）', '手记.md（追加）', `回合/第${n}回合.md`, 打回理由 ? '废案.md（追加）' : null].filter(Boolean) };
}

/* ───────────────────────── 展示 ───────────────────────── */
function 打印推演(推) {
  const j = 推.推演;
  say('');
  rule(`KP 后台 · 第 ${推.局.回合 + 1} 回合`);
  say(`${灰('取材')} ${推.取材.join(' ｜ ')}`);
  say(`${灰('工作台')} ${推.工作台字数} 字（这就是模型读到的全部）｜${灰(`推演 ${推.模型.用时}s`)}`);
  if (!j) { say(红('模型没吐出合法 JSON。原文：')); say(推.模型.正文.slice(0, 600)); return; }
  say(`${紫('推演')} ${j.推演 || '—'}`);
  if (j.暗骰) say(`${黄('暗骰')} ${j.暗骰.表达 || '—'} → ${j.暗骰.含义 || '—'} ${j.暗骰.是否公开 ? 绿('[公开]') : 红('[不公开]')}`);
  if (j.真相?.length) { say(`${红('真相（玩家层看不到）')}`); for (const x of j.真相) say(`  · ${x}`); }
  if (j.分诊?.length) say(`${灰('分诊')} ${j.分诊.join('；')}`);
  if (推.模型.思考) say(灰(`思考流 ${推.模型.思考.length} 字（后台，落盘前丢弃）`));
  say('');
  rule('候选走向（你裁定）');
  for (const o of j.选项 || []) say(`  ${粗(String(o.编号))}. ${o.做法}\n     ${灰('判定')} ${o.判定}\n     ${灰('后果')} ${o.后果}`);
  say('');
  say(`${灰('输入编号选定 ｜ `打回 理由` 重推 ｜ `:状态` `:档 幕` `:工具 char {"name":"祥子"}` ｜ `:退出`')}`);
}

function 打印落地(演, 落, 主) {
  say('');
  rule('演出（这一份才进上下文）');
  const 门 = 演.门;
  if (演.门.指纹) say(灰(`闸门 who：leader ${演.门.指纹.leader}｜${主} 第 ${演.门.指纹.本人排名}（偏差 ${演.门.指纹.本人偏差}）｜前三 ${演.门.指纹.前三.join(' / ')}`));
  if (演.门.指纹?.本人失分项?.length) say(灰(`  ↳ ${主} 的最大偏差项：${演.门.指纹.本人失分项.join('、')}（打回时可以照这个写理由）`));
  for (const l of 演.演出行) {
    const 是台词 = new RegExp(`^${主}[：:]`).test(l);
    say(是台词 ? 青(`  ${l}`) : 灰(`  ${l}`));
  }
  for (const p of 门.问题) say(红(`  ⚠ ${p}`));
  for (const p of 门.提示 || []) say(黄(`  · ${p}`));
  say(门.通过 ? 绿('  ✓ 闸门通过（三律 + 指纹）') : 黄('  ⚠ 闸门有问题上面标了——下一回合可以直接打回重演'));
  say('');
  rule(`落地 · 第 ${落.n} 回合`);
  for (const f of 落.写入) say(`  ${绿('✓')} ${f}`);
  say(`${灰('台账')} ${P('世界').replace(WS + '\\', '')} 等 ${落.写入.length} 处 ｜ ${灰(`模型 ${演.模型.用时}s`)}`);
}

function 打印状态() {
  const 局 = 读JSON(局档, null);
  if (!局) { say('台账还没建。先跑：node 跑道/跑道.mjs --初始化'); return; }
  say('');
  rule(`台账 · ${局.本局}`);
  say(`${灰('回合')} ${局.回合}｜${灰('打回')} ${局.打回}｜${灰('开局')} ${局.开局时间}`);
  for (const f of ['世界', '幕', '时间线', '手记', '废案']) {
    const t = 读(P(f));
    say(`${粗(f + '.md')} ${t.length} 字`);
    if (f === '幕') say(t.split('\n').filter((l) => l.startsWith('- ')).map((l) => `  ${l}`).join('\n'));
  }
  say('');
  for (const h of 局.历史 || []) say(`  ${灰('第' + h.回合 + '回合')} ${h.操作} → ${h.选} ${h.闸门 === 'pass' ? '✓' : '⚠'}${h.打回 ? `（打回：${h.打回}）` : ''}`);
}

/* ───────────────────────── 入口 ───────────────────────── */
async function 探端点() {
  const GW = 网关();
  say(`${灰('端点')} ${GW.base}`);
  say(`${灰('模型')} ${GW.model}`);
  /* 第一步：/models 不加载模型，用它区分「隧道/网关死了」和「27B 冷加载慢」。
   * 本机 .NET 与 curl.exe 的 schannel 有故障（autodl-接入信息.md §四），所以必须走 Node。 */
  const t0 = Date.now();
  let ids = null;
  try {
    const r = await fetch(`${GW.base}/models`, { headers: { Authorization: `Bearer ${GW.key}` }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    ids = (await r.json()).data?.map((m) => m.id) || [];
    say(`${绿('✓ 网关活着')} ${((Date.now() - t0) / 1000).toFixed(1)}s｜可用模型：${ids.join('、') || '（空）'}`);
    if (ids.length && !ids.includes(GW.model)) say(黄(`⚠ ${GW.model} 不在列表里——可能是网关配置变了`));
  } catch (e) {
    say(`${红('✗ 网关不通')} ${e.message}`);
    say(黄('这属于基础设施故障，不是本局的问题：AutoDL 实例重建会换域名与 Key（autodl-接入信息.md §五）'));
    return { 端点: GW.base, 网关: false, 错误: e.message };
  }
  /* 第二步：真发一次短请求。第一次调用可能触发 27B 冷加载，所以给足时间。 */
  say(灰('发一次短请求（首次可能触发 27B 冷加载，慢是正常的）…'));
  const r = await 问模型([{ role: 'user', content: '只回一个 JSON：{"ok":true,"你是谁":"一句话"}' }], { json: true, 超时: 420000 });
  say(`${绿('✓ 通了')} ${r.用时}s｜${灰('content')} ${r.正文.slice(0, 200)}`);
  if (r.思考) say(`${紫('思考流字段存在')}（${r.思考.length} 字）—— 这正好是这个模式要的「思考与产出分离」`);
  return { 端点: GW.base, 网关: true, 可用模型: ids, 模型: GW.model, 用时: r.用时, 正文: r.正文, 有思考流: !!r.思考 };
}

async function 单步() {
  const act = flag('act'), pick = flag('pick'), reject = flag('reject');
  const 局 = 确保台账();
  if (reject && typeof reject === 'string') {
    const 推 = await 推演(act, reject);
    const 假选 = { 编号: 0, 做法: `（打回：${reject}）`, 判定: '—', 后果: '—' };
    落地(推, act, 假选, { 模型: { 正文: '', 思考: '', 用时: '0' }, 结果: { delta: {} }, 演出行: [], 门: { 通过: true, 问题: [], 指纹: null } }, 推, reject);
    局.打回 = (局.打回 || 0) + 1;
    writeFileSync(局档, JSON.stringify(局, null, 2), 'utf8');
    打印推演(推);
    say(`${黄('已打回')}：理由与那一版走向已进 废案.md（角色永远看不到）`);
    return { 模式: '打回', 推演: 推.推演, 取材: 推.取材 };
  }
  const 推 = await 推演(act || '');
  打印推演(推);
  if (!pick) return { 模式: '推演', 取材: 推.取材, 工作台字数: 推.工作台字数, 推演: 推.推演, 选项: 推.推演?.选项 };
  const 选中 = (推.推演?.选项 || []).find((o) => String(o.编号) === String(pick));
  if (!选中) { say(红(`没有编号 ${pick} 的选项`)); return { 模式: '错误', 选项: 推.推演?.选项 }; }
  const 演 = await 演出(act || '', 选中, 推);
  const 落 = 落地(推, act || '', 选中, 演, 推);
  打印落地(演, 落, 推.主);
  return { 模式: '落地', 回合: 落.n, 选中, 演出: 演.演出行, 闸门: { 通过: 演.门.通过, 问题: 演.门.问题, 指纹: 演.门.指纹 }, 写入: 落.写入 };
}

/* ───────────────────────── 命令语义（交互与脚本共用同一套，避免"演示走的不是真身"） ───────────────────────── */

/**
 * 处理一行命令。返回 '退出' 表示结束会话，否则 null。
 * 会话 = { 上次推 }：交互式里它让「编号」指向你**刚看过的那一版**推演。
 *
 * 为什么要有脚本模式：把多行命令用管道喂给交互式 REPL 是不成立的——
 * 管道读到底是 EOF，readline 在**第一个**处理器还在跑（推演要 2 分钟）时就 close，
 * 后面的行全被丢掉（实测报 `readline was closed`）。要复现一局，就得逐行 await。
 */
async function 处理一行(t, 会话) {
  if (t === ':退出' || t === ':q') return '退出';
  if (t === ':状态') { 打印状态(); return null; }
  if (t === ':初始化') { 初始化(); say(绿('台账已重建')); return null; }
  if (t.startsWith(':档')) { const n = t.split(/\s+/)[1] || '幕'; say(读(P(n)) || 红('没有这份')); return null; }
  if (t.startsWith(':工具')) {
    const [, name, ...rest] = t.split(/\s+/);
    const t2 = tools[name];
    if (!t2) say(红(`没有工具 ${name}（现有：${Object.keys(tools).join('、')}）`));
    else {
      const arg = rest.join(' ');
      say(JSON.stringify(await t2.run(arg ? JSON.parse(arg) : {}), null, 2));
    }
    return null;
  }
  if (/^\d+$/.test(t) && 会话.上次推) {
    const 选中 = (会话.上次推.推演?.选项 || []).find((o) => String(o.编号) === t);
    if (!选中) { say(红(`没有编号 ${t}（上一版推演的编号：${(会话.上次推.推演?.选项 || []).map((o) => o.编号).join('、') || '无'}）`)); return null; }
    const 演 = await 演出(会话.上次推.操作文本, 选中, 会话.上次推);
    const 落 = 落地(会话.上次推, 会话.上次推.操作文本, 选中, 演, 会话.上次推);
    打印落地(演, 落, 会话.上次推.主);
    会话.上次推 = null;
    return null;
  }
  let 打回理由 = '';
  if (t.startsWith('打回')) 打回理由 = t.replace(/^打回\s*/, '') || '（未写理由）';
  if (打回理由 && !会话.上次推) { say(红('还没有可打回的推演——先输入一条操作声明')); return null; }
  const 推 = await 推演(打回理由 ? 会话.上次推.操作文本 : t, 打回理由);
  打印推演(推);
  if (打回理由) {
    const 局x = 读JSON(局档, { 打回: 0 }); 局x.打回 = (局x.打回 || 0) + 1;
    追加(P('废案'), [`## 第 ${(局x.回合 || 0) + 1} 回合 · 打回`, '', `理由：${打回理由}`, '', ...(会话.上次推?.推演?.选项 || []).map((o) => `- ${o.编号}. ${o.做法}（${o.后果}）`), ''].join('\n'));
    writeFileSync(局档, JSON.stringify(局x, null, 2), 'utf8');
    say(黄('已打回，进废案.md（角色永远看不到）'));
  }
  会话.上次推 = 推;
  return null;
}

const 报错 = (e) => {
  say(红(`✗ ${e.message}`));
  if (端点故障.test(String(e.message))) say(黄('这看起来是端点故障（AutoDL 实例重建会换域名与 Key，见 autodl-接入信息.md §五），不是本局的问题'));
};

async function 交互() {
  const 局0 = 确保台账();
  say('');
  say(粗(`跑道 · ${局0.本局} · 第 ${局0.回合} 回合`));
  say(灰('输入任意文本 = 你的操作声明（角色意图），KP 推演出选项，你裁定。'));
  say(灰('命令：:状态 ｜ :档 幕 ｜ :工具 char {"name":"祥子"} ｜ :初始化 ｜ :退出'));
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 青('跑道> ') });
  const 会话 = { 上次推: null };
  /* 管道输入会读到底就 close：close 之后再 rl.prompt() 会抛 readline was closed。
   * 交互式终端下不会走到这一步，但被重定向时要能优雅收场（脚本模式见 --脚本）。 */
  let 关了 = false;
  rl.on('close', () => { 关了 = true; });
  rl.prompt();
  for await (const line of rl) {
    const t = line.trim();
    if (!t) { if (!关了) rl.prompt(); continue; }
    let stop = null;
    try { stop = await 处理一行(t, 会话); } catch (e) { 报错(e); }
    if (stop === '退出') break;
    if (!关了) rl.prompt();
  }
  if (!关了) rl.close();
  say(灰('收工。台账在 跑道/台账/'));
}

/**
 * 脚本模式：逐行 await，可复现。
 * 用法：node 跑道/跑道.mjs --脚本 跑道/_演示脚本.txt
 * 空行与 # 开头的行忽略；其余行与交互式里敲进去的完全同义。
 */
async function 脚本(文件) {
  const 局0 = 确保台账();
  const 路径 = resolve(WS, String(文件));
  if (!existsSync(路径)) throw new Error(`没有脚本文件：${路径}`);
  const 行 = readFileSync(路径, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  say('');
  say(粗(`跑道 · ${局0.本局} · 第 ${局0.回合} 回合｜脚本模式`));
  say(灰(`${路径.replace(WS + '\\', '')}（${行.length} 行命令）`));
  const 会话 = { 上次推: null };
  for (const t of 行) {
    say(青(`\n跑道> ${t}`));
    try { if (await 处理一行(t, 会话) === '退出') break; } catch (e) { 报错(e); }
  }
  say(灰('\n收工。台账在 跑道/台账/'));
}

(async () => {
  try {
    if (argv.includes('--探端点')) { const r = await 探端点(); if (JSON_OUT) say(JSON.stringify(r, null, 2)); return; }
    if (argv.includes('--初始化')) { const r = 初始化(); return say(JSON_OUT ? JSON.stringify(r) : 绿(`台账已重建：${r.文件.join('、')}`)); }
    if (argv.includes('--状态')) return void 打印状态();
    const 档 = flag('档');
    if (档) return void say(读(P(String(档))) || 红('没有这份'));
    const 工具名 = flag('工具');
    if (工具名) {
      const i = argv.indexOf('--工具'); const arg = argv[i + 2];
      const out = await tools[工具名].run(arg ? JSON.parse(arg) : {});
      return void say(JSON.stringify(out, null, 2));
    }
    if (argv.includes('--装配')) {
      const 台 = await 装配(String(flag('act') || ''));
      return void say(JSON_OUT ? JSON.stringify({ 取材: 台.取材, 字数: 台.工作台.length }) : `${台.取材.join(' ｜ ')}\n工作台 ${台.工作台.length} 字\n\n${台.工作台}`);
    }
    const 脚本档 = flag('脚本');
    if (脚本档) return void await 脚本(脚本档 === true ? '跑道/_演示脚本.txt' : 脚本档);
    if (flag('act') || flag('pick') || flag('reject')) {
      const out = await 单步();
      if (JSON_OUT) say(JSON.stringify(out, null, 2));
      return;
    }
    await 交互();
  } catch (e) {
    console.error(红(`✗ ${e.message}`));
    if (端点故障.test(String(e.message))) say(黄('端点故障：AutoDL 实例重建会换域名与 Key（autodl-接入信息.md §五），不是本局的问题'));
    process.exit(1);
  }
})();
