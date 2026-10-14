#!/usr/bin/env node
/**
 * 羁绊态度生成器 —— 羁绊剧不是「亲密度刻度」，而是「X 对 Y 的态度」
 *
 * 前提（用户指出）：羁绊剧情记录的不是两个人一起经历了什么，
 * 而是**一个人怎么看另一个人**。所以分析单元不是「对」，而是**方向** X→Y。
 * 50 对 → 100 个方向；同一对的两个方向可以完全不同（谁更需要谁、谁在仰望谁）。
 *
 * 五个可算维度（全部由脚本算，数字不进手写稿）：
 *   1 称呼     X 怎么叫 Y（自动挖掘：句首/句末候选 + 「下一句由 Y 接话」信号 + 独占性过滤）
 *   2 关注率   X 的台词里有多少行点名了 Y
 *   3 情绪偏移 Δv = X 提到 Y 时的效价 − X 其余时候的效价（对方让 X 变亮还是变沉）
 *   4 态度词   X 提到 Y 时命中哪类态度语义（感谢/依赖/赞赏/好意/关心/冲突/困惑/距离/共鸣）
 *   5 主导度   X 的台词占比、是否开场
 *
 * 产出（json 是真源，md 由本脚本渲染）：
 *   话层分析/_data/bond_attitude.json
 *   话层分析/羁绊态度.md
 *
 * 用法：
 *   node 工具/build_bond_attitude.mjs              # 算 + 渲染
 *   node 工具/build_bond_attitude.mjs --only 数据   # 只算 json
 *   node 工具/build_bond_attitude.mjs --check       # 自检
 *   node 工具/build_bond_attitude.mjs --dry         # 不落盘
 *   node 工具/build_bond_attitude.mjs --force       # 忽略时间戳强制重写
 *   node 工具/build_bond_attitude.mjs --show        # 打印称呼挖掘明细（调参用）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '话层分析');
const DATA = join(OUT, '_data');
const BOND_DIR = join(ROOT, '素材全量', '按话', 'ja', '羁绊剧情');
const EMOTION = join(ROOT, '资料库', '_emotion_lines.jsonl');
/* 极性表复用 剧情分析 的那份（真源），不复制一份以免两处维护 */
const POLARITY = join(ROOT, '剧情分析', '_data', 'emotion_polarity.json');
const MASTER_TEXT = join(ROOT, 'masterdata', 'master', 'MasterText.json');
const KB_JSON = join(ROOT, '资料库', 'kb.json');
const VOCAB = join(ROOT, '资料库', '_emotion_vocab.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const FORCE = argv.includes('--force');
const CHECK = argv.includes('--check');
const SHOW = argv.includes('--show');
const oi = argv.indexOf('--only');
const ONLY = oi >= 0 ? (argv[oi + 1] ?? '') : '';

/* ------------------------------------------------------------------ *
 * 公共：USER 块保留 / 幂等写入
 * ------------------------------------------------------------------ */
const USER_RE = /<!-- USER:START ([^>]+?) -->\n([\s\S]*?)<!-- USER:END -->/g;
function extractUserBlocks(text) {
  const m = new Map();
  for (const mt of text.matchAll(USER_RE)) m.set(mt[1], mt[2]);
  return m;
}
function applyUserBlocks(content, blocks) {
  if (!blocks || !blocks.size) return content;
  return content.replace(USER_RE, (full, name) =>
    blocks.has(name) ? `<!-- USER:START ${name} -->\n${blocks.get(name)}<!-- USER:END -->` : full
  );
}
const stripTs = (s) => s.replace(/^> 生成于.*$/m, '');
const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

let updated = 0, skipped = 0;
function writeFile(rel, content) {
  const abs = join(OUT, rel);
  let out = content;
  if (existsSync(abs)) out = applyUserBlocks(content, extractUserBlocks(readFileSync(abs, 'utf8')));
  const changed = !existsSync(abs) || FORCE || stripTs(readFileSync(abs, 'utf8')) !== stripTs(out);
  if (DRY) { console.log(`  ${changed ? '~' : '='} ${rel}${changed ? '（将写入）' : ''}`); return; }
  if (!changed) { skipped++; console.log(`  = 跳过  ${rel}`); return; }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, out, 'utf8');
  updated++;
  console.log(`  ✎ ${rel}`);
}

/* ------------------------------------------------------------------ *
 * 载入：kb 中文名 / MasterText 日文姓与名 / 极性表 / 逐句情绪
 * ------------------------------------------------------------------ */
function loadKb() {
  const kb = JSON.parse(readFileSync(KB_JSON, 'utf8'));
  const byId = new Map();
  for (const c of kb.characters) byId.set(c.id, c);
  const zhOf = (m) => byId.get(m)?.name_short || m;
  const bandOf = (m) => byId.get(m)?.band || '—';
  return { byId, zhOf, bandOf };
}

/* 日文姓 / 名：MasterText 的 Character_Name_X="高松 燈"（姓 名，带空格） */
function loadJaNames() {
  const raw = JSON.parse(readFileSync(MASTER_TEXT, 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.data ?? raw.entries ?? raw.list ?? Object.values(raw)[0]);
  const map = new Map();
  const set = (key, field, val) => {
    if (!val) return;
    const k = key.toLowerCase();
    if (!map.has(k)) map.set(k, {});
    map.get(k)[field] = val;
  };
  for (const o of arr) {
    const id = String(o._id ?? o.id ?? '');
    const jp = String(o._japanese ?? '');
    let m = id.match(/^Character_Name_(.+)$/);
    if (m && jp && !jp.includes('/')) {
      const key = m[1].replace(/^(Doloris|Mortis|Timoris|Amoris|Oblivionis)_/i, '');
      const parts = jp.split(/\s+/);
      if (parts.length >= 2) { set(key, 'last', parts[0]); set(key, 'first', parts.slice(1).join('')); }
    }
    m = id.match(/^Character_Short_Name_(.+)$/);
    if (m && jp) {
      const key = m[1].replace(/^(Doloris|Mortis|Timoris|Amoris|Oblivionis)_/i, '');
      set(key, 'first', jp);
    }
  }
  return map;
}

function baseOf(tag) {
  if (!tag) return null;
  let s = String(tag).replace(/_(L|C|R)$/i, '');
  s = s.replace(/\d+$/, '');
  return s.replace(/^(exp|mtn)_/, '');
}
function loadPol() {
  const j = JSON.parse(readFileSync(POLARITY, 'utf8'));
  return j.polarity ?? j;
}
/* 表情词根 → 中文释义（人工补的，conf 见 _emotion_vocab.json） */
function loadExpZh() {
  const j = JSON.parse(readFileSync(VOCAB, 'utf8'));
  const m = new Map();
  for (const v of Object.values(j.exp ?? {})) if (v.base && v.zh && !m.has(v.base)) m.set(v.base, v.zh);
  return m;
}

function loadBondLines() {
  const byAdv = new Map();
  for (const line of readFileSync(EMOTION, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.advId < 10459 || o.advId > 10608) continue;
    if (!byAdv.has(o.advId)) byAdv.set(o.advId, []);
    byAdv.get(o.advId).push(o);
  }
  for (const arr of byAdv.values()) arr.sort((a, b) => a.seq - b.seq);
  return byAdv;
}

/* 羁绊剧清单：剧本名 adv_script_{A}_{B}_linkstory_{lv} —— 顺序只是组合枚举，不代表视角 */
function scanBond() {
  const rows = [];
  for (const f of readdirSync(BOND_DIR)) {
    if (!f.endsWith('.md')) continue;
    const head = readFileSync(join(BOND_DIR, f), 'utf8').split('\n').slice(0, 8).join('\n');
    const adv = head.match(/advId\*\* (\d+)/);
    const sc = head.match(/adv_script_(.+?)_(.+?)_linkstory_(\d)/);
    if (!adv || !sc) continue;
    rows.push({ advId: +adv[1], x: sc[1], y: sc[2], lv: +sc[3], file: f });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * 称呼自动挖掘
 *   信号：X 说出一句，句首/句尾的候选串 T，且「下一句由 Y 接话」→ T 计一票
 *   过滤：① 同一串在 X 口中作句首出现 ≥2 次（一次性短语出局）
 *         ② 该串在该方向的票数占其全局票数 ≥0.6（独占性，剔除通用词）
 *         ③ 长度 2..6、非语气词、非自称
 * ------------------------------------------------------------------ */
const PUNCT = /[、。，．,.！!？?…‥「」『』（）()\s]/;
const FILLER = /^(ねえ|ねぇ|あの|あのー|あのね|えー|ええ|えっと|あー|うーん|うん|んー|ん〜|はぁ|はあ|ふふ|あはは|あは|えっ|あっ|おお|へえ|へえー|まぁ|まあ|いや|いえ|あら|ほら|ちょっと|そう|そうそう|じゃあ|それじゃ|あれ|これ|それ|だって|でも|だから|ところで|ってか|てか|なぁ|なあ|うー|わあ|へー|ふーん|ふうん|あーあ|はい|いいえ|え|おっ|うわ|ん|は|へ)/;
/* 尾部助词：剥掉它才能得到干净的称呼（「まほろさんは」→「まほろさん」） */
const TAIL_PART = /(なぁ|ねぇ|よね|かな|かも|かしら|でしょう|でしょ|ですか|ですね|でした|ました|です|だよ|だね|だけ|しか|ばかり|ってば|ったら|なんて|から|まで|より|って|は|が|の|に|を|も|へ|や|と|か|な|ね|よ|さ|で|だ)$/;
/* 敬称被长度截断后的残片，仅在串长 ≥4 时剥（短串可能是名字本身） */
const TAIL_TRUNC = /(ち|ちゃ|さ|せ|ね|よ|り)$/;
/* 通用词/自称/寒暄 —— 剥掉尾部助词后仍命中即剔除 */
const STOP = new Set(['私', 'わたし', '僕', 'ぼく', 'あたし', 'あっし', '自分', 'みんな', '皆', 'あなた', 'あんた', '君', 'きみ', 'お前', 'おまえ', 'あいつ', '彼女', '彼', '二人', '二人と', 'みなさん', '先生', '先輩', '後輩', '今日', '今日は', '今', '今度', '今回', '明日', '昨日', '本当', 'ほんと', 'ほんとに', 'やっぱ', 'やっぱり', 'だいじょうぶ', '大丈夫', 'ありがとう', 'ありがと', 'ごめん', 'ごめんなさい', 'すみません', 'すいません', 'おはよう', 'こんにちは', 'こんばんは', 'じゃあ', 'それじゃ', 'それで', 'だから', 'そして', 'でも', 'ただ', 'まあ', 'まぁ', 'いや', 'いえ', 'はい', 'いいえ', 'うん', 'うーん', 'えっと', 'なんで', 'どうして', 'どうも', 'ところで', 'すごい', 'すごく', 'とても', 'めっちゃ', 'かなり', 'ちょっと', '少し', 'たくさん', 'いっぱい', 'なるほど', 'という', 'なに', 'なん', 'これ', 'それ', 'あれ', 'この', 'その', 'あの', 'ここ', 'そこ', 'あそこ', 'そう', 'そうそう', 'ふうん', 'へえ',
  'アタシ', 'アタシは', 'アンタ', 'はん', 'なんです', 'です', '間違', '残念', '注文', '天気', 'ねこ', 'ライブ', '一本', 'あな', 'あなの', 'そうよ', 'あたしも', 'じゃーん', 'すまない', '生活']);
/* 拟声 / 连续延长音 / 叠字：这类串不是名字（单个 ー 不算，りっきー 这种爱称要留） */
const NOISE_RE = /[〜～]{1,}|ー{2,}|(\p{Script=Hiragana}|\p{Script=Katakana})\1/u;

function headOf(t) {
  let s = '';
  for (const ch of String(t ?? '')) {
    if (PUNCT.test(ch)) break;
    s += ch;
    if (s.length >= 8) break;
  }
  return s;
}
function tailOf(t) {
  const s = String(t ?? '');
  let i = -1;
  for (let k = s.length - 1; k >= 0; k--) { if (PUNCT.test(s[k])) { i = k; break; } }
  return i >= 0 ? s.slice(i + 1) : '';
}
function stripFiller(h) {
  let cur = h;
  for (let n = 0; n < 4; n++) {
    const m = cur.match(FILLER);
    if (!m) break;
    const rest = cur.slice(m[0].length);
    if (rest.length < 2) break;
    cur = rest;
  }
  return cur;
}
/* 候选：按标点把整句切开，每个片段都是候选（呼语常在中段：「あっ、ともりん、いたいた！」）
   句首片段额外取 2..7 前缀，用来对付 8 字截断 */
function candsOf(text) {
  const out = new Set();
  const segs = String(text ?? '').split(/[、。，．,.！!？?…‥「」『』（）()\s]+/).filter(Boolean);
  const add = (v, withPrefix) => {
    if (!v) return;
    /* 语气词要剥，但不能把名字剥掉：「あのちゃん」里的「あの」是名，不是语气词 */
    const peeled = stripFiller(v);
    const keepRaw = peeled === v || peeled.length < 3 || /^(ちゃん|さん|くん|っち|様)/.test(peeled);
    for (const h of keepRaw ? [v] : [v, peeled]) {
      if (h.length < 2) continue;
      if (h.length <= 8) out.add(h);
      if (withPrefix) for (let L = 2; L <= Math.min(7, h.length); L++) out.add(h.slice(0, L));
      if (h.length >= 3) {
        const cut = h.replace(TAIL_PART, '');
        if (cut.length >= 2 && cut !== h) out.add(cut);
      }
    }
  };
  segs.forEach((s, i) => add(s.slice(0, 8), i === 0));
  return [...out].filter((t) => !NOISE_RE.test(t));
}

function mineAddress(rows, byAdv, kb) {
  const respOf = new Map();   // "X>Y" -> Map(tok -> n)
  const headOcc = new Map();  // model -> Map(tok -> n) 该 model 口中作句首出现次数
  const bump = (m, k, v = 1) => m.set(k, (m.get(k) ?? 0) + v);
  const inc = (outer, key, tok, v = 1) => {
    if (!outer.has(key)) outer.set(key, new Map());
    const inner = outer.get(key);
    inner.set(tok, (inner.get(tok) ?? 0) + v);
  };

  const headAdv = new Map(); // "model|tok" -> Set(advId)  称呼应跨话稳定，一次性内容词多半只在一话里反复
  for (const r of rows) {
    const arr = (byAdv.get(r.advId) ?? []).filter((o) => o.model);
    const pair = new Set([r.x, r.y]);
    for (const o of arr) {
      if (!pair.has(o.model)) continue;
      for (const t of candsOf(o.text)) {
        inc(headOcc, o.model, t);
        const k = `${o.model}|${t}`;
        if (!headAdv.has(k)) headAdv.set(k, new Set());
        headAdv.get(k).add(o.advId);
      }
    }
    for (let i = 0; i < arr.length - 1; i++) {
      const cur = arr[i], nxt = arr[i + 1];
      if (!pair.has(cur.model) || !pair.has(nxt.model) || cur.model === nxt.model) continue;
      for (const t of candsOf(cur.text)) inc(respOf, `${cur.model}>${nxt.model}`, t);
    }
  }

  /* 全局 token → 方向分布 / 对分布，用于独占性判定与通用词剔除 */
  const byTok = new Map(); // tok -> Map(dir -> n)
  const pairOf = new Map();
  for (const r of rows) {
    const pk = [r.x, r.y].sort().join('&');
    pairOf.set(`${r.x}>${r.y}`, pk);
    pairOf.set(`${r.y}>${r.x}`, pk);
  }
  for (const [dir, m] of respOf) for (const [tok, n] of m) {
    if (!byTok.has(tok)) byTok.set(tok, new Map());
    byTok.get(tok).set(dir, (byTok.get(tok).get(dir) ?? 0) + n);
  }
  const pairsOfTok = (tok) => new Set([...(byTok.get(tok)?.keys() ?? [])].map((d) => pairOf.get(d)).filter(Boolean));

  /* 姓名表命中：用于给候选加权（真称呼多半能对齐姓或名） */
  const nameHit = (tok, Y) => {
    const nm = kb.jaNames.get(Y) ?? {};
    const m = tok.match(HONOR);
    const stem = m ? tok.slice(0, tok.length - m[0].length) : tok;
    if (!stem) return false;
    for (const f of ['last', 'first']) {
      const v = nm[f];
      if (!v) continue;
      if (stem === v) return true;
      if (v.length >= 2 && (stem.startsWith(v) || v.startsWith(stem))) return true;
      if (stem.length >= 2 && v.length >= 2 && (stem.startsWith(v.slice(0, 2)) || v.startsWith(stem.slice(0, 2)))) return true;
    }
    return false;
  };

  /* 第三方人名表：X 提到「立希さん」这种不是叫 Y 的，要剔除 */
  const othersName = new Map();
  for (const [key, nm] of kb.jaNames) {
    for (const f of ['last', 'first']) {
      if (!nm[f]) continue;
      if (!othersName.has(nm[f])) othersName.set(nm[f], new Set());
      othersName.get(nm[f]).add(key);
    }
  }

  const addrOf = new Map(); // dir -> [{tok, n, type}]
  for (const [dir, m] of respOf) {
    const [X, Y] = dir.split('>');
    const selfTerms = new Set([kb.jaNames.get(X)?.last, kb.jaNames.get(X)?.first].filter(Boolean));
    const list = [];
    for (const [tok, n] of m) {
      if (n < 2) continue;
      if (tok.length < 2 || tok.length > 7) continue;
      if (/[゛゜]/.test(tok) && tok.length <= 2) continue;             // 浊点拟声
      if (STOP.has(tok)) continue;
      if (STOP.has(tok.replace(TAIL_PART, ''))) continue;              // 剥助词后是通用词
      if (selfTerms.has(tok) || selfTerms.has(tok.replace(TAIL_PART, ''))) continue; // 自称
      if (NOISE_RE.test(tok)) continue;                                // 拟声/延长音
      const dist = byTok.get(tok) ?? new Map();
      if (dist.size >= 6) continue;                                    // 通用词
      if (pairsOfTok(tok).size >= 3) continue;                         // 在多对里都出现，不是专名
      const tot = [...dist.values()].reduce((a, b) => a + b, 0);
      if (n / tot < 0.6) continue;                                     // 不独占
      if ((headOcc.get(X)?.get(tok) ?? 0) < 2) continue;               // 一次性短语
      const stem = tok.replace(HONOR, '');
      const owners = othersName.get(stem);
      if (owners && ![...owners].some((k) => k === X || k === Y)) continue; // 在叫第三个人
      if ((headOcc.get(Y)?.get(tok) ?? 0) > 1) continue;              // 对方自己也这么说 —— 多半不是对 Y 的称呼
      const advs = headAdv.get(`${X}|${tok}`) ?? new Set();
      if (advs.size < 2 && !nameHit(tok, Y)) continue;                 // 只在一话里出现，多半是话题词
      if (n < 3 && !nameHit(tok, Y)) continue;                         // 证据太薄，除非能对上姓/名
      const occ = headOcc.get(X)?.get(tok) ?? 0;
      if (occ && n / occ < 0.4) continue;                              // 说了对方却多半不接话 —— 不像在叫人
      list.push({ tok, n, type: addressType(tok, Y, kb), _s: n * 10 + (HONOR.test(tok) ? 3 : 0) + (nameHit(tok, Y) ? 2 : 0) + advs.size * 0.5 });
    }
    /* 归一化 ①：剥掉尾部助词 / 截断的敬称残片
       「蓬咲は」→「蓬咲」、「ユノさんち」→「ユノさん」 */
    const norm = new Map();
    for (const c of list) {
      let tok = c.tok;
      if (!HONOR.test(tok)) {
        const cut = tok.replace(TAIL_PART, '');
        if (cut !== tok) { if (cut.length < 2) continue; tok = cut; }
        else if (tok.length >= 4) {
          const cut2 = tok.replace(TAIL_TRUNC, '');
          if (cut2 !== tok && cut2.length >= 2 && !HONOR.test(cut2)) tok = cut2;
        }
      }
      if (tok.length < 2 || STOP.has(tok)) continue;
      const rec = { ...c, tok, type: addressType(tok, Y, kb) };
      const prev = norm.get(tok);
      if (!prev || rec.n > prev.n) norm.set(tok, rec);
    }
    /* 归一化 ②：前缀吸收，票数接近时取更长、更完整的那一个
       「燈ち」「燈ちゃ」→「燈ちゃん」、「千石」→「千石さん」 */
    const arr = [...norm.values()].sort((a, b) => b.n - a.n || b.tok.length - a.tok.length);
    const kept = [];
    for (const c of arr) {
      if (kept.some((k) => k.tok.startsWith(c.tok) && k.n >= c.n * 0.7)) continue;   // 已有更完整的同族串
      if (kept.some((k) => c.tok.startsWith(k.tok) && c.n <= k.n)) continue;          // 只是已有串的延长，且票数没更高
      const j = kept.findIndex((k) => c.tok.startsWith(k.tok) && c.n >= k.n * 0.7);
      if (j >= 0) kept.splice(j, 1);
      kept.push(c);
      if (kept.length >= 3) break;
    }
    addrOf.set(dir, kept.map(({ tok, n, type }) => ({ tok, n, type })));
  }
  return { addrOf, respOf, headOcc, headAdv, byTok, pairOf };
}

/* 诊断：某个方向为什么挖出/没挖出称呼（调参用） */
function debugDir(dir, pack, kb) {
  const { respOf, headOcc, headAdv, byTok, pairOf } = pack;
  const [X, Y] = dir.split('>');
  const m = respOf.get(dir) ?? new Map();
  console.log(`\n[诊断] ${dir}（${kb.zhOf(X)}→${kb.zhOf(Y)}）候选 ${m.size} 个`);
  const rowsOut = [];
  for (const [tok, n] of m) {
    const dist = byTok.get(tok) ?? new Map();
    const pairs = new Set([...dist.keys()].map((d) => pairOf.get(d)).filter(Boolean));
    const tot = [...dist.values()].reduce((a, b) => a + b, 0);
    const occ = headOcc.get(X)?.get(tok) ?? 0;
    const occY = headOcc.get(Y)?.get(tok) ?? 0;
    const advs = headAdv.get(`${X}|${tok}`)?.size ?? 0;
    const why = [];
    if (n < 2) why.push('票数<2');
    if (tok.length < 2 || tok.length > 7) why.push('长度');
    if (STOP.has(tok) || STOP.has(tok.replace(TAIL_PART, ''))) why.push('通用词');
    if (NOISE_RE.test(tok)) why.push('拟声');
    if (dist.size >= 6) why.push(`跨${dist.size}方向`);
    if (pairs.size >= 3) why.push(`跨${pairs.size}对`);
    if (n / tot < 0.6) why.push(`不独占${(n / tot).toFixed(2)}`);
    if (occ < 2) why.push('句首<2');
    if (occY > 1) why.push(`对方也说${occY}`);
    if (advs < 2 && !nameHitLocal(tok, Y, kb)) why.push(`仅${advs}话`);
    if (n < 3 && !nameHitLocal(tok, Y, kb)) why.push('证据薄');
    if (occ && n / occ < 0.4) why.push(`接话率${(n / occ).toFixed(2)}`);
    rowsOut.push({ tok, n, occ, occY, advs, 跨方向: dist.size, 跨对: pairs.size, 出局: why.join(',') || '✓ 入候选' });
  }
  rowsOut.sort((a, b) => b.n - a.n);
  for (const r of rowsOut.slice(0, 25)) {
    console.log(`  ${r.tok.padEnd(10)} 票${String(r.n).padStart(2)} 句首${String(r.occ).padStart(2)} 对方${r.occY} 跨话${r.advs} 跨方向${r.跨方向} 跨对${r.跨对}  → ${r.出局}`);
  }
}
function nameHitLocal(tok, Y, kb) {
  const nm = kb.jaNames.get(Y) ?? {};
  const mm = tok.match(HONOR);
  const stem = mm ? tok.slice(0, tok.length - mm[0].length) : tok;
  if (!stem) return false;
  for (const f of ['last', 'first']) {
    const v = nm[f];
    if (!v) continue;
    if (stem === v) return true;
    if (v.length >= 2 && (stem.startsWith(v) || v.startsWith(stem))) return true;
  }
  return false;
}

/* 称呼类型：姓/名 × 有无敬称。日语里「名+ちゃん」亲昵、「姓+さん」有距离、「呼び捨て」对等或生疏 */
const HONOR = /(ちゃん|さん|くん|っち|様|君|氏|たん|ぴょん|りん|ちー|ちゃんって)$/;
function addressType(tok, Y, kb) {
  const nm = kb.jaNames.get(Y) ?? {};
  const m = tok.match(HONOR);
  const stem = m ? tok.slice(0, tok.length - m[0].length) : tok;
  const hon = m ? m[0] : '';
  const tag = (base) => (hon ? `${base}+${hon}` : `${base}直呼`);
  if (nm.last && (stem === nm.last || (nm.last.length >= 2 && stem.startsWith(nm.last)))) return tag('姓');
  if (nm.first && (stem === nm.first || (nm.first.length >= 2 && (stem.startsWith(nm.first) || nm.first.startsWith(stem))))) return tag('名');
  if (hon) return `绰号+${hon}`;
  return '绰号';
}
const TYPE_LABEL = {
  '姓+さん': '礼貌/距离', '姓+ちゃん': '亲近带礼', '姓+くん': '亲近带礼', '姓直呼': '生疏/对事不对人',
  '名+さん': '亲近带礼', '名+ちゃん': '亲昵', '名+くん': '亲昵', '名直呼': '对等/不加敬称',
  '绰号+ちゃん': '亲昵（爱称）', '绰号+さん': '爱称带礼', '绰号+くん': '爱称带礼', '绰号': '爱称/绰号/身份',
};
const typeLabel = (t) =>
  TYPE_LABEL[t] ?? (t.includes('ちゃん') ? '亲昵' : t.includes('さん') || t.includes('くん') ? '带敬称'
    : t.endsWith('直呼') ? '不加敬称' : t.includes('先輩') ? '敬称（先辈）' : '爱称/绰号');

/* ------------------------------------------------------------------ *
 * 态度语义词表（人工定义，conf 0.4 —— 改这张表就改结论，见文档口径节）
 * ------------------------------------------------------------------ */
const ATTITUDE_LEX = {
  感谢: /ありがと|ありがとう|感謝|助かる|助かっ|サンキュー/,
  道歉: /ごめん|ごめんなさい|すまな|申し訳|悪かっ/,
  依赖: /頼り|頼って|頼れる|お願い|おねがい|助けて|いてくれ|いてほしい|そばに|一緒に|必要/,
  赞赏: /すごい|すご|かっこいい|かっこ良|憧れ|尊敬|さすが|上手|上手い|天才|最高|すばらし|素晴らし/,
  好意: /好き|大好き|だいすき|かわいい|可愛い|素敵|すてき|嬉しい|うれしい|楽しい|幸せ|大切/,
  关心: /心配|大丈夫|無理し|無理だ|休ん|気にす|気をつけ|大丈夫？/,
  冲突: /嫌い|きらい|むかつく|うるさ|黙っ|やめて|怒っ|ダメだ|だめだ|最悪/,
  困惑: /わからな|分からな|意味が|なんで|どうして|不思議|変わっ|謎|よくわか/,
  距离: /すみません|失礼|遠慮|初めまして|お疲れさまです|さん付け/,
  共鸣: /わかる|分かる|同じ|共感|そうそう|一緒だ|わかって/,
};
const ATTITUDE_CONF = 0.4;

/* ------------------------------------------------------------------ *
 * 方向指标
 * ------------------------------------------------------------------ */
const r3 = (v) => (v == null ? null : +v.toFixed(3));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function refTerms(Y, addrList, kb) {
  const nm = kb.jaNames.get(Y) ?? {};
  const set = new Set();
  if (nm.last && nm.last.length >= 2) set.add(nm.last);
  if (nm.first) set.add(nm.first);
  for (const a of addrList ?? []) { set.add(a.tok); set.add(a.tok.replace(HONOR, '')); }
  return [...set].filter((s) => s && s.length >= (s.length === 1 ? 2 : 1));
}
const hitRef = (text, terms) => terms.some((t) => String(text ?? '').includes(t));

function dirMetrics(dir, bucket, pol, addrOf, kb) {
  const [X, Y] = dir.split('>');
  const mine = bucket.filter((o) => o.model === X);
  const other = bucket.filter((o) => o.model === Y);
  const addr = addrOf.get(dir) ?? [];
  const terms = refTerms(Y, addr, kb);
  const hit = mine.filter((o) => hitRef(o.text, terms));
  const rest = mine.filter((o) => !hitRef(o.text, terms));

  const vOf = (arr) => avg(arr.map((o) => pol[baseOf(o.exp)]?.valence).filter((v) => typeof v === 'number'));
  const aOf = (arr) => avg(arr.map((o) => pol[baseOf(o.exp)]?.arousal).filter((v) => typeof v === 'number'));
  const topN = (arr, f) => {
    const c = new Map();
    for (const o of arr) { const k = baseOf(f(o)); if (k) c.set(k, (c.get(k) ?? 0) + 1); }
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => ({ k, n }));
  };

  const att = {};
  for (const o of hit) for (const [cat, re] of Object.entries(ATTITUDE_LEX)) if (re.test(o.text ?? '')) att[cat] = (att[cat] ?? 0) + 1;

  const vAll = vOf(mine), vHit = vOf(hit), vRest = vOf(rest);
  const delta = vHit != null && vRest != null ? vHit - vRest : null;
  const total = mine.length + other.length;

  return {
    dir, x: X, y: Y, zhX: kb.zhOf(X), zhY: kb.zhOf(Y), band: kb.bandOf(X),
    lines: mine.length,
    share: total ? +(mine.length / total).toFixed(3) : null,
    mention: hit.length,
    mentionRate: mine.length ? +(hit.length / mine.length).toFixed(3) : null,
    valenceAll: r3(vAll), valenceMention: r3(vHit), valenceRest: r3(vRest),
    deltaV: r3(delta),
    arousalMention: r3(aOf(hit)), arousalRest: r3(aOf(rest)),
    topExpMention: topN(hit, (o) => o.exp), topMotMention: topN(hit, (o) => o.mot),
    address: addr,
    attitude: Object.fromEntries(Object.entries(att).sort((a, b) => b[1] - a[1])),
    evidence: hit.slice(0, 3).map((o) => ({ advId: o.advId, seq: o.seq, exp: baseOf(o.exp), text: String(o.text ?? '').replace(/\n/g, ' ').slice(0, 40) })),
    sparse: hit.length < 3 || rest.length < 3,
  };
}

/* 态度标签（规则，conf 0.45 —— 阈值可调，见文档口径节） */
const D_THR = 0.06, M_HI = 0.35, M_LO = 0.12;
function labelOf(m) {
  if (m.sparse) return { label: '样本不足', conf: 0.2 };
  const dPart = m.deltaV == null ? '情绪不可比' : m.deltaV >= D_THR ? '提到对方变亮' : m.deltaV <= -D_THR ? '提到对方变沉' : '情绪无偏移';
  const mPart = m.mentionRate == null ? '' : m.mentionRate >= M_HI ? '高关注' : m.mentionRate <= M_LO ? '少指名' : '中关注';
  return { label: [mPart, dPart].filter(Boolean).join(' · '), conf: 0.45 };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
function main() {
  const t0 = Date.now();
  const kbRaw = loadKb();
  const kb = { ...kbRaw, jaNames: loadJaNames(), expZh: loadExpZh() };
  const pol = loadPol();
  const rows = scanBond();
  const byAdv = loadBondLines();

  const unknown = new Set();
  for (const r of rows) { if (!kb.byId.has(r.x)) unknown.add(r.x); if (!kb.byId.has(r.y)) unknown.add(r.y); }
  if (unknown.size) console.log(`⚠ 未知 model（不在 kb 47 人）：${[...unknown].join(', ')}`);

  /* ---- 称呼挖掘 ---- */
  const pack = mineAddress(rows, byAdv, kb);
  const { addrOf } = pack;
  const di = argv.indexOf('--dbg');
  if (di >= 0 && argv[di + 1]) { debugDir(argv[di + 1], pack, kb); return; }
  const namedDirs = [...addrOf.values()].filter((l) => l.length).length;
  if (SHOW) {
    console.log('\n[称呼挖掘明细]');
    for (const [dir, list] of [...addrOf.entries()].sort()) {
      if (!list.length) continue;
      console.log(`  ${dir.padEnd(18)} ${list.map((a) => `${a.tok}(${a.n},${a.type})`).join('  ')}`);
    }
    console.log(`\n  有效方向 ${namedDirs} / ${addrOf.size}`);
    return;
  }

  /* ---- 方向指标：合并 3 个 Lv + 分 Lv ---- */
  const dirs = new Map();
  for (const r of rows) {
    for (const [X, Y] of [[r.x, r.y], [r.y, r.x]]) {
      const k = `${X}>${Y}`;
      if (!dirs.has(k)) dirs.set(k, { all: [], lv: { 1: [], 2: [], 3: [] } });
      const arr = byAdv.get(r.advId) ?? [];
      dirs.get(k).all.push(...arr);
      dirs.get(k).lv[r.lv].push(...arr);
    }
  }
  const directions = [];
  for (const [k, v] of dirs) {
    const m = dirMetrics(k, v.all, pol, addrOf, kb);
    m.levels = {};
    for (const lv of [1, 2, 3]) {
      const lm = dirMetrics(k, v.lv[lv], pol, addrOf, kb);
      m.levels[lv] = { lines: lm.lines, mentionRate: lm.mentionRate, deltaV: lm.deltaV, valenceMention: lm.valenceMention, address: lm.address.map((a) => a.tok) };
    }
    Object.assign(m, labelOf(m));
    directions.push(m);
  }
  directions.sort((a, b) => a.band.localeCompare(b.band, 'zh') || a.zhX.localeCompare(b.zhX, 'zh') || a.zhY.localeCompare(b.zhY, 'zh'));

  /* ---- 成对：非对称 ---- */
  const byKey = new Map(directions.map((d) => [d.dir, d]));
  const pairs = [];
  for (const r of rows) {
    const k = `${r.x}&${r.y}`;
    if (pairs.some((p) => p.key === k)) continue;
    const ab = byKey.get(`${r.x}>${r.y}`), ba = byKey.get(`${r.y}>${r.x}`);
    const mr = (m) => m?.mentionRate ?? null;
    const dv = (m) => m?.deltaV ?? null;
    const asym = {
      mentionGap: mr(ab) != null && mr(ba) != null ? +(mr(ab) - mr(ba)).toFixed(3) : null,
      deltaGap: dv(ab) != null && dv(ba) != null ? +(dv(ab) - dv(ba)).toFixed(3) : null,
    };
    let lean = '—';
    if (asym.mentionGap != null && Math.abs(asym.mentionGap) >= 0.08) lean = asym.mentionGap > 0 ? `${ab.zhX}更在意${ab.zhY}` : `${ba.zhX}更在意${ba.zhY}`;
    else if (asym.mentionGap != null) lean = '大致对等';
    pairs.push({
      key: k, band: ab.band, x: r.x, y: r.y, zhX: ab.zhX, zhY: ab.zhY,
      ab: { mentionRate: mr(ab), deltaV: dv(ab), label: ab.label, address: ab.address, share: ab.share },
      ba: { mentionRate: mr(ba), deltaV: dv(ba), label: ba.label, address: ba.address, share: ba.share },
      asym, lean,
    });
  }
  pairs.sort((a, b) => Math.abs(b.asym.mentionGap ?? 0) - Math.abs(a.asym.mentionGap ?? 0));

  /* ---- 统计 ---- */
  const typeStat = {};
  for (const d of directions) for (const a of d.address) typeStat[a.type] = (typeStat[a.type] ?? 0) + 1;
  const labelStat = {};
  for (const d of directions) labelStat[d.label] = (labelStat[d.label] ?? 0) + 1;
  const dvs = directions.filter((d) => d.deltaV != null).map((d) => d.deltaV).sort((a, b) => a - b);
  const q = (p) => (dvs.length ? +dvs[Math.floor((dvs.length - 1) * p)].toFixed(3) : null);
  const mean = dvs.length ? +(dvs.reduce((a, b) => a + b, 0) / dvs.length).toFixed(3) : null;
  const sd = dvs.length && mean != null ? +Math.sqrt(dvs.reduce((a, b) => a + (b - mean) ** 2, 0) / dvs.length).toFixed(3) : null;

  const meta = {
    剧数: rows.length,
    对数: pairs.length,
    方向数: directions.length,
    有称呼方向: namedDirs,
    效价可比方向: dvs.length,
    样本不足方向: directions.filter((d) => d.sparse).length,
    台词行: [...byAdv.values()].reduce((a, b) => a + b.length, 0),
    deltaV分布: { min: dvs[0] ?? null, q1: q(0.25), 中位: q(0.5), q3: q(0.75), max: dvs[dvs.length - 1] ?? null, 均值: mean, 标准差: sd },
  };

  /* Lv 演变：称呼是否变化 + Δv 轨迹 */
  const lvTrend = { addrChanged: [], deltaByLv: [1, 2, 3].map((lv) => ({ lv, mean: r3(avg(directions.map((d) => d.levels[lv].deltaV).filter((v) => v != null))) })) };
  for (const d of directions) {
    const s = new Set([1, 2, 3].flatMap((lv) => d.levels[lv].address ?? []));
    const all = d.address.map((a) => a.tok);
    const perLv = [1, 2, 3].map((lv) => (d.levels[lv].address ?? []).join('/'));
    const uniq = new Set(perLv.filter(Boolean));
    if (uniq.size >= 2) lvTrend.addrChanged.push({ dir: `${d.zhX}→${d.zhY}`, lv1: perLv[0], lv2: perLv[1], lv3: perLv[2] });
    void s; void all;
  }

  /* 趋势分类：Lv1 → Lv3 的 Δv 走向。阈值 ±0.06（一档，见 meta 的 Δv 分布） */
  const STEP = 0.06;
  const trend = { 升温: 0, 降温: 0, 持平: 0, 反复: 0, 无数据: 0, cases: [] };
  for (const d of directions) {
    const v = [1, 2, 3].map((lv) => d.levels[lv].deltaV);
    if (v.some((x) => x == null)) { trend.无数据 += 1; continue; }
    const [a, b, c] = v;
    const d13 = c - a;
    if (Math.abs(d13) < STEP) { trend.持平 += 1; }
    else {
      /* 中间那级不反向才算「单调」 */
      const mono = (b - a >= -STEP && c - b >= -STEP) || (b - a <= STEP && c - b <= STEP);
      if (!mono) trend.反复 += 1;
      else if (d13 > 0) trend.升温 += 1;
      else trend.降温 += 1;
    }
    if (Math.abs(d13) >= 0.3) {
      trend.cases.push({ dir: `${d.zhX}→${d.zhY}`, lv1: r3(a), lv2: r3(b), lv3: r3(c), delta: r3(d13) });
    }
  }
  trend.cases.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  lvTrend.trend = trend;
  lvTrend.linesByLv = [1, 2, 3].map((lv) => ({
    lv, mean: r3(avg(directions.map((d) => d.levels[lv].lines))),
  }));

  const data = {
    _note: '羁绊剧 = X 对 Y 的态度，分析单元是「方向」不是「对」。称呼为自动挖掘，态度词表与标签阈值为人工定义（见 _口径）。',
    _口径: {
      称呼: '句首/句末候选串 + 「下一句由对方接话」信号 + 独占性过滤（见脚本 mineAddress）。未被挖掘出的方向不代表没有称呼，只代表统计证据不足。',
      关注率: 'X 的台词中点名 Y（姓/名/挖出的称呼）的行占比。',
      deltaV: 'X 提到 Y 时的效价 − X 其余台词的效价。正 = 对方让 X 变亮。',
      态度词: `人工正则词表，conf ${ATTITUDE_CONF}；改词表即改结论。`,
      标签: `规则标签，阈值 Δv±${D_THR}、关注率 ${M_LO}/${M_HI}，conf 0.45；改阈值即改结论。`,
      valence来源: 'emotion_polarity.json（人工判定表，非上游数据）。',
    },
    meta, directions, pairs,
    addressTypes: Object.fromEntries(Object.entries(typeStat).sort((a, b) => b[1] - a[1])),
    labels: Object.fromEntries(Object.entries(labelStat).sort((a, b) => b[1] - a[1])),
    lvTrend,
  };

  if (DRY || ONLY === '数据') {
    console.log(`\n[数据] 羁绊剧 ${meta.剧数} 剧 / ${meta.对数} 对 / ${meta.方向数} 方向；台词 ${meta.台词行} 行`);
    console.log(`[数据] 有称呼方向 ${meta.有称呼方向} ｜ 效价可比 ${meta.效价可比方向} ｜ 样本不足 ${meta.样本不足方向}`);
    console.log(`[数据] Δv ${JSON.stringify(meta.deltaV分布)}`);
    console.log(`[数据] 称呼类型 ${JSON.stringify(data.addressTypes)}`);
    console.log(`[数据] 标签 ${JSON.stringify(data.labels)}`);
    console.log(`[数据] 非对称最强 5 对：${pairs.slice(0, 5).map((p) => `${p.zhX}/${p.zhY} ${p.asym.mentionGap}`).join(' ｜ ')}`);
  }

  if (ONLY === '数据') {
    if (!DRY) { mkdirSync(DATA, { recursive: true }); writeFileSync(join(DATA, 'bond_attitude.json'), JSON.stringify(data, null, 1), 'utf8'); }
    console.log('  → _data/bond_attitude.json');
    console.log(`\n完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    return;
  }

  /* ---- 渲染 ---- */
  console.log('\n[渲染]');
  EXP_ZH = kb.expZh;
  writeFile('羁绊态度.md', render(data));
  if (!DRY) { mkdirSync(DATA, { recursive: true }); writeFileSync(join(DATA, 'bond_attitude.json'), JSON.stringify(data, null, 1), 'utf8'); }
  console.log(`\n完成（${((Date.now() - t0) / 1000).toFixed(1)}s）新建/更新 ${updated}，跳过 ${skipped}`);
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */
/* 模块级：表情中文释义（不进 json，仅供渲染） */
let EXP_ZH = new Map();
const zhExp = (k) => {
  const z = EXP_ZH.get(k);
  if (!z) return k;
  let s = z.replace(/[（(].*?[)）]/g, '').trim();
  if (!s) s = z;
  return `${k}·${s.split(/[、/]/)[0].trim().slice(0, 6)}`;
};

function render(d) {
  const m = d.meta, L = [];
  const f2 = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2));
  /* 关注率 0 且没挖到称呼 = 指称证据缺，不是真的从不提对方 */
  const mr = (v, hasAddr) => (v == null ? '—' : v === 0 && !hasAddr ? '0⚠' : (v > 0 ? '+' : '') + v.toFixed(2));
  L.push('# 羁绊剧：谁怎么看谁（态度分析）');
  L.push('');
  L.push(`> 生成于 ${stamp()}　｜　数据源：羁绊剧情 ${m.剧数} 剧 · ${m.台词行} 行带标签台词`);
  L.push('');
  L.push('**羁绊剧情不是「亲密度刻度」，是态度信息。**');
  L.push('一对角色的三段剧里藏着两个方向：**A 怎么看 B** 和 **B 怎么看 A** —— 这两件事常常不对称。');
  L.push('所以本文件的分析单元是**方向**（`X→Y`），不是「对」。`羁绊阶梯.md` 讲的是关系怎么走，这里讲的是**各自的态度**。');
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 0 口径：这一层的每个词指什么');
  L.push('');
  L.push('| 术语 | 定义 | 来源 |');
  L.push('|---|---|---|');
  L.push('| 方向 | 一次态度的持有者 X 与对象 Y，50 对拆成 100 个方向 | 脚本名 `adv_script_{X}_{Y}_linkstory_{lv}` |');
  L.push('| 称呼 | X 口中用来指 Y 的说法，自动挖掘 | 句首/句末候选 +「下一句由 Y 接话」信号 + 独占性过滤 |');
  L.push('| 关注率 | X 的台词中**点名了 Y** 的行占比 | 姓/名/挖出的称呼命中 |');
  L.push('| Δv（情绪偏移） | X 提到 Y 时的效价 − X 其余台词的效价。正 = 一提到对方就变亮 | 逐句表情标签 + 极性表 |');
  L.push('| 唤醒 | 激烈程度 0~3，与正负无关 | 同上 |');
  L.push('| 态度词 | 提到对方时命中的语义类别（感谢/依赖/赞赏…） | **人工正则词表，conf ' + ATT_CONF_STR + '** |');
  L.push('| 标签 | 「高关注 · 提到对方变亮」这类规则标签 | **规则，阈值 Δv±' + D_THR + '、关注率 ' + M_LO + '/' + M_HI + '，conf 0.45** |');
  L.push('');
  L.push('三条必须知道的边界：');
  L.push('');
  L.push('1. **效价来自人工极性表**（`剧情分析/_data/emotion_polarity.json`），不是上游数据。改那张表，本文件全部结论跟着变。');
  L.push(`2. **称呼是统计挖出来的，不是词典查的**。脚本没挖出称呼的方向（${m.方向数 - m.有称呼方向} 个）只代表证据不足，不代表 X 不叫 Y。`);
  L.push('3. **Δv 是相对 X 自己的基线**，不是绝对好坏。一个整体很阴的角色，Δv=+0.1 就是显著的「见到你就亮起来」。');
  L.push('4. 表里 `0⚠` = 这一方向**没挖到称呼**，关注率因此测不出来，不等于「从不提对方」；`样本不足` = 提到对方的行数太少（<3），不做结论。');
  L.push('');
  L.push(`> 实测 Δv 全距 ${m.deltaV分布.min}~${m.deltaV分布.max}，均值 ${m.deltaV分布.均值}，标准差 ${m.deltaV分布.标准差}，四分位 ${m.deltaV分布.q1} / ${m.deltaV分布.中位} / ${m.deltaV分布.q3}。`);
  L.push(`> 在这个分布下，**±0.06 已经是可观的一档** —— 别拿 ±1 的直觉去读这些数。`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 1 总览');
  L.push('');
  L.push(`- 羁绊剧 **${m.剧数}** 剧 = **${m.对数}** 对 × 3 级 → 拆成 **${m.方向数}** 个方向`);
  L.push(`- 挖出称呼的方向 **${m.有称呼方向}** 个；Δv 可比方向 **${m.效价可比方向}** 个；样本不足 **${m.样本不足方向}** 个`);
  L.push('');
  L.push('### 态度标签分布');
  L.push('');
  L.push('| 标签 | 方向数 |');
  L.push('|---|---:|');
  for (const [k, v] of Object.entries(d.labels)) L.push(`| ${k} | ${v} |`);
  L.push('');
  L.push('### 称呼类型分布');
  L.push('');
  L.push('| 称呼形态 | 出现方向数 | 通常读作 |');
  L.push('|---|---:|---|');
  for (const [k, v] of Object.entries(d.addressTypes)) L.push(`| \`${k}\` | ${v} | ${typeLabel(k)} |`);
  L.push('');
  L.push('> 日语里「姓+さん」是礼貌也是距离，「名+ちゃん」是亲昵，「呼び捨て」（不加敬称）要看关系：');
  L.push('> 同辈之间直呼其名通常意味着已经越过客套，但在还没熟的阶段则相反。所以类型只给形态，语义要连着关系看。');
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 2 非对称：谁更在意谁');
  L.push('');
  L.push('关注率差 = X 点名 Y 的比例 − Y 点名 X 的比例。差得越多，这段关系越不是「互相的」。');
  L.push('');
  L.push('⚠ 标记 = 该方向没挖到称呼，关注率 0 只说明**没抓到指称**，不等于从不提对方。');
  L.push('');
  L.push('| 对 | 乐队 | X→Y 关注率 | Y→X 关注率 | 差 | 称呼 X→Y / Y→X | 倾向 |');
  L.push('|---|---|---:|---:|---:|---|---|');
  for (const p of d.pairs.slice(0, 20)) {
    const ax = p.ab.address?.length ? p.ab.address.map((a) => `\`${a.tok}\``).join(' ') : '—';
    const bx = p.ba.address?.length ? p.ba.address.map((a) => `\`${a.tok}\``).join(' ') : '—';
    L.push(`| ${p.zhX} ／ ${p.zhY} | ${p.band} | ${mr(p.ab.mentionRate, p.ab.address?.length)} | ${mr(p.ba.mentionRate, p.ba.address?.length)} | ${f2(p.asym.mentionGap)} | ${ax} / ${bx} | ${p.lean} |`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 3 情绪偏移：提到对方时，人是变亮还是变沉');
  L.push('');
  L.push('### 最亮（Δv 最高）');
  L.push('');
  L.push('| 方向 | Δv | 关注率 | 提到对方时的表情 | 标签 |');
  L.push('|---|---:|---:|---|---|');
  for (const x of d.directions.filter((o) => o.deltaV != null && !o.sparse).sort((a, b) => b.deltaV - a.deltaV).slice(0, 12)) {
    L.push(`| ${x.zhX}→${x.zhY} | ${f2(x.deltaV)} | ${mr(x.mentionRate, x.address.length)} | ${x.topExpMention.map((e) => zhExp(e.k)).join('、') || '—'} | ${x.label} |`);
  }
  L.push('');
  L.push('### 最沉（Δv 最低）');
  L.push('');
  L.push('| 方向 | Δv | 关注率 | 提到对方时的表情 | 标签 |');
  L.push('|---|---:|---:|---:|---|---|');
  for (const x of d.directions.filter((o) => o.deltaV != null && !o.sparse).sort((a, b) => a.deltaV - b.deltaV).slice(0, 12)) {
    L.push(`| ${x.zhX}→${x.zhY} | ${f2(x.deltaV)} | ${mr(x.mentionRate, x.address.length)} | ${x.topExpMention.map((e) => zhExp(e.k)).join('、') || '—'} | ${x.label} |`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 4 称呼谱：一个人怎么叫另一个人');
  L.push('');
  L.push('只列挖到称呼的方向（`次数` 为「叫完对方就接话」的命中数）。例句可回溯到 advId + 句序。');
  L.push('');
  L.push('| 方向 | 称呼 | 次数 | 形态 | 关注率 | Δv |');
  L.push('|---|---|---:|---|---:|---:|');
  for (const x of d.directions.filter((o) => o.address.length)) {
    L.push(`| ${x.zhX}→${x.zhY} | ${x.address.map((a) => `\`${a.tok}\``).join(' ')} | ${x.address.map((a) => a.n).join('/')} | ${x.address.map((a) => typeLabel(a.type)).join('、')} | ${f2(x.mentionRate)} | ${f2(x.deltaV)} |`);
  }
  L.push('');
  L.push('### 没有挖到称呼的方向');
  L.push('');
  const noAddr = d.directions.filter((o) => !o.address.length);
  L.push(noAddr.length ? noAddr.map((o) => `${o.zhX}→${o.zhY}`).join('、') : '（无）');
  L.push('');
  L.push('> 这些方向里，X 很可能用的是代词（「あなた」「あの人」）或直接省略主语 —— 日语对话里这很常见。');
  L.push('> 这本身就是态度信息：**不点名**，有时是因为亲近到不必叫，有时是因为刻意保持距离。');
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 5 态度语义：提到对方时在说什么');
  L.push('');
  L.push('命中次数最多的方向（同一句可命中多类，这里只列每方向的第一类）。词表是人工正则，conf ' + ATT_CONF_STR + '。');
  L.push('');
  const attRows = d.directions.filter((o) => Object.keys(o.attitude).length).sort((a, b) => (Object.values(b.attitude)[0] ?? 0) - (Object.values(a.attitude)[0] ?? 0));
  L.push('| 方向 | 主类 | 次数 | 其它命中 | Δv |');
  L.push('|---|---|---:|---|---:|');
  for (const x of attRows.slice(0, 25)) {
    const es = Object.entries(x.attitude);
    L.push(`| ${x.zhX}→${x.zhY} | ${es[0][0]} | ${es[0][1]} | ${es.slice(1, 4).map(([k, v]) => `${k} ${v}`).join('、') || '—'} | ${f2(x.deltaV)} |`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 6 态度会随 Lv 变吗');
  L.push('');
  const lt = d.lvTrend;
  L.push('### 6.1 全样本均值');
  L.push('');
  L.push('| Lv | 全方向 Δv 均值 | 每方向均台词 |');
  L.push('|---|---:|---:|');
  for (const r of lt.deltaByLv) {
    const ln = lt.linesByLv?.find((x) => x.lv === r.lv);
    L.push(`| Lv${r.lv} | ${f2(r.mean)} | ${ln ? ln.mean : '—'} |`);
  }
  L.push('');
  L.push('三级均值几乎不动 —— **羁绊剧不是「越升级越甜」**。把 Lv 当好感度刻度读会读错。');
  L.push('');
  L.push('### 6.2 分方向看：升温 / 降温 / 反复');
  L.push('');
  const tr = lt.trend;
  if (tr) {
    L.push(`按 Lv1→Lv3 的 Δv 变化分类（阈值 ±0.06，即一档）：`);
    L.push('');
    L.push('| 走向 | 方向数 | 说明 |');
    L.push('|---|---:|---|');
    L.push(`| 升温 | ${tr.升温} | 三级单调上升，且首尾差 ≥ 0.06 |`);
    L.push(`| 降温 | ${tr.降温} | 三级单调下降，且首尾差 ≤ −0.06 |`);
    L.push(`| 持平 | ${tr.持平} | 首尾差不足一档 |`);
    L.push(`| 反复 | ${tr.反复} | 中间那级反向（先冷后热 / 先热后冷）|`);
    L.push(`| 无数据 | ${tr.无数据} | 某一级没提到对方，Δv 算不出来 |`);
    L.push('');
    L.push(`**降温（${tr.降温}）多于升温（${tr.升温}）**，反复（${tr.反复}）是最多的一类 ——`);
    L.push('多数羁绊剧是「关系变真」而不是「感情变好」：越熟越敢说重话、越不客套。');
    L.push('');
    if (tr.cases.length) {
      L.push('**变化最大的方向**（首尾差 ≥ 0.30）：');
      L.push('');
      L.push('| 方向 | Lv1 | Lv2 | Lv3 | Lv1→Lv3 |');
      L.push('|---|---:|---:|---:|---:|');
      for (const c of tr.cases.slice(0, 12)) {
        L.push(`| ${c.dir} | ${f2(c.lv1)} | ${f2(c.lv2)} | ${f2(c.lv3)} | ${c.delta > 0 ? '+' : ''}${c.delta.toFixed(2)} |`);
      }
      L.push('');
      L.push('⚠️ 每级每个方向平均只有 ' + (lt.linesByLv?.[0]?.mean ?? '—') + ' 句，单个方向的分级 Δv **噪声不小**；');
      L.push('这些大变样本要看 json 里的原文（\`evidence\`）确认，别只凭数字下结论。');
      L.push('');
    }
  }
  L.push('### 6.3 称呼随级变化了吗');
  L.push('');
  if (!d.lvTrend.addrChanged.length) {
    L.push('**一个都没有。** 所有挖到称呼的方向，三级用的是同一个称呼。');
    L.push('');
    L.push('这说明称呼是**角色设定**（一开始就定下来的叫法），不是随关系升温才改口的。');
    L.push('所以「称呼变亲昵」不能当作羁绊深化的证据 —— 反过来，称呼不变也不代表关系没推进。');
    L.push('');
  }
  if (d.lvTrend.addrChanged.length) {
    L.push('### 称呼发生变化的方向');
    L.push('');
    L.push('| 方向 | Lv1 | Lv2 | Lv3 |');
    L.push('|---|---|---|---|');
    for (const c of d.lvTrend.addrChanged.slice(0, 20)) L.push(`| ${c.dir} | ${c.lv1 || '—'} | ${c.lv2 || '—'} | ${c.lv3 || '—'} |`);
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('## 7 全表：50 对 · 100 个方向');
  L.push('');
  L.push('| 方向 | 称呼 | 关注率 | Δv | 台词占比 | 标签 |');
  L.push('|---|---|---:|---:|---:|---|');
  for (const x of d.directions) {
    L.push(`| ${x.zhX}→${x.zhY} | ${x.address.length ? x.address.map((a) => `\`${a.tok}\``).join(' ') : '—'} | ${mr(x.mentionRate, x.address.length)} | ${f2(x.deltaV)} | ${x.share == null ? '—' : (x.share * 100).toFixed(0) + '%'} | ${x.label} |`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('<!-- USER:START 观察 -->');
  L.push('（手写区：从上面这张表里读出来的、机器标不出来的东西。重跑脚本不会覆盖这一块。）');
  L.push('');
  L.push('<!-- USER:END -->');
  L.push('');
  return L.join('\n');
}

const ATT_CONF_STR = String(ATTITUDE_CONF);

/* ---------------- 自检 ---------------- */
if (CHECK) {
  let ok = true;
  const p = join(DATA, 'bond_attitude.json');
  if (!existsSync(p)) { console.log('✗ 缺 _data/bond_attitude.json'); ok = false; }
  else {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j.meta.方向数 !== 100) { console.log(`✗ 方向数 ${j.meta.方向数} ≠ 100`); ok = false; }
    if (j.meta.剧数 !== 150) { console.log(`✗ 羁绊剧数 ${j.meta.剧数} ≠ 150`); ok = false; }
    if (!j.meta.有称呼方向) { console.log('✗ 没挖到任何称呼'); ok = false; }
    if (j.directions.length !== 100) { console.log(`✗ directions ${j.directions.length} ≠ 100`); ok = false; }
    if (j.pairs.length !== 50) { console.log(`✗ pairs ${j.pairs.length} ≠ 50`); ok = false; }
  }
  if (!existsSync(join(OUT, '羁绊态度.md'))) { console.log('✗ 缺 羁绊态度.md'); ok = false; }
  console.log(ok ? '✓ 羁绊态度自检通过' : '✗ 羁绊态度自检失败');
  process.exit(ok ? 0 : 1);
}

main();
