# MCP 服务器 · 《BanG Dream! Our Notes》资料库

把本工作区里**可检索的文本层**暴露成 **MCP（Model Context Protocol）工具**，供 DSH 或任何 MCP 客户端调度。

- **作品**：BanG Dream! Our Notes —— MyGO!!!!! / Ave Mujica / 梦限大MewType / millsage / 一家Dumb Rock，共 **25 名乐队角色**；库内实际登记 **47 人**（25 名乐队成员 + Sumimi 真奈 + 妖精花束薇欧拉 + NPC，**其中 16 名主线相关 NPC 于 2026-10-05 第二批入册**；`who` / `speech` 都对这 47 人打分与排名）
- **语义检索**：**推荐用本地 Ollama** 做向量检索（数据不出本机、零 API 费用）；不装也能用，自动降级为纯词汇检索并在结果里说明
- **两条传输**：**stdio**（DSH 默认注册的方式）与 **streamable-http**（`http://127.0.0.1:8787/mcp`，与 `MYGO_MCP` 同形态）
  —— 同一份协议层 + 同一份工具实现，见「## 两条传输：stdio 与 HTTP」
- **当前版本 v1.6.0**：协议层抽到 `canon-mcp-core.mjs` + 协议版本按客户端协商 + 新增 streamable-http 传输；v1.5 起接管人设 skill（新增 `skill` / `skills`）与 Live2D 演出层 `action`，v1.6 新增场景化演出编排 `motion`，**19 个工具**
- **v1.3 名字索引**：所有收 `name` 的工具现在都认**中日全名 / 只写姓 / 只写名 / 舞台名 / 罗马音 / 简繁与和制汉字**（`三角初华`、`三角`、`三角 初華`、`Doloris`、`ドロリス`、`Uika Misumi`、`Misumi Uika`）。详见「## v1.3 更新了什么」

## 目标用户 / 「首版」定义 / 成功指标

这一节是补上的。本文原先只讲「有什么工具」，不讲「给谁用、做到什么算够」——
结果是判断某个工具该不该进首版时没有依据，而**数字漂移过一次也没有任何东西会红**。

### 目标用户（从下游反推，不是设想）

| 消费者 | 接入方式 | 它实际靠什么工作 |
|---|---|---|
| DSH / 通用 Agent | MCP stdio（`mcp__canon__*`） | 读 `tools/list` 的**描述文本**选工具，拿返回文本直接做判断 |
| Live2D 演出编排器 | `工具/编排_台词动作.mjs` 等 | 某一拍配哪个动作 + 同 model+exp 的真实台词范例（`motion`） |
| 跑道（跑团终端） | `import { tools } from 'mcp-canon/canon-tools.mjs'` —— **绕过 MCP 传输** | 逐句角色扮演与判定；要「证据非判断」可追溯 |
| light-novel-creator skill | 直接读文件 + `doc` / `card` / `skill` | 角色卡、系统提示词、长文设定 |
| 经 CLI 调度的程序 | `node 工具/canon.mjs <tool> --json` | 结构化输出，可被 `child_process` 解析（`资料库/README.md` 明示） |

> 对所有消费者都成立的两条铁律（本节是它们的依据）：
> **① 返回里给出的数字必须与实现现算一致** —— 描述里写「30 人」「50 条」而实际是 47 / 66，模型会照着错的数字做推理；
> **② 证据与判断要分开** —— `conf`、`证据级别`、`警告`、`note` 都在回答「这次结果有多可信」，它们**不能互相打架**
> （曾经同一个响应里 `conf: "high"` 与「证据不足…仅 2 条演出」同时出现）。

### 「首版」在这份文档里指什么

**v1.2 完成时点**：能**端到端跑通**、且**自述可信**的最小工具面 —— 改名 `kb→canon`、两条传输共用同一份协议层与工具层、`stats` 自报检索后端与文本资产。

首版**不**比工具数量，比的是：**模型只读 `tools/list` 就能选对工具、并正确解读返回**。
按这把尺子，`action` / `motion` / `skill` / `skills` 是 v1.6 的长出来的能力，不属首版；它们的自述同样受上面两条铁律约束。

### 成功指标（可当场验证，不设拍脑袋的百分比）

| 指标 | 判据 | 现算命令 |
|---|---|---|
| 自述零漂移 | 工具描述与各 README 里的人数/条数/文件数都等于实测 | `node 工具/check_doc_totals.mjs`（退出码 0）+ `_test-tools.mjs` 里的自述数字断言 |
| 契约自洽 | `list` 的输出能原样回喂给收 `name` 的工具；薄样本不给 `conf` | `node mcp-canon/_test-tools.mjs`（含 6 个契约缺陷回归） |
| 名字可达 | 中日全名 / 只写姓 / 舞台名 / 罗马音都能命中 | `node mcp-canon/_test-names.mjs` |
| 两条消费面一致 | MCP 与 CLI 走同一份实现，行为不分叉 | `node mcp-canon/_selfcheck.mjs`、`node 工具/自检.mjs` |
| 可降级 | 没 Ollama 不报错；`rerank` 未生效必须如实说 | `search` 返回的 `note` 字段 |

> ⚠️ **这个仓库没有使用度数据**：`canon-mcp-http.mjs` 的调用日志只 `console.log` 到 stdout、不落盘，`mcp-canon/` 下也没有遥测。
> 所以上表**故意不写**「命中率提升 X%」这类无据指标 —— 要量化 Reach，得先加日志（那是一个独立任务，不在本版范围）。

### 明确不做（写下来是为了别被当成 TODO）

| 不做的事 | 理由 |
|---|---|
| 47 人全员出角色卡 / 人设 skill | 后入册 16 名 NPC 里只有语料 ≥75 句的 5 名主角级够格；给 n≈17 的薄样本统计「怎么说」等于**造假指纹**。其余 11 人只进数据层 + 模型文档 + 系统提示词，模型文档顶部标「指标仅作扮演参考」 |
| 接入 `masterdata/`、`素材全量/` 原文、`.cache/script`、`角色模型/提取`、订单队列产出、任何图片/音频 | MCP 只覆盖「结构化 + 可直接投喂 LLM 的文本」；这些按路径直接读文件更省事，见「拿不到（有意不接入）」 |
| 日文语言指纹 | 现有 16 项指标全部基于**中文剧本**语料统计；要评估日文得先另建一套日文指纹，这不是加个参数的事 |
| 把 HTTP 做成常驻服务 | `canon-mcp-http.mjs` 是随用随起的进程。常驻会把「没起服务就连不上」变成一个需要运维的失败模式，而 stdio 已覆盖 DSH 场景（也是默认注册走 stdio 的原因） |
| 把单句猜人当成结论 | 回测单句 top1 仅约 5~6%（随机基线 2.1%／6.4%）；`who` 始终只是偏差分排序，调用方至少给 3 句并自留判断 |

## 已注册

| 项 | 值 |
|---|---|
| 服务端名 | `canon`（DSH project 级，stdio）—— 工具全名形如 `mcp__canon__char` |
| 协议身份 | `canon` v1.6.0（`initialize` 实跑返回，含 title《BanG Dream! Our Notes 资料库》） |
| 加载状态 | `loader on:active，19 个工具`（`mcp_manager_list` 可查） |
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

stdio（现状，二选一，别同时开两份 19 工具）：

```
mcp_manager_add(serverName=canon, transport=stdio, command=node, args=<...>\mcp-canon\canon-mcp-server.mjs)
```

HTTP（与 `MYGO_MCP` 同形态；**要先起服务**，否则该条目连不上）：

```
mcp_manager_add(serverName=canon, transport=streamable-http, url=http://127.0.0.1:8787/mcp, level=project)
```

> 两个都注册会让同名 19 个工具出现两遍（`mcp__canon__*`），日常只留一个。

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
| 角色档案（事实/性格内核/关系/状态机/语言指纹/OOC 红线） | 47 人 | `char` `rel` `state` `speech` |
| 代表性台词库 | 1271 句 | `quote` `sample` |
| 事件 / 场所 / 物件 | 51 / 7 / 7 | `event` `world` |
| **SillyTavern V2 角色卡**（含 first_mes / mes_example / 可导入） | **36 张** | **`card`** |
| **世界书词条** | **66 条** | **`worldbook`** |
| **完整《角色扮演模型》长文** | 47 份 | **`doc`** |
| **可直接粘贴的系统提示词** | 43 份 | **`doc`（kind=prompt）** |
| **聊天用人设 skill**（SKILL.md / lines / lore / yaml） | 32 套 | **`skill` `skills`** |
| **Live2D 演出层**（情绪→动作谱 / 逐句带演出标签的台词） | 31,505 条 / 62 model | **`action` `motion`** |

> **为什么 47 人只有 36 张卡 / 32 套 skill**：后入册的 16 名 NPC 里，只有语料 ≥75 句的 **5 名主角级**
> （奏多 / 初音 / 铃木 / 蕾叶的祖母 / 小春）出角色卡与人设 skill；其余 **11 名薄样本**（南、波波、蓓儿、Raki、
> 波塔、小萤、柚衣奈、心玖的母亲、枫、歌美、宁月的管家婆婆，语料 12~42 句）只进数据层 + 模型文档 + 系统提示词——
> 用 n=17 的统计去驱动"怎么说"会造出假指纹。他们的模型文档顶部均标注「指标仅作扮演参考」。

**拿不到（有意不接入，按需再加）**：游戏原始表 `masterdata/`、剧本原文 `素材全量/`（按话/按角色）、
`.cache/script` 抓取缓存、`角色模型/提取`（签名时刻）与 `主线`、订单队列产出、任何图片/音频素材。
需要这些就得按路径直接读文件——**MCP 只覆盖"结构化 + 可直接投喂 LLM 的文本"**。

## 工具一览（19）

| 工具 | 参数 | 说明 |
|---|---|---|
| `search` | q, top_k?, rerank?, type? | 混合检索（词汇 + 本地向量语义）；`type` 限定 角色/事件/场所/物件/台词 |
| `char` | name | 角色档案（结构化字段；要长文用 `doc`，要卡用 `card`） |
| `rel` | a, b | 双向关系（称呼 + 温度；语料无交集会如实标注） |
| `event` | q, top_k? | 事件检索（集数/参与者/摘要/关键词） |
| `quote` | q?, by?, top_k? | 台词检索；`by` 限定说话人，语义未命中时回退该角色台词库的词汇匹配 |
| `who` | text（字符串**或数组**/多行）, top_k? | 「这句是谁说的」——语言指纹偏差分，全 47 人排序；**多句比单句明显更准** |
| `speech` | name? / names[]? / metric? / order? / top_k? | 语言指纹：单人 16 项明细、按指标全库排名、2~5 人并排（附差异最大指标） |
| `state` | name? / q? | 状态机：状态名/触发 keys/该状态下的说话方式；`q` 跨角色搜 |
| `stats` | name? | 资料库体检：**检索后端**、文本资产盘点、缺失指标、模型文档存在性、缺口清单、台词库抽样偏差 |
| `world` | q? / kind? / top_k? | 场所 / 物件查询 |
| `sample` | name, n?, seed? | 抽该角色真实台词 N 句（同 seed 可复现）——扮演测试 / 盲测出题 |
| `card` | name, max_chars? | **SillyTavern V2 角色卡原字段**（description/personality/scenario/first_mes/mes_example/system_prompt/alternate_greetings/tags…） |
| `worldbook` | q?, top_k? | **世界书词条**：不带 q 回目录（66 条），给词或 uid 取正文 |
| `doc` | name, kind?（model\|prompt）, max_chars? | **完整《角色扮演模型》**（≤6 万字）或**系统提示词**（≤2 万字） |
| `list` | type? | 清单（角色/事件/场所/物件） |
| `skill` | name, part?（skill\|lines\|lore\|yaml\|all）, max_chars? | **聊天用人设 skill 全文**：从 `人设skill/` 取 SKILL.md / 台词语料库 / 背景考据 / UI 元数据 |
| `skills` | band? | **人设 skill 清单**：32 套 skill 的 id/角色/乐队/招牌机制，`band` 可按乐队过滤 |
| `action` | model? / name? / top? | **Live2D 演出动作谱**（§2 说法层真源证据，报告向）：某角色**全量**「情绪→动作」映射。`model` 传 Live2D model 名（tomori/mutsumi/mortis…），或 `name` 传角色名（核心 16 自动反查，里人格请直接传 model） |
| `motion` | model/name, exp? / exp_base?, top?, lines? | **演出编排**（场景创作向）：`model`+`exp`（或 `exp_base` 如 sad）→ 该角色此表情下 top 动作（含 `_L/_C/_R` 朝向与 canon 次数）+ 同 model+exp 真实台词范例（few-shot）+ valence/arousal。与 `action` 互补：`action` 给全量谱，`motion` 给某一拍的具体选配 |

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
| 嵌入（默认） | `qwen3-embedding:0.6b` | 0.60 GB | 1383 个检索块，首次建缓存约 20~40 秒 |
| 嵌入（进阶） | `qwen3-embedding:4b` | 2.33 GB | `EMBED_MODEL=qwen3-embedding:4b`；换模型会因缓存键不同自动重建 |
| 精排（可选） | `pdurugyan/qwen3-reranker-0.6b-q8_0:latest` | 0.60 GB | 设 `RERANK_MODEL` 后 `rerank=true` 生效 |
| 精排（进阶） | `B-A-M-N/Qwen3-Reranker-4B` | 2.33 GB | 同类，效果更强、更慢 |

**没装 / 没起 Ollama 会怎样**：不会报错、不会失能——自动降级为**纯词汇检索**，结果里附 `note` 说明；
`stats` 的「检索后端」会直接告诉你当前是哪一种，以及恢复命令（`ollama pull qwen3-embedding:0.6b`）。
所以 Ollama 是**推荐项而非硬依赖**：先能用，再谈更好。

**缓存**：`资料库/.kb-embeddings.json` 带语料哈希 + 模型名；数据或模型一变就自动重建，不用手动清。

## v1.6 更新了什么（Live2D 演出编排 motion）

1. **新增 `motion`**：场景化「选动作 + 台词范例」。传 `model` + `exp`（或 `exp_base`）→ 返回该角色此表情下最常做的 top 动作（含 `_L/_C/_R` 朝向与 canon 次数，来自 `_演出动作谱.json` 的 `expMotion`）+ 同 model+exp 的真实台词范例（few-shot，来自 `_emotion_lines.jsonl`）+ 该表情的 valence/arousal（`emotion_polarity.json`）。闭合「设计对话场景 → 动作+台词」的最后一公里。
2. **补登 `action`**：v1.5 已把 Live2D 演出动作谱接进 MCP（`action`），但当时漏更新 README 工具表与 `_test-tools.mjs` 的计数清单——`tools/list` 实为 18 而文档/测试写 17，计数断言一度报红。本版一并校正。
3. **分工**：`action` 给某角色**全量**情绪→动作谱（表演风格评估，报告向）；`motion` 给**某一拍**的具体选配（场景创作向）。
4. **纪律同 `角色模型/设计思路`**：按上游 model 名寻址（里人格独立动作池）、`_L/_C/_R` 是朝向非情绪、小样本标「证据不足」、**证据非判断**（脚本只给 canon 做过什么，为什么这么配须人工写）。

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
- 未命中时给**最像的几个**候选 + 可用写法 + 乐队名提示（`Ave Mujica` → 成员名单），不再把 47 个人名整份倒出来
- 命中路径会回显在 `char._命中`（如 `全名(中文)` / `姓(中文)` / `舞台名`），便于排查

**测试**：`node mcp-canon/_test-names.mjs` —— 110 条名字形态 + **25 名乐队成员**全量（中文全名/日文全名/只写姓）
+ 工具端到端 + 歧义与未知名的如实回报，全部离线（不需要 Ollama）。

> **覆盖缺口（如实标注）**：名字回归只跑这 25 名乐队成员，后入册的 22 人（Sumimi 真奈 / 妖精花束薇欧拉 / 16 名主线 NPC）
> **不在回归里**。工具本身认全部 47 人（`stats` 名字索引：键 369 / 角色 47；分级 0_主键 → 3_子串兜底 + 手写昵称 4），
> 但"把 25 人扩到 47 人全量回归"仍是待办。

## v1.2 更新了什么

1. **改名**：服务端 `kb` → **`canon`**，目录 `mcp-kb/` → `mcp-canon/`，
   `kb-mcp-server.mjs` → `canon-mcp-server.mjs`，`kb-tools.mjs` → `canon-tools.mjs`；
   工具名去掉 `kb_` 前缀（品牌由 `mcp__canon__` 命名空间承担）。旧名仍可调用，见上文"迁移"。
   CLI 同步改名：`工具/kb.mjs` → **`工具/canon.mjs`**，命令与 MCP 工具一一对应。
2. **接管其余文本资产**：新增 `card`（当时 25 张 SillyTavern V2 卡，现 36 张）、`worldbook`（当时 49 词条，现 66 条）、
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

把**全 47 人**的 `quote_bank` 拆成 **1645 句**当"已知说话人"的测试句，看能否把真说话人排到 top-1 / top-3
（随机基线 **top1 2.1% / top3 6.4%**，而不是旧文档写的 4% / 12%）：

| 变体 | 样本 | top1 | top3 |
|---|---|---|---|
| v1.0 单句（旧打分器） | 1645 | 5.4% | 13.7% |
| v1.0 多句拼接（不拆句·旧工具遇到多句的真实行为） | 532 | 5.5% | 14.3% |
| **v1.1 单句·raw（当前默认）** | 1645 | 5.6% | 11.7% |
| v1.1 单句·rank | 1645 | 5.8% | 12.0% |
| v1.1 单句·z | 1645 | 4.3% | 9.2% |
| v1.1 3 句·聚合·raw | 532 | 10.7% | 19.5% |
| v1.1 3 句·聚合·rank | 532 | 12.2% | 24.4% |
| v1.1 3 句·聚合·z | 532 | 11.3% | 23.1% |
| v1.1 3 句·多数票·raw | 532 | 7.5% | 14.3% |
| v1.1 5 句·聚合·raw | 309 | 10.7% | 23.3% |
| **v1.1 5 句·聚合·rank** | 309 | **17.8%** | **29.1%** |
| v1.1 5 句·聚合·z | 309 | 13.3% | 28.2% |
| v1.1 5 句·多数票·raw | 309 | 6.5% | 14.2% |
| 随机基线 | — | 2.1% | 6.4% |

（表外还有 `无波浪号` 变体：单句 raw 6.0% / rank 6.1% / z 4.0%，与含波浪号同档，说明波浪号维度不主导结果。）

**结论**：
- **多句 > 单句**（调用方**至少给 3 句**）：单句 4~6%，3 句聚合 ~11%，5 句聚合 ~11~18%——句数是最强的杠杆。
- **特征聚合 > 逐句多数票**，五种口径无一例外（3 句档 10.7% vs 7.5%；5 句档 10.7% vs 6.5%）。
- **新打分器 > 旧打分器**："多句当一句"的 v1.0 只剩 5.5%（与单句同档，因为它把整段当一个超长句），
  v1.1 拆句聚合后同批样本上到 10.7%。
- 三种口径 **仍未达显著区分**：单句档三者打平（5.6 / 5.8 / 4.3，n=1645，SE≈0.6pp）；
  3 句与 5 句档 `rank` 都更高，但差距只有 **1.6~1.9 个标准误**（n=532 / 309，SE≈1.3 / 1.8pp），
  在噪声边缘。**所以默认仍是 `raw`**——这是同源 in-sample 检验，换口径等于"在同一份有偏样本上调参"，
  风险大于收益。想要更高召回得换一份**独立**测试集再调。
- 逐维度消融（`--ablate`）显示只有「省略号率」「感叹结尾」有稳定正贡献，其余维度加入与否在噪声内。
- 最难认的 6 人（该变体 top1 = 0%）：爱音 / 爽世 / 祥子 / 睦 / 海铃 / 若麦——她们的语言指纹在语料里互相最像。

**口径声明（别拿这张表当"真人盲测水平"）**：① 同源检验，绝对值偏高；
② 测试句来自 `quote_bank`，而它不是随机抽样（见下节），分布比语料"平"，绝对值又被压低；
③ 标准误：单句 ≈0.6pp、3 句 ≈1.3pp、5 句 ≈1.8pp（n=1645 / 532 / 309）——表里 ±1pp 的差异基本都在噪声内。
它唯一成立的作用是**同一批样本下比较变体**。

## 台词库抽样偏差（`stats` · 值得先知道的坑）

`quote_bank` 是**人工精选**台词，不是随机抽样——它与 `speech` 里登记的语料指标**系统性打架**：
**全 47 人里 12 人 / 12 条**指标明显偏差（`stats` 的「台词库抽样偏差」逐人列出）：

| 例子 | 语料登记 | 台词库实测 | 差 |
|---|---|---|---|
| 茉幌 · 省略号率 | 42.4% | 17.0% | **-25.4** |
| 爽世 · 省略号率 | 42.3% | 21.6% | **-20.7** |
| 定治 · ≤6字占比 | 5.3% | 23.5% | **+18.2**（反向） |
| 律 · ≤6字占比 | 49.8% | 32.4% | **-17.4** |
| 小春 · ≤6字占比 | 42.6% | 58.3% | **+15.7**（反向） |
| 宁月的管家婆婆 · 句长均值 | 11.5 | 18.5 | **+7.0** |

方向不是单一的：既有"比语料干净"（省略号被抹掉、短句占比被压），
也有反过来"比语料更有戏"的（定治、小春的 ≤6字占比被抬高）。

**后果**：拿 `quote_bank`（或用 `sample` 抽的台词）当"风格范本"、出盲测题，会继承这个偏移；
`who` 的回测也在它上面跑，所以上表的绝对值不可外推。这是**偏差而非数据错误**（精选本就偏向"有戏"的句子），
但用它之前得知道。逐人数据在 `stats` 的「台词库抽样偏差」。

> **口径变更提示**：横比分母现在是**全 47 人名册**。旧文档写的"25 人 42 条"是按 25 名乐队成员统计的，
> 与"47 人 12 条"**不可直接比**（分母与阈值都不同）。引用时请带上分母。

## 手动启动 / 测试

```bash
# 工具层冒烟：19 个工具 + 断言全跑（不需要 spawn）
node mcp-canon/_test-tools.mjs

# 中日姓名索引回归（110 条名字形态 + 25 名乐队成员全量，纯离线）
node mcp-canon/_test-names.mjs

# 打分器回测（--ablate 逐维度消融；--json 机器可读）
node mcp-canon/_bench-who.mjs [--ablate] [--json]

# 逻辑自检一行（供脚本兜底）
node mcp-canon/_selfcheck.mjs

# HTTP 传输冒烟：进程内起服务器 + 真实 fetch，28 项断言（不需要 spawn；随机端口）
node mcp-canon/_test-http.mjs

# 起 HTTP 服务后可直接 curl / PowerShell 打（都不是 MCP 协议的一部分，只是顺手）
#   GET  /health                          → {ok,server,tools,...}
#   GET  /tools                           → 19 个工具的 schema
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
- **单句猜人不可当真**：回测单句 top1 仅约 5~6%（随机基线 2.1%）；给 ≥3 句才有实用价值（3 句 ~11%、5 句 ~11~18%），且始终只是"偏差分排序"而非结论
- **`quote_bank` 有抽样偏差**（见上节）
- **数据缺口**（`stats` 会逐人列出）：**12 人各缺 `歌词均长` 1 项**——乐奈、宁月、诗船、凛凛子、定治、波波、蓓儿、小萤、柚衣奈、心玖的母亲、枫、宁月的管家婆婆（没有歌词类语料，属数据事实，不是漏统计）；
  `台词偏少` 当前**为空**（最少的是 13 句：真奈 / 诗船 / 歌美），即没有角色的台词库低于 10 条
- **Ollama 是推荐项**：不可用时语义检索禁用、纯词汇可用；不要把它写成硬依赖
- MCP stdio 由 DSH 的加载器拉起；本工作区沙箱内 **node spawn 子进程受 EPERM 限制**（已文档化的边界），
  测试请走 `_test-tools.mjs` / PowerShell 管道 / **`_test-http.mjs`（进程内起服务，完全不用 spawn）**；
  `_test-client.mjs` 在本沙箱会报 `spawn EPERM`，属预期
- **HTTP 不是常驻服务**：`canon-mcp-http.mjs` 是随用随起的进程；没起服务时按 URL 注册的 MCP 条目会连不上
  （stdio 由宿主 spawn，没有这个前置条件）——这也是默认仍用 stdio 注册的原因
- 服务端收到 stdin EOF 后**不强制退出**，等在途异步请求（Ollama 检索）回完再自然退出；HTTP 端同理，
  Ctrl+C 只 `server.close()`——别改成 `process.exit()`：Windows 上会在句柄关闭途中触发 libuv 断言
