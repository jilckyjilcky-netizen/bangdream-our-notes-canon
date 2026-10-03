#!/usr/bin/env node
/** _test-client.mjs —— MCP stdio 客户端冒烟测试（spawn 服务器 + 握手 + 工具调用） */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(HERE, 'canon-mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });

const pending = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const call = (method, params, id = Math.floor(Math.random() * 1e6)) =>
  new Promise((res, rej) => { pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('超时: ' + method)); } }, 180000); });

(async () => {
  const t0 = Date.now();
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  console.log('✓ initialize:', JSON.stringify(init.result.serverInfo));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await call('tools/list');
  console.log('✓ tools/list:', tools.result.tools.map(t => t.name).join(', '));

  const show = (label, r) => {
    const txt = r.result.content[0].text;
    const o = JSON.parse(txt);
    console.log(`\n━━━ ${label}（${((Date.now() - t0) / 1000).toFixed(1)}s）━━━`);
    console.log(Array.isArray(o) ? o.slice(0, 3) : o);
  };

  show('语义检索: 害怕失去乐队的人', await call('tools/call', { name: 'search', arguments: { q: '害怕失去乐队的人', top_k: 3 } }));
  show('语义检索: 会撒娇的网络主播', await call('tools/call', { name: 'search', arguments: { q: '会撒娇的网络主播', top_k: 3 } }));
  show('词汇检索: 抹茶', await call('tools/call', { name: 'search', arguments: { q: '抹茶', top_k: 3 } }));
  show('search type=台词', await call('tools/call', { name: 'search', arguments: { q: '一起前进', top_k: 3, type: '台词' } }));
  show('kb_who 单句', await call('tools/call', { name: 'who', arguments: { text: '……嗯。歌词，写了一点点……' } }));
  show('kb_who 多句（数组）', await call('tools/call', { name: 'who', arguments: { text: ['小祥……你回来了。', '我、我只是想和你在一起而已！', '这种事，为什么非要问我？'] } }));
  show('kb_quote 情感: 想和别人一起前进', await call('tools/call', { name: 'quote', arguments: { q: '想和别人一起前进', top_k: 3 } }));
  show('kb_quote by=爽世', await call('tools/call', { name: 'quote', arguments: { by: '爽世', top_k: 3 } }));
  show('char', await call('tools/call', { name: 'char', arguments: { name: '初华' } }));
  show('kb_rel', await call('tools/call', { name: 'rel', arguments: { a: '灯', b: '祥子' } }));
  show('kb_speech 疑问率排名', await call('tools/call', { name: 'speech', arguments: { metric: '疑问率', top_k: 5 } }));
  show('kb_state', await call('tools/call', { name: 'state', arguments: { name: '初华' } }));
  show('kb_world 抹茶', await call('tools/call', { name: 'world', arguments: { q: '抹茶', top_k: 3 } }));
  show('kb_sample 灯', await call('tools/call', { name: 'sample', arguments: { name: '灯', n: 3 } }));

  child.kill();
  process.exit(0);
})().catch(e => { console.error('TEST FAIL:', e); child.kill(); process.exit(1); });