# MCP 服务器 · 《BanG Dream! Our Notes》资料库

把本工作区里**可检索的文本层**暴露成 **MCP（Model Context Protocol）工具**，供 DSH 或任何 MCP 客户端调度。

- **作品**：BanG Dream! Our Notes —— MyGO!!!!! / Ave Mujica / 梦限大MewType / millsage / 一家Dumb Rock，共 **25 人**
- **语义检索**：**推荐用本地 Ollama** 做向量检索（数据不出本机、零 API 费用）；不装也能用，自动降级为纯词汇检索并在结果里说明
- **两条传输**：**stdio**（DSH 默认注册的方式）与 **streamable-http**（`http://127.0.0.1:8787/mcp`，与 `MYGO_MCP` 同形态）
  —— 同一份协议层 + 同一份工具实现，见「## 两条传输：stdio 与 HTTP」
- **当前版本 v1.4**：协议层抽到 `canon-mcp-core.mjs` + 协议版本按客户端协商 + 新增 streamable-http 传输（15 个工具不变）
- **v1.3 名字索引**：所有收 `name` 的工具现在都认**中日全名 / 只写姓 / 只写名 / 舞台名 / 罗马音 / 简繁与和制汉字**（`三角初华`、`三角`、`三角 初華`、`Doloris`、`ドロリス`、`Uika Misumi`、`Misumi Uika`）。详见「## v1.3 更新了什么」

## 已注册

| 项 | 值 |
|---|---|
| 服务端名 | `canon`（DSH project 级，stdio）—— 工具全名形如 `mcp__canon__char` |
| 协议身份 | `canon-notes-kb` v1.4.0（`initialize` 时返回，含 title） |
| 加载状态 | `loader on:active，15 个工具`（`mcp_manager_list` 可查） |
| 改代码后 | 必须 **重启加载器**（`mcp_manager_restart`）才生效；工具清单会热更新到当前会话 |

> **从 v1.1 迁移**：旧的 `kb_*` 调用名仍可用（服务端保留 `kb_char → char` 的兼容映射），
> 但 `tools/list` 只播报新名，文档与提示词请统一改用新名。

## 两条传输：stdio 与 HTTP

同一个服务器有两种连法，**工具清单与行为完全一致**（协议层 `canon-mcp-core.mjs` + 工具层 `canon-tools.mjs` 共用）：

| 传输 | 入口文件 | 地址 | 适合 |
|---|---|---|---|
| **stdio**（默认，已注册） | `canon-mcp-server.mjs` | —（宿主 spawn） | DSH 里开箱即用，不占端口 |
| **streamable-http** | `canon-mcp-http.mjs` | `http://127.0.0.1:8787/mcp` | 多个客户端/多台机器按 URL 连；curl/PowerShell 直接调试；无需 spawn（对本沙箱的 spawn EPERM 免疫） |

### 启动

```powershell
node mcp-canon/canon-mcp-http.mjs      # 前台，Ctrl+C 停止
.\start-kb.ps1                       # 菜单 [6] 启动 HTTP / [7] 体检端点
```

启动后：`GET /health`（存活探针，不需要 token）、`GET /tools`（工具清单）、
`POST /call`（`{"name":"char","arguments":{"name":"初华"}}`，随手 curl 用；三者都不是 MCP 协议的一部分）。

### 范本 JSON（[`mcp-http.example.json`](./mcp-http.example.json)）

```json
{
  "mcpServers": {
    "canon": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

需要 token 时（服务端设了 `CANON_HTTP_TOKEN`）：

```json
{
  "mcpServers": {
    "canon": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer 你的token" }
    }
  }
}
```

### 注册进 DSH

stdio（现状，二选一，别同时开两份 15 工具）：

```
mcp_manager_add(serverName=canon, transport=stdio, command=node, args=<...>\mcp-canon\canon-mcp-server.mjs)
```

HTTP（与 `MYGO_MCP` 同形态；**要先起服务**，否则该条目连不上）：

```
mcp_manager_add(serverName=canon, transport=streamable-http, url=http://127.0.0.1:8787/mcp, level=project)
```

> 两个都注册会让同名 15 个工具出现两遍（`mcp__canon__*`），日常只留一个。

### 传输层实现要点

- 请求 → `200 + application/json`；通知（无 `id`）→ `202` 空体；`Accept` 只认 `text/event-stream` 时回单帧 SSE
- **无会话**：不发 `mcp-session-id`，客户端因此也不会发 `DELETE`（规范允许，最省事也最稳）；无状态天然可并发
- `GET /mcp` 与 `DELETE /mcp` → `405`（不开独立 SSE 流 / 无会话可终止，规范允许，官方 SDK 把 405 当正常）
- 只监听 `127.0.0.1`（回环）；`OPTIONS` 带 CORS 头，浏览器里的 MCP 客户端也能连
- 冒烟：`node mcp-canon/_test-http.mjs` —— 进程内起服务器 + 真实 fetch，28 项断言（含通知 202 / 405 / 404 /
  token 鉴权 / SSE 单帧 / 旧名 `kb_*` 兼容），**不需要 spawn**，所以在本沙箱也能跑

## 覆盖范围：MCP 能拿到什么

**能拿到（本工作区的文本资产，全部可检索）**

| 资产 | 数量 | 对应工具 |
|---|---|---|
| 角色档案（事实/性格内核/关系/状态机/语言指纹/OOC 红线） | 25 人 | `char` `rel` `state` `speech` |
| 代表性台词库 | 256 句 | `quote` `sample` |
| 事件 / 场所 / 物件 | 14 / 7 / 7 | `event` `world` |
| **SillyTavern V2 角色卡**（含 first_mes / mes_example / 可导入） | **25 张** | **`card`** |
| **世界书词条** | **49 条** | **`worldbook`** |
| **完整《角色扮演模型》长文** | 25 份 | **`doc`** |
| **可直接粘贴的系统提示词** | 25 份 | **`doc`（kind=prompt）** |

**拿不到（有意不接入，按需再加）**：游戏原始表 `masterdata/`、剧本原文 `素材全量/`（按话/按角色）、
`.cache/script` 抓取缓存、`角色模型/提取`（签名时刻）与 `主线`、订单队列产出、任何图片/音频素材。
需要这些就得按路径直接读文件——**MCP 只覆盖"结构化 + 可直接投喂 LLM 的文本"**。

## 工具一览（15）

| 工具 | 参数 | 说明 |
|---|---|---|
| `search` | q, top_k?, rerank?, type? | 混合检索（词汇 + 本地向量语义）；`type` 限定 角色/事件/场所/物件/台词 |
| `char` | name | 角色档案（结构化字段；要长文用 `doc`，要卡用 `card`） |
| `rel` | a, b | 双向关系（称呼 + 温度；语料无交集会如实标注） |
| `event` | q, top_k? | 事件检索（集数/参与者/摘要/关键词） |
| `quote` | q?, by?, top_k? | 台词检索；`by` 限定说话人，语义未命中时回退该角色台词库的词汇匹配 |
| `who` | text（字符串**或数组**/多行）, top_k? | 「这句是谁说的」——语言指纹偏差分，全 25 人排序；**多句比单句明显更准** |
| `speech` | name? / names[]? / metric? / order? / top_k? | 语言指纹：单人 16 项明细、按指标全库排名、2~5 人并排（附差异最大指标） |
| `state` | name? / q? | 状态机：状态名/触发 keys/该状态下的说话方式；`q` 跨角色搜 |
| `stats` | name? | 资料库体检：**检索后端**、文本资产盘点、缺失指标、模型文档存在性、缺口清单、台词库抽样偏差 |
| `world` | q? / kind? / top_k? | 场所 / 物件查询 |
| `sample` | name, n?, seed? | 抽该角色真实台词 N 句（同 seed 可复现）——扮演测试 / 盲测出题 |
| `card` | name, max_chars? | **SillyTavern V2 角色卡原字段**（description/personality/scenario/first_mes/mes_example/system_prompt/alternate_greetings/tags…） |
| `worldbook` | q?, top_k? | **世界书词条**：不带 q 回目录（49 条），给词或 uid 取正文 |
| `doc` | name, kind?（model\|prompt）, max_chars? | **完整《角色扮演模型》**（≤6 万字）或**系统提示词**（≤2 万字） |
| `list` | type? | 清单（角色/事件/场所/物件） |

## 推荐：用本地 Ollama 做向量检索

**为什么推荐**：语义检索是"按意思找"而不是"按字面找"的能力（问「会撒娇的网络主播」也能命中爱音）。
用本地 Ollama 做嵌入有三个好处：**数据不出本机**、**没有 API 费用**、**离线可用**。代价只有一次模型下载。

```bash
# 1) 装 Ollama（https://ollama.com），确认服务在跑
curl http://localhost:11434/api/tags

# 2) 拉嵌入模型（默认用它，0.60 GB）
ollama pull qwen3-embedding:0.6b
```

**本机实测可用的模型（2026-09-27 实测）**

| 用途 | 模型 tag | 体积 | 说明 |
|---|---|---|---|
| 嵌入（默认） | `qwen3-embedding:0.6b` | 0.60 GB | 309 个检索块，首次建缓存约 20~40 秒 |
| 嵌入（进阶） | `qwen3-embedding:4b` | 2.33 GB | `EMBED_MODEL=qwen3-embedding:4b`；换模型会因缓存键不同自动重建 |
| 精排（可选） | `pdurugyan/qwen3-reranker-0.6b-q8_0:latest` | 0.60 GB | 设 `RERANK_MODEL` 后 `rerank=true` 生效 |
| 精排（进阶） | `B-A-M-N/Qwen3-Reranker-4B` | 2.33 GB | 同类，效果更强、更慢 |

**没装 / 没起 Ollama 会怎样**：不会报错、不会失能——自动降级为**纯词汇检索**，结果里附 `note` 说明；
`stats` 的「检索后端」会直接告诉你当前是哪一种，以及恢复命令（`ollama pull qwen3-embedding:0.6b`）。
所以 Ollama 是**推荐项而非硬依赖**：先能用，再谈更好。

**缓存**：`资料库/.kb-embeddings.json` 带语料哈希 + 模型名；数据或模型一变就自动重建，不用手动清。

## v1.4 更新了什么（HTTP 传输 + 协议层抽取）

1. **协议层抽到 [`canon-mcp-core.mjs`](./canon-mcp-core.mjs)**：工具清单 / `initialize` 协商 / JSON-RPC 分发
   只有一份；`canon-mcp-server.mjs`（stdio）与 `canon-mcp-http.mjs`（HTTP）都只是薄薄一层传输。
   **行为对齐**：通知不回包、工具错误走 `result.isError`、旧名 `kb_*` 仍可用、结果 JSON 缩进 2 空格。
2. **新增 streamable-http 传输**：`node mcp-canon/canon-mcp-http.mjs` → `http://127.0.0.1:8787/mcp`，
   零依赖（只用 `node:http`），形态与 `MYGO_MCP`（`http://127.0.0.1:8848/mcp`）一致。
3. **协议版本按客户端协商**：客户端要 `2025-11-25` 就给 `2025-11-25`（此前固定回 `2024-11-05`）；
   不认识的版本回落到 `2025-06-18`。已知支持集见 `SUPPORTED_PROTOCOL_VERSIONS`。
4. **不再强退**：HTTP 服务收到 Ctrl+C 只 `server.close()`，等事件循环自然排空——
   `process.exit()` 在 Windows 句柄关闭途中会触发 libuv 断言（`_test-http.mjs` 因此改用 `exitCode`）。

## v1.3 更新了什么（中日姓名索引）

**症状**：`char{name:"三角初华"}` 返回「未找到角色」——库里所有实体的主键都是**简称**（初华 / 祥子 / 睦），
而中日语境下人写的是全名。这是索引缺口，不是调用方的错。

**修法**：解析逻辑抽到独立模块 [`name-index.mjs`](./name-index.mjs)，所有收 `name` 的工具（`char` / `rel` /
`quote.by` / `speech` / `state` / `stats` / `sample` / `card` / `doc`）统一走它。

| 形态 | 例子 |
|---|---|
| 主键 | `初华` · `uika` · `初音`（库内别名） |
| 全名 | `三角初华` · `三角 初华` · `三 角 初 华` · `三角初華` · `Doloris / 三角初华` |
| 只写姓 | `三角` · `高松` · `丰川` · `藤` |
| 日文 | `三角 初華` · `長崎そよ` · `祐天寺にゃむ` · `汐見蛍` |
| 舞台名 | `Doloris` · `ドロリス` · `Oblivionis` · `オブリビオニス` |
| 罗马音 | `Uika Misumi` · `Misumi Uika` · `uika` · `Misumi`（长音符也能过：`Tōgawa` → `togawa`） |
| 手写昵称 | `小祥` → 祥子 · `小睦` → 睦 |

**字对从哪来**：`工具/素材提取/aliases.json` 每条同时给了 zh 与 ja 写法，**等长时逐字对齐**即可推出
权威字对（長→长、豊→丰、葉→叶、蛍→萤、鈴→铃），含假名的位置跳过（`长崎爽世` vs `長崎そよ` 的
爽/そ 不是字对）。长度不等的（`伊沢 なつめ` vs `伊泽枣`、`浜崎 まほろ` vs `滨崎茉幌`）推导不到，
进 `MANUAL_FOLD` 手写补充。**凡是能推出来的一律不手写**，避免第二份真相。

**不猜**：
- 同级多命中 → 报**歧义**并列候选（`叶` → 睦 / 蕾叶），不按数组顺序蒙一个
- 姓是弱证据：`三角初雪` **不会**因为含"三角"被认成初华，只在整串就是 `三角` 时才算命中
- 未命中时给**最像的几个**候选 + 可用写法 + 乐队名提示（`Ave Mujica` → 成员名单），不再把 25 个人名整份倒出来
- 命中路径会回显在 `char._命中`（如 `全名(中文)` / `姓(中文)` / `舞台名`），便于排查

**测试**：`node mcp-canon/_test-names.mjs` —— 91 条名字形态 + 25 人全量（中文全名/日文全名/只写姓）
+ 工具端到端 + 歧义与未知名的如实回报，全部离线（不需要 Ollama）。

## v1.2 更新了什么

1. **改名**：服务端 `kb` → **`canon`**，目录 `mcp-kb/` → `mcp-canon/`，
   `kb-mcp-server.mjs` → `canon-mcp-server.mjs`，`kb-tools.mjs` → `canon-tools.mjs`；
   工具名去掉 `kb_` 前缀（品牌由 `mcp__canon__` 命名空间承担）。旧名仍可调用，见上文"迁移"。
   CLI 同步改名：`工具/kb.mjs` → **`工具/canon.mjs`**，命令与 MCP 工具一一对应。
2. **接管其余文本资产**：新增 `card`（25 张 SillyTavern V2 卡）、`worldbook`（49 词条）、
   `doc`（完整模型长文 / 系统提示词）。此前这三样**只能按文件路径去翻，MCP 拿不到**。
3. **`stats` 自述检索后端与文本资产**：把"推荐用本地 Ollama"从 README 里的建议变成工具输出里的事实。

> 数据层命名**有意未改**：`资料库/kb.json`、`工具/build_kb.mjs`、`工具/check_kb.mjs` 保持原名
> （它们指的是"知识库数据文件"这一层，改动会牵动大量脚本与归档记录，收益为零）。

## v1.1 更新了什么（`who` 打分器）

`who` 从"整段当一句"升级为**多句聚合**：按 `。！？` 拆句 → 用 n 句估计语料级特征 → 与登记指标比偏差。
v1.0 遇到多句会崩（把整段汉字数当"句长均值"），回测 top1 从 8.3% 掉到 **3.3%**。
另外：波浪号预期不再硬编码 `['若麦','爱音','爽世']`（实测 quote_bank 里 **12 人**都用过「～」，那份名单是错的），改为从数据派生。
**注**：不在「…」处断句——本语料 36~48% 的行含省略号，它是停顿标记而非句末。

### `who` 回测（`node mcp-canon/_bench-who.mjs`）

把 25 人的 `quote_bank` 拆成 **399 句**当"已知说话人"的测试句，看能否把真说话人排到 top-1：

| 变体 | 样本 | top1 | top3 |
|---|---|---|---|
| v1.0 单句（旧打分器） | 399 | 8.3% | 17.3% |
| v1.0 多句拼接（旧工具遇到多句的真实行为） | 123 | 3.3% | 8.1% |
| **v1.2 单句** | 399 | **11.0%** | 24.3% |
| v1.2 3 句·特征聚合 | 121 | 14.0% | 28.1% |
| v1.2 3 句·逐句多数票 | 121 | 11.6% | 25.6% |
| **v1.2 5 句·特征聚合** | 57 | **15.8%** | 31.6% |
| v1.2 5 句·逐句多数票 | 57 | 10.5% | 22.8% |
| 随机基线 | — | 4% | 12% |

**结论**：多句 > 单句（调用方**至少给 3 句**）；**特征聚合 > 逐句多数票**；新打分器 > 旧打分器。
三种口径 raw / rank / z **互相区分不出来**（5 句档 n=57，标准误 ≈5pp），所以默认取最简单的 `raw`，
**不在这份有偏样本上调权重**——那会过拟合。逐维度消融（`--ablate`）显示只有"省略号率""感叹结尾"有稳定正贡献。

**口径声明（别拿这张表当"真人盲测水平"）**：① 同源检验，绝对值偏高；
② 测试句来自 `quote_bank`，而它不是随机抽样（见下节），分布比语料"平"，绝对值又被压低；
③ 标准误：单句 ≈1.6pp、3 句 ≈2.9pp、5 句 ≈5.0pp——表里 ±2pp 的差异都在噪声内。
它唯一成立的作用是**同一批样本下比较变体**。

## 台词库抽样偏差（`stats` · 值得先知道的坑）

`quote_bank` 是**人工精选**台词，不是随机抽样——它与 `speech` 里登记的语料指标**系统性打架**，
25 人里 **42 条**明显偏差，方向几乎全是"精选台词比语料干净"：

| 例子 | 语料登记 | 台词库实测 | 差 |
|---|---|---|---|
| 乐奈 · ≤6字占比 | 85.5% | 42.9% | **-42.6** |
| 由乃 · 省略号率 | 41.5% | 0% | **-41.5** |
| 都子 · ≤6字占比 | 39.1% | 0% | **-39.1** |
| 立希 · 疑问率 | 29.9% | 1.9% | **-28.0** |
| 爱音 · 疑问率 | 38.6% | 14.3% | -24.3 |
| 朋花 · 省略号率 | 30.5% | 60% | **+29.5**（反向） |

**后果**：拿 `quote_bank`（或用 `sample` 抽的台词）当"风格范本"、出盲测题，会继承这个偏移；
`who` 在它上面评测时疑问率维度拿到的是被压低的估计。这是**偏差而非数据错误**（精选本就偏向"有戏"的句子），
但用它之前得知道。逐人数据在 `stats` 的「台词库抽样偏差」。

## 手动启动 / 测试

```bash
# 工具层冒烟：15 个工具 + 断言全跑（不需要 spawn）
node mcp-canon/_test-tools.mjs

# 中日姓名索引回归（91 条名字形态 + 25 人全量，纯离线）
node mcp-canon/_test-names.mjs

# 打分器回测（--ablate 逐维度消融；--json 机器可读）
node mcp-canon/_bench-who.mjs [--ablate] [--json]

# 逻辑自检一行（供脚本兜底）
node mcp-canon/_selfcheck.mjs

# HTTP 传输冒烟：进程内起服务器 + 真实 fetch，28 项断言（不需要 spawn；随机端口）
node mcp-canon/_test-http.mjs

# 起 HTTP 服务后可直接 curl / PowerShell 打（都不是 MCP 协议的一部分，只是顺手）
#   GET  /health                          → {ok,server,tools,...}
#   GET  /tools                           → 15 个工具的 schema
#   POST /call  {"name":"char","arguments":{"name":"初华"}}
node mcp-canon/canon-mcp-http.mjs

# stdio 冒烟（PowerShell 管道喂 JSON-RPC，规避本沙箱 node spawn EPERM）
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node mcp-canon/canon-mcp-server.mjs

# CLI（与 MCP 共用同一份实现）
node 工具/canon.mjs speech 疑问率
node 工具/canon.mjs card 爱音
node 工具/canon.mjs worldbook 春日影
node 工具/canon.mjs doc 灯 prompt

# 一键环境自检 + 菜单（含 Ollama / 嵌入缓存检查）
.\start-kb.ps1

# 注册进 DSH（已注册；如需重建）
# 项目级：mcp_manager_add(serverName=canon, transport=stdio, command=node, args=<canon-mcp-server.mjs 绝对路径>)
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `KB_PATH` | `<mcp-canon>/../资料库/kb.json` | 知识库数据文件 |
| `OLLAMA_URL` | `http://localhost:11434` | 本地 Ollama API |
| `EMBED_MODEL` | `qwen3-embedding:0.6b` | 嵌入模型（可换 `qwen3-embedding:4b`） |
| `RERANK_MODEL` | （空） | 置为 `pdurugyan/qwen3-reranker-0.6b-q8_0:latest` 启用精排 |
| `CANON_HTTP_HOST` | `127.0.0.1` | HTTP 传输监听地址（**别改成 `0.0.0.0`**，除非你确实要对外暴露整份语料） |
| `CANON_HTTP_PORT` | `8787` | HTTP 传输端口（`MYGO_MCP` 用 8848，互不冲突） |
| `CANON_HTTP_PATH` | `/mcp` | HTTP 端点路径 |
| `CANON_HTTP_TOKEN` | （空） | 设了之后 POST 必须带 `Authorization: Bearer <token>`（`/health` 仍免鉴权，供探针） |

## 与命令行版的关系

- `canon-tools.mjs` 是**唯一的工具实现**（纯函数层，可 import）；
  `canon-mcp-core.mjs` 是**唯一的协议层**（工具清单 / 版本协商 / JSON-RPC 分发）；
  `canon-mcp-server.mjs`（stdio）与 `canon-mcp-http.mjs`（streamable-http）**只做传输**——改工具只改 `canon-tools.mjs`
- `工具/canon.mjs`（CLI，含 `--json`）的 `who` / `speech` / `state` / `card` / `worldbook` / `doc`
  **直接 import 同一份实现**；`search` / `char` / `rel` / `event` / `quote` / `list` 仍是它自己的词汇检索（不依赖 Ollama）
  > v1.0 曾两边各写一套 `who`（README 却称"同一份逻辑"），已合并——别再分叉。
- 数据源更新后：`node 工具/build_kb.mjs` 重建 kb.json → 服务器按语料哈希变化自动重建嵌入缓存

## 已知边界

- **只认中文剧本**：语言指纹基于中文语料统计，纯假名/罗马字输入会被判为无效句并如实报错（要评估日文得先另建一套日文指纹）
- **单句猜人不可当真**：回测单句 top1 仅 11%；给 ≥3 句才有实用价值，且始终只是"偏差分排序"而非结论
- **`quote_bank` 有抽样偏差**（见上节）
- **数据缺口**：乐奈、宁月缺 `歌词*` 三项指标；20 人台词库 <10 条（`stats` 会列出）
- **Ollama 是推荐项**：不可用时语义检索禁用、纯词汇可用；不要把它写成硬依赖
- MCP stdio 由 DSH 的加载器拉起；本工作区沙箱内 **node spawn 子进程受 EPERM 限制**（已文档化的边界），
  测试请走 `_test-tools.mjs` / PowerShell 管道 / **`_test-http.mjs`（进程内起服务，完全不用 spawn）**；
  `_test-client.mjs` 在本沙箱会报 `spawn EPERM`，属预期
- **HTTP 不是常驻服务**：`canon-mcp-http.mjs` 是随用随起的进程；没起服务时按 URL 注册的 MCP 条目会连不上
  （stdio 由宿主 spawn，没有这个前置条件）——这也是默认仍用 stdio 注册的原因
- 服务端收到 stdin EOF 后**不强制退出**，等在途异步请求（Ollama 检索）回完再自然退出；HTTP 端同理，
  Ctrl+C 只 `server.close()`——别改成 `process.exit()`：Windows 上会在句柄关闭途中触发 libuv 断言
