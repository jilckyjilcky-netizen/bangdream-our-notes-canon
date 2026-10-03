#!/usr/bin/env node
/**
 * name-index.mjs —— 《BanG Dream! Our Notes》资料库 · 中日姓名解析索引（v1.3 新增）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * 库里所有实体的主键是**简称**（初华 / 祥子 / 睦），而中日语境下人会这样写：
 *   全名   三角初华 / 三角 初華
 *   只写姓 三角
 *   只写名 初华（已经是主键，OK）
 *   舞台名 Doloris / ドロリス / Oblivionis
 *   罗马音 Uika Misumi / Misumi Uika / uika
 *   和制汉字 豊川祥子 / 汐見蛍 / 長崎そよ / 祐天寺にゃむ
 * v1.2 的 resolveChar 只做「简称精确 + 拼接串包含」，于是「三角初华」直接查不到——
 * 这是**索引缺口**，不是调用方的错。
 *
 * ── 数据来源（权威优先，全部可追溯） ──────────────────────────
 *   1. 工具/素材提取/aliases.json —— 由 <上游域已移除> 的 MasterBand + MasterCharacter 生成：
 *      官方全名（Ave Mujica 形如 "Doloris / 三角初华"）、简称、日文名、舞台名。**姓与全名的唯一权威来源。**
 *   2. 资料库/kb.json 角色字段 —— id / name（含括注）/ name_short / en（罗马音全名）/ aliases / stage。
 *   3. 由 1+2 **推导**：姓 = 全名去掉简称（三角初华 − 初华 = 三角），日文同理；罗马音按
 *      "Given Family" 拆出 given / family 并给出反序写法。
 *   4. 手写补充（MANUAL_*）：只放**推导拿不到**的东西——和制新字体（沢/浜/桜）与通用繁体，
 *      以及语料里确凿的昵称（小祥）。凡是能从 1/2 推出来的一律不手写，避免第二份真相。
 *
 * ── 简繁与和制汉字怎么折叠 ────────────────────────────────────
 *   aliases.json 每条同时给了 zh 与 ja 两种写法，**等长**时逐字对齐即可得到权威字对
 *   （長→长、豊→丰、葉→叶、蛍→萤）；含假名的位置跳过（"长崎爽世" vs "長崎そよ" 的
 *   爽/そ 不是字对，不能当映射）。不等长的（伊沢 なつめ vs 伊泽枣、浜崎 まほろ vs 滨崎茉幌）
 *   推导不到，进 MANUAL_FOLD。
 *   折叠方向统一到 **kb 用的简体中文形**，于是简繁日三种写法都能落到同一个键。
 *
 * ── 解析分级（tier 越小越权威；同级多命中 = 歧义，如实回报，不猜） ──
 *   0 主键：id / 简称 / kb.aliases
 *   1 全名：中文全名 / 日文全名 / kb.name（带括注）/ 官方 "舞台名 / 本名" 串 /
 *           舞台名（拉丁 + 片假名）/ 罗马音全名（两种语序）
 *   2 部位：姓 / 日文姓 / 罗马音 given / 罗马音 family
 *   3 兜底：唯一子串命中（"祥" → 祥子）；一旦候选跨多个角色就报歧义
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const HERE = dirname(fileURLToPath(import.meta.url));
/** 默认权威别名表（素材提取工具生成；缺失时自动降级为仅 kb.json，并在 stats 里如实说明）。 */
export const DEFAULT_ALIASES_PATH = resolve(HERE, '..', '工具', '素材提取', 'aliases.json');

const HAN = /^[\u3400-\u9fff\u3005\u3006\uf900-\ufaff]$/;
const SEPARATORS = /[\s\u00a0\u3000\u30fb\u00b7\u2027\u2022・·、，,。.．;；:：!！?？"'“”‘’（）()【】\[\]{}<>《》「」『』/／\\|｜~〜～\-—–_+=*#@&^%$`]+/g;

/**
 * 手写补充字对：**只放数据推导不到的**。
 *  · 和制新字体（日本新字体与中文简繁都不同形）：沢→泽、浜→滨、桜→樱、広→广、辺→边、
 *    斉→齐、姫→姬、曽→曾、増→增、恵→惠、徳→德
 *  · 通用繁体（库里没出现过，但用户会打）：國/學/實/壽/榮/義/禮/靜/龍/竜
 * 三角初華、豊川祥子、汐見蛍、長崎そよ 这类由 aliases.json 的 zh/ja 字对自动推出，不在此列。
 */
export const MANUAL_FOLD = {
  沢: '泽', 浜: '滨', 濱: '滨', 桜: '樱', 櫻: '樱', 棗: '枣', 広: '广', 辺: '边', 斉: '齐', 姫: '姬',
  曽: '曾', 増: '增', 恵: '惠', 徳: '德',
  國: '国', 學: '学', 實: '实', 壽: '寿', 榮: '荣', 義: '义', 禮: '礼', 靜: '静',
  龍: '龙', 竜: '龙',
};

/** 手写补充别名：语料里确凿的称呼（推导不出来）。键会被同一套归一化处理。 */
export const MANUAL_ALIASES = {
  小祥: '祥子', 小睦: '睦', 小灯: '灯', 小爱: '爱音',
};

/** 归一化：NFKC → 去变音符（Tōgawa → Togawa）→ 去分隔符 → 小写 → 折叠简繁/和制。 */
export function makeNormalizer(fold = {}) {
  return (input) => {
    if (input == null) return '';
    let s = String(input).normalize('NFKC').normalize('NFD').replace(/\p{M}+/gu, '');
    s = s.replace(SEPARATORS, '').toLowerCase();
    return [...s].map((ch) => fold[ch] || ch).join('');
  };
}

/** 从 aliases.json 的 zh/ja 对照里**推导**字对（等长逐字对齐，假名位置跳过）。 */
export function deriveFoldPairs(aliasDoc) {
  const fold = {};
  const pair = (zhRaw, jaRaw) => {
    if (!zhRaw || !jaRaw) return;
    const zh = String(zhRaw).replace(SEPARATORS, '');
    const ja = String(jaRaw).replace(SEPARATORS, '');
    if (!zh || !ja || zh.length !== ja.length) return;
    for (let i = 0; i < zh.length; i++) {
      const [a, b] = [zh[i], ja[i]];
      if (a === b || !HAN.test(a) || !HAN.test(b)) continue; // 汉字 vs 汉字才成对；假名跳过
      fold[b] = a; // 折叠方向：日文形 → 简体中文形
    }
  };
  for (const c of aliasDoc?.characters || []) {
    pair(c.real, c.realJa);
    pair(c.short, c.shortJa);
  }
  return fold;
}

/** aliases.json 的角色行与 kb 角色按简称/全名对齐。 */
function matchAliasRow(row, characters) {
  const byShort = characters.find((c) => c.name_short === row.short);
  if (byShort) return byShort;
  return characters.find((c) => row.real && row.real.endsWith(c.name_short)) || null;
}

/** 姓 = 全名去掉简称（三角初华 − 初华 = 三角）；推不出返回 null。 */
function familyOf(real, short) {
  if (!real || !short || real === short) return null;
  if (real.endsWith(short)) return real.slice(0, real.length - short.length) || null;
  const i = real.indexOf(short);
  if (i >= 0) return (real.slice(0, i) + real.slice(i + short.length)) || null;
  return null; // 对不上就不猜
}

/**
 * 建索引。返回 { resolve, suggest, bandHint, normalize, stats }。
 * characters 必须是 kb.characters（返回值直接给调用方当实体用）。
 */
export function createCharResolver({
  characters,
  aliasesPath = DEFAULT_ALIASES_PATH,
  manualFold = MANUAL_FOLD,
  manualAliases = MANUAL_ALIASES,
} = {}) {
  let aliasDoc = null, aliasSrc = '缺失（仅 kb.json：无全名/日文名/舞台名日文）';
  if (aliasesPath && existsSync(aliasesPath)) {
    try { aliasDoc = JSON.parse(readFileSync(aliasesPath, 'utf8')); aliasSrc = aliasesPath; } catch { /* 坏文件按缺失处理 */ }
  }
  const fold = { ...deriveFoldPairs(aliasDoc), ...manualFold };
  const norm = makeNormalizer(fold);

  /** key -> [{ char, tier, via }]，同一角色同一 key 只留最权威的一条。 */
  const entries = new Map();
  const add = (char, raw, tier, via) => {
    const key = norm(raw);
    if (!key) return;
    const list = entries.get(key) || [];
    if (list.some((e) => e.char === char && e.tier <= tier)) return;
    const i = list.findIndex((e) => e.char === char);
    if (i >= 0) list[i] = { char, tier, via }; else list.push({ char, tier, via });
    entries.set(key, list);
  };

  const aliasRowByChar = new Map();
  for (const row of aliasDoc?.characters || []) {
    const c = matchAliasRow(row, characters);
    if (c) aliasRowByChar.set(c, row);
  }

  for (const c of characters) {
    const row = aliasRowByChar.get(c) || {};
    /* tier 0 · 主键 */
    add(c, c.id, 0, 'id');
    add(c, c.name_short, 0, '简称');
    for (const a of c.aliases || []) add(c, a, 0, '别名');
    /* tier 1 · 全名与舞台名 */
    add(c, c.name, 0, 'kb.name');                       // "初华（Doloris / Uika Misumi）"
    add(c, row.real, 1, '全名(中文)');
    add(c, row.realJa, 1, '全名(日文)');
    add(c, row.full, 1, '官方名(舞台名/本名)');
    add(c, row.shortJa, 0, '简称(日文)');
    for (const n of [row.stageName, row.stageNameJa, c.stage]) add(c, n, 1, '舞台名');
    /* tier 1/2 · 罗马音 */
    const rom = String(c.en || '').split(/\s+/).filter(Boolean);
    if (rom.length >= 2) {
      add(c, rom.join(' '), 1, '罗马音');
      add(c, [...rom].reverse().join(' '), 1, '罗马音(日文语序)');
      add(c, rom[0], 2, '罗马音 given');
      add(c, rom[rom.length - 1], 2, '罗马音 family');
    } else if (rom.length === 1) add(c, rom[0], 1, '罗马音');
    /* tier 2 · 姓 */
    const fam = familyOf(row.real, c.name_short);
    const famJa = familyOf(String(row.realJa || '').replace(SEPARATORS, ''), String(row.shortJa || '').replace(SEPARATORS, ''));
    add(c, fam, 2, '姓(中文)');
    add(c, famJa, 2, '姓(日文)');
  }

  /* 手写昵称 */
  for (const [alias, short] of Object.entries(manualAliases)) {
    const c = characters.find((x) => x.name_short === short);
    if (c) add(c, alias, 0, '昵称(手写)');
  }

  const uniq = (list) => {
    const seen = new Map();
    for (const e of list) if (!seen.has(e.char.id)) seen.set(e.char.id, e);
    return [...seen.values()];
  };
  const found = (list, tier, via) => {
    const u = uniq(list);
    if (u.length === 1) return { char: u[0].char, tier: u[0].tier ?? tier, via: u[0].via ?? via };
    return { ambiguous: u }; // 同级多命中：不猜
  };

  /** 解析：返回 {char,tier,via} | {ambiguous:[…]} | null */
  function resolve(raw) {
    const key = norm(raw);
    if (!key) return null;
    /* 1) 精确键（tier 由建立时决定，取该键下最权威的一条） */
    const exact = entries.get(key);
    if (exact) {
      const best = Math.min(...exact.map((e) => e.tier));
      const atBest = exact.filter((e) => e.tier === best);
      return found(atBest, best);
    }
    /* 2) 输入里含有某个键（"初华（Doloris / Uika Misumi）" / "初华小姐"）；最长键优先。
     *    **排除 tier 2（姓/罗马音 family）**：否则 "三角初雪" 会因为含"三角"被当成初华——
     *    姓是弱证据，只在**精确整串**时才算命中（"三角" 走 1) 精确键，不作子串猜测）。 */
    const contained = [];
    for (const [k, list] of entries) {
      if (k.length < 2 || !key.includes(k)) continue;
      const strong = list.filter((e) => e.tier !== 2);
      if (strong.length) contained.push([k, strong]);
    }
    if (contained.length) {
      const max = Math.max(...contained.map(([k]) => k.length));
      return found(contained.filter(([k]) => k.length === max).flatMap(([, list]) => list), 3, '子串(输入包含键)');
    }
    /* 3) 键里含有输入（"祥" → 祥子）；一旦跨角色就报歧义 */
    const hits = [];
    for (const [k, list] of entries) if (key.length >= 1 && k.includes(key)) hits.push(...list);
    if (hits.length) return found(hits.map((e) => ({ ...e, tier: 3, via: '子串' })));
    return null;
  }

  /** 找不到时的近似候选：按共享字数 + 长度差排序，返回简称列表。 */
  function suggest(raw, k = 5) {
    const key = norm(raw);
    if (!key) return characters.map((c) => c.name_short).slice(0, k);
    const chars = new Set([...key]);
    return characters
      .map((c) => {
        const keys = [c.name_short, ...(c.aliases || [])];
        let best = -1;
        for (const kk of keys) {
          const n = norm(kk);
          let share = 0;
          for (const ch of new Set([...n])) if (chars.has(ch)) share++;
          best = Math.max(best, share * 2 - Math.abs(n.length - key.length) * 0.1);
        }
        return { name: c.name_short, score: best };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.name);
  }

  /** 传进来的是乐队名时给出成员名单——比丢一句"未找到角色"有用。 */
  function bandHint(raw) {
    const key = norm(raw);
    if (!key) return null;
    for (const b of aliasDoc?.bands || []) {
      if ([b.name?.zh, b.name?.ja, b.slug].some((n) => n && norm(n) === key)) {
        const members = [...aliasRowByChar.entries()].filter(([, r]) => r.band === b.name?.zh).map(([c]) => c.name_short);
        return { band: b.name?.zh, members };
      }
    }
    return null;
  }

  return {
    resolve,
    suggest,
    bandHint,
    normalize: norm,
    stats: () => ({
      键: entries.size,
      角色: characters.length,
      别名来源: aliasSrc,
      推导字对: Object.keys(deriveFoldPairs(aliasDoc)).length,
      手写字对: Object.keys(manualFold).length,
      手写昵称: Object.keys(manualAliases).length,
      分级: { '0_主键': 0, '1_全名': 1, '2_姓部位': 2, '3_子串兜底': 3 },
    }),
  };
}
