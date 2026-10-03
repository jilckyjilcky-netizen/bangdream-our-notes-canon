#!/usr/bin/env node
/**
 * _bench-who.mjs —— who 打分器回测（v1.0 vs 当前；单句 vs 多句）
 *
 * 做法：把 25 人的 quote_bank 拆成句，作为"已知说话人"的测试句，
 * 看打分器能否把真说话人排到 top-1 / top-3。
 *
 * ⚠️ 口径声明：这是**同源检验（in-sample）**——语言指纹指标本身就是从同一批语料算出来的，
 *    所以绝对准确率会被高估，**不能**当作"真人盲测水平"。
 *    它唯一成立的作用是：在**同一批样本、同一个指标**下，比较两个打分器 / 两种聚合方式谁更好。
 *
 * 用法：node mcp-canon/_bench-who.mjs [--json]
 */
import { kb, splitSentences, scoreLegacy, scoreCharacters, fingerprintOf, whoGuess } from './canon-tools.mjs';

const asJson = process.argv.includes('--json');

/* ---------- 测试集：每人一句池 ---------- */
const pools = kb.characters.map(c => ({ name: c.name_short, sents: splitSentences(c.quote_bank || []) })).filter(p => p.sents.length);
const TOTAL_SINGLE = pools.reduce((s, p) => s + p.sents.length, 0);

const seedInt = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const shuffle = (arr, seed) => { const r = mulberry32(seedInt(seed)); const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const score = (rank, truth) => ({ top1: rank[0] === truth ? 1 : 0, top3: rank.slice(0, 3).includes(truth) ? 1 : 0 });
const acc = (rows) => ({
  n: rows.length,
  top1: +(100 * rows.reduce((s, r) => s + r.top1, 0) / rows.length).toFixed(1),
  top3: +(100 * rows.reduce((s, r) => s + r.top3, 0) / rows.length).toFixed(1),
});

/* ---------- 变体 ---------- */
const variants = [];
const push = (label, rows) => variants.push({ label, ...acc(rows), per: rows });

// ① v1.0 单句
push('v1.0 单句（旧打分器）', pools.flatMap(p => p.sents.map(s => {
  const g = scoreLegacy(s).guesses.map(x => x.name);
  return { truth: p.name, ...score(g, p.name) };
})));

// ② v1.0 多句拼接（旧工具拿到多句时的实际行为：不拆句，整段当一句）
push('v1.0 多句拼接（不拆句）', pools.flatMap(p => {
  const groups = chunk(shuffle(p.sents, `legacy-${p.name}`), 3).filter(g => g.length === 3);
  return groups.map(g => ({ truth: p.name, ...score(scoreLegacy(g.join('')).guesses.map(x => x.name), p.name) }));
}));

// ③ v1.1 单句：三种打分口径 × 波浪号维度开关
for (const mode of ['raw', 'z', 'rank']) {
  for (const includeWave of [true, false]) {
    push(`v1.1 单句·${mode}${includeWave ? '' : '（无波浪号）'}`, pools.flatMap(p => p.sents.map(s => {
      const r = whoGuess(s, { includeWave, mode });
      return { truth: p.name, ...score(r.guesses.map(x => x.name), p.name) };
    })));
  }
}

// ④ v1.1 多句：聚合 / 投票 × 打分口径
for (const k of [3, 5]) {
  const eligible = pools.filter(p => p.sents.length >= k * 2);
  for (const mode of ['raw', 'z', 'rank']) {
    for (const method of ['aggregate', 'vote']) {
      push(`v1.1 ${k}句·${method === 'vote' ? '多数票' : '聚合'}·${mode}`, eligible.flatMap(p => {
        const groups = chunk(shuffle(p.sents, `${method}-${p.name}`), k).filter(g => g.length === k);
        return groups.map(g => {
          const r = whoGuess(g, { method, mode });
          return { truth: p.name, ...score(r.guesses.map(x => x.name), p.name) };
        });
      }));
    }
  }
}

// ⑤ 逐维度消融（raw 口径）：确认有没有"有害维度"。默认关，--ablate 打开。
if (process.argv.includes('--ablate')) {
  const ALL_DIMS = ['句长均值(汉字)', '≤6字占比', '省略号率', '以…结尾', '疑问率', '以!结尾', '含我率', '口吃率', '小X呼称率', '波浪号'];
  const groups3 = new Map(pools.filter(p => p.sents.length >= 6).map(p => [p.name, chunk(shuffle(p.sents, `aggregate-${p.name}`), 3).filter(g => g.length === 3)]));
  for (const d of ALL_DIMS) {
    push(`消融·去掉「${d}」单句`, pools.flatMap(p => p.sents.map(s => {
      const r = scoreCharacters(fingerprintOf([s]), { drop: [d] });
      return { truth: p.name, ...score(r.map(x => x.name), p.name) };
    })));
    push(`消融·去掉「${d}」3句聚合`, [...groups3.entries()].flatMap(([name, gs]) => gs.map(g => {
      const r = scoreCharacters(fingerprintOf(g), { drop: [d] });
      return { truth: name, ...score(r.map(x => x.name), name) };
    })));
  }
}

function chunk(a, k) { const o = []; for (let i = 0; i < a.length; i += k) o.push(a.slice(i, i + k)); return o; }

/* ---------- 输出 ---------- */
const N = kb.characters.length;
const baseline = [+(100 / N).toFixed(1), +(300 / N).toFixed(1)];

if (asJson) {
  console.log(JSON.stringify({ 测试句数: TOTAL_SINGLE, 变体: variants.map(({ per, ...v }) => v), 随机基线: { top1: baseline[0], top3: baseline[1] } }, null, 2));
} else {
  console.log(`\nwho 打分器回测 ｜ 测试句 ${TOTAL_SINGLE} 句 ｜ 候选 ${N} 人 ｜ 随机基线 top1 ${baseline[0]}% / top3 ${baseline[1]}%`);
  console.log('（同源检验 in-sample：绝对值会偏高，只用于变体之间互相比较）\n');
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].reduce((w, ch) => w + (/[\u4e00-\u9fa5]/.test(ch) ? 2 : 1), 0)));
  console.log(pad('变体', 34) + pad('样本', 8) + pad('top1', 8) + 'top3');
  console.log('-'.repeat(58));
  for (const v of variants) console.log(pad(v.label, 34) + pad(v.n, 8) + pad(v.top1 + '%', 8) + v.top3 + '%');

  const best = [...variants].sort((a, b) => b.top1 - a.top1)[0];
  console.log(`\n最佳变体：${best.label}（top1 ${best.top1}% / top3 ${best.top3}%）`);
  const weak = Object.entries(best.per.reduce((m, r) => { (m[r.truth] ||= []).push(r); return m; }, {}))
    .map(([name, rs]) => ({ name, top1: +(100 * rs.reduce((s, r) => s + r.top1, 0) / rs.length).toFixed(0), n: rs.length }))
    .filter(x => x.n >= 3).sort((a, b) => a.top1 - b.top1).slice(0, 6);
  console.log('该变体下最难认的 6 人：' + weak.map(w => `${w.name} ${w.top1}%(${w.n})`).join(' ｜ '));
}
