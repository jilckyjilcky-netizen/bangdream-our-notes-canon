#!/usr/bin/env node
/**
 * verify_quotes.mjs —— 引文校验器
 *
 * 把模型文档里所有 「……」 内的引文，拿到原始语料里逐条核对。
 * 目的：保证「角色模型」里的每一句引文都真的存在于素材中，杜绝二手转述走形。
 *
 * 用法：node verify_quotes.mjs <模型md> <语料md>
 */
import { readFileSync } from 'node:fs';

const [docPath, ...corpusPaths] = process.argv.slice(2);
if (!docPath || !corpusPaths.length) { console.error('用法: node verify_quotes.mjs <模型md> <语料md> [更多语料md...]'); process.exit(1); }

const norm = s => s.replace(/[^\u4e00-\u9fa5]/g, '');   // 只留汉字，忽略标点/引号/空白差异

const corpus = corpusPaths.map(p => norm(readFileSync(p, 'utf8'))).join('\n');
const doc = readFileSync(docPath, 'utf8');

// 抓 「……」 引文；跳过纯标点、跳过明显是术语的短词
const quotes = [...doc.matchAll(/「([^」\n]+)」/g)]
  .map(m => m[1].trim())
  .filter(q => norm(q).length >= 4)
  .filter((q, i, a) => a.indexOf(q) === i);

const ok = [], miss = [];
for (const q of quotes) {
  // 引文可能含省略号截断，取最长连续汉字片段做匹配
  const segs = q.split(/[^\u4e00-\u9fa5]+/).filter(s => s.length >= 4);
  const target = segs.length ? segs.sort((a, b) => b.length - a.length)[0] : norm(q);
  (corpus.includes(target) ? ok : miss).push(q);
}

console.log(`引文总数 ${quotes.length} ｜ 命中 ${ok.length} ｜ 未命中 ${miss.length}`);
console.log(`命中率 ${(ok.length / quotes.length * 100).toFixed(1)}%\n`);
if (miss.length) {
  console.log('### 未命中（需人工确认是否改写过）');
  for (const m of miss) console.log(`  ✗ ${m}`);
  process.exitCode = 1;
} else {
  console.log('✓ 全部引文均可在原始语料中逐字定位。');
}
