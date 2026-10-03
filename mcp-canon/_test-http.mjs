#!/usr/bin/env node
/**
 * _test-http.mjs —— streamable-http 传输冒烟测试（**进程内**起服务器 + fetch，不 spawn 子进程）
 *
 * 为什么进程内：本工作区沙箱里 node spawn 带管道 stdio 的子进程会 EPERM（已知边界），
 * 所以这里直接 import startHttpServer 在测试进程里监听一个**随机端口**，再用 fetch 打真实 HTTP。
 *
 * 覆盖：健康探针 / initialize 协商 / 通知 202 / tools/list / tools/call（含报错路径）/
 *       解析错误 / 未知方法 / 只认 SSE 的客户端 / GET 405 / 404 / token 鉴权。
 * 用随机端口：node mcp-canon/_test-http.mjs
 */
import { startHttpServer } from './canon-mcp-http.mjs';
import { SERVER_INFO, TOOL_NAMES } from './canon-mcp-core.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`); }
};

const rpc = (url, body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const info = await startHttpServer({ port: 0, log: () => {} }); // port 0 = 内核分配空闲端口
const base = `http://${info.host}:${info.port}`;
const endpoint = info.url;
console.log(`\n━━━ streamable-http 冒烟（${endpoint}）━━━`);

try {
  // 1. 健康探针
  const h = await fetch(`${base}/health`);
  const hj = await h.json();
  ok(h.status === 200 && hj.ok === true && hj.tools === TOOL_NAMES.length, `/health → 200（tools:${hj.tools}）`, hj);

  // 2. initialize：版本协商 + 无会话头
  const init = await rpc(endpoint, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  const initBody = await init.json();
  ok(init.status === 200, 'initialize → 200');
  ok(init.headers.get('content-type')?.includes('application/json'), 'initialize content-type=application/json', init.headers.get('content-type'));
  ok(initBody.result?.serverInfo?.name === SERVER_INFO.name, `initialize serverInfo=${initBody.result?.serverInfo?.name}`, initBody.result?.serverInfo);
  ok(initBody.result?.protocolVersion === '2025-11-25', '协议版本按客户端协商（2025-11-25）', initBody.result?.protocolVersion);
  ok(init.headers.get('mcp-session-id') === null, '无状态：不返回 mcp-session-id');

  const init2 = await (await rpc(endpoint, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).json();
  ok(init2.result?.protocolVersion === '2025-06-18', '未知协议版本回落到 2025-06-18', init2.result?.protocolVersion);

  // 3. 通知 → 202 空体
  const note = await rpc(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' });
  ok(note.status === 202, 'notifications/initialized → 202', note.status);

  // 4. tools/list
  const tl = await (await rpc(endpoint, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).json();
  ok(tl.result?.tools?.length === TOOL_NAMES.length, `tools/list → ${tl.result?.tools?.length} 个工具`);
  ok(tl.result.tools.every(t => t.name && t.inputSchema), '每个工具都有 name + inputSchema');

  // 5. tools/call：真实调用（char 走本地 kb.json，不需要 Ollama）
  const call = await (await rpc(endpoint, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'char', arguments: { name: '初华' } } })).json();
  ok(call.result && !call.result.isError, 'tools/call char 初华 → 无错误', call.result?.isError);
  const charText = call.result?.content?.[0]?.text || '';
  let charObj = null; try { charObj = JSON.parse(charText); } catch {}
  ok(!!charObj && !!(charObj.name || charObj.id || charObj.profile), 'tools/call 返回可解析的角色档案 JSON', charText.slice(0, 120));

  // 5b. 旧工具名兼容（kb_ 前缀）
  const legacy = await (await rpc(endpoint, { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'kb_char', arguments: { name: '灯' } } })).json();
  ok(legacy.result && !legacy.result.isError, '旧名 kb_char 仍可用', legacy.result?.isError);

  // 6. 报错路径：未知工具 → isError（HTTP 仍是 200，错误在 result 里，符合规范）
  const bad = await rpc(endpoint, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  const badBody = await bad.json();
  ok(bad.status === 200 && badBody.result?.isError === true, '未知工具 → result.isError=true', badBody.result?.content?.[0]?.text);

  // 7. 解析错误 → -32700；未知方法 → -32601
  const pe = await rpc(endpoint, '{ 这不是 json');
  const peBody = await pe.json();
  ok(pe.status === 400 && peBody.error?.code === -32700, '坏 JSON → 400 / -32700', peBody);
  const um = await (await rpc(endpoint, { jsonrpc: '2.0', id: 6, method: 'resources/list' })).json();
  ok(um.error?.code === -32601, '未知方法 → -32601', um);
  const ping = await (await rpc(endpoint, { jsonrpc: '2.0', id: 7, method: 'ping' })).json();
  ok(ping.result && Object.keys(ping.result).length === 0, 'ping → {}', ping);

  // 8. 只认 SSE 的客户端 → text/event-stream 单帧
  const sse = await rpc(endpoint, { jsonrpc: '2.0', id: 8, method: 'tools/list' }, { accept: 'text/event-stream' });
  const sseText = await sse.text();
  ok(sse.headers.get('content-type')?.includes('text/event-stream') && sseText.startsWith('event: message\ndata: '), 'Accept 只认 SSE → 单帧 text/event-stream', sseText.slice(0, 60));
  ok(JSON.parse(sseText.split('data: ')[1].split('\n')[0]).result.tools.length === TOOL_NAMES.length, 'SSE 帧内容与 JSON 路径一致');

  // 9. GET / DELETE 405；未知路径 404
  const g = await fetch(endpoint);
  ok(g.status === 405, 'GET /mcp → 405（不开独立 SSE 流，规范允许）', g.status);
  const d = await fetch(endpoint, { method: 'DELETE' });
  ok(d.status === 405, 'DELETE /mcp → 405（无会话）', d.status);
  ok((await fetch(`${base}/nope`)).status === 404, '未知路径 → 404');
  const opt = await fetch(endpoint, { method: 'OPTIONS' });
  ok(opt.status === 204 && opt.headers.get('access-control-allow-origin') === '*', 'OPTIONS → 204 + CORS');

  // 10. 顺手自查接口
  const t = await (await fetch(`${base}/tools`)).json();
  ok(t.count === TOOL_NAMES.length, `/tools → ${t.count} 个工具`);
  const c = await (await fetch(`${base}/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'speech', arguments: { metric: '疑问率', top_k: 3 } }) })).json();
  ok(typeof c.text === 'string' && c.text.length > 0, '/call speech 疑问率 → 有内容', c.text?.slice(0, 80));

  // 11. token 鉴权（另起一个带 token 的实例）
  const sec = await startHttpServer({ port: 0, token: 's3cret', log: () => {} });
  const secUrl = sec.url;
  ok((await rpc(secUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status === 401, '带 token 时无凭据 → 401');
  ok((await fetch(`http://${sec.host}:${sec.port}/health`)).status === 200, '带 token 时 /health 仍免鉴权（探针）');
  const authed = await rpc(secUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer s3cret' });
  ok(authed.status === 200 && (await authed.json()).result.tools.length === TOOL_NAMES.length, '带 Bearer token → 200 + 工具清单');
  await sec.close();
} finally {
  await info.close();
}

console.log(`\n━━━ 结果：${pass} 通过 / ${fail} 失败 ━━━\n`);
// 用 exitCode 而不是 process.exit()：强退会在句柄关闭途中触发 libuv 断言（Windows 已知问题）
process.exitCode = fail ? 1 : 0;
