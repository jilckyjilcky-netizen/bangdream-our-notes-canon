#!/usr/bin/env node
/**
 * _闸门核对.mjs —— 复算某一回合的语言指纹闸门（用满 topK=25）
 *
 * 为什么需要它：第一局跑通时闸门打印的是「祥子 排名第 0（偏差 undefined）」——
 * 因为当时 who 只取了前三名，本人排到第 4 名就「报不出来」，而不是"没问题"。
 * 这个脚本从落地档里取回**当时被闸门打过分的那些台词**，用满 25 名复算，
 * 直接给出：本人第几名、偏差多少、**最大偏差是哪几项**（打回时要照这个写理由）。
 *
 * 用法：node 跑道/_闸门核对.mjs [回合号，默认 1]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { whoGuess } from '../mcp-canon/canon-tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const 局 = JSON.parse(readFileSync(join(HERE, '台账', '局.json'), 'utf8'));
const 主 = JSON.parse(readFileSync(join(HERE, '开局.json'), 'utf8')).主视角;
const n = Number(process.argv[2] || 局.回合 || 1);
const 路径 = join(HERE, '台账', '回合', `第${n}回合.md`);
if (!existsSync(路径)) { console.error(`没有 ${路径}`); process.exit(1); }

/* 演出段落里的台词行：形如 `- 祥子：「…」` */
const 全文 = readFileSync(路径, 'utf8');
const 台词段 = 全文.split('## 演出')[1]?.split('## 闸门')[0] || '';
const 台词 = 台词段.split('\n')
  .filter((l) => l.startsWith(`- ${主}：`) || l.startsWith(`- ${主}:`))
  .map((l) => l.replace(/^-\s*[^：:]+[：:]/, '').replace(/^「|」$/g, '').trim())
  .filter(Boolean);

console.log(`第 ${n} 回合｜主视角 ${主}｜台词 ${台词.length} 行`);
for (const t of 台词) console.log(`  「${t}」`);
if (!台词.length) { console.log('本回合没有台词，闸门不评分'); process.exit(0); }

const r = whoGuess(台词, { topK: 25 });
if (r.error) { console.error(r.error); process.exit(1); }
const i = (r.guesses || []).findIndex((g) => g.name === 主);
const mine = i >= 0 ? r.guesses[i] : null;
console.log(`\n句数 ${r.句数}｜leader ${r.leader}`);
console.log(`${主} 排名第 ${i >= 0 ? i + 1 : '—'} / ${r.guesses.length}（偏差 ${mine?.score ?? '—'}）`);
console.log(`${主} 最大偏差项：${(mine?.worst || []).join('、') || '—'}`);
console.log(`前三：${r.guesses.slice(0, 3).map((g) => `${g.name} ${g.score}`).join(' / ')}`);
console.log(`\n结论：${r.leader === 主 ? '✓ 指纹过关（leader 就是本人）' : `⚠ leader 是「${r.leader}」，本人第 ${i + 1} 名 —— 要演得更像，照上面「最大偏差项」调`}`);
