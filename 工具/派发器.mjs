#!/usr/bin/env node
/**
 * 派发器.mjs —— 极简云模型串行派发器（落地 交接计划 §附 规格表）
 *
 * 形状直接抄本机唯一实测可用的云通道 跑道/跑道.mjs：网关() 凭据解析 + 问模型() SSE 流式 + 端点故障判据。
 * 不重建整条队列：只有「读订单 jsonl → 一单一单跑 → 落盘」这一件事。
 *
 * 用法：
 *   node 工具/派发器.mjs --in 归档/_派发/扮演回测/订单.jsonl --out 归档/_派发/扮演回测/ [--dry] [--only 单号] [--limit N]
 *   node 工具/派发器.mjs --selftest                离线自测（本地 stub，不联网、不需要凭据）
 *
 * 控制：批次目录下建 STOP 文件 → 跑完当前单收工。
 */
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync, renameSync, readdirSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { createServer } from 'node:http';
import { WS } from './_root.mjs';

/* max_tokens 由网关强制覆盖为 15000（客户端传什么都无效），所以这里不发它；
 * 思考关不掉且全程计入那 15000 ⇒ 一单按 5~10 分钟估。超时给足 15 分钟：
 * 上一轮 S02 就是被短超时打死的（交接.md §六 / §八.3）。 */
const 默认超时ms = 15 * 60 * 1000;
const 任务级最多重试 = 2;   // 每单最多 1 + 2 次尝试
const 连续infra收工 = 3;
const 默认冷却ms = 30 * 1000;

/* ───────────────────────── 凭据（只存一处：读法与 跑道.mjs 的 网关() 一致） ───────────────────────── */
export function 网关(root = WS) {
  let base = process.env.AUTODL_BASE_URL, key = process.env.AUTODL_API_KEY, model = process.env.AUTODL_MODEL;
  if (!base || !key) {
    const p = join(root, 'autodl-接入信息.md');
    if (!existsSync(p)) {
      throw new Error(
        `缺凭据：既没有环境变量 AUTODL_BASE_URL / AUTODL_API_KEY，也找不到 ${p}\n` +
        '  → 需向负责人取**新的** AutoDL 域名 + Key（实例重建后两者都会变），在工作区根目录重建 autodl-接入信息.md，\n' +
        '    文件里要能匹配出 https://.../v1 与 sk-xxxx。派发器与 跑道 共用这一处读法，不要另开第二处凭据。');
    }
    const md = readFileSync(p, 'utf8');
    base = base || (md.match(/https:\/\/[^\s`|)]+\/v1/) || [])[0];
    key = key || (md.match(/sk-[A-Za-z0-9]{16,}/) || [])[0];
  }
  if (!base || !key) throw new Error('凭据解析失败：autodl-接入信息.md 里没找到 Base URL 或 API Key');
  return { base: base.replace(/\/$/, ''), key, model: model || 'qwen3.8:27b' };
}

/* 基础设施故障 ≠ 任务失败（交接.md §八.6：那晚 47 单被 404 连试 3 次全判死，其实一单都没坏）。
 * 判据：所有单都以同样方式失败 ⇒ 问题在端点，不在单。 */
const 端点故障 = /^HTTP (404|429|500|502|503|504)\b|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|UND_ERR/i;
const isInfra = (e) => e?.name === 'TypeError' || 端点故障.test(e?.message || String(e));

const nowISO = () => new Date().toISOString();

/* ───────────────────────── 一单：SSE 流式问模型（抄 跑道.mjs 的 问模型()） ─────────────────────────
 * 为什么流式而不是 stream:false：本网关对**长**非流式请求会 fetch failed（/v1/models 却秒通）。 */
export async function 问模型(gw, prompt, { 温度 = 0.85, 超时ms = 默认超时ms, onProgress = null } = {}) {
  const t0 = Date.now();
  /* 零继承：每单只有一条 user 消息，不带上文 ⇒ prompt 自包含 ⇒ 重投幂等 */
  const 体 = JSON.stringify({ model: gw.model, messages: [{ role: 'user', content: prompt }], stream: true, temperature: 温度 });
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), 超时ms);
  let 正文 = '', 思考 = '', finish = null, usage = null;
  const 计时 = onProgress ? setInterval(() => onProgress((Date.now() - t0) / 1000, 思考.length, 正文.length), 10000) : null;
  try {
    const r = await fetch(`${gw.base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.key}`, 'Content-Type': 'application/json' },
      body: 体, signal: ac.signal,
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`HTTP ${r.status}: ${t.slice(0, 300)}`); }
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
        /* 本网关思考流的增量键是 reasoning（不是 reasoning_content） */
        const 思 = d.reasoning ?? d.reasoning_content ?? d.thinking ?? '';
        if (思) 思考 += 思;
        if (d.content) 正文 += d.content;
        if (ch.finish_reason) finish = ch.finish_reason;
        if (j.usage) usage = j.usage;
      }
    }
  } finally {
    clearTimeout(killer);
    if (计时) clearInterval(计时);
  }
  const 用时 = +((Date.now() - t0) / 1000).toFixed(1);
  if (!正文.trim()) throw new Error(`正文为空（思考 ${思考.length} 字，finish=${finish}）——多半是被截断或排队超时`);
  return { 正文, 思考, 用时, usage, finish };
}

/* ───────────────────────── 订单 / 状态 / 锁 ───────────────────────── */
export function loadOrders(file) {
  if (!existsSync(file)) throw new Error(`没有订单文件：${file}`);
  const out = [], seen = new Set();
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((l, i) => {
    const t = l.trim();
    if (!t || t.startsWith('//')) return;
    let j;
    try { j = JSON.parse(t); } catch { console.log(`  ⚠ 第 ${i + 1} 行不是合法 JSON，跳过`); return; }
    if (!j.id || !j.prompt) { console.log(`  ⚠ 第 ${i + 1} 行缺 id/prompt，跳过`); return; }
    if (seen.has(j.id)) { console.log(`  ⚠ 重复 id「${j.id}」，只取第一次`); return; }
    seen.add(j.id);
    out.push({ 温度: 0.85, ...j, seq: i });
  });
  return out;
}

const 状态文件 = (outDir) => join(outDir, 'state.json');
function loadState(outDir) { try { return JSON.parse(readFileSync(状态文件(outDir), 'utf8')); } catch { return {}; } }
function saveState(outDir, st) {
  const tmp = 状态文件(outDir) + '.tmp';
  writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  renameSync(tmp, 状态文件(outDir));
}

const 单目录 = (outDir, id) => join(outDir, 'out', id);
const 有结果 = (outDir, id) => {
  try { return readFileSync(join(单目录(outDir, id), 'result.md'), 'utf8').trim().length > 0; } catch { return false; }
};
const 在途标记 = (outDir, id) => {
  try { return JSON.parse(readFileSync(join(单目录(outDir, id), 'meta.json'), 'utf8')).status === 'in-flight'; } catch { return false; }
};

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function acquireLock(outDir) {
  const LOCK = join(outDir, 'run.lock');
  if (existsSync(LOCK)) {
    let info = null;
    try { info = JSON.parse(readFileSync(LOCK, 'utf8')); } catch {}
    if (info?.pid && alive(info.pid)) {
      throw new Error(`已有派发器在跑：pid ${info.pid}（${info.host || '?'}，起于 ${info.startedAt || '?'}）——串行同一时刻只允许一个调度器。`);
    }
    if (info?.pid) console.log(`· 发现孤儿锁（pid ${info.pid} 已不在）→ 接管`);
  }
  const 释放 = () => { try { rmSync(LOCK, { force: true }); } catch {} process.off('exit', 释放); };
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: nowISO() }, null, 2), 'utf8');
  process.on('exit', 释放);
  return 释放;
}

/* ───────────────────────── 跑一单 ───────────────────────── */
async function 跑一单(outDir, o, gw, { 尝试, 超时ms, quiet }) {
  const dir = 单目录(outDir, o.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ model: gw.model, messages: [{ role: 'user', content: o.prompt }], stream: true, temperature: o.温度 }, null, 2), 'utf8');
  /* 先落 in-flight 标记：进程被硬杀时下次启动看得见「这单在途」，据此重投（prompt 自包含 ⇒ 幂等） */
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id: o.id, status: 'in-flight', attempt: 尝试, startedAt: nowISO(), pid: process.pid }, null, 2), 'utf8');
  const r = await 问模型(gw, o.prompt, {
    温度: o.温度, 超时ms,
    onProgress: quiet ? null : (s, 思, 文) => process.stderr.write(`  · ${o.id} 生成中 ${s.toFixed(0)}s｜思考 ${思} 字｜正文 ${文} 字\n`),
  });
  writeFileSync(join(dir, 'result.md'), r.正文.trimEnd() + '\n', 'utf8');
  /* 思考流落盘但绝不进任何上下文（打分器只读 result.md） */
  writeFileSync(join(dir, 'thinking.md'), r.思考.trimEnd() + '\n', 'utf8');
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    id: o.id, status: 'done', model: gw.model, attempt: 尝试, seconds: r.用时,
    chars: { content: r.正文.length, reasoning: r.思考.length },
    finish_reason: r.finish, usage: r.usage || null, finishedAt: nowISO(),
  }, null, 2), 'utf8');
  return r;
}

/* ───────────────────────── 主循环（零并发：一个 for + await，不用任何并发原语） ───────────────────────── */
export async function runBatch({ ordersFile, outDir, gw, dry = false, only = null, limit = 0, quiet = false, 超时ms = 默认超时ms, 冷却ms = 默认冷却ms }) {
  const orders = loadOrders(ordersFile);
  const list = orders.filter(o => !only || o.id === only || o.id.startsWith(only) || o.char === only || o.arm === only);
  mkdirSync(outDir, { recursive: true });
  if (!dry) {
    mkdirSync(join(outDir, 'out'), { recursive: true });
    mkdirSync(join(outDir, 'log'), { recursive: true });
  }
  const log = (line) => {
    if (!dry) appendFileSync(join(outDir, 'log', 'run.log'), `[${nowISO()}] ${line}\n`, 'utf8');
    if (!quiet) console.log(line);
  };

  if (dry) {
    console.log(`派发计划（--dry，不发请求、不读凭据）｜订单 ${orders.length} 条 @ ${ordersFile}`);
    for (const o of list) {
      const 状态 = 有结果(outDir, o.id) ? '已完成(跳过)' : 在途标记(outDir, o.id) ? '在途(重投)' : '待跑';
      console.log(`  ${o.id.padEnd(14)} ${状态.padEnd(10)} prompt ${String(o.prompt.length).padStart(7)} 字  温度 ${o.温度}`);
    }
    const 待 = list.filter(o => !有结果(outDir, o.id)).length;
    console.log(`合计：${list.length} 单，其中待跑/重投 ${待} 单`);
    return { planned: list.length, pending: 待, done: 0, dead: 0, infra: 0, dry: true, stopped: null };
  }

  const 释放 = acquireLock(outDir);
  try {
    let 已完成 = 0, 死单 = 0, infra连续 = 0, 处理数 = 0;
    for (const o of list) {
      if (existsSync(join(outDir, 'STOP'))) { log('· 检测到 STOP → 收工'); return { done: 已完成, dead: 死单, infra: infra连续, stopped: 'stop' }; }
      if (limit && 处理数 >= limit) { log(`· 达到 --limit ${limit} → 收工`); break; }
      if (有结果(outDir, o.id)) {
        const s = loadState(outDir); s[o.id] = { ...(s[o.id] || {}), status: 'done' }; saveState(outDir, s);
        continue;
      }
      处理数++;
      const 是重投 = 在途标记(outDir, o.id);
      let 尝试 = 0;
      while (true) {
        尝试++;
        { const s = loadState(outDir); s[o.id] = { ...(s[o.id] || {}), status: 'running', attempts: 尝试, startedAt: nowISO() }; saveState(outDir, s); }
        log(`▶ ${o.id} 第 ${尝试} 次尝试（prompt ${o.prompt.length} 字）${是重投 && 尝试 === 1 ? '｜meta 标在途 → 重投' : ''}`);
        try {
          const r = await 跑一单(outDir, o, gw, { 尝试, 超时ms, quiet });
          const s = loadState(outDir);
          s[o.id] = { status: 'done', attempts: 尝试, seconds: r.用时, chars: r.正文.length, reasoningChars: r.思考.length };
          saveState(outDir, s);
          已完成++; infra连续 = 0;
          const tps = r.usage?.completion_tokens ? (r.usage.completion_tokens / r.用时).toFixed(1) : '?';
          log(`  ✓ ${o.id} ${r.用时}s 正文 ${r.正文.length} 字 / 思考 ${r.思考.length} 字 ｜ ${tps} tok/s`);
          break;
        } catch (e) {
          const msg = e.name === 'AbortError' ? `超时（${(超时ms / 60000).toFixed(1)} 分钟）` : (e.message || String(e));
          if (e.name !== 'AbortError' && isInfra(e)) {
            infra连续++;
            /* infra 故障：attempts 退回（不消耗重试预算）、status 回 pending（不判死） */
            const s = loadState(outDir);
            s[o.id] = { ...(s[o.id] || {}), status: 'pending', attempts: Math.max(0, 尝试 - 1), infraFail: true, error: msg };
            saveState(outDir, s);
            log(`  ✗ 基础设施故障（连续第 ${infra连续} 次，不计入重试预算、不判死）：${msg.slice(0, 140)}`);
            if (infra连续 >= 连续infra收工) {
              log(`✗ 连续 ${infra连续} 次基础设施故障 → 判定端点故障，主动收工等人。这些单**没有被判死**；排查 ① 云实例是否在跑 ② ${gw.base}/models 是否 404。修好后重跑同一命令即可续跑。`);
              return { done: 已完成, dead: 死单, infra: infra连续, stopped: 'infra' };
            }
            /* infra 故障不是这一单的问题：换下一单试（同一单不重复消耗尝试数）。
             * 若接下来的单也以同样方式失败，就是端点挂了 —— 由上面的连续计数收工。 */
            await new Promise(r2 => setTimeout(r2, 冷却ms));
            break;
          }
          infra连续 = 0;
          if (尝试 > 任务级最多重试) {
            const s = loadState(outDir);
            s[o.id] = { status: 'dead', attempts: 尝试, error: msg, deadAt: nowISO() };
            saveState(outDir, s);
            appendFileSync(join(outDir, 'dead.jsonl'), JSON.stringify({ id: o.id, error: msg, attempts: 尝试, at: nowISO() }) + '\n', 'utf8');
            死单++;
            log(`  ✗ 任务级失败，第 ${尝试} 次仍失败 → 记 dead.jsonl，继续下一单`);
            break;
          }
          log(`  ✗ 任务级失败（第 ${尝试}/${任务级最多重试 + 1} 次）：${msg.slice(0, 160)} → 重试`);
        }
      }
    }
    log(`收工｜完成 ${已完成} ｜ 死单 ${死单} ｜ 本批仍缺结果 ${list.filter(o => !有结果(outDir, o.id)).length} 单`);
    return { done: 已完成, dead: 死单, infra: infra连续, stopped: null };
  } finally {
    释放();
  }
}

/* ───────────────────────── CLI ───────────────────────── */
const flagOf = (argv, n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };

const main = async () => {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return void await selftest();
  const inF = flagOf(argv, 'in'), outF = flagOf(argv, 'out');
  if (!inF || !outF) {
    console.error('用法：node 工具/派发器.mjs --in <订单.jsonl> --out <归档/_派发/批次/> [--dry] [--only 单号] [--limit N]');
    console.error('     node 工具/派发器.mjs --selftest   离线自测（本地 stub，不联网、不需要凭据）');
    process.exit(1);
  }
  const opts = {
    ordersFile: resolve(WS, String(inF)), outDir: resolve(WS, String(outF)),
    dry: argv.includes('--dry'),
    only: typeof flagOf(argv, 'only') === 'string' ? String(flagOf(argv, 'only')) : null,
    limit: Number(flagOf(argv, 'limit') || 0),
    超时ms: Number(process.env.DISPATCH_TIMEOUT_MS || 默认超时ms),
  };
  if (opts.dry) { await runBatch(opts); return; }
  const gw = 网关();
  console.log(`串行派发 ｜ ${gw.model} @ ${gw.base} ｜ 零并发 ｜ SSE 流式 ｜ 超时 ${(opts.超时ms / 60000).toFixed(1)} 分钟/单`);
  const r = await runBatch({ ...opts, gw });
  process.exitCode = (r.dead || r.stopped === 'infra') ? 1 : 0;
};

/* ───────────────────────── 离线自测（本地 stub，零网络出口、零凭据） ───────────────────────── */
async function selftest() {
  const root = join(WS, '归档', '_派发', '_selftest', '派发');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const assert = [];
  const check = (name, cond, info = '') => assert.push({ name, pass: !!cond, info: String(info) });

  let inflight = 0, maxInflight = 0; const hits = [];
  const wait = (ms) => new Promise(r2 => setTimeout(r2, ms));
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    inflight++; maxInflight = Math.max(maxInflight, inflight); hits.push(body);
    let j = {}; try { j = JSON.parse(body); } catch {}
    const prompt = j.messages?.[0]?.content || '';
    try {
      if (prompt.includes('STUB404')) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found（AutoDL FAQ 页）'); return; }
      if (prompt.includes('STUBEMPTY')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning: '只有思考没有正文' }, finish_reason: 'length' }] }) + '\n\n');
        res.write('data: [DONE]\n\n'); res.end(); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const sse = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      for (const s of ['先想一句', '再想一句（reasoning 键）']) { sse({ choices: [{ delta: { reasoning: s } }] }); await wait(5); }
      for (const c of ['**灯**：……\n', '**灯**：今天的风，有点吵。\n', '**灯**：……\n']) { sse({ choices: [{ delta: { content: c } }] }); await wait(5); }
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 30 } });
      res.write('data: [DONE]\n\n'); res.end();
    } finally { inflight--; }
  });
  await new Promise((r2) => server.listen(0, '127.0.0.1', r2));
  const gw = { base: `http://127.0.0.1:${server.address().port}/v1`, key: 'sk-selftest', model: 'stub/model' };
  const mk = (dir, orders) => {
    mkdirSync(dir, { recursive: true });
    const f = join(dir, '订单.jsonl');
    writeFileSync(f, orders.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8');
    return f;
  };
  const fast = { gw, quiet: true, 超时ms: 30000, 冷却ms: 20 };
  const 全部缺结果 = (dir) => {
    const od = join(dir, 'out');
    if (!existsSync(od)) return true;
    return readdirSync(od).every((d) => !有结果(dir, d));
  };

  try {
    /* 1 · 正常跑通：SSE 解析 / 正文与思考分离 / 零并发 */
    const d1 = join(root, 'b1');
    const f1 = mk(d1, [{ id: 'A01-灯', prompt: '正常单 1' }, { id: 'B01-灯', prompt: '正常单 2' }]);
    const r1 = await runBatch({ ordersFile: f1, outDir: d1, ...fast });
    const res = readFileSync(join(d1, 'out', 'A01-灯', 'result.md'), 'utf8');
    const thi = readFileSync(join(d1, 'out', 'A01-灯', 'thinking.md'), 'utf8');
    const meta = JSON.parse(readFileSync(join(d1, 'out', 'A01-灯', 'meta.json'), 'utf8'));
    check('零并发：在途请求恒为 1', maxInflight === 1, `maxInflight=${maxInflight}`);
    check('SSE 流式解析：reasoning 增量与 content 都收到', res.includes('今天的风') && thi.includes('reasoning 键'), `正文 ${res.length} 字｜思考 ${thi.length} 字`);
    check('result.md / thinking.md 分离落盘（互不污染）', !res.includes('先想一句') && !thi.includes('**灯**'), '思考不进正文、正文不进思考');
    check('meta.json 记 用时 / usage / finish', !!meta.seconds && meta.usage?.completion_tokens === 30 && meta.finish_reason === 'stop', `用时 ${meta.seconds}s｜finish ${meta.finish_reason}`);
    check('request.json 落盘且单条 user 消息（零继承）', JSON.parse(readFileSync(join(d1, 'out', 'A01-灯', 'request.json'), 'utf8')).messages.length === 1, '');
    check('两单全部完成', r1.done === 2 && r1.dead === 0, JSON.stringify(r1));

    /* 2 · 断点续跑：已有 result.md ⇒ 跳过，不发请求 */
    const n0 = hits.length;
    const r2 = await runBatch({ ordersFile: f1, outDir: d1, ...fast });
    check('断点续跑：已完成单被跳过（零新请求）', hits.length === n0 && r2.done === 0, `新增请求 ${hits.length - n0}`);

    /* 3 · meta 标 in-flight ⇒ 重投（幂等） */
    const d3 = join(root, 'b3');
    const f3 = mk(d3, [{ id: 'A02-爱音', prompt: '正常单 3' }]);
    mkdirSync(join(d3, 'out', 'A02-爱音'), { recursive: true });
    writeFileSync(join(d3, 'out', 'A02-爱音', 'meta.json'), JSON.stringify({ id: 'A02-爱音', status: 'in-flight' }), 'utf8');
    const n1 = hits.length;
    const r3 = await runBatch({ ordersFile: f3, outDir: d3, ...fast });
    check('meta 标 in-flight ⇒ 重投并幂等', hits.length > n1 && r3.done === 1 && 有结果(d3, 'A02-爱音'), `done=${r3.done}`);

    /* 4 · 任务级失败：1 + 2 次尝试后记 dead.jsonl（不误报 infra） */
    const d4 = join(root, 'b4');
    const f4 = mk(d4, [{ id: 'A03-立希', prompt: 'STUBEMPTY 正文为空' }]);
    const r4 = await runBatch({ ordersFile: f4, outDir: d4, ...fast });
    const st4 = JSON.parse(readFileSync(join(d4, 'state.json'), 'utf8'));
    const dead4 = existsSync(join(d4, 'dead.jsonl')) ? readFileSync(join(d4, 'dead.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
    check('任务级失败重试到第 3 次尝试后记 dead.jsonl', r4.dead === 1 && dead4.length === 1 && JSON.parse(dead4[0]).id === 'A03-立希', `dead.jsonl ${dead4.length} 行`);
    check('任务级失败的尝试数 = 1 + 2 次重试', st4['A03-立希'].attempts === 3, `attempts=${st4['A03-立希'].attempts}`);
    check('任务级失败不触发 infra 收工', r4.stopped === null && r4.infra === 0, JSON.stringify(r4));

    /* 5 · 基础设施断路器：连续 3 次 404 → 收工等人、不判死、不消耗重试预算 */
    const d5 = join(root, 'b5');
    const f5 = mk(d5, ['A04-爽世', 'B04-爽世', 'C04-爽世', 'D04-爽世', 'E04-爽世'].map(id => ({ id, prompt: 'STUB404 端点挂了' })));
    const r5 = await runBatch({ ordersFile: f5, outDir: d5, ...fast });
    const st5 = JSON.parse(readFileSync(join(d5, 'state.json'), 'utf8'));
    const 状态集 = Object.values(st5).map(s => s.status);
    check('连续 3 次 infra 故障即主动收工', r5.stopped === 'infra' && r5.infra === 3, JSON.stringify(r5));
    check('infra 故障不判死（无 dead.jsonl、无 dead 状态）', !existsSync(join(d5, 'dead.jsonl')) && !状态集.includes('dead'), `状态：${[...new Set(状态集)].join(',')}`);
    check('infra 故障不消耗重试预算（attempts 全部回退为 0）', Object.values(st5).every(s => s.attempts === 0), Object.entries(st5).map(([k, v]) => `${k}:${v.attempts}`).join(' '));
    check('infra 收工后其余单仍待跑（可直接续跑）', Object.keys(st5).length === 3 && Object.values(st5).every(s => s.status === 'pending') && 全部缺结果(d5, f5), `已尝试 ${Object.keys(st5).length} 单｜5 单仍无结果`);
    const n5 = hits.length;
    const r5b = await runBatch({ ordersFile: f5, outDir: d5, ...fast });
    check('修好端点前重跑仍是 infra 收工（不积累死单）', r5b.stopped === 'infra' && hits.length > n5 && !existsSync(join(d5, 'dead.jsonl')), `新增请求 ${hits.length - n5}`);

    /* 6 · run.lock：活锁拒绝并报 pid；孤儿锁接管 */
    const d6 = join(root, 'b6');
    const f6 = mk(d6, [{ id: 'A05-乐奈', prompt: '正常单 6' }]);
    writeFileSync(join(d6, 'run.lock'), JSON.stringify({ pid: process.pid, host: 'other', startedAt: nowISO() }), 'utf8');
    let lockErr = '';
    try { await runBatch({ ordersFile: f6, outDir: d6, ...fast }); } catch (e) { lockErr = e.message; }
    check('run.lock 拒绝第二实例并报出占用 pid', new RegExp(`pid ${process.pid}\\b`).test(lockErr), lockErr.slice(0, 80));
    writeFileSync(join(d6, 'run.lock'), JSON.stringify({ pid: 999999, host: 'ghost', startedAt: nowISO() }), 'utf8');
    const r6 = await runBatch({ ordersFile: f6, outDir: d6, ...fast });
    check('孤儿锁（pid 已死）被接管', r6.done === 1 && !existsSync(join(d6, 'run.lock')), `done=${r6.done}｜锁已释放=${!existsSync(join(d6, 'run.lock'))}`);

    /* 7 · --dry：出计划、不发请求、不需要凭据 */
    const d7 = join(root, 'b7');
    const f7 = mk(d7, [{ id: 'A06-灯', prompt: '待跑单' }, { id: 'B06-灯', prompt: '待跑单' }]);
    mkdirSync(join(d7, 'out', 'A06-灯'), { recursive: true });
    writeFileSync(join(d7, 'out', 'A06-灯', 'result.md'), '**灯**：已完成的单\n', 'utf8');
    const n7 = hits.length;
    const r7 = await runBatch({ ordersFile: f7, outDir: d7, dry: true, quiet: true });
    check('--dry 出完整计划且零请求（免凭据）', hits.length === n7 && r7.planned === 2 && r7.pending === 1, `planned=${r7.planned}｜pending=${r7.pending}`);

    /* 8 · 缺凭据时的提示 */
    const 存 = { b: process.env.AUTODL_BASE_URL, k: process.env.AUTODL_API_KEY };
    delete process.env.AUTODL_BASE_URL; delete process.env.AUTODL_API_KEY;
    let 提示 = '';
    try { 网关(join(root, '不存在')); } catch (e) { 提示 = e.message; }
    if (存.b) process.env.AUTODL_BASE_URL = 存.b;
    if (存.k) process.env.AUTODL_API_KEY = 存.k;
    check('缺凭据时报清楚缺件提示（指向 autodl-接入信息.md）', /缺凭据/.test(提示) && /autodl-接入信息\.md/.test(提示), 提示.split('\n')[0]);
  } finally {
    server.close();
  }

  const fail = assert.filter(a => !a.pass);
  console.log('派发器 离线自测（本地 node:http stub ｜ 零外网、零凭据）');
  console.log('-'.repeat(72));
  for (const a of assert) console.log(`${a.pass ? '✓' : '✗'} ${a.name}${a.info ? `  ｜ ${a.info}` : ''}`);
  console.log('-'.repeat(72));
  console.log(`${assert.length - fail.length}/${assert.length} 通过${fail.length ? '  ✗ 失败：' + fail.map(f => f.name).join('；') : ''}`);
  process.exitCode = fail.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
}
