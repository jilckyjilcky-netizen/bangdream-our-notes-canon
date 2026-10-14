#!/usr/bin/env node
/**
 * build_novel_env.mjs —— 生成 / 重建 NovelProject/ 创作环境骨架
 *
 * 归属：项目级 skill `light-novel-creator`（.workbuddy/skills/light-novel-creator）的初始化器。
 * 职责：把「原作既定事实」从 资料库/kb.json、角色卡/、世界书/ 注入 NovelProject/ 的
 *       World / Settings / Factions / Characters / Timeline / Foreshadows 六个文件，
 *       作为该 skill §13 角色卡片的 🔒固定属性来源与 §13.7 时间线基线。
 *
 * 纪律（本项目硬规则）：
 *   - **所有数字由脚本在生成时注入**，禁止手抄进 md。改 kb.json 后重跑即可同步。
 *   - 生成区（AUTO）每次覆盖；手改内容一律写进 USER 块，重跑不丢。
 *
 * 用法：
 *   node 工具/build_novel_env.mjs              # 生成骨架（已存在的文件只做增量安全更新）
 *   node 工具/build_novel_env.mjs --force      # 强制重生成 AUTO 区（USER 块仍保留）
 *   node 工具/build_novel_env.mjs --dry        # 只打印将要写的文件，不落盘
 *   node 工具/build_novel_env.mjs --list       # 列出可生成的卡片角色 id
 *   node 工具/build_novel_env.mjs --card 灯    # 生成单张角色卡（🔒固定属性自动预填）
 *   node 工具/build_novel_env.mjs --card 灯,祥子
 *
 * USER 块语法（写在生成文件里，重跑会原样保留）：
 *   <!-- USER:START 块名 -->
 *   ...手改内容...
 *   <!-- USER:END -->
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 多形态角色表（2026-10-06 实测找出）。
 *
 * **背景**：kb 的 `speech` 按 kb id 合并，但有些角色在语料里是**多个 model**。
 * 合并会把第二人格/第二形态的说话方式彻底抹平 ——
 * 而这些角色的 OOC 禁令往往正是「怎么区分这两个」（睦：「第三人称小睦 = 〔原文略〕」）。
 * **照合并后的卡片写第二形态，必然写飘。**
 *
 * ⚠️ **只列真正属于同一角色的**。`_emotion_lines.jsonl` 里还有
 * `nyamumother` / `raikagrandmother` / `mikumother` 这类**亲属** model ——
 * 那些是**独立角色**（kb 里也各有其人），已被指纹生成器正确排除，**不进这张表**。
 * 判据：附属 model 的台词归属同一叙事身份，不是另一个角色。
 */
const MULTI_MODEL_ALIAS = {
  mutsumi: {
    alt: 'Mortis',
    others: ['mortis'],
    label: (m) => (m === 'mortis' ? '第二人格' : m),
    judge: '**一句话里出现第三人称「小睦」= Mortis 在说话**（本体绝不会这样自称）。本体沉默率高、Mortis 表演腔。',
  },
  hatsune: {
    alt: '初音（Doloris）',
    others: ['hatsune2'],
    label: (m) => (m === 'hatsune2' ? '另形态' : m),
    judge: '`hatsune2` 台词量很小（7 行），**样本不足，别当权威**；要用先回语料逐句看。',
  },
};

/**
 * 某 model 的**日文原文侧**指纹（数据源 `_emotion_lines.jsonl`）。
 *
 * ⚠️ **口径提醒（重要）**：这里算的是**日文**（`text` 是日文原文），而卡片上那段
 * `char.speech` 是**中文**指纹表。**两套口径绝对值不可比，只做组内自比**
 * （mutsumi vs mortis），别拿这里的 36.2% 去对上面那段 33.3% 说「不一致」。
 * 与 MEMORY「语气×感情交叉」那条同源：语料是日文原文，组内自比是唯一正确用法。
 */
let _linesCache = null;
function loadEmotionLines() {
  if (_linesCache) return _linesCache;
  const p = path.join(ROOT, '资料库', '_emotion_lines.jsonl');
  if (!fs.existsSync(p)) return (_linesCache = []);
  _linesCache = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s));
  return _linesCache;
}

/** 假名 + 汉字都算「有字」；纯标点/空白算沉默行。 */
const hasGlyph = (s) => /[぀-ヿ㐀-鿿]/.test(String(s));

function perModelSpeech(model) {
  const rows = loadEmotionLines().filter((l) => l.model === model);
  if (!rows.length) return null;
  const texts = rows.map((r) => String(r.text || ''));
  const spoken = texts.filter(hasGlyph);
  const n = spoken.length || 1;
  const L = spoken.map((t) => (t.match(/[぀-ヿ㐀-鿿]/g) || []).length);
  const r1 = (x) => Math.round((x / n) * 1000) / 10;
  return {
    台词: rows.length,
    沉默行: rows.length - spoken.length,
    均长: Math.round((L.reduce((a, b) => a + b, 0) / n) * 10) / 10,
    省略号率: r1(spoken.filter((t) => /…|\.\.\./.test(t)).length),
    含我率: r1(spoken.filter((t) => /[぀-ヿ]/.test(t) && /(私|僕|俺|私達|私たち)/.test(t)).length),
    疑问率: r1(spoken.filter((t) => /？|\?$/.test(t)).length),
    动作种类: new Set(rows.map((r) => r.mot).filter(Boolean)).size,
  };
}
const NOVEL = path.join(ROOT, 'NovelProject');
const SKILL_DIR = path.join(ROOT, '.workbuddy', 'skills', 'light-novel-creator');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argVal = (f) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const DRY = has('--dry');
const FORCE = has('--force');
const LIST = has('--list');
const CARD = argVal('--card');

// ---------------------------------------------------------------- 基础工具

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

/** 把任意 kb 字段压成单行字符串（对象/数组都能吃） */
function flat(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v.replace(/\s*\n\s*/g, ' / ').trim();
  if (Array.isArray(v)) return v.map(flat).filter(Boolean).join(' / ');
  if (typeof v === 'object') {
    return Object.entries(v)
      .filter(([k]) => k !== '项目' && k !== '---' && !/^-+$/.test(k))
      .map(([k, x]) => `${k}: ${flat(x)}`)
      .filter(Boolean)
      .join(' / ');
  }
  return String(v);
}

/** 乐队名归一：上游存在「〔原文略〕」与「〔原文略〕」两种写法 */
function normBand(b) {
  return String(b || '').replace(/[!\s・·]/g, '').toLowerCase();
}

/** 取出 USER 块：块名 -> 块内正文 */
function extractUserBlocks(text) {
  const re = /<!-- USER:START ([^\n]*?) -->\r?\n([\s\S]*?)<!-- USER:END -->/g;
  const map = new Map();
  let m;
  while ((m = re.exec(text))) map.set(m[1].trim(), m[2]);
  return map;
}

/** 把旧文件里的 USER 块内容回填进新生成的文本 */
function applyUserBlocks(next, blocks) {
  return next.replace(
    /<!-- USER:START ([^\n]*?) -->\r?\n([\s\S]*?)<!-- USER:END -->/g,
    (full, name, body) => {
      const key = name.trim();
      if (blocks.has(key)) return `<!-- USER:START ${name} -->\n${blocks.get(key)}<!-- USER:END -->`;
      return full;
    },
  );
}

function userBlock(name, placeholder = '') {
  return `<!-- USER:START ${name} -->\n${placeholder}<!-- USER:END -->`;
}

function genHeader(title, src) {
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  return [
    `# ${title}`,
    '',
    `> AUTO-GENERATED by \`工具/build_novel_env.mjs\` — 数据源：${src}（data_version \`${DATA_VERSION}\`）`,
    `> 生成于 ${stamp}。数字均为脚本注入，请勿手改；改上游数据后重跑本脚本同步。`,
    `> 需要手写的内容请写进下方 \`<!-- USER:START -->\` 块内，重跑不会被覆盖。`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- 载入上游

const kb = readJson('资料库/kb.json');
const DATA_VERSION = kb?.meta?.data_version ?? 'unknown';
const CHARS = kb.characters || [];
const EVENTS = kb.events || [];
const PLACES = kb.places || [];
const ITEMS = kb.items || [];

const worldBook = readJson('世界书/mygo_ave_世界书.json');
const WB_ENTRIES = Array.isArray(worldBook?.entries) ? worldBook.entries : [];

/** 角色卡文件：卡名 -> 相对路径 */
const CARD_FILES = fs
  .readdirSync(path.join(ROOT, '角色卡'))
  .filter((f) => f.endsWith('_character_card.json') && !f.startsWith('_'))
  .map((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, '角色卡', f), 'utf8'));
      return { name: j?.data?.name ?? f.replace('_character_card.json', ''), file: `角色卡/${f}` };
    } catch {
      return { name: f.replace('_character_card.json', ''), file: `角色卡/${f}` };
    }
  });

/**
 * 角色名解析 —— 复用 canon MCP 的 name-index，不另写一套。
 * 认中日全名 / 只写姓 / 只写名 / 舞台名 / 罗马音 / 和制汉字
 * （如「三角初华」「Doloris」「ドロリス」「Uika Misumi」都指向 uika）。
 */
let RESOLVER = null;
try {
  const ni = await import(new URL('../mcp-canon/name-index.mjs', import.meta.url).href);
  RESOLVER = ni.createCharResolver({ characters: CHARS });
} catch {
  RESOLVER = null; // 降级到本地简易匹配
}

function resolveChar(name) {
  if (RESOLVER) {
    const r = RESOLVER.resolve(name);
    if (r?.char) return r.char;
  }
  return (
    CHARS.find((c) => c.id === name) ||
    CHARS.find((c) => c.name_short === name || c.name === name || (c.aliases || []).includes(name)) ||
    CHARS.find((c) => c.name?.includes(name)) ||
    CHARS.find((c) => c.name_short && name.includes(c.name_short)) ||
    null
  );
}

/** 角色卡 -> kb 角色 的匹配 */
function matchChar(cardName) {
  return resolveChar(cardName);
}

const CARD_OF = new Map(); // kb.id -> 角色卡/ 下的 JSON 相对路径（下游站点用）
const ORPHAN_CARDS = [];
for (const cf of CARD_FILES) {
  const c = matchChar(cf.name);
  if (c) CARD_OF.set(c.id, cf.file);
  else ORPHAN_CARDS.push(cf.file);
}

/**
 * `NovelProject/Characters/*.md` —— **与上面那套是两回事**。
 * `角色卡/*.json` 是下游 SillyTavern 用的；`NovelProject/Characters/` 是本 skill
 * §13 角色卡片数据库（写作时读的那套）。
 * ⚠️ 之前只有 `CARD_OF` 一个索引，一览表里那列写「角色卡」指的全是 JSON，
 *   **新建的 29 张 md 一张都没进表** —— 索引指向的东西和实际产物脱节了。
 *   所以加这一列，两套各列各的，别混。
 */
const NP_CARD_OF = new Map(); // kb.id -> NovelProject/Characters/xxx_名字.md
if (fs.existsSync(path.join(NOVEL, 'Characters'))) {
  for (const f of fs.readdirSync(path.join(NOVEL, 'Characters'))) {
    if (!f.endsWith('.md') || f === '_template.md') continue;
    const c = matchChar(f);
    if (c) NP_CARD_OF.set(c.id, `Characters/${f}`);
  }
}

/**
 * 每人的中文台词数 —— **现算**，不解析 kb 的 `speech` 字符串。
 * ⚠️ kb 里存的是 `纯沉默占比: "151/1030 = 14.7%"` 这种**混合格式**，
 *   正则去抠会抠错（MEMORY 记过「数字对但对象错」那类坑）。
 * 真源在 `素材全量/按角色全量/zh-Hans/`（47 人全，`按角色/ja/{band}/` 不全）。
 *
 * ⚠️⚠️ **口径必须与 `fingerprint_full` 一致**（实测踩过）：
 *   直接数 `- ` 条数会把**沉默行与歌词**算进去 → 31 人过线；
 *   而 `fingerprint_full` 的「台词」已剔除那些 → 29 人。
 *   差出来的 2 人（koharu 82→69、baachan 77→52）**恰好卡在分档线上**，
 *   口径不同就得出不同名单 —— 分档线是 75这种边缘值，口径必须钉死。
 *   这里按 fingerprint_full 的规则复算：剔歌词（`『』『♪` 开头）与心声（`（` 开头）。
 */
const LINES_OF = new Map(); // kb.id -> 台词行数（已剔歌词/心声，与 fingerprint_full 同口径）
{
  const dir = path.join(ROOT, '素材全量', '按角色全量', 'zh-Hans');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const c = matchChar(f);
      if (!c) continue;
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
      let cur = null, inItems = false, n = 0;
      const flush = () => {
        if (cur == null) return;
        const t = cur.replace(/\s/g, '');
        if (t && !/^[『♪]/.test(t) && !/^（/.test(t)) n++;
        cur = null;
      };
      for (const l of lines) {
        if (/^##\s/.test(l)) { flush(); inItems = l.replace(/^##\s+/, '').trim() !== '出处目录'; cur = null; continue; }
        if (!inItems) continue;
        if (/^<sub>/.test(l) || /^#/.test(l) || /^>/.test(l) || /^---/.test(l)) continue;
        if (/^-\s/.test(l)) { flush(); cur = l.replace(/^-\s+/, ''); continue; }
        if (!l.trim()) { flush(); continue; }
        if (cur != null) cur += l.trim();
      }
      flush();
      LINES_OF.set(c.id, n);
    }
  }
}
/** 主角级分档线：≥75 句。低于此是薄样本，**不进卡**（小样本统计会造出假指纹）。 */
const MAIN_LINE_THRESHOLD = 75;
const MAIN_CHAR_IDS = new Set(
  [...LINES_OF.entries()].filter(([, n]) => n >= MAIN_LINE_THRESHOLD).map(([id]) => id),
);

/** 乐队聚合（归一后合并，展示名取出现次数最多的原写法） */
const BANDS = new Map();
for (const c of CHARS) {
  const key = normBand(c.band) || '(未归属)';
  if (!BANDS.has(key)) BANDS.set(key, { display: c.band || '（未归属）', variants: new Set(), members: [] });
  const b = BANDS.get(key);
  b.variants.add(c.band || '（未归属）');
  b.members.push(c);
}
const BAND_MERGES = [...BANDS.values()].filter((b) => b.variants.size > 1);

if (LIST) {
  console.log('可生成角色卡的角色（kb id / 名称 / 乐队 / 是否已有角色卡）：\n');
  for (const c of CHARS) {
    console.log(
      `  ${c.id.padEnd(16)} ${(c.name_short || c.name).padEnd(10)} ${String(c.band || '-').padEnd(16)} ${CARD_OF.has(c.id) ? '✔ 有卡' : '—'}`,
    );
  }
  process.exit(0);
}

// ---------------------------------------------------------------- 各文件生成

function genReadme() {
  return [
    '# NovelProject — 轻小说创作工程目录',
    '',
    '> 由 `工具/build_novel_env.mjs` 生成。本目录是 skill `light-novel-creator` 的工作区，',
    '> 不是本仓库的考据资产——考据结论仍在 `资料库/`、`角色模型/`、`角色卡/`、`世界书/` 里。',
    '',
    '## 文件职责',
    '',
    '| 文件 | 内容 | 谁来改 |',
    '|---|---|---|',
    '| `World.md` | 世界观。上半「原作基底」自动生成，下半「本作设定」手写 | 手写区 |',
    '| `Settings.md` | 场景/地点。原作 7 处已注入，本作新增场景手写 | 手写区 |',
    '| `Factions.md` | 势力/乐队。按 `kb.json` 聚合 | 手写区 |',
    '| `Characters.md` | 角色一览表（自动）+ 关系图谱（手写） | 手写区 |',
    '| `Characters/*.md` | ★角色卡片，一人一张 | skill 每章强制更新 |',
    '| `Timeline.md` | 时间线。原作 14 事件为基线，本作章节追加 | skill 每章强制追加 |',
    '| `Foreshadows.md` | 伏笔追踪 | 手写 |',
    '| `_原作词条索引.md` | 世界书词条索引，供检索 | 自动生成 |',
    '',
    '## 与项目既有资产的关系（重要）',
    '',
    `- **🔒固定属性**不要自己编：一律取自 \`资料库/kb.json\`（在册 ${CHARS.length} 人）、\`角色卡/\`（${CARD_FILES.length} 份）、\`世界书/\`（${WB_ENTRIES.length} 条）。`,
    '- **🔄可变动属性**（年龄/学年/职业/资产/能力/婚育/关系好感度）才由本作剧情驱动。',
    '- 卡片里的「来源」字段写 `Our Notes 本地考据库`，不要写「萌娘百科导入」——本仓库不走百科抓取。',
    '',
    '## 常用命令',
    '',
    '```bash',
    'node 工具/build_novel_env.mjs            # 同步骨架（保留手写区）',
    'node 工具/build_novel_env.mjs --force    # 强制重生成自动区',
    'node 工具/build_novel_env.mjs --list     # 看可建卡的角色 id',
    'node 工具/build_novel_env.mjs --card 灯  # 生成一张预填了固定属性的角色卡',
    '```',
    '',
  ].join('\n');
}

function genWorld() {
  const L = [];
  L.push(genHeader('世界观设定', '资料库/kb.json / 世界书/mygo_ave_世界书.json'));
  L.push('## 一、原作基底（AUTO · 只读，勿改）', '');
  L.push(`### 1.1 取材范围`, '');
  L.push(`> ${flat(kb?.meta?.title)}`, '');
  L.push(
    `在册角色 **${CHARS.length}** 名 ｜ 乐队/团体 **${BANDS.size}** 支 ｜ 关键事件 **${EVENTS.length}** 个 ｜ 地点 **${PLACES.length}** 处 ｜ 关键物品/意象 **${ITEMS.length}** 件 ｜ 世界书词条 **${WB_ENTRIES.length}** 条。`,
    '',
  );
  L.push('### 1.2 各团体构成', '');
  L.push('| 团体 | 人数 | 成员 |', '|---|---|---|');
  for (const b of [...BANDS.values()].sort((x, y) => y.members.length - x.members.length)) {
    L.push(`| **${b.display}** | ${b.members.length} | ${b.members.map((m) => m.name_short || m.name).join('、')} |`);
  }
  L.push('');
  if (BAND_MERGES.length) {
    L.push(
      `> ⚠️ 上游乐队名书写不统一，已归一合并：${BAND_MERGES.map((b) => [...b.variants].join(' ＝ ')).join('；')}。建议回头统一 \`kb.json\`。`,
      '',
    );
  }
  L.push('### 1.3 世界规则要点（来自世界书，逐条见 `_原作词条索引.md`）', '');
  L.push(`世界书共 **${WB_ENTRIES.length}** 条词条，覆盖：${WB_ENTRIES.slice(0, 12).map((e) => (e.keys || [])[0]).filter(Boolean).join('、')}……`, '');
  L.push('### 1.4 关键物品 / 意象', '');
  L.push('| 物品 | 类别 | 含义 | 关键词 |', '|---|---|---|---|');
  for (const it of ITEMS) {
    L.push(`| **${it.name}** | ${it.kind || '-'} | ${flat(it.summary)} | ${(it.keywords || []).join('、') || '-'} |`);
  }
  L.push('');
  L.push('## 二、本作设定（USER · 手写区）', '');
  L.push(userBlock('本作世界观设定', '<!-- 写在这里：本作与「原作基底」的差异、新增规则、时间起点、主角定位。\n本目录考据结论不可推翻；若本作要改设定，在此显式声明为「本作改写」。 -->\n'));
  L.push('');
  return L.join('\n');
}

function genSettings() {
  const L = [];
  L.push(genHeader('场景 / 地点设定', '资料库/kb.json · places'));
  L.push(`## 一、原作地点（AUTO · ${PLACES.length} 处）`, '');
  L.push('| 地点 | 说明 | 关键词 |', '|---|---|---|');
  for (const p of PLACES) {
    L.push(`| **${p.name}** | ${flat(p.summary)} | ${(p.keywords || []).join('、') || '-'} |`);
  }
  L.push('');
  L.push('## 二、本作新增场景（USER · 手写区）', '');
  L.push('| 场景 | 归属 | 首次登场 | 作用 |', '|---|---|---|---|');
  L.push(userBlock('本作新增场景表', '<!-- 一行一个场景，例：| 天台 | 羽丘 | Ch.1 | 灯逃避练习的去处 | -->\n'));
  L.push('');
  return L.join('\n');
}

function genFactions() {
  const L = [];
  L.push(genHeader('势力 / 团体设定', '资料库/kb.json · characters'));
  L.push(`## 一、原作团体（AUTO · ${BANDS.size} 支）`, '');
  for (const b of [...BANDS.values()].sort((x, y) => y.members.length - x.members.length)) {
    L.push(`### ${b.display}（${b.members.length} 人）`, '');
    L.push('| 成员 | 担当 | 所属/学校 | 一句话定位 |', '|---|---|---|---|');
    for (const m of b.members) {
      L.push(
        `| ${m.name_short || m.name} | ${m.role || '-'} | ${flat(m.basic?.学校) || '-'} | ${flat(m.tagline) || flat(m.bio).slice(0, 40)} |`,
      );
    }
    L.push('');
  }
  L.push('## 二、本作新增势力（USER · 手写区）', '');
  L.push(userBlock('本作新增势力', '<!-- 目标 / 成员 / 资源 / 与其他势力的关系 -->\n'));
  L.push('');
  return L.join('\n');
}

function genCharacters() {
  const L = [];
  L.push(genHeader('角色一览', '资料库/kb.json · characters / 角色卡/'));
  L.push(
    `在册 **${CHARS.length}** 人 ｜ SillyTavern 角色卡（\`角色卡/*.json\`）**${CARD_OF.size}** 份 ｜
**NovelProject 卡片（\`Characters/*.md\`）${NP_CARD_OF.size} 份**（**主角级 = 台词 ≥75 句的 ${MAIN_CHAR_IDS.size} 人**，薄样本不进卡）。`,
    '**本表是索引，不是角色卡片**。两列是两套东西：',
    '`角色卡 JSON` 给下游站点用；`NovelProject 卡` 是写作时读的那套（含说话指纹 / OOC 禁令 / USER 区）。',
    '',
  );
  L.push('| # | 角色 | 团体 | 担当 | 生日 | 身高 | 学校 | 台词 | 角色卡JSON | NovelProject卡 | 考据文档 |', '|---|---|---|---|---|---|---|---|---|---|---|');
  CHARS.forEach((c, i) => {
    const n = LINES_OF.get(c.id);
    L.push(
      `| ${String(i + 1).padStart(3, '0')} | **${c.name_short || c.name}** | ${c.band || '-'} | ${c.role || '-'} | ${flat(c.basic?.生日) || '-'} | ${flat(c.basic?.身高) || '-'} | ${flat(c.basic?.学校) || '-'} | ${n ?? '—'} | ${CARD_OF.has(c.id) ? `\`${CARD_OF.get(c.id)}\`` : '—'} | ${NP_CARD_OF.has(c.id) ? `[\`${NP_CARD_OF.get(c.id)}\`](${NP_CARD_OF.get(c.id)})` : '—'} | ${c.doc ? `\`${c.doc}\`` : '—'} |`,
    );
  });
  L.push('');
  if (ORPHAN_CARDS.length) {
    L.push(`> ⚠️ 有 ${ORPHAN_CARDS.length} 份角色卡未匹配到 kb 角色：${ORPHAN_CARDS.join('、')}`, '');
  }
  L.push('## 关系图谱（USER · 手写区）', '');
  L.push(
    '> 原作侧的人际关系已存在 `kb.json` 的 `relations` 字段里（含称呼与语气实测），',
    '> 建卡时照抄即可；此处只记录**本作原创**的关系变化。',
    '',
  );
  L.push(userBlock('本作关系图谱', '<!-- 例：| 灯 → 祥子 | 本作设定为同级转学生 | Ch.1 起 | -->\n'));
  L.push('');
  return L.join('\n');
}

function genTimeline() {
  const sorted = [...EVENTS].sort((a, b) => {
    const ea = Math.min(...(a.episodes || []).map(Number).filter((n) => !Number.isNaN(n)), 99999);
    const eb = Math.min(...(b.episodes || []).map(Number).filter((n) => !Number.isNaN(n)), 99999);
    return ea - eb;
  });
  const L = [];
  L.push(genHeader('时间线概要', '资料库/kb.json · events'));
  L.push('> 当前时间点：__（由本作章节推进后填写）__ ｜ 最后更新：初始化', '');
  L.push(`## 一、原作基线（AUTO · ${EVENTS.length} 个关键事件，按首次出现的话数排序）`, '');
  L.push('| # | 事件 | 涉及角色 | 摘要 | 关键词 | 出处话数 |', '|---|---|---|---|---|---|');
  sorted.forEach((e, i) => {
    L.push(
      `| ${i + 1} | **${e.name}** | ${(e.participants || []).join('、') || '-'} | ${flat(e.summary)} | ${(e.keywords || []).join('、') || '-'} | ${(e.episodes || []).join(', ') || '-'} |`,
    );
  });
  L.push('');
  L.push('## 二、本作时间轴（USER · 手写区，每章后强制追加）', '');
  L.push('| 日期 | 章节 | 事件 | 涉及角色 | 角色状态变更 |', '|---|---|---|---|---|');
  L.push(userBlock('本作时间轴', '<!-- 每章结束后追加。例：| 20XX-04-07(月) | Ch.1 | 入学式 | 灯、爱音 | 灯→羽丘1-A | -->\n'));
  L.push('');
  L.push('## 三、当前角色状态速览（USER · 手写区）', '');
  L.push('| 角色 | 年龄 | 学年/职业 | 关系 | 最新章 |', '|---|---|---|---|---|');
  L.push(userBlock('角色状态速览', '<!-- 每次更新角色卡片后同步此表，与卡片双写验证 -->\n'));
  L.push('');
  return L.join('\n');
}

function genForeshadows() {
  const L = [];
  L.push(genHeader('伏笔追踪（本作要埋的）', '模板（无自动生成内容）'));
  L.push(
    '> ⚠️ **这不是原作伏笔清单。** 原作已埋已收的 **36 项**在 `剧情分析/伏笔与回收.md`',
    '> （意象 / 台词 / 道具的埋设点↔回收点对照，每条带 advId 与原文证据）。',
    '> **本表只管「本作新埋的」** —— 填你写 chapters 时埋下的东西。',
    '> ⚠️ 别把原作那 36 项抄进来：那些是**别人的底本事实**，抄进来就分不清哪些是自己的设定了。',
    '',
  );
  L.push('| # | 伏笔 | 埋下章节 | 预计回收 | 状态 | 备注 |', '|---|---|---|---|---|---|');
  L.push(userBlock('伏笔表', '<!-- 状态用：已埋 / 已回收 / 废弃。例：| 1 | 灯的创可贴是海洋生物系列 | Ch.1 | Ch.6 | 已埋 | 与「给心灵贴创可贴」呼应 | -->\n'));
  L.push('');
  L.push('## 原作可复用的意象（AUTO · 取自关键物品，供埋伏笔参考）', '');
  L.push(ITEMS.map((it) => `- **${it.name}**（${it.kind || '-'}）：${flat(it.summary)}`).join('\n'));
  L.push('');
  return L.join('\n');
}

function genWorldBookIndex() {
  const L = [];
  L.push(genHeader('原作词条索引', '世界书/mygo_ave_世界书.json'));
  L.push(`共 **${WB_ENTRIES.length}** 条。查详情请打开 \`世界书/mygo_ave_世界书.json\`。`, '');
  L.push('| # | 触发词 | 内容摘要 |', '|---|---|---|');
  WB_ENTRIES.forEach((e, i) => {
    const keys = (e.keys || []).join(' / ');
    const content = String(e.content || '').replace(/\s*\n\s*/g, ' ').trim();
    L.push(`| ${i + 1} | ${keys || '-'} | ${content.slice(0, 120)}${content.length > 120 ? '…' : ''} |`);
  });
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------- 角色卡生成

function genCard(char) {
  const b = char.basic || {};
  const p = char.personality || {};
  const cardFile = CARD_OF.get(char.id);
  const L = [];
  L.push(`# 角色卡片：${char.name_short || char.name}`);
  L.push('');
  L.push(`> 卡片编号：${String(CHARS.indexOf(char) + 1).padStart(3, '0')} ｜ 创建：初始化 ｜ 最后更新：初始化`);
  L.push(`> 来源：Our Notes 本地考据库（kb.json \`data_version: ${DATA_VERSION}\`）`);
  L.push(`> 考据文档：\`${char.doc || '—'}\`${cardFile ? ` ｜ 项目角色卡：\`${cardFile}\`` : ''}`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 🔒 固定属性（只读 — 不随剧情变化）');
  L.push('');
  L.push('### 基本身份');
  L.push(`- 姓名：${flat(char.name)}${char.stage ? ` ／ 舞台名：${flat(char.stage)}` : ''}${char.en ? ` ／ EN：${flat(char.en)}` : ''}`);
  L.push(`- 性别：${flat(b.性别) || '[待补充]'}`);
  L.push(`- 生日：${flat(b.生日) || '[待补充]'}${flat(b.星座) ? `（${flat(b.星座)}）` : ''}`);
  L.push(`- 血型：${flat(b.血型) || '[待补充]'}`);
  L.push(`- 国籍/出生地：日本${flat(b.出身地) ? ` · ${flat(b.出身地)}` : ''}`);
  L.push(`- 所属作品：BanG Dream!（Our Notes 考据库）`);
  L.push(`- 所属团体：${char.band || '—'}${char.role ? ` ｜ 担当：${flat(char.role)}` : ''}`);
  L.push('');
  L.push('### 外貌（不可变）');
  L.push(`- 身高：${flat(b.身高) || '[待补充]'}`);
  L.push(`- 体重：${flat(b.体重) || '[待补充]'}`);
  L.push(`- 发色/瞳色：${flat(b.发色) || '[待补充]'} / ${flat(b.瞳色) || '[待补充]'}`);
  L.push(`- 标志性特征：${flat(b.标志) || '[待补充]'}`);
  L.push(`- 主色：${flat(b.主色) || '[待补充]'}`);
  L.push('');
  L.push('### 性格底色（不可变）');
  L.push(`- 核心：${flat(p.core) || '[待补充]'}`);
  L.push(`- 想要：${flat(p.desire) || '[待补充]'}`);
  L.push(`- 害怕：${flat(p.fear) || '[待补充]'}`);
  L.push(`- 防御方式：${flat(p.defense) || '[待补充]'}`);
  L.push(`- 一句话：${flat(char.tagline) || flat(char.bio)}`);
  L.push(`- 优点：${flat(p.strengths) || '[待补充]'}`);
  L.push(`- 缺点：${flat(p.weaknesses) || '[待补充]'}`);
  L.push(`- 角色弧线：${flat(p.arc) || '[待补充]'}`);
  L.push(`- 喜欢的东西 / 兴趣：${flat(char.likes_interests) || flat(b.喜欢的东西) || '[待补充]'}`);
  L.push(`- 关键词 / 意象：${(char.keywords || []).join('、') || '[待补充]'}`);
  L.push('');
  L.push('### 说话风格（实测指纹 · 不可变）');
  if (char.speech && typeof char.speech === 'object') {
    for (const [k, v] of Object.entries(char.speech)) L.push(`- ${k}：${flat(v)}`);
  } else {
    L.push(`- ${flat(char.speech) || '[待补充]'}`);
  }
  L.push('');
  // ⚠️ **多形态角色必须分开给指纹**（2026-10-06 加）。
  //   kb 的 `speech` 是**按 kb id 合并**的，而有些角色在语料里是**多个 model**：
  //     睦 = mutsumi(本体) + mortis(第二人格) —— 合并 757 句
  //     初音 = hatsune + hatsune2
  //   而睦的 OOC 禁令第一条就是「一句话里第三人称『小睦』= 〔原文略〕」——
  //   **卡片却给不出 Mortis 的独立指纹，照这张卡写 Mortis 必然写飘。**
  //   这与 MEMORY 那条「演出层按上游 model 名统计，不按叙事身份归并」同源：
  //   kb 的 stage 字段把mortis 并进 mutsumi。
  //   所以：检出附属 model 就补一段现算的分形态指纹（数据源 _emotion_lines.jsonl）。
  const ALIAS = MULTI_MODEL_ALIAS[char.id];
  if (ALIAS) {
    L.push(`#### ⚠️ 分形态指纹（**不要用上面那段写 ${ALIAS.alt}**）`);
    L.push('');
    L.push('| 形态 | 台词 | 沉默行 | 均长 | 省略号率 | 含我率 | 疑问率 | 动作种类 |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const m of [char.id, ...ALIAS.others]) {
      const s = perModelSpeech(m);
      if (!s) { L.push(`| \`${m}\` | （语料里没有） | — | — | — | — | — | — |`); continue; }
      L.push(`| \`${m}\`${m === char.id ? '' : ` ← **${ALIAS.label(m)}**`} | ${s.台词} | ${s.沉默行} | ${s.均长} | ${s.省略号率}% | ${s.含我率}% | ${s.疑问率}% | ${s.动作种类} |`);
    }
    L.push('');
    L.push(`> ⚠️ **日文原文侧**（与上面那段中文指纹**口径不同，绝对值不可比，只做组内自比**）。`);
    L.push(`> 判据：${ALIAS.judge}`);
    L.push('');
  }
  if (char.addresses && Object.keys(char.addresses).length) {
    L.push('### 称呼习惯（实测频次 · 不可变）');
    L.push('| 称呼 | 次数 |');
    L.push('|---|---|');
    for (const [k, v] of Object.entries(char.addresses).sort((a, b) => b[1] - a[1])) {
      L.push(`| ${k} | ${v} |`);
    }
    L.push('');
  }
  L.push('### 硬禁令（OOC 红线 · 不可变）');
  if (Array.isArray(char.bans) && char.bans.length) {
    for (const x of char.bans) L.push(`- ${flat(x)}`);
  } else {
    L.push('- [待补充]');
  }
  L.push('');
  L.push('### 背景（固定历史）');
  L.push(`- 简介：${flat(char.bio) || '[待补充]'}`);
  L.push(`- 学校/班级：${flat(b.学校) || '[待补充]'}${flat(b.班级) ? ` · ${flat(b.班级)}` : ''}`);
  if (Array.isArray(char.states) && char.states.length) {
    L.push(`- 已知状态期：${char.states.map((s) => s.name).join(' → ')}`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 🔄 可变动属性（每章更新）');
  L.push('');
  L.push(userCardBlock('可变动属性', `- **年龄**：[待补充]
- **学年/班级**：${flat(b.班级) || '[待补充]'}
- **职业/身份**：${char.band || '[待补充]'}（${flat(char.role) || '[待补充]'}）
- **所属组织/势力**：${char.band || '[待补充]'}
- **社会地位/称号**：${char.stage ? flat(char.stage) : '[待补充]'}
- **名下资产**：[待补充]
- **能力/技能**：[待补充]
- **婚育状况**：[待补充]
- **人际关系网**：见下
`));
  L.push('');
  L.push('### 人际关系网（原作实测 · 可随本作变动）');
  if (Array.isArray(char.relations) && char.relations.length) {
    L.push('| 对象 | 称呼 | 语气实测 |', '|---|---|---|');
    for (const r of char.relations) L.push(`| ${flat(r.with)} | ${flat(r.call) || '-'} | ${flat(r.tone) || '-'} |`);
  } else {
    L.push('[待补充]');
  }
  L.push('');
  L.push(userCardBlock('本作原创关系', '<!-- 本作新增的人际关系写在这里，原作表不要动 -->\n'));
  L.push('');
  L.push('## 剧情定位');
  L.push(userCardBlock('剧情定位', `- 角色类型：[主角 / 女主角 / 反派 / 配角 / NPC → 升级]
- 剧情功能：[吐槽役 / 战斗担当 / 智慧担当 / 治愈担当 / 情报屋 / 保护对象]
- 剧情弧线预期：[待填]
- 登场章节：Ch.[待填]
- 退场/死亡章节：（如适用）
`));
  L.push('');
  L.push('## 章节追踪');
  L.push('| 章节 | 关键行为 | 可变动属性变化 |');
  L.push('|------|----------|----------------|');
  L.push(userCardBlock('章节追踪表', '<!-- 每章追加一行 -->\n'));
  L.push('');
  L.push('## 备注');
  L.push(userCardBlock('备注', '<!-- 作者备忘。跨作品联动注意事项写这里 -->\n'));
  L.push('');
  return L.join('\n');
}

function userCardBlock(name, body) {
  return `<!-- USER:START ${name} -->\n${body}<!-- USER:END -->`;
}

// ---------------------------------------------------------------- 落盘

/** 比较时剥掉「生成于」时间戳，否则每次重跑都会误判为有变化 */
const stripStamp = (s) => s.replace(/^> 生成于 .*$/m, '');

function writeFile(rel, content) {
  const abs = path.join(NOVEL, rel);
  const existed = fs.existsSync(abs);
  let out = content;
  if (existed) {
    const prev = fs.readFileSync(abs, 'utf8');
    const blocks = extractUserBlocks(prev);
    out = applyUserBlocks(content, blocks);
    // ⚠️ `--force` 也要**沿用原来的时间戳**（2026-10-06 修）。
    //   判据 `changed` 本来就用 `stripStamp` 比较，对「内容没变」是准的；
    //   但 `--force` 会无条件写盘，把时间戳也刷掉 → 5 个文件凭空各多 1 行 diff，
    //   「我明明什么都没改」却看到满屏变更。**时间戳是噪音，不是变更。**
    const oldStamp = prev.match(/^> 生成于 .*$/m);
    if (oldStamp) out = out.replace(/^> 生成于 .*$/m, oldStamp[0]);
  }
  const changed = !existed || stripStamp(fs.readFileSync(abs, 'utf8')) !== stripStamp(out);
  if (DRY) {
    console.log(`${existed ? (changed ? '  ~ 更新' : '  = 无变化') : '  + 新建'}  NovelProject/${rel}`);
    return;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (existed && !FORCE && !changed) {
    console.log(`  = 跳过  NovelProject/${rel}（无变化）`);
    return;
  }
  fs.writeFileSync(abs, out, 'utf8');
  console.log(`${existed ? '  ~ 更新' : '  + 新建'}  NovelProject/${rel}${existed && FORCE ? '（--force，USER 块已保留）' : ''}`);
}

// ---- 单卡模式
if (CARD) {
  const wanted = CARD.split(/[,，\s]+/).filter(Boolean);
  for (const w of wanted) {
    const c = resolveChar(w);
    if (!c) {
      console.error(`  ✗ 未找到角色「${w}」。用 --list 看可用 id。`);
      process.exitCode = 1;
      continue;
    }
    const idx = String(CHARS.indexOf(c) + 1).padStart(3, '0');
    const rel = `Characters/${idx}_${c.name_short || c.name}.md`;
    if (DRY) {
      console.log(`  + 将生成 NovelProject/${rel}`);
      continue;
    }
    fs.mkdirSync(path.join(NOVEL, 'Characters'), { recursive: true });
    const abs = path.join(NOVEL, rel);
    if (fs.existsSync(abs) && !FORCE) {
      console.log(`  = 跳过  NovelProject/${rel}（已存在，加 --force 覆盖）`);
      continue;
    }
    fs.writeFileSync(abs, genCard(c), 'utf8');
    console.log(`  + 新建  NovelProject/${rel}`);
  }
  process.exit(process.exitCode ?? 0);
}

// ---- 骨架模式
console.log(`初始化 NovelProject/ —— 数据源 data_version ${DATA_VERSION}`);
console.log(`  在册角色 ${CHARS.length} ｜ 团体 ${BANDS.size} ｜ 事件 ${EVENTS.length} ｜ 地点 ${PLACES.length} ｜ 物品 ${ITEMS.length} ｜ 词条 ${WB_ENTRIES.length}`);
if (DRY) console.log('  （--dry：不落盘）\n');

writeFile('README.md', genReadme());
writeFile('World.md', genWorld());
writeFile('Settings.md', genSettings());
writeFile('Factions.md', genFactions());
writeFile('Characters.md', genCharacters());
writeFile('Timeline.md', genTimeline());
writeFile('Foreshadows.md', genForeshadows());
writeFile('_原作词条索引.md', genWorldBookIndex());

// 角色卡模板：从 skill 目录复制
const tplSrc = path.join(SKILL_DIR, 'NovelProject', 'Characters', '_template.md');
const tplRel = 'Characters/_template.md';
if (fs.existsSync(tplSrc)) {
  const tpl = fs.readFileSync(tplSrc, 'utf8');
  if (DRY) {
    console.log(`  ${fs.existsSync(path.join(NOVEL, tplRel)) ? '~ 更新' : '+ 新建'}  NovelProject/${tplRel}（复制自 skill 模板）`);
  } else {
    fs.mkdirSync(path.join(NOVEL, 'Characters'), { recursive: true });
    if (fs.existsSync(path.join(NOVEL, tplRel)) && fs.readFileSync(path.join(NOVEL, tplRel), 'utf8') === tpl) {
      console.log(`  = 跳过  NovelProject/${tplRel}（无变化）`);
    } else {
      fs.writeFileSync(path.join(NOVEL, tplRel), tpl, 'utf8');
      console.log(`  + 新建  NovelProject/${tplRel}（复制自 skill 模板）`);
    }
  }
} else {
  console.warn(`  ! 未找到 skill 模板 ${tplSrc}，跳过 _template.md`);
}

if (!DRY) {
  console.log('');
  console.log('完成。下一步：');
  console.log('  1) 填 World.md 的「本作设定」USER 块（本作与考据基底的差异）');
  console.log('  2) node 工具/build_novel_env.mjs --card 灯,祥子   生成主角+女主卡片（固定属性已预填）');
  console.log('  3) 写 Chapter01.md');
}
