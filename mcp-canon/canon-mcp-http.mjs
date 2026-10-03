#!/usr/bin/env node
/**
 * canon-mcp-http.mjs —— 《BanG Dream! Our Notes》资料库 MCP 服务器（**streamable-http**，零依赖）
 *
 * 和 canon-mcp-server.mjs（stdio）是**同一份协议层**（canon-mcp-core.mjs）的另一条传输：
 * 客户端按 URL 连，不用 spawn 进程 —— 形态与 MYGO_MCP（http://127.0.0.1:8848/mcp）一致。
 *
 * 端点（默认 http://127.0.0.1:8787/mcp，只监听本机回环）：
 *   POST   /mcp               JSON-RPC 请求  → application/json（或在 Accept 只认 SSE 时回 text/event-stream）
 *   GET    /mcp   405         本服务不开独立 SSE 流（MCP 规范允许，客户端按规范接受 405）
 *   DELETE /mcp   405         无会话状态，不支持终止会话
 *   GET    /health            存活探针（不需要 token）：服务名/版本/工具数
 *   GET    /tools             工具清单（方便 curl / PowerShell 自查，非 MCP 协议部分）
 *   POST   /call              {"name":"char","arguments":{"name":"初华"}} 直接调一个工具（同上，方便自查）
 *
 * 传输层要点（对齐 MCP Streamable HTTP 规范 + 官方 SDK 客户端的行为）：
 *   - 请求 → 200 + application/json；通知（无 id）→ 202 空体
 *   - **无会话**：不返回 mcp-session-id，客户端因此也不会发 DELETE（规范允许，最省事也最稳）
 *   - 无状态可并发：每个请求独立处理，多个客户端/多标签页可同时连
 *
 * 环境变量：CANON_HTTP_HOST（默认 127.0.0.1）、CANON_HTTP_PORT（默认 8787）、
 *           CANON_HTTP_PATH（默认 /mcp）、CANON_HTTP_TOKEN（设了就要求 Authorization: Bearer <token>）。
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { safeHandleMessage, SERVER_INFO, SUPPORTED_PROTOCOL_VERSIONS, TOOL_NAMES } from './canon-mcp-core.mjs';

const MAX_BODY = 4 * 1024 * 1024; // 4MB：doc 全文（≤6 万字）也够，防止有人拿本机端口灌爆内存
const STARTED_AT = Date.now();

/* 调用日志：时间戳 + 方法/工具 + 参数（看窗口就能知道谁调了哪个工具） */
const ts = () => { const d = new Date(); const p = (n, l = 2) => String(n).padStart(l, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`; };
const LOG = (...a) => console.log(`[${ts()}]`, ...a);

const json = (res, status, body, extra = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(text);
};

const cors = (res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, accept, mcp-session-id, mcp-protocol-version, last-event-id');
  res.setHeader('access-control-expose-headers', 'mcp-session-id');
};

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

/** 客户端只认 SSE（不含 application/json）时，按规范用 SSE 帧回一条消息再收尾 */
const sendSseSingle = (res, payload) => {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.end(body);
};

function wantsSseOnly(req) {
  const accept = String(req.headers.accept || '');
  return accept.includes('text/event-stream') && !accept.includes('application/json') && !accept.includes('*/*');
}

export function startHttpServer({
  host = process.env.CANON_HTTP_HOST || '127.0.0.1',
  port = Number(process.env.CANON_HTTP_PORT || 8787),
  path = process.env.CANON_HTTP_PATH || '/mcp',
  token = process.env.CANON_HTTP_TOKEN || '',
  log = (...a) => console.error('[canon-http]', ...a),
} = {}) {
  const authorized = (req) => {
    if (!token) return true;
    const h = String(req.headers.authorization || '');
    return h === `Bearer ${token}` || h === token;
  };

  const endpoint = path.replace(/\/+$/, '') || '/';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    cors(res);

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // —— 存活探针：不要求 token，也不吐任何语料 ——
    if (pathname === '/health') {
      json(res, 200, {
        ok: true,
        transport: 'streamable-http',
        server: SERVER_INFO,
        endpoint: `${path}`,
        tools: TOOL_NAMES.length,
        protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
        authRequired: !!token,
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      });
      return;
    }

    // —— 非 MCP 的顺手自查接口（便于 curl / PowerShell，不参与协议协商）——
    if (pathname === '/tools') {
      if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return; }
      const { listTools } = await import('./canon-mcp-core.mjs');
      json(res, 200, { count: TOOL_NAMES.length, tools: listTools() });
      return;
    }
    if (pathname === '/call' && req.method === 'POST') {
      if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return; }
      let args;
      try { args = JSON.parse(await readBody(req) || '{}'); } catch { json(res, 400, { error: 'bad json' }); return; }
      LOG('tools/call', args.name || '', JSON.stringify(args.arguments || {}));
      const out = await safeHandleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: args.name, arguments: args.arguments || {} } });
      if (out?.result?.isError) { json(res, 400, { error: out.result.content[0].text }); return; }
      json(res, 200, { name: args.name, text: out?.result?.content?.[0]?.text ?? '' });
      return;
    }

    if (pathname !== endpoint) { json(res, 404, { error: `not found: ${pathname}（MCP 端点是 ${endpoint}）` }); return; }

    // 规范：不想开独立 SSE 流就回 405，客户端（官方 SDK）把 405 当正常情况
    if (req.method === 'GET' || req.method === 'DELETE') {
      res.writeHead(405, { allow: 'POST, OPTIONS', 'content-type': 'text/plain; charset=utf-8' });
      res.end('本服务只支持 POST（无独立 SSE 流 / 无会话状态）');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST, OPTIONS', 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    if (!authorized(req)) { json(res, 401, { error: 'unauthorized：请带 Authorization: Bearer <CANON_HTTP_TOKEN>' }); return; }

    let raw;
    try { raw = await readBody(req); }
    catch (e) { json(res, e.status || 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: String(e.message) } }); return; }

    let parsed;
    try { parsed = JSON.parse(raw === '' ? '{}' : raw); }
    catch { json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }

    const batch = Array.isArray(parsed);
    const messages = batch ? parsed : [parsed];
    const responses = [];
    for (const m of messages) {
      if (m?.method === 'tools/call') {
        const a = m.params?.arguments || {};
        LOG('tools/call', m.params?.name || '', JSON.stringify(a));
      } else if (m?.method) {
        LOG(m.method);
      }
      const out = await safeHandleMessage(m);
      if (out) responses.push(out);
      if (!batch && !out) { res.writeHead(202, { 'content-length': 0 }); res.end(); return; } // 通知：202 空体
    }
    if (responses.length === 0) { res.writeHead(202, { 'content-length': 0 }); res.end(); return; }

    const payload = batch ? responses : responses[0];
    if (wantsSseOnly(req)) sendSseSingle(res, payload);
    else json(res, 200, payload);
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    log('clientError:', err.message);
  });
  server.keepAliveTimeout = 120000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        server,
        host,
        port: addr.port,
        url: `http://${host}:${addr.port}${endpoint}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// 直接运行（node mcp-canon/canon-mcp-http.mjs）才起服务；被 import 时只导出（供 _test-http.mjs 用）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const info = await startHttpServer();
  console.log(`canon MCP（streamable-http）已就绪：${info.url}`);
  console.log(`  存活探针：http://${info.host}:${info.port}/health   工具清单：http://${info.host}:${info.port}/tools`);
  console.log(`  ${SERVER_INFO.name} v${SERVER_INFO.version} · ${TOOL_NAMES.length} 个工具 · Ctrl+C 停止`);
  const bye = () => {
    console.log('\ncanon MCP 已停止');
    // 只关服务器，**不调 process.exit()**：Windows 上在句柄关闭途中强退会触发
    // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`（本仓库已踩过）。
    // server.close() 后事件循环自然排空，进程自己干净退出。
    info.close();
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
