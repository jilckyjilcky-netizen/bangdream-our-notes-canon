#!/usr/bin/env node
/**
 * canon-mcp-core.mjs —— 《BanG Dream! Our Notes》资料库 MCP 服务器：**传输无关的协议层**
 *
 * 两条传输共用这一份实现（工具清单 / 初始化协商 / JSON-RPC 分发）：
 *   - stdio          → canon-mcp-server.mjs（零依赖，DSH stdio 注册用）
 *   - streamable-http → canon-mcp-http.mjs  （零依赖，http://127.0.0.1:8787/mcp，与 MYGO_MCP 同形态）
 *
 * 工具实现见 canon-tools.mjs；本文件不碰 stdin/stdout/网络，只产出「要回复的 JSON-RPC 对象」。
 */

/** 工具定义：name → { description, schema }（schema 即 MCP inputSchema） */
export const TOOL_DEFS = {
  list: { description: '资料库清单。type: 角色|事件|场所|物件（缺省全部）', schema: { type: 'object', properties: { type: { type: 'string' } } } },
  search: { description: '资料库混合检索（词汇 + 本地 Ollama 向量语义，rerank=true 时用本地 reranker 精排）。返回 角色/事件/场所/物件/台词 结果；type 可限定类别', schema: { type: 'object', properties: { q: { type: 'string' }, top_k: { type: 'number' }, rerank: { type: 'boolean' }, type: { type: 'string', description: '限定类别：角色|事件|场所|物件|台词' } }, required: ['q'] } },
  char: { description: '角色档案：事实/性格内核/语言指纹/状态机/关系/OOC红线/代表性台词（结构化字段；要长文用 doc，要卡用 card）', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  rel: { description: '双向关系：称呼与关系温度（语料无交集会如实标注）', schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] } },
  event: { description: '事件检索：词汇+语义，返回集数/参与者/摘要', schema: { type: 'object', properties: { q: { type: 'string' }, top_k: { type: 'number' } }, required: ['q'] } },
  quote: { description: '台词检索：按内容或情感语义检索台词，返回归属；by 可限定某个角色的台词（语义未命中时回退为该角色台词库的词汇匹配）', schema: { type: 'object', properties: { q: { type: 'string' }, by: { type: 'string', description: '限定说话人（角色名）' }, top_k: { type: 'number' } } } },
  who: { description: '「这句是谁说的」：按语言指纹（句长/短句占比/省略号/疑问/感叹/口吃/小X/含我/波浪号）给全 25 人打偏差分。支持多句输入——传多行或数组（多句比单句明显更准）', schema: { type: 'object', properties: { text: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: '一句话；也可传多行文本或字符串数组（推荐 ≥3 句）' }, top_k: { type: 'number', description: '返回候选人数，默认 3' } }, required: ['text'] } },
  speech: { description: '语言指纹查询：传 name 看某人全部 16 项指标明细；传 metric（如「疑问率」「≤6字占比」）看 25 人排名；传 names 数组并排对比（附差异最大的指标）', schema: { type: 'object', properties: { name: { type: 'string' }, names: { type: 'array', items: { type: 'string' }, description: '2~5 个角色并排对比' }, metric: { type: 'string', description: '指标名，如 疑问率 / 省略号率 / ≤6字占比 / 句长均值(汉字)' }, order: { type: 'string', enum: ['asc', 'desc'], description: '排名方向，默认 desc（从高到低）' }, top_k: { type: 'number' } } } },
  state: { description: '状态机查询：传 name 看某人全部状态（状态名/触发 keys/该状态下的说话方式）；传 q 跨角色搜状态', schema: { type: 'object', properties: { name: { type: 'string' }, q: { type: 'string' } } } },
  stats: { description: '资料库体检：检索后端（是否已启用本地 Ollama 语义检索）、文本资产盘点、每人的台词/事件/关系/状态与缺失指标、模型文档是否存在、缺口清单', schema: { type: 'object', properties: { name: { type: 'string', description: '只看某个角色（缺省全库）' } } } },
  world: { description: '场所 / 物件查询：q 语义检索（返回完整条目与关键词），或省略 q 列出全部；kind 限定 场所|物件', schema: { type: 'object', properties: { q: { type: 'string' }, kind: { type: 'string', enum: ['场所', '物件'] }, top_k: { type: 'number' } } } },
  sample: { description: '从某角色的真实台词库随机抽样 N 句（同 name+seed 可复现）——用于扮演测试 / 盲测出题', schema: { type: 'object', properties: { name: { type: 'string' }, n: { type: 'number', description: '抽样条数，默认 5' }, seed: { type: 'string', description: '随机种子，默认用角色 id' } }, required: ['name'] } },
  card: { description: 'SillyTavern V2 角色卡（角色卡/*.json）原字段：description / personality / scenario / first_mes / mes_example / system_prompt / alternate_greetings / tags 等，可直接导入前端', schema: { type: 'object', properties: { name: { type: 'string' }, max_chars: { type: 'number', description: '每个长字段的截断上限，默认 1200（要全文传大值，如 20000）' } }, required: ['name'] } },
  worldbook: { description: '世界书词条检索：不带 q 回全部词条目录（标题/关键词/长度），给 q 或 uid 取正文；共 50 条，可供 SillyTavern 世界书对账', schema: { type: 'object', properties: { q: { type: 'string', description: '关键词或词条 uid' }, top_k: { type: 'number' } } } },
  doc: { description: '取该角色的长文：kind=model 返回完整《角色扮演模型》（默认，上限 60000 字），kind=prompt 返回可直接粘贴的系统提示词（上限 20000 字）；被截断时用 max_chars 控制', schema: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['model', 'prompt'] }, max_chars: { type: 'number' } }, required: ['name'] } },
  skills: { description: '聊天用人设 skill 清单：列出 人设skill/ 下全部 skill（id/角色/乐队/招牌机制）。id = canon 角色 id = 文件夹名，作 skill 工具的 name 参数。可选 band 过滤', schema: { type: 'object', properties: { band: { type: 'string', description: '按乐队过滤：MyGO!!!!!|Ave Mujica|梦限大MewType|millsage|一家Dumb Rock!|Sumimi（非乐队）' } } } },
  skill: { description: '取某角色的聊天用人设 skill 全文：name 传角色名/别名/id（如 祥子/sakiko/小祥），part 选 skill（默认，SKILL.md）|lines（台词语料库）|lore（背景考据）|yaml（UI 元数据）|all（四件全给）。人设 skill 让 CLI 用该角色腔调说话，骨架对齐 dafeiyu skill', schema: { type: 'object', properties: { name: { type: 'string' }, part: { type: 'string', enum: ['skill', 'lines', 'lore', 'yaml', 'all'] }, max_chars: { type: 'number', description: '单文件返回上限，默认 8000（all 模式每文件 8000）' } }, required: ['name'] } },
};

/** MCP 服务端身份（initialize 返回；两条传输一致） */
export const SERVER_INFO = { name: 'canon', title: 'BanG Dream! Our Notes 资料库', version: '1.5.0' };

/** 我们声明支持的协议版本（与官方 @modelcontextprotocol/sdk 1.30 的集合对齐） */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

/** 协商：客户端要什么就给什么（在支持集合内），否则给一个现代且被广泛支持的版本 */
export function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : FALLBACK_PROTOCOL_VERSION;
}

/** tools/list 的返回体 */
export function listTools() {
  return Object.entries(TOOL_DEFS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema }));
}

export const TOOL_NAMES = Object.keys(TOOL_DEFS);

export const isNotification = (msg) => !!msg && msg.id === undefined && typeof msg.method === 'string';

/** 兼容旧调用：v1.1 及以前的工具名带 kb_ 前缀（kb_char → char）。tools/list 只播报新名。 */
export async function resolveTool(name) {
  const { tools } = await import('./canon-tools.mjs');
  return tools[name] || tools[String(name || '').replace(/^kb_/, '')];
}

/** 工具结果 → MCP content 包装（与旧 stdio 版完全一致：长对象缩进 2 空格） */
export function toContent(result, { isError = false } = {}) {
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
    isError,
  };
}

/**
 * 处理一条 JSON-RPC 消息，返回「要回给客户端的对象」。
 * 通知（无 id）返回 null —— 调用方自行决定：stdio 什么都不做，HTTP 回 202。
 */
export async function handleMessage(msg) {
  if (!msg || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const reply = (result, opts) => ({ jsonrpc: '2.0', id: msg.id, result: toContent(result, opts) });

  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: negotiateProtocolVersion(msg.params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return null;
    case 'ping':
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id: msg.id, result: { tools: listTools() } };
    case 'tools/call': {
      const t = await resolveTool(msg.params?.name);
      if (!t) return reply({ error: `未知工具 ${msg.params?.name}（现有：${TOOL_NAMES.join('、')}）` }, { isError: true });
      try { return reply(await t.run(msg.params?.arguments || {})); }
      catch (e) { return reply({ error: e?.stack || String(e) }, { isError: true }); }
    }
    default:
      if (isNotification(msg)) return null;
      return { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: 'Method not found: ' + msg.method } };
  }
}

/** 兜底：把 handleMessage 抛出的异常也变成 JSON-RPC 错误对象 */
export async function safeHandleMessage(msg) {
  try { return await handleMessage(msg); }
  catch (e) { return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: String(e?.message || e) } }; }
}
