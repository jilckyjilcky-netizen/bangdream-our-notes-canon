# Live2D 演出编排器 · 流程设计

> **目标**：输入一个**设计好的对话场景**，输出一串 **〔Live2D 动作 + 台词〕对**。
> 动作从 canon 演出证据里**检索**，不凭空生成；台词受角色说话指纹**约束**；语义判断留给**人**。
>
> 本文只梳理**流程与数据契约**——把已有零件指清楚、定义唯一要新写的编排器。不写生成器代码。
> 现状盘点日：2026-10-13。所有"已有"均指读过真源文件，非声称。

---

## 0. 一句话定位与核心分工

把「设计对话场景」变成「可播的 Live2D 演出小段」。三件事分开，别混：

| 环节 | 性质 | 谁来做 |
|---|---|---|
| **选动作（mtn_*）** | **检索**，确定性 | 脚本查 canon 证据表，不用 AI |
| **写台词** | **受约束的写作** | LLM 写，但被说话指纹 + 语料 few-shot 框住 |
| **为什么这么配** | **判断** | 人（脚本不代笔语义，见 §5 纪律一） |

关键认知：用户说"选动作表现情绪"——**选动作本质是查表，不是创作**。canon 已经有 31,505 条演出指令告诉我们"这个角色在这个表情下最常做什么动作"，编排器只是查这张表。

---

## 1. 总流程

```
┌─ 用户/策划输入 ─────────────────────────────┐
│  角色(model) + 这一幕想表达的情绪 + 处境/潜台词 │
└───────────────────┬────────────────────────┘
                    ▼  Stage 1 · 定调
        目标 exp 标签（+ valence/arousal 校验）
                    ▼  Stage 2 · 选动作（检索，确定性）
        该 model 在该 exp 下的 top mtn（含 _L/_C/_R 朝向）
                    ▼  Stage 3 · 写台词（LLM，受约束）
        符合该角色说话指纹的一句台词（few-shot 自语料库检索）
                    ▼  Stage 4 · 组装
   〔exp, mtn, 台词〕× N  →  分镜表 / 喂 Live2D 运行时
```

---

## 2. 已有零件（直接复用，别重造）

> 这是本文最实用的部分：**要做的工具 80% 是接线，不是新算法。**

| 层 | 资产（路径） | 入口 / 生成器 | 数据契约 | 备注 |
|---|---|---|---|---|
| 逐句语料库 | `资料库/_emotion_lines.jsonl` | `工具/情绪标签.mjs` | 每行 `{advId, seq, row, model, exp, mot, text}` | **既是动作查表的底，也是台词 few-shot 库**；text 是日文原文 |
| exp→动作查表 | `角色模型/设计思路/_演出动作谱.json` | `工具/抽取_演出动作谱.py` | `byModel[model].expMotion[exp] → {mtn_*: count}` | 31,505 条有效演出 / 62 model；按上游 model 名归并 |
| 情绪效价 | `剧情分析/_data/emotion_polarity.json` | 人工维护 | `polarity[base] → {valence, arousal, conf}` | 51 exp 词根；把"想表达的情绪"换成具体 exp 的依据 |
| 标志性动作 | `资料库/_motion_profile.json` | `工具/build_motion_profile.mjs` | `characters[].lifts[] → {base, lift}` | lift = 角色占比÷全局占比；破同质化用（见 §4） |
| 说话指纹 | `风格档案/*.md` | `工具/build_style_profile.mjs` | 各乐队均长/语气词率/省略号率/均效价… | 约束台词"像不像这个角色" |
| 对话模式×动作 | `角色模型/设计思路/_对话模式动作谱.json` | `工具/抽取_对话模式动作谱.py` | 句式→动作 | ⚠️ **薄**（MasterTalk 每角色约 23 条，启发式非 canon），只作弱参考 |

**三条最关键的既有资产**（编排器的主干就靠它们）：

1. `_emotion_lines.jsonl` —— 唯一带**台词原文**的逐句语料。few-shot 检索、验证"这句配这个动作 canon 里有没有先例"都靠它。
2. `_演出动作谱.json` 的 `expMotion` —— 情绪→动作的**查表主入口**。
3. `emotion_polarity.json` —— 情绪**定调**的依据（valence 正负 / arousal 强度）。

---

## 3. 四个阶段详解

### Stage 1 · 定调：想要的情绪 → exp 标签

- **输入**：场景想表达的情绪（自然语言，如"想安慰但说不出口的窘迫"）+ 角色 model。
- **动作**：查 `emotion_polarity.json`，按目标 valence / arousal 圈定候选 base（如 valence≈+0.2 / arousal≈1 → `shy`/`smirk` 一族）。
- **输出**：一个**具体的编号 exp**（`exp_shy01`，不是 base `shy`）。
- ⚠️ **base→编号要落地**：emotion_polarity 的键是 base（`sad`），expMotion 的键是带编号的（`exp_sad01/02/03`）。必须先看这个 model 的 `expMotion` **实际有哪些编号 exp**，再挑——不能假设每个角色都有全套 sad 变体（要乐奈基本只有 `idle/smile/kime`，见 `_演出动作谱.md`）。

### Stage 2 · 选动作：exp + model → mtn（确定性查表）✅ 已落地为 MCP 工具 `motion`

- **输入**：model + 具体 exp（Stage 1 产出）。
- **动作**：读 `_演出动作谱.json` → `byModel[model].expMotion[exp]`，按 count 取 top，再叠加两个修正：
  - **富集度去同质化**：若 top 动作对该角色 lift 低（`_motion_profile.json`）、对全局是烂大街款，可下调，改取该角色 lift 高的词根（她的"标志性动作"）。
  - **朝向 `_L/_C/_R`**：是**角色面向镜头的方向，不是情绪**（`build_motion_profile.mjs` 明释）。默认沿用 canon 高频朝向；角色同场多人时用朝向错开，避免全挤中间。
- **输出**：一个具体 mtn（`mtn_nervous01_L`）+ 选择理由（引用 canon 次数）。
- ⚠️ **小样本模型要降权**：`doloris`(29 行)/`timoris`(22)/`amoris`(35)/`oblivionis`(34) 这些人格里人格，expMotion 格子极稀，top1 可能只有 ×2，**不足以当定式**，应回退到本体 model 或标注"证据不足"。

### Stage 3 · 写台词：model + 情绪 + 处境 → 一句台词

- **输入**：model + exp + 处境/潜台词 + 这句想承载的内容。
- **约束**（缺一不可）：
  1. **说话指纹**：从 `风格档案/` 取该角色的句长/语气词率/省略号率，长句角色别写成短句小子。
  2. **few-shot 检索**：从 `_emotion_lines.jsonl` 捞该 model 在同 exp 下的真实台词（`text` 字段）当范例，压住 LLM 的串味与翻译腔。
  3. **分层纪律**：台词是**表层**，不等于设定事实；若这幕涉及"对好的口径/安抚的谎言层"，按项目既有分层处理，别把台词当真相写进证据。
- **输出**：一句（或一组）台词。
- ⚠️ 这是全流程**唯一需要 LLM 的一步**；前三步都可以不联网跑完。

### Stage 4 · 组装输出

- 产出 `〔exp, mtn, 台词〕` 序列。可选附：valence/arousal（供后面接情绪曲线校验）、canon 依据次数、few-shot 来源 advId。
- 消费方：分镜表 / 自写 web Live2D（VTube Studio / pixi-live2d 都吃 motion 名） / 后续若要做口型，再把 text 送 TTS。

---

## 4. 演出编排器（orchestrator）——Stage 2 已落地，剩 Stage 1→3 胶水

**Stage 2（选动作）已经作为 MCP 工具 `motion` 落地**（v1.6，见 §6）——模型连上 canon 服务就能在工具列表里发现并调用它，不用再写。剩下的胶水是 **Stage 1（定调）与 Stage 3（写台词）的编排**：把 `motion` 的返回喂给 LLM，照它给的台词范例 + 风格档案指纹写出正式那句。若要包成一个上层编排器，建议落 `工具/`（如 `编排_台词动作.mjs`），遵守项目脚本规矩：只读语义 json 绝不写、幂等、`--dry`、数字全部从被测数据抽不手抄。

**输入契约**（一个场景，JSON 或交互填）：

```jsonc
{
  "model": "uika",                 // 必填，上游 model 名，不是中文名
  "intent": "被打动但死不承认",      // 想表达的情绪/潜台词
  "valence": 0.2, "arousal": 1,    // 可选，覆盖自动定调
  "context": "对方递过来创可贴",     // 处境，供写台词
  "n": 3                            // 要几拍
}
```

**输出契约**（每拍一对）：

```jsonc
{
  "model": "uika",
  "beat": [
    { "exp": "exp_shy01", "mot": "mtn_nod02_C",
      "line": "……谁、谁要那个啊",
      "why": "canon exp_shy01 下 nod02 系高频；朝向 C 避开同伴",
      "fewshot_advId": [10086, 10120] }
  ]
}
```

**伪代码**：

```
for i in 1..n:
  exp   = pickExp(model, intent, valence, arousal)   // Stage1，查 emotion_polarity + 该 model 可用 exp
  mot   = pickMotion(model, exp)                       // Stage2，查 expMotion top，叠 lift 去同质、避朝向
  line  = writeLine(model, exp, context, fewshot)      // Stage3，LLM + 风格档案约束 + 语料检索
  emit {exp, mot, line, why, fewshot_advId}
```

---

## 5. 三条不可越界的纪律

1. **证据 vs 判断**：编排器只吐"canon 里这个角色在这个情绪下做过什么"（证据）；"为什么这么配、这幕该不该这么演"是判断，留给人。这条直接继承 `_演出动作谱.md` 的定位——本工具是**检索器**，不是**创作者**。数字/动作删掉后若判断垮了，说明在拿证据硬撑结论，重写。
2. **按 model 名寻址，不按叙事身份**：`mutsumi`/`mortis`、`uika`/`doloris`、`umiri`/`timoris`、`nyamu`/`amoris`、`sakiko`/`oblivionis` 都是**不同 model、不同动作池**。给 Mortis 配动作必须查 `mortis` 的 expMotion，套 `mutsumi` 的必然写飘（与项目 OOC 禁令"第三人称小睦=〔原文略〕"同源的坑）。
3. **薄数据必须标注**：`_对话模式动作谱`（MasterTalk 23 条/角色、启发式）和四人格里人格的 expMotion 都是**弱证据**，输出里要带"证据不足"标记，别当成定式用。

---

## 6. 已落地：Stage 2 = MCP 工具 `motion`（v1.6，2026-10-13）

原本的 MVP（打通 Stage 2 纯查表）**已经做完并接进 MCP**——模型连上 canon 服务就能在工具列表里发现它、调用它。

**工具契约**：

| 工具 | 输入 | 输出 |
|---|---|---|
| `motion` | `model`（或 `name`）+ `exp` / `exp_base`，可选 `top`/`lines` | 该角色此 exp 下 top 动作（含 `_L/_C/_R` 朝向 + canon 次数 + share）+ 同 model+exp 真实台词范例（few-shot，带 advId + 是否配到推荐动作）+ valence/arousal |
| `action` | `model`/`name`，可选 `top` | 某角色**全量**情绪→动作谱（报告向，与 `motion` 互补） |

真实样例（`motion{model:"uika", exp_base:"sad"}`）：
- 动作：`mtn_sad01_L`×10 / `mtn_sad01_R`×9 / `mtn_thinking01_L`×8 / `mtn_thinking01_R`×7 / `mtn_sad01_C`×7（exp_sad01，valence −0.7 / arousal 2，共 90 条演出）
- 台词范例：`うん……`（advId 10022，配 `mtn_thinking01_L`）、`……！`（10022，配 `mtn_sad01_R`）、`……昔から、か`（10023）——均标注是否配到推荐动作。

**给模型的用法**：设计某一拍时，先 `motion` 拿动作 + 台词范例，再让 LLM 照范例的语气 + 风格档案指纹写正式台词。动作和范例都是 canon 证据；写出的台词仍受 Stage 3 三层约束（说话指纹 / few-shot / 分层纪律）。

⚠️ **改代码后模型不会自动看到新工具**：stdio 注册的要 `mcp_manager_restart` 重载；HTTP 传输（`canon-mcp-http.mjs`）要重启进程。重启后 `tools/list` 才会播报 19 个工具（含 `motion`）。测试：`node mcp-canon/_test-tools.mjs`（工具层冒烟，含 motion 正/负向断言）。

---

## 附：寻址速查（model → 角色，均待人工终校）

`tomori`高松灯 · `anon`千早爱音 · `rana`要乐奈 · `soyo`长崎爽世 · `taki`椎名立希 ·
`uika`三角初华 · `mutsumi`若叶睦 · `sakiko`丰川祥子 · `umiri`八幡海铃 · `nyamu`祐天寺若麦 ·
`hatsune`三角初音（**与 uika 是两个人**）· `doloris`/`mortis`/`timoris`/`amoris`/`oblivionis` 为里人格。
