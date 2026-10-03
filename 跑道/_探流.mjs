#!/usr/bin/env node
/**
 * _探流.mjs —— 网关诊断：非流式 vs 流式
 *
 * 背景：跑道.mjs 用 stream:false 打这个网关会 `fetch failed`，而 /v1/models 秒通。
 * 而队列（订单队列/queue.mjs）走的是 SSE 流式——所以先分清到底是
 *   (a) 非流式长请求被反向代理掐断，还是
 *   (b) 这个网关/TLS 根本不通。
 *
 * 用法：node 跑道/_探流.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(HERE, '..');
const md = readFileSync(join(WS, 'autodl-接入信息.md'), 'utf8');
const BASE = (md.match(/https:\/\/[^\s`|)]+\/v1/) || [])[0];
const KEY = (md.match(/sk-[A-Za-z0-9]{16,}/) || [])[0];
const MODEL = 'qwen3.8:27b';
console.log(`端点 ${BASE}\n模型 ${MODEL}\n`);

const 说错 = (e) => {
  const c = e.cause || {};
  console.log(`  ✗ ${e.name}: ${e.message}`);
  if (c.code || c.message) console.log(`    cause: ${c.code || ''} ${c.message || ''}`);
  if (c.errno) console.log(`    errno: ${c.errno}｜syscall: ${c.syscall}`);
};

/* ── A. 非流式（跑道.mjs 现在的做法） ── */
async function 非流式() {
  console.log('A) stream:false …');
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: '只回一个 JSON：{"ok":true}' }], stream: false, response_format: { type: 'json_object' } }),
      signal: AbortSignal.timeout(180000),
    });
    const t = await r.text();
    console.log(`  ✓ HTTP ${r.status}｜${((Date.now() - t0) / 1000).toFixed(1)}s｜${t.slice(0, 200)}`);
    return true;
  } catch (e) { 说错(e); return false; }
}

/* ── B. 流式（队列的做法：SSE 边收边拿） ── */
async function 流式() {
  console.log('\nB) stream:true（SSE）…');
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: '只回一个 JSON：{"ok":true,"你是谁":"一句话"}' }], stream: true }),
      signal: AbortSignal.timeout(180000),
    });
    console.log(`  HTTP ${r.status}｜首字节 ${((Date.now() - t0) / 1000).toFixed(1)}s｜content-type ${r.headers.get('content-type')}`);
    if (!r.ok) { console.log('  ✗ ' + (await r.text()).slice(0, 200)); return false; }
    let buf = '', 正文 = '', 思考 = '', n = 0;
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString('utf8');
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const p = s.slice(5).trim();
        if (p === '[DONE]') continue;
        try {
          const d = JSON.parse(p).choices?.[0]?.delta || {};
          if (d.reasoning_content) 思考 += d.reasoning_content;
          if (d.content) { 正文 += d.content; if (++n <= 3) console.log(`  ← ${((Date.now() - t0) / 1000).toFixed(1)}s ${JSON.stringify(d.content.slice(0, 60))}`); }
        } catch {}
      }
    }
    console.log(`  ✓ 完成 ${((Date.now() - t0) / 1000).toFixed(1)}s｜正文 ${正文.length} 字｜思考流 ${思考.length} 字`);
    console.log(`  正文：${正文.slice(0, 200)}`);
    if (思考) console.log(`  思考流前 120 字：${思考.slice(0, 120)}`);
    return true;
  } catch (e) { 说错(e); return false; }
}

const a = await 非流式();
const b = await 流式();
console.log(`\n结论：非流式 ${a ? '通' : '不通'}｜流式 ${b ? '通' : '不通'}${!a && b ? ' → 必须改走 SSE（跑道.mjs 的 stream:false 是 bug）' : ''}`);
