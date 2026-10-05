#!/usr/bin/env node
/**
 * 生成文件清单.mjs —— 重建 `素材全量/文件清单.md`（文件级总台账）
 *
 * 为什么现在才有生成器：这份台账 2026-10-04 被发现落后 36 行（2,545 vs 2,581 个内容文件），
 * 当时 `更新内容与功能介绍.md` §5.1 记的是「缺生成器入口，属独立一件事」。本文件补上那个入口。
 *
 * 口径（写死，别再靠记忆）：
 *   - 统计范围 = `素材全量/` 递归全部文件，**不含 `文件清单.md` 自身**（旧版也从未列入）；
 *   - 路径用反斜杠分隔（Windows 形制，与旧文件一致）；
 *   - 排序 = 整条相对路径 `localeCompare(…, 'zh')`（拼音序）；
 *   - 汇总表的「合计」含根目录散文件（校验报告.md / 总索引.md），与旧版一致，
 *     但表内只列目录行 —— 根文件数另在备注里写明，避免「合计 ≠ 各行之和」看起来像 bug。
 *
 * 用法：
 *   node 工具/生成文件清单.mjs            # 打印到 stdout，不写盘
 *   node 工具/生成文件清单.mjs --write    # 写 素材全量/文件清单.md（LF，与旧文件一致）
 *   node 工具/生成文件清单.mjs --check    # 只核对：现有清单与实况差多少，退出码 0/1
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WS = join(fileURLToPath(import.meta.url), '..', '..');
const ROOT = join(WS, '素材全量');
const OUT = join(ROOT, '文件清单.md');
const SELF = '文件清单.md';
const BS = String.fromCharCode(92);
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const CHECK = argv.includes('--check');

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((en) => {
  const p = join(d, en.name);
  return en.isDirectory() ? walk(p) : [p];
});

const files = walk(ROOT)
  .filter((p) => relative(ROOT, p) !== SELF)
  .map((p) => ({ rel: relative(ROOT, p).split(sep).join(BS), bytes: statSync(p).size }))
  .sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));

/* 顶层分组（目录行 + 根散文件） */
const groups = new Map();
for (const f of files) {
  const g = f.rel.includes(BS) ? f.rel.slice(0, f.rel.indexOf(BS) + BS.length) : '(根目录)';
  const cur = groups.get(g) || { n: 0, b: 0 };
  cur.n++; cur.b += f.bytes;
  groups.set(g, cur);
}
const dirRows = [...groups].filter(([g]) => g !== '(根目录)')
  .sort((a, b) => a[0].localeCompare(b[0], 'zh'));
const rootG = groups.get('(根目录)') || { n: 0, b: 0 };
const totalN = files.length;
const totalB = files.reduce((s, f) => s + f.bytes, 0);

const L = [];
L.push('# 素材全量 · 文件级总台账', '');
L.push('> 自动生成 ｜ 用于交接核对（是否缺文件、体积是否异常）', '');
L.push(`> 生成器：\`node 工具/生成文件清单.mjs --write\`（排序=整条相对路径拼音序；不含本文件自身）`, '');
L.push('| 目录 | 文件数 | 字节 |');
L.push('|---|---|---|');
for (const [g, v] of dirRows) L.push(`| ${g.replace(/\\$/, '')} | ${v.n} | ${v.b} |`);
L.push(`| （根散文件） | ${rootG.n} | ${rootG.b} |`);
L.push(`| **合计** | **${totalN}** | **${totalB}** |`);
L.push('');
L.push('## 完整文件清单', '');
L.push('```');
for (const f of files) L.push(`${String(f.bytes).padStart(9)}  ${f.rel}`);
L.push('```');
const md = L.join('\n') + '\n';

if (CHECK) {
  const old = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
  const rows = old.slice(old.indexOf('## 完整文件清单')).split('\n');
  const s = rows.indexOf('```');
  const e = rows.indexOf('```', s + 1);
  const oldSet = new Map(rows.slice(s + 1, e).filter((x) => x.trim())
    .map((x) => [x.trim().replace(/^\d+\s+/, '').trim(), +x.trim().split(/\s+/)[0]]));
  const added = files.filter((f) => !oldSet.has(f.rel));
  const gone = [...oldSet.keys()].filter((p) => !files.some((f) => f.rel === p));
  const drift = files.filter((f) => oldSet.has(f.rel) && oldSet.get(f.rel) !== f.bytes);
  console.log(`现有清单 ${oldSet.size} 行 ｜ 实况 ${files.length} 个文件`);
  console.log(`  新增 ${added.length}：${added.slice(0, 8).map((f) => f.rel).join(' , ')}${added.length > 8 ? ' …' : ''}`);
  console.log(`  缺失 ${gone.length}：${gone.slice(0, 8).join(' , ') || '无'}`);
  console.log(`  字节漂移 ${drift.length}：${drift.slice(0, 8).map((f) => f.rel).join(' , ') || '无'}`);
  const ok = !added.length && !gone.length && !drift.length;
  console.log(ok ? '✓ 清单与实况一致' : '✗ 清单已过期（跑 --write 重建）');
  process.exit(ok ? 0 : 1);
}

if (WRITE) {
  writeFileSync(OUT, md, 'utf8');   // LF：与旧文件行制一致（旧版通篇 LF，勿改成 CRLF 免得 diff 全红）
  console.log(`已写 → 素材全量/文件清单.md（${files.length} 个文件 / ${totalB} 字节）`);
} else {
  process.stdout.write(md);
}
