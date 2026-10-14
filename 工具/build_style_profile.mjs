#!/usr/bin/env node
/**
 * build_style_profile.mjs —— 乐队「风格档案」生成器
 * （light-novel-creator §1 Style Learning System 的本项目离线实现）
 *
 * 输入（全本地、零 token、不联网）：
 *   1. 资料库/kb.json                         —— 47 人 speech 实测指纹 / addresses / keywords / band
 *   2. 素材全量/按角色全量/zh-Hans/*.md        —— 中文台词（语气词、n-gram 现算）
 *   3. 资料库/_emotion_lines.jsonl            —— 逐句表情标签
 *   4. 剧情分析/_data/emotion_polarity.json    —— 词根→效价/唤醒（人工判定）
 *   5. 素材全量/按话/{ja,zh-Hans}/主线/**      —— 叙事结构（每话台词量、说话人数）
 *
 * 产出：风格档案/{乐队}.md × 5 + 风格档案/README.md（五队对照总表）
 *
 * 硬规矩：所有数字运行时现算注入，不手抄；幂等；USER 块保留。
 *
 * 用法：
 *   node 工具/build_style_profile.mjs             # 生成全部
 *   node 工具/build_style_profile.mjs --dry       # 只打印不落盘
 *   node 工具/build_style_profile.mjs --force     # 忽略时间戳强制重写
 *   node 工具/build_style_profile.mjs --check     # 自检
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '风格档案');

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const CHECK = process.argv.includes('--check');

/* ------------------------------------------------------------------ *
 * 1. 乐队定义：kb 的 band 值 → 主线目录名
 * ------------------------------------------------------------------ */
const BANDS = [
  { key: 'MyGO!!!!!', dir: 'MyGO', label: 'MyGO!!!!!' },
  { key: 'Ave Mujica', dir: 'Ave Mujica', label: 'Ave Mujica' },
  { key: '梦限大MewType', dir: '梦限大MewType', label: '梦限大MewType' },
  { key: 'millsage', dir: 'millsage', label: 'millsage' },
  { key: '一家Dumb Rock!', dir: '一家Dumb Rock', label: '一家Dumb Rock!' },
];

/* ------------------------------------------------------------------ *
 * 2. 通用工具
 * ------------------------------------------------------------------ */
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const r2 = (x) => Math.round(x * 100) / 100;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** 解析 "624/773 = 80.7%" → { a: 624, b: 773 } */
function frac(s) {
  const m = String(s ?? '').match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { a: Number(m[1]), b: Number(m[2]) } : null;
}

/** 从 "8.2（10.3）" 里取第一个数 */
function firstNum(s) {
  const m = String(s ?? '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/* ------------------------------------------------------------------ *
 * 3. 加载数据
 * ------------------------------------------------------------------ */
const KB = JSON.parse(readFileSync(join(ROOT, '资料库', 'kb.json'), 'utf8'));
const CHARS = KB.characters ?? [];

const EMOTION_PATH = join(ROOT, '资料库', '_emotion_lines.jsonl');
const POLARITY_PATH = join(ROOT, '剧情分析', '_data', 'emotion_polarity.json');
const hasEmotion = existsSync(EMOTION_PATH) && existsSync(POLARITY_PATH);

const CORPUS_DIR = join(ROOT, '素材全量', '按角色全量', 'zh-Hans');

/** 角色短名 → 语料文件（前缀匹配，避免"萤"命中"小萤"） */
function corpusFile(short) {
  if (!existsSync(CORPUS_DIR)) return null;
  const pref = `${short}_`;
  const hit = readdirSync(CORPUS_DIR).find((f) => f.startsWith(pref) && f.endsWith('.md'));
  return hit ? join(CORPUS_DIR, hit) : null;
}

/** 解析台词 md：返回 [{ cat, advId, lines: [] }]，跳过「出处目录」 */
function parseCorpus(abs) {
  const raw = readFileSync(abs, 'utf8').split(/\r?\n/);
  const secs = [];
  let cur = null, entry = null, skip = false;
  const closeEntry = () => { if (entry && cur) cur.lines.push(entry.trim()); entry = null; };
  const closeSection = () => { closeEntry(); if (cur) secs.push(cur); cur = null; };
  for (const line of raw) {
    if (/^##\s/.test(line)) {
      closeSection();
      const title = line.replace(/^##\s+/, '').trim();
      skip = title === '出处目录';
      cur = skip ? null : { title, cat: '', advId: '', lines: [] };
      continue;
    }
    if (skip) continue;
    if (/^<sub>/.test(line)) {
      const m = line.match(/advId\s*(\d+)/);
      if (m && cur) cur.advId = Number(m[1]);
      continue;
    }
    if (/^-\s/.test(line)) { closeEntry(); entry = line.replace(/^-\s+/, ''); continue; }
    if (/^\s{2,}\S/.test(line) && entry !== null) { entry += '\n' + line.trim(); continue; }
    closeEntry();
  }
  closeSection();
  return secs;
}

/* ------------------------------------------------------------------ *
 * 4. 语言层：语气词 / n-gram
 * ------------------------------------------------------------------ */
const MODALS = ['吗', '呢', '吧', '啊', '呀', '嘛', '啦', '哦', '喔', '哟', '咯', '诶', '欸', '哈', '嘿', '哼', '喂', '嗯'];
const STRIP = /[。！？…～~、，,.!?\*\s"'「」『』（）()—－…]+$/g;

/** 统计一段台词集合的语气词分布 */
function modalStats(lines) {
  const out = { total: 0, hit: 0, by: new Map() };
  for (const raw of lines) {
    const s = raw.replace(STRIP, '').trim();
    if (!s) continue;
    out.total += 1;
    const last = s[s.length - 1];
    if (MODALS.includes(last)) {
      out.hit += 1;
      out.by.set(last, (out.by.get(last) ?? 0) + 1);
    }
  }
  return out;
}

/** 中文 n-gram 计数（只取连续汉字，n=2,3） */
function ngramCount(lines, n) {
  const m = new Map();
  for (const raw of lines) {
    for (const seg of raw.match(/[一-鿿]+/g) ?? []) {
      if (seg.length < n) continue;
      for (let i = 0; i + n <= seg.length; i += 1) {
        const g = seg.slice(i, i + n);
        m.set(g, (m.get(g) ?? 0) + 1);
      }
    }
  }
  return m;
}

/* ------------------------------------------------------------------ *
 * 5. 逐乐队聚合
 * ------------------------------------------------------------------ */
const emotionLines = hasEmotion
  ? readFileSync(EMOTION_PATH, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  : [];
const POLARITY = hasEmotion ? JSON.parse(readFileSync(POLARITY_PATH, 'utf8')).polarity : {};

/** 主线 advId 集合 */
const ADV_OF = new Map();
for (const b of BANDS) {
  const dir = join(ROOT, '素材全量', '按话', 'zh-Hans', '主线', b.dir);
  const ids = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const m = f.match(/^(\d+)_/);
      if (m) ids.push({ advId: Number(m[1]), title: f.replace(/^\d+_/, '').replace(/\.md$/, ''), file: f });
    }
  }
  ids.sort((x, y) => x.advId - y.advId);
  ADV_OF.set(b.key, ids);
}

function collectBand(band) {
  const members = CHARS.filter((c) => c.band === band.key);
  const advIds = ADV_OF.get(band.key) ?? [];

  /* 5.1 speech 指纹累加（分子/分母分别相加，不是比率平均） */
  const acc = {};
  const KEYS = ['纯沉默占比', '省略号率', '以…结尾', '以?结尾', '以!结尾', '疑问率', '感叹率', '口吃率', '小X呼称率', '含我率'];
  const totals = [];
  const lenMeans = [];
  const medians = [];
  const maxLens = [];
  const shortRates = [];
  let lyricLines = 0, lyricLenSum = 0;

  for (const c of members) {
    const sp = c.speech ?? {} ;
    for (const k of KEYS) {
      const f = frac(sp[k]);
      if (f) { acc[k] = acc[k] ?? { a: 0, b: 0 }; acc[k].a += f.a; acc[k].b += f.b; }
    }
    const tf = frac(sp['纯沉默占比']);
    if (tf) totals.push({ id: c.id, name: c.name_short, n: tf.b });
    const lm = firstNum(sp['句长均值(汉字)']);
    if (lm != null) lenMeans.push({ v: lm, w: tf?.b ?? 1 });
    const md = firstNum(sp['句长中位数']);
    if (md != null) medians.push(md);
    const ml = firstNum(sp['最长句']);
    if (ml != null) maxLens.push({ name: c.name_short, v: ml });
    const sr = firstNum(sp['≤6字占比']);
    if (sr != null) shortRates.push({ v: sr, w: tf?.b ?? 1 });
    const ll = firstNum(sp['歌词均长']);
    if (ll != null) { lyricLenSum += ll; lyricLines += 1; }
  }
  const totalLines = totals.reduce((s, x) => s + x.n, 0);
  const wmean = (arr) => (arr.length ? arr.reduce((s, x) => s + x.v * x.w, 0) / arr.reduce((s, x) => s + x.w, 0) : 0);

  /* 5.2 中文语料：语气词 + n-gram */
  const corpusByChar = new Map();
  let corpusMissing = [];
  for (const c of members) {
    const f = corpusFile(c.name_short);
    if (!f) { corpusMissing.push(c.name_short); continue; }
    const secs = parseCorpus(f);
    const lines = secs.flatMap((s) => s.lines);
    corpusByChar.set(c.id, { name: c.name_short, lines });
  }
  const bandLines = [...corpusByChar.values()].flatMap((x) => x.lines);

  const modal = modalStats(bandLines);
  const modalByChar = [...corpusByChar.values()].map((x) => ({ name: x.name, ...modalStats(x.lines) }));

  /* n-gram：乐队 vs 全库 */
  const allCharFiles = existsSync(CORPUS_DIR)
    ? readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.md'))
    : [];
  const allLinesOf = (files) => files.flatMap((f) => parseCorpus(join(CORPUS_DIR, f)).flatMap((s) => s.lines));
  const allLines = allLinesOf(allCharFiles);
  const allLen = allLines.reduce((s, x) => s + x.length, 0);
  const bandLen = bandLines.reduce((s, x) => s + x.length, 0);

  // 人名/称呼剔除名单（否则"小灯""若叶同学"会霸占词表；它们属第 5 节称呼层，
  // 口径同 工具/lexicon.mjs）。kb 只有罗马字姓，汉字姓从中文语料文件名取。
  const nameStop = new Set();
  for (const c of CHARS) {
    for (const s of [c.name_short, c.basic?.简称, String(c.name ?? '').replace(/（.*?）/g, '')]) {
      if (s) nameStop.add(String(s).trim());
    }
    for (const a of c.aliases ?? []) if (a) nameStop.add(String(a).trim());
    for (const f of Object.keys(c.addresses ?? {})) nameStop.add(String(f).trim());
  }
  // 中文全名的 2~3 字子串（覆盖 若叶/丰川/祐天寺/汐见 等姓）
  if (existsSync(CORPUS_DIR)) {
    for (const f of readdirSync(CORPUS_DIR)) {
      const m = f.match(/^(.+?)_(.+)\.md$/);
      if (!m) continue;
      for (const full of [m[1], m[2]]) {
        for (const s of full.match(/[一-鿿]+/g) ?? []) {
          for (let i = 0; i + 2 <= s.length; i += 1) {
            nameStop.add(s.slice(i, i + 2));
            if (i + 3 <= s.length) nameStop.add(s.slice(i, i + 3));
          }
        }
      }
    }
  }
  // 短名 + 称呼后缀
  for (const c of CHARS) {
    for (const suf of ['同学', '酱', '桑', '君', '前辈', '后辈']) nameStop.add(`${c.name_short}${suf}`);
  }
  const stopList = [...nameStop].filter((s) => s.length >= 2);
  // 功能词/虚词片段：含"的"的短语、人称代词开头、疑问词开头
  const FUNC_RE = /^(.)?的(.)?$|^(我们|你们|他们|自己|什么|怎么|为什么|已经|还是|就是|可是|但是|因为|所以|于是|然后|可以|能够|没有)/;
  const isName = (g) =>
    FUNC_RE.test(g)
    || stopList.some((s) => g.includes(s) || s.includes(g))
    || (g.length <= 4 && g.includes('的'))
    || (g.length <= 4 && /^(我|你|他|她|它|那|这|是|就|还|也|都|又|再|可|能|会|要|有|没|不)/.test(g))
    || (g.length <= 5 && /(同学|小姐|先生|前辈|后辈)/.test(g));

  // 统计 3~6 字，再做「片段吸收」：若某串被更长的候选包含、且更长者频次 ≥ 其 70%，
  // 说明它只是后者的一部分（"组一辈"/"辈子乐" → "〔原文略〕"），剔除短者
  const NS = [3, 4, 5, 6];
  const bmByN = {}, amByN = {};
  for (const n of NS) { bmByN[n] = ngramCount(bandLines, n); amByN[n] = ngramCount(allLines, n); }
  const cands = [];
  for (const n of NS) {
    for (const [g, cnt] of bmByN[n]) {
      if (cnt < 6 || isName(g)) continue;
      const allCnt = amByN[n].get(g) ?? 0;
      const allRate = allCnt / (allLen || 1);
      const lift = allRate ? (cnt / (bandLen || 1)) / allRate : 0;
      if (lift >= 2.2) cands.push({ g, n, cnt, allCnt, lift });
    }
  }
  const grams = cands.filter((g) => !cands.some((o) => o.n > g.n && o.g.includes(g.g) && o.cnt >= g.cnt * 0.7));
  grams.sort((a, b) => b.lift * b.cnt - a.lift * a.cnt);
  const kept = [];
  for (const g of grams) {
    if (kept.some((u) => u.g.includes(g.g) || g.g.includes(u.g))) continue;
    kept.push(g);
    if (kept.length >= 14) break;
  }

  /* 5.3 情绪底色 */
  const advSet = new Set(advIds.map((x) => x.advId));
  const vs = [], ars = [], exps = new Map();
  let emoTagged = 0;
  if (hasEmotion) {
    for (const l of emotionLines) {
      if (!advSet.has(Number(l.advId))) continue;
      const base = typeof l.exp === 'string' ? l.exp.replace(/^exp_/, '').replace(/\d+$/, '') : null;
      if (!base) continue;
      const p = POLARITY[base];
      if (!p) continue;
      emoTagged += 1;
      vs.push(p.valence); ars.push(p.arousal);
      exps.set(base, (exps.get(base) ?? 0) + 1);
    }
  }
  const topExps = [...exps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, n]) => ({ zh: POLARITY[k]?.zh ?? k, n }));

  /* 5.4 叙事结构 */
  const perEp = [];
  for (const a of advIds) {
    const f = join(ROOT, '素材全量', '按话', 'zh-Hans', '主线', band.dir, a.file);
    if (!existsSync(f)) continue;
    const txt = readFileSync(f, 'utf8');
    const hm = txt.match(/\*\*(\d+)\s*行\*\*/);
    const lines = hm ? Number(hm[1]) : (txt.match(/^\*\*/gm) ?? []).length;
    const speakers = new Set();
    for (const m of txt.matchAll(/^\*\*(.+?)\*\*[：:]/gm)) speakers.add(m[1]);
    perEp.push({ advId: a.advId, title: a.title, lines, speakers: speakers.size });
  }
  const epLineCounts = perEp.map((x) => x.lines);
  const hottestEp = perEp.length
    ? perEp.reduce((a, b) => (b.lines > a.lines ? b : a), perEp[0])
    : null;
  const coldestEp = perEp.length
    ? perEp.reduce((a, b) => (b.lines < a.lines ? b : a), perEp[0])
    : null;

  /* 5.5 主题意象 */
  const kw = new Map();
  for (const c of members) for (const k of c.keywords ?? []) kw.set(k, (kw.get(k) ?? 0) + 1);
  const topKw = [...kw.entries()].sort((a, b) => b[1] - a[1]);

  /* 5.6 称呼体系 */
  const addrPairs = [];
  for (const c of members) {
    for (const [form, n] of Object.entries(c.addresses ?? {})) {
      addrPairs.push({ from: c.name_short, form, n });
    }
  }
  addrPairs.sort((a, b) => b.n - a.n);

  return {
    band, members, advIds,
    totalLines,
    membersByLines: totals.sort((a, b) => b.n - a.n),
    speechAcc: acc,
    lenMean: wmean(lenMeans),
    lenMedian: median(medians),
    longest: maxLens.reduce((a, b) => (b.v > a.v ? b : a), { v: 0, name: '—' }),
    shortRate: wmean(shortRates),
    lyricMean: lyricLines ? lyricLenSum / lyricLines : 0,
    corpus: {
      chars: corpusByChar.size,
      lines: bandLines.length,
      missing: corpusMissing,
      modal: { total: modal.total, hit: modal.hit, rate: modal.total ? modal.hit / modal.total : 0,
        top: [...modal.by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8) },
      modalByChar,
      grams: kept,
    },
    emotion: {
      tagged: emoTagged,
      meanValence: r2(mean(vs)),
      meanArousal: r2(mean(ars)),
      negRatio: vs.length ? vs.filter((x) => x < -0.05).length / vs.length : 0,
      posRatio: vs.length ? vs.filter((x) => x > 0.05).length / vs.length : 0,
      topExps,
    },
    narrative: {
      episodes: perEp.length,
      perEp,
      meanLines: r2(mean(epLineCounts)),
      medianLines: median(epLineCounts),
      minEp: coldestEp,
      maxEp: hottestEp,
      meanSpeakers: r2(mean(perEp.map((x) => x.speakers))),
    },
    keywords: topKw,
    addresses: addrPairs,
  };
}

/* ------------------------------------------------------------------ *
 * 6. 渲染
 * ------------------------------------------------------------------ */
function extractUserBlocks(txt) {
  const m = new Map();
  const re = /<!-- USER:START ([^>]+?) -->([\s\S]*?)<!-- USER:END -->/g;
  let x;
  while ((x = re.exec(txt))) m.set(x[1], x[2]);
  return m;
}
function applyUserBlocks(content, blocks) {
  return content.replace(
    /<!-- USER:START ([^>]+?) -->([\s\S]*?)<!-- USER:END -->/g,
    (all, name) => (blocks.has(name) ? `<!-- USER:START ${name} -->${blocks.get(name)}<!-- USER:END -->` : all)
  );
}
const stripTs = (s) => s.replace(/^> 生成于：.*$/m, '');

let changed = 0, skipped = 0, created = 0;
function writeFile(rel, content) {
  const abs = join(OUT_DIR, rel);
  let out = content;
  if (existsSync(abs)) out = applyUserBlocks(content, extractUserBlocks(readFileSync(abs, 'utf8')));
  const same = existsSync(abs) && stripTs(readFileSync(abs, 'utf8')) === stripTs(out);
  if (same && !FORCE) { console.log(`  = 跳过  风格档案/${rel}`); skipped += 1; return; }
  if (DRY) { console.log(`  ~ 将写  风格档案/${rel}`); changed += 1; return; }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, out, 'utf8');
  console.log(`  ${existsSync(abs) ? '~ 更新' : '+ 新建'}  风格档案/${rel}`);
  changed += 1;
}

/** 以中轴 | 为零点的双向条，总长 2*half+1 */
function bar(v, half = 18) {
  const n = Math.min(half, Math.round(Math.abs(v) * half));
  const pad = '·'.repeat(half);
  if (v >= 0) return pad + '|' + '█'.repeat(n) + '·'.repeat(half - n);
  return '·'.repeat(half - n) + '▓'.repeat(n) + '|' + pad;
}

function renderBand(d) {
  const b = d.band;
  const L = [];
  const acc = d.speechAcc;
  const rate = (k) => (acc[k] ? acc[k].a / acc[k].b : 0);

  L.push(`# Style Profile: ${b.label}`);
  L.push('');
  L.push('> 生成于：' + new Date().toISOString().slice(0, 19).replace('T', ' '));
  L.push(`> 成员 **${d.members.length}** 人 ｜ 台词合计 **${d.totalLines}** 行 ｜ 主线 **${d.narrative.episodes}** 话`);
  L.push('> 全部数字由 `工具/build_style_profile.mjs` 现算注入：说话指纹取 `kb.json` 逐人实测值按分子分母累加，');
  L.push('> 语气词与高频词串由中文语料现算，情绪底色取 `_emotion_lines.jsonl × emotion_polarity.json`。');
  L.push('');
  L.push('> ⚠️ **本档案是描述层（概率学统计），不是结论。** 语气词率 / 句长 / 效价等只是「是什么样」的证据，');
  L.push('> 读完只能得到"知道了"。要的是**为什么**——某角色在某种情绪下**怎么演（动作）**——见');
  L.push('> [`角色模型/设计思路/_演出动作谱.md`](../角色模型/设计思路/_演出动作谱.md)（Live2D `_command===21` 抽出的「情绪→动作」映射，§2 说法层真源）。');
  L.push('> 数字删掉后判断若站不住，说明数字在撑结论，要重写。');
  L.push('');

  L.push('## 0. 口径与不适用槽位');
  L.push('');
  L.push('skill 原版 §1 模板是给**小说正文**设计的，本项目底本是**游戏对话剧本**，有三个槽位不适用：');
  L.push('');
  L.push('| 模板槽位 | 本项目情况 | 替代指标 |');
  L.push('|---|---|---|');
  L.push('| 描写占比（环境/外貌/动作） | 剧本无描写层，原文只有 `说话人：台词` | 改为「叙事结构」：每话台词量、说话人数 |');
  L.push('| 心理活动占比（内心独白） | 内心活动全部外化为台词或沉默 | 改为「纯沉默占比」：无台词但有表情指令的行 |');
  L.push('| 对话占比 | 剧本恒为 100%，无信息量 | 改为「每话台词量分布」看节奏疏密 |');
  L.push('');
  L.push('**效价 / 唤醒口径**同 [`剧情分析/情绪曲线.md`](../剧情分析/情绪曲线.md)：效价 = 情绪正负方向（−1~+1），唤醒 = 激活强度（0~3）。');
  L.push('逐话均效价实际只在 −0.47~+0.33 区间波动，**0.2 已是显著落差**。');
  L.push('');

  L.push('## 1. 成员构成');
  L.push('');
  L.push('| 成员 | id | 担当 | 台词行数 | 占队比 |');
  L.push('|---|---|---|---:|---:|');
  for (const m of d.membersByLines) {
    const c = d.members.find((x) => x.id === m.id);
    L.push(`| ${m.name} | \`${m.id}\` | ${c?.role ?? '—'} | ${m.n} | ${pct(m.n / (d.totalLines || 1))} |`);
  }
  L.push('');

  L.push('## 2. 句长分布');
  L.push('');
  L.push(`- 平均句长：**${d.lenMean.toFixed(1)}** 字/句（按各成员句数加权）`);
  L.push(`- 句长中位数：${d.lenMedian} 字（各成员中位数取中位）`);
  L.push(`- 最长句：**${d.longest.v}** 字（${d.longest.name}）`);
  L.push(`- ≤6 字短句占比：**${pct(d.shortRate / 100)}**`);
  L.push(`- 歌词均长：${d.lyricMean.toFixed(1)} 字`);
  L.push('');
  L.push(`变化模式：${rate('纯沉默占比') > 0.1 ? '长短落差极大——沉默行与完整句交替出现，是停顿感的主要来源' : '句长相对均匀，以完整句推进'}`);
  L.push('');

  L.push('## 3. 对话节奏');
  L.push('');
  L.push('| 指标 | 比率 | 条形 |');
  L.push('|---|---:|---|');
  const rhythm = [
    ['纯沉默占比', '纯沉默（只出表情不出词）'],
    ['省略号率', '省略号率'],
    ['以…结尾', '以省略号收尾'],
    ['以?结尾', '以问号收尾'],
    ['以!结尾', '以感叹号收尾'],
    ['疑问率', '疑问率'],
    ['感叹率', '感叹率'],
    ['口吃率', '口吃/重复'],
    ['小X呼称率', '「小X」式亲昵称呼'],
    ['含我率', '含「我」'],
  ];
  for (const [k, label] of rhythm) {
    const v = rate(k);
    const n = Math.round(v * 24);
    L.push(`| ${label} | ${pct(v)} | \`${'█'.repeat(n)}${'·'.repeat(24 - n)}\` |`);
  }
  L.push('');

  L.push('## 4. 语尾与口头禅');
  L.push('');
  L.push(`语尾语气词总率 **${pct(d.corpus.modal.rate)}**（${d.corpus.modal.hit}/${d.corpus.modal.total} 行，中文语料 “素材全量/按角色全量/zh-Hans/”，${d.corpus.chars} 人有语料）。`);
  if (d.corpus.missing.length) L.push(`> 无独立语料文件：${d.corpus.missing.join('、')}（其指纹仍计入第 2、3 节）。`);
  L.push('');
  if (d.corpus.modal.top.length) {
    L.push('| 语气词 | 次数 |');
    L.push('|---|---:|');
    for (const [w, n] of d.corpus.modal.top) L.push(`| ${w} | ${n} |`);
    L.push('');
  }
  L.push('**分成员语气词率**（看队内谁在拖/推这个节奏）：');
  L.push('');
  L.push('| 成员 | 语尾行/总行 | 率 | 主要语气词 |');
  L.push('|---|---:|---:|---|');
  for (const m of d.corpus.modalByChar.sort((a, b) => b.rate - a.rate)) {
    const r = m.total ? m.hit / m.total : 0;
    const top = [...m.by.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([w, n]) => `${w}×${n}`).join(' ');
    L.push(`| ${m.name} | ${m.hit}/${m.total} | ${pct(r)} | ${top || '—'} |`);
  }
  L.push('');
  L.push('**专属高频词串**（3~6 字，相对全库 47 人语料倍数 ≥ 2.2、出现 ≥ 6 次；人名与称呼串已剔除见第 5 节，跨词片段已做吸收）：');
  L.push('');
  L.push('> 片段吸收规则：若某串被更长的候选包含、且更长者频次 ≥ 其 70%，则视为后者的一部分被剔除。');
  L.push('> **仍可能残留跨词片段**（如「世同学」实为「爽世同学」的尾巴），当招牌词用前请人工复核。');
  L.push('');
  if (d.corpus.grams.length) {
    L.push('| 词串 | 本队次数 | 全库次数 | 相对倍数 |');
    L.push('|---|---:|---:|---:|');
    for (const g of d.corpus.grams) L.push(`| ${g.g} | ${g.cnt} | ${g.allCnt} | ×${g.lift.toFixed(1)} |`);
  } else {
    L.push('（无达门槛词串）');
  }
  L.push('');

  L.push('## 5. 称呼体系');
  L.push('');
  if (d.addresses.length) {
    L.push('| 称呼方 | 称呼形式 | 次数 |');
    L.push('|---|---|---:|');
    for (const a of d.addresses.slice(0, 24)) L.push(`| ${a.from} | ${a.form} | ${a.n} |`);
  } else {
    L.push('（kb 未记录）');
  }
  L.push('');

  L.push('## 6. 主题意象');
  L.push('');
  if (d.keywords.length) {
    L.push(d.keywords.slice(0, 24).map(([k, n]) => `**${k}**${n > 1 ? `（${n}人共用）` : ''}`).join('　·　'));
  } else {
    L.push('（kb 未记录）');
  }
  L.push('');

  L.push('## 7. 情绪底色');
  L.push('');
  if (d.emotion.tagged) {
    L.push(`- 带表情标签台词：**${d.emotion.tagged}** 句`);
    L.push(`- 平均效价：**${d.emotion.meanValence.toFixed(2)}**　\`${bar(d.emotion.meanValence)}\``);
    L.push(`- 平均唤醒：**${d.emotion.meanArousal.toFixed(2)}**（0 平静 ~ 3 剧烈）`);
    L.push(`- 负向句占比 ${pct(d.emotion.negRatio)} ／ 正向句占比 ${pct(d.emotion.posRatio)}`);
    L.push('');
    L.push('高频表情：' + d.emotion.topExps.map((x) => `${x.zh}×${x.n}`).join('、'));
  } else {
    L.push('（情绪数据缺失，先跑 `node 工具/情绪标签.mjs`）');
  }
  L.push('');

  L.push('## 8. 叙事结构');
  L.push('');
  L.push(`- 主线 **${d.narrative.episodes}** 话（advId ${d.advIds[0]?.advId}–${d.advIds[d.advIds.length - 1]?.advId}）`);
  L.push(`- 每话台词量：均值 **${d.narrative.meanLines.toFixed(1)}** 行 ／ 中位数 ${d.narrative.medianLines.toFixed(1)} 行`);
  if (d.narrative.maxEp) L.push(`- 最密一话：${d.narrative.maxEp.advId} ${d.narrative.maxEp.title}（${d.narrative.maxEp.lines} 行 / ${d.narrative.maxEp.speakers} 人）`);
  if (d.narrative.minEp) L.push(`- 最疏一话：${d.narrative.minEp.advId} ${d.narrative.minEp.title}（${d.narrative.minEp.lines} 行 / ${d.narrative.minEp.speakers} 人）`);
  L.push(`- 每话平均出场人数：**${d.narrative.meanSpeakers}** 人`);
  L.push('');
  L.push('| advId | 话标题 | 台词行 | 说话人 |');
  L.push('|---|---|---:|---:|');
  for (const e of d.narrative.perEp) L.push(`| ${e.advId} | ${e.title} | ${e.lines} | ${e.speakers} |`);
  L.push('');

  L.push('## 9. 创作要点（手写区）');
  L.push('');
  L.push('<!-- USER:START 创作要点 -->');
  L.push('<!-- 写在这里：模仿这个乐队写作时该抓住什么。重跑生成不会覆盖本块 -->');
  L.push('<!-- USER:END -->');
  L.push('');
  return L.join('\n');
}

function renderIndex(all) {
  const L = [];
  L.push('# 风格档案 — 五队对照总表');
  L.push('');
  L.push('> 生成于：' + new Date().toISOString().slice(0, 19).replace('T', ' '));
  L.push('> `工具/build_style_profile.mjs` 现算注入。口径见各队档案第 0 节。');
  L.push('');
  L.push('> ⚠️ **本总表是描述层（概率学统计），不是结论。** 语气词率等只是「是什么样」的证据，读完只得到"知道了"。');
  L.push('> 要的是**为什么**——某角色在某种情绪下**怎么演（动作）**——见 [`角色模型/设计思路/_演出动作谱.md`](../角色模型/设计思路/_演出动作谱.md)');
  L.push('> （Live2D `_command===21` 抽出的「情绪→动作」映射，§2 说法层真源）。数字删掉后判断若站不住，说明数字在撑结论，要重写。');
  L.push('');
  L.push('| 乐队 | 成员 | 台词行 | 主线话数 | 平均句长 | ≤6字占比 | 纯沉默率 | 省略号率 | 语尾语气词率 | 均效价 | 均唤醒 | 每话台词 |');
  L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const d of all) {
    const r = (k) => (d.speechAcc[k] ? d.speechAcc[k].a / d.speechAcc[k].b : 0);
    L.push(`| [${d.band.label}](${encodeURIComponent(d.band.label)}.md) | ${d.members.length} | ${d.totalLines} | ${d.narrative.episodes} | ${d.lenMean.toFixed(1)} | ${pct(d.shortRate / 100)} | ${pct(r('纯沉默占比'))} | ${pct(r('省略号率'))} | ${pct(d.corpus.modal.rate)} | ${d.emotion.meanValence.toFixed(2)} | ${d.emotion.meanArousal.toFixed(2)} | ${d.narrative.meanLines.toFixed(1)} |`);
  }
  L.push('');

  L.push('## 五队速写');
  L.push('');
  for (const d of all) {
    const r = (k) => (d.speechAcc[k] ? d.speechAcc[k].a / d.speechAcc[k].b : 0);
    L.push(`### ${d.band.label}`);
    L.push('');
    L.push(`句长 ${d.lenMean.toFixed(1)} 字 · 短句 ${pct(d.shortRate / 100)} · 沉默 ${pct(r('纯沉默占比'))} · 省略号 ${pct(r('省略号率'))} · 效价 ${d.emotion.meanValence.toFixed(2)} · 唤醒 ${d.emotion.meanArousal.toFixed(2)}`);
    L.push('');
    L.push(d.keywords.slice(0, 10).map(([k]) => k).join('　·　') || '（无关键词）');
    L.push('');
  }

  L.push('## 附：非主线组合');
  L.push('');
  const others = {};
  for (const c of CHARS) {
    if (BANDS.some((b) => b.key === c.band)) continue;
    (others[c.band ?? '(无)'] = others[c.band ?? '(无)'] ?? []).push(c);
  }
  L.push('| 组合 | 人数 | 成员 |');
  L.push('|---|---:|---|');
  for (const [k, arr] of Object.entries(others)) {
    L.push(`| ${k} | ${arr.length} | ${arr.map((c) => c.name_short).join('、')} |`);
  }
  L.push('');
  L.push('> 这些组合没有独立主线目录，不出单独档案；数据仍在 `kb.json` 内，`人物` 类工具可查。');
  L.push('');
  return L.join('\n');
}

/* ------------------------------------------------------------------ *
 * 7. 主流程
 * ------------------------------------------------------------------ */
const all = BANDS.map(collectBand);

if (CHECK) {
  const problems = [];
  if (!hasEmotion) problems.push('情绪数据缺失（资料库/_emotion_lines.jsonl 或 emotion_polarity.json）');
  for (const d of all) {
    if (!d.members.length) problems.push(`${d.band.label}：kb 无成员`);
    if (!d.totalLines) problems.push(`${d.band.label}：台词行数为 0`);
    if (!d.narrative.episodes) problems.push(`${d.band.label}：主线话数为 0`);
    if (!d.corpus.lines) problems.push(`${d.band.label}：中文语料 0 行`);
    if (!existsSync(join(OUT_DIR, `${d.band.label}.md`))) problems.push(`${d.band.label}：档案未生成`);
    for (const k of ['纯沉默占比', '省略号率']) {
      const a = d.speechAcc[k];
      if (a && (a.a > a.b)) problems.push(`${d.band.label}：${k} 分子大于分母`);
    }
  }
  if (!existsSync(join(OUT_DIR, 'README.md'))) problems.push('README.md 未生成');
  if (problems.length) { console.error('✗ 自检未通过：'); problems.forEach((p) => console.error('  - ' + p)); process.exit(1); }
  console.log(`✓ 风格档案自检通过（${all.length} 队 / ${all.reduce((s, d) => s + d.members.length, 0)} 人）`);
  process.exit(0);
}

console.log(DRY ? '（--dry：只预览不落盘）' : '生成乐队风格档案：');
for (const d of all) writeFile(`${d.band.label}.md`, renderBand(d));
writeFile('README.md', renderIndex(all));
console.log(`完成。${created ? `新建 ${created} / ` : ''}更新 ${changed} / 跳过 ${skipped}`);
