#!/usr/bin/env node
/**
 * 章节标题表：MasterAdv._titleTextId → MasterText 四语文案
 *
 * 用法：
 *   node 工具/build_chapter_titles.mjs            # 生成/刷新 资料库/_chapter_titles.json
 *   node 工具/build_chapter_titles.mjs --check    # 只校验（自检用）
 *   node 工具/build_chapter_titles.mjs --show     # 打印抽样
 *
 * 产出：资料库/_chapter_titles.json
 *   { _generated, _source, _note, n, titles: { "<advId>": { ja, zh, en, script, kind } } }
 *
 * kind 由剧本名推断：本篇 / 番外 / 羁绊剧 / 演出结束对话 / 主页剧情 / 其它
 *
 * 幂等：连跑第二次内容不变（_generated 时间戳在比较时剥掉）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MASTER_ADV = join(ROOT, 'masterdata', 'master', 'MasterAdv.json');
const MASTER_TEXT = join(ROOT, 'masterdata', 'master', 'MasterText.json');
const OUT = join(ROOT, '资料库', '_chapter_titles.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const asArray = (j) => (Array.isArray(j) ? j : (j.data ?? j.entries ?? j.list ?? Object.values(j)[0]));

/* 乐队 key：本篇 / 番外脚本名的第二段 */
const BAND_KEYS = ['mygo', 'mujica', 'yumemita', 'millsage', 'kadan'];

/** 剧本名 → 篇章类型。实测 946 条零缺失，模式见 --show */
function kindOf(script) {
  if (!script) return '未知';
  if (/_linkstory_\d+$/.test(script)) return '羁绊剧';
  if (/_exstory_/.test(script)) return '番外';
  if (/^adv_script_tutorial_/.test(script)) return '教程';
  if (/^adv_script_home_/.test(script)) return '主页剧情';
  if (/^adv_script_afterlive_/.test(script)) return '演出结束对话';
  if (/^adv_script_anotherstory_/.test(script)) return '支线剧情';
  /* 本篇：adv_script_{bandkey}_{编号}_1_{话序} */
  if (new RegExp(`^adv_script_(${BAND_KEYS.join('|')})_\\d+_1_\\d+$`).test(script)) return '本篇';
  return '其它';
}

function build() {
  const adv = asArray(JSON.parse(readFileSync(MASTER_ADV, 'utf8')));
  const txt = asArray(JSON.parse(readFileSync(MASTER_TEXT, 'utf8')));

  const map = new Map();
  for (const o of txt) {
    const id = o._id ?? o.id;
    if (id) map.set(id, o);
  }

  const titles = {};
  const kinds = new Map();
  let miss = 0;
  for (const a of adv) {
    const id = String(a._id);
    const script = a._sheetName ?? a._advEpisodeAsset ?? '';
    const t = map.get(a._titleTextId);
    if (!t) { miss++; continue; }
    titles[id] = {
      ja: t._japanese ?? '',
      zh: t._simplifiedChinese ?? '',
      en: t._english ?? '',
      script,
      kind: kindOf(script),
    };
    kinds.set(titles[id].kind, (kinds.get(titles[id].kind) ?? 0) + 1);
  }

  return {
    _generated: new Date().toISOString(),
    _source: ['masterdata/master/MasterAdv.json', 'masterdata/master/MasterText.json'],
    _note: '官方章节标题，四语齐全。zh 取 _simplifiedChinese。kind 由剧本名推断。',
    n: Object.keys(titles).length,
    _miss: miss,
    _kinds: Object.fromEntries([...kinds].sort((x, y) => y[1] - x[1])),
    titles,
  };
}

/** 剥掉时间戳后比较，避免每次重跑都误判为有变化 */
function sameExceptTime(a, b) {
  const strip = (o) => JSON.stringify({ ...o, _generated: '' });
  return strip(a) === strip(b);
}

function main() {
  if (has('--check')) {
    if (!existsSync(OUT)) { console.error('[check] 缺产物 ' + OUT); process.exit(1); }
    const cur = JSON.parse(readFileSync(OUT, 'utf8'));
    if (!cur.n || cur.n < 900) { console.error('[check] 标题数异常 ' + cur.n); process.exit(1); }
    if (cur._miss > 0) { console.error('[check] 有 ' + cur._miss + ' 条缺标题'); process.exit(1); }
    const fresh = build();
    if (!sameExceptTime(cur, fresh)) { console.error('[check] 内容与上游不一致，需重跑'); process.exit(1); }
    console.log('[check] 章节标题 OK：' + cur.n + ' 条，类型分布 ' + JSON.stringify(cur._kinds));
    return;
  }

  const data = build();

  if (has('--show')) {
    for (const id of ['10000', '10015', '10100', '10459', '10201']) {
      const t = data.titles[id];
      if (t) console.log(id + ' [' + t.kind + '] ' + t.ja + ' / ' + t.zh);
    }
    console.log('类型分布', JSON.stringify(data._kinds));
    return;
  }

  let mode = '生成';
  if (existsSync(OUT)) {
    try {
      const cur = JSON.parse(readFileSync(OUT, 'utf8'));
      if (sameExceptTime(cur, data)) { console.log('= 跳过（无变化）'); mode = '跳过'; }
    } catch { /* 解析失败则重写 */ }
  }
  if (mode === '生成') writeFileSync(OUT, JSON.stringify(data, null, 1), 'utf8');
  console.log('[章节标题] ' + mode + '：' + data.n + ' 条 → 资料库/_chapter_titles.json');
  console.log('  类型分布 ' + JSON.stringify(data._kinds));
}

main();
