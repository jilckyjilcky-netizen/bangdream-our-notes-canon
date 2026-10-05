#!/usr/bin/env node
/**
 * 角色表.mjs —— 25 名乐队角色 ＋ 附加角色 的路径映射（audit_models 的数据源）
 *
 * 原文件在 订单队列/角色表.mjs（云队列停运后目录未迁移，脚本也从未入 git），
 * 这里按同一规则从 素材全量/按角色/zh-Hans/ 五个乐队目录的文件名派生：
 *   - corpus: 素材全量/按角色/zh-Hans/{乐队}/{短名}_{全名}.md
 *   - model : 角色模型/{乐队目录}/{短名}_{全名}_角色扮演模型.md
 *   - fp    : 角色模型/指纹/{短名}_{全名}_语言指纹报告.md
 *   - sp    : 角色模型/系统提示词/{短名}_{全名}_系统提示词.md
 * 乐队名对照：素材目录用全名（Ave Mujica / 一家Dumb Rock），模型目录用拼接名（AveMujica / 一家DumbRock）。
 *
 * EXTRA_CHARS：不在五支乐队编制内、但已有完整《角色扮演模型》的在册角色（真奈）。
 *   语料落在 素材全量/按角色全量/zh-Hans/（按角色/ 里她在「配角」目录、没有独立文件），
 *   故这里显式给出 corpus 路径；其余路径规则与主角色完全一致。
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WS } from './_root.mjs';

const BAND_DIR = {
  'MyGO': 'MyGO',
  'Ave Mujica': 'AveMujica',
  '梦限大MewType': '梦限大MewType',
  'millsage': 'millsage',
  '一家Dumb Rock': '一家DumbRock',
};
const CODE = { 'MyGO': 'MyGO', 'Ave Mujica': 'AveM', '梦限大MewType': '梦限', 'millsage': 'mill', '一家Dumb Rock': 'Dumb' };

const CHARS = [];
for (const [band, dir] of Object.entries(BAND_DIR)) {
  for (const f of readdirSync(join(WS, '素材全量', '按角色', 'zh-Hans', band))) {
    if (!f.endsWith('.md')) continue;
    const [k, full] = f.replace(/\.md$/, '').split('_');
    CHARS.push({ k, full, g: CODE[band], band, dir });
  }
}

/* 附加角色（非乐队编制；真奈 = sumimi 主唱）。corpus 用「按角色全量」版式。
 * 2026-10-05 新增薇欧拉：妖精花束队长、MewType 主线操盘型反派（官方 MasterCharacter 25 人编制外，
 * 与诗船/清告同类，但有自己的组合，故单列 角色模型/妖精花束/ 目录）。
 * 短名 = 全名（剧本里只有「薇欧拉」／日 ビオラ／英 Viola），与凛凛子同例。
 *
 * 2026-10-05 第二批：16 名主线相关 NPC（见 _add_npc_batch1/2.mjs）。
 *   dir 取「主线归属」而非「编制」——奏多属 millsage、初音属 Ave Mujica 主线，以此类推；
 *   南（森南）与丰川家三人同归 NPC，波波/蓓儿归妖精花束。
 *   只有剧本里给过全名的才写全名（初音＝三角初音、南＝森南），其余短名 = 全名。 */
const EXTRA_CHARS = [
  { k: '真奈', full: '纯田真奈', g: 'Sumi', band: 'Sumimi', dir: 'Sumimi', corpus: '素材全量/按角色全量/zh-Hans/真奈_纯田真奈.md' },
  { k: '薇欧拉', full: '薇欧拉', g: 'Fee', band: '妖精花束', dir: '妖精花束', corpus: '素材全量/按角色全量/zh-Hans/薇欧拉_薇欧拉.md' },
  /* --- 主角级（语料 ≥75 句，产角色卡与人设 skill） --- */
  { k: '奏多', full: '泽海奏多', g: 'mill', band: 'millsage', dir: 'millsage', corpus: '素材全量/按角色全量/zh-Hans/奏多_泽海奏多.md' },
  { k: '初音', full: '三角初音', g: 'AveM', band: 'Ave Mujica', dir: 'AveMujica', corpus: '素材全量/按角色全量/zh-Hans/初音_三角初音.md' },
  { k: '铃木', full: '铃木', g: 'Dumb', band: '一家Dumb Rock', dir: '一家DumbRock', corpus: '素材全量/按角色全量/zh-Hans/铃木_铃木.md' },
  { k: '蕾叶的祖母', full: '蕾叶的祖母', g: 'Dumb', band: '一家Dumb Rock', dir: '一家DumbRock', corpus: '素材全量/按角色全量/zh-Hans/蕾叶的祖母_蕾叶的祖母.md' },
  { k: '小春', full: '小春', g: '梦限', band: '梦限大MewType', dir: '梦限大MewType', corpus: '素材全量/按角色全量/zh-Hans/小春_小春.md' },
  /* --- 主线相关（薄样本，只进数据层 + 模型文档 + 系统提示词） --- */
  { k: '南', full: '森南', g: 'NPC', band: 'NPC', dir: 'NPC', corpus: '素材全量/按角色全量/zh-Hans/南_森南.md' },
  { k: '波波', full: '波波', g: 'Fee', band: '妖精花束', dir: '妖精花束', corpus: '素材全量/按角色全量/zh-Hans/波波_波波.md' },
  { k: '蓓儿', full: '蓓儿', g: 'Fee', band: '妖精花束', dir: '妖精花束', corpus: '素材全量/按角色全量/zh-Hans/蓓儿_蓓儿.md' },
  { k: 'Raki', full: 'Raki', g: '梦限', band: '梦限大MewType', dir: '梦限大MewType', corpus: '素材全量/按角色全量/zh-Hans/Raki_Raki.md' },
  { k: '波塔', full: '波塔', g: '梦限', band: '梦限大MewType', dir: '梦限大MewType', corpus: '素材全量/按角色全量/zh-Hans/波塔_波塔.md' },
  { k: '小萤', full: '小萤', g: 'mill', band: 'millsage', dir: 'millsage', corpus: '素材全量/按角色全量/zh-Hans/小萤_小萤.md' },
  { k: '柚衣奈', full: '柚衣奈', g: '梦限', band: '梦限大MewType', dir: '梦限大MewType', corpus: '素材全量/按角色全量/zh-Hans/柚衣奈_柚衣奈.md' },
  { k: '心玖的母亲', full: '心玖的母亲', g: 'Dumb', band: '一家Dumb Rock', dir: '一家DumbRock', corpus: '素材全量/按角色全量/zh-Hans/心玖的母亲_心玖的母亲.md' },
  { k: '枫', full: '枫', g: '梦限', band: '梦限大MewType', dir: '梦限大MewType', corpus: '素材全量/按角色全量/zh-Hans/枫_枫.md' },
  { k: '歌美', full: '歌美', g: '梦限', band: '梦限大MewType', dir: '梦限大MewType', corpus: '素材全量/按角色全量/zh-Hans/歌美_歌美.md' },
  { k: '宁月的管家婆婆', full: '宁月的管家婆婆', g: 'Dumb', band: '一家Dumb Rock', dir: '一家DumbRock', corpus: '素材全量/按角色全量/zh-Hans/宁月的管家婆婆_宁月的管家婆婆.md' },
];

const corpusOf = c => join(WS, '素材全量', '按角色', 'zh-Hans', c.band, `${c.k}_${c.full}.md`);
const modelOf = c => join(WS, '角色模型', c.dir, `${c.k}_${c.full}_角色扮演模型.md`);
const fpOf = c => join(WS, '角色模型', '指纹', `${c.k}_${c.full}_语言指纹报告.md`);
const spOf = c => join(WS, '角色模型', '系统提示词', `${c.k}_${c.full}_系统提示词.md`);

export { WS, CHARS, EXTRA_CHARS, corpusOf, modelOf, fpOf, spOf };
