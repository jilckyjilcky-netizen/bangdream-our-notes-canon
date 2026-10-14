#!/usr/bin/env node
/**
 * 情绪标签.mjs —— 从上游 Episode.json 抽取 Live2D 演出标签，逐句对齐台词。
 *
 * 数据来源（客观数据，非人工标注）：
 *   <上游域已移除>/{lang}/Adv/Episode/{script}/{script}-Episode/...-Episode.json
 *   → _allData[] 中 `_command === 21` 的行为演出指令，携带
 *     _targetName（角色模型名）/ _expressionName（表情 exp_*）/ _motionName（动作 mtn_*）
 *   它与台词行 `_command === 2` 近乎 1:1 伴生，故可逐句回溯出官方情绪标签。
 *
 * 产物：
 *   资料库/_emotion_lines.jsonl        逐句标签（advId / 行序 / 模型名 / 表情 / 动作 / 台词原文）
 *   资料库/_emotion_vocab.json         表情与动作词表（含计数与中文名，中文名标注置信度）
 *   资料库/_emotion_fingerprint.json   每个角色的「演出指纹」统计
 *   角色模型/_演出指纹.md               由上面那份 json 生成的报告（数字全部脚本注入，不手抄）
 *
 * 用法：
 *   node 工具/情绪标签.mjs                 全量跑（946 剧本，联网抓 Episode+Text 并缓存）
 *   node 工具/情绪标签.mjs --limit 20      只跑前 20 个（调试）
 *   node 工具/情绪标签.mjs --check         不联网，只校验已有产物自洽
 *   node 工具/情绪标签.mjs --only mygo     只跑剧本名含该关键字的
 *   node 工具/情绪标签.mjs --concurrency 6 --lang ja
 *
 * 缓存：落在 .cache/script/{lang}/（与 素材提取/lib.mjs 同一套路径，可被原提取器复用）。
 */
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ASSETS, CACHE, LANG_FIELD, plainRichText, tableUrl } from "./素材提取/lib.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const LINES_OUT = path.join(ROOT, "资料库/_emotion_lines.jsonl");
const VOCAB_OUT = path.join(ROOT, "资料库/_emotion_vocab.json");
const FP_OUT = path.join(ROOT, "资料库/_emotion_fingerprint.json");
const REPORT_OUT = path.join(ROOT, "角色模型/_演出指纹.md");

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return argv.includes(`--${name}`) ? true : dflt;
};
const LIMIT = Number(argOf("limit", 0)) || 0;
const ONLY = argOf("only", "");
const CONC = Number(argOf("concurrency", 6));
const LANG = argOf("lang", "ja");
const CHECK = argv.includes("--check");
const FRESH = argv.includes("--fresh"); // 忽略本地缓存，强制重抓

// ---------- 取数 ----------
async function getJson(url, { retries = 4 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
      if (res.ok) return await res.json();
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status}`);
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, attempt * 500));
  }
  throw lastError;
}

async function pool(items, size, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(size, items.length) || 1 }, async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** 抓一份剧本的 Episode + Text，落 .cache/script/{lang}/。 */
async function fetchScript(script, lang) {
  const dir = path.join(CACHE, "script", lang);
  await mkdir(dir, { recursive: true });
  const epFile = path.join(dir, `${script}-Episode.json`);
  const txFile = path.join(dir, `${script}-Text.json`);
  if (!FRESH && existsSync(epFile) && existsSync(txFile)) {
    return { episode: JSON.parse(await readFile(epFile, "utf8")), text: JSON.parse(await readFile(txFile, "utf8")) };
  }
  const [episode, text] = await Promise.all([
    getJson(tableUrl(script, "Episode", lang)),
    getJson(tableUrl(script, "Text", lang)),
  ]);
  await writeFile(epFile, JSON.stringify(episode));
  await writeFile(txFile, JSON.stringify(text));
  return { episode, text };
}

// ---------- 角色模型名 → 角色身份 ----------
/**
 * 上游模型名与项目在册名单的拼写并不一致（例：蕾叶的祖母 upstream 叫 raikagrandmother，
 * 本项目 kb 里叫 baachan）。这张表只做**拼写归一**，不新增角色。
 */
const MODEL_ALIAS = {
  raikagrandmother: "baachan",
  mikumother: "mikumom",
  bota: "pota",
  bell: "belle",
  kiyotsugu: "seikoku",
  hotaru_child: "kohotaru",
  mutsumi_maybe: "mutsumi",
  hatsune_maybe: "hatsune",
  grandma: "baachan",
};

async function buildIdentity() {
  const kb = JSON.parse(await readFile(path.join(ROOT, "资料库/kb.json"), "utf8"));
  const map = new Map();
  const put = (model, cid, zh, short) => { if (model) map.set(String(model).toLowerCase(), { cid, zh, short }); };
  for (const x of kb.characters ?? []) {
    put(x.id, x.id, x.name_short || x.id, x.name_short || null);
    if (x.stage) put(x.stage, x.id, x.name_short || x.id, x.name_short || null);
  }
  for (const [from, to] of Object.entries(MODEL_ALIAS)) {
    const hit = (kb.characters ?? []).find((x) => x.id === to);
    if (hit) put(from, to, hit.name_short || to, hit.name_short || null);
  }
  return map;
}

async function buildModelMap() {
  const chRaw = JSON.parse(await readFile(path.join(ROOT, "masterdata/master/MasterCharacter.json"), "utf8"));
  const txRaw = JSON.parse(await readFile(path.join(ROOT, "masterdata/master/MasterText.json"), "utf8"));
  const text = new Map(Object.values(txRaw._allData ?? txRaw).map((r) => [String(r._id), r]));
  const map = new Map();
  for (const r of Object.values(chRaw._allData ?? chRaw)) {
    const full = text.get(String(r._nameTextID)) || {};
    const short = text.get(String(r._shortNameTextID)) || {};
    const rec = {
      zh: full._simplifiedChinese || "",
      short: short._simplifiedChinese || "",
      bandId: r._bandID ?? null,
    };
    for (const seg of String(r._nameTextID).replace(/^Character_Name_/, "").toLowerCase().split("_")) {
      if (seg) map.set(seg, rec);
    }
    const s = String(r._shortNameTextID).replace(/^Character_Short_Name_/, "").toLowerCase();
    if (s) map.set(s, rec);
  }
  return map;
}

// ---------- 解析 ----------
/**
 * 一次遍历：cmd21 记下该角色最近的表情/动作，cmd2（台词）回溯它。
 * 注意：_expressionName 存在极少量脏数据（被填成 mtn_*），用前缀过滤。
 */
function parseEpisode(episodeRows, textRows, lang) {
  const field = LANG_FIELD[lang];
  const textOf = (id) => {
    const row = textRows.get(String(id));
    return row ? plainRichText(row[`_${field}`]).trim() : "";
  };
  const last = new Map();
  const lines = [];
  let seq = 0;
  let dropped = 0;
  for (const r of episodeRows) {
    if (r._command === 21) {
      const t = (r._targetName || "").trim();
      if (!t) continue;
      const exp = /^exp_/.test((r._expressionName || "").trim()) ? r._expressionName.trim() : "";
      const mot = /^mtn_/.test((r._motionName || "").trim()) ? r._motionName.trim() : "";
      if (!exp && !mot) continue;
      last.set(t, { exp, mot });
    } else if (r._command === 2) {
      const text = textOf(r._advTextID);
      if (!text) { dropped += 1; continue; }
      const raw = (r._targetName || "").trim();
      const model = raw ? raw.split("・")[0] : "";
      const hit = model ? last.get(model) : undefined;
      seq += 1;
      lines.push({
        seq,
        row: r._index,
        model: model || null,
        exp: hit?.exp || null,
        mot: hit?.mot || null,
        text,
      });
    }
  }
  return { lines, dropped };
}

// ---------- 中文名（人工维护，标注置信度；不要拿它当上游数据） ----------
const EXP_ZH = {
  idle: ["平静（无表情）", "high"],
  smile: ["微笑", "high"],
  bsmile: ["营业笑（存疑，待确认）", "unknown"],
  sad: ["悲伤", "high"],
  angry: ["生气", "high"],
  surprised: ["惊讶", "high"],
  serious: ["严肃", "high"],
  thinking: ["思考", "high"],
  question: ["疑问", "high"],
  shy: ["害羞", "high"],
  panic: ["慌张", "high"],
  puzzled: ["困惑", "high"],
  pale: ["苍白（血色尽失）", "high"],
  cry: ["哭泣", "high"],
  heart: ["心动（爱心眼）", "high"],
  sing: ["歌唱", "high"],
  cheer: ["欢呼", "high"],
  amazed: ["惊叹", "high"],
  sneer: ["冷笑 / 讥诮", "high"],
  smirk: ["坏笑 / 得意一笑", "high"],
  wink: ["眨眼", "high"],
  trouble: ["困扰 / 为难", "high"],
  despair: ["绝望", "high"],
  close: ["闭眼", "mid"],
  sleep: ["困倦", "mid"],
  normal: ["平常", "high"],
  dislike: ["厌恶", "high"],
  dispair: ["绝望（原词 dispair）", "mid"],
  upset: ["沮丧 / 失落", "high"],
  shadow: ["阴沉（打影）", "high"],
  kirakira: ["闪闪发亮（キラキラ）", "high"],
  jitome: ["じと目（无语 / 睥睨）", "mid"],
  kime: ["キメ顔（认真 / 决意）", "mid"],
  kusogaki: ["クソガキ（得意臭屁）", "mid"],
  dispase: ["不悦（原词 dispase，疑为 displease）", "mid"],
  sdeprecate: ["自嘲（推测，待确认）", "unknown"],
  salk: ["（含义不明，待确认）", "unknown"],
  anxiety: ["焦虑 / 不安", "high"],
  tired: ["疲倦", "high"],
  trance: ["恍惚 / 出神", "mid"],
  envy: ["嫉妒", "high"],
  nohighlight: ["去高光（暗淡）", "mid"],
  pain: ["痛苦", "high"],
  absent: ["失神 / 茫然", "mid"],
  shock: ["震惊", "high"],
  gaze: ["凝视", "high"],
  mad: ["狂乱", "mid"],
  motivation: ["燃起干劲", "mid"],
  doya: ["ドヤ顔（得意炫耀）", "mid"],
  hatred: ["憎恶", "high"],
  special: ["特殊用途（含义不明）", "unknown"],
  unique: ["特殊用途（含义不明）", "unknown"],
  grinning: ["咧嘴笑", "high"],
  smilk: ["（疑为 smile 拼写变体，待确认）", "unknown"],
  shadows: ["阴沉", "mid"],
  suprised: ["惊讶（原词拼写 suprised）", "high"],
  spin: ["旋转 / 转圈", "mid"],
};
const MTN_ZH = {
  idle: ["待机", "high"],
  nod: ["点头", "high"],
  denial: ["摇头（否认）", "high"],
  smile: ["笑", "high"],
  sad: ["难过", "high"],
  serious: ["严肃", "high"],
  check: ["看向 / 确认", "high"],
  thinking: ["思考", "high"],
  question: ["疑问", "high"],
  surprised: ["惊讶", "high"],
  panic: ["慌张", "high"],
  angry: ["生气", "high"],
  shy: ["害羞", "high"],
  cheer: ["欢呼", "high"],
  kime: ["キメ（决意）", "mid"],
  laugh: ["笑出声", "high"],
  bow: ["鞠躬", "high"],
  run: ["跑", "high"],
  walk: ["走", "high"],
  turn: ["转身", "high"],
  look: ["张望", "high"],
  sing: ["歌唱", "high"],
  cry: ["哭", "high"],
  down: ["垂头", "mid"],
  up: ["抬头", "mid"],
  nervous: ["紧张 / 局促", "high"],
  bye: ["挥手告别", "high"],
  habit: ["习惯性小动作（具体不明）", "mid"],
  note: ["笔记 / 书写（推测）", "unknown"],
  maskoff: ["摘下面具", "high"],
  spray: ["喷雾（推测）", "unknown"],
  jitabata: ["じたばた（手忙脚乱）", "high"],
  confrict: ["冲突（原词 confrict，疑 conflict）", "mid"],
  join: ["加入 / 入场", "mid"],
  scream: ["尖叫", "high"],
  haruhikage: ["春日影（专有，晴影）", "mid"],
  mal_cry: ["（含义不明，待确认）", "unknown"],
  rook: ["（含义不明，待确认）", "unknown"],
  sneer: ["冷笑", "high"],
  spin: ["旋转 / 转圈", "mid"],
  wink: ["眨眼", "high"],
};
/**
 * exp_smile01 → smile；mtn_nod02_C → nod。
 * ⚠️ 顺序要紧：必须先剥 _L/_C/_R 站位后缀，再剥末尾编号 ——
 *    反了的话 `mtn_check01_L` 会留下尾号变成 `check01`，查不到词根。
 */
const baseOf = (tag) => String(tag).replace(/^exp_|^mtn_/, "").replace(/_(L|C|R)$/i, "").replace(/[0-9]+$/, "").toLowerCase();
const SUFFIX_POS = { L: "左", C: "中", R: "右" };

// ---------- 主流程 ----------
async function main() {
  const advRaw = JSON.parse(await readFile(path.join(ROOT, "masterdata/master/MasterAdv.json"), "utf8"));
  let rows = Object.values(advRaw._allData ?? advRaw)
    .map((r) => ({ advId: Number(r._id), script: String(r._advEpisodeAsset || "").trim() }))
    .filter((r) => r.script)
    .sort((a, b) => a.advId - b.advId);
  if (ONLY) rows = rows.filter((r) => r.script.includes(ONLY));
  if (LIMIT) rows = rows.slice(0, LIMIT);

  console.log(`目标 ${rows.length} 个剧本（lang=${LANG}, 并发=${CONC}）`);

  const ident = await buildIdentity();

  let done = 0;
  let failed = 0;
  const failures = [];
  const perScript = []; // {advId, script, lines}

  await pool(rows, CONC, async (r) => {
    try {
      const { episode, text } = await fetchScript(r.script, LANG);
      const epRows = episode._allData ?? [];
      const txRows = new Map(Object.values(text._allData ?? text).map((x) => [String(x._id), x]));
      const { lines } = parseEpisode(epRows, txRows, LANG);
      perScript.push({ advId: r.advId, script: r.script, lines });
    } catch (error) {
      failed += 1;
      failures.push(`${r.advId}/${r.script}: ${error.message}`);
    }
    done += 1;
    if (done % 25 === 0 || done === rows.length) process.stdout.write(`  抓取 ${done}/${rows.length}（失败 ${failed}）\n`);
  });

  perScript.sort((a, b) => a.advId - b.advId);

  // ---- 汇总 ----
  const expCount = new Map();
  const motCount = new Map();
  const modelStat = new Map(); // 上游模型名 → 统计（保留原始名，供 join jsonl）
  const charStat = new Map();  // 角色身份 → 统计（同角色的多个模型名合并）
  const cidOf = (model) => ident.get(String(model).toLowerCase())?.cid || `raw:${model}`;
  let total = 0;
  let tagged = 0;
  let narration = 0;

  const chunks = [];
  for (const s of perScript) {
    for (const l of s.lines) {
      total += 1;
      if (!l.model) narration += 1;
      if (l.exp) { tagged += 1; expCount.set(l.exp, (expCount.get(l.exp) || 0) + 1); }
      if (l.mot) motCount.set(l.mot, (motCount.get(l.mot) || 0) + 1);
      if (l.model) {
        const bump = (map, key) => {
          let st = map.get(key);
          if (!st) { st = { n: 0, tagged: 0, exp: new Map(), mot: new Map(), models: new Set() }; map.set(key, st); }
          st.n += 1;
          if (l.exp) { st.tagged += 1; st.exp.set(l.exp, (st.exp.get(l.exp) || 0) + 1); }
          if (l.mot) st.mot.set(l.mot, (st.mot.get(l.mot) || 0) + 1);
          return st;
        };
        bump(modelStat, l.model);
        bump(charStat, cidOf(l.model)).models.add(l.model);
      }
      chunks.push(JSON.stringify({ advId: s.advId, seq: l.seq, row: l.row, model: l.model, exp: l.exp, mot: l.mot, text: l.text }) + "\n");
    }
  }

  await writeFile(LINES_OUT, chunks.join(""), "utf8");

  const vocab = (map, zhTable) => {
    const out = {};
    for (const [k, v] of [...map].sort((a, b) => b[1] - a[1])) {
      const base = baseOf(k);
      const [zh, conf] = zhTable[base] || ["（未收录）", "unknown"];
      const pos = /_(L|C|R)$/.exec(k);
      out[k] = { n: v, base, zh, conf, pos: pos ? SUFFIX_POS[pos[1]] : null };
    }
    return out;
  };

  const modelsOut = {};
  for (const [k, st] of [...modelStat].sort((a, b) => b[1].n - a[1].n)) {
    const hit = ident.get(String(k).toLowerCase());
    modelsOut[k] = {
      n: st.n,
      cid: hit?.cid || `raw:${k}`,
      zh: hit?.zh || null,
      short: hit?.short || null,
    };
  }

  const vocabJson = {
    _generated: new Date().toISOString(),
    _source: "<上游域已移除> Episode.json _command=21（_expressionName / _motionName）",
    _note: "exp/mtn 是上游官方标签名，零主观；中文名是人工补的，conf 字段标置信度（high/mid/unknown），unknown 别当结论用。",
    _scale: {
      scripts: perScript.length,
      scriptsFailed: failed,
      lines: total,
      narration,
      tagged,
      taggedRateOfSpoken: +(tagged / Math.max(1, total - narration)).toFixed(4),
      expKinds: expCount.size,
      motKinds: motCount.size,
      models: modelStat.size,
      characters: charStat.size,
    },
    exp: vocab(expCount, EXP_ZH),
    mtn: vocab(motCount, MTN_ZH),
    models: modelsOut,
  };
  await writeFile(VOCAB_OUT, JSON.stringify(vocabJson, null, 2), "utf8");

  const fp = {
    _generated: vocabJson._generated,
    _source: vocabJson._source,
    characters: {},
  };
  for (const [k, st] of [...charStat].sort((a, b) => b[1].n - a[1].n)) {
    const m = ident.get(String([...st.models][0] || "").toLowerCase());
    const top = (mm, n) => [...mm].sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([name, c]) => ({ name, n: c, pct: +((c / Math.max(1, st.tagged)) * 100).toFixed(1) }));
    fp.characters[k] = {
      zh: m?.zh || null,
      short: m?.short || null,
      models: [...st.models].sort(),
      lines: st.n,
      tagged: st.tagged,
      tagRate: +((st.tagged / Math.max(1, st.n)) * 100).toFixed(1),
      expKinds: st.exp.size,
      motKinds: st.mot.size,
      topExp: top(st.exp, 8),
      topMot: top(st.mot, 5),
    };
  }
  await writeFile(FP_OUT, JSON.stringify(fp, null, 2), "utf8");

  await writeFile(REPORT_OUT, renderReport(vocabJson, fp), "utf8");

  const size = (await stat(LINES_OUT)).size;
  console.log(`\n完成：剧本 ${perScript.length}（失败 ${failed}）｜台词行 ${total}｜旁白 ${narration}｜带标签 ${tagged}`);
  console.log(`配对率（去旁白）：${(vocabJson._scale.taggedRateOfSpoken * 100).toFixed(1)}%`);
  console.log(`表情 ${expCount.size} 种｜动作 ${motCount.size} 种｜角色模型 ${modelStat.size} 个`);
  console.log(`产物：${LINES_OUT} (${(size / 1048576).toFixed(1)} MB) / _emotion_vocab.json / _emotion_fingerprint.json / 角色模型/_演出指纹.md`);
  if (failures.length) console.log("失败清单（前 10）：\n  " + failures.slice(0, 10).join("\n  "));
}

function renderReport(v, fp) {
  const s = v._scale;
  const L = [];
  L.push("# 演出指纹 · Live2D 情绪标签统计");
  L.push("");
  L.push("> 本文件由 `node 工具/情绪标签.mjs` **自动生成**，所有数字均为脚本注入，请勿手改。");
  L.push("> 改数据请改上游或改脚本后重跑；中文名属人工补录，置信度见 `_emotion_vocab.json` 的 `conf`。");
  L.push("");
  L.push("## 一、数据口径");
  L.push("");
  L.push(`- 来源：${v._source}`);
  L.push(`- 覆盖剧本 **${s.scripts}** 个（失败 ${s.scriptsFailed}）`);
  L.push(`- 台词行 **${s.lines}**，其中旁白 **${s.narration}**（无说话人，天然无标签）`);
  L.push(`- 带表情标签 **${s.tagged}**，占「有说话人」行的 **${(s.taggedRateOfSpoken * 100).toFixed(1)}%**`);
  L.push(`- 表情 **${s.expKinds}** 种 ｜ 动作 **${s.motKinds}** 种 ｜ 上游模型名 **${s.models}** 个 → 合并为角色 **${s.characters}** 个`);
  L.push("");
  L.push("## 二、表情总榜（前 30）");
  L.push("");
  L.push("| 标签 | 中文 | 次数 | 占已标签 |");
  L.push("|---|---|---|---|");
  const expEntries = Object.entries(v.exp);
  const expTotal = expEntries.reduce((a, [, x]) => a + x.n, 0);
  for (const [k, x] of expEntries.slice(0, 30)) {
    L.push(`| \`${k}\` | ${x.zh}${x.conf === "unknown" ? " ⚠️" : ""} | ${x.n} | ${((x.n / expTotal) * 100).toFixed(1)}% |`);
  }
  L.push("");
  L.push("## 三、动作总榜（前 20）");
  L.push("");
  L.push("| 标签 | 中文 | 次数 |");
  L.push("|---|---|---|");
  const motEntries = Object.entries(v.mtn);
  for (const [k, x] of motEntries.slice(0, 20)) {
    L.push(`| \`${k}\` | ${x.zh}${x.pos ? `·${x.pos}` : ""}${x.conf === "unknown" ? " ⚠️" : ""} | ${x.n} |`);
  }
  L.push("");
  L.push("## 四、角色演出指纹（在册角色）");
  L.push("");
  L.push("按台词量排序。同一角色的多个上游模型名（如 `uika` + `doloris`）已合并。");
  L.push("标签率 = 该角色台词里能回溯到官方表情的比例。");
  L.push("");
  L.push("| 角色 | 模型名 | 台词 | 标签率 | 表情种类 | 前三表情 |");
  L.push("|---|---|---|---|---|---|");
  const named = Object.entries(fp.characters).filter(([, c]) => c.zh);
  const unnamed = Object.entries(fp.characters).filter(([, c]) => !c.zh);
  for (const [k, c] of named) {
    const top3 = c.topExp.slice(0, 3).map((e) => `${v.exp[e.name]?.zh || "?"} \`${e.name}\` ${e.pct}%`).join(" · ");
    L.push(`| ${c.zh} | \`${c.models.join("` `")}\` | ${c.lines} | ${c.tagRate}% | ${c.expKinds} | ${top3 || "—"} |`);
  }
  L.push("");
  L.push("## 五、未登记模型名（NPC / 群演 / 复用资产）");
  L.push("");
  L.push(`共 ${unnamed.length} 个，此处只列台词量前 30。`);
  L.push("");
  L.push("| 模型名 | 台词 | 标签率 | 前三表情 |");
  L.push("|---|---|---|---|");
  for (const [k, c] of unnamed.slice(0, 30)) {
    const top3 = c.topExp.slice(0, 3).map((e) => `${v.exp[e.name]?.zh || "?"} ${e.pct}%`).join(" · ");
    L.push(`| \`${k.replace(/^raw:/, "")}\` | ${c.lines} | ${c.tagRate}% | ${top3 || "—"} |`);
  }
  L.push("");
  L.push("## 六、使用方式");
  L.push("");
  L.push("- 逐句标签：`资料库/_emotion_lines.jsonl`，每行一个 JSON —— `{advId, seq, row, model, exp, mot, text}`");
  L.push("- 词表与中文名：`资料库/_emotion_vocab.json`");
  L.push("- 机读统计：`资料库/_emotion_fingerprint.json`");
  L.push("- 生成侧可直接用 `exp` 字段驱动 Live2D（例：`[exp:sad01]`）");
  L.push("");
  L.push(`> ⚠️ 中文名带 ⚠️ 的条目含义未确认（\`bsmile\` / \`sdeprecate\` / \`salk\` / \`smilk\` 等），别当成结论用。`);
  L.push("> 这些标签本身是上游官方数据，只有**中文释义**是猜的——标签值永远可信，释义不一定。");
  L.push("");
  return L.join("\n");
}

// ---------- --check ----------
async function check() {
  const problems = [];
  if (!existsSync(LINES_OUT)) return console.log("✗ 缺产物，先跑一次不带 --check 的全量");
  const v = JSON.parse(await readFile(VOCAB_OUT, "utf8"));
  const raw = await readFile(LINES_OUT, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length !== v._scale.lines) problems.push(`jsonl 行数 ${lines.length} ≠ vocab 记录 ${v._scale.lines}`);
  let expN = 0;
  let narration = 0;
  for (const l of lines) {
    const o = JSON.parse(l);
    if (o.exp) expN += 1;
    if (!o.model) narration += 1;
  }
  if (expN !== v._scale.tagged) problems.push(`实际带标签 ${expN} ≠ ${v._scale.tagged}`);
  if (narration !== v._scale.narration) problems.push(`实际旁白 ${narration} ≠ ${v._scale.narration}`);
  const fp = JSON.parse(await readFile(FP_OUT, "utf8"));
  const sumLines = Object.values(fp.characters).reduce((a, c) => a + c.lines, 0);
  if (sumLines !== v._scale.lines - v._scale.narration) problems.push(`指纹台词合计 ${sumLines} ≠ 有说话人行 ${v._scale.lines - v._scale.narration}`);
  const report = await readFile(REPORT_OUT, "utf8");
  if (!report.includes(String(v._scale.lines))) problems.push("报告未含台词行总数（数字未注入？）");
  if (problems.length) {
    console.log("✗ 情绪标签自检未过：");
    for (const p of problems) console.log("  - " + p);
    process.exitCode = 1;
  } else {
    console.log(`✓ 情绪标签自检通过：${lines.length} 行 / 带标签 ${expN}（${(v._scale.taggedRateOfSpoken * 100).toFixed(1)}%）/ 表情 ${v._scale.expKinds} 种 / 动作 ${v._scale.motKinds} 种 / 角色 ${v._scale.characters} 个`);
  }
}

if (CHECK) await check();
else await main();
