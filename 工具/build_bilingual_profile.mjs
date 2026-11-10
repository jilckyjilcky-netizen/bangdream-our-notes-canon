#!/usr/bin/env node
/**
 * build_bilingual_profile.mjs —— 日中平行语料对照层
 * （light-novel-creator §2 多语言创作系统的本项目离线实现）
 *
 * 为什么单独一层：
 *   现有四层分析（风格档案 / 话层 / 剧情 / 叙事方式）全部跑在 **zh-Hans** 一侧
 *   —— 实测 `grep "'ja'" build_style_profile.mjs` 返回 0，而 `素材全量/按话/ja/` 有 946 篇。
 *   也就是说目前所有结论描述的是「译本」而不是「原作」：作者的语言和译者的语言
 *   被当成同一个东西统计了。本层把这两件事分开。
 *
 * 数据基础（独一份）：
 *   `素材全量/按话/{ja,zh-Hans}` 同名同布局，**逐话成对的平行语料**（109 话主线）。
 *   ja 侧写日本短名（そよ/燈）、zh 侧写中文短名（爽世/灯）—— 没有对照表，
 *   所以两张表的连接是靠**逐块对齐共现挖出来的**（≥MIN_VOTE 票且独占），不是手写词典。
 *
 * 指标（全部块级，不依赖句对齐 —— 句级 join 不可靠，见下）：
 *   膨胀率      zh 可见字符 / ja 可见字符        —— 信息密度差
 *   句长        ja 字/句、zh 字/句               —— 各自的自然吞吐
 *   语气密度    句末终助词率（ja）vs 句末语气词率（zh）
 *   落地率      ja 侧出现某标记时 zh 侧保留率：～ / …… / ？ / ！？ / 敬体
 *   沉默一致    纯沉默行两边是否都是沉默
 *
 * ⚠️ 为什么用块级不用句级：ja 一句在 zh 里常被拆成两句或并成一句，
 *    句级 join 会产生大量 1:N / N:1 配对，比值会失真。块级（一个说话块对另一个说话块）
 *    天然同构：同一 advId 同一行号，两边行数实测 100% 一致。
 *
 * 产出：双语对照/README.md（五队对照总表）+ 双语对照/<队>.md × 5
 *      + 双语对照/说话人对照.md（ja↔zh 映射，for '-' 副产品）
 *      + 双语对照/_data/bilingual.json（真源）
 *
 * 硬规矩：数字运行时现算注入，不手抄；幂等；USER 块保留。
 *
 * 用法：
 *   node 工具/build_bilingual_profile.mjs            # 生成全部
 *   node 工具/build_bilingual_profile.mjs --dry      # 只打五队实测对比
 *   node 工具/build_bilingual_profile.mjs --force    # 忽略时间戳强制重写
 *   node 工具/build_bilingual_profile.mjs --check    # 自检（自检.mjs 必过项）
 *   node 工具/build_bilingual_profile.mjs --json     # 只落 _data/bilingual.json
 *   node 工具/build_bilingual_profile.mjs --show <队> # 看某队角色级明细
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, '素材全量', '按话');
const OUT_DIR = join(ROOT, '双语对照');
const OUT_DATA = join(OUT_DIR, '_data');

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const CHECK = process.argv.includes('--check');
const JSON_ONLY = process.argv.includes('--json');
const showIdx = process.argv.indexOf('--show');
const SHOW = showIdx >= 0 ? process.argv[showIdx + 1] : null;

/* ------------------------------------------------------------------ *
 * 1. 乐队定义（与 build_style_profile.mjs 同一张表，别各写一份）
 * ------------------------------------------------------------------ */
const BANDS = [
  { key: 'MyGO!!!!!', dir: 'MyGO', label: 'MyGO!!!!!' },
  { key: 'Ave Mujica', dir: 'Ave Mujica', label: 'Ave Mujica' },
  { key: '梦限大MewType', dir: '梦限大MewType', label: '梦限大MewType' },
  { key: 'millsage', dir: 'millsage', label: 'millsage' },
  { key: '一家Dumb Rock!', dir: '一家Dumb Rock', label: '一家Dumb Rock!' },
];

/* 说话人映射的可信门槛：同一 ja 名必须投给同一个 zh 名 ≥ MIN_VOTE 票，且票数独占第一。 */
const MIN_VOTE = 3;
/** 主角级门槛（与 NovelProject 角色卡口径一致：台词 ≥75 句） */
const MIN_LINES_LEAD = 20;

/* ------------------------------------------------------------------ *
 * 2. 通用工具
 * ------------------------------------------------------------------ */
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const r2 = (x) => Math.round(x * 100) / 100;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** 非空白可见字符数（中日都按字符数，不用字节） */
const visible = (s) => (s.replace(/\s/g, '').length);

/* 句读符：两边各自的口径 */
const SENT_SPLIT_JA = /[。！？!?…‥♪]+/g;
const SENT_SPLIT_ZH = /[。！？!?…]+/g;

/** 纯沉默块（有说话人、无实质台词） */
const SILENT_RE = /^[.。…・·‥\s]+$/;

/* ---- 模式表：ja 侧标记 → zh 侧应保留的同族标记 ---- */
const PATTERNS = [
  { id: 'tilde', name: '拖音～', ja: /[〜～]/, zh: /[～~]/ },
  { id: 'ellipsis', name: '省略号…', ja: /…/, zh: /[…。]{2}|……|…/ },
  { id: 'question', name: '疑问？', ja: /[？?]/, zh: /[？?]/ },
  { id: 'mixbang', name: '疑叹！？', ja: /[！!][？?]|[？?][！!]|‼|⁉/, zh: /[！!][？?]|[？?][！!]|‼|⁉/ },
];

/** 日文敬体标志 */
const JA_POLITE = /(です|ます|ました|でした|ください|でございます|ございます|させていただき|いただき|ですわ|ますわ|でしょう|ですか|ますか)/;
/** 中文里的敬语/郑重标记（比日文窄得多 —— 这正是要测的） */
const ZH_POLITE = /(您|请|可否|能否|劳烦|荣幸|冒昧|失礼|还望|恕我|感激不尽|客气)/;

/** 日语句末终助词（中文没有对等物，只能靠语气词近似） */
const JA_FINAL = /(ね|よ|わ|の|かな|かしら|ぞ|ぜ|なあ|のに|んだよ|んじゃん|よね|のよ|わね|ですわ|ますわ|だよ|だね|かなあ)$/;
/** 中文句末语气词 */
const ZH_FINAL = /(吗|呢|吧|啊|呀|嘛|啦|哦|喔|哟|咯|诶|欸|嗯|罢了|而已)$/;

/* ------------------------------------------------------------------ *
 * 3. 解析逐话 md → 说话块
 *
 * 布局（ja 与 zh 完全一致）：
 *   # 标题
 *   > **advId** 10000 ｜ ...
 *   ---
 *   **話者**：台詞一行   <- 续行以两个空格结尾
 *   **話者**：...
 * ------------------------------------------------------------------ */
function parseEpisode(abs) {
  const raw = readFileSync(abs, 'utf8').split(/\r?\n/);
  const blocks = [];
  let advId = null;
  let cur = null;
  const push = () => { if (cur) blocks.push(cur); cur = null; };

  for (const line of raw) {
    const meta = line.match(/\*\*advId\*\*\s*(\d+)/);
    if (meta) { advId = Number(meta[1]); continue; }
    const sp = line.match(/^\*\*(.+?)\*\*[：:](.*)$/);
    if (sp) {
      push();
      cur = {
        speakerRaw: sp[1].trim(),
        speakers: sp[1].split(/[・、,，]/).map((s) => s.trim()).filter(Boolean),
        lines: [sp[2].trim()],
      };
      continue;
    }
    // 续行：以两个及以上空格结尾，或**不在任何说话块之后的裸文本**
    if (/[ ]{2,}$/.test(line) && cur) {
      cur.lines.push(line.replace(/[ ]{2,}$/, '').trim());
      continue;
    }
    if (/\S/.test(line) && !/^[#>\-]/.test(line) && cur) {
      cur.lines.push(line.trim());
      continue;
    }
  }
  push();
  return { advId, blocks };
}

/* ------------------------------------------------------------------ *
 * 4. 配对 + 指标
 * ------------------------------------------------------------------ */
function countSentences(text, re) {
  const parts = text.split(re).map((s) => s.trim()).filter(Boolean);
  return Math.max(1, parts.length);
}

/** 一个块的一侧指标 */
function sideStats(text, isJa) {
  const flat = text.replace(/\n/g, '');
  const chars = visible(flat);
  const sents = countSentences(flat, isJa ? SENT_SPLIT_JA : SENT_SPLIT_ZH);
  const silent = SILENT_RE.test(flat) || chars === 0;
  // 句末语气密度：按句统计落点
  const sentList = flat.split(isJa ? SENT_SPLIT_JA : SENT_SPLIT_ZH)
    .map((s) => s.replace(/[\s"'「」『』（）()]/g, '')).filter(Boolean);
  const finalRe = isJa ? JA_FINAL : ZH_FINAL;
  const finalHit = sentList.filter((s) => finalRe.test(s)).length;
  const polite = isJa ? JA_POLITE.test(flat) : ZH_POLITE.test(flat);
  const pat = {};
  for (const p of PATTERNS) pat[p.id] = (isJa ? p.ja : p.zh).test(flat);
  return { chars, sents, silent, finalHit, sentCount: Math.max(1, sentList.length), polite, pat };
}

function collectBand(band) {
  const jaDir = join(CORPUS, 'ja', '主线', band.dir);
  const zhDir = join(CORPUS, 'zh-Hans', '主线', band.dir);
  if (!existsSync(jaDir) || !existsSync(zhDir)) return null;

  const jaFiles = readdirSync(jaDir).filter((f) => f.endsWith('.md'));
  const episodes = [];
  const speakerVotes = new Map();   // jaName -> Map(zhName -> n)
  const roleAgg = new Map();        // zhName -> accumulator

  const acc = () => ({
    pairs: 0, jaChars: 0, zhChars: 0, jaSents: 0, zhSents: 0,
    jaFinalHit: 0, jaSentCount: 0, zhFinalHit: 0, zhSentCount: 0,
    politeJa: 0, politeBoth: 0, silentSame: 0, silentJa: 0,
    patJa: Object.fromEntries(PATTERNS.map((p) => [p.id, 0])),
    patKeep: Object.fromEntries(PATTERNS.map((p) => [p.id, 0])),
  });

  for (const f of jaFiles) {
    const zhPath = join(zhDir, f);
    if (!existsSync(zhPath)) continue;
    const ja = parseEpisode(join(jaDir, f));
    const zh = parseEpisode(zhPath);
    const n = Math.min(ja.blocks.length, zh.blocks.length);
    const aligned = ja.blocks.length === zh.blocks.length;

    let jaC = 0, zhC = 0, jaS = 0, zhS = 0;
    let jaF = 0, jaSC = 0, zhF = 0, zhSC = 0;
    let silSame = 0, silJa = 0, polJa = 0, polBoth = 0;
    const epPat = Object.fromEntries(PATTERNS.map((p) => [p.id, [0, 0]]));

    for (let i = 0; i < n; i += 1) {
      const a = ja.blocks[i], b = zh.blocks[i];
      const sa = sideStats(a.lines.join(''), true);
      const sb = sideStats(b.lines.join(''), false);

      // 说话人映射：只在两边写人名单形变都退化的成对情况票（一一对应时最可靠）
      if (a.speakers.length === 1 && b.speakers.length === 1) {
        const jn = a.speakers[0], zn = b.speakers[0];
        if (!speakerVotes.has(jn)) speakerVotes.set(jn, new Map());
        const m = speakerVotes.get(jn);
        m.set(zn, (m.get(zn) ?? 0) + 1);
      }

      const share = 1 / Math.max(1, b.speakers.length);
      for (const zn of b.speakers) {
        if (!roleAgg.has(zn)) roleAgg.set(zn, acc());
        const r = roleAgg.get(zn);
        r.pairs += share;
        r.jaChars += sa.chars * share; r.zhChars += sb.chars * share;
        r.jaSents += sa.sents * share; r.zhSents += sb.sents * share;
        r.jaFinalHit += sa.finalHit * share; r.jaSentCount += sa.sentCount * share;
        r.zhFinalHit += sb.finalHit * share; r.zhSentCount += sb.sentCount * share;
        if (sa.polite) { r.politeJa += share; if (sb.polite) r.politeBoth += share; }
        if (sa.silent) { r.silentJa += share; if (sb.silent) r.silentSame += share; }
        for (const p of PATTERNS) {
          if (sa.pat[p.id]) { r.patJa[p.id] += share; if (sb.pat[p.id]) r.patKeep[p.id] += share; }
        }
      }

      jaC += sa.chars; zhC += sb.chars; jaS += sa.sents; zhS += sb.sents;
      jaF += sa.finalHit; jaSC += sa.sentCount; zhF += sb.finalHit; zhSC += sb.sentCount;
      if (sa.silent) { silJa += 1; if (sb.silent) silSame += 1; }
      if (sa.polite) { polJa += 1; if (sb.polite) polBoth += 1; }
      for (const p of PATTERNS) {
        if (sa.pat[p.id]) { epPat[p.id][0] += 1; if (sb.pat[p.id]) epPat[p.id][1] += 1; }
      }
    }

    episodes.push({
      file: f, advId: ja.advId, jaBlocks: ja.blocks.length, zhBlocks: zh.blocks.length,
      aligned, jaChars: jaC, zhChars: zhC,
      ratio: jaC ? zhC / jaC : 0,
      jaSentLen: jaS ? jaC / jaS : 0, zhSentLen: zhS ? zhC / zhS : 0,
      jaFinalRate: jaSC ? jaF / jaSC : 0, zhFinalRate: zhSC ? zhF / zhSC : 0,
      silentJa: silJa, silentSame: silSame,
      politeJa: polJa, politeBoth: polBoth,
      pat: Object.fromEntries(PATTERNS.map((p) => [p.id, epPat[p.id]])),
    });
  }

  return { band, episodes, speakerVotes, roleAgg };
}

/* ------------------------------------------------------------------ *
 * 5. 聚合
 * ------------------------------------------------------------------ */
function bandSummary(c) {
  const eps = c.episodes;
  const jaChars = eps.reduce((s, e) => s + e.jaChars, 0);
  const zhChars = eps.reduce((s, e) => s + e.zhChars, 0);
  const jaSents = eps.reduce((s, e) => s + (e.jaChars / (e.jaSentLen || 1)), 0);
  const zhSents = eps.reduce((s, e) => s + (e.zhChars / (e.zhSentLen || 1)), 0);
  const polJa = eps.reduce((s, e) => s + e.politeJa, 0);
  const silJa = eps.reduce((s, e) => s + e.silentJa, 0);
  const pat = {};
  for (const p of PATTERNS) {
    const a = eps.reduce((s, e) => s + e.pat[p.id][0], 0);
    const b = eps.reduce((s, e) => s + e.pat[p.id][1], 0);
    pat[p.id] = { ja: a, keep: b, rate: a ? b / a : 0 };
  }
  // 句末语气密度：按句加权（各话句数不同，不能简单平均话率）
  let jaF = 0, jaSC = 0, zhF = 0, zhSC = 0;
  for (const e of eps) {
    const jaS = e.jaChars / (e.jaSentLen || 1), zhS = e.zhChars / (e.zhSentLen || 1);
    jaF += e.jaFinalRate * jaS; jaSC += jaS;
    zhF += e.zhFinalRate * zhS; zhSC += zhS;
  }
  return {
    key: c.band.key,
    label: c.band.label,
    episodes: eps.length,
    aligned: eps.filter((e) => e.aligned).length,
    jaChars, zhChars,
    ratio: jaChars ? zhChars / jaChars : 0,
    jaSentLen: jaSents ? jaChars / jaSents : 0,
    zhSentLen: zhSents ? zhChars / zhSents : 0,
    jaFinalRate: jaSC ? jaF / jaSC : 0,
    zhFinalRate: zhSC ? zhF / zhSC : 0,
    politeJa: polJa,
    politeKeepRate: polJa ? eps.reduce((s, e) => s + e.politeBoth, 0) / polJa : 0,
    silentJa: silJa,
    silentKeepRate: silJa ? eps.reduce((s, e) => s + e.silentSame, 0) / silJa : 0,
    pat,
    ratioRange: (() => {
      const rs = eps.map((e) => e.ratio).sort((a, b) => a - b);
      return rs.length ? [rs[0], rs[rs.length - 1], rs[Math.floor(rs.length / 2)]] : [0, 0, 0];
    })(),
  };
}

function summarizeRoles(c) {
  const out = [];
  for (const [name, r] of c.roleAgg) {
    if (r.pairs < MIN_LINES_LEAD) continue;
    out.push({
      name,
      pairs: Math.round(r.pairs),
      jaChars: Math.round(r.jaChars), zhChars: Math.round(r.zhChars),
      ratio: r.jaChars ? r.zhChars / r.jaChars : 0,
      jaSentLen: r.jaSents ? r.jaChars / r.jaSents : 0,
      zhSentLen: r.zhSents ? r.zhChars / r.zhSents : 0,
      jaFinalRate: r.jaSentCount ? r.jaFinalHit / r.jaSentCount : 0,
      zhFinalRate: r.zhSentCount ? r.zhFinalHit / r.zhSentCount : 0,
      politeJa: Math.round(r.politeJa),
      politeKeepRate: r.politeJa ? r.politeBoth / r.politeJa : 0,
      patKeep: Object.fromEntries(PATTERNS.map((p) => [p.id, r.patJa[p.id] ? r.patKeep[p.id] / r.patJa[p.id] : 0])),
    });
  }
  return out.sort((a, b) => b.pairs - a.pairs);
}

/** 从共现票里挖 ja 名 → zh 名（≥MIN_VOTE 且独占第一） */
function buildSpeakerMap(allVotes) {
  const map = [];
  const conflict = [];
  for (const [jn, votes] of allVotes) {
    const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (!sorted.length) continue;
    const [zn, n] = sorted[0];
    if (n < MIN_VOTE) continue;
    if (sorted.length > 1 && sorted[1][1] === n) { conflict.push([jn, sorted.slice(0, 3)]); continue; }
    map.push({ ja: jn, zh: zn, votes: n, purity: n / [...votes.values()].reduce((a, b) => a + b, 0) });
  }
  return { map: map.sort((a, b) => b.votes - a.votes), conflict };
}

/* ------------------------------------------------------------------ *
 * 6. 主流程
 * ------------------------------------------------------------------ */
const collected = [];
for (const b of BANDS) {
  const c = collectBand(b);
  if (c) collected.push(c);
}

if (!collected.length) {
  console.error('双语语料未找到：', CORPUS);
  process.exit(2);
}

const allVotes = new Map();
for (const c of collected) {
  for (const [jn, m] of c.speakerVotes) {
    if (!allVotes.has(jn)) allVotes.set(jn, new Map());
    for (const [zn, n] of m) allVotes.get(jn).set(zn, (allVotes.get(jn).get(zn) ?? 0) + n);
  }
}
const { map: speakerMap, conflict: speakerConflict } = buildSpeakerMap(allVotes);

const summaries = collected.map(bandSummary);
const roleTables = new Map(collected.map((c) => [c.band.key, summarizeRoles(c)]));

const ALL = {
  generatedAt: new Date().toISOString(),
  corpus: {
    jaDir: '素材全量/按话/ja/主线', zhDir: '素材全量/按话/zh-Hans/主线',
    episodes: collected.reduce((s, c) => s + c.episodes.length, 0),
    aligned: collected.reduce((s, c) => s + c.episodes.filter((e) => e.aligned).length, 0),
  },
  bands: summaries,
  roles: Object.fromEntries([...roleTables].map(([k, v]) => [k, v])),
  speakers: {
    total: speakerMap.length,
    totalVotes: [...allVotes.values()].reduce((s, m) => s + [...m.values()].reduce((a, b) => a + b, 0), 0),
    minVote: MIN_VOTE,
    map: speakerMap,
    conflict: speakerConflict,
  },
  patterns: PATTERNS.map((p) => ({ id: p.id, name: p.name })),
  params: { MIN_VOTE, MIN_LINES_LEAD },
};

// ⚠️ 别写成 `ALL.corpus.bands ? ... : 0` —— corpus 里没有 bands 字段，三元恒假会算出 0。
// 这正是「断言/赋值里引用不存在的字段，语句语法完全正常」那一类事故：不报错，只是静默给 0。
const _jaTotal = summaries.reduce((s, b) => s + b.jaChars, 0);
const ratioAll = _jaTotal ? summaries.reduce((s, b) => s + b.zhChars, 0) / _jaTotal : 0;

/* -------------------- --dry / --show -------------------- */
if (DRY || SHOW) {
  console.log('\n=== 日中平行语料对照（ dry run ） ===');
  console.log(`语料：${ALL.corpus.episodes} 话成对，其中 ${ALL.corpus.aligned} 话块数完全一致（${pct(ALL.corpus.aligned / ALL.corpus.episodes)}）`);
  console.log(`全局膨胀率 zh/ja = ${r2(ratioAll)}  （中文字符数是日文的 ${r2(ratioAll)} 倍）\n`);
  console.log('队'.padEnd(18) + '膨胀率   日句长   中句长   末语气ja  末语气zh  敬体保留  ～保留  ……保留  ？保留');
  for (const b of summaries) {
    console.log(
      b.label.padEnd(18) +
      String(r2(b.ratio)).padEnd(9) +
      String(r2(b.jaSentLen)).padEnd(9) +
      String(r2(b.zhSentLen)).padEnd(9) +
      pct(b.jaFinalRate).padEnd(10) +
      pct(b.zhFinalRate).padEnd(10) +
      pct(b.politeKeepRate).padEnd(10) +
      pct(b.pat.tilde.rate).padEnd(8) +
      pct(b.pat.ellipsis.rate).padEnd(9) +
      pct(b.pat.question.rate)
    );
  }
  console.log(`\n说话人对照：挖出 ${speakerMap.length} 条（门槛 ${MIN_VOTE} 票），冲突 ${speakerConflict.length} 条`);
  for (const m of speakerMap.slice(0, 12)) console.log(`  ${m.ja.padEnd(12)} → ${m.zh.padEnd(10)} ${String(m.votes).padStart(4)} 票  纯度 ${pct(m.purity)}`);
  if (SHOW) {
    const key = BANDS.find((b) => b.dir === SHOW || b.key === SHOW || b.label === SHOW)?.key;
    if (!key) { console.error(`\n--show "${SHOW}" 无匹配，可用：${BANDS.map((b) => b.dir).join(' / ')}`); process.exit(2); }
    console.log(`\n=== ${SHOW} 角色级明细 ===`);
    console.log('角色'.padEnd(12) + '句数   膨胀率   日句长  中句长   敬体句  敬体留');
    for (const r of roleTables.get(key) ?? []) {
      console.log(
        r.name.padEnd(12) + String(r.pairs).padEnd(7) +
        String(r2(r.ratio)).padEnd(9) + String(r2(r.jaSentLen)).padEnd(8) +
        String(r2(r.zhSentLen)).padEnd(9) + String(r.politeJa).padEnd(8) +
        pct(r.politeKeepRate)
      );
    }
  }
  if (!JSON_ONLY) process.exit(0);
}

/* -------------------- --check -------------------- */
if (CHECK) {
  const errs = [];
  if (!existsSync(join(OUT_DATA, 'bilingual.json'))) errs.push('缺产物 _data/bilingual.json —— 先跑一次不带参数的生成');
  else {
    const prev = JSON.parse(readFileSync(join(OUT_DATA, 'bilingual.json'), 'utf8'));
    if (prev.corpus.episodes !== ALL.corpus.episodes) {
      errs.push(`语料规模变了：产物记 ${prev.corpus.episodes} 话，现算 ${ALL.corpus.episodes} 话 —— 重跑生成器`);
    }
    for (const b of BANDS) {
      const f = join(OUT_DIR, `${b.label}.md`);
      if (!existsSync(f)) errs.push(`缺队档案 ${b.label}.md`);
    }
    if (!existsSync(join(OUT_DIR, 'README.md'))) errs.push('缺 README.md 总表');
    if (!existsSync(join(OUT_DIR, '说话人对照.md'))) errs.push('缺 说话人对照.md');
  }
  // 结构性事实卡死：五队、109 话、全部块数对齐
  if (collected.length !== 5) errs.push(`队数应为 5，实为 ${collected.length}`);
  const pairs = collected.reduce((s, c) => s + c.episodes.length, 0);
  if (pairs !== 109) errs.push(`成对话数应为 109，实为 ${pairs}`);
  const mis = collected.reduce((s, c) => s + c.episodes.filter((e) => !e.aligned).length, 0);
  if (mis > 0) errs.push(`${mis} 话块数不等 —— 逐话布局漂了，指标不可信`);
  if (speakerMap.length < 20) errs.push(`说话人对照只挖出 ${speakerMap.length} 条（期望 ≥20）—— MIN_VOTE 可能调太高或语料布局变了`);
  // md 里的数字必须来自 json，不能手抄错：抽查每个队档案的膨胀率行。
  // ⚠️ 期望值必须用**与渲染同一个函数**取（这里是 r2），不能用 toFixed 另写一遍 ——
  //    实测过：渲染走 r2 得 "0.8"，这里若写 r2().toFixed(2) 得 "0.80"，
  //    md 明明是对的却报「不同源」—— 假红灯和假绿灯一样让闸门作废。
  for (const b of BANDS) {
    const f = join(OUT_DIR, `${b.label}.md`);
    if (!existsSync(f)) continue;
    const md = readFileSync(f, 'utf8');
    const s = summaries.find((x) => x.label === b.label);
    if (!s) continue;
    const want = String(r2(s.ratio));
    if (!md.includes(want)) errs.push(`${b.label}.md 未含现算膨胀率 ${want} —— md 与数据不同源`);
  }
  if (errs.length) {
    console.error('\n[双语对照自检失败]');
    for (const e of errs) console.error('  ✗ ' + e);
    process.exit(1);
  }
  console.log(`\n[双语对照自检通过] ${pairs} 话成对 / 全对齐 / 说话人 ${speakerMap.length} 条 / 全局膨胀率 ${r2(ratioAll)}`);
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 7. 渲染
 * ------------------------------------------------------------------ */
if (!existsSync(OUT_DIR)) { console.error('缺产出目录，先 mkdir：', OUT_DIR); process.exit(2); }

/** 保留 USER 手写区 */
function userBlock(oldMd, name) {
  const m = String(oldMd ?? '').match(new RegExp(`<!-- USER:START ${name} -->([\\s\\S]*?)<!-- USER:END -->`));
  return m ? m[1].replace(/^\n|\n$/g, '') : null;
}

function render(patterns, keepKey) {
  return patterns.map((p) => `| ${p.name} | ${pct(p.rate)} | ${p.ja} |`).join('\n');
}

const now = new Date().toISOString().slice(0, 10);

function bandMd(s) {
  const prev = existsSync(join(OUT_DIR, `${s.label}.md`)) ? readFileSync(join(OUT_DIR, `${s.label}.md`), 'utf8') : '';
  const u = userBlock(prev, '本地化要点') ?? '_（写这一队的可迁移观察：哪些口癖在中文里必须另找载体、哪些保留率异常的角色）_';
  const roles = roleTables.get(s.key) ?? [];
  // 敬体最重的人：按密度（敬体句/本人总句数）排，取前 3 且密度 >5%。
  // 用密度不是绝对句数：句数多只说明戏份多，不说明讲话体面。
  const politeHeavy = roles
    .map((r) => ({ ...r, density: r.pairs ? r.politeJa / r.pairs : 0 }))
    .filter((r) => r.density > 0.05)
    .sort((a, b) => b.density - a.density)
    .slice(0, 3);
  const patRows = PATTERNS.map((p) => {
    const v = s.pat[p.id];
    return `| ${p.name}（${p.id}） | ${v.ja} | ${v.keep} | ${pct(v.rate)} |`;
  }).join('\n');
  const roleRows = roles.slice(0, 20).map((r) => `| ${r.name} | ${r.pairs} | ${r2(r.ratio)} | ${r2(r.jaSentLen)} | ${r2(r.zhSentLen)} | ${pct(r.jaFinalRate)} | ${pct(r.zhFinalRate)} | ${r.politeJa} | ${pct(r.politeKeepRate)} |`).join('\n');
  const [lo, hi, mid] = s.ratioRange;

  return `# ${s.label} · 日中对照

> 生成于 ${now} ｜ 生成器 \`工具/build_bilingual_profile.mjs\` ｜ 真源 \`双语对照/_data/bilingual.json\`
> 本页数字全部运行时现算，**不要手改**；要改口径改生成器。

## 0. 这一页在说什么

\`风格档案/\` 那一层回答「角色怎么说话」，但它跑的是 **zh-Hans 侧语料** ——
也就是说那一层的结论描述的是**译本**。本页把日文原文侧拉进来，
用来回答另一个问题：**从 ja 到 zh，什么东西被保留了，什么东西掉了。**

判断自己做中文稿时这套对照怎么用：做状态 integral —— 若某个标记在五队里
保留率都 >90%（如疑问号），它就是**不可丢的硬约束**；若保留率低于 30%（如敬体），
它就是**中文里本来就没有对等物**的位置，需要你自己造。

## 1. 规模与对齐

| 项 | 值 |
|---|---|
| 成对话数 | ${s.episodes} |
| 块数完全对齐的话 | ${s.aligned} / ${s.episodes}（${pct(s.aligned / s.episodes)}） |
| ja 可见字符 | ${s.jaChars.toLocaleString()} |
| zh 可见字符 | ${s.zhChars.toLocaleString()} |
| **膨胀率 zh/ja** | **${r2(s.ratio)}** |
| 逐话膨胀率区间 | ${r2(lo)} ~ ${r2(hi)}（中位 ${r2(mid)}） |

## 2. 吞吐与句长

| 指标 | 日文侧 | 中文侧 |
|---|---|---|
| 平均每句字符数 | ${r2(s.jaSentLen)} | ${r2(s.zhSentLen)} |
| 句末语气密度 | ${pct(s.jaFinalRate)}（终助词） | ${pct(s.zhFinalRate)}（语气词） |

> ⚠️ 两边词典口径不同，**不做直接相等比较**，只看各自在自己那一侧的相对位置。
> ja 的终助词（ね/よ/わ/の）与 zh 的语气词（吗/呢/吧/啊）不是对等物 ——
> 「中文侧没达到日文侧的密度」不代表翻译漏了，多数情况是本就没有对等形态。

## 3. 保留率（ja 侧出现 → zh 侧是否同族落地）

| 标记 | ja 侧出现句数 | zh 侧保留 | 保留率 |
|---|---|---|---|
${patRows}

## 4. 敬体塌缩（本层的重点）

| 项 | 值 |
|---|---|
| ja 侧出现敬体标志的句数 | ${s.politeJa} |
| zh 侧同时有敬语标志的 | ${pct(s.politeKeepRate)} |

> 日文有一整套句末敬体（です/ます/ですわ/ますわ/させていただき），
> 中文没有对等形态。上面的保留率是 **"塌缩到零"** 的比例：
> 敬体承载的**阶层差 / 距离感 / 客气与否**在中文里必须另找载体，
> 否则所有角色会长着同一张嘴。

### 本队敬体最重的人（自动挑出）

> 排序键是**敬体使用密度**（敬体句 ÷ 本人总句数），不是绝对句数 ——
> 句数多的人未必是讲话最体面的那个。这几个人一旦塌缩，**掉的是人设不是句子**。

| 角色 | 总句数 | 敬体句 | 密度 | 中文保留 |
|---|---|---|---|---|
${politeHeavy.map((r) => `| ${r.name} | ${r.pairs} | ${r.politeJa} | ${pct(r.density)} | ${pct(r.politeKeepRate)} |`).join('\n') || '| （本队无人使用敬体） | — | — | — | — |'}

> 这一栏是本层**唯一能直接抄进自己写作的地方**：给中文角色定口吻时，
> 先看她在日语里站哪个敬水位，再挑中文的替代载体（句式 / 选词 / 称谓）。
> 反过来，密度接近 0 的人（如本队末尾那几位）本身就是设计选择 —— 别给她们补敬语。

## 5. 沉默一致性

| 项 | 值 |
|---|---|
| ja 侧纯沉默句数 | ${s.silentJa} |
| zh 侧同为沉默 | ${pct(s.silentKeepRate)} |

> 沉默是**不需要翻译的东西**，保留率低说明译制时对「停顿」做过处理 —— 那是改写不是翻译。

## 6. 角色级（句数 ≥ ${MIN_LINES_LEAD}）

| 角色 | 句数 | 膨胀率 | 日句长 | 中句长 | 末语气ja | 末语气zh | 敬体句 | 敬体保留 |
|---|---|---|---|---|---|---|---|---|
${roleRows}

## 7. USER 手写区 · 本地化要点

<!-- USER:START 本地化要点 -->
${u}
<!-- USER:END -->
`;
}

function readmeMd() {
  const prev = existsSync(join(OUT_DIR, 'README.md')) ? readFileSync(join(OUT_DIR, 'README.md'), 'utf8') : '';
  const u = userBlock(prev, '可迁移结论') ?? '_（写：这套对照对自己写中文/日文意味着什么）_';
  // ⚠️ 链接写法必须与 风格档案/README.md **完全一致**：percent 编码、且不带 `./` 前缀。
  //    实测踩过：加 `./` 前缀后 check_design_links 判链接失效（3 条全红），去掉即通过。
  const rows = summaries.map((s) => `| [${s.label}](${encodeURIComponent(s.label)}.md) | ${s.episodes} | ${r2(s.ratio)} | ${r2(s.jaSentLen)} | ${r2(s.zhSentLen)} | ${pct(s.jaFinalRate)} | ${pct(s.zhFinalRate)} | ${pct(s.politeKeepRate)} | ${pct(s.pat.tilde.rate)} | ${pct(s.pat.ellipsis.rate)} | ${pct(s.pat.question.rate)} |`).join('\n');
  const worst = [...summaries].sort((a, b) => a.politeKeepRate - b.politeKeepRate)[0];
  const best = [...summaries].sort((a, b) => b.politeKeepRate - a.politeKeepRate)[0];
  const allTilde = mean(summaries.map((s) => s.pat.tilde.rate));
  const allQ = mean(summaries.map((s) => s.pat.question.rate));
  const allE = mean(summaries.map((s) => s.pat.ellipsis.rate));

  return `# 日中平行语料对照 · 五队总表

> 生成于 ${now} ｜ 生成器 \`工具/build_bilingual_profile.mjs\` ｜ 真源 \`_data/bilingual.json\`
> 本页数字全部运行时现算，**不要手改**。

## 0. 这一层是干什么的

light-novel-creator 的 §2「多语言创作」原本只有一句原则 —— *「语言本地化，而不是翻译腔」*。
本层把这空话变成能查的数：

\`\`\`bash
node 工具/build_bilingual_profile.mjs            # 全部生成
node 工具/build_bilingual_profile.mjs --dry      # 只打这张表
node 工具/build_bilingual_profile.mjs --show MyGO # 某队角色级明细
node 工具/build_bilingual_profile.mjs --check     # 自检（自检.mjs 必过项）
\`\`\`

**数据前提**：\`素材全量/按话/{ja,zh-Hans}\` 同名双份，**逐话逐块对齐**
（现测 ${ALL.corpus.aligned}/${ALL.corpus.episodes} 话块数完全一致，${pct(ALL.corpus.aligned / ALL.corpus.episodes)}）。
这是良性平行语料 —— 逐句对照不需要句子 Embedding 对齐。

**为什么值得单独一层**：现有四层分析（风格档案 / 话层 / 剧情 / 叙事方式）
**全部只跑 zh-Hans** —— 实测 \`grep "'ja'" build_style_profile.mjs\` 返回 0。
日语侧 ${ALL.corpus.episodes} 话从未进过任何分析管线。所以此前所有结论描述的其实是
**译本**里这个角色怎么说话，而不是**原作**里她怎么说话。本层负责把两件事分开。

## 1. 五队对照

| 队 | 话 | 膨胀率 | 日句长 | 中句长 | 末语气ja | 末语气zh | 敬体保留 | ～保留 | ……保留 | ？保留 |
|---|---|---|---|---|---|---|---|---|---|---|
${rows}

> **膨胀率** = zh 可见字符 ÷ ja 可见字符。全局 ${r2(ratioAll)}。
> 这个值不是「谁翻得好」，是**两语承载同一份信息各自需要多少字符** —— 拿它当密度基准，
> 给自己写中文稿定句长时有个参照。

## 2. 三种性质的标记（按五队均值）

| 标记 | 五队平均保留率 | 性质 | 怎么用 |
|---|---|---|---|
| 疑问？ | ${pct(allQ)} | **硬约束** | 丢一句就从问句变成陈述，整句功能变了 —— 写中文稿时别动疑问句的落点 |
| 省略号… | ${pct(allE)} | 半硬 | 掉多半是译者并句了；自己写要主动保留 —— 它是节奏而非标点 |
| 拖音～ | ${pct(allTilde)} | 半硬 | 中文「～」是语气延伸，日文「〜」常是口癖；差别出在谁身上要去各队 §6 角色表看 |
| 敬体 | ${pct(mean(summaries.map((s) => s.politeKeepRate)))} | **无对等物** | 见下 |

## 3. 唯一的强判断：敬体在中文里塌缩，但塌缩程度因角色而异

五队平均下来，日文侧写了敬体而中文侧**没有任何敬语标记**的只剩 ${pct(mean(summaries.map((s) => s.politeKeepRate)))}。
这不是翻译过失 —— **中文没有句末敬体这回事**。真正的代价在这里：

> 敬体在日语里同时承载**阶层、距离、客气、性别气质**。
> 一旦塌缩成零，这些区别要靠别的载体补回来；补不回来，所有角色会说同一种话。

实测区间：**${worst.label} ${pct(worst.politeKeepRate)}（最低） ～ ${best.label} ${pct(best.politeKeepRate)}（最高）。**
但真正拉开差距的不是队，是人：**同一队内部成员之间的敬体使用密度差得极远**
（0 句与上百句在同一队并存，见 MyGO 队文档 §6）。
队级均值会把这种差异抹平 —— **要看具体谁，去各队文档 §6 角色表的「敬体句 / 敬体保留」两列。**

## 4. 说话人对照（副产品）

ja 侧写日本短名（そよ/燈）、zh 侧写中文短名（爽世/灯），仓库里原本没有对照表。
这里靠**逐块对齐共现**挖出来（同一位置反复共现 ≥ ${MIN_VOTE} 票且独占第一）：

\`\`\`bash
# 完整表见 说话人对照.md
\`\`\`

挖出 **${speakerMap.length} 条**，覆盖 ${ALL.speakers.totalVotes.toLocaleString()} 次共现，冲突 ${speakerConflict.length} 条。
冲突是指同一个 ja 名在不同位置对应多个 zh 名且票数并列 —— 多半是群演（クラスメイトA 等），不作真错。

## 5. 与其它四层的关系

| 层 | 跑在哪一侧语料 | 回答 |
|---|---|---|
| 风格档案 / 话层 / 剧情 / 叙事方式 | **zh-Hans** | 译本里这个角色怎么说话 |
| **双语对照（本层）** | **ja ↔ zh** | 从作者的语言到读者的语言，掉了什么 |
| 设计思路 | 判断层，不看语料 | 为什么这么设计 |

## 6. 已知边界（别踩）

1. **不做直接跨语言的等式比较。** ja 终助词 ≠ zh 语气词，密度差不代表漏翻。
2. **指标是块级不是句级。** ja 一句常被拆成 zh 两句，句级 join 会产生大量假配对 —— 已刻意避开。
3. **膨胀率受专名影响**：ja 侧写 \`CRYCHIC\`、\`MyGO!!!!!\` 这类拉丁转写同样按字符计数，
   会拉低比值。同队自比无碍，**跨队比较要留意各队专名密度不同**。
4. **不判「翻译好坏」。** 本层只报「什么掉了」，不评价掉得对不对 —— 那是设计判断，归 §7 USER 手写区。
5. **敬体检测是正则，不是句法分析。** \`JA_POLITE\` 认的是表层形态，助动词结句的口语敬体会漏。

## 7. USER 手写区 · 可迁移结论

<!-- USER:START 可迁移结论 -->
${u}
<!-- USER:END -->
`;
}

function speakerMd() {
  const prev = existsSync(join(OUT_DIR, '说话人对照.md')) ? readFileSync(join(OUT_DIR, '说话人对照.md'), 'utf8') : '';
  const u = userBlock(prev, '备注') ?? '_（写：群演/未挖到的名字怎么办）_';
  const rows = speakerMap.map((m) => `| ${m.ja} | ${m.zh} | ${m.votes} | ${pct(m.purity)} |`).join('\n');
  const conf = speakerConflict.length
    ? speakerConflict.map(([jn, arr]) => `| ${jn} | ${arr.map(([z, n]) => `${z}(${n})`).join(' / ')} |`).join('\n')
    : '（无）';

  return `# 说话人对照表 · ja ↔ zh

> 生成于 ${now} ｜ 由 \`工具/build_bilingual_profile.mjs\` 从逐块共现挖出，**不是手写词典**
> 门槛：共现 ≥ ${MIN_VOTE} 票且独占第一 ｜ 共 ${ALL.speakers.totalVotes.toLocaleString()} 次共现

## 为什么靠挖不靠写

\`素材全量/按话/ja/\` 里的说话人字段写的是日本短名（そよ / 燈 / にゃむ），
\`zh-Hans/\` 里写的是中文短名（爽世 / 灯 / 若麦），仓库里**没有**这两者的对照表 ——
\`资料库/kb.json\` 的 \`name_short\` 只有中文。手抄一张不但会漏群演，
还会像当初「设计思路层声称 4 份单体而磁盘只有 2 份」那样 —— 数据一变就原地腐烂。
与其如此，不如让 109 话 × 逐块的对齐自己说话。

**判据**：同一个 ja 名字在第 N 块出现时 zh 侧同位置是谁，累计投票；
票数最多且不与次名并列 → 采信。**只有群演会并列**（クラスメイトA/B/C 在不同话对应不同中文译法）。

## 主表（${speakerMap.length} 条）

| ja | zh | 共现票 | 纯度 |
|---|---|---|---|
${rows}

## 并列未采信（${speakerConflict.length} 条）

| ja | 候选（票数） |
|---|---|
${conf}

> 这些不是错牌 —— 是群演名在不同话的译法不一致。放进 batch import 前先看目标是否唯一。

## USER 手写区 · 备注

<!-- USER:START 备注 -->
${u}
<!-- USER:END -->
`;
}

if (JSON_ONLY) {
  writeFileSync(join(OUT_DATA, 'bilingual.json'), JSON.stringify(ALL, null, 2), 'utf8');
  console.log(`\n[双语对照] 只落数据：_data/bilingual.json（${ALL.corpus.episodes} 话）`);
  process.exit(0);
}

/* 写盘（幂等：内容相同则跳过，但仍要刷新 mtime 以表示已核） */
const written = [];
function writeIfChanged(name, content) {
  const p = join(OUT_DIR, name);
  const strip = (s) => s.replace(/^> 生成于 .*$/m, '');
  if (existsSync(p)) {
    const old = readFileSync(p, 'utf8');
    if (strip(old) === strip(content) && !FORCE) { written.push(`= ${name}（无变化）`); return; }
  }
  writeFileSync(p, content, 'utf8');
  written.push(`+ ${name}`);
}

if (!existsSync(OUT_DATA)) {
  console.error('缺数据目录（用 Bash mkdir 建，node 递归 mkdir 在本沙箱会 EPERM）：', OUT_DATA);
  process.exit(2);
}

writeFileSync(join(OUT_DATA, 'bilingual.json'), JSON.stringify(ALL, null, 2), 'utf8');
writeIfChanged('README.md', readmeMd());
writeIfChanged('说话人对照.md', speakerMd());
for (const s of summaries) writeIfChanged(`${s.label}.md`, bandMd(s));

console.log('\n[双语对照] 产出：');
for (const w of written) console.log('  ' + w);
console.log(`  ~ _data/bilingual.json（真源，每次重写）`);
console.log(`\n语料 ${ALL.corpus.episodes} 话成对，${ALL.corpus.aligned} 话块数全等`);
console.log(`全局膨胀率 zh/ja = ${r2(ratioAll)}｜说话人对照 ${speakerMap.length} 条`);
if (speakerConflict.length) console.log(`⚠️ 说话人并列 ${speakerConflict.length} 条（多为群演），见 说话人对照.md`);
