#!/usr/bin/env node
/**
 * 打包.mjs —— 一键把工作区打成 zip，自动跳过 .git / 隐藏目录 / 缓存 / 凭据
 *
 * 为什么要有它：资源管理器里右键「压缩到 zip」会把 .git(25M)、.cache(103M)、
 * .workbuddy(会话记忆)、.qoder 等隐藏目录全带上，而且**凭据文件（交接.md、
 * autodl-接入信息.md、含 API Key 的探测脚本）也会被打包进去** —— 交接.md 原文
 * 明确写着「请勿提交仓库或外发」。本脚本把这两件事一次性堵死。
 *
 * 排除口径（单一真源，不另抄一份清单）：
 *   1. **隐藏规则** —— 路径任一段以 `.` 开头即跳过（两个例外：
 *      `.gitignore` 本身保留、`.workbuddy/skills/` 是项目资产保留）
 *   2. **.gitignore 排除规则** —— 直接解析仓库根的 .gitignore（`!` 例外行不解析，
 *      改由上面的白名单保证），所以以后改 .gitignore 就是改打包口径
 *   3. **凭据硬保险** —— 落盘前再扫一遍清单，命中凭据名单直接报错退出（除非 --with-secrets）
 *
 * 用法：
 *   node 工具/打包.mjs                          # 打全量 → 上级目录/工作区名_时间戳.zip
 *   node 工具/打包.mjs --dry                    # 只列清单和体积，不落盘
 *   node 工具/打包.mjs --out D:/tmp/x.zip       # 指定 zip 路径（给目录则放里面）
 *   node 工具/打包.mjs --out 归档/ --slim       # --slim 去掉素材全量/与 masterdata/
 *   node 工具/打包.mjs --only 工具 --only mcp-canon
 *   node 工具/打包.mjs --exclude 角色模型 --exclude '*.log'
 *   node 工具/打包.mjs --add 归档/_打包/先看我.md          # 额外塞一个文件进 zip 顶层
 *   node 工具/打包.mjs --add a.md --addas docs/a.md       # 多个 --add 按顺序与 --addas 配对定 zip 内路径
 *   node 工具/打包.mjs --store                  # 不压缩（只打包），快但体积大
 *   node 工具/打包.mjs --no-verify              # 跳过落盘后自检（只探口径时用，别对外的包别跳）
 *   node 工具/打包.mjs --with-secrets           # 强制含凭据文件（自己备份时用）
 *
 * 说明：
 *   · zip 内部统一带一层顶层目录（工作区名），解压出来是个文件夹，不会散一地。
 *   · 纯 node 实现（zlib deflateRaw），不依赖系统 zip / PowerShell / 任何三方包。
 *   · 文件名按 UTF-8 写入并置 UTF-8 标志位，中文目录名不会乱码。
 */
import { readFileSync, statSync, readdirSync, existsSync, mkdirSync, openSync, writeSync, readSync, closeSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename, relative, sep } from 'node:path';
import { deflateRawSync, inflateRawSync, crc32 as zlibCrc32 } from 'node:zlib';
import { WS } from './_root.mjs';

/* ────────────────────────── 参数 ────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
/**
 * 取某个可重复参数的全部取值。
 * ⚠️ 别用 `argv.indexOf(a)` 反查位置 —— 重复传 `--exclude a --exclude b` 时 indexOf
 * 永远返回第一处，会把 b 悄悄换成 a（曾导致「只排除 工具、masterdata 漏进对外包」）。
 * 用一趟线性扫描按下标取值，不做任何反查。
 */
function many(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--' + name) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) continue;   // 缺值，或下一个又是别的开关
    out.push(v);
  }
  return out;
}
const one = (name) => (many(name)[0] ?? null);

const OPT = {
  dry: flag('dry'),
  noverify: flag('no-verify'),
  store: flag('store'),
  secrets: flag('with-secrets'),
  slim: flag('slim'),
  out: one('out'),
  only: many('only'),
  exclude: many('exclude'),
  /** 额外注入：--add <本地路径> 可多次；--addas <zip内路径> 按出现顺序与之配对，缺省放顶层 */
  add: many('add'),
  addas: many('addas'),
};

const WS_NAME = basename(resolve(WS));

/* ────────────────────────── 排除规则 ────────────────────────── */

/** 凭据名单：命中即中止（除非 --with-secrets）。口径来自 .gitignore 的「严禁外发」 */
const SECRETS = [
  '交接.md',                 // 无斜杠 = 任意层级文件名匹配
  'autodl-接入信息.md',
  '归档/_cloud_probe.mjs',
  '归档/_probe_cloud2.mjs',
  '归档/_md备份/交接.md',
];

/**
 * 隐藏项规则：**目录**以 `.` 开头一律排除（.git/.cache/.workbuddy 等，这是用户的主诉）；
 * **文件**以 `.` 开头默认保留（`.gitignore`、`.editorconfig` 这类是资产），只排除下面这份垃圾名单。
 */
const HIDDEN_KEEP = ['.workbuddy/skills'];   // 项目级 skill 是资产，连同它的祖先目录一起放行
const HIDDEN_FILE_DROP = [
  '.env', '.DS_Store', 'Thumbs.db', '.npmrc', '.bash_history',
  '.kb-embeddings.json',  // 17MB 向量缓存，带 model+hash 可重建，别塞进包里
];

/** --slim：游戏原文与大体积上游数据，给别人/上传时用 */
const SLIM_PATTERNS = ['素材全量/', 'masterdata/'];

/**
 * 把 gitignore 风格 pattern 转成判定函数。
 * 支持：`#` 注释、空行、尾部 `/`（仅目录）、`*`、`?`、`**`，以及无斜杠 = 任意层级。
 * `!` 例外行本脚本不解析（白名单走 HIDDEN_KEEP）。
 */
function compilePattern(raw) {
  let p = raw.trim();
  if (!p || p.startsWith('#')) return null;
  let negated = false;
  if (p.startsWith('!')) return null; // 例外不解析
  let dirOnly = false;
  if (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1); }
  if (p.startsWith('/')) p = p.slice(1);
  if (!p) return null;
  const anchored = p.includes('/');
  // 转正则：** → 任意（含 /），* → 非 / 任意，? → 单个非 /
  const re = new RegExp(
    '^' + p.split('/').map((seg) =>
      seg === '**' ? '.*'
        : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    ).join('/') + '$'
  );
  const base = basename(p);
  return {
    raw, dirOnly,
    test(rel, isDir, base_) {
      if (dirOnly && !isDir) return false;
      if (re.test(rel)) return true;
      if (!anchored && base_ === base) return true;           // 无斜杠：任意层级 basename 匹配
      if (anchored && rel.endsWith('/' + p)) return true;     // 祖先路径匹配（如 归档/_probe）
      return false;
    },
  };
}

const gitignorePath = join(WS, '.gitignore');
const RULES = [];
if (existsSync(gitignorePath)) {
  for (const line of readFileSync(gitignorePath, 'utf8').split(/\r?\n/)) {
    const r = compilePattern(line);
    if (r) RULES.push(r);
  }
}
for (const p of (OPT.slim ? SLIM_PATTERNS : [])) { const r = compilePattern(p); if (r) RULES.push(r); }
for (const p of OPT.exclude) { const r = compilePattern(p); if (r) RULES.push(r); }

function isHidden(rel) {
  return rel.split('/').some((seg) => seg.startsWith('.'));
}
/** 命中白名单本身，或是白名单的祖先目录（.workbuddy 不能整棵剪掉，里面有 skills） */
function underKeep(rel) {
  return HIDDEN_KEEP.some((k) => rel === k || rel.startsWith(k + '/') || k.startsWith(rel + '/'));
}

/** 判断 rel（相对工作区根，`/` 分隔）是否应排除 */
function excluded(rel, isDir) {
  const base_ = basename(rel);
  // 0) 白名单优先于一切排除规则（.gitignore 的 `!.workbuddy/skills/` 例外行本脚本不解析）
  if (underKeep(rel)) return null;
  // 1) 隐藏规则
  if (isHidden(rel)) {
    if (isDir) return '隐藏目录';
    if (HIDDEN_FILE_DROP.includes(base_) || base_.startsWith('.env')) return '隐藏文件';
  }
  // 2) .gitignore / --slim / --exclude
  for (const r of RULES) {
    if (r.test(rel, isDir, base_)) return `规则 ${r.raw}`;
  }
  return null;
}

/* ────────────────────────── 遍历 ────────────────────────── */

const ROOTS = OPT.only.length
  ? OPT.only.map((o) => o.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
  : [''];

const files = [];   // { rel, abs, size, mtime }
const dirs = [];    // { rel, mtime }
const skipped = new Map(); // 原因 → 条数
const skippedTop = [];     // 被排除的顶层条目（打给用户看）
let totalBytes = 0;

function noteSkip(reason, rel) {
  skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  const depth = rel.split('/').length;
  if (depth <= 2 || OPT.dry) skippedTop.push({ rel, reason });
}

function walk(relDir) {
  const absDir = relDir ? join(WS, relDir) : WS;
  let entries;
  try { entries = readdirSync(absDir, { withFileTypes: true }); }
  catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    // 顶层：--only 模式下不重复套根
    const isDir = e.isDirectory();
    const why = excluded(rel, isDir);
    if (why) { noteSkip(why, rel); continue; }
    if (isDir) {
      const st = statSync(join(WS, rel));
      dirs.push({ rel, mtime: st.mtime });
      walk(rel);
    } else if (e.isFile()) {
      const abs = join(WS, rel);
      const st = statSync(abs);
      files.push({ rel, abs, size: st.size, mtime: st.mtime });
      totalBytes += st.size;
    }
  }
}

// 顶层目录条目
for (const r of ROOTS) walk(r);

/* ─────────────────── 额外注入（--add / --addas）─────────────────── */

/**
 * 用途：往包里塞**不属于仓库**的东西，比如给外行看的「先看我.md」
 * （放在被 gitignore 的 归档/_打包/ 下，只进 zip、不入库）。
 * 注入项跳过全部排除规则 —— 它是你显式指名的，不走口径。
 */
for (let i = 0; i < OPT.add.length; i++) {
  const src = resolve(WS, OPT.add[i]);
  if (!existsSync(src)) { console.error(`[中止] --add 的文件不存在：${src}`); process.exit(1); }
  const rel = (OPT.addas[i] ?? basename(src)).replace(/\\/g, '/').replace(/^\/+/, '');
  const st = statSync(src);
  files.push({ rel, abs: src, size: st.size, mtime: st.mtime });
  totalBytes += st.size;
}

/* ────────────────────────── 凭据硬保险 ────────────────────────── */

const secretHits = files.filter((f) => SECRETS.some((s) => f.rel === s || f.rel.endsWith('/' + s))).map((f) => f.rel);
if (secretHits.length && !OPT.secrets) {
  console.error('\n[中止] 打包清单命中凭据文件，拒绝落盘：');
  for (const h of secretHits) console.error('  - ' + h);
  console.error('\n交接.md 原文写明「请勿提交仓库或外发」。确是自己备份请加 --with-secrets。\n');
  process.exit(1);
}

/* ────────────────────────── zip 编码 ────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  if (typeof zlibCrc32 === 'function') return zlibCrc32(buf);
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function dosStamp(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** 单文件体积超过这个就直接存（不压缩），避免大文件吃满内存 */
const STORE_LIMIT = 256 * 1024 * 1024;

function localHeader(nameBuf, crc, csize, usize, method, time, date) {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);          // version needed
  b.writeUInt16LE(0x0800, 6);      // flags: UTF-8 文件名
  b.writeUInt16LE(method, 8);
  b.writeUInt16LE(time, 10);
  b.writeUInt16LE(date, 12);
  b.writeUInt32LE(crc, 14);
  b.writeUInt32LE(csize, 18);
  b.writeUInt32LE(usize, 22);
  b.writeUInt16LE(nameBuf.length, 26);
  b.writeUInt16LE(0, 28);          // extra len
  return b;
}
function centralHeader(nameBuf, crc, csize, usize, method, time, date, offset, isDir) {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(20, 4);          // version made by
  b.writeUInt16LE(20, 6);          // version needed
  b.writeUInt16LE(0x0800, 8);
  b.writeUInt16LE(method, 10);
  b.writeUInt16LE(time, 12);
  b.writeUInt16LE(date, 14);
  b.writeUInt32LE(crc, 16);
  b.writeUInt32LE(csize, 20);
  b.writeUInt32LE(usize, 24);
  b.writeUInt16LE(nameBuf.length, 28);
  b.writeUInt16LE(0, 30);          // extra
  b.writeUInt16LE(0, 32);          // comment
  b.writeUInt16LE(0, 34);          // disk start
  b.writeUInt16LE(0, 36);          // internal attr
  b.writeUInt32LE(isDir ? 0x41ed0010 : 0x81ed0000, 38); // external attr（目录置 MS-DOS directory 位）
  b.writeUInt32LE(offset, 42);
  return b;
}
function eocd(count, cdSize, cdOffset) {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE(0, 6);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(cdSize, 12);
  b.writeUInt32LE(cdOffset, 16);
  b.writeUInt16LE(0, 20);
  return b;
}

/* ────────────────────────── 落盘 ────────────────────────── */

const stamp = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
})();

function defaultOut() {
  return join(dirname(resolve(WS)), `${WS_NAME}_${stamp}.zip`);
}
let outPath = OPT.out ? resolve(WS, OPT.out) : defaultOut();
if (!outPath.toLowerCase().endsWith('.zip')) outPath = join(outPath, `${WS_NAME}_${stamp}.zip`);

const MB = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

console.log(`\n打包: ${resolve(WS)}`);
console.log(`输出: ${outPath}`);
console.log(`条目: ${files.length} 文件 / ${dirs.length} 目录，原始合计 ${MB(totalBytes)}`);
console.log(`排除: ${[...skipped.entries()].map(([k, v]) => `${k}×${v}`).join('、') || '无'}`);
if (OPT.dry) {
  console.log(`\n[--dry] 未落盘。顶层被排除的条目：`);
  for (const s of skippedTop.slice(0, 40)) console.log(`  - ${s.rel}  (${s.reason})`);
  console.log('');
  process.exit(0);
}

mkdirSync(dirname(outPath), { recursive: true });
if (existsSync(outPath)) rmSync(outPath);
const fd = openSync(outPath, 'w');
/** writeSync 不保证一次写完（大 buffer / 信号中断会部分写），循环补齐 */
function writeAll(buf) {
  let n = 0;
  while (n < buf.length) n += writeSync(fd, buf, n, buf.length - n);
}
let offset = 0;
const central = [];
let compTotal = 0;
const t0 = Date.now();

/** zip 内部路径：统一套一层顶层目录 */
const zname = (rel) => `${WS_NAME}/${rel}`;

/**
 * ⚠️ usize 必须显式传入原始（未压缩）长度。
 * 曾经的 bug：这里直接拿 `bodyBuf.length` 当 usize —— 一旦走了 deflate，
 * 写进头里的「原始大小」就成了压缩后大小，而 CRC 却是按原始内容算的。
 * 结果是**整包静默损坏**：能列出、能解压，但 3519/3545 个文件 CRC 不匹配，
 * Windows 资源管理器 / 7-Zip 会报「数据错误」，Python zipfile 直接 BadZipFile。
 * 修完这条之后才加了落盘后的 verifyZip()。
 */
function emit(nameBuf, bodyBuf, crc, usize, method, mtime) {
  const { time, date } = dosStamp(mtime);
  const csize = bodyBuf.length;
  const lh = localHeader(nameBuf, crc, csize, usize, method, time, date);
  writeAll(lh); writeAll(nameBuf); writeAll(bodyBuf);
  central.push({ nameBuf, crc, csize, usize, method, time, date, offset, isDir: false });
  offset += lh.length + nameBuf.length + bodyBuf.length;
  compTotal += lh.length + nameBuf.length + bodyBuf.length;
}

// 目录条目（让解压出来空目录也还在）
for (const d of dirs) {
  const nameBuf = Buffer.from(zname(d.rel) + '/', 'utf8');
  const { time, date } = dosStamp(d.mtime);
  const lh = localHeader(nameBuf, 0, 0, 0, 0, time, date);
  writeAll(lh); writeAll(nameBuf);
  central.push({ nameBuf, crc: 0, csize: 0, usize: 0, method: 0, time, date, offset, isDir: true });
  offset += lh.length + nameBuf.length;
  compTotal += lh.length + nameBuf.length;
}

let done = 0;
for (const f of files) {
  const nameBuf = Buffer.from(zname(f.rel), 'utf8');
  if (f.size === 0) {
    emit(nameBuf, Buffer.alloc(0), 0, 0, 0, f.mtime);
  } else {
    const raw = readFileSync(f.abs);
    let method = 8, body = raw;
    if (OPT.store || raw.length > STORE_LIMIT) { method = 0; body = raw; }
    else {
      const z = deflateRawSync(raw, { level: 6 });
      if (z.length >= raw.length) { method = 0; body = raw; } else body = z;
    }
    emit(nameBuf, body, crc32(raw), raw.length, method, f.mtime);
  }
  if (++done % 500 === 0) process.stdout.write(`\r  已写入 ${done}/${files.length} ...`);
}
if (done >= 500) process.stdout.write('\r' + ' '.repeat(40) + '\r');

const cdOffset = offset;
let cdSize = 0;
for (const c of central) {
  const ch = centralHeader(c.nameBuf, c.crc, c.csize, c.usize, c.method, c.time, c.date, c.offset, c.isDir);
  writeAll(ch); writeAll(c.nameBuf);
  cdSize += ch.length + c.nameBuf.length;
}
writeAll(eocd(central.length, cdSize, cdOffset));
closeSync(fd);

/* ────────────────────────── 落盘后自检 ────────────────────────── */

/**
 * 把刚写出来的 zip 自己读回来，逐个条目解压并算 CRC。
 * 为什么必须有这一步：上面那个 usize bug 是**静默**的 —— 包能生成、能列目录、
 * 能开始解压，直到 CRC 校验时才炸。没有这道关，坏包会一路流到别人手里。
 * 默认全量；`--no-verify` 可关（比如只是想快速试一下排除口径）。
 */
function verifyZip(path) {
  const size = statSync(path).size;
  if (size > 512 * 1024 * 1024) return { skipped: '包 >512MB，跳过自检（改用外部 unzip -t 验证）' };
  const buf = Buffer.alloc(size);
  const vf = openSync(path, 'r');
  let n = 0;
  while (n < size) n += readSync(vf, buf, n, size - n, n);
  closeSync(vf);

  // EOCD：从尾部倒着找签名（本脚本不写 comment，但别人加过也能容错）
  let eo = -1;
  for (let i = size - 22; i >= 0 && i >= size - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eo = i; break; }
  }
  if (eo < 0) return { fatal: '找不到 EOCD —— 这个 zip 结构已损坏' };
  const count = buf.readUInt16LE(eo + 10);
  let p = buf.readUInt32LE(eo + 16);

  const bad = [];
  let checked = 0;
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) { bad.push({ name: `<条目${k}>`, why: '中央目录签名不对' }); break; }
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + cmtLen;

    if (usize === 0 && csize === 0) continue;      // 目录条目
    // 定位数据区（走 local header，不信 central 里的 offset 之外的东西）
    if (buf.readUInt32LE(lho) !== 0x04034b50) { bad.push({ name, why: 'local header 签名不对' }); continue; }
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataOff = lho + 30 + lNameLen + lExtraLen;
    const stored = buf.slice(dataOff, dataOff + csize);
    let plain;
    try { plain = method === 8 ? inflateRawSync(stored) : stored; }
    catch (e) { bad.push({ name, why: '解压失败: ' + e.message }); continue; }
    checked++;
    if (plain.length !== usize) { bad.push({ name, why: `解压后 ${plain.length} 字节 ≠ 头里记的 ${usize}` }); continue; }
    const got = crc32(plain) >>> 0;
    if (got !== crc) { bad.push({ name, why: `CRC ${got.toString(16)} ≠ 头里记的 ${(crc >>> 0).toString(16)}` }); }
  }
  return { checked, count, bad };
}

if (!OPT.noverify) {
  process.stdout.write('  自检中 ...');
  const t1 = Date.now();
  const v = verifyZip(outPath);
  process.stdout.write('\r' + ' '.repeat(20) + '\r');
  if (v.fatal || v.skipped) {
    console.log(`自检: ${v.fatal ?? v.skipped}`);
    if (v.fatal) process.exit(1);
  } else if (v.bad.length) {
    console.error(`\n[✗ 自检失败] ${v.bad.length}/${v.checked} 个条目有问题，这个包是坏的，别外发：`);
    for (const b of v.bad.slice(0, 10)) console.error(`  - ${b.name}：${b.why}`);
    console.error('');
    process.exit(1);
  } else {
    console.log(`自检: ${v.checked} 个条目全部 CRC 通过（${((Date.now() - t1) / 1000).toFixed(1)}s）`);
  }
}

const zipSize = statSync(outPath).size;
const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n完成: ${zipSize ? MB(zipSize) : '0'} / 原始 ${MB(totalBytes)}` +
  (totalBytes ? `（压缩率 ${((1 - zipSize / totalBytes) * 100).toFixed(0)}%）` : '') + `，用时 ${sec}s`);
console.log(`凭据: ${secretHits.length ? `⚠ 含 ${secretHits.join('、')}（--with-secrets）` : '已确认不含交接.md / autodl-接入信息.md'}\n`);
