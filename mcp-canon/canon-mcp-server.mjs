#!/usr/bin/env node
/**
 * canon-mcp-server.mjs —— 《BanG Dream! Our Notes》资料库 MCP 服务器（stdio，零依赖）
 *
 * 作品：BanG Dream! Our Notes（MyGO!!!!! / Ave Mujica / 梦限大MewType / millsage / 一家Dumb Rock，25 人）
 * 定位：该作品的**可检索文本层**——角色档案 / 角色卡 / 关系 / 状态机 / 语言指纹 / 台词 / 事件 / 场所物件 / 世界书 / 完整模型文档。
 *
 * 工具实现见 canon-tools.mjs；协议层（工具清单 / 初始化协商 / JSON-RPC 分发）见 canon-mcp-core.mjs；
 * 本文件只做 **stdio 传输**。
 * 要 HTTP（streamable-http，和 MYGO_MCP 同形态、可被任何 MCP 客户端按 URL 连）用：
 *   node mcp-canon/canon-mcp-http.mjs        →  http://127.0.0.1:8787/mcp
 *
 * 语义检索：**推荐用本地 Ollama**（默认 qwen3-embedding:0.6b；可配 EMBED_MODEL / RERANK_MODEL），
 *           装不上也不影响使用——自动降级为纯词汇检索并在结果里说明。
 * v1.4：协议层抽到 canon-mcp-core.mjs（stdio / streamable-http 共用）+ 协议版本按客户端协商。
 * v1.2：改名（服务端 kb → canon，工具名去掉 kb_ 前缀）+ 接管角色卡/世界书/模型长文，共 15 个工具。
 */
import { createInterface } from 'node:readline';
import { safeHandleMessage } from './canon-mcp-core.mjs';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

/**
 * 在途计数：MCP 客户端发完请求就关 stdin 时，**不能立刻退出**——
 * 否则需要 Ollama 的异步工具（search / event / quote 带 q / world 带 q）
 * 的回复会被 process.exit 抢掉，表现是「管道里看不到这一条回复」。
 * 真实客户端（DSH）保持 stdin 开启，所以只有冒烟测试会踩到；但这属于传输层职责，必须修。
 *
 * 做法：stdin 关闭后**不主动 exit**，等在途请求跑完、事件循环自己排空（干净退出）。
 * 别改成 process.exit()——Windows 上会在句柄关闭途中触发
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`。
 */
let inflight = 0;

rl.on('line', async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  inflight++;
  try {
    const out = await safeHandleMessage(msg);
    if (out) send(out); // 通知（无 id）不回包
  }
  finally { inflight--; }
});
rl.on('close', () => {
  // 兜底：万一某个工具卡死，最多再等 150 秒（unref 保证它自己不会拖住进程）
  setTimeout(() => process.exit(0), 150000).unref();
});
